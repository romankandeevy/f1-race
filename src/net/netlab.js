// Лаборатория онлайна (этапы 1–2): два окна — два игрока. Свою машину ведём сами (предсказание, predict.js),
// чужие рисуем по снапшотам с буфером (interp.js). Сервер: server/lab-server.mjs. Ввод: W/S/A/D.
import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { sampleCar, prune } from './interp.js'
import { createPredictor } from './predict.js'

await RAPIER.init()

const q = new URLSearchParams(location.search)
const WS_URL = q.get('ws') || `ws://${location.hostname}:8787`
const BASE = Number(q.get('buf') ?? 100) // мс: буфер интерполяции чужих машин
const TICK_MS = 1000 / 240
const INPUT_DT = 1 / 60
const hud = document.getElementById('hud')

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x1a1d22)
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2))
scene.add(new THREE.GridHelper(2000, 200, 0x444a55, 0x2a2e36))
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 3000)
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
})

const PALETTE = [0xe10600, 0x2a7de1, 0x3fbf5f, 0xf2c200, 0xb46cff, 0xff8a00, 0x00c8c8, 0xdddddd]
const geo = new THREE.BoxGeometry(1.9, 0.6, 4.4)
const cars = new Map() // id -> { mesh, buf } — чужие машины
function remoteFor(id) {
  if (!cars.has(id)) {
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: PALETTE[(id - 1) % PALETTE.length] }))
    scene.add(mesh)
    cars.set(id, { mesh, buf: [] })
  }
  return cars.get(id)
}
const mine = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff }))
scene.add(mine)

// --- часы, буфер, статистика ---
let myId = null
let pred = null // предсказание своей машины
let est = Infinity // сдвиг часов: min(время приёма − серверное время снапшота)
let cur = BASE // буфер чужих машин, мс (растёт при сбоях)
let underruns = 0
let lastFail = -Infinity
let snapsWin = []
const corr = { n: 0, sum: 0, max: 0, over5cm: 0 } // поправки от сервера, м
let offset = [0, 0, 0] // визуальный хвост после поправки: не даём машине прыгнуть

function onSnap(m) {
  const now = performance.now()
  est = Math.min(est, now - m.tick * TICK_MS)
  snapsWin.push(now)
  for (const p of m.players) {
    if (p.id === myId) {
      reconcile(p, m.own.st)
      continue
    }
    const c = remoteFor(p.id)
    c.buf.push({ t: m.tick * TICK_MS, p: p.p, q: p.q, v: p.v })
    prune(c.buf, now - est - cur)
  }
}

function reconcile(p, st) {
  if (!pred) return
  const before = pred.pos()
  pred.reconcile(p.seq, { p: p.p, q: p.q, v: p.v, w: p.w, st })
  const after = pred.pos()
  const d = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2])
  corr.n++
  corr.sum += d
  corr.max = Math.max(corr.max, d)
  if (d > 0.05) corr.over5cm++
  // визуально сохраняем прежнее положение и гасим разницу за несколько кадров
  offset = [offset[0] + before[0] - after[0], offset[1] + before[1] - after[1], offset[2] + before[2] - after[2]]
}

// буфер растёт на 60 мс при сбое, уменьшается на 10 мс/с после 3 с без сбоев; не ниже BASE и не выше 300
function adapt(now, failed) {
  if (failed && now - lastFail > 300) {
    lastFail = now
    underruns++
    cur = Math.min(300, cur + 60)
  } else if (!failed && now - lastFail > 3000 && cur > BASE) {
    cur = Math.max(BASE, cur - 10 / 60)
  }
}

// --- ввод и сеть ---
const keys = new Set()
addEventListener('keydown', (e) => keys.add(e.code))
addEventListener('keyup', (e) => keys.delete(e.code))
let seq = 0
let sent = 0
let ws = null

function connect() {
  ws = new WebSocket(WS_URL)
  ws.onclose = () => {
    hud.textContent = 'нет связи с сервером — перезагрузи страницу'
  }
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.type === 'welcome') {
      myId = m.id
      pred = createPredictor(RAPIER, m.spawn)
    } else if (m.type === 'snap') onSnap(m)
  }
}
connect()

function sampleKeys() {
  return {
    throttle: keys.has('KeyW') ? 1 : 0,
    brake: keys.has('KeyS') ? 1 : 0,
    steer: (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0),
    handbrake: false,
    abs: false,
    aero: false,
    aeroZone: false,
    boost: false,
    ersMode: 'balanced',
    hold: false,
  }
}

// --- отрисовка и такт ввода ---
const fwd = new THREE.Vector3()
let simAcc = 0
let last = performance.now()
function frame(now) {
  requestAnimationFrame(frame)
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  // ввод и предсказание: кусок ввода каждые 1/60 с, как и отправляется на сервер
  simAcc += dt
  while (pred && simAcc >= INPUT_DT) {
    simAcc -= INPUT_DT
    seq++
    const input = sampleKeys()
    pred.step(seq, input)
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'in', seq, throttle: input.throttle, brake: input.brake, steer: input.steer }))
      sent++
    }
  }
  // чужие машины: интерполяция с буфером
  const rt = now - est - cur
  let anyFail = false
  for (const c of cars.values()) {
    if (!c.buf.length) continue
    const s = sampleCar(c.buf, rt)
    if (!s) continue
    if (s.extrap) anyFail = true
    c.mesh.position.set(s.p[0], s.p[1], s.p[2])
    c.mesh.quaternion.set(s.q[0], s.q[1], s.q[2], s.q[3])
  }
  adapt(now, anyFail)
  // своя машина: предсказание плюс затухающий хвост поправок
  const decay = Math.exp(-dt * 12)
  offset = offset.map((x) => x * decay)
  if (pred) {
    const p = pred.pos()
    const r = pred.quat()
    mine.position.set(p[0] + offset[0], p[1] + offset[1], p[2] + offset[2])
    mine.quaternion.set(r[0], r[1], r[2], r[3])
    fwd.set(0, 0, 1).applyQuaternion(mine.quaternion)
    camera.position.copy(mine.position).addScaledVector(fwd, -13).add(new THREE.Vector3(0, 5, 0))
    camera.lookAt(mine.position)
  }
  snapsWin = snapsWin.filter((t) => now - t < 1000)
  renderer.render(scene, camera)
  const cm = corr.n ? (corr.sum / corr.n) * 100 : 0
  hud.textContent =
    `игрок ${myId ?? '—'} · в комнате ${cars.size + (myId ? 1 : 0)}\n` +
    `буфер чужих ${cur.toFixed(0)} мс (база ${BASE}) · сбоев ${underruns}\n` +
    `снапшоты ${snapsWin.length} Гц · ввод отправлено ${sent} · в ожидании ${pred ? pred.pending() : 0}\n` +
    `поправки своей машины: ${corr.n} шт, средняя ${cm.toFixed(2)} см, макс ${(corr.max * 100).toFixed(1)} см, больше 5 см: ${corr.over5cm}`
}
requestAnimationFrame(frame)
