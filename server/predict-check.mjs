// Проверка предсказания без браузера: «сервер» и «клиент» — одна физика; клиент откатывается к снапшоту сервера
// с задержкой D окон ввода и переигрывает неподтверждённый хвост. Ошибка = расстояние между предсказанием и сервером.
import RAPIER from '@dimforge/rapier3d-compat'
import { createVehicle, stepVehicle, STATIC_GROUPS } from '../src/vehicle.js'
import { TUNING } from '../src/tuning.js'
import { createPredictor, DT, INPUT_STEPS } from '../src/net/predict.js'
import { exportVehicle } from '../src/net/state.js'

await RAPIER.init()
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const D = Number(args.delay ?? 6) // задержка снапшота в окнах ввода (1 окно = 4 шага = 1/60 с)
const WINDOWS = Number(args.windows ?? 600)
const SERVER_DELAY_INPUT = Number(args.inputDelay ?? 0) // окна: на сколько сервер позже применяет каждый ввод

function ground(world) {
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
}
const worldS = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
worldS.timestep = DT
ground(worldS)
const S = createVehicle(RAPIER, worldS, { x: 0, y: 0.05, z: 0, yaw: 0 }, TUNING)
const spawn = { x: 0, y: 0.05, z: 0 }
const C = createPredictor(RAPIER, spawn)

// входы: газ, потом змейка руля и короткие тормоза
const inputAt = (w) => {
  const t = w / 60
  return { throttle: t < 2 ? 1 : 0.8, brake: t % 9 > 8.6 ? 1 : 0, steer: 0.6 * Math.sin((2 * Math.PI * t) / 3), handbrake: false, abs: false, aero: false, aeroZone: false, boost: false, ersMode: 'balanced', hold: false }
}

const snaps = [] // { deliverW, seq, state } — что клиент получит
const serverPos = [] // позиция сервера после каждого окна
const clientPos = [] // позиция предсказания после каждого окна
let maxErr = 0
let sumErr = 0
let n = 0
const serverSeqAt = (w) => w // окно, которое сервер уже применил (без задержки ввода)
for (let w = 0; w < WINDOWS; w++) {
  // сервер: окно w применяет 4 шага (с задержкой ввода SERVER_DELAY_INPUT, сервер ещё на окне w−k)
  const sw = Math.max(0, w - SERVER_DELAY_INPUT)
  const inp = inputAt(sw)
  for (let i = 0; i < INPUT_STEPS; i++) {
    stepVehicle(S, inp, DT, () => 'asphalt')
    worldS.step()
  }
  // клиент: отправляет ввод окна w и сразу предсказывает
  const cinp = inputAt(w)
  C.step(w + 1, cinp)
  // снапшот сервера раз в 2 окна (30 Гц), приходит через D окон
  if (w % 2 === 1) {
    const t = S.body.translation()
    const st = { p: [t.x, t.y, t.z], q: (() => { const r = S.body.rotation(); return [r.x, r.y, r.z, r.w] })(), v: (() => { const l = S.body.linvel(); return [l.x, l.y, l.z] })(), w: (() => { const a = S.body.angvel(); return [a.x, a.y, a.z] })(), st: exportVehicle(S) }
    snaps.push({ at: w + D, seq: serverSeqAt(sw) + 1, state: st })
  }
  // доставка снапшотов
  while (snaps.length && snaps[0].at <= w) {
    const sn = snaps.shift()
    C.reconcile(sn.seq, sn.state)
  }
  // ошибка: предсказание окна w против сервера, когда тот применит ввод окна w (сервер отстаёт на SERVER_DELAY_INPUT)
  const sp = S.body.translation()
  serverPos.push([sp.x, sp.y, sp.z])
  clientPos.push(C.pos())
  // сервер в окне w применил ввод окна w−k; предсказание окна w−k должно совпасть с ним
  const i = w - SERVER_DELAY_INPUT
  if (i >= 0 && w > 60) {
    const a = clientPos[i]
    const b = serverPos[w]
    const e = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
    maxErr = Math.max(maxErr, e)
    sumErr += e
    n++
  }
}
console.log(`задержка снапшота ${D} окон (${((D / 60) * 1000).toFixed(0)} мс), запаздывание ввода на сервере ${SERVER_DELAY_INPUT} окон: средняя ошибка ${(sumErr / n * 100).toFixed(2)} см, макс ${(maxErr * 100).toFixed(2)} см`)
