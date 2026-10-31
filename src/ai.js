// ИИ-водитель. Бот ездит на той же физике, что и игрок: он только «жмёт педали и крутит руль» —
// выдаёт тот же набор ввода { throttle, brake, steer, aero, boost… }. Без Three.js, проверяется в Node.
// Идеи (не код) — из роботов TORCS / Speed Dreams (Simplix, USR, DanDroid) и SuperTuxKart.
//
// 1) Гоночная линия: ось трассы сглаживается в пределах ширины — линия срезает повороты (вход снаружи,
//    апекс внутри, выход снаружи). Уровень решает, насколько бот уходит от середины к этой линии.
//    Заранее считаются ещё две линии — левая и правая, каждая со своим профилем скорости; при объезде
//    бот смешивает гоночную линию с боковой (и скорость тоже), а не просто сдвигает точку прицеливания.
// 2) Скорость: в каждой точке — предел по сцеплению (шина + прижим), затем проход с конца назад:
//    успеть оттормозиться к следующему повороту. Уровень — какая доля сцепления и тормозов используется.
// 3) Соседи (как Simplix Classify): для каждого болида впереди — через сколько секунд догоню и какой
//    будет боковой зазор в этот момент (с учётом того, как я сам сместлюсь). Тормозим, только если удар
//    реально будет: нужное замедление = (моя скорость − его) / время до догона.
// 4) Объезд (как Simplix Runaround): боковое смещение — движение с пределом боковой скорости и ускорения,
//    с торможением к цели. Ширина трассы делится на 9 полос, полосы под соседями помечаются занятыми,
//    выбирается окно из 3 свободных — лучше с внутренней стороны следующего поворота.
// 5) Решение (как USR canOvertake): обгон начинается, только если хватает разницы в скорости и места до
//    точки торможения. Иначе — едем следом. Сосед сбоку — сужаем свой коридор, а не толкаемся.
// 6) Автомат (как DanDroid): линия → следом → обгон → возврат на линию, с задержками; выбранную сторону
//    держим минимум 1,8 с — боковых дёрганий нет.
// 7) Руль: «погоня за точкой» — самая дальняя точка линии, до которой прямая не выходит за трассу
//    (SuperTuxKart findNonCrashingPoint), угол колёс — чтобы попасть в неё.
// 8) Защита: догоняют сзади на прямой — одно перестроение навстречу, держит до конца атаки.
// 9) Пилоты, как в F1 25: у каждого свои рейтинги (makePilots) — темп по номеру 1…N (1 — предел уровня,
//    каждый следующий на 0,5% медленнее), своя траектория (насколько срезает), тормоза, взгляд вперёд,
//    агрессия (как охотно закрывается и идёт на обгон). Уровень сложности сдвигает всех разом.
import { TUNING } from './tuning.js'
import { tyreGrip } from './wear.js'

const G = 9.81

// passDv — на сколько м/с надо быть быстрее болида впереди, чтобы пойти на обгон
// Уровни (Рома 31.10: «боты не нравятся»): бывшие средние — теперь «Стандартные», самый простой уровень; бывшие сложные —
// «Средние»; «Сложные» (pro) — те же, что средние, плюс подтягивание (rubber, bots.js): уехал от них — догоняют, отстал — лидеры
// чуть сбавляют. Ключи прежние (сохранёнки, сервер, тесты); light в меню больше нет — остался для тестов и замеров.
export const AI_LEVELS = {
  light: { name: 'Лёгкие', grip: 0.8, brake: 0.7, line: 0.5, look: 1.15, ers: 'balanced', boost: false, defend: false, passDv: 3.2 },
  medium: { name: 'Стандартные', grip: 0.91, brake: 0.85, line: 0.85, look: 1.05, ers: 'balanced', boost: true, defend: true, passDv: 2.2 },
  hard: { name: 'Средние', grip: 1, brake: 1, line: 1, look: 1, ers: 'hotlap', boost: true, defend: true, passDv: 1.6 },
  pro: { name: 'Сложные', grip: 1, brake: 1, line: 1, look: 1, ers: 'hotlap', boost: true, defend: true, passDv: 1.4, rubber: true },
}
// уровни в меню (по возрастанию) и старые сохранённые → нынешние
export const LEVEL_IDS = ['medium', 'hard', 'pro']
export const levelOf = (id) => (LEVEL_IDS.includes(id) ? id : 'medium')

const MARGIN = 1.5 // м от белой линии края до центра болида на гоночной линии
const CAR_W = 2.1 // ширина болида с запасом, м
const CAR_L = 5.6 // длина болида, м
const HIT_GAP = CAR_W + 1 // ближе этого бок о бок (центр к центру) мы соседа не подпускаем (коридор)
const HIT_AHEAD = CAR_W + 0.45 // ближе этого к болиду впереди в момент догона — считаем, что заденем, и тормозим
const LANES = 9 // полос поперёк трассы для выбора окна объезда
const LANE_EDGE = 1.2 // от белой линии до центра болида в крайней полосе
const SIDE = 4.2 // на сколько боковая линия уходит от гоночной, м
const LAT_V = 3.2 // предел боковой скорости смещения, м/с
const LAT_A = 5 // предел бокового ускорения смещения, м/с²
const HOLD = 1.8 // с: выбранную сторону обгона не меняем
const CHORD_EDGE = 1.5 // м от белой линии: дальше прямая «до точки» выходит за трассу
const PACK_K = 0.94 // доля скорости по профилю, когда рядом кто-то (поток)
const STRAIGHT_ALPHA = 0.06 // рад: дальнюю точку берём, только когда она почти прямо по ходу

