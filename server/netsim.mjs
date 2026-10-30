// Проверка этапа 1 (_materials/f1-online-ru.md, ворота: визуальная ошибка чужих ≤ 0,3 м при 100 мс и 2% потерь).
// Без браузера и без сети: физика — та же, что на сервере (stepVehicle, 240 Гц), снапшоты — 30 Гц,
// канал — netmodel.mjs (TCP-подобный: потеря = переотправка), клиент — тот же sampleCar из src/net/interp.js.
// Ошибка = расстояние между тем, что клиент рисует в момент rt, и истинной позицией машины в серверное время rt.
// Запуск: node netsim.mjs [--seconds=40]
import RAPIER from '@dimforge/rapier3d-compat'
import { createVehicle, stepVehicle, STATIC_GROUPS } from '../src/vehicle.js'
import { TUNING } from '../src/tuning.js'
import { sampleCar, prune } from '../src/net/interp.js'
import { makeLink } from './netmodel.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const SECONDS = Number(args.seconds ?? 40)
const DT = 1 / 240
const TICK_MS = DT * 1000
const SNAP_EVERY = 8

await RAPIER.init()

// истинный ход машины: позиция по тикам
function truth() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
  const v = createVehicle(RAPIER, world, { x: 0, y: 0.05, z: 0, yaw: 0 }, TUNING)
  const ticks = Math.round(SECONDS / DT)
  const pos = new Float64Array(ticks * 3)
  const vel = new Float64Array(ticks * 3)
  const quat = new Float64Array(ticks * 4)
  for (let i = 0; i < ticks; i++) {
    const t = i * DT
    // газ 2 с, потом виляние по руслу: руль синусоидой 4 с — машина идёт змейкой, без прямой линии
    const input = { throttle: t < 2 ? 1 : 0.75, brake: 0, steer: t < 2 ? 0 : 0.45 * Math.sin((2 * Math.PI * t) / 4), handbrake: false, abs: false, aero: false, aeroZone: false, boost: false, ersMode: 'balanced', hold: false }
    stepVehicle(v, input, DT, () => 'asphalt')
    world.step()
    const p = v.body.translation()
    const l = v.body.linvel()
    const r = v.body.rotation()
    pos.set([p.x, p.y, p.z], i * 3)
    vel.set([l.x, l.y, l.z], i * 3)
    quat.set([r.x, r.y, r.z, r.w], i * 4)
  }
  return { ticks, pos, vel, quat }
}

// истинная позиция в серверное время tMs: pos[k] — состояние после шага k, то есть на времени (k+1)·шаг;
// линейно между тиками (шаг 4,2 мс — ошибка этого шага ничтожна)
function truthAt(T, tMs) {
  const f = Math.min(T.ticks - 1.001, Math.max(0, tMs / TICK_MS - 1))
  const i = Math.floor(f)
  const u = f - i
  return [0, 1, 2].map((k) => T.pos[i * 3 + k] * (1 - u) + T.pos[(i + 1) * 3 + k] * u)
}

