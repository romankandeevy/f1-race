// Все числа трассы «Спа-Франкоршам» (по мотивам) для Forma: ось через 1 м, рельеф, сечение (линии, поребрики,
// зоны безопасности, гравий, газон, ограждения), пит-лейн, решётка, сектора, трибуны, пит-комплекс, земля и лес.
// Пишет out/spa-data.json — его берёт код в Forma (parts.mjs), и печатает проверки (радиусы, уклоны, замыкание).
// usage: node tools/track/spa/track.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { buildCenterline, LENGTH } from './centerline.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const r = buildCenterline()
const N = LENGTH // точек через 1 м
const STEP = Math.round(1 / r.H) // мелких шагов в 1 м
if (r.n !== N * STEP) throw new Error('длина круга не кратна 1 м: ' + r.n * r.H)
const wrap = (i) => ((i % N) + N) % N
const sDist = (a, b) => {
  const d = Math.abs(a - b) % N
  return Math.min(d, N - d)
}
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

// ---------- ось через 1 м ----------
const X = new Float64Array(N)
const Z = new Float64Array(N)
const A = new Float64Array(N)
const K = new Float64Array(N) // кривизна (+ направо)
for (let i = 0; i < N; i++) {
  X[i] = r.X[i * STEP]
  Z[i] = r.Z[i * STEP]
  A[i] = r.A[i * STEP]
  let k = 0
  for (let j = 0; j < STEP; j++) k += r.K[(i * STEP + j - STEP / 2 + r.n) % r.n]
  K[i] = k / STEP
}
const TX = (i) => Math.cos(A[wrap(i)])
const TZ = (i) => Math.sin(A[wrap(i)])
// левая нормаль (по ходу движения): (sin a, -cos a) — как lat в lap.mjs / circuit.js
const NX = (i) => Math.sin(A[wrap(i)])
const NZ = (i) => -Math.cos(A[wrap(i)])

// повороты плана: начало, середина, конец (м от линии старта)
const turns = []
r.plan.forEach((seg, k) => {
  const s0 = r.segStart[k] / STEP
  const s1 = (k + 1 < r.plan.length ? r.segStart[k + 1] : r.n) / STEP
  seg.s0 = s0
  seg.s1 = s1
  if (seg.t !== undefined) turns.push({ name: seg.name, t: seg.t, R: seg.R, s0, s1, mid: (s0 + s1) / 2, right: seg.t > 0 })
})
const T = Object.fromEntries(turns.map((t) => [t.name, t]))

// ---------- радиусы (проверка) ----------
function radiusAt(i, h = 5) {
  const a = [X[wrap(i - h)], Z[wrap(i - h)]]
  const b = [X[i], Z[i]]
  const c = [X[wrap(i + h)], Z[wrap(i + h)]]
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1])
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1])
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1])
  const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
  return cross < 1e-9 ? Infinity : (ab * bc * ca) / (2 * cross)
}
let minR = Infinity
let minRAt = 0
for (let i = 0; i < N; i++) {
  const R = radiusAt(i)
  if (R < minR) {
    minR = R
    minRAt = i
  }
}

// ---------- рельеф ----------
const keys = [
  [0, 0],
  [T['Ла-Сурс'].mid, 1.5],
  [T['О-Руж'].mid, -9],
  [T['Радийон'].s1, 4],
  [T['вершина Радийона'].s1, 6],
  [T['Ле-Комб'].s0, 12.5],
  [T['Ле-Комб 2'].s1, 13],
  [T['Мальмеди'].s1, 10],
  [T['Риваж'].mid, 2],
  [T['поворот 9'].mid, -1],
  [T['Пуон'].mid, -4],
  [T['Пуон 2'].s1, -6],
  [T['Фань'].mid, -8],
  [T['Ставло'].mid, -11],
  [T['Ставло 2'].s1, -10],
  [T['Поль Фрер'].mid, -7],
  [T['Бланшимон'].mid, -4],
  [T['Бланшимон 2'].s1, -2],
  [T['Бас-Стоп'].mid, -0.5],
]
// монотонный кубический сплайн (PCHIP) по кругу
function pchipLoop(pts, L) {
  const n = pts.length
  const P = [...pts, [pts[0][0] + L, pts[0][1]]]
  const P0 = [pts[n - 1][0] - L, pts[n - 1][1]]
  const xs = [P0[0], ...P.map((p) => p[0])]
  const ys = [P0[1], ...P.map((p) => p[1])]
  const m = xs.length
  const dl = []
  for (let i = 0; i < m - 1; i++) dl.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]))
  const d = new Array(m).fill(0)
  for (let i = 1; i < m - 1; i++) {
    if (dl[i - 1] * dl[i] <= 0) d[i] = 0
    else {
      const h0 = xs[i] - xs[i - 1]
      const h1 = xs[i + 1] - xs[i]
      const w1 = 2 * h1 + h0
      const w2 = h1 + 2 * h0
      d[i] = (w1 + w2) / (w1 / dl[i - 1] + w2 / dl[i])
    }
  }
  return (s) => {
    let i = 1
    while (i < m - 1 && xs[i + 1] < s) i++
    const h = xs[i + 1] - xs[i]
    const t = (s - xs[i]) / h
    const t2 = t * t
    const t3 = t2 * t
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * d[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * d[i + 1]
  }
}
const prof = pchipLoop(keys, N)
let Y0 = new Float64Array(N)
for (let i = 0; i < N; i++) Y0[i] = prof(i)
// вертикальные кривые: сглаживание Гауссом (σ 28 м), по кругу
function gauss(arr, sigma) {
  const out = new Float64Array(arr.length)
  const R = Math.ceil(sigma * 3)
  const w = []
  let sw = 0
  for (let k = -R; k <= R; k++) {
    w.push(Math.exp(-(k * k) / (2 * sigma * sigma)))
    sw += w[w.length - 1]
  }
  for (let i = 0; i < arr.length; i++) {
    let s = 0
    for (let k = -R; k <= R; k++) s += arr[wrap(i + k)] * w[k + R]
    out[i] = s / sw
  }
  return out
}
let Y = gauss(Y0, 28)
const y0 = Y[0]
for (let i = 0; i < N; i++) Y[i] -= y0
let maxGrade = 0
let maxGradeAt = 0
let minVR = Infinity
let minVRAt = 0
let yMin = Infinity
let yMax = -Infinity
for (let i = 0; i < N; i++) {
  const g = (Y[wrap(i + 1)] - Y[wrap(i - 1)]) / 2
  if (Math.abs(g) > maxGrade) {
    maxGrade = Math.abs(g)
    maxGradeAt = i
  }
  const c = Math.abs(Y[wrap(i + 10)] - 2 * Y[i] + Y[wrap(i - 10)]) / 100
  if (1 / c < minVR) {
    minVR = 1 / c
    minVRAt = i
  }
  yMin = Math.min(yMin, Y[i])
  yMax = Math.max(yMax, Y[i])
}

