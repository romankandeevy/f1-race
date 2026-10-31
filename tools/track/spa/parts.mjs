// Детали трассы «Спа-Франкоршам» для Forma: код three.js, который строит каждую часть из чисел out/spa-data.json.
// В Forma (model3d_run) по одной части за вызов:
//   const P = await import('http://127.0.0.1:8799/parts.mjs?' + Date.now())
//   const D = await P.load()
//   add(P.surface(THREE, D), find('Трасса'))
// Имена деталей и групп — как читает игра (src/circuit.js, server/track-node.mjs), материалы — как у Marina Bay.

export async function load(url = 'http://127.0.0.1:8799/out/spa-data.json') {
  if (globalThis.__spaData) return globalThis.__spaData
  const r = await fetch(url + '?' + Date.now())
  globalThis.__spaData = await r.json()
  return globalThis.__spaData
}
export function reset() {
  globalThis.__spaData = null
  globalThis.__spaMats = null
}

// ---------- материалы (общие на всю модель, по имени) ----------
const MAT = {
  asphalt: { color: '#2c2d31', roughness: 0.9 },
  'пол боксов': { color: '#3a3c41', roughness: 0.9 },
  'разметка белая': { color: '#f4f4f4', roughness: 0.5 },
  'поребрик красный': { color: '#d7141a', roughness: 0.6 },
  гравий: { color: '#a89a7c', roughness: 1 },
  grass: { color: '#4b7a33', roughness: 1 },
  'трава склонов': { color: '#ffffff', roughness: 1, vertexColors: true },
  'металл отбойника': { color: '#b9bec4', roughness: 0.35, metalness: 0.8 },
  TecPro: { color: '#ffffff', roughness: 0.7, vertexColors: true },
  'бетон блока': { color: '#d9d9d4', roughness: 0.85 },
  сетка: { color: '#9aa0a6', roughness: 0.6, metalness: 0.5, transparent: true, opacity: 0.32, depthWrite: false },
  'металл сетки': { color: '#8c9196', roughness: 0.45, metalness: 0.7 },
  'огонь старта (тёмный)': { color: '#2a0000', roughness: 0.3, emissive: '#000000' },
  металл: { color: '#5d6168', roughness: 0.4, metalness: 0.7 },
  хвоя: { color: '#ffffff', roughness: 0.95, vertexColors: true },
  листва: { color: '#ffffff', roughness: 0.95, vertexColors: true },
  ствол: { color: '#4a3a2c', roughness: 1 },
  'бетон трибуны': { color: '#b8b6b0', roughness: 0.9 },
  зрители: { color: '#ffffff', roughness: 0.9, vertexColors: true },
  крыша: { color: '#e8e8e8', roughness: 0.5, metalness: 0.3 },
  'ангар тёмный': { color: '#24262b', roughness: 0.8 },
  'фасад команд': { color: '#eceef0', roughness: 0.6 },
  стекло: { color: '#2a3b4a', roughness: 0.08, metalness: 0.3 },
  'асфальт паддока': { color: '#55575c', roughness: 0.95 },
  моторхоум: { color: '#ffffff', roughness: 0.4, metalness: 0.2, vertexColors: true },
  'красный акцент': { color: '#c8102e', roughness: 0.5 },
}
function mat(THREE, name) {
  globalThis.__spaMats ||= new Map()
  const cache = globalThis.__spaMats
  if (cache.has(name)) return cache.get(name)
  const o = MAT[name]
  const m = new THREE.MeshStandardMaterial({
    name,
    color: new THREE.Color(o.color),
    roughness: o.roughness ?? 0.8,
    metalness: o.metalness ?? 0,
    vertexColors: !!o.vertexColors,
    transparent: !!o.transparent,
    opacity: o.opacity ?? 1,
    depthWrite: o.depthWrite ?? true,
    side: THREE.DoubleSide,
  })
  if (o.emissive) m.emissive = new THREE.Color(o.emissive)
  cache.set(name, m)
  return m
}

// ---------- геометрия ----------
const wrapI = (D, i) => ((i % D.N) + D.N) % D.N
// точка сечения: lat > 0 — влево по ходу
function at(D, i, lat, dy = 0) {
  const [x, y, z, a] = D.axis1m[wrapI(D, i)]
  return [x + Math.sin(a) * lat, y + dy, z - Math.cos(a) * lat]
}
const sgn = (side) => (side === 'L' ? 1 : -1)

class Builder {
  constructor() {
    this.p = []
    this.uv = []
    this.c = []
    this.idx = []
  }
  v(p, u = 0, w = 0, col) {
    this.p.push(p[0], p[1], p[2])
    this.uv.push(u, w)
    if (col) this.c.push(col[0], col[1], col[2])
    return this.p.length / 3 - 1
  }
  tri(a, b, c) {
    this.idx.push(a, b, c)
  }
  quad(a, b, c, d) {
    // a-b вдоль первой строки, d-c вдоль второй: a b / d c
    this.idx.push(a, d, b, b, d, c)
  }
  geo(THREE, { normals = true } = {}) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    if (this.c.length) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3))
    g.setIndex(this.idx)
    if (normals) g.computeVertexNormals()
    return g
  }
}

