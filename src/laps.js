// Время круга: где болид на трассе (дистанция по оси), круги, секторы, лучший круг и дельта к нему.
// Ось трассы — точки каждые 2 м с distance_m. Круг засчитывается, только если болид проехал
// оба сектора по порядку и пересёк финиш вперёд. После возврата на трассу (R) текущий круг
// не считается: время пойдёт со следующего пересечения линии финиша. За границы трассы (limits.js)
// круг не отменяется: после трёх предупреждений к его времени добавляется штраф (addPenalty).
// Лучший круг, лучшие секторы и «профиль» лучшего круга (время в каждой точке оси) хранятся
// в браузере — по профилю считается дельта в любой точке круга.

const WINDOW = 40 // сколько точек оси вокруг прошлой искать ближайшую (быстро, без обхода всей оси)

export function createLaps(track, storeKey) {
  const axis = track.axis
  const N = axis.length
  const L = track.length
  const sectorD = track.sectors.filter((s) => /Сектор/.test(s.name)).map((s) => s.distance_m).sort((a, b) => a - b)

  let saved = null
  try {
    saved = JSON.parse(localStorage.getItem(storeKey) || 'null')
  } catch {
    saved = null
  }

  const st = {
    lap: 0, // номер текущего круга (0 — ещё не пересёк старт)
    running: false,
    lapTime: 0,
    lastLap: null,
    bestLap: saved?.bestLap ?? null,
    bestSectors: saved?.bestSectors ?? [null, null, null],
    sectors: [null, null, null], // время секторов текущего круга
    sectorState: ['', '', ''], // 'best' — быстрее своего лучшего, 'slower' — медленнее, '' — ещё не проехан
    sector: 0, // какой сектор едем
    delta: null,
    s: 0, // дистанция по кругу, м
    idx: 0,
    note: 'Пересеките линию старта',
    wrongWay: 0, // сколько секунд подряд болид едет вперёд, но против хода гонки
  }
  let bestProfile = saved?.profile ? Float32Array.from(saved.profile) : null
  let profile = new Float32Array(N).fill(-1)
  let first = true

  function nearest(x, z) {
    let bi = st.idx
    let best = Infinity
    const scan = (i) => {
      const a = axis[(i + N) % N]
      const d = (a.x - x) ** 2 + (a.z - z) ** 2
      if (d < best) {
        best = d
        bi = (i + N) % N
      }
    }
    if (first) for (let i = 0; i < N; i++) scan(i)
    else for (let i = st.idx - WINDOW; i <= st.idx + WINDOW; i++) scan(i)
    // далеко от прошлого места (возврат на трассу, срезка) — ищем по всей оси
    if (best > 40 * 40) for (let i = 0; i < N; i++) scan(i)
    first = false
    return bi
  }

  function save() {
    try {
      localStorage.setItem(storeKey, JSON.stringify({ bestLap: st.bestLap, bestSectors: st.bestSectors, profile: bestProfile ? Array.from(bestProfile) : null }))
    } catch {
      // приватное окно — лучший круг просто не запомнится
    }
  }

  function closeSector(i, time) {
    st.sectors[i] = time
    const best = st.bestSectors[i]
    st.sectorState[i] = best === null || time < best ? 'best' : 'slower'
  }

  function startLap() {
    st.lap += 1
    st.running = true
    st.lapTime = 0
    st.sector = 0
    st.sectors = [null, null, null]
    st.sectorState = ['', '', '']
    profile = new Float32Array(N).fill(-1)
    st.note = ''
  }

  return {
    state: st,

    // новый старт с решётки: круг заново
    restart() {
      st.running = false
      st.delta = null
      st.wrongWay = 0
      st.note = ''
      first = true
    },

    // штраф к времени текущего круга (границы трассы), с: круг засчитывается, просто дольше
    addPenalty(seconds) {
      if (st.running) st.lapTime += seconds
    },

    // после возврата на трассу круг не считаем
    invalidate() {
      st.wrongWay = 0
      if (st.running) st.note = 'Круг не засчитан — до финиша'
      st.running = false
      st.delta = null
      first = true
    },

    update(dt, x, z, yaw = null, fwdSpeed = 0) {
      const prevS = st.s
      st.idx = nearest(x, z)
      st.s = axis[st.idx].distance_m
      // неверное направление: нос смотрит против оси трассы и болид едет вперёд (задний ход не считается)
      if (yaw !== null) {
        const d = Math.cos(yaw - axis[st.idx].yaw)
        st.wrongWay = d < -0.3 && fwdSpeed > 4 ? st.wrongWay + dt : 0
      }
      if (st.running) st.lapTime += dt

      const crossedFinish = prevS > L - 60 && st.s < 60
      const backwards = prevS < 60 && st.s > L - 60
      if (backwards) this.invalidate()

      if (st.running) {
        if (profile[st.idx] < 0) profile[st.idx] = st.lapTime
        // секторы по порядку
        if (st.sector < sectorD.length && prevS < sectorD[st.sector] && st.s >= sectorD[st.sector] && st.s - prevS < 100) {
          const before = st.sectors.slice(0, st.sector).reduce((a, b) => a + b, 0)
          closeSector(st.sector, st.lapTime - before)
          st.sector += 1
        }
        if (bestProfile && bestProfile[st.idx] >= 0) st.delta = st.lapTime - bestProfile[st.idx]
      }

      if (crossedFinish) {
        if (st.running && st.sector === sectorD.length) {
          const before = st.sectors.slice(0, st.sector).reduce((a, b) => a + b, 0)
          closeSector(st.sector, st.lapTime - before)
          const time = st.lapTime
          st.lastLap = time
          // секторы законченного круга ещё несколько секунд видны на табло
          st.lastSectors = st.sectors.slice()
          st.lastSectorState = st.sectorState.slice()
          st.lastWasBest = st.bestLap === null || time < st.bestLap
          for (let i = 0; i < 3; i++) if (st.sectors[i] !== null && (st.bestSectors[i] === null || st.sectors[i] < st.bestSectors[i])) st.bestSectors[i] = st.sectors[i]
          if (st.bestLap === null || time < st.bestLap) {
            st.bestLap = time
            bestProfile = profile
          }
          save()
        }
        startLap()
      }
    },
  }
}

export function formatTime(t) {
  if (t === null || t === undefined) return '—'
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(3).padStart(6, '0')}`
}
