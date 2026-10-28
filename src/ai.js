// ИИ-водитель. Бот ездит на той же физике, что и игрок: он только «жмёт педали и крутит руль» —
// выдаёт тот же набор ввода { throttle, brake, steer, aero, boost… }. Без Three.js, проверяется в Node.
//
// 1) Гоночная линия: ось трассы сглаживается в пределах ширины — линия срезает повороты (вход снаружи,
//    апекс внутри, выход снаружи). Уровень решает, насколько бот уходит от середины к этой линии.
// 2) Скорость: в каждой точке — предел по сцеплению (шина + прижим), затем проход с конца назад:
//    успеть оттормозиться к следующему повороту. Уровень — какая доля сцепления и тормозов используется.
// 3) Руль: «погоня за точкой» — точка на линии впереди (дальше на скорости), угол колёс — чтобы попасть в неё.
// 4) Обгон: болид впереди и медленнее — уходит в сторону, где больше места; места нет — держит его скорость.
// 5) Соседи: бот не лезет на линию поверх болида сбоку — держит дистанцию, линия ждёт, пока станет свободно.
//    Так и старт выходит сам собой: с решётки едут рядами и расходятся по мере того, как растягиваются.
// 6) Защита: догоняют сзади на прямой — одно перестроение навстречу, держит до конца атаки;
//    соперник уже рядом сбоку — не дёргается, чтобы не зажать.
// 7) Пилоты, как в F1 25: у каждого свои рейтинги (makePilots) — темп по номеру 1…N (1 — предел уровня,
//    каждый следующий на 0,5% медленнее), своя траектория (насколько срезает), тормоза, взгляд вперёд,
//    агрессия (как охотно закрывается). Уровень сложности сдвигает всех разом.
import { TUNING } from './tuning.js'
import { tyreGrip } from './wear.js'

const G = 9.81

export const AI_LEVELS = {
  light: { name: 'Лёгкие', grip: 0.8, brake: 0.7, line: 0.5, look: 1.15, ers: 'balanced', boost: false, defend: false },
  medium: { name: 'Средние', grip: 0.91, brake: 0.85, line: 0.85, look: 1.05, ers: 'balanced', boost: true, defend: true },
  hard: { name: 'Сложные', grip: 1, brake: 1, line: 1, look: 1, ers: 'hotlap', boost: true, defend: true },
}

const MARGIN = 1.5 // м от белой линии края до центра болида на гоночной линии
const CAR_W = 2.1 // ширина болида с запасом, м

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
  const ds = new Float64Array(n) // расстояние до следующей точки
  for (let i = 0; i < n; i++) ds[i] = Math.hypot(x[at(i + 1)] - x[i], z[at(i + 1)] - z[i]) || 0.1

  // скорость: предел в повороте по сцеплению с прижимом, mv²κ = μ(v)·(mg + k·v²).
  // μ(v) подогнано по замеру нашей физики : на 60 км/ч ≈1,40,
  // на 250 ≈1,21 — чем сильнее прижим, тем ниже коэффициент шины
  const k = T.downforceK
  const m = T.mass
  const mu = (v) => T.tireMu * 0.84 * L.grip * (pilot.pace ?? 1) * Math.pow(1 + (k * v * v) / (m * G), -T.loadSensitivity * 1.24)
  const vMax = 95
  const speed = new Float64Array(n)
  const R = 5 // точки по бокам для кривизны (10 м)
  for (let i = 0; i < n; i++) {
    const ax = x[at(i - R)]
    const az = z[at(i - R)]
    const bx = x[i]
    const bz = z[i]
    const qx = x[at(i + R)]
    const qz = z[at(i + R)]
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
  const brakeAcc = (v) => Math.min(T.brakeForce / m, mu(v) * (G + (k * v * v) / m)) * L.brake * (pilot.brake ?? 1) + (T.dragK * v * v) / m
  for (let pass = 0; pass < 2; pass++) {
    for (let j = n - 1; j >= 0; j--) {
      const nv = speed[at(j + 1)]
      speed[j] = Math.min(speed[j], Math.sqrt(nv * nv + 2 * brakeAcc(nv) * ds[j]))
    }
  }

  return { n, x, z, off, nx, nz, wl, wr, speed, ds, brakeAcc, level: levelKey, pilot }
}

