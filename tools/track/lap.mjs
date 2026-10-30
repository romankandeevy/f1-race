// Круг ботов каждого уровня на трассе из GLB (ось «Ось трассы», земля плоская — как в tests/physics.mjs, тест 22).
// Числа — для квалификации (`TRACKS.quali` в src/main.js): круг пилота с темпом 1, второй (летящий) круг.
// usage (из папки проекта): node tools/track/lap.mjs public/models/marina.glb
import fs from 'fs'
import RAPIER from '@dimforge/rapier3d-compat'
import { createVehicle, stepVehicle, STATIC_GROUPS } from '../../src/vehicle.js'
import { TUNING } from '../../src/tuning.js'
import { createRaceLine, createAiDriver } from '../../src/ai.js'

await RAPIER.init()
const DT = 1 / 240
const glb = fs.readFileSync(process.argv[2])
const json = JSON.parse(glb.slice(20, 20 + glb.readUInt32LE(12)).toString())
const axis = json.nodes
  .find((n) => n.name === 'Ось трассы')
  .children.map((i) => {
    const n = json.nodes[i]
    const t = n.translation || [n.matrix[12], n.matrix[13], n.matrix[14]]
    return { x: t[0], z: t[2], ...n.extras }
  })
  .sort((a, b) => a.distance_m - b.distance_m)
const len = axis[axis.length - 1].distance_m + 2

function lap(level) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
  const v = createVehicle(RAPIER, world, { y: 0.05, wear: false }, TUNING)
  const a0 = axis[0]
  const a1 = axis[1]
  v.body.setTranslation({ x: a0.x, y: 0.05, z: a0.z }, true)
  const yaw = Math.atan2(a1.x - a0.x, a1.z - a0.z)
  v.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true)
  const d = createAiDriver(createRaceLine(axis, level), { idx: 0 })
  let prev = 0
  let crossings = []
  let over = -Infinity
  for (let t = 0; t < 600 && crossings.length < 3; t += DT) {
    stepVehicle(v, d.update(v, DT), DT, () => 'asphalt')
    world.step()
    const p = v.body.translation()
    const a = axis[d.state.idx]
    const b = axis[(d.state.idx + 1) % axis.length]
    const tx = b.x - a.x
    const tz = b.z - a.z
    const lat = ((p.x - a.x) * tz - (p.z - a.z) * tx) / Math.hypot(tx, tz)
    over = Math.max(over, Math.abs(lat) - Math.max(a.width_left, a.width_right))
    if (prev > len * 0.75 && a.distance_m < len * 0.25) crossings.push(t)
    prev = a.distance_m
  }
  return { lap: crossings.length >= 3 ? crossings[2] - crossings[1] : Infinity, over }
}

for (const level of ['hard', 'medium', 'light']) {
  const r = lap(level)
  console.log(level, 'круг', r.lap.toFixed(1), 'с, центр болида за белой линией не дальше', r.over.toFixed(2), 'м')
}