// пилоты на гонку: номера 1…count вразброс, у каждого свои рейтинги
export function makePilots(count, rand = Math.random) {
  const ranks = Array.from({ length: count }, (_, i) => i + 1)
  for (let i = ranks.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[ranks[i], ranks[j]] = [ranks[j], ranks[i]]
  }
  return ranks.map((rank) => ({
    rank,
    pace: 1 - (rank - 1) * 0.005, // доля предела уровня
    line: 0.82 + rand() * 0.18, // насколько срезает повороты
    brake: 0.95 + rand() * 0.05,
    look: 0.95 + rand() * 0.12,
    aggression: rand(), // охота закрываться и лезть в борьбу
  }))
}

// сглаживание оси — самое дорогое, у всех пилотов общее: считаем один раз на трассу
const bases = new WeakMap()
function baseLine(axis) {
  if (bases.has(axis)) return bases.get(axis)
  const n = axis.length
  const cx = new Float64Array(n)
  const cz = new Float64Array(n)
  const nx = new Float64Array(n) // нормаль влево от направления движения
  const nz = new Float64Array(n)
  const wl = new Float64Array(n)
  const wr = new Float64Array(n)
  const at = (i) => ((i % n) + n) % n
  for (let i = 0; i < n; i++) {
    cx[i] = axis[i].x
    cz[i] = axis[i].z
    wl[i] = axis[i].width_left ?? 6
    wr[i] = axis[i].width_right ?? 6
  }
  for (let i = 0; i < n; i++) {
    const tx = cx[at(i + 1)] - cx[at(i - 1)]
    const tz = cz[at(i + 1)] - cz[at(i - 1)]
    const len = Math.hypot(tx, tz) || 1
    // в осях Three.js при взгляде вдоль +z левая сторона — +x
    nx[i] = tz / len
    nz[i] = -tx / len
  }

  // гоночная линия: сдвиг от оси, сглаживание в несколько масштабов (от длинных дуг к коротким)
  const off = new Float64Array(n)
  const tmp = new Float64Array(n)
  const px = (i) => cx[at(i)] + off[at(i)] * nx[at(i)]
  const pz = (i) => cz[at(i)] + off[at(i)] * nz[at(i)]
  for (const [k, iters] of [[40, 60], [20, 60], [10, 80], [5, 80], [2, 60]]) {
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < n; i++) {
        const mx = (px(i - k) + px(i + k)) / 2
        const mz = (pz(i - k) + pz(i + k)) / 2
        const o = (mx - cx[i]) * nx[i] + (mz - cz[i]) * nz[i]
        tmp[i] = Math.min(wl[i] - MARGIN, Math.max(-(wr[i] - MARGIN), off[i] + 0.6 * (o - off[i])))
      }
      off.set(tmp)
    }
  }
  const base = { n, cx, cz, nx, nz, wl, wr, off }
  bases.set(axis, base)
  return base
}

