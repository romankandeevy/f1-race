// Проверка готового GLB трассы «Спа-Франкоршам» (после сохранения в Forma):
//   ось (длина, замыкание, радиусы), рельеф, поребрики за линией, пит-лейн и стены не на трассе, пол боксов вровень,
//   нет света и камер в файле, бюджет; и круг бота уровня «hard» по НАСТОЯЩЕЙ коллизии трассы (рельеф, поребрики, газон),
//   как на сервере (server/track-node.mjs): время, выезды за белую линию, NaN, отрыв колёс.
// usage (из папки проекта): node tools/track/spa/check.mjs public/models/spa.glb
import fs from 'fs'
import RAPIER from '@dimforge/rapier3d-compat'
import { loadTrack } from '../../../server/track-node.mjs'
import { createVehicle, stepVehicle } from '../../../src/vehicle.js'
import { TUNING } from '../../../src/tuning.js'
import { createRaceLine, createAiDriver } from '../../../src/ai.js'

const file = process.argv[2] || 'public/models/spa.glb'
const levels = (process.argv[3] || 'hard').split(',')
const buf = fs.readFileSync(file)
const json = JSON.parse(buf.slice(20, 20 + buf.readUInt32LE(12)).toString())
const problems = []
const say = (...a) => console.log(...a)

// ---------- файл ----------
const tri = json.meshes.reduce((s, m) => s + m.primitives.reduce((a, p) => a + json.accessors[p.indices ?? p.attributes.POSITION].count / 3, 0), 0)
say('файл', (buf.length / 1e6).toFixed(1), 'МБ, треугольников', Math.round(tri), ', мешей', json.meshes.length, ', материалов', json.materials.length, ', текстур', (json.images || []).length)
if (json.extensions?.KHR_lights_punctual) problems.push('в файле есть источники света (KHR_lights_punctual)')
if (json.cameras?.length) problems.push('в файле есть камеры: ' + json.cameras.length)
if (buf.length > 25.5e6) problems.push('файл больше 25 МБ')
if (tri > 400e3) problems.push('треугольников больше 400 тыс.')
const need = ['Трасса', 'Покрытие (коллизия)', 'Полотно трассы', 'Пит-лейн', 'Разметка (без коллизии)', 'Поребрики красные', 'Поребрики белые', 'Газон', 'Ограждения (коллизия)', 'Сетка (без коллизии)', 'Пит-уолл', 'Ось трассы', 'Финиш и сектора', 'Финиш', 'Сектор 1', 'Сектор 2', 'Ось пит-лейна', 'Пит лимит начало', 'Пит лимит конец', 'Старт P1', 'Старт P20', 'Пит-бокс 1', 'Пит-бокс 20']
for (let n = 1; n <= 5; n++) need.push(`Огонь старта ${n} верх`, `Огонь старта ${n} низ`)
const names = new Set(json.nodes.map((n) => n.name))
const missing = need.filter((n) => !names.has(n))
if (missing.length) problems.push('нет узлов: ' + missing.join(', '))
say('трибун (имя с «Трибуна»):', json.nodes.filter((n) => /Трибуна/.test(n.name || '') && n.children).length)

// ---------- трасса как на сервере ----------
const track = loadTrack(file)
const ax = track.axis
const L = track.length
say('ось:', ax.length, 'точек, длина', L, 'м; последняя → первая', Math.hypot(ax[ax.length - 1].x - ax[0].x, ax[ax.length - 1].z - ax[0].z).toFixed(2), 'м')
for (let i = 0; i < ax.length; i++) if (ax[i].distance_m !== i * 2) problems.push('distance_m не по порядку на ' + i)
let minR = Infinity
let minRAt = 0
for (let i = 0; i < ax.length; i++) {
  const a = ax[(i - 5 + ax.length) % ax.length]
  const b = ax[i]
  const c = ax[(i + 5) % ax.length]
  const ab = Math.hypot(b.x - a.x, b.z - a.z)
  const bc = Math.hypot(c.x - b.x, c.z - b.z)
  const ca = Math.hypot(a.x - c.x, a.z - c.z)
  const area = Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2
  const R = area < 1e-9 ? Infinity : (ab * bc * ca) / (4 * area)
  if (R < minR) {
    minR = R
    minRAt = b.distance_m
  }
}
say('мин. радиус оси (три точки через 10 м):', minR.toFixed(1), 'м на', minRAt, 'м')
if (minR < 22) problems.push('радиус меньше 22 м')
const ys = ax.map((a) => a.y)
let maxG = 0
for (let i = 0; i < ax.length; i++) maxG = Math.max(maxG, Math.abs(ax[(i + 1) % ax.length].y - ax[i].y) / 2)
say('высоты оси', Math.min(...ys).toFixed(1), '…', Math.max(...ys).toFixed(1), 'м, перепад', (Math.max(...ys) - Math.min(...ys)).toFixed(1), 'м; макс. уклон', (maxG * 100).toFixed(1), '%')
const ws = ax.map((a) => a.width_left + a.width_right)
say('ширина между линиями', Math.min(...ws), '…', Math.max(...ws), 'м')
say('решётка', track.grid.length, ', боксов', track.pit?.boxes.length, ', ось пит-лейна', track.pit?.axis.length, 'точек, ограничитель', track.pit?.limitStart, '…', track.pit?.limitEnd, 'м; сектора', track.sectors.map((s) => s.name + ' ' + s.distance_m).join(', '))

