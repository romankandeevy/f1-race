// Круг с каждой готовой настройкой на каждой трассе (--write — записать src/setup-data.js): бот «Средние» (темп 1, стандартная сборка) с настройкой пресета,
// второй круг в одиночку по оси трассы на ровной земле (как tools/track/lap.mjs). По этим числам выбираются
// рекомендованные настройки трасс и строка «Круг …» на карточках гаража.
// usage (из папки проекта): node tools/setup/preset-laps.mjs [track.glb marina.glb spa.glb]
import fs from 'fs'
import { fileURLToPath } from 'url'
const R = fileURLToPath(new URL('../../', import.meta.url))
import RAPIER from '@dimforge/rapier3d-compat'
const { createVehicle, stepVehicle, STATIC_GROUPS } = await import(R + 'src/vehicle.js')
const { TUNING, SETUP_LEVELS, presetsFor, PRESET_ORDER } = await import(R + 'src/tuning.js')
const { createRaceLine, createAiDriver } = await import(R + 'src/ai.js')
const { buildTuning, STOCK_BUILD } = await import(R + 'src/build.js')
await RAPIER.init()
const DT = 1 / 240

function axisOf(file) {
  const glb = fs.readFileSync(R + 'public/models/' + file)
  const json = JSON.parse(glb.slice(20, 20 + glb.readUInt32LE(12)).toString())
  const node = json.nodes.find((n) => n.name === 'Ось трассы')
  return node.children
    .map((i) => {
      const n = json.nodes[i]
      const t = n.translation || (n.matrix ? [n.matrix[12], n.matrix[13], n.matrix[14]] : [0, 0, 0])
      return { x: t[0], y: t[1], z: t[2], ...n.extras }
    })
    .filter((a) => typeof a.distance_m === 'number')
    .sort((a, b) => a.distance_m - b.distance_m)
}

export function lap(axis, values) {
  const len = axis[axis.length - 1].distance_m + 2
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
  const setup = { ...TUNING.setup, ...values }
  const T = buildTuning(STOCK_BUILD, setup)
  const keep = TUNING.setup
  TUNING.setup = setup // физика читает настройку болида из TUNING.setup (крылья, подвеска, шины…)
  try {
    const v = createVehicle(RAPIER, world, { y: 0.05, wear: false }, T)
    const a0 = axis[0]
    const a1 = axis[1]
    v.body.setTranslation({ x: a0.x, y: 0.05, z: a0.z }, true)
    const yaw = Math.atan2(a1.x - a0.x, a1.z - a0.z)
    v.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true)
    const d = createAiDriver(createRaceLine(axis, 'hard', T, { pace: 1 }), { idx: 0, T })
    let prev = 0
    const cr = []
    let over = -Infinity
    for (let t = 0; t < 900 && cr.length < 3; t += DT) {
      stepVehicle(v, d.update(v, DT), DT, () => 'asphalt')
      world.step()
      const p = v.body.translation()
      const a = axis[d.state.idx]
      const b = axis[(d.state.idx + 1) % axis.length]
      const tx = b.x - a.x
      const tz = b.z - a.z
      over = Math.max(over, Math.abs(((p.x - a.x) * tz - (p.z - a.z) * tx) / Math.hypot(tx, tz)) - Math.max(a.width_left, a.width_right))
      if (prev > len * 0.75 && a.distance_m < len * 0.25) cr.push(t)
      prev = a.distance_m
    }
    return { time: cr.length >= 3 ? cr[2] - cr[1] : Infinity, over }
  } finally {
    TUNING.setup = keep
  }
}

// трассы игры: id как в main.js TRACKS
export const TRACK_FILES = { lumen: 'track.glb', marina: 'marina.glb', spa: 'spa.glb' }

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { measure, rates } = await import(R + 'tools/setup/presets.mjs')
  const write = process.argv.includes('--write')
  const data = {}
  // оценки 1–5 не зависят от трассы — по значениям настройки
  const rateOf = (values) => rates(measure(values))
  for (const [id, f] of Object.entries(TRACK_FILES)) {
    const axis = axisOf(f)
    const levelLap = {}
    for (const k of ['low', 'mid', 'high']) levelLap[k] = lap(axis, SETUP_LEVELS[k].values).time
    const best = Object.keys(levelLap).reduce((a, b) => (levelLap[b] < levelLap[a] ? b : a))
    const P = presetsFor(best)
    const laps = { ...levelLap, safe: lap(axis, P.safe.values).time, wet: lap(axis, P.wet.values).time }
    const rate = Object.fromEntries(PRESET_ORDER.map((k) => [k, rateOf(P[k].values)]))
    data[id] = { best, laps: Object.fromEntries(Object.entries(laps).map(([k, t]) => [k, Math.round(t * 10) / 10])), rate }
    console.log(id, 'лучший', best, PRESET_ORDER.map((k) => `${P[k].name} ${laps[k].toFixed(2)} (${rate[k].straight}/${rate[k].corners}/${rate[k].forgiving})`).join(' · '))
  }
  if (write) {
    const out = `// Сгенерировано: node tools/setup/preset-laps.mjs --write (не править руками).
// Для каждой трассы: лучший уровень прижима, круг бота с каждой готовой настройкой (с, сухо) и оценки 1–5.
export const SETUP_DATA = ${JSON.stringify(data, null, 2)}
`
    fs.writeFileSync(R + 'src/setup-data.js', out)
    console.log('записано src/setup-data.js')
  }
}
