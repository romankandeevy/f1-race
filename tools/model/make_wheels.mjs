// Игровые колёса из «ШИНЫ.glb» (Рома 30.10: «взять полностью каждое колесо — со спицами, колодками, со всем — и перенести в нашу»).
// В файле пять комплектов: шина (протектор + две боковины) и одинаковый у всех диск колеса — обод, спицы, ступица с гайкой,
// карбоновый тормозной диск с колоколом, суппорт с поршнями, ниппель, грузики.
// Выход:
//   wheel_spin    — всё, что крутится с колесом (обод, спицы, ступица, гайка, тормозной диск), общий для всех составов;
//   wheel_caliper — суппорт с поршнями: стоит на стойке, поворачивается с рулём, но не крутится;
//   tyre_<состав> — шины пяти составов (tyre_tread_/tyre_sidewall_outer_/tyre_sidewall_inner_<состав>).
// Центр — центр колеса, ось вращения X (как wheel_XX в f1.glb), внешняя сторона +X. Ширина в файле одна (0,376 м);
// переднюю и заднюю ширину ставит car.js масштабом по X. Материал карбонового диска — brake_disc.
// usage: node make_wheels.mjs <ШИНЫ.glb> <выход.glb> [ошибка, м] [множитель для канавок]
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRLightsPunctual } from '@gltf-transform/extensions'
import { transformPrimitive, simplifyPrimitive, weld, prune, dedup, textureCompress, getBounds, unpartition, joinPrimitives } from '@gltf-transform/functions'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
import { mat4 } from 'gl-matrix'

const [SRC, OUT, ERR = '0.0005', GROOVE = '3'] = process.argv.slice(2)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(SRC)
const root = doc.getRoot()
const scene = root.getDefaultScene() || root.listScenes()[0]
const SETS = { 'Мягкая': 'soft', 'Средняя': 'medium', 'Жёсткая': 'hard', 'Промежуточная': 'intermediate', 'Дождевая': 'wet' }
const MAT = { soft: 'soft', medium: 'medium', hard: 'hard', inter: 'intermediate', wet: 'wet' }
const triOf = (m) => m.listPrimitives().reduce((b, p) => b + (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3, 0)
const tri = () => root.listMeshes().reduce((a, m) => a + triOf(m), 0)
const meshesUnder = (n, out = []) => {
  if (n.getMesh()) out.push(n)
  for (const c of n.listChildren()) meshesUnder(c, out)
  return out
}

// поворот: в файле ось колеса — Z, внешняя сторона +Z; в игре ось X, внешняя +X → поворот на +90° вокруг Y
const rotY = mat4.fromYRotation(mat4.create(), Math.PI / 2)
const out = []
let spinParts = null
let caliperParts = null
let toLocalRim = null
for (const n of root.listNodes()) {
  const m = /^Шина_—_([А-Яа-яЁё]+)/.exec(n.getName())
  if (!m || !SETS[m[1]]) continue
  const id = SETS[m[1]]
  const parts = n.listChildren().filter((c) => c.getMesh() && /^(Протектор|Боковина)/.test(c.getName()))
  // центр колеса — по протектору
  const tread = parts.find((c) => c.getName().startsWith('Протектор'))
  const b = getBounds(tread)
  const ctr = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]
  const toLocal = mat4.multiply(mat4.create(), rotY, mat4.fromTranslation(mat4.create(), ctr.map((v) => -v)))
  const node = doc.createNode('tyre_' + id)
  for (const c of parts) {
    const kind = c.getName().startsWith('Протектор') ? 'tread' : c.getName().includes('внешн') ? 'sidewall_outer' : 'sidewall_inner'
    const mesh = doc.createMesh(`tyre_${kind}_${id}`)
    const rel = mat4.multiply(mat4.create(), toLocal, c.getWorldMatrix())
    for (const p of c.getMesh().listPrimitives()) {
      const q = p.clone()
      transformPrimitive(q, rel)
      mesh.addPrimitive(q)
    }
    node.addChild(doc.createNode(`tyre_${kind}_${id}`).setMesh(mesh))
  }
  out.push(node)
  // диск колеса одинаковый во всех комплектах — берём из первого
  const rim = n.listChildren().find((c) => c.getName().startsWith('Диск_колеса'))
  if (rim && !spinParts) {
    toLocalRim = toLocal
    const isCaliper = (x) => {
      for (let p = x; p && p !== rim; p = p.getParentNode()) if (p.getName().startsWith('Суппорт')) return true
      return false
    }
    const all = meshesUnder(rim)
    spinParts = all.filter((x) => !isCaliper(x))
    caliperParts = all.filter(isCaliper)
  }
  console.log(id, 'центр', ctr.map((v) => +v.toFixed(3)), 'деталей шины', parts.length)
}
console.log('диск колеса:', spinParts.map((x) => x.getName()).join(', '))
console.log('суппорт:', caliperParts.map((x) => x.getName()).join(', '))