// лента по оси: cols(i) — список смещений (lat, со знаком), ys(i) — высоты (или null — уровень оси + dy);
// keep(i0, i1) — рисовать ли участок; шаг stride м
function ribbon(THREE, D, { cols, ys = null, dy = 0, keep = () => true, stride = 2, uvScale = 1, from = 0, to = null, loop = true, fixNormalsUp = true }) {
  const b = new Builder()
  const rows = []
  const end = to ?? D.N
  for (let i = from; i < end; i += stride) rows.push(i)
  if (!loop && rows[rows.length - 1] !== end) rows.push(end)
  const rowV = new Map()
  const rowOf = (i) => {
    if (rowV.has(i)) return rowV.get(i)
    const c = cols(wrapI(D, i))
    const h = ys ? ys(wrapI(D, i)) : null
    const vs = c.map((lat, k) => {
      const p = at(D, i, lat, dy)
      if (h) p[1] = h[k]
      return b.v(p, lat / uvScale, i / uvScale)
    })
    rowV.set(i, vs)
    return vs
  }
  const n = rows.length
  for (let k = 0; k < (loop ? n : n - 1); k++) {
    const i0 = rows[k]
    const i1 = loop && k === n - 1 ? rows[0] + D.N : rows[k + 1]
    if (!keep(wrapI(D, i0), wrapI(D, i1))) continue
    const a = rowOf(i0)
    const c = rowOf(i1)
    for (let j = 0; j < a.length - 1; j++) {
      // порядок обхода — чтобы нормаль смотрела вверх
      const lat0 = cols(wrapI(D, i0))
      const leftward = lat0[j + 1] > lat0[j]
      if (leftward) b.idx.push(a[j], a[j + 1], c[j], a[j + 1], c[j + 1], c[j])
      else b.idx.push(a[j], c[j], a[j + 1], a[j + 1], c[j], c[j + 1])
    }
  }
  const g = b.geo(THREE)
  if (fixNormalsUp) {
    const nrm = g.getAttribute('normal')
    for (let k = 0; k < nrm.count; k++) if (nrm.getY(k) < 0) nrm.setXYZ(k, -nrm.getX(k), -nrm.getY(k), -nrm.getZ(k))
  }
  return g
}

function mesh(THREE, name, geo, matName) {
  const m = new THREE.Mesh(geo, mat(THREE, matName))
  m.name = name
  return m
}
function group(THREE, name, children = []) {
  const g = new THREE.Group()
  g.name = name
  for (const c of children) if (c) g.add(c)
  return g
}
const C = (D, side, i) => {
  const c = D.cols[side][i]
  return { lo: c[0], a: c[1], p: c[2], f: c[3], g: c[4], b: c[5], e: c[6], wall: c[7] }
}

// ---------- 1. Корень ----------
export function root(THREE) {
  return group(THREE, 'Трасса', [
    group(THREE, 'Покрытие (коллизия)'),
    group(THREE, 'Разметка (без коллизии)'),
    group(THREE, 'Газон'),
    group(THREE, 'Ограждения (коллизия)', [group(THREE, 'Сетка (без коллизии)')]),
    group(THREE, 'Стартовый портал'),
    group(THREE, 'Пит-комплекс'),
    group(THREE, 'Трибуны'),
    group(THREE, 'Окружение'),
    group(THREE, 'Служебное (точки и оси)'),
  ])
}

// ---------- 2. Покрытие: полотно, зоны безопасности, пит-лейн, пол боксов, гравий ----------
export function surface(THREE, D) {
  const out = []
  // полотно: от внешнего края правой белой линии до левой, UV в единицах по 4 м (у игры плитка асфальта 4 м на единицу)
  out.push(mesh(THREE, 'Полотно трассы', ribbon(THREE, D, { cols: (i) => [-C(D, 'R', i).lo, 0, C(D, 'L', i).lo], uvScale: 4 }), 'asphalt'))
  // зоны безопасности (асфальт за линией): обе стороны в одной детали
  const runoff = (side) => ribbon(THREE, D, { cols: (i) => [C(D, side, i).lo * sgn(side), C(D, side, i).a * sgn(side)], uvScale: 4 })
  out.push(mesh(THREE, 'Зоны безопасности', mergeGeos(THREE, [runoff('L'), runoff('R')]), 'asphalt'))
  // пит-лейн (слева) и пол боксов
  const wide = (k0, k1) => (i0, i1) => {
    const a = D.cols.L[i0]
    const b = D.cols.L[i1]
    return a[k1] - a[k0] > 0.01 || b[k1] - b[k0] > 0.01
  }
  out.push(mesh(THREE, 'Пит-лейн', ribbon(THREE, D, { cols: (i) => [C(D, 'L', i).a, C(D, 'L', i).p], keep: wide(1, 2), uvScale: 4 }), 'asphalt'))
  out.push(mesh(THREE, 'Пол боксов', ribbon(THREE, D, { cols: (i) => [C(D, 'L', i).p, C(D, 'L', i).f], keep: wide(2, 3) }), 'пол боксов'))
  // гравий
  const grav = (side) =>
    ribbon(THREE, D, {
      cols: (i) => [C(D, side, i).f * sgn(side), C(D, side, i).g * sgn(side)],
      keep: (i0, i1) => D.cols[side][i0][4] - D.cols[side][i0][3] > 0.05 || D.cols[side][i1][4] - D.cols[side][i1][3] > 0.05,
    })
  out.push(mesh(THREE, 'Гравий', mergeGeos(THREE, [grav('L'), grav('R')]), 'гравий'))
  return out
}

