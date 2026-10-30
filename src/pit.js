// Пит-стоп. Игрок по пит-лейну едет сам (Рома 28.10: «почему машина сама едет»), в зоне — ограничитель 80 км/ч
// (pitLimiter); игра берёт руль только на последние ~35 м до бокса, чтобы ровно поставить болид, потом
// обслуживание и выпуск газом по зелёному (чем быстрее реакция, тем меньше потеря) — и управление сразу снова у игрока.
// Боты проходят пит-лейн целиком на автомате, выпуск у них — с короткой случайной задержкой.
// Ось пит-лейна, боксы и зона ограничителя — из модели трассы (circuit.js → track.pit). Без Three.js.
//
// Фазы игрока с автопилотом (opts.auto, Рома 29.10: «на пит-стопе можно отдохнуть, просто подожди»): in → service →
// release (механик выпускает сам через ~1 с, газ — раньше) → out (едет сам, ограничитель до конца зоны) → done: управление
// возвращается за ~15 м до конца ограничителя. Без auto (старый режим): lane (едет сам до бокса) → in (игра ставит в бокс) →
// service → release (ждём газ) → free → done. Боты: in → service → release → out → done.
// abort — болид ушёл от пит-лейна дальше 12 м или стоит дольше 6 с: управление сразу возвращается.
import { TUNING } from './tuning.js'
import { COMPOUNDS, freshTyres, BLANKET, repairSeconds, needsRepair, applyRepair } from './wear.js'

const G = 9.81
export const PIT_SPEED = 80 / 3.6
const FAST_LANE = 2 // м влево от оси пит-лейна (к трассе) — полоса проезда мимо боксов
const ENTRY = [12, 45] // точки оси пит-лейна, где болид считается въехавшим (раньше — узкий клин у края трассы: ложные въезды)
const STOP_DECEL = 4 // м/с² — мягкая остановка в боксе
const ENTRY_DECEL = 9 // м/с² — торможение до 80 к линии ограничителя
const AUTO_RELEASE = 2 // с: не нажал газ — механик выпускает сам (с потерей)
const AUTO_RELEASE_PLAYER = 1 // с: игрок на автопилоте — выпуск сам, газ выпускает раньше
const AUTO_HANDBACK = 15 // м после конца ограничителя: автопилот отдаёт управление игроку
const PARK = 35 // м до бокса: дальше игра ставит болид игрока в бокс сама

export function createPitLane(pit) {
  const a = pit.axis
  const n = a.length
  const nx = new Float64Array(n)
  const nz = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const p = a[Math.max(0, i - 1)]
    const q = a[Math.min(n - 1, i + 1)]
    const len = Math.hypot(q.x - p.x, q.z - p.z) || 1
    nx[i] = (q.z - p.z) / len // нормаль влево по ходу
    nz[i] = -(q.x - p.x) / len
  }
  const nearestIdx = (x, z, from = 0, to = n) => {
    let bi = from
    let bd = Infinity
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) {
      const d = (a[i].x - x) ** 2 + (a[i].z - z) ** 2
      if (d < bd) {
        bd = d
        bi = i
      }
    }
    return { i: bi, d: Math.sqrt(bd) }
  }
  // бокс: где он на оси и насколько в сторону
  const boxes = pit.boxes.map((b) => {
    const { i } = nearestIdx(b.x, b.z)
    return { s: a[i].distance_m, off: (b.x - a[i].x) * nx[i] + (b.z - a[i].z) * nz[i] }
  })
  // точка в пит-лейне или в margin м от его края (вдоль всей оси, включая въезд и выезд)
  const near = (x, z, margin = 0) => {
    const { i, d } = nearestIdx(x, z)
    return d < (a[i].width ?? 6) / 2 + margin
  }
  return { axis: a, n, nx, nz, boxes, limitStart: pit.limitStart, limitEnd: pit.limitEnd, length: a[n - 1].distance_m, nearestIdx, near }
}

// болид въехал в пит-лейн: рядом с началом оси пит-лейна и едет по ней
export function pitEntryHit(lane, x, z, yaw) {
  const { i, d } = lane.nearestIdx(x, z, ENTRY[0], ENTRY[1])
  if (i <= ENTRY[0] || i >= ENTRY[1] - 1) return false
  const p = lane.axis[i]
  const q = lane.axis[i + 1]
  const along = Math.sin(yaw) * (q.x - p.x) + Math.cos(yaw) * (q.z - p.z)
  // ширина: у LUMEN RING в точке `width`, у Marina Bay `width_left`/`width_right` (въезд расширяется от 0 до 13 м)
  const width = p.width ?? (p.width_left != null ? p.width_left + p.width_right : 6)
  return d < width / 2 + 0.3 && along > 0.5
}

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

