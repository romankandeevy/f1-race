// Отклик на руль (01.11, Рома на Спа: «болид не слушается руля»): скорость поворота кузова через 0,2 / 0,5 / 1,5 с после
// того, как руль повёрнут на 40%, на 150 и 250 км/ч — для настройки по умолчанию и каждой готовой. Плоский асфальт, без износа.
// usage (из папки проекта): node tools/setup/steer-response.mjs
import { fileURLToPath } from 'url'
const R = fileURLToPath(new URL('../../', import.meta.url))
import RAPIER from '@dimforge/rapier3d-compat'
const { createVehicle, stepVehicle, STATIC_GROUPS } = await import(R + 'src/vehicle.js')
const { TUNING, SETUP_DEFAULT, SETUP_LEVELS, presetsFor } = await import(R + 'src/tuning.js')
await RAPIER.init()
const DT = 1 / 240
const NONE = { throttle: 0, brake: 0, steer: 0, handbrake: false, aero: false }
function test(values, kmh, steer) {
  Object.assign(TUNING.setup, SETUP_DEFAULT, values)
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = DT
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
  const v = createVehicle(RAPIER, world, { y: 0.05, wear: false }, TUNING)
  const st = (inp) => { stepVehicle(v, { ...NONE, ...inp }, DT, () => 'asphalt'); world.step() }
  for (let i = 0; i < 120; i++) st({})
  for (let t = 0; t < 40 && v.state.speedKmh < kmh; t += DT) st({ throttle: 1 })
  const hold = () => ({ throttle: v.state.speedKmh < kmh ? Math.min(1, (kmh - v.state.speedKmh) * 0.15 + 0.2) : 0 })
  for (let i = 0; i < 240; i++) st(hold())
  const yaw = () => v.body.angvel().y
  let r02 = 0, r05 = 0, r15 = 0
  for (let i = 0; i < 360; i++) { st({ ...hold(), steer }); if (i === 48) r02 = yaw(); if (i === 120) r05 = yaw(); if (i === 359) r15 = yaw() }
  return [r02, r05, r15].map((x) => Math.abs(x * 57.3).toFixed(1)).join(' / ')
}
const P = presetsFor('mid')
const rows = { 'по умолчанию 30/30': {}, ...Object.fromEntries(Object.entries(P).map(([k, p]) => [p.name, p.values])) }
for (const kmh of [150, 250]) {
  console.log(`\n${kmh} км/ч, руль на 40%: скорость поворота °/с через 0,2 / 0,5 / 1,5 с`)
  for (const [n, vals] of Object.entries(rows)) console.log('  ' + n.padEnd(20), test(vals, kmh, 0.4))
}