// ближайшая точка оси и боковое смещение (влево +)
function lateral(x, z) {
  let best = Infinity
  let bi = 0
  for (let i = 0; i < ax.length; i++) {
    const d = (ax[i].x - x) ** 2 + (ax[i].z - z) ** 2
    if (d < best) {
      best = d
      bi = i
    }
  }
  const a = ax[bi]
  const b = ax[(bi + 1) % ax.length]
  const tx = b.x - a.x
  const tz = b.z - a.z
  const t = Math.hypot(tx, tz)
  const along = ((x - a.x) * tx + (z - a.z) * tz) / t
  // назад от точки: берём предыдущий отрезок
  if (along < 0) {
    const p = ax[(bi - 1 + ax.length) % ax.length]
    const ux = a.x - p.x
    const uz = a.z - p.z
    const u = Math.hypot(ux, uz)
    const al = ((x - p.x) * ux + (z - p.z) * uz) / u
    return { i: bi, lat: ((x - p.x) * uz - (z - p.z) * ux) / u, along: al, a, y: p.y + ((a.y - p.y) * al) / u }
  }
  return { i: bi, lat: ((x - a.x) * tz - (z - a.z) * tx) / t, along, a, y: a.y + ((b.y - a.y) * along) / t }
}

// вершины детали по имени (мировые)
const node = (name) => json.nodes.findIndex((n) => n.name === name)
const parent = new Array(json.nodes.length).fill(-1)
json.nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)))
function vertsOf(name) {
  const i = node(name)
  if (i < 0) return []
  const n = json.nodes[i]
  if (n.mesh === undefined) return []
  // в файле Forma детали трассы без сдвигов (матрица единичная) — проверяем
  for (let p = i; p >= 0; p = parent[p]) {
    const q = json.nodes[p]
    if (q.matrix || q.translation || q.rotation || q.scale) problems.push('у детали ' + name + ' есть сдвиг в иерархии (' + q.name + ')')
  }
  const out = []
  const bin = buf.subarray(20 + buf.readUInt32LE(12) + 8)
  for (const prim of json.meshes[n.mesh].primitives) {
    const acc = json.accessors[prim.attributes.POSITION]
    const bv = json.bufferViews[acc.bufferView]
    const base = (bv.byteOffset || 0) + (acc.byteOffset || 0)
    const stride = bv.byteStride || 12
    for (let k = 0; k < acc.count; k++) out.push([bin.readFloatLE(base + k * stride), bin.readFloatLE(base + k * stride + 4), bin.readFloatLE(base + k * stride + 8)])
  }
  return out
}
// поребрики: ни одной вершины ближе к оси, чем внешний край белой линии
let kerbBad = 0
let kerbBadY = 0
let kerbN = 0
for (const nm of ['Поребрики красные', 'Поребрики белые']) {
  for (const [x, y, z] of vertsOf(nm)) {
    const r = lateral(x, z)
    kerbN++
    const lim = (r.lat > 0 ? r.a.width_left : r.a.width_right) + r.a.white_line_width - 0.03 // 3 см — хорда оси через 2 м против дуги
    if (Math.abs(r.lat) < lim) { kerbBad++; if (process.env.DBG && kerbBad < 15) say("  поребрик", r.a.distance_m, r.lat.toFixed(3), lim.toFixed(3), r.along.toFixed(2)) }
    if (Math.abs(y - r.y) > 0.045) kerbBadY++
  }
}
say('поребрики: вершин', kerbN, ', на полотне', kerbBad, ', не на высоте асфальта +3 см', kerbBadY)
if (kerbBad) problems.push('поребрики на полотне: ' + kerbBad)
if (kerbBadY) problems.push('поребрики не на высоте: ' + kerbBadY)
// ограждения и пит-уолл: не ближе 2 м к белой линии
for (const nm of ['Отбойники', 'Барьеры TecPro', 'Бетонные стены', 'Пит-уолл']) {
  let worst = Infinity
  for (const [x, , z] of vertsOf(nm)) {
    const r = lateral(x, z)
    const w = r.lat > 0 ? r.a.width_left : r.a.width_right
    worst = Math.min(worst, Math.abs(r.lat) - w - r.a.white_line_width)
  }
  say(nm + ': ближе всего к белой линии', worst.toFixed(2), 'м')
  if (worst < 1.4) problems.push(nm + ' ближе 1,4 м к белой линии')
}
// пит-уолл и боксы: не на оси пит-лейна
if (track.pit) {
  const pa = track.pit.axis
  let worst = Infinity
  for (const [x, , z] of vertsOf('Пит-уолл')) for (const p of pa) worst = Math.min(worst, Math.hypot(p.x - x, p.z - z))
  say('пит-уолл: до оси пит-лейна не ближе', worst.toFixed(2), 'м')
  if (worst < 5.5) problems.push('пит-уолл ближе 5,5 м к оси пит-лейна')
  // пол боксов и пит-лейн вровень
  const lane = vertsOf('Пит-лейн')
  const floor = vertsOf('Пол боксов')
  let dy = 0
  for (const [x, y, z] of floor) {
    let best = Infinity
    let by = 0
    for (const [px, py, pz] of lane) {
      const d = (px - x) ** 2 + (pz - z) ** 2
      if (d < best) {
        best = d
        by = py
      }
    }
    if (best < 1) dy = Math.max(dy, Math.abs(by - y))
  }
  say('пол боксов и пит-лейн: разница высот на стыке', (dy * 100).toFixed(1), 'см')
  if (dy > 0.01) problems.push('пол боксов не вровень с пит-лейном')
  // пит-лейн не пересекает гоночную линию: ось пит-лейна, пока она дальше 1 м от трассы, не возвращается внутрь
  let into = 0
  for (const p of pa) {
    const r = lateral(p.x, p.z)
    if (r.lat < -0.5) into++ // пит-лейн слева; справа от оси трассы — пересёк
  }
  say('ось пит-лейна справа от оси трассы (пересечение):', into, 'точек')
  if (into) problems.push('ось пит-лейна заходит на другую сторону трассы')
}

