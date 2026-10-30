// Флаги и нейтрализация гонки (Рома 29.10: «чтобы я был пилотом Формулы-1, точь-в-точь»): жёлтые флаги, виртуальная машина безопасности (VSC),
// машина безопасности (SC) и красный флаг. Без Three.js, проверяется в Node. Решения принимает main.js, ограничения скорости читают боты и игрок.
//
// Как в F1 (упрощённо): остановившийся сошедший болид — инцидент. Несошедший болид, который стоит вне боксов дольше STUCK_TIME
// (развернуло, упёрся в стену), — тоже инцидент (Рома 29.10: «ни разу не видел машину безопасности, если сам не сошёл»);
// поехал дальше — инцидент снят сам, без эвакуатора. Рядом с трассой — жёлтый флаг на участке и VSC; на асфальте — машина безопасности;
// два остановившихся на асфальте болида одновременно — красный флаг. Пока инцидент не убран эвакуатором, нейтрализация держится; потом ещё SC_END_TIME с — зелёный.
// Под флагами обгонять нельзя (штраф), под SC и VSC скорость ограничена всем.
// Красный флаг (Рома 29.10: «возврат в боксы и новый старт с места»): все едут медленно (RED_SPEED) в пит-лейн и встают в боксах — там меняют шины
// и чинят; когда встали все (или прошло RED_MAX), ещё RED_HOLD с, потом событие `restart`: main.js ставит болиды на решётку в порядке гонки
// и запускает огни старта. С машиной безопасности (opts.safetyCar) зелёный флаг — только когда SC зашла в боксы (`scHome()`).
export const SC_SPEED = 50 // м/с (~180 км/ч): машина безопасности (было 38 — Рома 30.10: «полтора круга на 130»; настоящая SC на прямых едет 200+)
export const VSC_SPEED = 33 // м/с (~119 км/ч): виртуальная
export const YELLOW_SPEED = 28 // м/с (~100 км/ч): боты проезжают жёлтый участок так
export const RED_SPEED = 30 // м/с (~108 км/ч): на красном флаге едут в боксы не быстрее
export const RED_MIN = 35 // с: красный флаг не короче
export const RED_HOLD = 15 // с: все встали в боксах — ещё столько ждём до старта
export const RED_MAX = 150 // с: не дождались всех — стартуем без них (они уже на пути)
export const SC_END_TIME = 5 // с: после уборки инцидента машина безопасности ещё едет, потом гасит огни и уходит
export const TOW_DELAY = 6 // с: сколько стоит болид, пока выедет эвакуатор
const YELLOW_BEFORE = 250 // м до инцидента — жёлтый
const YELLOW_AFTER = 40 // м после
const STOP_SPEED = 3 // м/с: ниже — стоит
const STOP_TIME = 1.5 // с стоит — инцидент
const STUCK_TIME = 5 // с стоит несошедший болид вне боксов — инцидент
const MOVING = 8 // м/с: несошедший болид поехал — его инцидент снят
const SC_DELAY = 3 // с с остановки на асфальте до машины безопасности

const clamp = (x, a, b) => Math.min(b, Math.max(a, x))

