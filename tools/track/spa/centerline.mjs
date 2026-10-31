// Ось трассы «Спа-Франкоршам» (по мотивам): прямые и повороты-дуги с переходными кривыми (клотоиды),
// по часовой стрелке. Три прямые подбираются так, чтобы круг замкнулся и был ровно LENGTH метров.
// Плоскость XZ (Y вверх), направление a: (cos a, sin a); поворот направо (по часовой, если смотреть сверху) — a растёт.
export const LENGTH = 7000
const H = 0.25 // шаг интегрирования, м
const deg = Math.PI / 180

// t: поворот в градусах (+ направо), R — радиус дуги, Ls — длина каждой переходной кривой
// name — название поворота (для отчёта, рельефа и окружения); v — прямая, длину которой подбираем
export const PLAN = [
  { L: 240, name: 'старт → Ла-Сурс' },
  { t: 165, R: 24, Ls: 16, name: 'Ла-Сурс' },
  { L: 110 },
  { t: 12, R: 320, Ls: 30, name: 'спуск' },
  { L: 130 },
  { t: -35, R: 110, Ls: 26, name: 'О-Руж' },
  { L: 8 },
  { t: 45, R: 125, Ls: 32, name: 'Радийон' },
  { L: 14 },
  { t: -40, R: 210, Ls: 30, name: 'вершина Радийона' },
  { L: 600, v: true, name: 'прямая Кеммель' },
  { t: 8, R: 900, Ls: 30, name: 'Кеммель излом' },
  { L: 200 },
  { t: 72, R: 40, Ls: 18, name: 'Ле-Комб' },
  { L: 36 },
  { t: -74, R: 45, Ls: 18, name: 'Ле-Комб 2' },
  { L: 110 },
  { t: 80, R: 55, Ls: 20, name: 'Мальмеди' },
  { L: 260, v: true, name: 'спуск к Риважу' },
  { t: 150, R: 30, Ls: 18, name: 'Риваж' },
  { L: 160 },
  { t: -45, R: 110, Ls: 25, name: 'поворот 9' },
  { L: 220, name: 'к Пуону' },
  { t: -75, R: 95, Ls: 25, name: 'Пуон' },
  { L: 50 },
  { t: -70, R: 105, Ls: 25, name: 'Пуон 2' },
  { L: 320, v: true, name: 'к Фань' },
  { t: 55, R: 60, Ls: 20, name: 'Фань' },
  { L: 40 },
  { t: -48, R: 70, Ls: 20, name: 'Кампюс' },
  { L: 160 },
  { t: 85, R: 65, Ls: 20, name: 'Ставло' },
  { L: 70 },
  { t: 90, R: 90, Ls: 25, name: 'Ставло 2' },
  { L: 250 },
  { t: 0, R: 350, Ls: 40, name: 'Поль Фрер', rest: true },
  { L: 250 },
  { t: -35, R: 380, Ls: 40, name: 'Бланшимон' },
  { L: 120 },
  { t: -25, R: 420, Ls: 40, name: 'Бланшимон 2' },
  { L: 250 },
  { t: 80, R: 28, Ls: 15, name: 'Бас-Стоп' },
  { L: 25 },
  { t: -80, R: 28, Ls: 15, name: 'Бас-Стоп 2' },
  { L: 380, name: 'стартовая прямая' },
]

// кривизна по шагам сетки H для одного поворота
function turnSamples(seg) {
  const total = seg.t * deg
  const sgn = Math.sign(total) || 1
  const k = sgn / seg.R
  const n1 = Math.max(1, Math.round(seg.Ls / H))
  const thS = (k * H * n1) / 2 // поворот одной переходной
  const arcAng = total - 2 * thS
  const n2 = Math.max(1, Math.round(Math.abs(arcAng) / (Math.abs(k) * H)))
  const kArc = arcAng / (n2 * H)
  const out = []
  for (let i = 0; i < n1; i++) out.push((k * (i + 0.5)) / n1)
  for (let i = 0; i < n2; i++) out.push(kArc)
  for (let i = 0; i < n1; i++) out.push(k * (1 - (i + 0.5) / n1))
  return out
}

export function buildCenterline(a0 = -Math.PI / 2, solve = true) {
  const plan = PLAN.map((s) => ({ ...s }))
  const rest = plan.find((s) => s.rest)
  rest.t = 360 - plan.filter((s) => s.t !== undefined && !s.rest).reduce((a, s) => a + s.t, 0)
  const vars = plan.filter((s) => s.v)
  // два прохода: решаем линейную систему по длинам прямых, потом округление сетки
  for (let pass = 0; pass < (solve ? 3 : 0); pass++) {
    const { X, Z, n, heads } = integrate(plan, a0)
    const gx = X[n] - X[0]
    const gz = Z[n] - Z[0]
    const gl = n * H - LENGTH
    // [cos a_v ...; sin a_v ...; 1 1 1] * dL = -[gx, gz, gl]
    const M = [vars.map((v) => Math.cos(heads.get(v))), vars.map((v) => Math.sin(heads.get(v))), vars.map(() => 1)]
    const dL = solve3(M, [-gx, -gz, -gl])
    vars.forEach((v, i) => (v.L += dL[i]))
  }
  const r = integrate(plan, a0)
  r.gap = [r.X[r.n] - r.X[0], r.Z[r.n] - r.Z[0]]
  if (!solve) { r.plan = plan; r.H = H; r.closure = Math.hypot(...r.gap); return r }
  // остаток замыкания (доли шага) — линейно по длине
  const rx = r.X[r.n] - r.X[0]
  const rz = r.Z[r.n] - r.Z[0]
  for (let i = 0; i <= r.n; i++) {
    r.X[i] -= (rx * i) / r.n
    r.Z[i] -= (rz * i) / r.n
  }
  r.closure = Math.hypot(rx, rz)
  r.plan = plan
  r.H = H
  return r
}

function integrate(plan, a0) {
  const K = []
  const heads = new Map()
  const segStart = []
  let a = a0
  for (const s of plan) {
    segStart.push(K.length)
    if (s.L !== undefined) {
      heads.set(s, a)
      const n = Math.round(s.L / H)
      for (let i = 0; i < n; i++) K.push(0)
    } else {
      const ks = turnSamples(s)
      for (const k of ks) {
        K.push(k)
        a += k * H
      }
    }
  }
  const n = K.length
  const X = new Float64Array(n + 1)
  const Z = new Float64Array(n + 1)
  const A = new Float64Array(n + 1)
  A[0] = a0
  for (let i = 0; i < n; i++) {
    const am = A[i] + (K[i] * H) / 2
    X[i + 1] = X[i] + Math.cos(am) * H
    Z[i + 1] = Z[i] + Math.sin(am) * H
    A[i + 1] = A[i] + K[i] * H
  }
  return { X, Z, A, K, n, heads, segStart }
}

function solve3(M, b) {
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const D = det(M)
  return [0, 1, 2].map((c) => det(M.map((row, r) => row.map((v, j) => (j === c ? b[r] : v)))) / D)
}