// ---------- ширина между белыми линиями ----------
const LW = 0.3 // белая линия
const startStraight = (s) => {
  // от конца Бас-Стопа до начала Ла-Сурс — шире (14 м), плавно 30 м
  const a = T['Бас-Стоп 2'].s1 - N // отрицательное — перед линией
  const b = T['Ла-Сурс'].s0
  const ss = s > N / 2 ? s - N : s
  return smooth((ss - a) / 30) * smooth((b - ss) / 30)
}
const W = new Float64Array(N)
for (let i = 0; i < N; i++) W[i] = 6.5 + 0.5 * startStraight(i)

// ---------- пит-лейн: смещение оси пит-лейна влево от оси трассы ----------
const PIT_D = 20
const PIT_HALF = 6
const pitIn = T['Бас-Стоп 2'].s1 + 15 // начало въезда (м от линии, до круга)
const pitRampIn = 170
const pitOutStart = T['Ла-Сурс'].s1 + 15
const pitRampOut = 160
const Dp = new Float64Array(N)
for (let i = 0; i < N; i++) {
  let s = i >= pitIn - 10 ? i - N : i // по кругу: въезд перед линией
  const a = pitIn - N
  if (s < a || s > pitOutStart + pitRampOut) continue
  Dp[i] = PIT_D * smooth((s - a) / pitRampIn) * (1 - smooth((s - pitOutStart) / pitRampOut))
}
const pitActive = (i) => Dp[i] > 0.001

// ---------- кривизна сглаженная и зазоры до других участков трассы ----------
const KS = gauss(K, 8)
const clear = { L: new Float64Array(N).fill(1e9), R: new Float64Array(N).fill(1e9) }
{
  const grid = new Map()
  const cell = 50
  const key = (x, z) => Math.floor(x / cell) + ',' + Math.floor(z / cell)
  for (let i = 0; i < N; i += 2) {
    const k = key(X[i], Z[i])
    if (!grid.has(k)) grid.set(k, [])
    grid.get(k).push(i)
  }
  for (let i = 0; i < N; i++) {
    const cx = Math.floor(X[i] / cell)
    const cz = Math.floor(Z[i] / cell)
    for (let dx = -4; dx <= 4; dx++)
      for (let dz = -4; dz <= 4; dz++) {
        const list = grid.get(cx + dx + ',' + (cz + dz))
        if (!list) continue
        for (const j of list) {
          const ex = X[j] - X[i]
          const ez = Z[j] - Z[i]
          const d = Math.hypot(ex, ez)
          if (d > 200 || sDist(i, j) < 1.6 * d + 20) continue
          const side = ex * NX(i) + ez * NZ(i)
          if (Math.abs(side) < 0.25 * d) continue
          const c = side > 0 ? clear.L : clear.R
          if (d < c[i]) c[i] = d
        }
      }
  }
}