// один прогон: канал + клиент с буфером bufMs. adaptive: буфер растёт на 60 мс при каждом сбое (экстраполяции),
// за 3 с без сбоев уменьшается на 10 мс/с, но не ниже bufMs и не выше 300 мс. Возвращает статистику по кадрам 60 Гц
function run(T, cfg, bufMs, adaptive = false) {
  const link = makeLink(cfg, seeded(cfg.seed ?? 7))
  const arrivals = [] // снапшоты в порядке доставки: { due, t, p, q, v }
  for (let tick = SNAP_EVERY; tick <= T.ticks; tick += SNAP_EVERY) {
    const i = tick - 1
    const sendAt = tick * TICK_MS
    const due = link.schedule(sendAt)
    arrivals.push({
      due,
      snap: { t: sendAt, p: [T.pos[i * 3], T.pos[i * 3 + 1], T.pos[i * 3 + 2]], q: [T.quat[i * 4], T.quat[i * 4 + 1], T.quat[i * 4 + 2], T.quat[i * 4 + 3]], v: [T.vel[i * 3], T.vel[i * 3 + 1], T.vel[i * 3 + 2]] },
    })
  }
  arrivals.sort((a, b) => a.due - b.due)
  const buf = []
  let est = Infinity
  let next = 0
  const errs = []
  let extrapFrames = 0
  let frames = 0
  const endMs = (SECONDS - 1) * 1000
  let cur = bufMs
  let lastFail = -Infinity
  let wasExtrap = false
  let prevNow = 1000
  for (let now = 1000; now < endMs; now += 1000 / 60) {
    while (next < arrivals.length && arrivals[next].due <= now) {
      const a = arrivals[next++]
      buf.push(a.snap)
      est = Math.min(est, a.due - a.snap.t) // сдвиг часов: самая быстрая доставка
    }
    if (adaptive && now - lastFail > 3000 && cur > bufMs) cur = Math.max(bufMs, cur - 10 * ((now - prevNow) / 1000))
    prevNow = now
    const rt = now - est - cur // серверное время, которое рисуем
    prune(buf, rt)
    const s = sampleCar(buf, rt)
    if (!s) continue
    frames++
    if (s.extrap) {
      extrapFrames++
      if (!wasExtrap && adaptive) {
        cur = Math.min(300, cur + 60)
        lastFail = now
      }
    }
    wasExtrap = s.extrap
    const want = truthAt(T, rt)
    errs.push(Math.hypot(s.p[0] - want[0], s.p[1] - want[1], s.p[2] - want[2]))
  }
  errs.sort((a, b) => a - b)
  const q = (x) => errs[Math.min(errs.length - 1, Math.floor(errs.length * x))]
  return {
    p50: q(0.5),
    p95: q(0.95),
    max: errs[errs.length - 1],
    extrapShare: extrapFrames / frames,
  }
}

function seeded(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

const T = truth()
const top = T.pos.slice(-3)
console.log(`истина: ${SECONDS} с, пройдено ${Math.hypot(top[0], top[2]).toFixed(0)} м по прямой, шаг ${TICK_MS.toFixed(2)} мс, снапшот каждые ${SNAP_EVERY} тиков (30 Гц)`)

const scenarios = [
  { name: 'сеть идеальная, пинг 40 мс', cfg: { delay: 20, jitter: 0, loss: 0 } },
  { name: 'пинг 40 мс, джиттер ±20 мс', cfg: { delay: 20, jitter: 20, loss: 0 } },
  { name: 'пинг 40 мс, потери 2%', cfg: { delay: 20, jitter: 5, loss: 0.02 } },
  { name: 'пинг 100 мс, джиттер ±30, потери 2%', cfg: { delay: 50, jitter: 30, loss: 0.02 } },
  { name: 'мобильная плохая: 120 мс, ±40, потери 5%', cfg: { delay: 60, jitter: 40, loss: 0.05 } },
]
console.log('\nсценарий'.padEnd(46) + 'буфер  ошибка p50 / p95 / макс (м)   экстраполяция')
for (const sc of scenarios) {
  for (const [buf, adaptive] of [[100, false], [150, false], [100, true]]) {
    const seeds = [1, 2, 3, 4, 5].map((seed) => run(T, { ...sc.cfg, seed }, buf, adaptive))
    const avg = (k) => seeds.reduce((a, r) => a + r[k], 0) / seeds.length
    const worst = (k) => Math.max(...seeds.map((r) => r[k]))
    console.log(
      `${sc.name}`.padEnd(46) +
        `${adaptive ? 'адапт. от ' + buf : buf + ' мс'}  ${avg('p50').toFixed(3)} / ${avg('p95').toFixed(3)} / ${worst('max').toFixed(2)}`.padEnd(40) +
        `${(avg('extrapShare') * 100).toFixed(1)}% кадров`,
    )
  }
}
console.log('\n(по 5 прогонам на сценарий; «макс» — худший за все прогоны)')
