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
const FAST_LANE = 2 // м от оси пит-лейна в сторону от боксов (к трассе) — полоса проезда мимо боксов
const ENTRY = [16, 60] // точки оси пит-лейна (по 2 м), где болид считается въехавшим (раньше — узкий клин у края трассы: ложные въезды)
// Marina Bay (Рома 30.10: «срезал — и меня заставило заехать в боксы, а круг был лучший»): пит-лейн идёт вдоль стартовой
// прямой, и зона въезда начиналась в 0,2–0,4 м за белой линией — вышел колёсами за линию, и автопилот уводил в боксы.
// Теперь въезд — только по самому пит-лейну (не дальше ENTRY_HALF от его оси) и не ближе ENTRY_CLEAR за белой линией трассы
const ENTRY_HALF = 2.2 // м
const ENTRY_CLEAR = 2.5 // м
const ENTRY_SPAN = 45 // точек (90 м): длина зоны въезда от места, где пит-лейн ушёл за белую линию
const STOP_DECEL = 4 // м/с² — мягкая остановка в боксе
const ENTRY_DECEL = 9 // м/с² — торможение до 80 к линии ограничителя
const AUTO_RELEASE = 2 // с: не нажал газ — механик выпускает сам (с потерей)
const AUTO_RELEASE_PLAYER = 1 // с: игрок на автопилоте — выпуск сам, газ выпускает раньше
const AUTO_HANDBACK = 15 // м после конца ограничителя: автопилот отдаёт управление игроку
const PARK = 35 // м до бокса: дальше игра ставит болид игрока в бокс сама
// подъезд к въезду по трассе (Marina Bay, 30.10): автопилот берёт руль за 25–100 м до начала пит-лейна и раньше целился
// прямо в его начало — на LUMEN RING это было по траве, а у Марины въезд сразу за последним поворотом, и прямая срезала
// поворот через внутреннюю стену (боты и игрок разбивались). Теперь до въезда он едет по оси трассы, смещаясь к стороне
// пит-лейна: к началу пит-лейна — на APPROACH_LAT его смещения от оси (стена внутри кончается у самого въезда)
// и скорость по поворотам трассы до въезда: у Марины перед въездом поворот радиусом 25 м, а «80 к линии ограничителя»
// вело в него на 75–80 км/ч — болид проезжал поворот прямо в наружную стену (без стен уходил на траву)
const APPROACH_LAT = 0.65
const APPROACH_FROM = 200 // м до въезда по трассе, с которых работает подъезд
const APPROACH_MU = 1.1 // запас сцепления в повороте на подъезде (на малой скорости прижима почти нет)
const APPROACH_DECEL = 7 // м/с² — торможение к повороту

// trackAxis — ось трассы (circuit.js → track.axis): по ней автопилот подъезжает к въезду; без неё — прямо на начало пит-лейна
export function createPitLane(pit, trackAxis = null) {
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
  // въезд на оси трассы: где пит-лейн отделяется и насколько он в стороне (влево по ходу — плюс)
  let track = null
  if (trackAxis?.length) {
    const ta = trackAxis
    const tn = ta.length
    let ti = 0
    let bd = Infinity
    ta.forEach((t, i) => {
      const d = (t.x - a[0].x) ** 2 + (t.z - a[0].z) ** 2
      if (d < bd) {
        bd = d
        ti = i
      }
    })
    const left = (i) => {
      const p = ta[(i - 1 + tn) % tn]
      const q = ta[(i + 1) % tn]
      const len = Math.hypot(q.x - p.x, q.z - p.z) || 1
      return [(q.z - p.z) / len, -(q.x - p.x) / len]
    }
    const [lx, lz] = left(ti)
    // радиус оси трассы в каждой точке (по точкам через 10 м) — для скорости на подъезде
    const radius = new Float64Array(tn)
    for (let i = 0; i < tn; i++) {
      const p = ta[(i - 5 + tn) % tn]
      const q = ta[i]
      const s = ta[(i + 5) % tn]
      const ab = Math.hypot(q.x - p.x, q.z - p.z)
      const bc = Math.hypot(s.x - q.x, s.z - q.z)
      const ca = Math.hypot(p.x - s.x, p.z - s.z)
      const area = Math.abs((q.x - p.x) * (s.z - p.z) - (s.x - p.x) * (q.z - p.z)) / 2
      radius[i] = area < 1e-6 ? 1e6 : (ab * bc * ca) / (4 * area)
    }
    track = { axis: ta, n: tn, entryTi: ti, entryS: ta[ti].distance_m, entryLat: (a[0].x - ta[ti].x) * lx + (a[0].z - ta[ti].z) * lz, len: ta[tn - 1].distance_m + 2, left, radius }
  }
  // полоса проезда — по другую сторону оси от боксов: у LUMEN RING боксы справа от оси (−2,9 м), у Marina Bay слева (+2,9),
  // и полоса «влево на 2 м» шла прямо через боксы — болид в боксе перегораживал её, едущие мимо в него врезались
  const fast = boxes.length && boxes.reduce((s, b) => s + b.off, 0) > 0 ? -FAST_LANE : FAST_LANE
  // зона въезда (Рома 31.10 на Спа: «триггер не активировался, не пустило в боксы»): у Спа пит-лейн отходит от трассы прямо
  // с асфальта и только к ~86 м уходит за белую линию на ENTRY_CLEAR — постоянное окно точек 16…60 оставляло 34 м, свернул чуть
  // не так — въезд не засчитан. Теперь окно своё у каждой трассы: с первой точки, где пит-лейн уже за линией, и ENTRY_SPAN точек дальше
  let entry = ENTRY
  if (track) {
    const ta = track.axis
    for (let i = ENTRY[0]; i < n - 2; i++) {
      let bd = Infinity
      let bi = 0
      for (let k = 0; k < ta.length; k++) {
        const d = (ta[k].x - a[i].x) ** 2 + (ta[k].z - a[i].z) ** 2
        if (d < bd) {
          bd = d
          bi = k
        }
      }
      const half = Math.max(ta[bi].width_left ?? (ta[bi].width ?? 12) / 2, ta[bi].width_right ?? (ta[bi].width ?? 12) / 2)
      if (Math.sqrt(bd) > half + ENTRY_CLEAR + 0.3) {
        entry = [Math.max(ENTRY[0], i - 2), Math.min(n - 2, Math.max(ENTRY[1], i + ENTRY_SPAN))]
        break
      }
    }
  }
  return { axis: a, n, nx, nz, boxes, fast, limitStart: pit.limitStart, limitEnd: pit.limitEnd, length: a[n - 1].distance_m, nearestIdx, near, track, entry }
}