// ---------- зоны вылета у поворотов: асфальт / гравий снаружи ----------
// side — снаружи поворота (у правого поворота снаружи левая сторона)
const RUNOFF = {
  'О-Руж': { asph: 8 },
  Радийон: { asph: 10, tecpro: true },
  'вершина Радийона': { asph: 7 },
  'Ле-Комб': { asph: 6, grav: 10, tecpro: true },
  'Ле-Комб 2': { asph: 6 },
  Мальмеди: { asph: 8, tecpro: true },
  Риваж: { asph: 5, grav: 12, tecpro: true },
  'поворот 9': { asph: 6 },
  Пуон: { asph: 4, grav: 14, tecpro: true },
  'Пуон 2': { asph: 4, grav: 14, tecpro: true },
  Фань: { asph: 4, grav: 10, tecpro: true },
  Кампюс: { asph: 6 },
  Ставло: { asph: 10, tecpro: true },
  'Ставло 2': { asph: 10 },
  'Поль Фрер': { asph: 6 },
  Бланшимон: { asph: 6, grav: 8, tecpro: true },
  'Бланшимон 2': { asph: 6, grav: 6 },
  'Бас-Стоп': { asph: 10, tecpro: true },
  'Бас-Стоп 2': { asph: 8, tecpro: true },
  'Ла-Сурс': { asph: 4 },
  'Кеммель излом': {},
  спуск: {},
}
// вклад каждой зоны в точке: плавно 25 м до и после
const zone = (i, t, before = 30, after = 60) => {
  let s = i
  if (s - t.s1 > N / 2) s -= N
  if (t.s0 - s > N / 2) s += N
  return smooth((s - (t.s0 - before)) / 25) * smooth((t.s1 + after - s) / 25)
}
const sides = ['L', 'R']
const asphExtra = { L: new Float64Array(N), R: new Float64Array(N) }
const gravW = { L: new Float64Array(N), R: new Float64Array(N) }
const tecpro = { L: new Uint8Array(N), R: new Uint8Array(N) }
for (const t of turns) {
  const cfg = RUNOFF[t.name] || {}
  const out = t.right ? 'L' : 'R'
  for (let i = 0; i < N; i++) {
    const z = zone(i, t)
    if (z <= 0) continue
    asphExtra[out][i] = Math.max(asphExtra[out][i], z * (cfg.asph || 0))
    gravW[out][i] = Math.max(gravW[out][i], z * (cfg.grav || 0))
    if (cfg.tecpro && z > 0.5) tecpro[out][i] = 1
  }
}

// ---------- поребрики: внутри поворота (апекс) и снаружи на выходе ----------
const kerb = { L: new Uint8Array(N), R: new Uint8Array(N) }
for (const t of turns) {
  if (t.R > 150) continue
  const inside = t.right ? 'R' : 'L'
  const outside = t.right ? 'L' : 'R'
  for (let s = Math.round(t.s0 - 4); s <= Math.round(t.s1 + 4); s++) kerb[inside][wrap(s)] = 1
  for (let s = Math.round(t.mid); s <= Math.round(t.s1 + 25); s++) kerb[outside][wrap(s)] = 1
}
for (let i = 0; i < N; i++) if (pitActive(i)) kerb.L[i] = 0
const KERB_W = 1.2
const KERB_H = 0.03

// ---------- сечение: столбцы от оси наружу ----------
// lo — внешний край белой линии; a — конец асфальта трассы (зона безопасности); p — конец пит-лейна;
// f — конец пола боксов; g — конец гравия; b — ограждение (или -1); e — край газона
const BASE_RUNOFF = 1.5
const col = { L: [], R: [] }
const boxZone = { s0: -150, s1: 110 } // м от линии, по оси трассы
const inBox = (i) => {
  const s = i > N / 2 ? i - N : i
  return s >= boxZone.s0 - 6 && s <= boxZone.s1 + 6
}
for (const side of sides) {
  const sign = side === 'L' ? 1 : -1
  const raw = []
  for (let i = 0; i < N; i++) {
    const w = W[i]
    const lo = w + LW
    let a = lo + BASE_RUNOFF + asphExtra[side][i]
    let p = a
    let f = a
    let pitWall = false
    if (side === 'L' && pitActive(i)) {
      const D = Dp[i]
      const pin = Math.max(D - PIT_HALF, lo)
      a = Math.max(a, pin)
      p = Math.max(a, D + PIT_HALF)
      f = p + (inBox(i) ? 20 : 0) // пол боксов и гаражи (16 м внутри здания)
      pitWall = D - PIT_HALF - 2.5 >= lo + 2
    }
    const g = f + gravW[side][i]
    const fast = Math.abs(K[i]) < 1 / 400
    let b = g + (gravW[side][i] > 0.5 ? 2.5 : fast ? 7 : 5)
    if (side === 'L' && pitActive(i) && inBox(i)) b = -1 // за боксами — здание
    let e = (b > 0 ? b : g) + 16
    if (side === 'L' && pitActive(i) && inBox(i)) e = g + 3 // под зданием боксов
    // внутренняя сторона поворота: не дальше 0,8 радиуса
    const inside = KS[i] * sign < 0 // правый поворот (K>0): внутри — справа
    if (inside && Math.abs(KS[i]) > 1e-4) {
      const lim = 0.8 / Math.abs(KS[i])
      e = Math.min(e, lim)
    }
    // другой участок трассы рядом
    const c = clear[side][i]
    e = Math.min(e, c / 2 - 0.5)
    if (b > 0) b = Math.min(b, e - 1.5, c / 2 - 2.5)
    if (b > 0 && b < g + 1.5) b = -1
    if (e < g + 0.5) e = g + 0.5
    raw.push({ lo, a, p, f, g, b, e, pitWall })
  }
  col[side] = raw
}
// e и b сглаживаем вдоль трассы (минимум по окну, потом среднее), чтобы край не шёл зубцами
for (const side of sides) {
  for (const key of ['e', 'b']) {
    const v = col[side].map((c) => c[key])
    const mn = v.map((_, i) => {
      let m = Infinity
      for (let k = -6; k <= 6; k++) {
        const x = v[wrap(i + k)]
        if (key === 'b' && x < 0) continue
        m = Math.min(m, x)
      }
      return m
    })
    const av = mn.map((_, i) => {
      let s = 0
      for (let k = -6; k <= 6; k++) s += mn[wrap(i + k)]
      return s / 13
    })
    col[side].forEach((c, i) => {
      if (key === 'b') {
        if (c.b > 0) c.b = Math.max(Math.min(c.b, av[i]), c.g + 1.5)
      } else c.e = Math.max(Math.min(c.e, av[i]), c.g + 0.5)
    })
  }
  // b не должен заходить за e
  for (const c of col[side]) if (c.b > 0 && c.b > c.e - 1) c.b = -1
}
// отдельные «острова» ограждения короче 20 м убираем
for (const side of sides) {
  const c = col[side]
  let i = 0
  const start = c.findIndex((q) => q.b < 0)
  if (start >= 0) {
    for (let k = 0; k < N; k++) {
      const j = wrap(start + k)
      if (c[j].b > 0) {
        let n = 0
        while (n < N && c[wrap(j + n)].b > 0) n++
        if (n < 20) for (let q = 0; q < n; q++) c[wrap(j + q)].b = -1
        k += n
      }
    }
  }
  i = i + 0
}