// plan: { compound, wing } — что делать в боксе; opts: { player, auto, rand, T, damage, hold } (hold() — пока true, из бокса не выпускают: красный флаг)
export function createPitStop(lane, boxIndex, plan, opts = {}) {
  const damage = opts.damage // повреждения болида на въезде: от них зависит, сколько стоим
  const T = opts.T || TUNING
  const rand = opts.rand || Math.random
  const box = lane.boxes[boxIndex % lane.boxes.length]
  const st = {
    phase: opts.player && !opts.auto ? 'lane' : 'in',
    s: 0,
    idx: 0,
    t: 0, // время в фазе
    // стоим дольше, чем больше надо чинить (у каждой части свои секунды, см. wear.js REPAIR); без повреждений — просто шины
    service: 2 + rand() * 0.8 + (plan.wing ? (damage ? repairSeconds(damage) : 6.5) : 0),
    reaction: null, // реакция игрока на выпуск, с
    total: 0, // всё время в пит-лейне
    plan,
  }
  // hold — стоим на тормозе без заднего хода: без него тормоз на месте включал задний ход и болид в боксе ехал назад
  const input = { throttle: 0, brake: 0, steer: 0, handbrake: false, aero: false, aeroZone: false, abs: true, ersMode: 'balanced', boost: false, hold: true }
  const manual = !!opts.player && !opts.auto // старый режим: игрок едет по пит-лейну сам

  // сдвиг от оси пит-лейна в точке s: въезд по оси → быстрая полоса → бокс → полоса → выезд по оси
  function offsetAt(s) {
    if (s < lane.limitStart) return FAST_LANE * smooth((s - (lane.limitStart - 40)) / 40)
    if (s > lane.limitEnd) return FAST_LANE * (1 - smooth((s - lane.limitEnd) / 40))
    const toBox = st.phase === 'in' ? smooth((s - (box.s - 30)) / 30) : 1 - smooth((s - box.s) / 25)
    return FAST_LANE + (box.off - FAST_LANE) * Math.max(0, Math.min(1, toBox))
  }

  return {
    state: st,
    input,
    get inLimit() {
      return st.s >= lane.limitStart && st.s <= lane.limitEnd
    },
    // какая скорость сейчас ещё позволяет успеть сбросить до 80 к линии ограничителя
    get entryCap() {
      return st.s < lane.limitStart ? Math.sqrt(PIT_SPEED ** 2 + 2 * ENTRY_DECEL * Math.max(0, lane.limitStart - 15 - st.s)) : PIT_SPEED
    },

    // v — болид, go — игрок жмёт газ (для выпуска)
    update(v, dt, go = false) {
      st.t += dt
      st.total += dt
      const p = v.body.translation()
      const q = v.body.rotation()
      const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
      const fx = Math.sin(yaw)
      const fz = Math.cos(yaw)
      const lx = Math.cos(yaw)
      const lz = -Math.sin(yaw)
      const speed = Math.max(0, v.state.fwdSpeed)
      const near = lane.nearestIdx(p.x, p.z, st.idx - 5, st.idx + 40)
      st.idx = near.i
      st.s = lane.axis[near.i].distance_m
      // игрок едет сам: до своего бокса и после выпуска (ограничитель — pitLimiter); null — «управляет игрок»
      if (st.phase === 'lane' || st.phase === 'free') {
        if (st.idx >= ENTRY[0] && near.d > 12) st.phase = 'abort'
        else if (st.phase === 'lane' && st.s >= box.s - PARK && st.s < box.s + 3 && near.d < 8) st.phase = 'in'
        else if (st.phase === 'free' && (st.s > lane.limitEnd + 15 || st.s >= lane.length - 30)) st.phase = 'done'
        return st.phase === 'in' ? this.update(v, 0, go) : null
      }
      // страховка: болид не в пит-лейне или встал — отдать управление
      st.still = speed < 1 && (st.phase === 'in' || st.phase === 'out') && !(st.phase === 'in' && st.s >= box.s - 3) ? (st.still || 0) + dt : 0
      // (боты начинают заезд ещё на трассе, за 25–100 м до въезда — там далеко от оси пит-лейна, это нормально)
      if ((st.idx >= ENTRY[0] && near.d > 12) || near.d > 130 || st.still > 6) {
        st.phase = 'abort'
        return input
      }

      input.aeroZone = false
      input.aero = false
      input.boost = false
      if (st.phase === 'service' || st.phase === 'release') {
        input.throttle = 0
        input.brake = 1
        input.steer = 0
        if (st.phase === 'service' && st.t >= st.service) {
          // механики закончили: новые шины, крыло
          v.compound = plan.compound
          v.tyres = freshTyres(BLANKET)
          if (plan.wing) applyRepair(v)
          st.phase = 'release'
          st.t = 0
          st.releaseDelay = manual ? null : opts.auto ? AUTO_RELEASE_PLAYER : 0.2 + rand() * 0.3
        } else if (st.phase === 'release') {
          const held = !!opts.hold?.()
          const ready = !held && (manual ? go || st.t >= AUTO_RELEASE : (opts.auto && go && st.t > 0.3) || st.t >= st.releaseDelay)
          if (ready) {
            st.reaction = st.t
            st.phase = manual ? 'free' : 'out'
            st.t = 0
          }
        }
        return input
      }

      // скорость по фазе
      let vt
      if (st.phase === 'in') {
        // к линии ограничителя — уже 80, с запасом 15 м (тормоза жмутся не мгновенно)
        vt = Math.sqrt(PIT_SPEED ** 2 + 2 * ENTRY_DECEL * Math.max(0, lane.limitStart - 15 - st.s)) - (st.s > lane.limitStart - 15 ? 1 : 0)
        vt = Math.min(vt, Math.sqrt(2 * STOP_DECEL * Math.max(0, box.s - st.s - 0.3)))
        if (st.s >= box.s - 1.5 && speed < 0.6) {
          st.phase = 'service'
          st.t = 0
        }
      } else {
        vt = st.s <= lane.limitEnd ? PIT_SPEED : 60
        if (st.s >= lane.length - 30 || (opts.auto && st.s > lane.limitEnd + AUTO_HANDBACK)) st.phase = 'done'
      }

      // руль: точка на линии пит-лейна впереди
      const look = 4 + 0.3 * speed
      let j = near.i
      while (j < lane.n - 1 && lane.axis[j].distance_m - st.s < look) j++
      const off = offsetAt(lane.axis[j].distance_m)
      const tx = lane.axis[j].x + off * lane.nx[j] - p.x
      const tz = lane.axis[j].z + off * lane.nz[j] - p.z
      const alpha = Math.atan2(tx * lx + tz * lz, tx * fx + tz * fz)
      const delta = Math.atan((2 * T.wheelBase * Math.sin(alpha)) / look)
      const aLim = T.tireMu * G * (1 + (v.aeroK * speed * speed) / (T.mass * G))
      const maxA = Math.min(T.steerLock, Math.atan((T.wheelBase * aLim) / Math.max(speed * speed, 1)) + T.steerSlipMargin)
      input.steer = Math.sign(delta) * Math.pow(Math.min(1, Math.abs(delta) / maxA), 1 / T.steerCurve)

      const err = vt - speed
      if (err > 0.3) {
        input.throttle = Math.min(1, 0.25 + err * 0.35)
        input.brake = 0
      } else if (err < -0.3) {
        input.throttle = 0
        input.brake = Math.min(1, -err * 0.35)
      } else {
        input.throttle = 0.12
        input.brake = 0
      }
      // ограничитель скорости в зоне: как у настоящего — мотор не даёт больше 80
      if (st.s >= lane.limitStart - 2 && st.s <= lane.limitEnd && speed > PIT_SPEED - 1.2) input.throttle = Math.min(input.throttle, 0.05)
      return input
    },
  }
}