// болид въехал в пит-лейн: рядом с началом оси пит-лейна и едет по ней
export function pitEntryHit(lane, x, z, yaw) {
  const [e0, e1] = lane.entry ?? ENTRY
  const { i, d } = lane.nearestIdx(x, z, e0, e1)
  if (i <= e0 || i >= e1 - 1) return false
  const p = lane.axis[i]
  const q = lane.axis[i + 1]
  const along = Math.sin(yaw) * (q.x - p.x) + Math.cos(yaw) * (q.z - p.z)
  // ширина: у LUMEN RING в точке `width`, у Marina Bay `width_left`/`width_right` (въезд расширяется от 0 до 13 м)
  const width = p.width ?? (p.width_left != null ? p.width_left + p.width_right : 6)
  if (!(d < Math.min(width / 2, ENTRY_HALF) + 0.3 && along > 0.5)) return false
  // от трассы: центр болида должен быть заметно за её белой линией — свернул в пит-лейн, а не вылетел за линию
  const t = lane.track
  if (!t) return true
  let bi = 0
  let bd = Infinity
  for (let k = 0; k < t.n; k++) {
    const dd = (t.axis[k].x - x) ** 2 + (t.axis[k].z - z) ** 2
    if (dd < bd) {
      bd = dd
      bi = k
    }
  }
  const a = t.axis[bi]
  const half = Math.max(a.width_left ?? (a.width ?? 12) / 2, a.width_right ?? (a.width ?? 12) / 2)
  return Math.sqrt(bd) > half + ENTRY_CLEAR
}

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