// ---------- земля: высота H(x, z) ----------
// вблизи трассы — высота трассы (взвешенно по ближним участкам), дальше — холмы Арденн
function hash(n) {
  const s = Math.sin(n) * 43758.5453
  return s - Math.floor(s)
}
const waves = []
for (let k = 0; k < 9; k++) {
  const ang = hash(k * 7.1 + 1) * Math.PI * 2
  const len = 260 + hash(k * 3.3 + 2) * 700
  waves.push({ kx: Math.cos(ang) / len, kz: Math.sin(ang) / len, ph: hash(k * 9.7 + 3) * Math.PI * 2, amp: 4 + hash(k * 5.1 + 4) * 9 })
}
const hills = (x, z) => waves.reduce((s, w) => s + w.amp * Math.sin((x * w.kx + z * w.kz) * Math.PI * 2 + w.ph), 0)
// пространственная сетка точек оси (каждые 4 м) для поиска ближних
const cellA = 40
const aGrid = new Map()
for (let i = 0; i < N; i += 4) {
  const k = Math.floor(X[i] / cellA) + ',' + Math.floor(Z[i] / cellA)
  if (!aGrid.has(k)) aGrid.set(k, [])
  aGrid.get(k).push(i)
}
function nearAxis(x, z, radius) {
  const out = []
  const r = Math.ceil(radius / cellA)
  const cx = Math.floor(x / cellA)
  const cz = Math.floor(z / cellA)
  for (let dx = -r; dx <= r; dx++)
    for (let dz = -r; dz <= r; dz++) {
      const list = aGrid.get(cx + dx + ',' + (cz + dz))
      if (list) for (const i of list) out.push(i)
    }
  return out
}
// ближайшая точка оси (точно, через 1 м вокруг найденной через 4 м)
function nearest(x, z, radius = 400) {
  let best = Infinity
  let bi = -1
  for (const i of nearAxis(x, z, radius)) {
    const d = (X[i] - x) ** 2 + (Z[i] - z) ** 2
    if (d < best) {
      best = d
      bi = i
    }
  }
  if (bi < 0) return null
  for (let k = -3; k <= 3; k++) {
    const j = wrap(bi + k)
    const d = (X[j] - x) ** 2 + (Z[j] - z) ** 2
    if (d < best) {
      best = d
      bi = j
    }
  }
  const lat = (x - X[bi]) * NX(bi) + (z - Z[bi]) * NZ(bi)
  return { i: bi, d: Math.sqrt(best), lat, side: lat >= 0 ? 'L' : 'R' }
}
function groundH(x, z) {
  const near = nearAxis(x, z, 360)
  let dmin = Infinity
  for (const i of near) dmin = Math.min(dmin, Math.hypot(X[i] - x, Z[i] - z))
  let sw = 0
  let sy = 0
  for (const i of near) {
    const d = Math.hypot(X[i] - x, Z[i] - z)
    if (d > dmin + 120) continue
    const w = Math.exp(-(((d - dmin) / 35) ** 2))
    sw += w
    sy += w * Y[i]
  }
  const yt = sw > 0 ? sy / sw : 0
  const far = dmin === Infinity ? 1 : smooth((dmin - 60) / 260)
  // дальше от трассы — холмы и горы по краям
  const hill = hills(x, z) + 22
  return yt + far * (hill - (sw > 0 ? 0 : 0)) * (dmin === Infinity ? 1 : 1)
}