// ---------- круг бота по настоящей коллизии ----------
await RAPIER.init()
const DT = 1 / 240
for (const level of levels) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  track.attachPhysics(RAPIER, world)
  const a0 = ax[0]
  const a1 = ax[1]
  const yaw = Math.atan2(a1.x - a0.x, a1.z - a0.z)
  const v = createVehicle(RAPIER, world, { x: a0.x, y: a0.y + 0.08, z: a0.z, yaw, wear: false }, TUNING)
  const d = createAiDriver(createRaceLine(ax, level), { idx: 0 })
  let prev = 0
  const crossings = []
  let over = -Infinity
  let overAt = 0
  let nan = false
  let air = 0
  let maxAir = 0
  let offAsphalt = 0
  let minY = Infinity
  let worstDy = 0
  for (let t = 0; t < 700 && crossings.length < 3; t += DT) {
    stepVehicle(v, d.update(v, DT), DT, track.surfaceAt)
    world.step()
    const p = v.body.translation()
    if (!Number.isFinite(p.x + p.y + p.z)) {
      nan = true
      break
    }
    const a = ax[d.state.idx]
    const b = ax[(d.state.idx + 1) % ax.length]
    const tx = b.x - a.x
    const tz = b.z - a.z
    const lat = ((p.x - a.x) * tz - (p.z - a.z) * tx) / Math.hypot(tx, tz)
    const o = Math.abs(lat) - (lat > 0 ? a.width_left : a.width_right)
    if (crossings.length >= 1) {
      if (o > over) {
        over = o
        overAt = a.distance_m
      }
      const contact = v.wheels ? v.wheels.filter((w) => w.contact ?? w.onGround ?? w.hit).length : 4
      if (contact === 0) {
        air += DT
        maxAir = Math.max(maxAir, air)
      } else air = 0
      if (v.wheels?.some((w) => w.surface && w.surface !== 'asphalt' && w.surface !== 'kerb')) offAsphalt += DT
      worstDy = Math.max(worstDy, Math.abs(p.y - a.y))
    }
    minY = Math.min(minY, p.y)
    if (prev > L * 0.75 && a.distance_m < L * 0.25) crossings.push(t)
    prev = a.distance_m
  }
  const lap = crossings.length >= 3 ? crossings[2] - crossings[1] : Infinity
  say(`бот ${level} по коллизии трассы: круг ${lap.toFixed(1)} с; центр за белой линией не дальше ${over.toFixed(2)} м (на ${overAt} м); колёса не на асфальте ${offAsphalt.toFixed(1)} с; в воздухе всеми колёсами до ${(maxAir * 1000).toFixed(0)} мс; кузов от оси по высоте до ${worstDy.toFixed(2)} м; NaN: ${nan ? 'да' : 'нет'}`)
  if (nan) problems.push('NaN в физике')
  if (!Number.isFinite(lap)) problems.push(`бот ${level} не проехал круг`)
  if (over > 0) problems.push(`бот ${level} выходит центром за белую линию (${over.toFixed(2)} м на ${overAt} м)`)
}

say(problems.length ? '\nПРОБЛЕМЫ:\n- ' + problems.join('\n- ') : '\nпроблем нет')