function mergeGeos(THREE, geos) {
  const pos = []
  const nrm = []
  const uv = []
  const col = []
  const idx = []
  let off = 0
  const hasColor = geos.every((g) => g.getAttribute('color'))
  for (const g of geos) {
    const p = g.getAttribute('position')
    const app = (dst, src) => {
      for (let k = 0; k < src.length; k++) dst.push(src[k])
    }
    app(pos, p.array)
    app(nrm, g.getAttribute('normal').array)
    app(uv, g.getAttribute('uv').array)
    if (hasColor) app(col, g.getAttribute('color').array)
    for (const k of g.index.array) idx.push(k + off)
    off += p.count
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  if (hasColor) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setIndex(idx)
  return g
}

// ---------- 3. Разметка: линии, старт, решётка, пит-лейн, поребрики ----------
export function markings(THREE, D) {
  const out = []
  const LW = D.LW
  const line = (side) => ribbon(THREE, D, { cols: (i) => [D.W[i] * sgn(side), (D.W[i] + LW) * sgn(side)], dy: 0.01 })
  out.push(mesh(THREE, 'Линия края слева', line('L'), 'разметка белая'))
  out.push(mesh(THREE, 'Линия края справа', line('R'), 'разметка белая'))
  // линия пит-лейна: по краю пит-лейна у трассы, где пит-лейн отделён (и на въезде/выезде)
  out.push(
    mesh(
      THREE,
      'Линия пит-лейна у трассы',
      ribbon(THREE, D, {
        cols: (i) => [C(D, 'L', i).a, C(D, 'L', i).a + LW],
        dy: 0.01,
        keep: (i0, i1) => D.cols.L[i0][2] - D.cols.L[i0][1] > 4 && D.cols.L[i1][2] - D.cols.L[i1][1] > 4,
      }),
      'разметка белая',
    ),
  )
  // старт-финиш: полоса 0,6 м поперёк
  {
    const b = new Builder()
    const wl = D.W[0] + LW
    // по касательной от точки 0
    const [x, y, z, a] = D.axis1m[0]
    const tx = Math.cos(a)
    const tz = Math.sin(a)
    const nx = Math.sin(a)
    const nz = -Math.cos(a)
    const P = (s, l) => [x + tx * s + nx * l, y + 0.012, z + tz * s + nz * l]
    const q = [P(-0.3, -wl), P(-0.3, wl), P(0.3, wl), P(0.3, -wl)].map((p) => b.v(p))
    b.idx.push(q[0], q[2], q[1], q[0], q[3], q[2])
    out.push(mesh(THREE, 'Линия старта-финиша белая', b.geo(THREE), 'разметка белая'))
  }
  // решётка: у каждого места «скобка» — полоса поперёк перед болидом и два уса назад
  {
    const b = new Builder()
    for (const g of D.grid) {
      const s = g.distance_m
      const i = Math.round(s)
      const [x, y, z, a] = D.axis1m[wrapI(D, i)]
      const tx = Math.cos(a)
      const tz = Math.sin(a)
      const nx = Math.sin(a)
      const nz = -Math.cos(a)
      const P = (ds, l) => [x + tx * ds + nx * l, y + 0.011, z + tz * ds + nz * l]
      const rect = (s0, s1, l0, l1) => {
        const q = [P(s0, l0), P(s0, l1), P(s1, l1), P(s1, l0)].map((p) => b.v(p))
        b.idx.push(q[0], q[1], q[2], q[0], q[2], q[3])
      }
      const L = g.lateral_m
      rect(2.6, 2.8, L - 1.1, L + 1.1)
      rect(1.2, 2.6, L - 1.1, L - 0.9)
      rect(1.2, 2.6, L + 0.9, L + 1.1)
    }
    const geo = b.geo(THREE)
    fixUp(geo)
    out.push(mesh(THREE, 'Стартовая решётка', geo, 'разметка белая'))
  }
  // поребрики: полосы по 1 м, красная/белая по очереди, от внешнего края линии на 1,2 м наружу, +3 см
  for (const [name, color] of [
    ['Поребрики красные', 0],
    ['Поребрики белые', 1],
  ]) {
    const geos = []
    for (const side of ['L', 'R']) {
      const prof = [0, 0.15, 1.05, D.KERB_W]
      const hgt = [0.005, D.KERB_H, D.KERB_H, 0.005]
      geos.push(
        ribbon(THREE, D, {
          stride: 1,
          cols: (i) => prof.map((u) => (D.cols[side][i][0] + u) * sgn(side)),
          ys: (i) => hgt.map((h) => D.axis1m[i][1] + h),
          keep: (i0, i1) => D.kerb[side][i0] && D.kerb[side][i1] && i0 % 2 === color,
        }),
      )
    }
    out.push(mesh(THREE, name, mergeGeos(THREE, geos), color === 0 ? 'поребрик красный' : 'разметка белая'))
  }
  return out
}
function fixUp(g) {
  const nrm = g.getAttribute('normal')
  for (let k = 0; k < nrm.count; k++) if (nrm.getY(k) < 0) nrm.setXYZ(k, -nrm.getX(k), -nrm.getY(k), -nrm.getZ(k))
}

// ---------- 4. Газон: лента у трассы и склоны (земля сеткой) ----------
export function grass(THREE, D) {
  const band = (side) =>
    ribbon(THREE, D, {
      cols: (i) => {
        const c = C(D, side, i)
        const q = D.ribbon[side][i]
        const g = c.g
        const lv = Math.max(q[0], g + 0.2)
        const mid = Math.max(q[1], lv + 0.1)
        const e = Math.max(c.e, mid + 0.1)
        return [g, lv, mid, e].map((u) => u * sgn(side))
      },
      ys: (i) => {
        const y = D.axis1m[i][1]
        const q = D.ribbon[side][i]
        return [y, y, q[2], q[3]]
      },
      uvScale: 1,
    })
  return mesh(THREE, 'Газон у трассы', mergeGeos(THREE, [band('L'), band('R')]), 'grass')
}
export function slopes(THREE, D) {
  const t = D.terrain
  const b = new Builder()
  // цвета вершин линейные: у газона у трассы #4b7a33 ≈ (0.07, 0.195, 0.033)
  const near = [0.07, 0.19, 0.035]
  const forest = [0.022, 0.06, 0.018]
  for (let iz = 0; iz < t.nz; iz++)
    for (let ix = 0; ix < t.nx; ix++) {
      const k = iz * t.nx + ix
      const f = t.c[k] / 255
      const n = (Math.sin(ix * 12.9898 + iz * 78.233) * 43758.5453) % 1
      const j = 0.92 + 0.12 * Math.abs(n)
      const col = near.map((v, c) => (v * (1 - f) + forest[c] * f) * j)
      b.v([t.x0 + ix * t.step, t.h[k], t.z0 + iz * t.step], ix * t.step / 8, iz * t.step / 8, col)
    }
  for (let iz = 0; iz < t.nz - 1; iz++)
    for (let ix = 0; ix < t.nx - 1; ix++) {
      const a = iz * t.nx + ix
      b.idx.push(a, a + t.nx, a + 1, a + 1, a + t.nx, a + t.nx + 1)
    }
  const g = b.geo(THREE)
  fixUp(g)
  return mesh(THREE, 'Склоны', g, 'трава склонов')
}

// ---------- 5. Ограждения ----------
// стенка вдоль ленты: перед на смещении front(i), толщина th, высота h (от уровня оси), низ на 0,4 м в землю
function wallAlong(THREE, D, side, front, th, h, keep, stride = 2, colorFn = null) {
  const b = new Builder()
  const s = sgn(side)
  const runs = []
  let cur = null
  for (let i = 0; i <= D.N; i += stride) {
    const ii = wrapI(D, i)
    if (keep(ii)) {
      if (!cur) cur = []
      cur.push(i)
    } else if (cur) {
      runs.push(cur)
      cur = null
    }
  }
  if (cur) runs.push(cur)
  // склеить первый и последний, если круг замкнут
  if (runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][runs[runs.length - 1].length - 1] === D.N) {
    const last = runs.pop()
    runs[0] = last.slice(0, -1).concat(runs[0].map((i) => i + D.N))
  }
  for (const run of runs) {
    if (run.length < 2) continue
    const pts = run.map((i) => {
      const ii = wrapI(D, i)
      const f = front(ii)
      const y = D.axis1m[ii][1]
      return { fb: at(D, i, f * s, -0.4), ft: at(D, i, f * s, h), bt: at(D, i, (f + th) * s, h), bb: at(D, i, (f + th) * s, -0.4), i: ii }
    })
    const faces = [
      ['fb', 'ft'],
      ['ft', 'bt'],
      ['bt', 'bb'],
    ]
    for (const [p, q] of faces) {
      const ids = pts.map((o, k) => {
        const col = colorFn ? colorFn(o.i, k) : null
        return [b.v(o[p], k * stride, 0, col), b.v(o[q], k * stride, 1, col)]
      })
      for (let k = 0; k < ids.length - 1; k++) b.idx.push(ids[k][0], ids[k + 1][0], ids[k][1], ids[k][1], ids[k + 1][0], ids[k + 1][1])
    }
    // торцы
    for (const o of [pts[0], pts[pts.length - 1]]) {
      const q = [o.fb, o.ft, o.bt, o.bb].map((p) => b.v(p, 0, 0, colorFn ? colorFn(o.i, 0) : null))
      b.idx.push(q[0], q[1], q[2], q[0], q[2], q[3])
    }
  }
  // нормали по граням: вершины граней не общие, computeVertexNormals даёт плоские грани по сечению
  return b.geo(THREE)
}