// plan: { compound, wing } — что делать в боксе; opts: { player, auto, rand, T, damage, hold, drive } (hold() — пока true, из бокса не
// выпускают: красный флаг; drive — штраф «проезд по пит-лейну»: весь пит-лейн по быстрой полосе с ограничителем, в бокс не заезжает)
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
    drive: !!opts.drive,
  }
  // hold — стоим на тормозе без заднего хода: без него тормоз на месте включал задний ход и болид в боксе ехал назад
  const input = { throttle: 0, brake: 0, steer: 0, handbrake: false, aero: false, aeroZone: false, abs: true, ersMode: 'balanced', boost: false, hold: true }
  const manual = !!opts.player && !opts.auto // старый режим: игрок едет по пит-лейну сам

  // сдвиг от оси пит-лейна в точке s: въезд по оси → быстрая полоса → бокс → полоса → выезд по оси
  function offsetAt(s) {
    // в полосу проезда — не сразу: у Марины пит-уолл на въезде в 1,3 м от оси (отходит на 6 м только к ~100 м),
    // на выезде снова сходится; сразу на 2 м в сторону — болид бился о его начало
    const fast = (lane.fast ?? FAST_LANE) * Math.min(smooth((s - 40) / 50), 1 - smooth((s - (lane.length - 60)) / 40))
    if (s < lane.limitStart) return fast * smooth((s - (lane.limitStart - 40)) / 40)
    if (s > lane.limitEnd) return fast * (1 - smooth((s - lane.limitEnd) / 40))
    const toBox = opts.drive ? 0 : st.phase === 'in' ? smooth((s - (box.s - 30)) / 30) : 1 - smooth((s - box.s) / 25)
    return fast + (box.off - fast) * Math.max(0, Math.min(1, toBox))
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
      // первый шаг — по всей зоне въезда: свернул в него позже (у Спа зона въезда до ~176 м) — иначе ближайшей была бы точка 40,
      // болид «далеко от пит-лейна», и автопилот сразу отменялся (Рома 31.10: «не пустило в боксы»)
      const near = st.located ? lane.nearestIdx(p.x, p.z, st.idx - 5, st.idx + 40) : lane.nearestIdx(p.x, p.z, 0, (lane.entry ?? ENTRY)[1] + 5)
      st.located = true
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
        if (opts.drive) {
          // проезд: за линией ограничителя — сразу выезд (80 до конца зоны), без остановки
          if (st.s >= lane.limitStart) st.phase = 'out'
        } else vt = Math.min(vt, Math.sqrt(2 * STOP_DECEL * Math.max(0, box.s - st.s - 0.3)))
        if (!opts.drive && st.s >= box.s - 1.5 && speed < 0.6) {
          st.phase = 'service'
          st.t = 0
        }
      } else {
        vt = st.s <= lane.limitEnd ? PIT_SPEED : 60
        if (st.s >= lane.length - 30 || (opts.auto && st.s > lane.limitEnd + AUTO_HANDBACK)) st.phase = 'done'
      }

      // руль: точка на линии пит-лейна впереди; ещё до въезда — точка на трассе со смещением к стороне пит-лейна
      const look = 4 + 0.3 * speed
      let j = near.i
      while (j < lane.n - 1 && lane.axis[j].distance_m - st.s < look) j++
      const off = offsetAt(lane.axis[j].distance_m)
      let gx = lane.axis[j].x + off * lane.nx[j]
      let gz = lane.axis[j].z + off * lane.nz[j]
      let approachCap = Infinity
      const tr = lane.track
      if (tr && st.phase === 'in' && near.i < 3) {
        let ti = tr.entryTi
        let bd = Infinity
        for (let k = -110; k <= 5; k++) {
          const i = (tr.entryTi + k + tr.n) % tr.n
          const d = (tr.axis[i].x - p.x) ** 2 + (tr.axis[i].z - p.z) ** 2
          if (d < bd) {
            bd = d
            ti = i
          }
        }
        const rem = (tr.entryS - tr.axis[ti].distance_m + tr.len) % tr.len
        if (rem > 6 && rem < APPROACH_FROM) {
          const k = (ti + Math.max(1, Math.round(look / 2))) % tr.n
          const [lx, lz] = tr.left(k)
          // к стороне пит-лейна плавно; если болид уже ближе к ней — к середине не тянем
          const side = Math.sign(tr.entryLat)
          const goal = Math.abs(tr.entryLat) * APPROACH_LAT
          const [cx, cz] = tr.left(ti)
          const now = side * ((p.x - tr.axis[ti].x) * cx + (p.z - tr.axis[ti].z) * cz)
          const lat = side * Math.max(goal * smooth(1 - (rem - 10) / 70), Math.min(now, goal))
          gx = tr.axis[k].x + lat * lx
          gz = tr.axis[k].z + lat * lz
          // скорость: успеть оттормозиться к каждому повороту до въезда
          for (let d = 0, i = ti; d < rem + 10; d += 2, i = (i + 1) % tr.n) {
            const vc = Math.sqrt(APPROACH_MU * G * tr.radius[i])
            approachCap = Math.min(approachCap, Math.sqrt(vc * vc + 2 * APPROACH_DECEL * d))
          }
        }
      }
      const tx = gx - p.x
      const tz = gz - p.z
      const alpha = Math.atan2(tx * lx + tz * lz, tx * fx + tz * fz)
      const delta = Math.atan((2 * T.wheelBase * Math.sin(alpha)) / look)
      const aLim = T.tireMu * G * (1 + (v.aeroK * speed * speed) / (T.mass * G))
      const maxA = Math.min(T.steerLock, Math.atan((T.wheelBase * aLim) / Math.max(speed * speed, 1)) + T.steerSlipMargin)
      input.steer = Math.sign(delta) * Math.pow(Math.min(1, Math.abs(delta) / maxA), 1 / T.steerCurve)

      vt = Math.min(vt, approachCap)
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