// высота газона в сечении: ровно до ограждения (+1,5 м), дальше плавно к земле
const ribbon = { L: [], R: [] }
for (const side of sides) {
  const sign = side === 'L' ? 1 : -1
  for (let i = 0; i < N; i++) {
    const c = col[side][i]
    const lv = (c.b > 0 ? c.b + 1.5 : c.g + 1)
    const levelTo = Math.min(lv, c.e)
    const ex = X[i] + NX(i) * c.e * sign
    const ez = Z[i] + NZ(i) * c.e * sign
    const he = groundH(ex, ez)
    const mid = (levelTo + c.e) / 2
    ribbon[side].push({ level: levelTo, mid, yMid: Y[i] + (he - Y[i]) * 0.5, yE: he })
  }
}
// высота газона в любой точке ленты (для земли под ней и деревьев)
function ribbonY(i, side, d) {
  const q = ribbon[side][i]
  if (d <= q.level) return Y[i]
  const e = col[side][i].e
  if (d >= e) return q.yE
  // как в сетке ленты: ровно до level, дальше по прямой к mid и к краю e
  if (d <= q.mid) return Y[i] + ((q.yMid - Y[i]) * (d - q.level)) / Math.max(1e-6, q.mid - q.level)
  return q.yMid + ((q.yE - q.yMid) * (d - q.mid)) / Math.max(1e-6, e - q.mid)
}

// ---------- служебные точки ----------
const yawAt = (i) => Math.atan2(TX(i), TZ(i)) // поворот узла вокруг Y: +Z узла по ходу
const pt = (i, lat) => ({ x: X[wrap(i)] + NX(i) * lat, y: Y[wrap(i)], z: Z[wrap(i)] + NZ(i) * lat })
const axisOut = []
for (let i = 0; i < N; i += 2) {
  axisOut.push({
    i: i / 2,
    x: X[i],
    y: Y[i],
    z: Z[i],
    yaw: yawAt(i),
    wl: W[i],
    wr: W[i],
    al: col.L[i].a,
    ar: col.R[i].a,
  })
}
const grid = []
for (let k = 1; k <= 20; k++) {
  const s = wrap(-8 * k)
  const lat = k % 2 ? -3 : 3 // P1 справа (внутри Ла-Сурс)
  grid.push({ k, ...pt(s, lat), yaw: yawAt(s), distance_m: -8 * k, lateral_m: lat })
}
const sectorS = [0, Math.round(T['Ле-Комб'].s0 - 120), Math.round(T['Фань'].s0 - 60)]
const sectors = sectorS.map((s, k) => ({ name: ['Финиш', 'Сектор 1', 'Сектор 2'][k], ...pt(s, 0), yaw: yawAt(s), distance_m: s, wl: W[s], wr: W[s] }))

// ось пит-лейна: путь P(s) + nL·D(s), по длине через 2 м
const pitPath = []
{
  const a = Math.round(pitIn - N)
  const b = Math.round(pitOutStart + pitRampOut)
  let dist = 0
  let prev = null
  for (let s = a; s <= b; s += 0.25) {
    const i0 = Math.floor(s)
    const f = s - i0
    const lerp = (fn) => fn(wrap(i0)) * (1 - f) + fn(wrap(i0 + 1)) * f
    const D = lerp((i) => Dp[i])
    const x = lerp((i) => X[i]) + lerp(NX) * D
    const z = lerp((i) => Z[i]) + lerp(NZ) * D
    const y = lerp((i) => Y[i])
    if (prev) dist += Math.hypot(x - prev.x, z - prev.z)
    pitPath.push({ s, x, y, z, D, dist })
    prev = { x, z }
  }
}
const pitAxis = []
{
  let j = 0
  for (let d = 0; d <= pitPath[pitPath.length - 1].dist; d += 2) {
    while (j < pitPath.length - 2 && pitPath[j + 1].dist < d) j++
    const p = pitPath[j]
    const q = pitPath[j + 1]
    const f = (d - p.dist) / (q.dist - p.dist || 1)
    const x = p.x + (q.x - p.x) * f
    const z = p.z + (q.z - p.z) * f
    const s = p.s + (q.s - p.s) * f
    const D = p.D + (q.D - p.D) * f
    const i = wrap(Math.round(s))
    const lo = W[i] + LW
    const wl = PIT_HALF
    const wr = D - PIT_HALF > lo ? PIT_HALF : Math.max(1, D + W[i])
    pitAxis.push({ k: pitAxis.length, x, y: p.y + (q.y - p.y) * f, z, s, D, distance_m: d, wl, wr })
  }
  for (let k = 0; k < pitAxis.length; k++) {
    const a = pitAxis[Math.max(0, k - 1)]
    const b = pitAxis[Math.min(pitAxis.length - 1, k + 1)]
    pitAxis[k].yaw = Math.atan2(b.x - a.x, b.z - a.z)
  }
}
const pitDistAtS = (s) => {
  let best = 0
  let bd = Infinity
  for (const p of pitAxis) {
    const d = Math.abs(p.s - s)
    if (d < bd) {
      bd = d
      best = p.distance_m
    }
  }
  return best
}
const pitPoints = {
  in: 0,
  limStart: pitDistAtS(-190),
  limEnd: pitDistAtS(200),
  out: pitAxis[pitAxis.length - 1].distance_m,
}
const boxes = []
for (let k = 0; k < 20; k++) {
  const d = pitDistAtS(boxZone.s0 + 4) + k * 13
  const p = pitAxis[Math.round(d / 2)]
  const off = 2.9 // от оси пит-лейна к боксам (наружу, влево)
  boxes.push({ k: k + 1, x: p.x + Math.sin(p.yaw + Math.PI / 2) * off * -1 * -1, y: p.y, z: p.z, yaw: p.yaw, distance_m: p.distance_m, off })
}
// точка бокса: левее оси пит-лейна (левая нормаль к направлению yaw: (cos yaw·?, ...)). Направление (sin yaw, cos yaw), левая нормаль (cos yaw, -sin yaw)
for (const b of boxes) {
  const p = pitAxis[Math.round(b.distance_m / 2)]
  b.x = p.x + Math.cos(p.yaw) * b.off
  b.z = p.z - Math.sin(p.yaw) * b.off
}