// ограничитель скорости для игрока, который едет по пит-лейну сам: в зоне мотор не даёт больше 80;
// до линии подтормаживает, если иначе не успеть сбросить до 80 (вместо штрафа за превышение)
export function pitLimiter(ctl, v, input) {
  input.boost = false
  input.aero = false
  const speed = v.state.fwdSpeed
  // до линии: быстрее, чем успеешь оттормозиться к 80, — подтормаживает (рулишь сам)
  const cap = ctl.inLimit ? PIT_SPEED : ctl.state.phase === 'lane' ? ctl.entryCap : Infinity
  if (speed > cap - 1) input.throttle = 0
  if (speed > cap + 1) input.brake = Math.max(input.brake, Math.min(1, (speed - cap) * 0.2))
  return input
}

// план по умолчанию: другой состав (правило двух составов), крыло — если помято
// какие шины нужны на такой трассе: ливень — дождевые, влажно — промежуточные, иначе слики (null)
export const rainTyreFor = (wet) => (wet > 0.8 ? 'wet' : wet > 0.3 ? 'intermediate' : null)

export function defaultPlan(v, lapsLeft) {
  const cur = v.compound
  const rain = rainTyreFor(v.wet || 0)
  const onRain = cur === 'intermediate' || cur === 'wet'
  // в дождь — дождевые шины; трасса подсохла — снова слики (на короткий остаток — мягкие)
  const compound = rain ? rain : onRain ? (lapsLeft <= 3 ? 'soft' : 'medium') : cur === 'soft' ? (lapsLeft > 3 ? 'hard' : 'medium') : lapsLeft <= 3 ? 'soft' : cur === 'medium' ? 'hard' : 'medium'
  return { compound, wing: needsRepair(v.damage) }
}

export const compoundName = (c) => COMPOUNDS[c].name
