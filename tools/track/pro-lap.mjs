// Круг «Сложного» бота с лучшей сборкой и с подтягиванием (bots.js rubberK): node tools/track/pro-lap.mjs track.glb
import fs from 'fs'
import { fileURLToPath } from 'url'
const R = fileURLToPath(new URL('../../', import.meta.url))
import RAPIER from '@dimforge/rapier3d-compat'
const { createVehicle, stepVehicle, STATIC_GROUPS } = await import(R + 'src/vehicle.js')
const { TUNING } = await import(R + 'src/tuning.js')
const { createRaceLine, createAiDriver } = await import(R + 'src/ai.js')
const { buildTuning, randomBuild, lapForecast, STOCK_BUILD } = await import(R + 'src/build.js')
await RAPIER.init()
const DT = 1 / 240
const glb = fs.readFileSync(R + 'public/models/' + process.argv[2])
const json = JSON.parse(glb.slice(20, 20 + glb.readUInt32LE(12)).toString())
const axis = json.nodes.find((n) => n.name === 'Ось трассы').children.map((i) => { const n = json.nodes[i]; const t = n.translation || [n.matrix[12], n.matrix[13], n.matrix[14]]; return { x: t[0], z: t[2], ...n.extras } }).sort((a, b) => a.distance_m - b.distance_m)
const len = axis[axis.length - 1].distance_m + 2
function lap(build, pace, gripK, powK) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }); world.timestep = DT
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
  const T = buildTuning(build, { ...TUNING.setup })
  T.tireMu *= gripK; T.power *= powK; T.maxDriveForce *= powK; T.brakeForce *= gripK
  const v = createVehicle(RAPIER, world, { y: 0.05, wear: false }, T)
  const a0 = axis[0], a1 = axis[1]
  v.body.setTranslation({ x: a0.x, y: 0.05, z: a0.z }, true)
  const yaw = Math.atan2(a1.x - a0.x, a1.z - a0.z)
  v.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true)
  const d = createAiDriver(createRaceLine(axis, 'hard', T, { pace }), { idx: 0, T })
  d.state.rubber = Math.sqrt(gripK)
  let prev = 0, cr = [], over = -Infinity
  for (let t = 0; t < 600 && cr.length < 3; t += DT) {
    d.state.rubber = Math.sqrt(gripK)
    stepVehicle(v, d.update(v, DT), DT, () => 'asphalt'); world.step()
    const p = v.body.translation(); const a = axis[d.state.idx], b = axis[(d.state.idx + 1) % axis.length]
    const tx = b.x - a.x, tz = b.z - a.z
    over = Math.max(over, Math.abs(((p.x - a.x) * tz - (p.z - a.z) * tx) / Math.hypot(tx, tz)) - Math.max(a.width_left, a.width_right))
    if (prev > len * 0.75 && a.distance_m < len * 0.25) cr.push(t)
    prev = a.distance_m
  }
  return (cr.length >= 3 ? cr[2] - cr[1] : Infinity).toFixed(2) + ' over ' + over.toFixed(2)
}
let best = null, bt = Infinity
let seed = 3; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
for (let k = 0; k < 40; k++) { const b = randomBuild(rand); const t = lapForecast(b, 'lumen').time; if (t < bt) { bt = t; best = b } }
console.log('best forecast', bt.toFixed(2), JSON.stringify(best))
console.log('stock pace1', lap(STOCK_BUILD, 1, 1, 1))
console.log('best pace1', lap(best, 1, 1, 1))
console.log('best +7%', lap(best, 1, 1.07, 1.07))
console.log('best +8/16%', lap(best, 1, 1.08, 1.16))
console.log('best +10/20%', lap(best, 1, 1.10, 1.20))