// ---------- трибуны, пит-комплекс, паддок ----------
const stands = [
  { name: 'Трибуна главная', s0: -230, s1: 60, side: 'R', depth: 24, rows: 14 },
  { name: 'Трибуна Ла-Сурс', s0: T['Ла-Сурс'].s0 - 10, s1: T['Ла-Сурс'].s1 + 10, side: 'L', depth: 18, rows: 10, extra: 10 },
  { name: 'Трибуна О-Руж', s0: T['Радийон'].s0 - 20, s1: T['Радийон'].s1 + 30, side: 'L', depth: 18, rows: 10 },
  { name: 'Трибуна Ле-Комб', s0: T['Ле-Комб'].s0 - 80, s1: T['Ле-Комб'].s0 + 10, side: 'L', depth: 16, rows: 9 },
  { name: 'Трибуна Пуон', s0: T['Пуон'].s0 - 10, s1: T['Пуон'].s1 + 30, side: 'R', depth: 18, rows: 10 },
  { name: 'Трибуна Бланшимон', s0: T['Бланшимон'].s0 - 40, s1: T['Бланшимон'].s1 + 20, side: 'R', depth: 16, rows: 9 },
]
for (const st of stands) {
  const sign = st.side === 'L' ? 1 : -1
  const pts = []
  // отступ: за ограждением (или краем гравия) + 4 м, не ближе к оси, чем край ленты газона позволяет
  let off = 0
  for (let s = Math.round(st.s0); s <= Math.round(st.s1); s++) {
    const c = col[st.side][wrap(s)]
    off = Math.max(off, (c.b > 0 ? c.b + 0.6 : c.g) + 4 + (st.extra || 0))
  }
  st.off = off
  for (let s = Math.round(st.s0); s <= Math.round(st.s1); s += 6) {
    const i = wrap(s)
    pts.push({ x: X[i] + NX(i) * off * sign, z: Z[i] + NZ(i) * off * sign, nx: NX(i) * sign, nz: NZ(i) * sign, y: Y[i] })
  }
  st.pts = pts
  st.y = Math.min(...pts.map((p) => p.y))
}
// пит-комплекс: вдоль боксов, за полом боксов
const pitBuilding = []
for (let s = boxZone.s0 - 6; s <= boxZone.s1 + 6; s += 2) {
  const i = wrap(s)
  const c = col.L[i]
  pitBuilding.push({ x: X[i], z: Z[i], nx: NX(i), nz: NZ(i), y: Y[i], front: c.p + 4, back: c.p + 24 })
}
const paddock = { s0: boxZone.s0 - 30, s1: boxZone.s1 + 30, from: col.L[0].p + 28, to: col.L[0].p + 110 }
const pads = [] // прямоугольники, где земля опускается и лес не растёт: [{pts:[...4]}]
{
  const P = (s, d) => pt(wrap(s), d)
  pads.push({ name: 'паддок', poly: [P(paddock.s0, paddock.from - 6), P(paddock.s1, paddock.from - 6), P(paddock.s1, paddock.to), P(paddock.s0, paddock.to)], y: Y[0] })
  for (const st of stands) {
    const sign = st.side === 'L' ? 1 : -1
    const a = st.pts[0]
    const b = st.pts[st.pts.length - 1]
    pads.push({ name: st.name, poly: st.pts.map((p) => ({ x: p.x - p.nx * 2, z: p.z - p.nz * 2 })).concat(st.pts.slice().reverse().map((p) => ({ x: p.x + p.nx * (st.depth + 6), z: p.z + p.nz * (st.depth + 6) }))), y: st.y, stand: true })
    void sign, a, b
  }
}
function inPoly(poly, x, z) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}
const padAt = (x, z) => pads.find((p) => inPoly(p.poly, x, z))