export function barriers(THREE, D) {
  const out = []
  const b = (side, i) => D.cols[side][i][5]
  const startZone = (i) => {
    const s = i > D.N / 2 ? i - D.N : i
    return s > -420 && s < 250
  }
  const kind = (side, i) => (b(side, i) <= 0 ? null : D.tecpro[side][i] ? 'tec' : side === 'R' && startZone(i) ? 'wall' : 'armco')
  const geosA = []
  const geosT = []
  const geosW = []
  for (const side of ['L', 'R']) {
    geosA.push(wallAlong(THREE, D, side, (i) => b(side, i), 0.4, 0.85, (i) => kind(side, i) === 'armco', 4)) // через 4 м: отбойник далеко от линии
    geosT.push(
      wallAlong(THREE, D, side, (i) => b(side, i), 1.0, 1.0, (i) => kind(side, i) === 'tec', 2, (i) => (Math.floor(i / 2) % 2 ? [0.05, 0.25, 0.75] : [0.85, 0.08, 0.1])),
    )
    geosW.push(wallAlong(THREE, D, side, (i) => b(side, i), 0.6, 1.1, (i) => kind(side, i) === 'wall'))
  }
  out.push(mesh(THREE, 'Отбойники', mergeGeos(THREE, geosA), 'металл отбойника'))
  out.push(mesh(THREE, 'Барьеры TecPro', mergeGeos(THREE, geosT), 'TecPro'))
  out.push(mesh(THREE, 'Бетонные стены', mergeGeos(THREE, geosW), 'бетон блока'))
  // пит-уолл: между трассой и пит-лейном, на 2 м от края пит-лейна, толщина 1 м
  out.push(mesh(THREE, 'Пит-уолл', wallAlong(THREE, D, 'L', (i) => D.D[i] - 6 - 2, 1.0, 1.2, (i) => D.cols.L[i][7] === 1), 'бетон блока'))
  // задняя стена гаражей (внутри здания): дальше пола боксов не уехать
  out.push(mesh(THREE, 'Стена пит-лейна (у боксов)', wallAlong(THREE, D, 'L', (i) => D.cols.L[i][3], 0.5, 3, (i) => D.inBox[i] === 1), 'ангар тёмный'))
  return out
}
// сетка-уловитель над бетонными стенами и пит-уоллом: столбы через 4 м и сетка 3 м
export function fences(THREE, D) {
  const startZone = (i) => {
    const s = i > D.N / 2 ? i - D.N : i
    return s > -420 && s < 250
  }
  const runsR = (i) => D.cols.R[i][5] > 0 && startZone(i) && !D.tecpro.R[i]
  const runsP = (i) => D.cols.L[i][7] === 1
  const net = []
  const posts = new Builder()
  for (const [side, keep, front] of [
    ['R', runsR, (i) => D.cols.R[i][5] + 0.3],
    ['L', runsP, (i) => D.D[i] - 6 - 1.5],
  ]) {
    net.push(ribbonWall(THREE, D, side, front, 1.1, 4.2, keep))
    for (let i = 0; i < D.N; i += 4) {
      if (!keep(i)) continue
      const f = front(i) * sgn(side)
      const [x0, y0, z0] = at(D, i, f - 0.06 * sgn(side), 0)
      const [x1, , z1] = at(D, i, f + 0.06 * sgn(side), 0)
      box(posts, [(x0 + x1) / 2, y0 + 2.6, (z0 + z1) / 2], [0.12, 3.4, 0.12], D.axis1m[i][3])
    }
  }
  return [mesh(THREE, 'Сетка-уловитель', mergeGeos(THREE, net), 'сетка'), mesh(THREE, 'Столбы сетки', posts.geo(THREE), 'металл сетки')]
}
function ribbonWall(THREE, D, side, front, y0, y1, keep) {
  const b = new Builder()
  let prev = null
  for (let i = 0; i <= D.N; i += 2) {
    const ii = wrapI(D, i)
    if (!keep(ii)) {
      prev = null
      continue
    }
    const f = front(ii) * sgn(side)
    const lo = b.v(at(D, i, f, y0), i / 2, 0)
    const hi = b.v(at(D, i, f, y1), i / 2, 1)
    if (prev) b.idx.push(prev[0], lo, prev[1], prev[1], lo, hi)
    prev = [lo, hi]
  }
  return b.geo(THREE)
}
// коробка в общий Builder: центр, размеры, поворот вокруг Y (a — направление оси трассы)
function box(b, c, size, a = 0, col = null) {
  const [sx, sy, sz] = size.map((v) => v / 2)
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  // локальные оси: u вдоль (cos a, sin a), w поперёк (sin a, -cos a)
  const P = (u, v, w) => [c[0] + ca * u + sa * w, c[1] + v, c[2] + sa * u - ca * w]
  const faces = [
    [[sx, -sy, -sz], [sx, sy, -sz], [sx, sy, sz], [sx, -sy, sz]],
    [[-sx, -sy, sz], [-sx, sy, sz], [-sx, sy, -sz], [-sx, -sy, -sz]],
    [[-sx, sy, -sz], [-sx, sy, sz], [sx, sy, sz], [sx, sy, -sz]],
    [[-sx, -sy, sz], [-sx, -sy, -sz], [sx, -sy, -sz], [sx, -sy, sz]],
    [[-sx, -sy, sz], [sx, -sy, sz], [sx, sy, sz], [-sx, sy, sz]],
    [[sx, -sy, -sz], [-sx, -sy, -sz], [-sx, sy, -sz], [sx, sy, -sz]],
  ]
  for (const f of faces) {
    const q = f.map((p) => b.v(P(...p), 0, 0, col))
    b.idx.push(q[0], q[1], q[2], q[0], q[2], q[3])
  }
}