// безымянные материалы получают имя по детали; карбоновый диск — brake_disc
for (const x of [...spinParts, ...caliperParts])
  for (const p of x.getMesh().listPrimitives()) {
    const mat = p.getMaterial()
    if (!mat) continue
    if (x.getName() === 'Диск_карбон') mat.setName('brake_disc')
    else if (!mat.getName()) mat.setName('wheel_' + x.getName())
  }

// одинаковые материалы (у «Шлифованного металла» в файле шесть копий с разными картинками) — в один: меньше вызовов отрисовки и текстур
const sameMat = new Map()
// яркость картинки цвета ступенями: тёмный анодированный обод и светлый металл ступицы — разные материалы, хоть и с одним именем
const shade = async (mat) => {
  const t = mat.getBaseColorTexture()
  if (!t) return '-'
  const st = await sharp(t.getImage()).stats()
  return Math.round((st.channels[0].mean + st.channels[1].mean + st.channels[2].mean) / 3 / 40)
}
for (const x of [...spinParts, ...caliperParts])
  for (const p of x.getMesh().listPrimitives()) {
    const mat = p.getMaterial()
    if (!mat || mat.getName() === 'brake_disc') continue
    const key = mat.getName() + '|' + mat.getBaseColorFactor().map((v) => v.toFixed(2)).join(',') + '|' + (await shade(mat))
    if (!sameMat.has(key)) sameMat.set(key, mat)
    p.setMaterial(sameMat.get(key))
  }
// карбоновый диск: без картинки (у UV-швов упрощение встаёт — 20 тыс. треугольников), тёмный карбон
for (const x of spinParts)
  if (x.getName() === 'Диск_карбон')
    for (const p of x.getMesh().listPrimitives()) {
      const m = p.getMaterial()
      m.setBaseColorTexture(null).setMetallicRoughnessTexture(null).setNormalTexture(null).setBaseColorFactor([0.05, 0.05, 0.055, 1]).setMetallicFactor(0.2).setRoughnessFactor(0.55)
      for (const e of m.listExtensions()) m.setExtension(e.extensionName, null)
      p.setAttribute('TEXCOORD_0', null)
    }