// ---------- земля сеткой ----------
let bx0 = Infinity
let bx1 = -Infinity
let bz0 = Infinity
let bz1 = -Infinity
for (let i = 0; i < N; i++) {
  bx0 = Math.min(bx0, X[i])
  bx1 = Math.max(bx1, X[i])
  bz0 = Math.min(bz0, Z[i])
  bz1 = Math.max(bz1, Z[i])
}
const MARGIN = 900
const GS = 24
const gx0 = Math.floor((bx0 - MARGIN) / GS) * GS
const gz0 = Math.floor((bz0 - MARGIN) / GS) * GS
const gnx = Math.ceil((bx1 + MARGIN - gx0) / GS) + 1
const gnz = Math.ceil((bz1 + MARGIN - gz0) / GS) + 1
const gH = new Float32Array(gnx * gnz)
const gC = new Uint8Array(gnx * gnz) // 0 газон у трассы … 255 лес
let covered = 0
for (let iz = 0; iz < gnz; iz++)
  for (let ix = 0; ix < gnx; ix++) {
    const x = gx0 + ix * GS
    const z = gz0 + iz * GS
    const k = iz * gnx + ix
    const n = nearest(x, z, 420)
    let h = groundH(x, z) - 0.15
    if (n) {
      const c = col[n.side][n.i]
      const d = Math.abs(n.lat)
      // под лентой газона — ниже самой низкой точки ленты в радиусе шага сетки: треугольник сетки (24 м)
      // не должен вылезти сквозь ленту ни в ровной части, ни на склоне
      let low = Infinity
      for (let r = 0; r <= GS * 1.05; r += GS * 0.35) {
        const steps = r === 0 ? 1 : 12
        for (let q = 0; q < steps; q++) {
          const ang = (q / steps) * Math.PI * 2
          const sx = x + Math.cos(ang) * r
          const sz = z + Math.sin(ang) * r
          const m = r === 0 ? n : nearest(sx, sz, 200)
          if (!m) continue
          const dd = Math.abs(m.lat)
          if (dd > col[m.side][m.i].e) continue
          low = Math.min(low, ribbonY(m.i, m.side, dd))
        }
      }
      if (low < Infinity) {
        h = Math.min(h + 0.15, low) - 0.25
        if (d < c.e) covered++
      }
      gC[k] = Math.round(255 * smooth((n.d - c.e - 30) / 220))
    } else gC[k] = 255
    const pad = padAt(x, z)
    if (pad) h = Math.min(h, pad.y - 0.3)
    gH[k] = h
  }

// край ленты газона садится на сетку земли (без ступеньки), середина склона — не ниже сетки
function gridAt(x, z) {
  const fx = (x - gx0) / GS
  const fz = (z - gz0) / GS
  const ix = Math.floor(fx)
  const iz = Math.floor(fz)
  const u = fx - ix
  const v = fz - iz
  const H = (a, b) => gH[(iz + b) * gnx + ix + a]
  if (u + v <= 1) return H(0, 0) + (H(1, 0) - H(0, 0)) * u + (H(0, 1) - H(0, 0)) * v
  return H(1, 1) + (H(0, 1) - H(1, 1)) * (1 - u) + (H(1, 0) - H(1, 1)) * (1 - v)
}
for (const side of sides) {
  const sign = side === 'L' ? 1 : -1
  for (let i = 0; i < N; i++) {
    const q = ribbon[side][i]
    const e = col[side][i].e
    const P = (d) => [X[i] + NX(i) * d * sign, Z[i] + NZ(i) * d * sign]
    q.yE = gridAt(...P(e)) + 0.03
    q.yMid = Math.max((Y[i] + q.yE) / 2, gridAt(...P(q.mid)) + 0.06)
  }
}

// ---------- лес ----------
const trees = []
{
  let seed = 1
  const rnd = () => {
    seed = (seed * 16807) % 2147483647
    return (seed - 1) / 2147483646
  }
  const sp = 8.5
  for (let z = bz0 - 500; z < bz1 + 500; z += sp)
    for (let x = bx0 - 500; x < bx1 + 500; x += sp) {
      const px = x + (rnd() - 0.5) * sp * 0.9
      const pz = z + (rnd() - 0.5) * sp * 0.9
      const n = nearest(px, pz, 420)
      const dist = n ? n.d : 1e9
      const edge = n ? col[n.side][n.i].e : 0
      const beyond = dist - edge
      let p = 0
      if (beyond > 4 && beyond < 60) p = 0.55
      else if (beyond >= 60 && beyond < 420) p = 0.06
      else if (!n) p = 0.02
      if (rnd() > p) continue
      if (padAt(px, pz)) continue
      // не в коридоре пит-комплекса и паддока
      const kind = rnd() < 0.72 ? 0 : 1
      const h = kind === 0 ? 15 + rnd() * 12 : 11 + rnd() * 9
      trees.push([+px.toFixed(1), +(gridAt(px, pz) - 0.3).toFixed(2), +pz.toFixed(1), +h.toFixed(1), kind, +(rnd() * 6.28).toFixed(2)])
    }
}