// axis — точки оси трассы по кругу: { x, z, distance_m, width_left, width_right }; pilot — из makePilots (или {})
export function createRaceLine(axis, levelKey, T = TUNING, pilot = {}) {
  const L = AI_LEVELS[levelKey]
  const { n, cx, cz, nx, nz, wl, wr } = baseLine(axis)
  const at = (i) => ((i % n) + n) % n
  // уровень и пилот: насколько бот уходит от середины к гоночной линии
  const off = Float64Array.from(baseLine(axis).off, (o) => o * L.line * (pilot.line ?? 1))
  const px = (i) => cx[at(i)] + off[at(i)] * nx[at(i)]
  const pz = (i) => cz[at(i)] + off[at(i)] * nz[at(i)]

  const x = new Float64Array(n)
  const z = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    x[i] = px(i)
    z[i] = pz(i)
  }
  const dsOf = (xs, zs) => {
    const d = new Float64Array(n) // расстояние до следующей точки
    for (let i = 0; i < n; i++) d[i] = Math.hypot(xs[at(i + 1)] - xs[i], zs[at(i + 1)] - zs[i]) || 0.1
    return d
  }
  const ds = dsOf(x, z)
  const cum = new Float64Array(n) // расстояние вдоль линии от точки 0
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + ds[i - 1]
  const total = cum[n - 1] + ds[n - 1]

  // скорость: предел в повороте по сцеплению с прижимом, mv²κ = μ(v)·(mg + k·v²).
  // μ(v) подогнано по замеру нашей физики : на 60 км/ч ≈1,40,
  // на 250 ≈1,21 — чем сильнее прижим, тем ниже коэффициент шины
  const k = T.downforceK
  const m = T.mass
  const mu = (v) => T.tireMu * 0.84 * L.grip * (pilot.pace ?? 1) * Math.pow(1 + (k * v * v) / (m * G), -T.loadSensitivity * 1.24)
  const vMax = 95
  const brakeAcc = (v) => Math.min(T.brakeForce / m, mu(v) * (G + (k * v * v) / m)) * L.brake * (pilot.brake ?? 1) + (T.dragK * v * v) / m
  const R = 5 // точки по бокам для кривизны (10 м)
  // профиль скорости по линии (xs, zs — её точки, d — расстояния между ними)
  const profile = (xs, zs, d) => {
    const speed = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const ax = xs[at(i - R)]
      const az = zs[at(i - R)]
      const bx = xs[i]
      const bz = zs[i]
      const qx = xs[at(i + R)]
      const qz = zs[at(i + R)]
      const cross = (bx - ax) * (qz - az) - (bz - az) * (qx - ax)
      const a = Math.hypot(bx - ax, bz - az)
      const b = Math.hypot(qx - bx, qz - bz)
      const c = Math.hypot(qx - ax, qz - az)
      const kappa = (2 * Math.abs(cross)) / Math.max(a * b * c, 1e-6)
      let vc = vMax
      for (let it = 0; it < 6; it++) {
        const u = mu(vc)
        const den = m * kappa - u * k
        vc = den <= 0 ? vMax : Math.min(vMax, Math.sqrt((u * m * G) / den))
      }
      speed[i] = vc
    }
    // назад по кругу (дважды — чтобы замкнуть): успеть оттормозиться
    for (let pass = 0; pass < 2; pass++) {
      for (let j = n - 1; j >= 0; j--) {
        const nv = speed[at(j + 1)]
        speed[j] = Math.min(speed[j], Math.sqrt(nv * nv + 2 * brakeAcc(nv) * d[j]))
      }
    }
    return speed
  }
  const speed = profile(x, z, ds)

  // боковые линии объезда: на SIDE метров от гоночной (меньше, где мало места), со сглаживанием,
  // у каждой свой профиль скорости. dir > 0 — левая, < 0 — правая
  const sideLine = (dir) => {
    const room = (i) => Math.max(0, dir > 0 ? wl[i] - 1.3 - off[i] : wr[i] - 1.3 + off[i])
    let S = Float64Array.from({ length: n }, (_, i) => Math.min(SIDE, room(i)))
    for (let pass = 0; pass < 3; pass++) {
      const T2 = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        let sum = 0
        for (let q = -8; q <= 8; q += 2) sum += S[at(i + q)]
        T2[i] = Math.min(sum / 9, room(i))
      }
      S = T2
    }
    const xs = new Float64Array(n)
    const zs = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      xs[i] = x[i] + dir * S[i] * nx[i]
      zs[i] = z[i] + dir * S[i] * nz[i]
    }
    return { S, speed: profile(xs, zs, dsOf(xs, zs)) }
  }
  const left = sideLine(1)
  const right = sideLine(-1)

  // изгиб линии со знаком: > 0 — поворачивает влево (внутренняя сторона слева)
  const bend = new Float64Array(n)
  for (let i = 0; i < n; i++) bend[i] = (x[at(i + R)] + x[at(i - R)] - 2 * x[i]) * nx[i] + (z[at(i + R)] + z[at(i - R)] - 2 * z[i]) * nz[i]

  return { n, x, z, off, nx, nz, wl, wr, speed, ds, cum, total, left, right, bend, brakeAcc, level: levelKey, pilot }
}

