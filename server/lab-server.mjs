// Этап 1–2 онлайна (_materials/f1-online-ru.md): сервер-авторитет на той же физике, что в игре.
// Каждый игрок — свой мир физики и «шагает» по окнам ввода: окно = 4 шага 1/240 с = 1/60 с, как у клиента.
// Ввод применяется строго по порядку номеров; нет ввода — машина стоит (как и на клиенте, где время идёт по вводу).
// Снапшоты — 30 Гц. Очередь ввода держит JITTER_WINDOWS окон, чтобы джиттер и TCP-задержки не останавливали машину.
// Параметры сети для проверки без tc/netem: --loss (доля пакетов с потерей, как в TCP: переотправка), --delay (мс в одну
// сторону), --jitter (мс), --jb (окон в очереди), --gap (м между стартами игроков). Модель канала — netmodel.mjs.
import { WebSocketServer } from 'ws'
import RAPIER from '@dimforge/rapier3d-compat'
import { createVehicle, stepVehicle, STATIC_GROUPS } from '../src/vehicle.js'
import { TUNING } from '../src/tuning.js'
import { exportVehicle } from '../src/net/state.js'
import { makeLink } from './netmodel.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const PORT = Number(args.port ?? 8787)
const LOSS = Number(args.loss ?? 0)
const DELAY = Number(args.delay ?? 0)
const JITTER = Number(args.jitter ?? 0)
const JITTER_WINDOWS = Number(args.jb ?? 8)
const SLOT_GAP = Number(args.gap ?? 40) // м между стартовыми точками поперёк: соседей в мире игрока нет (столкновения — этап 3)

const DT = 1 / 240 // шаг физики, как STEP в main.js
const WINDOW = 4 // шагов на одно окно ввода: 240 / 4 = 60 вводов в секунду
const SNAP_EVERY = 8 // 240 / 8 = 30 снапшотов в секунду
const QUEUE_MAX = 40 // больше 2/3 с ввода в очереди — лишнее отбрасываем

await RAPIER.init()
const surface = () => 'asphalt'
const players = new Map() // id -> { ws, world, v, queue, applied, started, active, input, seq, slot, link }
let nextId = 1
let tick = 0
const stats = { snapsSent: 0, steps: 0, stepMsTotal: 0, stepMsMax: 0, frozen: 0 }

function freeSlot() {
  const used = new Set([...players.values()].map((p) => p.slot))
  let slot = 0
  while (used.has(slot)) slot++
  return slot
}

const neutral = () => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, abs: false, aero: false, aeroZone: false, boost: false, ersMode: 'balanced', hold: false })

function newWorld() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), ground)
  return world
}

// начало окна: берём следующий по порядку ввод; нет его — машина стоит на это окно (ничего не додумываем)
function beginWindow(p) {
  if (!p.started) {
    if (p.queue.length < JITTER_WINDOWS) {
      p.active = false
      return
    }
    p.started = true
    p.applied = p.queue[0].seq - 1
  }
  const want = p.applied + 1
  while (p.queue.length && p.queue[0].seq < want) p.queue.shift()
  if (p.queue.length && p.queue[0].seq === want) {
    p.input = p.queue.shift().input
    p.applied = want
    p.active = true
  } else {
    p.active = false
    stats.frozen++
  }
}

function step() {
  const t0 = performance.now()
  const boundary = tick % WINDOW === 0
  for (const p of players.values()) {
    if (boundary) beginWindow(p)
    if (p.active) {
      stepVehicle(p.v, p.input, DT, surface)
      p.world.step()
    }
  }
  tick++
  const ms = performance.now() - t0
  stats.steps++
  stats.stepMsTotal += ms
  stats.stepMsMax = Math.max(stats.stepMsMax, ms)
  if (tick % SNAP_EVERY === 0) broadcast()
}

// снапшот: тик, для каждой машины — позиция, поворот, скорость и номер последнего применённого ввода;
// своему игроку дополнительно — полное внутреннее состояние (own.st), чтобы он мог откатываться и переигрывать
function snapshotPlayers() {
  const list = []
  for (const [id, p] of players) {
    const t = p.v.body.translation()
    const r = p.v.body.rotation()
    const l = p.v.body.linvel()
    const w = p.v.body.angvel()
    list.push({ id, seq: p.applied, p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w], v: [l.x, l.y, l.z], w: [w.x, w.y, w.z] })
  }
  return list
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(msg)
}

function broadcast() {
  const list = snapshotPlayers()
  const now = performance.now()
  for (const [id, p] of players) {
    stats.snapsSent++
    const msg = JSON.stringify({ type: 'snap', tick, players: list, own: { id, st: exportVehicle(p.v) } })
    const due = p.link.schedule(now)
    if (due > now + 1) setTimeout(() => send(p.ws, msg), due - now)
    else send(p.ws, msg)
  }
}

// цикл: накапливаем реальное время и делаем столько шагов 1/240 с, сколько набежало
let last = performance.now()
let acc = 0
setInterval(() => {
  const now = performance.now()
  acc += Math.min(0.25, (now - last) / 1000)
  last = now
  while (acc >= DT) {
    step()
    acc -= DT
  }
}, 4)

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))
const clampSteer = (x) => Math.max(-1, Math.min(1, Number(x) || 0))

const wss = new WebSocketServer({ port: PORT })
wss.on('connection', (ws) => {
  const id = nextId++
  const slot = freeSlot()
  const world = newWorld()
  const spawn = { x: slot * SLOT_GAP, y: 0.05, z: 0 }
  const v = createVehicle(RAPIER, world, { ...spawn, yaw: 0 }, TUNING)
  const link = makeLink({ delay: DELAY, jitter: JITTER, loss: LOSS })
  const player = { ws, world, v, queue: [], applied: 0, started: false, active: false, input: neutral(), seq: 0, slot, link }
  players.set(id, player)
  send(ws, JSON.stringify({ type: 'welcome', id, dt: DT, snapEvery: SNAP_EVERY, serverTick: tick, spawn }))
  ws.on('message', (raw) => {
    let m
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    if (m.type !== 'in' || !(m.seq > player.seq)) return // старые пакеты (переупорядочены джиттером) не нужны
    player.seq = m.seq
    player.queue.push({ seq: m.seq, input: { ...neutral(), throttle: clamp01(m.throttle), brake: clamp01(m.brake), steer: clampSteer(m.steer) } })
    if (player.queue.length > QUEUE_MAX) player.queue.splice(0, player.queue.length - QUEUE_MAX)
  })
  ws.on('close', () => {
    players.delete(id)
  })
})

setInterval(() => {
  const avg = stats.steps ? (stats.stepMsTotal / stats.steps).toFixed(3) : '0'
  console.log(`[lab] игроков ${players.size}, тик ${tick}, шаг ${avg} мс (макс ${stats.stepMsMax.toFixed(2)}), снапшотов ${stats.snapsSent}, окон без ввода ${stats.frozen}`)
  stats.stepMsTotal = 0
  stats.steps = 0
  stats.stepMsMax = 0
  stats.frozen = 0
}, 5000)

console.log(`[lab] ws://localhost:${PORT} · потери ${LOSS}, задержка ${DELAY} мс, джиттер ${JITTER} мс, очередь ${JITTER_WINDOWS} окон, старт через ${SLOT_GAP} м`)