// ---------- проверка: земля (сетка) нигде не выше ленты газона и асфальта ----------
function gridY(x, z) {
  const fx = (x - gx0) / GS
  const fz = (z - gz0) / GS
  const ix = Math.floor(fx)
  const iz = Math.floor(fz)
  const u = fx - ix
  const v = fz - iz
  const H = (a, b) => gH[(iz + b) * gnx + ix + a]
  // треугольники сетки: (0,0)-(0,1)-(1,0) и (1,0)-(0,1)-(1,1)
  if (u + v <= 1) return H(0, 0) + (H(1, 0) - H(0, 0)) * u + (H(0, 1) - H(0, 0)) * v
  return H(1, 1) + (H(0, 1) - H(1, 1)) * (1 - u) + (H(1, 0) - H(1, 1)) * (1 - v)
}
let poke = 0
let pokeMax = 0
for (const side of sides) {
  const sign = side === 'L' ? 1 : -1
  for (let i = 0; i < N; i += 2) {
    const c = col[side][i]
    for (let d = 0; d <= c.e; d += 1.5) {
      const x = X[i] + NX(i) * d * sign
      const z = Z[i] + NZ(i) * d * sign
      const top = ribbonY(i, side, d)
      const g = gridY(x, z)
      if (g > top - 0.02) {
        if (process.env.DBG && poke % 60 === 0) console.log('  земля выше', side, i, 'd', d.toFixed(1), 'e', c.e.toFixed(1), 'lv', ribbon[side][i].level.toFixed(1), 'g-top', (g - top).toFixed(2), 'Y', Y[i].toFixed(1), 'yE', ribbon[side][i].yE.toFixed(1))
        poke++
        pokeMax = Math.max(pokeMax, g - top)
      }
    }
  }
}

// ---------- проверка поребриков: целиком за белой линией ----------
let kerbOnTrack = 0
for (const side of sides) for (let i = 0; i < N; i++) if (kerb[side][i] && col[side][i].lo + 0.001 < W[i] + LW) kerbOnTrack++

// ---------- запись ----------
const round = (v, k = 3) => +v.toFixed(k)
const data = {
  N,
  length: N,
  LW,
  KERB_W,
  KERB_H,
  axis1m: Array.from({ length: N }, (_, i) => [round(X[i]), round(Y[i]), round(Z[i]), round(A[i], 5)]),
  W: Array.from(W, (v) => round(v, 2)),
  cols: Object.fromEntries(sides.map((s) => [s, col[s].map((c) => [round(c.lo, 2), round(c.a, 2), round(c.p, 2), round(c.f, 2), round(c.g, 2), round(c.b, 2), round(c.e, 2), c.pitWall ? 1 : 0])])),
  ribbon: Object.fromEntries(sides.map((s) => [s, ribbon[s].map((q) => [round(q.level, 2), round(q.mid, 2), round(q.yMid, 2), round(q.yE, 2)])])),
  kerb: { L: Array.from(kerb.L), R: Array.from(kerb.R) },
  tecpro: { L: Array.from(tecpro.L), R: Array.from(tecpro.R) },
  D: Array.from(Dp, (v) => round(v, 2)),
  inBox: Array.from({ length: N }, (_, i) => (inBox(i) ? 1 : 0)),
  axis: axisOut.map((a) => ({ ...a, x: round(a.x), y: round(a.y), z: round(a.z), yaw: round(a.yaw, 5) })),
  grid,
  sectors,
  pitAxis: pitAxis.map((p) => ({ k: p.k, x: round(p.x), y: round(p.y), z: round(p.z), yaw: round(p.yaw, 5), distance_m: p.distance_m, wl: round(p.wl, 2), wr: round(p.wr, 2) })),
  pitPoints,
  boxes,
  stands: stands.map((s) => ({ name: s.name, side: s.side, depth: s.depth, rows: s.rows, y: s.y, pts: s.pts })),
  pitBuilding,
  paddock: { ...paddock, poly: pads[0].poly, y: Y[0] },
  terrain: { x0: gx0, z0: gz0, nx: gnx, nz: gnz, step: GS, h: Array.from(gH, (v) => round(v, 2)), c: Array.from(gC) },
  trees,
  turns: turns.map((t) => ({ name: t.name, s0: round(t.s0, 1), s1: round(t.s1, 1), R: t.R, t: t.t })),
}
fs.mkdirSync(path.join(here, 'out'), { recursive: true })
fs.writeFileSync(path.join(here, 'out', 'spa-data.json'), JSON.stringify(data))

console.log('длина оси', N, 'м, замыкание', r.closure.toFixed(3), 'м, поворот за круг', ((r.A[r.n] - r.A[0]) / (Math.PI / 180)).toFixed(2), '°')
console.log('мин. радиус оси (по трём точкам через 5 м)', minR.toFixed(1), 'м на', minRAt, 'м')
console.log('рельеф', yMin.toFixed(1), '…', yMax.toFixed(1), 'м (перепад', (yMax - yMin).toFixed(1), 'м), макс. уклон', (maxGrade * 100).toFixed(1), '% на', maxGradeAt, 'м; мин. радиус вертикальной кривой', minVR.toFixed(0), 'м на', minVRAt)
console.log('ширина между линиями', (2 * Math.min(...W)).toFixed(1), '…', (2 * Math.max(...W)).toFixed(1), 'м; поребрики на полотне:', kerbOnTrack)
console.log('пит-лейн: ось', pitAxis.length, 'точек,', pitPoints.out, 'м; ограничитель', pitPoints.limStart, '…', pitPoints.limEnd, 'м; боксов', boxes.length)
console.log('сектора', sectorS.join(', '), 'м; земля', gnx, '×', gnz, '(шаг', GS, 'м), под лентой', covered, ', земля выше ленты в', poke, 'точках (до', pokeMax.toFixed(2), 'м); деревьев', trees.length)
console.log('повороты:', turns.map((t) => `${t.name} ${t.s0.toFixed(0)}–${t.s1.toFixed(0)} R${t.R}`).join('; '))