// ---------- 6. Стартовый портал и огни ----------
export function gantry(THREE, D) {
  const out = []
  const [x, y, z, a] = D.axis1m[0]
  const tx = Math.cos(a)
  const tz = Math.sin(a)
  const P = (s, l, h) => [x + tx * s + Math.sin(a) * l, y + h, z + tz * s - Math.cos(a) * l]
  const latR = -(D.cols.R[0][5] + 1.2)
  const latL = D.D[0] - 6 - 1.5
  const b = new Builder()
  box(b, P(0, latR, 3.9), [0.6, 8.6, 0.6], a)
  box(b, P(0, latL, 3.9), [0.6, 8.6, 0.6], a)
  const mid = (latL + latR) / 2
  box(b, P(0, mid, 7.9), [0.9, 0.7, latL - latR + 0.6], a)
  box(b, P(-0.1, 0, 6.55), [0.35, 2.2, 4.4], a) // панель огней
  out.push(mesh(THREE, 'Ферма портала', b.geo(THREE), 'металл'))
  // огни: пять колонн по две, слева направо по ходу движения, смотрят навстречу болидам
  const lamps = []
  for (let n = 1; n <= 5; n++) {
    const lat = (3 - n) * 0.85
    for (const [part, h] of [
      ['верх', 7.0],
      ['низ', 6.25],
    ]) {
      const g = new THREE.CylinderGeometry(0.17, 0.17, 0.08, 20)
      g.rotateZ(Math.PI / 2) // ось цилиндра — вдоль X
      const m = mesh(THREE, `Огонь старта ${n} ${part}`, g, 'огонь старта (тёмный)')
      const p = P(-0.32, lat, h)
      m.position.set(p[0], p[1], p[2])
      m.rotation.y = -a // локальный X → вдоль трассы
      lamps.push(m)
    }
  }
  return out.concat(lamps)
}