// Водитель. line — из createRaceLine; opts: { skill (≈1, разброс между ботами), idx (точка старта), zone (зоны режима прямой) }
export function createAiDriver(line, opts = {}) {
  const L = AI_LEVELS[line.level]
  const T = opts.T || TUNING
  const skill = opts.skill ?? 1
  const pilot = line.pilot || {}
  const defends = L.defend && (pilot.aggression ?? 1) > 0.3
  const n = line.n
  const at = (i) => ((i % n) + n) % n
  const st = { idx: opts.idx ?? 0, offset: 0, passSide: 0, stuck: 0, dist: 0, slip: 0, lost: opts.idx == null, placed: false, defend: null }
  const input = { throttle: 0, brake: 0, steer: 0, handbrake: false, aero: false, aeroZone: true, abs: true, ersMode: L.ers, boost: false }

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

  return {
    state: st,
    input,

    // точка старта/возврата на трассу: искать заново по всему кругу
    reset(idx) {
      if (idx != null) st.idx = idx
      st.offset = 0
      st.passSide = 0
      st.stuck = 0
      st.lost = true
      st.placed = false
      st.defend = null
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
      if (!st.placed) {
        st.offset = (p.x - line.x[near.i]) * line.nx[near.i] + (p.z - line.z[near.i]) * line.nz[near.i]
        st.placed = true
      }
      const inZone = opts.zone ? opts.zone[near.i] === 1 : true

      // обгон: болид впереди в нашем коридоре — уйти в сторону; вплотную и медленнее — держать его скорость
      let follow = Infinity
      let wantSide = 0
      let attack = null // сдвиг догоняющего сзади (влево +)
      let alongside = false
      let push = 0 // соседи сбоку отталкивают: не лезть на линию поверх них
      for (const o of others) {
        const dx = o.x - p.x
        const dz = o.z - p.z
        const f = dx * fx + dz * fz
        const l = dx * lx + dz * lz
        if (f > -8 && f < 3 && Math.abs(l) < CAR_W + 1.5) alongside = true
        if (f > -10 && f < 10 && Math.abs(l) > 0.3 && Math.abs(l) < CAR_W + 1.6) push -= Math.sign(l) * (CAR_W + 1.6 - Math.abs(l))
        if (f <= -8 && f > -30 && Math.abs(l) < 7 && o.speed - speed > 1.5 && (attack === null || Math.abs(l) < Math.abs(attack))) attack = l
        if (f < -2 || f > 32 || Math.abs(l) > CAR_W + 0.6) continue
        const closing = speed - o.speed
        if (closing > -2) wantSide = st.passSide || (l >= 0 ? -1 : 1)
        // почти стоящий впереди (авария, разворот) — не вставать за ним, а объезжать (сторону выбирает wantSide)
        if (f < 12 && Math.abs(l) < CAR_W && closing > 0 && o.speed > 8) follow = Math.min(follow, o.speed - 0.5 + Math.max(0, f - 6) * 0.4)
      }
      st.passSide = wantSide
      const i0 = st.idx
      // сдвиг от линии в пределах асфальта
      const room = (side) => (side > 0 ? line.wl[i0] - MARGIN + 0.6 - line.off[i0] : line.wr[i0] - MARGIN + 0.6 + line.off[i0])
      const lim = (o) => Math.max(-Math.max(0, room(-1)), Math.min(Math.max(0, room(1)), o))
      // по умолчанию — на свою линию; сосед сбоку — держать дистанцию от него
      let want = push ? st.offset + push : 0
      if (wantSide) want = wantSide * Math.min(3.2, Math.max(0, room(wantSide)))
      else if (defends && inZone && attack !== null) {
        if (st.defend === null) st.defend = lim(st.offset + attack) // одно перестроение навстречу
        want = st.defend
      }
      if (attack === null) st.defend = null
      if (alongside && !wantSide) want = st.offset // рядом сбоку — держать свою полосу
      st.offset += Math.max(-2.5 * dt, Math.min(2.5 * dt, lim(want) - st.offset))

      // руль: точка на линии впереди
      const look = (6 + 0.32 * speed) * L.look * (pilot.look ?? 1)
      let j = i0
      for (let acc = 0; acc < look; j++) acc += line.ds[at(j)]
      j = at(j)
      const tx = line.x[j] + st.offset * line.nx[j] - p.x
      const tz = line.z[j] + st.offset * line.nz[j] - p.z
      const alpha = Math.atan2(tx * lx + tz * lz, tx * fx + tz * fz)
      const delta = Math.atan((2 * T.wheelBase * Math.sin(alpha)) / look)
      const aLim = T.tireMu * G * (1 + (v.aeroK * speed * speed) / (T.mass * G))
      const maxA = Math.min(T.steerLock, Math.atan((T.wheelBase * aLim) / Math.max(speed * speed, 1)) + T.steerSlipMargin)
      input.steer = Math.sign(delta) * Math.pow(Math.min(1, Math.abs(delta) / maxA), 1 / T.steerCurve)

      // шины: холодные, стёртые, перегретые или проколотые держат хуже — бот едет медленнее, как живой
      // (скорость в повороте ∝ √сцепления; профиль посчитан на номинальную шину)
      let tg = 1
      if (v.wearOn) {
        tg = 0
        for (let i = 0; i < 4; i++) tg += tyreGrip(v.tyres[i], v.compound) / 4
      }
      const tyreK = Math.sqrt(Math.min(1.04, tg))
      // педали: скорость по профилю здесь и замедление, нужное, чтобы к точке впереди выйти на её скорость
      const now = Math.min(line.speed[i0] * skill * tyreK, follow)
      let k = i0
      let ahead = 0
      while (ahead < Math.max(8, speed * 0.5)) ahead += line.ds[at(k++)]
      const later = Math.min(line.speed[at(k)] * skill * tyreK, follow)
      const need = (speed * speed - later * later) / (2 * ahead) // м/с², > 0 — тормозить
      const maxDec = line.brakeAcc(speed)
      const err = now - speed
      if (speed > now + 0.5 || need > 0.3 * maxDec) {
        input.throttle = 0
        input.brake = Math.max(0, Math.min(1, need / maxDec + (speed - now) * 0.3))
      } else {
        input.throttle = Math.max(0, Math.min(1, 0.6 + err * 0.4))
        input.brake = 0
      }
      // аккуратнее с газом, когда зад буксует или болид идёт боком (так ведёт себя водитель, это не антипробуксовка)
      const vel = v.body.linvel()
      st.slip = speed > 5 ? Math.abs(Math.atan2(vel.x * lx + vel.z * lz, speed)) : 0
      if (v.wheels[2].sliding || v.wheels[3].sliding) input.throttle *= 0.4
      if (st.slip > 0.1) input.throttle *= 0.3

      // режим прямой и обгон: только на прямой с почти прямым рулём
      const straight = Math.abs(input.steer) < 0.15 && err > -2
      input.aeroZone = inZone
      input.aero = inZone && straight
      input.boost = L.boost && inZone && straight && v.battery > (wantSide ? 0.15 : 0.4)

      st.stuck = speed < 3 ? st.stuck + dt : 0
      return input
    },
  }
}