// Водитель. line — из createRaceLine; opts: { skill (≈1, разброс между ботами), idx (точка старта), zone (зоны режима прямой) }
export function createAiDriver(line, opts = {}) {
  const L = AI_LEVELS[line.level]
  const T = opts.T || TUNING
  const skill = opts.skill ?? 1
  const pilot = line.pilot || {}
  const aggression = pilot.aggression ?? 0.5
  const defends = L.defend && (pilot.aggression ?? 1) > 0.3
  const n = line.n
  const at = (i) => ((i % n) + n) % n
  const st = {
    idx: opts.idx ?? 0,
    offset: 0, // боковое смещение от гоночной линии, м (влево +)
    latV: 0, // боковая скорость смещения, м/с
    tgt: 0, // куда смещение идёт сейчас
    mode: 'line', // line → follow → pass → return; defend — закрываемся от догоняющего
    side: 0, // сторона обгона (влево +), держится HOLD секунд
    hold: 0, // сколько уже держим выбранную сторону
    tMode: 0, // сколько в текущем режиме
    clear: 0, // сколько уже нет помехи (для возврата)
    cool: 0, // после сорванного обгона не пробуем снова
    evalT: 0,
    defendTgt: null,
    noAttack: 0,
    tRun: 0, // сколько уже едем после старта; на разгоне в куче не обгоняем
    raceT: 0, // сколько едем с отмашки: обнуляют только огни старта (bots.js), возврат на трассу (reset) — нет
    lane: 0, // полоса, с которой стартовали (от гоночной линии, м): держим её, пока до торможения далеко
    vl: 0, // боковая скорость болида (по месту), сглажена
    lPrev: null,
    stuck: 0,
    dist: 0,
    cap: Infinity, // потолок скорости, м/с: машина безопасности, VSC, жёлтый участок, красный флаг (0 — стоять); ставит bots.js
    rubber: 1, // подтягивание «Сложных» (bots.js): множитель скорости по профилю — болид тоже получает столько же сцепления
    noPass: false, // обгон запрещён (флаги)
    slip: 0,
    lost: opts.idx == null,
    placed: false,
    block: false, // впереди болид, с которым по прогнозу столкнёмся
    oppBrake: 0, // торможение из-за болида впереди, плавно спадает (без «дёрганья» педали)
  }
  // hold: тормоз почти на месте держит болид, а не включает задний ход — бот назад не ездит (Марина, 30.10: со 2-го ряда
  // решётки бот тормозил перед стоящим соседом и уезжал назад до −22 км/ч прямо в тех, кто сзади)
  const input = { throttle: 0, brake: 0, steer: 0, handbrake: false, aero: false, aeroZone: true, abs: true, ersMode: L.ers, boost: false, hold: true }

  function nearest(px, pz, wide) {
    let best = st.idx
    let bd = Infinity
    const from = wide ? 0 : st.idx - 15
    const to = wide ? n : st.idx + 60
    for (let j = from; j < to; j++) {
      const i = at(j)
      const d = (line.x[i] - px) ** 2 + (line.z[i] - pz) ** 2
      if (d < bd) {
        bd = d
        best = i
      }
    }
    return { i: best, d: Math.sqrt(bd) }
  }

  // расстояние вдоль линии от точки a до точки b (со знаком, по кругу)
  const sBetween = (a, b) => {
    let s = line.cum[b] - line.cum[a]
    if (s > line.total / 2) s -= line.total
    else if (s < -line.total / 2) s += line.total
    return s
  }

  // желаемая боковая скорость: разгон, потолок и торможение к цели (скорость ~ √(2·a·путь))
  const latVel = (e) => Math.sign(e) * Math.min(LAT_V, Math.sqrt(1.6 * LAT_A * Math.abs(e)))
  // где окажется смещение через time секунд, если идти к target (то же движение, что и в update)
  function predict(time, target) {
    let o = st.offset
    let w = st.latV
    for (let t = 0; t < time; t += 0.1) {
      const h = Math.min(0.1, time - t)
      w += Math.max(-LAT_A * h, Math.min(LAT_A * h, latVel(target - o) - w))
      o += w * h
    }
    return o
  }

  const setMode = (mode) => {
    st.mode = mode
    st.tMode = 0
  }

  return {
    state: st,
    input,

    // точка старта/возврата на трассу: искать заново по всему кругу
    reset(idx) {
      if (idx != null) st.idx = idx
      st.offset = 0
      st.latV = 0
      st.tgt = 0
      st.mode = 'line'
      st.side = 0
      st.hold = 0
      st.tMode = 0
      st.clear = 0
      st.cool = 0
      st.defendTgt = null
      st.noAttack = 0
      st.block = false
      st.oppBrake = 0
      st.tRun = 0
      st.lane = 0
      st.vl = 0
      st.lPrev = null
      st.stuck = 0
      st.lost = true
      st.placed = false
    },

    // v — болид бота, others — [{ x, z, speed }] остальные болиды, dt — с
    update(v, dt, others = []) {
      const p = v.body.translation()
      const q = v.body.rotation()
      const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
      const fx = Math.sin(yaw)
      const fz = Math.cos(yaw)
      const lx = Math.cos(yaw)
      const lz = -Math.sin(yaw)
      const speed = Math.max(0, v.state.fwdSpeed)

      let near = nearest(p.x, p.z, st.lost)
      if (near.d > 30 && !st.lost) near = nearest(p.x, p.z, true)
      st.lost = false
      st.idx = near.i
      st.dist = near.d
      // сдвиг от линии там, где бот стоит сейчас (решётка, возврат на трассу) — без рывка к линии
      const i0 = st.idx
      const lMe = (p.x - line.x[i0]) * line.nx[i0] + (p.z - line.z[i0]) * line.nz[i0]
      if (!st.placed) {
        st.offset = lMe
        st.tgt = lMe
        st.latV = 0
        st.lane = lMe
        st.placed = true
      }
      // в повороте болид идёт шире линии: зазоры с соседями считаем по месту, где он на самом деле
      const lag = lMe - st.offset // отставание болида от желаемого смещения
      st.vl += ((st.lPrev === null ? 0 : (lMe - st.lPrev) / Math.max(dt, 1e-3)) - st.vl) * Math.min(1, dt / 0.25)
      st.lPrev = lMe
      st.tRun = speed > 3 ? st.tRun + dt : 0
      st.raceT += dt
      const inZone = opts.zone ? opts.zone[i0] === 1 : true
      st.hold += dt
      st.tMode += dt
      st.cool = Math.max(0, st.cool - dt)

      // шины: холодные, стёртые, перегретые или проколотые держат хуже — бот едет медленнее, как живой
      // (скорость в повороте ∝ √сцепления; профиль посчитан на номинальную шину)
      let tg = 1
      if (v.wearOn) {
        tg = 0
        for (let i = 0; i < 4; i++) tg += tyreGrip(v.tyres[i], v.compound, v.wet) / 4
      }
      const tyreK = Math.sqrt(Math.min(1.04, tg))
      // мокрая трасса и плохие шины — и тормозить раньше: замедление ∝ сцеплению
      const maxDec = line.brakeAcc(speed) * Math.min(1, tg)

      // ---- соседи: где каждый на линии (расстояние s, боковое l), его скорость
      const nbs = []
      for (const o of others) {
        const ddx = o.x - p.x
        const ddz = o.z - p.z
        if (ddx * ddx + ddz * ddz > 320 * 320) continue
        let bj = -1
        let bd = Infinity
        for (let j = i0 - 25; j < i0 + 150; j++) {
          const i = at(j)
          const d = (line.x[i] - o.x) ** 2 + (line.z[i] - o.z) ** 2
          if (d < bd) {
            bd = d
            bj = i
          }
        }
        if (bd > 40 * 40) continue
        // расстояние вдоль линии с точностью до долей шага (точки идут через ~2 м): без него «рядом» — это ±1 м
        const s =
          sBetween(i0, bj) +
          (o.x - line.x[bj]) * -line.nz[bj] +
          (o.z - line.z[bj]) * line.nx[bj] -
          ((p.x - line.x[i0]) * -line.nz[i0] + (p.z - line.z[i0]) * line.nx[i0])
        if (s < -45 || s > 300) continue
        nbs.push({ s, l: (o.x - line.x[bj]) * line.nx[bj] + (o.z - line.z[bj]) * line.nz[bj], v: Math.max(0, o.speed), j: bj })
      }

      // в потоке рядом кто-то: зазоры считаем по месту, где болид на самом деле (в одиночку цель тянет болид обратно на линию)
      const inTraffic = nbs.some((nb) => nb.s > -25 && nb.s < 40 && Math.abs(nb.l - lMe) < 8)

      // ---- прогноз столкновения (Simplix Classify): через сколько секунд догоню и каков будет боковой зазор
      const safe = 3.5 + 0.18 * speed // желаемый зазор между бамперами
      let block = null
      let attack = null
      let busy = false // кто-то рядом сбоку или чуть впереди — обгон ещё идёт
      let lo = -Infinity
      let hi = Infinity
      let squeezeBy = false
      let yieldV = Infinity
      for (const nb of nbs) {
        const gap = nb.s - CAR_L // от моего носа до его хвоста
        if (nb.s > -(CAR_L + 3) && nb.s < CAR_L + 3 && Math.abs(nb.l - lMe) < 6) {
          // рядом сбоку: сужаем свой коридор, а не лезем на него
          // уже сближаемся вбок — запас больше (болид отвечает на руль не сразу)
          if (nb.l >= lMe) hi = Math.min(hi, nb.l - lag - HIT_GAP - 0.4 * Math.max(0, st.vl))
          else lo = Math.max(lo, nb.l - lag + HIT_GAP + 0.4 * Math.max(0, -st.vl))
          squeezeBy = true
          // бок о бок и уже перекрылись: тот, чей центр позади соседа, уступает — чуть сбавляет и отстаёт
          // стоящему (заглох, разбит) не уступают — иначе встаёшь рядом с ним насовсем; на решётке первые 8 с — уступают
          const parked = nb.v < 1.5 && st.raceT > 8
          if (!parked && (nb.s > 0.3 || (nb.s > -0.3 && speed >= nb.v)) && Math.abs(nb.l - lMe) < HIT_GAP) yieldV = Math.min(yieldV, nb.v - 2 - 2 * (HIT_GAP - Math.abs(nb.l - lMe)))
        }
        if (nb.s >= CAR_L + 1.5) {
          const vc = speed - nb.v
          const tc = vc > 0.2 ? Math.max(gap, 0) / vc : Infinity
          if (tc < 6 || (gap < 2 * safe && vc > -1.5)) {
            // болид отстаёт от желаемого смещения, пока смещается (≈ боковая скорость × 0,7 с); остановится — отставание пройдёт
            const horizon = Math.min(tc, 4)
            const lp = predict(horizon, st.tgt) + lag * Math.exp(-horizon / 0.8)
            if (Math.abs(lp - nb.l) < HIT_AHEAD && (block === null || gap < block.gap)) block = { gap, vc, tc, v: nb.v, l: nb.l, s: nb.s, j: nb.j }
          }
        } else if (nb.s < -8 && nb.s > -30 && Math.abs(nb.l - lMe) < 7 && nb.v - speed > 1.5 && nb.v - speed < 14 && st.tRun > 6 && (attack === null || Math.abs(nb.l - lMe) < Math.abs(attack))) {
          attack = nb.l - lMe // догоняющий сзади (влево +)
        }
        if (nb.s > -(CAR_L + 4) && nb.s < 18 && Math.abs(nb.l - lMe) < 4.2) busy = true
      }
      st.block = block !== null

      // скорость, с которой можно было бы ехать здесь, ничего не опасаясь; на боковой линии — смесь профилей
      const dirNow = st.offset >= 0 ? 1 : -1
      const sideNow = dirNow > 0 ? line.left : line.right
      const wNow = Math.min(1.4, Math.abs(st.offset) / Math.max(1, sideNow.S[i0]))
      const spd = (i) => {
        const sd = dirNow > 0 ? line.left.speed[i] : line.right.speed[i]
        return line.speed[i] + Math.min(1, wNow) * (sd - line.speed[i])
      }

      // сколько места до точки торможения (профиль скорости упадёт на пятую часть)
      const brakePoint = () => {
        const ref = line.speed[i0]
        let acc = 0
        for (let c = 0; c < 150; c++) {
          const jj = at(i0 + c * 2)
          if (line.speed[jj] < ref * 0.8) return acc
          acc += line.ds[jj] * 2
        }
        return acc
      }

      // стоящая или совсем медленная помеха (а не поле, которое разгоняется вместе со мной): на месте, под огнями, ничего не объезжаем
      // стоящий болид прямо впереди — помеха и тогда, когда сам уже встал за ним (Рома 30.10, флаги: за заглохшим ботом
      // вставала вся колонна до эвакуатора — под флагом «не обгонять», а помехой он считался, только пока едешь быстрее 8 м/с);
      // первые 8 с после отмашки — нет: на решётке все стоят
      const isObstacle = (b) => (b.v < 3 && speed > 8) || (b.v < 0.35 * speed && speed > 12) || (b.v < 1.5 && b.gap < 30 && st.raceT > 8)

      // решение «обгонять или нет» (USR canOvertake): хватает разницы в скорости и места до торможения
      const canOvertake = (b) => {
        if (st.cool > 0) return false
        if (st.noPass && !isObstacle(b)) return false // под флагами не обгоняем, стоящее объезжаем
        // стоящую или совсем медленную помеху объезжаем всегда; а вот обгонять в куче на разгоне и на малой скорости не начинаем
        if (!isObstacle(b) && (speed < 25 || st.tRun < 6)) return false
        const vfree = line.speed[at(i0 + Math.round(Math.max(0, b.s) / 2))] * skill * st.rubber * tyreK
        const dv = vfree - b.v
        if (dv < L.passDv) return false
        const tPass = (b.gap + CAR_L + 3) / Math.max(0.6 * dv, 1)
        const need = (Math.max(speed, b.v) + 0.3 * dv) * tPass
        return brakePoint() > need + 15 + 25 * (1 - aggression)
      }

      // окно из трёх свободных полос из девяти; лучше с внутренней стороны следующего поворота
      const pickWindow = (b, lockSide) => {
        const jb = b.j
        const half = [line.wl[jb] - LANE_EDGE, line.wr[jb] - LANE_EDGE]
        const lowest = -half[1]
        const step = (half[0] + half[1]) / (LANES - 1)
        const occ = new Array(LANES).fill(false)
        for (const nb of nbs) {
          if (nb.s <= -(CAR_L + 8) || nb.s > b.s + 14) continue
          const lax = nb.l + line.off[nb.j]
          for (let c = 0; c < LANES; c++) if (Math.abs(lowest + c * step - lax) < CAR_W / 2 + 0.3) occ[c] = true
        }
        // в какую сторону следующий поворот: внутренняя сторона
        let inner = 0
        for (let c = 0, jj = jb; c < 150; c++, jj += 2) {
          const bd = line.bend[at(jj)]
          if (Math.abs(bd) > 0.35) {
            inner = Math.sign(bd)
            break
          }
        }
        let best = null
        for (let c = 1; c < LANES - 1; c++) {
          if (occ[c - 1] || occ[c] || occ[c + 1]) continue
          const rel = lowest + c * step - line.off[jb] // смещение от гоночной линии
          const side = rel >= b.l ? 1 : -1
          if (lockSide && side !== lockSide) continue
          const cost = Math.abs(rel - st.offset) + 0.5 * Math.max(0, -inner * (rel - b.l)) + 0.2 * Math.abs(rel - b.l)
          if (best === null || cost < best.cost) best = { rel, side, cost }
        }
        return best
      }

      // со стартовой решётки не бежим сразу на гоночную линию (все 12 в одну колонну): своя полоса держится, пока до
      // торможения далеко, и плавно уходит на линию на последних ~250 м перед ним; обгон и возврат её отменяют
      const laneWant = () => {
        if (st.lane === 0) return 0
        const k = Math.max(0, Math.min(1, (brakePoint() - 120) / 130))
        if (k === 0) st.lane = 0
        return st.lane * k
      }

      // ---- автомат: линия → следом → обгон → возврат (DanDroid), защита от догоняющего
      st.evalT -= dt
      let want = 0
      switch (st.mode) {
        case 'line':
          want = laneWant()
          if (block) {
            setMode('follow')
            st.clear = 0
          } else if (defends && inZone && attack !== null && aggression > 0.3) {
            st.defendTgt = null
            st.noAttack = 0
            setMode('defend')
          }
          break
        case 'follow':
          want = laneWant()
          if (!block) {
            st.clear += dt
            if (st.clear > 0.7) setMode(Math.abs(st.offset) > 0.25 ? 'return' : 'line')
          } else {
            st.clear = 0
            if (st.evalT <= 0 && (st.tMode > 0.35 + 0.5 * (1 - aggression) || isObstacle(block))) {
              st.evalT = 0.2
              if (canOvertake(block)) {
                const w = pickWindow(block, 0)
                if (w) {
                  st.side = w.side
                  st.hold = 0
                  st.tgt = w.rel
                  setMode('pass')
                }
              }
            }
          }
          break
        case 'pass': {
          want = st.tgt
          if (st.evalT <= 0) {
            st.evalT = 0.25
            // новое окно — только на ту же сторону, пока не прошло HOLD (если окно занято — сторону можно сменить)
            const b = block || nbs.filter((nb) => nb.s > -(CAR_L + 4) && nb.s < 70).sort((a, c) => a.s - c.s)[0]
            if (b) {
              const bb = { j: b.j, s: b.s, l: b.l }
              const w = pickWindow(bb, st.hold < HOLD ? st.side : 0)
              if (w && Math.abs(w.rel - st.tgt) > 0.2) {
                if (st.hold >= HOLD || w.side === st.side) st.tgt = w.rel
                if (w.side !== st.side) {
                  st.side = w.side
                  st.hold = 0
                }
              }
            }
          }
          want = st.tgt
          if (!busy && !block) {
            st.clear += dt
            if (st.clear > 0.5 && st.hold > HOLD) setMode('return')
          } else st.clear = 0
          // обгон не получается (разница скоростей кончилась) — вернуться за болид и подождать
          if (st.tMode > 7 && block) {
            st.cool = 3
            setMode('follow')
            st.clear = 0
          }
          break
        }
        case 'return':
          want = 0
          if (block) setMode('follow')
          else if (Math.abs(st.offset) < 0.25 && st.tMode > 0.3) setMode('line')
          break
        case 'defend':
          if (st.defendTgt === null) st.defendTgt = st.offset + (attack ?? 0) // одно перестроение навстречу
          want = st.defendTgt
          if (attack === null) st.noAttack += dt
          else st.noAttack = 0
          if (block) setMode('follow')
          else if (st.noAttack > 0.6 && st.tMode > HOLD) setMode('return')
          break
      }
      if (st.mode !== 'pass' && st.mode !== 'defend') st.side = 0
      if (st.mode === 'pass' || st.mode === 'defend' || st.mode === 'return') st.lane = 0

      // сдвиг от линии в пределах асфальта (и в пределах боковой линии)
      const room = (side) => Math.min(side > 0 ? line.wl[i0] - MARGIN + 0.6 - line.off[i0] : line.wr[i0] - MARGIN + 0.6 + line.off[i0], 1.4 * (side > 0 ? line.left : line.right).S[i0])
      const lowest = -Math.max(0, room(-1))
      const highest = Math.max(0, room(1))
      let tgt = Math.max(lowest, Math.min(highest, want))
      // сосед сбоку — коридор уже: на его сторону не заходим (но и за белую линию не уходим)
      if (lo > hi) tgt = (lo + hi) / 2
      else tgt = Math.max(lo, Math.min(hi, tgt))
      tgt = Math.max(lowest, Math.min(highest, tgt))
      st.tgt = tgt
      // боковое смещение: предел скорости и ускорения, торможение к цели
      st.latV += Math.max(-LAT_A * dt, Math.min(LAT_A * dt, latVel(tgt - st.offset) - st.latV))
      st.offset += st.latV * dt

      // ---- руль: самая дальняя точка линии, до которой прямая не выходит за трассу (findNonCrashingPoint)
      const dir = st.offset >= 0 ? 1 : -1
      const side = dir > 0 ? line.left : line.right
      // вес боковой линии: смещение больше SIDE (стартовая полоса, окно обгона у края) — продолжаем её форму, но не дальше асфальта
      const w = Math.min(2.5, Math.abs(st.offset) / Math.max(1, side.S[i0]))
      const look = (6 + 0.32 * speed) * L.look * (pilot.look ?? 1)
      let tx = 0
      let tz = 0
      let reach = look
      for (const mult of [1.5, 1.25, 1]) {
        const dist = look * mult
        reach = dist
        let j = i0
        for (let acc = 0; acc < dist; j++) acc += line.ds[at(j)]
        const jt = at(j)
        const room = Math.max(0, dir > 0 ? line.wl[jt] - 1.3 - line.off[jt] : line.wr[jt] - 1.3 + line.off[jt])
        const sh = dir * Math.min(w * side.S[jt], room)
        const ax = line.x[jt] + sh * line.nx[jt]
        const az = line.z[jt] + sh * line.nz[jt]
        tx = ax - p.x
        tz = az - p.z
        if (mult === 1) break
        // дальше обычного смотрим, только пока цель почти прямо по ходу: в повороте дальняя цель даёт вылет наружу
        let ok = Math.abs(Math.atan2(tx * lx + tz * lz, tx * fx + tz * fz)) < STRAIGHT_ALPHA
        for (let t = 0.125; t < 1 && ok; t += 0.125) {
          const ii = at(i0 + Math.round(t * (j - i0)))
          const sx = p.x + tx * t
          const sz = p.z + tz * t
          const lat = (sx - line.x[ii]) * line.nx[ii] + (sz - line.z[ii]) * line.nz[ii] + line.off[ii]
          ok = lat < line.wl[ii] - CHORD_EDGE && lat > -(line.wr[ii] - CHORD_EDGE)
        }
        if (ok) break
      }
      const alpha = Math.atan2(tx * lx + tz * lz, tx * fx + tz * fz)
      const delta = Math.atan((2 * T.wheelBase * Math.sin(alpha)) / reach)
      const aLim = T.tireMu * G * (1 + (v.aeroK * speed * speed) / (T.mass * G))
      const maxA = Math.min(T.steerLock, Math.atan((T.wheelBase * aLim) / Math.max(speed * speed, 1)) + T.steerSlipMargin)
      const demand = Math.abs(delta) / maxA // 1 — рулю не хватает хода или сцепления, чтобы попасть в точку
      input.steer = Math.sign(delta) * Math.pow(Math.min(1, demand), 1 / T.steerCurve)

      // ---- педали: скорость по профилю здесь (смесь линий) и замедление, нужное, чтобы к точке впереди выйти на её скорость
      // на старте поле разгоняется вместе (как в F1): за болидом впереди скорость не держим, это делает прогноз удара
      const launching = st.tRun < 5 && speed < 40
      let follow = yieldV
      let oppBrake = 0
      if (block) {
        const gapRem = block.gap - safe
        // держим зазор: чем он больше, тем быстрее можно ехать относительно болида впереди
        if (!launching) follow = Math.min(follow, block.v + Math.max(-1.5, 0.3 * gapRem))
        if (block.vc > 0.2) {
          const tcs = Math.max(0.15, gapRem / block.vc)
          const decel = block.vc / tcs // (моя скорость − его) / время до догона
          if (decel * 0.5 > 0.18 * maxDec) oppBrake = Math.min(1, (decel * 0.55) / maxDec)
        }
      }
      // руль на пределе, а до точки всё равно не дотягиваемся (болид вынесло из-за возни с соседями) — сбавить
      // и когда болид стабильно идёт шире своей линии (не на перестроении) — тоже сбавить, пока не вынесло за белую
      let wide = demand > 0.92 && Math.abs(lag) > 0.6 ? speed - (demand - 0.92) * 14 : Infinity
      // у самой белой линии (центр ближе 0,4 м к ней) — сбавить, чтобы не вынесло на траву
      const latAx = lMe + line.off[i0]
      const edge = Math.max(latAx - (line.wl[i0] - 0.4), -latAx - (line.wr[i0] - 0.4))
      if (edge > 0) wide = Math.min(wide, speed - edge * 6)
      if (inTraffic && (st.mode === 'line' || st.mode === 'follow') && Math.abs(st.latV) < 1 && Math.abs(lag) > 1.2) wide = Math.min(wide, speed - (Math.abs(lag) - 1.2) * 8)
      // в потоке идеальной линии нет (чужой воздух, чужие траектории) — чуть меньше предела, чтобы не выносило в поворотах
      // (на прямой не режем: там обгон и не нужно терять в скорости; чем медленнее поворот — тем сильнее)
      const packK = inTraffic ? 1 - (1 - PACK_K) * Math.max(0, Math.min(1, (75 - spd(i0)) / 30)) : 1
      const now = Math.min(spd(i0) * skill * st.rubber * tyreK * packK, follow, wide, st.cap)
      let k = i0
      let ahead = 0
      while (ahead < Math.max(8, speed * 0.5)) ahead += line.ds[at(k++)]
      const later = Math.min(spd(at(k)) * skill * st.rubber * tyreK * packK, follow, st.cap)
      const need = (speed * speed - later * later) / (2 * ahead) // м/с², > 0 — тормозить
      const err = now - speed
      if (speed > now + 0.5 || need > 0.3 * maxDec) {
        input.throttle = 0
        input.brake = Math.max(0, Math.min(1, need / maxDec + (speed - now) * 0.3))
      } else {
        input.throttle = Math.max(0, Math.min(1, 0.6 + err * 0.4))
        input.brake = 0
      }
      // красный флаг: стоим (с нулём в качестве цели газ всё равно давал бы 60%)
      if (st.cap < 0.5) {
        input.throttle = 0
        input.brake = Math.max(input.brake, speed > 1 ? 0.7 : 0.4)
      }
      oppBrake = Math.max(oppBrake, st.oppBrake - 3 * dt)
      st.oppBrake = oppBrake
      if (oppBrake > input.brake) {
        input.brake = oppBrake
        input.throttle = 0
      }
      if (squeezeBy && lo > hi) input.throttle *= 0.5 // зажали с двух сторон — не лезем вперёд
      // аккуратнее с газом, когда зад буксует или болид идёт боком (так ведёт себя водитель, это не антипробуксовка)
      const vel = v.body.linvel()
      st.slip = speed > 5 ? Math.abs(Math.atan2(vel.x * lx + vel.z * lz, speed)) : 0
      if (v.wheels[2].sliding || v.wheels[3].sliding) input.throttle *= 0.4
      if (st.slip > 0.1) input.throttle *= 0.3

      // режим прямой и обгон: только на прямой с почти прямым рулём
      const straight = Math.abs(input.steer) < 0.15 && err > -2
      input.aeroZone = inZone
      input.aero = inZone && straight
      input.boost = L.boost && inZone && straight && v.battery > (st.mode === 'pass' || st.mode === 'follow' ? 0.15 : 0.4)

      st.stuck = speed < 3 ? st.stuck + dt : 0
      return input
    },
  }
}