// ---------- 7. Пит-комплекс и паддок ----------
function sweep(b, path, profile, colFn = null) {
  // path: [{x,y,z,nx,nz}], profile: [[u, v], ...] (u — от пути наружу по nx/nz, v — вверх от y); каждая грань отдельно
  for (let e = 0; e < profile.length - 1; e++) {
    const [u0, v0] = profile[e]
    const [u1, v1] = profile[e + 1]
    const ids = path.map((p, k) => [
      b.v([p.x + p.nx * u0, p.y + v0, p.z + p.nz * u0], k, v0, colFn ? colFn(e, k) : null),
      b.v([p.x + p.nx * u1, p.y + v1, p.z + p.nz * u1], k, v1, colFn ? colFn(e, k) : null),
    ])
    for (let k = 0; k < ids.length - 1; k++) b.idx.push(ids[k][0], ids[k + 1][0], ids[k][1], ids[k][1], ids[k + 1][0], ids[k + 1][1])
  }
}
export function pitComplex(THREE, D) {
  const pb = D.pitBuilding
  const path = (off) => pb.map((p) => ({ x: p.x + p.nx * off, y: p.y, z: p.z + p.nz * off, nx: p.nx, nz: p.nz }))
  const f0 = pb[0].front
  const back = pb[0].back
  const P = path(0)
  const out = []
  // гаражи: тёмный объём (внутри)
  const g = new Builder()
  sweep(g, P, [[f0 + 0.6, -1], [f0 + 0.6, 4.6], [back, 4.6], [back, -1]])
  out.push(mesh(THREE, 'Гаражи команд', g.geo(THREE), 'ангар тёмный'))
  // фасад: простенки между воротами (10 гаражей по 2 бокса) и перемычка над воротами
  const f = new Builder()
  const pitN = pb.length
  const total = Math.hypot(pb[pitN - 1].x - pb[0].x, pb[pitN - 1].z - pb[0].z)
  const a = Math.atan2(pb[pitN - 1].z - pb[0].z, pb[pitN - 1].x - pb[0].x)
  const along = (d, off, h) => [pb[0].x + Math.cos(a) * d + pb[0].nx * off, pb[0].y + h, pb[0].z + Math.sin(a) * d + pb[0].nz * off]
  const garages = 10
  const gw = total / garages
  for (let k = 0; k <= garages; k++) box(f, along(k * gw, f0 + 0.3, 2.5), [1.2, 5, 0.6], a)
  sweep(f, P, [[f0, 4.0], [f0, 5.0], [f0 + 0.6, 5.0]])
  out.push(mesh(THREE, 'Фасад команд', f.geo(THREE), 'фасад команд'))
  // Paddock Club: второй и третий этаж с остеклением, нависает над пол боксов
  const pc = new Builder()
  sweep(pc, P, [[f0 - 2, 5.0], [f0 - 2, 5.6], [f0 - 2, 5.6], [back, 5.6], [back, 11.6], [f0 - 2, 11.6], [f0 - 2, 11.0]])
  sweep(pc, P, [[f0 - 2.2, 11.6], [back + 0.3, 11.6], [back + 0.3, 12.2], [f0 - 2.2, 12.2], [f0 - 2.2, 11.6]])
  sweep(pc, P, [[back, -1], [back, 5.0]])
  out.push(mesh(THREE, 'Paddock Club', pc.geo(THREE), 'фасад команд'))
  const gl = new Builder()
  sweep(gl, P, [[f0 - 2.05, 5.7], [f0 - 2.05, 10.9]])
  out.push(mesh(THREE, 'Paddock Club стекло', gl.geo(THREE), 'стекло'))
  // красная полоса с названием над гаражами
  const red = new Builder()
  sweep(red, P, [[f0 - 0.05, 4.1], [f0 - 0.05, 4.9]])
  out.push(mesh(THREE, 'Полоса над боксами', red.geo(THREE), 'красный акцент'))
  // вышка дирекции гонки за зданием у финиша
  const tw = new Builder()
  const ti = pb.findIndex((p, k) => k > pitN * 0.62)
  const T0 = pb[ti]
  const tc = [T0.x + T0.nx * (back + 8), T0.y + 9, T0.z + T0.nz * (back + 8)]
  box(tw, tc, [10, 18, 10], a)
  box(tw, [tc[0], tc[1] + 9.4, tc[2]], [12, 0.8, 12], a)
  out.push(mesh(THREE, 'Вышка дирекции гонки', tw.geo(THREE), 'фасад команд'))
  const tg = new Builder()
  box(tg, [tc[0], tc[1] + 7, tc[2]], [10.3, 3, 10.3], a)
  out.push(mesh(THREE, 'Вышка дирекции — стекло', tg.geo(THREE), 'стекло'))
  return out
}
export function paddock(THREE, D) {
  const pd = D.paddock
  const b = new Builder()
  const q = pd.poly.map((p) => b.v([p.x, pd.y - 0.05, p.z], p.x / 4, p.z / 4))
  b.idx.push(q[0], q[2], q[1], q[0], q[3], q[2])
  const g = b.geo(THREE)
  fixUp(g)
  const out = [mesh(THREE, 'Паддок', g, 'асфальт паддока')]
  // моторхоумы команд: два ряда
  const mh = new Builder()
  const [p0, p1, , p3] = pd.poly
  const ax = Math.atan2(p1.z - p0.z, p1.x - p0.x)
  const len = Math.hypot(p1.x - p0.x, p1.z - p0.z)
  const nx = (p3.x - p0.x) / Math.hypot(p3.x - p0.x, p3.z - p0.z)
  const nz = (p3.z - p0.z) / Math.hypot(p3.x - p0.x, p3.z - p0.z)
  const cols = [
    [0.85, 0.05, 0.08], [0.1, 0.1, 0.12], [0.05, 0.3, 0.75], [0.95, 0.45, 0.05], [0.0, 0.45, 0.35],
    [0.9, 0.9, 0.92], [0.55, 0.0, 0.1], [0.1, 0.55, 0.9], [0.2, 0.2, 0.25], [0.95, 0.8, 0.1],
  ]
  for (const row of [22, 52]) {
    for (let k = 0; k < 10; k++) {
      const d = 25 + k * ((len - 50) / 9)
      const c = [p0.x + Math.cos(ax) * d + nx * row, pd.y + 2.3, p0.z + Math.sin(ax) * d + nz * row]
      box(mh, c, [16, 4.6, 6], ax, cols[k])
    }
  }
  out.push(mesh(THREE, 'Моторхоумы команд', mh.geo(THREE), 'моторхоум'))
  return out
}

