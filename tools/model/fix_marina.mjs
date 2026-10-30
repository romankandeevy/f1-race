// Правка трассы Marina Bay из «MARINA.glb» (делал другой агент): поребрики лежали на полотне — полосой 1,2 м внутри
// белой линии. Рома 30.10: «поребрики красно-белые должны быть не на трассе, а за линией». Каждая вершина поребрика
// сдвигается наружу от оси трассы так, чтобы полоса начиналась сразу за белой линией (ширина до линии + white_line_width).
// Ось и ширины — из служебных точек «Ось трассы» самого файла. Асфальт за линией пока узкий (~0,15 м) — расширим вместе с окружением.
// usage: node fix_marina.mjs <MARINA.glb> <выход.glb>
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const [SRC, OUT] = process.argv.slice(2)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(SRC)
const root = doc.getRoot()
const find = (n) => root.listNodes().find((x) => x.getName() === n)

const ax = find('Ось трассы')
  .listChildren()
  .map((c) => {
    const t = c.getWorldTranslation()
    return { x: t[0], z: t[2], ...c.getExtras() }
  })
  .sort((a, b) => a.distance_m - b.distance_m)
for (let i = 0; i < ax.length; i++) {
  const a = ax[i]
  const b = ax[(i + 1) % ax.length]
  const l = Math.hypot(b.x - a.x, b.z - a.z)
  a.tx = (b.x - a.x) / l
  a.tz = (b.z - a.z) / l
}
const cells = new Map()
ax.forEach((a, i) => {
  const k = Math.floor(a.x / 10) + ',' + Math.floor(a.z / 10)
  if (!cells.has(k)) cells.set(k, [])
  cells.get(k).push(i)
})
const nearest = (x, z) => {
  let best = Infinity
  let bi = -1
  const cx = Math.floor(x / 10)
  const cz = Math.floor(z / 10)
  for (let dx = -2; dx <= 2; dx++)
    for (let dz = -2; dz <= 2; dz++)
      for (const i of cells.get(cx + dx + ',' + (cz + dz)) || []) {
        const d = (ax[i].x - x) ** 2 + (ax[i].z - z) ** 2
        if (d < best) {
          best = d
          bi = i
        }
      }
  return bi
}

for (const name of ['Поребрики красные', 'Поребрики белые']) {
  const node = find(name)
  const M = node.getWorldMatrix()
  for (const p of node.getMesh().listPrimitives()) {
    const pos = p.getAttribute('POSITION')
    // сдвиг одинаковый для всей полосы: от её внутреннего края (самая близкая к оси точка) до наружного края белой линии
    const lat = []
    for (let i = 0; i < pos.getCount(); i++) {
      const v = pos.getElement(i, [])
      const x = M[0] * v[0] + M[4] * v[1] + M[8] * v[2] + M[12]
      const z = M[2] * v[0] + M[6] * v[1] + M[10] * v[2] + M[14]
      const a = ax[nearest(x, z)]
      const left = (z - a.z) * a.tx - (x - a.x) * a.tz
      const edge = left > 0 ? a.width_left : a.width_right
      lat.push({ a, side: left > 0 ? 1 : -1, rel: Math.abs(left) - edge })
    }
    // каждый поребрик (связный кусок сетки) — свой сдвиг: от его внутреннего края до наружного края белой линии
    const parent = Array.from({ length: pos.getCount() }, (_, i) => i)
    const top = (i) => (parent[i] === i ? i : (parent[i] = top(parent[i])))
    const idx = p.getIndices().getArray()
    for (let t = 0; t < idx.length; t += 3) {
      parent[top(idx[t + 1])] = top(idx[t])
      parent[top(idx[t + 2])] = top(idx[t])
    }
    const innerOf = new Map()
    lat.forEach((l, i) => innerOf.set(top(i), Math.min(innerOf.get(top(i)) ?? Infinity, l.rel)))
    const shifts = []
    for (let i = 0; i < pos.getCount(); i++) {
      const { a, side } = lat[i]
      const shift = (a.white_line_width ?? 0.35) - innerOf.get(top(i))
      shifts.push(shift)
      // наружу от оси: «влево» по ходу — (tz, −tx)… в осях файла лево = (−tz, tx)·(−1); берём направление от оси к вершине
      const v = pos.getElement(i, [])
      const nx = side > 0 ? -a.tz : a.tz
      const nz = side > 0 ? a.tx : -a.tx
      // узлы поребриков без поворота и масштаба (проверено), поэтому сдвиг в мире = сдвиг в осях узла
      pos.setElement(i, [v[0] + nx * shift, v[1], v[2] + nz * shift])
    }
    console.log(name, 'кусков', innerOf.size, 'сдвиг наружу', Math.min(...shifts).toFixed(2), '…', Math.max(...shifts).toFixed(2), 'м')
  }
}
await io.write(OUT, doc)
console.log('готово')