export function createFlags(axis, length, opts = {}) {
  const st = { mode: 'green', t: 0, incidents: [], redSince: 0, allInAt: 0, endAt: 0, needSc: !!opts.safetyCar, scHome: false }
  const stopT = new Map() // болид → сколько стоит
  const known = new Set() // болиды, по которым инцидент уже заведён

  const nearest = (x, z) => {
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < axis.length; i++) {
      const d = (axis[i].x - x) ** 2 + (axis[i].z - z) ** 2
      if (d < bd) {
        bd = d
        bi = i
      }
    }
    const a = axis[bi]
    // положение поперёк трассы: влево +
    const l = (x - a.x) * Math.cos(a.yaw) - (z - a.z) * Math.sin(a.yaw)
    return { s: a.distance_m, l, wl: a.width_left ?? 8, wr: a.width_right ?? 8 }
  }
  // расстояние вдоль трассы от s1 до s2 вперёд
  const ahead = (s1, s2) => (((s2 - s1) % length) + length) % length

  const active = () => st.incidents.filter((i) => !i.cleared)

  return {
    state: st,
    get mode() {
      return st.mode
    },
    get incidents() {
      return st.incidents
    },

    // cars: [{ id, x, z, speed, retired, inPit }] — раз в ~0,25 с. Возвращает события [{ type, text, inc? }].
    update(dt, cars) {
      st.t += dt
      const events = []
      for (const c of cars) {
        // несошедший болид поехал: его инцидент снят (эвакуатор не нужен)
        const live = st.incidents.find((i) => i.id === c.id && i.live && !i.cleared)
        if (live && !c.retired && c.speed > MOVING) {
          live.cleared = true
          known.delete(c.id)
          stopT.delete(c.id)
          continue
        }
        if (live && c.retired) live.live = false // стоял и сошёл — теперь за ним эвакуатор
        if (!c.inPit && c.speed < STOP_SPEED && !known.has(c.id)) {
          const t = (stopT.get(c.id) ?? 0) + dt
          stopT.set(c.id, t)
          if (t > (c.retired ? STOP_TIME : STUCK_TIME)) {
            const p = nearest(c.x, c.z)
            const inc = { id: c.id, s: p.s, l: p.l, onTrack: p.l < p.wl + 1 && p.l > -p.wr - 1, since: st.t, tow: false, cleared: false, live: !c.retired }
            st.incidents.push(inc)
            known.add(c.id)
            events.push({ type: 'incident', inc, text: inc.onTrack ? 'Болид остановился на трассе' : 'Болид остановился у трассы' })
          }
        } else if (!known.has(c.id)) stopT.delete(c.id)
      }
      // эвакуатор выезжает не сразу (и только за сошедшим)
      for (const i of active()) {
        if (!i.tow && !i.live && st.t - i.since > TOW_DELAY) {
          i.tow = true
          events.push({ type: 'tow', inc: i })
        }
      }
      const on = active().filter((i) => i.onTrack && st.t - i.since > SC_DELAY)
      const any = active().filter((i) => st.t - i.since > SC_DELAY)
      const set = (mode, text) => {
        if (st.mode === mode) return
        st.mode = mode
        if (mode === 'sc') st.scHome = false
        events.push({ type: mode, text })
      }
      if (st.mode === 'red') {
        // все, кто ещё в гонке, стоят в боксах — отсчёт до старта
        const racing = cars.filter((c) => !c.retired)
        // встали: в боксе (parked) либо, если водитель не знает фазы, в пит-лейне и почти не едет
        const allIn = racing.length > 0 && racing.every((c) => (c.parked ?? (c.inPit && c.speed < 1.5)) && c.speed < 1.5)
        if (allIn) st.allInAt = st.allInAt || st.t
        else st.allInAt = 0
        const ready = (st.allInAt && st.t - st.allInAt > RED_HOLD && st.t - st.redSince > RED_MIN) || st.t - st.redSince > RED_MAX
        if (ready) {
          for (const i of active()) i.cleared = true // красный флаг: трассу чистят вручную, остатки убраны
          events.push({ type: 'clear-all' })
          st.mode = 'green'
          st.endAt = 0
          st.allInAt = 0
          events.push({ type: 'restart', text: 'Старт с места: болиды на решётке' })
        }
      } else if (on.filter((i) => !i.live).length >= 2) {
        // красный — только за двумя сошедшими на асфальте: вставшие, но живые болиды (развернуло, затор) уедут сами
        st.redSince = st.t
        st.allInAt = 0
        set('red', 'Красный флаг: на трассе два остановившихся болида, гонка остановлена, все в боксы')
      } else if (on.length >= 1 && st.mode !== 'sc') set('sc', 'Машина безопасности: на трассе остановившийся болид, обгон запрещён')
      else if (any.length > 0 && st.mode === 'green') set('vsc', 'Виртуальная машина безопасности: болид у трассы, скорость ограничена')
      // инциденты убраны — машина безопасности ещё едет, потом зелёный
      if ((st.mode === 'sc' || st.mode === 'vsc') && active().length === 0) {
        if (!st.endAt) st.endAt = st.t + (st.mode === 'sc' ? SC_END_TIME : 6)
        // машина безопасности заходит в боксы в конце круга: пока она на трассе, зелёного нет (запас 200 с на случай сбоя)
        if (st.t > st.endAt && (!st.needSc || st.mode !== 'sc' || st.scHome || st.t > st.endAt + 200)) {
          st.endAt = 0
          st.mode = 'green'
          events.push({ type: 'green', text: 'Зелёный флаг: гонка продолжается' })
        }
      } else if (active().length > 0) st.endAt = 0
      return events
    },

    // эвакуатор забрал болид
    clear(id) {
      const i = st.incidents.find((x) => x.id === id)
      if (i) i.cleared = true
    },
    reset() {
      st.mode = 'green'
      st.t = 0
      st.incidents.length = 0
      st.redSince = 0
      st.allInAt = 0
      st.scHome = false
      st.endAt = 0
      stopT.clear()
      known.clear()
    },

    // красный флаг: { allIn — все встали в боксах, left — сколько секунд до старта (null, пока ждём остальных) }
    redInfo() {
      if (st.mode !== 'red') return null
      const left = st.allInAt ? Math.max(0, st.allInAt + RED_HOLD - st.t, st.redSince + RED_MIN - st.t) : null
      return { allIn: !!st.allInAt, left }
    },
    // машина безопасности заехала в боксы
    scHome() {
      st.scHome = true
    },
    // конец нейтрализации близко: машина безопасности «заходит в боксы»
    ending: () => (st.mode === 'sc' || st.mode === 'vsc') && active().length === 0 && st.endAt > 0,

    // участок s (расстояние по оси) в жёлтой зоне какого-то инцидента: за YELLOW_BEFORE до него и YELLOW_AFTER после
    inYellow(s) {
      return active().some((i) => ahead(s, i.s) <= YELLOW_BEFORE || ahead(i.s, s) <= YELLOW_AFTER)
    },
    // инцидент впереди, м (для табло); null — нет
    nextIncident(s) {
      let best = null
      for (const i of active()) {
        const d = ahead(s, i.s)
        if (d <= YELLOW_BEFORE && (best === null || d < best)) best = d
      }
      return best
    },

    // предельная скорость, м/с, для болида на участке s с зазором gapAhead (м) до болида впереди; Infinity — без ограничения.
    // Под SC болиды позади лидера могут ехать быстрее, пока не сомкнутся с колонной (до +20% при зазоре больше 85 м до ближайшего болида впереди по трассе) — иначе поле не собирается.
    // sc — для лидера: { gap — сколько метров до машины безопасности впереди, speed — её скорость }: нельзя её догнать
    cap(s, gapAhead = 0, sc = null) {
      if (st.mode === 'red') return RED_SPEED
      const bunch = 1 + 0.2 * clamp((gapAhead - 25) / 60, 0, 1) // догнать колонну: до +20% (при SC 180 км/ч — 216)
      if (st.mode === 'sc') {
        const c = SC_SPEED * bunch
        return sc ? Math.min(c, Math.max(0, sc.speed + (sc.gap - 35) * 0.35)) : c
      }
      if (st.mode === 'vsc') return VSC_SPEED
      return Infinity
    },
    // для ботов: жёлтый участок тоже ограничивает
    botCap(s, gapAhead = 0, sc = null) {
      const c = this.cap(s, gapAhead, sc)
      return this.inYellow(s) ? Math.min(c, YELLOW_SPEED) : c
    },
    // обгон запрещён: любая нейтрализация или жёлтый участок
    noPass: (s) => st.mode !== 'green' || active().some((i) => ahead(s, i.s) <= YELLOW_BEFORE || ahead(i.s, s) <= YELLOW_AFTER),
  }
}
