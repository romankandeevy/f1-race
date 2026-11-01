// Замеры готовых настроек (SETUP_LEVELS, presetsFor в src/tuning.js) — по ним ставятся оценки 1–5 на карточках гаража.
// Та же физика, что в игре, без браузера (как tests/physics.mjs): плоский асфальт, болид без износа.
//   прямая      — скорость после 40 с газа в пол, км/ч;
//   повороты    — боковая перегрузка на постоянном круге с полным рулём на 100 и 200 км/ч, g;
//   прощает     — угол заноса кузова, °: тормоз в пол в повороте (180 км/ч, полруля — главное: здесь настройки
//                 различаются сильнее всего, «Пилот» до правки разворачивало на 41°), сброс газа в повороте на 220 км/ч
//                 и перекладка на 160 (меньше — спокойнее). Газ на выходе и баланс в установившемся повороте почти
//                 не различаются (болид у всех сильно недоповорачивает) — в оценку не входят;
//   тормоз      — путь 250→100 км/ч с тормозом в пол без ABS, м.
// usage (из папки проекта): node tools/setup/presets.mjs
import { pathToFileURL } from 'url'
import RAPIER from '@dimforge/rapier3d-compat'
import { createVehicle, stepVehicle, STATIC_GROUPS } from '../../src/vehicle.js'
import { TUNING, SETUP_DEFAULT, presetsFor, PRESET_ORDER } from '../../src/tuning.js'

await RAPIER.init()
const DT = 1 / 240
const NONE = { throttle: 0, brake: 0, steer: 0, handbrake: false, aero: false }
const deg = (r) => (r * 180) / Math.PI

function fresh() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
  const v = createVehicle(RAPIER, world, { y: 0.05, wear: false }, TUNING)
  return { world, v }
}
function run(w, input, seconds, cb) {
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) {
    stepVehicle(w.v, { ...NONE, ...(typeof input === 'function' ? input(i * DT) : input) }, DT, () => 'asphalt')
    w.world.step()
    cb && cb(i * DT)
  }
}
const kmh = (w) => w.v.state.speedKmh
const hold = (w, target) => ({ throttle: kmh(w) < target ? Math.min(1, (target - kmh(w)) * 0.15 + 0.2) : 0, brake: kmh(w) > target + 8 ? 0.4 : 0 })
function accelTo(w, target) {
  for (let t = 0; t < 30 && kmh(w) < target; t += DT) run(w, { throttle: 1 }, DT)
}
// угол заноса кузова: куда едет относительно того, куда смотрит
function beta(w) {
  const q = w.v.body.rotation()
  const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
  const lv = w.v.body.linvel()
  const fwd = lv.x * Math.sin(yaw) + lv.z * Math.cos(yaw)
  const lat = lv.x * Math.cos(yaw) - lv.z * Math.sin(yaw)
  return Math.abs(deg(Math.atan2(lat, Math.max(Math.abs(fwd), 1))))
}

function steady(target) {
  const w = fresh()
  run(w, NONE, 0.5)
  accelTo(w, target)
  run(w, () => ({ ...hold(w, target), steer: 1 }), 4)
  const lv = w.v.body.linvel()
  const sp = Math.hypot(lv.x, lv.z)
  return { w, g: (Math.abs(w.v.body.angvel().y) * sp) / 9.81 }
}

export function measure(values) {
  Object.assign(TUNING.setup, SETUP_DEFAULT, values)
  try {
    const top = (() => {
      const w = fresh()
      run(w, NONE, 0.5)
      run(w, { throttle: 1 }, 40)
      return kmh(w)
    })()
    const g100 = steady(100).g
    const g200 = steady(200).g
    const s150 = steady(150)
    void s150
    const maxBeta = (speed, setupSteer, seconds, input) => {
      const w = fresh()
      run(w, NONE, 0.5)
      accelTo(w, speed)
      run(w, () => ({ ...hold(w, speed), steer: setupSteer }), 2)
      let m = 0
      run(w, input, seconds, () => (m = Math.max(m, beta(w))))
      return m
    }
    const trail = maxBeta(180, 0.5, 1.2, { brake: 1, steer: 0.5 }) // тормоз в пол в повороте
    const lift = maxBeta(220, 0.6, 1.5, { steer: 0.6 }) // сброс газа в быстром повороте
    const slalom = (() => {
      const w = fresh()
      run(w, NONE, 0.5)
      accelTo(w, 160)
      let m = 0
      run(w, (t) => ({ ...hold(w, 160), steer: t < 0.6 ? 1 : t < 1.2 ? -1 : 0 }), 2.5, () => (m = Math.max(m, beta(w))))
      return m
    })()
    const brake = (() => {
      const w = fresh()
      run(w, NONE, 0.5)
      accelTo(w, 250)
      const p0 = w.v.body.translation()
      for (let t = 0; t < 10 && kmh(w) > 100; t += DT) run(w, { brake: 1 }, DT)
      const p1 = w.v.body.translation()
      return Math.hypot(p1.x - p0.x, p1.z - p0.z)
    })()
    return { top, g100, g200, trail, lift, slalom, brake }
  } finally {
    Object.assign(TUNING.setup, SETUP_DEFAULT)
  }
}

// оценки 1–5 из замеров (пороги подобраны так, чтобы «Средний прижим» был 3/3/3)
export function rates(m) {
  const step = (x, cuts) => 1 + cuts.filter((c) => x > c).length
  const corners = (m.g100 / 1.95 + m.g200 / 3.42) / 2 // доля от «Универсальной»
  return {
    straight: step(m.top, [304, 314, 328, 340]), // 01.11: крылья дают 296…361 км/ч
    corners: step(corners, [0.9, 0.96, 1.04, 1.085]),
    forgiving: 6 - step(m.trail, [1.2, 1.8, 3.5, 8]),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const best of ['low', 'mid', 'high']) {
    const P = presetsFor(best)
    for (const id of best === 'low' ? PRESET_ORDER : ['safe', 'wet']) {
      const m = measure(P[id].values)
      const r = rates(m)
      console.log(`${P[id].name.padEnd(16)} ${id === 'safe' || id === 'wet' ? `(от «${best}»)` : ''} прямая ${m.top.toFixed(0)} км/ч · повороты ${m.g100.toFixed(2)} / ${m.g200.toFixed(2)} g · занос: тормоз в повороте ${m.trail.toFixed(1)}°, сброс ${m.lift.toFixed(1)}°, перекладка ${m.slalom.toFixed(1)}° · тормоз ${m.brake.toFixed(0)} м · оценки ${r.straight}/${r.corners}/${r.forgiving}`)
    }
  }
}