// нормали по углу: вершина сглаживается только с гранями, отличающимися не больше чем на ANGLE (острые кромки остаются острыми)
const ANGLE = Math.cos((40 * Math.PI) / 180)
function angleNormals(q) {
  const P = q.getAttribute('POSITION').getArray()
  const I = q.getIndices().getArray()
  const uv = q.getAttribute('TEXCOORD_0')?.getArray()
  const nf = I.length / 3
  const fn = new Float32Array(nf * 3)
  for (let f = 0; f < nf; f++) {
    const a = I[f * 3] * 3, b = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2]
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2]
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z) || 1
    fn[f * 3] = x / l; fn[f * 3 + 1] = y / l; fn[f * 3 + 2] = z / l
  }
  const key = (i) => Math.round(P[i * 3] * 1e5) + ',' + Math.round(P[i * 3 + 1] * 1e5) + ',' + Math.round(P[i * 3 + 2] * 1e5)
  const faces = new Map()
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) {
    const kk = key(I[f * 3 + k])
    if (!faces.has(kk)) faces.set(kk, [])
    faces.get(kk).push(f)
  }
  const pos = new Float32Array(nf * 9), nor = new Float32Array(nf * 9), tex = uv ? new Float32Array(nf * 6) : null
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) {
    const v = I[f * 3 + k], o = (f * 3 + k)
    pos.set(P.subarray(v * 3, v * 3 + 3), o * 3)
    if (tex) tex.set(uv.subarray(v * 2, v * 2 + 2), o * 2)
    let x = 0, y = 0, z = 0
    for (const g of faces.get(key(v))) {
      const d = fn[f * 3] * fn[g * 3] + fn[f * 3 + 1] * fn[g * 3 + 1] + fn[f * 3 + 2] * fn[g * 3 + 2]
      if (d >= ANGLE) { x += fn[g * 3]; y += fn[g * 3 + 1]; z += fn[g * 3 + 2] }
    }
    const l = Math.hypot(x, y, z) || 1
    nor[o * 3] = x / l; nor[o * 3 + 1] = y / l; nor[o * 3 + 2] = z / l
  }
  const acc = (arr, type) => doc.createAccessor().setType(type).setArray(arr)
  q.setAttribute('POSITION', acc(pos, 'VEC3')).setAttribute('NORMAL', acc(nor, 'VEC3'))
  if (tex) q.setAttribute('TEXCOORD_0', acc(tex, 'VEC2'))
  q.setIndices(null)
}

// детали в оси колеса, упрощение каждой отдельно (у каждой своя кривизна), потом слияние по материалу — меньше вызовов отрисовки.
// Нормали снимаются до упрощения (из-за граней с разными нормалями вершины не склеиваются и упрощение не идёт), потом считаются заново
// карбоновый диск почти весь за спицами и ободом, а вентиляционные отверстия дают ~80 тыс. треугольников — допуск в 8 раз больше
const PART_ERR = { 'Диск_карбон': 8 }
await MeshoptSimplifier.ready
function assemble(name, list, err) {
  const groups = new Map()
  const tmp = doc.createMesh('tmp_' + name)
  for (const x of list) {
    const rel = mat4.multiply(mat4.create(), toLocalRim, x.getWorldMatrix())
    for (const p of x.getMesh().listPrimitives()) {
      // у части деталей в файле нет индексов — их проставит weld ниже

      // копия со своими данными: одна деталь идёт в два колеса (полное и облегчённое), общие буферы повернулись бы дважды
      const q = p.clone()
      for (const sem of q.listSemantics()) q.setAttribute(sem, q.getAttribute(sem).clone())
      if (q.getIndices()) q.setIndices(q.getIndices().clone())
      transformPrimitive(q, rel)
      q.setAttribute('NORMAL', null)
      q.setExtras({ k: PART_ERR[x.getName()] || 1 })
      tmp.addPrimitive(q)
    }
  }
  return { name, tmp, err }
}
const lists = [assemble('wheel_spin', spinParts, +ERR), assemble('wheel_caliper', caliperParts, +ERR), assemble('wheel_spin_lo', spinParts, +ERR * 6), assemble('wheel_caliper_lo', caliperParts, +ERR * 6)]
await doc.transform(weld({ tolerance: 0.00002 }))
const finished = []
for (const { name, tmp, err } of lists) {
  const groups = new Map()
  const mats = root.listMaterials()
  for (const q of tmp.listPrimitives()) {
    const pos = q.getAttribute('POSITION')
    const mn = pos.getMin([])
    const mx = pos.getMax([])
    const r = Math.max(Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2, 1e-4)
    simplifyPrimitive(q, { simplifier: MeshoptSimplifier, ratio: 0, error: Math.min(Math.min(err * (q.getExtras().k || 1), 0.004) / r, 0.5) }) // больше 4 мм — деталь разваливается
    if (!q.getIndices() || q.getIndices().getCount() < 3) continue
    angleNormals(q)
    // у облегчённого колеса (боты) металл одного имени — один материал: меньше вызовов отрисовки на 44 колеса
    const lo = name.endsWith('_lo')
    const key = (lo ? q.getMaterial()?.getName() : mats.indexOf(q.getMaterial())) + '|' + q.listSemantics().sort().join(',')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(q)
  }
  const mesh = doc.createMesh(name)
  for (const prims of groups.values()) {
    for (const q of prims) q.setMaterial(prims[0].getMaterial())
    mesh.addPrimitive(prims.length > 1 ? joinPrimitives(prims, { skipValidation: true }) : prims[0])
  }
  tmp.dispose()
  finished.push(doc.createNode(name).setMesh(mesh))
}
const [spin, caliper, spinLo, caliperLo] = finished

