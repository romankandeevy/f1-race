// Гонка с ботами: круги, позиции, финиш. Без Three.js — проверяется в Node.
// Прогресс болида — пройденные круги и расстояние по оси трассы (distance_m ближайшей точки).
// Решётка стоит перед линией старта, поэтому первое пересечение линии — начало первого круга.
// Отставание от лидера — как в F1: сколько секунд назад лидер проезжал ту же точку (отметки каждые 20 м).
// Правила F1: за гонку обязательны два разных состава шин (иначе дисквалификация); отказ — сход.
// Классификация: финишировавшие → ещё едущие → сошедшие → дисквалифицированные.
export const RACE_LAPS = 5
// правило двух составов — с этой длины гонки (Рома 29.10: в гонке на один круг все боты «просто так» заехали в боксы):
// в короткой гонке пит-стоп ничего не даёт, кроме потери ~20 с; в спринте F1 его тоже нет. С 30.10 — с 5 кругов
// (Рома получил дисквалификацию в гонке на 3 круга: «что блять??»), и игра предупреждает об этом в гонке (main.js)
export const TWO_COMPOUND_MIN_LAPS = 5

// entries: [{ id, name, player, compound }] — порядок не важен
export function createRace(length, entries, laps = RACE_LAPS) {
  const st = {
    laps,
    running: false, // огни погасли — время идёт
    time: 0,
    cars: entries.map((e) => ({ ...e, lap: 0, s: 0, prevS: null, finished: false, finishTime: 0, progress: 0, gap: 0, penalty: 0, stops: 0, compounds: new Set(e.compound ? [e.compound] : []), dnf: false, dsq: false })),
    order: [], // болиды по местам
    playerDone: false,
  }
  const marks = new Map() // отметка трассы → когда её проехал первый болид

  // группа в классификации: 0 — финишировал, 1 — едет, 2 — сошёл, 3 — дисквалифицирован
  const group = (c) => (c.dsq ? 3 : c.dnf ? 2 : c.finished ? 0 : 1)
  const sortOrder = () => {
    st.order = st.cars.slice().sort((a, b) => {
      if (group(a) !== group(b)) return group(a) - group(b)
      if (a.finished && b.finished) return a.finishTime + a.penalty - (b.finishTime + b.penalty)
      return b.progress - a.progress
    })
  }

  return {
    state: st,
    go() {
      st.running = true
    },

    // sOf(car) — расстояние по оси трассы для болида, м
    update(dt, sOf) {
      if (st.running) st.time += dt
      for (const c of st.cars) {
        if (c.dnf) continue // сошедший стоит
        const s = sOf(c)
        // несколько кадров после новой расстановки не считаем пересечение линии: расстояние у водителей ещё прежнее
        if (c.settle > 0) {
          c.settle--
          c.prevS = null
        }
        if (c.prevS !== null) {
          if (c.prevS > length * 0.75 && s < length * 0.25) {
            c.lap++
            if (c.lap > st.laps && !c.finished && !c.dnf && st.running) {
              c.finished = true
              c.finishTime = st.time
              // правило двух составов
              if (st.laps >= TWO_COMPOUND_MIN_LAPS && c.compounds.size === 1 && !c.compounds.has('intermediate') && !c.compounds.has('wet')) c.dsq = true // в дождь правило двух составов не действует (как в F1)
              if (c.player) st.playerDone = true
            }
          } else if (c.prevS < length * 0.25 && s > length * 0.75) c.lap-- // проехал линию назад
        }
        c.prevS = s
        c.s = s
        c.progress = c.lap * length + s
        if (st.running && !c.finished) {
          const mark = Math.floor(c.progress / 20)
          if (!marks.has(mark)) marks.set(mark, st.time)
          c.gap = st.time - marks.get(mark)
        }
      }
      sortOrder()
      // финишировавшие — отставание по времени финиша
      const winner = st.order[0]
      for (const c of st.cars) if (c.finished && !c.dsq && winner.finished) c.gap = c.finishTime + c.penalty - (winner.finishTime + winner.penalty)
    },

    // новый старт с места после красного флага: у всех один круг (засчитанные круги лидера), дальше они идут по решётке в порядке гонки
    regrid(lap) {
      for (const c of st.cars) {
        if (c.dnf) continue
        c.lap = lap
        c.prevS = null
        c.settle = 4
      }
    },

    // штраф к итоговому времени (границы трассы), с
    addPenalty(id, seconds) {
      const c = st.cars.find((x) => x.id === id)
      if (c) c.penalty += seconds
    },

    // пит-стоп: новый состав засчитывается в правило двух составов
    pitStop(id, compound) {
      const c = st.cars.find((x) => x.id === id)
      if (!c) return
      c.stops++
      c.compounds.add(compound)
    },

    // сход (отказ мотора, разрушенный болид); если это игрок — гонка для него окончена
    retire(id, reason = '') {
      const c = st.cars.find((x) => x.id === id)
      if (!c || c.finished || c.dnf) return
      c.dnf = true
      c.reason = reason
      if (c.player) st.playerDone = true
    },

    // чёрный флаг: дисквалификация посреди гонки (небезопасный болид не заехал в боксы)
    disqualify(id, reason = '') {
      const c = st.cars.find((x) => x.id === id)
      if (!c || c.finished || c.dsq) return
      c.dsq = true
      c.dnf = true
      c.reason = reason
      if (c.player) st.playerDone = true
    },

    position: (id) => st.order.findIndex((c) => c.id === id) + 1,
    car: (id) => st.cars.find((c) => c.id === id),
  }
}