// ---------- 8. Трибуны ----------
export function stands(THREE, D) {
  const out = []
  let seed = 7
  const rnd = () => {
    seed = (seed * 16807) % 2147483647
    return (seed - 1) / 2147483646
  }
  const shirts = [
    [0.85, 0.1, 0.1], [0.95, 0.85, 0.1], [0.1, 0.2, 0.7], [0.95, 0.95, 0.95], [0.1, 0.1, 0.1], [0.9, 0.45, 0.1], [0.2, 0.6, 0.25], [0.6, 0.1, 0.5],
  ]
  for (const st of D.stands) {
    const P = st.pts.map((p) => ({ ...p, y: st.y }))
    const rise = 0.6
    const tread = (st.depth - 1.5) / st.rows
    const prof = [[0, -3], [0, 1.6]]
    let u = 0.0
    let v = 1.6
    for (let r = 0; r < st.rows; r++) {
      prof.push([u + tread, v])
      v += rise
      prof.push([u + tread, v])
      u += tread
    }
    prof.push([st.depth, v], [st.depth, v + 1.1], [st.depth + 0.3, v + 1.1], [st.depth + 0.3, -3])
    const b = new Builder()
    sweep(b, P, prof)
    const top = v
    // крыша на столбах сзади
    const roof = new Builder()
    sweep(roof, P, [[st.depth * 0.15, top + 4.2], [st.depth + 0.6, top + 3.6], [st.depth + 0.6, top + 3.3], [st.depth * 0.15, top + 3.9]])
    for (let k = 0; k < P.length; k += 2) {
      const p = P[k]
      box(roof, [p.x + p.nx * (st.depth + 0.15), p.y + (top + 3.6 - 3) / 2 + 0.5, p.z + p.nz * (st.depth + 0.15)], [0.3, top + 3.6 + 3, 0.3])
    }
    // зрители: прямоугольники на рядах, лицом к трассе
    const fans = new Builder()
    for (let k = 0; k < P.length - 1; k++) {
      const p = P[k]
      const q = P[k + 1]
      const segLen = Math.hypot(q.x - p.x, q.z - p.z)
      const n = Math.floor(segLen / 0.7)
      for (let r = 0; r < st.rows; r++) {
        const uu = (r + 0.55) * tread
        const vv = 1.6 + (r + 1) * rise
        for (let j = 0; j < n; j++) {
          if (rnd() < 0.22) continue
          const f = (j + 0.5) / n
          const x = p.x + (q.x - p.x) * f + p.nx * uu
          const z = p.z + (q.z - p.z) * f + p.nz * uu
          const tx = (q.x - p.x) / segLen
          const tz = (q.z - p.z) / segLen
          const col = shirts[Math.floor(rnd() * shirts.length)]
          const hh = 0.75 + rnd() * 0.2
          const w = 0.24
          const qd = [
            fans.v([x - tx * w, p.y + vv, z - tz * w], 0, 0, col),
            fans.v([x + tx * w, p.y + vv, z + tz * w], 1, 0, col),
            fans.v([x + tx * w, p.y + vv + hh, z + tz * w], 1, 1, col),
            fans.v([x - tx * w, p.y + vv + hh, z - tz * w], 0, 1, col),
          ]
          fans.idx.push(qd[0], qd[1], qd[2], qd[0], qd[2], qd[3])
        }
      }
    }
    out.push(
      group(THREE, st.name, [
        mesh(THREE, st.name + ' — конструкция', b.geo(THREE), 'бетон трибуны'),
        mesh(THREE, st.name + ' — крыша', roof.geo(THREE), 'крыша'),
        mesh(THREE, st.name + ' — зрители', fans.geo(THREE), 'зрители'),
      ]),
    )
  }
  return out
}