// всё остальное — вон, комплекты и колесо — в сцену
for (const c of scene.listChildren()) scene.removeChild(c)
const keep = new Set([spin, caliper, spinLo, caliperLo, ...out, ...out.flatMap((o) => o.listChildren())])
for (const n of root.listNodes()) if (!keep.has(n)) n.dispose()
for (const n of [spin, caliper, spinLo, caliperLo, ...out]) scene.addChild(n)
for (const ext of root.listExtensionsUsed()) if (ext.extensionName === KHRLightsPunctual.EXTENSION_NAME) ext.dispose()
// материалы шин: Протектор_soft → tyre_tread_soft, Боковина_inter → tyre_sidewall_intermediate
for (const mat of root.listMaterials()) {
  const m = /^(Протектор|Боковина)_(\w+)$/.exec(mat.getName())
  if (m) mat.setName(`tyre_${m[1] === 'Протектор' ? 'tread' : 'sidewall'}_${MAT[m[2]] || m[2]}`)
}
await doc.transform(prune({ keepLeaves: true }), weld({ tolerance: 0.00001 }))

const before = tri()
for (const mesh of root.listMeshes()) {
  if (!mesh.getName().startsWith('tyre_')) continue
  for (const p of mesh.listPrimitives()) {
    // протектор промежуточных и дождевых — канавки геометрией: допуск больше, иначе ~60 тыс. треугольников на шину
    const grooves = /tread_(intermediate|wet)/.test(mesh.getName())
    if (!p.getIndices()) continue
    const pos = p.getAttribute('POSITION')
    const mn = pos.getMin([])
    const mx = pos.getMax([])
    const r = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2
    simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: 0, error: (+ERR * (grooves ? +GROOVE : 1)) / r, lockBorder: !grooves })
  }
}
console.log('шины', Math.round(before), '→', Math.round(tri()))
for (const mesh of root.listMeshes()) console.log('  ', mesh.getName(), triOf(mesh), 'частей', mesh.listPrimitives().length, mesh.listPrimitives().map((p) => p.getMaterial()?.getName()).join(' | '))
await doc.transform(prune({ keepLeaves: true }), dedup(), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 85 }), unpartition())
// металл диска — мелкая зернистость, 512 хватает
for (const t of root.listTextures()) {
  const users = t.listParents().filter((p) => p.propertyType === 'Material').map((m) => m.getName())
  if (users.length && users.every((u) => !u.startsWith('tyre_'))) {
    const img = await sharp(t.getImage()).resize(512, 512, { fit: 'inside' }).webp({ quality: 85 }).toBuffer()
    t.setImage(new Uint8Array(img))
  }
}
await io.write(OUT, doc)
console.log('готово, материалы:', root.listMaterials().map((m) => m.getName()).join(', '))
console.log('текстур', root.listTextures().length)