// ---------- 9. Лес ----------
export function forest(THREE, D) {
  const ели = new Builder()
  const листва = new Builder()
  const стволы = new Builder()
  const cone = (b, cx, y0, cz, r, h, seg, rot, col) => {
    const tip = b.v([cx, y0 + h, cz], 0.5, 1, col)
    const ring = []
    for (let k = 0; k < seg; k++) {
      const t = rot + (k / seg) * Math.PI * 2
      ring.push(b.v([cx + Math.cos(t) * r, y0, cz + Math.sin(t) * r], k / seg, 0, col.map((v) => v * 0.8)))
    }
    for (let k = 0; k < seg; k++) b.idx.push(ring[k], tip, ring[(k + 1) % seg])
  }
  for (const [x, y, z, h, kind, rot] of D.trees) {
    const hash = Math.abs(Math.sin(x * 12.9 + z * 78.2) * 43758.5) % 1
    if (kind === 0) {
      const col = [0.018 + 0.012 * hash, 0.06 + 0.03 * hash, 0.03 + 0.012 * hash]
      cone(ели, x, y + h * 0.08, z, h * 0.23, h * 0.62, 6, rot, col)
      cone(ели, x, y + h * 0.45, z, h * 0.16, h * 0.55, 5, rot + 0.5, col.map((v) => v * 1.1))
    } else {
      const col = [0.05 + 0.05 * hash, 0.13 + 0.06 * hash, 0.025 + 0.02 * hash]
      const r = h * 0.3
      const cy = y + h * 0.62
      // крона — вытянутый октаэдр
      const top = листва.v([x, cy + r * 1.1, z], 0.5, 1, col)
      const bot = листва.v([x, cy - r * 0.9, z], 0.5, 0, col.map((v) => v * 0.7))
      const ring = []
      for (let k = 0; k < 5; k++) {
        const t = rot + (k / 5) * Math.PI * 2
        ring.push(листва.v([x + Math.cos(t) * r, cy + (k % 2 ? 0.15 : -0.1) * r, z + Math.sin(t) * r], k / 5, 0.5, col.map((v) => v * 0.9)))
      }
      for (let k = 0; k < 5; k++) {
        листва.idx.push(ring[k], top, ring[(k + 1) % 5])
        листва.idx.push(ring[(k + 1) % 5], bot, ring[k])
      }
      // ствол: трёхгранный
      const tr = []
      for (let k = 0; k < 3; k++) {
        const t = rot + (k / 3) * Math.PI * 2
        tr.push([стволы.v([x + Math.cos(t) * 0.25, y, z + Math.sin(t) * 0.25]), стволы.v([x + Math.cos(t) * 0.18, cy, z + Math.sin(t) * 0.18])])
      }
      for (let k = 0; k < 3; k++) {
        const a = tr[k]
        const c = tr[(k + 1) % 3]
        стволы.idx.push(a[0], c[0], a[1], a[1], c[0], c[1])
      }
    }
  }
  return [mesh(THREE, 'Лес — ели', ели.geo(THREE), 'хвоя'), mesh(THREE, 'Лес — лиственные', листва.geo(THREE), 'листва'), mesh(THREE, 'Лес — стволы', стволы.geo(THREE), 'ствол')]
}

// ---------- 10. Служебные точки ----------
function node(THREE, name, p, yaw, extras) {
  const o = new THREE.Object3D()
  o.name = name
  o.position.set(p.x, p.y, p.z)
  o.rotation.y = yaw
  if (extras) o.userData = extras
  return o
}
export function service(THREE, D) {
  const axis = group(THREE, 'Ось трассы')
  for (const a of D.axis) {
    axis.add(
      node(THREE, 'Ось ' + String(a.i).padStart(4, '0'), a, a.yaw, {
        index: a.i,
        distance_m: a.i * 2,
        width_left: a.wl,
        width_right: a.wr,
        white_line_width: D.LW,
        asphalt_half_width: Math.round(Math.max(a.al, a.ar) * 100) / 100,
      }),
    )
  }
  const sec = group(THREE, 'Финиш и сектора', D.sectors.map((s) => node(THREE, s.name, s, s.yaw, { distance_m: s.distance_m, width_left: s.wl, width_right: s.wr })))
  const grid = group(THREE, 'Стартовые позиции', D.grid.map((g) => node(THREE, 'Старт P' + g.k, g, g.yaw, { grid_position: g.k, distance_m: g.distance_m, lateral_m: g.lateral_m })))
  const pit = group(THREE, 'Ось пит-лейна', D.pitAxis.map((p) => node(THREE, 'Ось пит-лейна ' + String(p.k).padStart(3, '0'), p, p.yaw, { index: p.k, distance_m: p.distance_m, width_left: p.wl, width_right: p.wr })))
  const pAt = (d) => D.pitAxis[Math.min(D.pitAxis.length - 1, Math.round(d / 2))]
  const pp = D.pitPoints
  const pitPts = group(THREE, 'Пит-лейн (точки)', [
    node(THREE, 'Пит въезд', pAt(pp.in), pAt(pp.in).yaw, { distance_m: pp.in }),
    node(THREE, 'Пит лимит начало', pAt(pp.limStart), pAt(pp.limStart).yaw, { distance_m: pp.limStart }),
    node(THREE, 'Пит лимит конец', pAt(pp.limEnd), pAt(pp.limEnd).yaw, { distance_m: pp.limEnd }),
    node(THREE, 'Пит выезд', pAt(pp.out), pAt(pp.out).yaw, { distance_m: pp.out }),
  ])
  const boxes = group(THREE, 'Пит-боксы', D.boxes.map((b) => node(THREE, 'Пит-бокс ' + b.k, b, b.yaw, { index: b.k, distance_m: b.distance_m, lateral_m: b.off })))
  return [axis, sec, grid, pit, pitPts, boxes]
}
