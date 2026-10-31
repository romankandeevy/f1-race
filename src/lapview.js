// Телеметрия круга против лучшего (Рома 31.10, пункт 19). Пока едешь, по каждой точке оси трассы (через 2 м)
// пишется скорость, газ, тормоз и время круга. Законченный засчитанный круг — «последний»; лучший круг на трассе
// хранится в localStorage (`f1-race.tele.<длина трассы>`). Экран (клавиша Y в заезде, кнопка в «Рекордах»):
// графики скорости, газа и тормоза по дистанции — последний (белый) против лучшего (красный), под ними разница по
// времени (вверх — теряешь, вниз — выигрываешь), справа схема трассы: участки, где последний круг быстрее лучшего, —
// зелёные, медленнее — красные. Мышь по графику — значения в точке и точка на схеме. Пока открыт — игра на паузе.
const W = 960
const H = 470

const pack = (a) => Array.from(a, (x) => Math.round(x * 10) / 10)

export function createLapView(track) {
  const N = track.axis.length
  const L = track.length
  const KEY = `f1-race.tele.${Math.round(L)}`
  const blank = () => ({ speed: new Float32Array(N).fill(-1), thr: new Float32Array(N).fill(-1), brk: new Float32Array(N).fill(-1), t: new Float32Array(N).fill(-1), time: 0 })
  let cur = blank()
  let last = null
  let best = null
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (s && s.speed?.length === N) best = { speed: Float32Array.from(s.speed), thr: Float32Array.from(s.thr), brk: Float32Array.from(s.brk), t: Float32Array.from(s.t), time: s.time }
  } catch {
    // нет лучшего — будет после первого засчитанного круга
  }
  let prevLapTime = 0
  let prevCompleted = null

  // ---- экран ----
  const box = document.createElement('div')
  box.id = 'lapview'
  box.hidden = true
  box.innerHTML = `<div class="lv-top"><span class="lv-k">Телеметрия круга</span><span class="lv-leg"><i class="a"></i>Последний <b class="lv-la"></b><i class="b"></i>Лучший <b class="lv-lb"></b></span><span class="lv-at"></span><button class="lv-x" title="Закрыть (Y или Esc)">Закрыть</button></div><canvas width="${W}" height="${H}"></canvas><p class="lv-empty" hidden>Проедь засчитанный круг — здесь появятся графики.</p>`
  document.body.appendChild(box)
  const cv = box.querySelector('canvas')
  const g = cv.getContext('2d')
  let hover = -1
  let onClose = null
  box.querySelector('.lv-x').addEventListener('click', () => api.close())
  cv.addEventListener('mousemove', (e) => {
    const r = cv.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * W
    hover = x >= PLOT.x && x <= PLOT.x + PLOT.w ? Math.round(((x - PLOT.x) / PLOT.w) * (N - 1)) : -1
    draw()
  })
  cv.addEventListener('mouseleave', () => {
    hover = -1
    draw()
  })

  const PLOT = { x: 54, w: 600 }
  const MAP = { x: 690, y: 40, w: 250, h: 250 }
  // схема трассы: ось в квадрат MAP
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const a of track.axis) {
    minX = Math.min(minX, a.x)
    maxX = Math.max(maxX, a.x)
    minZ = Math.min(minZ, a.z)
    maxZ = Math.max(maxZ, a.z)
  }
  const sc = Math.min(MAP.w / (maxX - minX || 1), MAP.h / (maxZ - minZ || 1))
  const mx = (a) => MAP.x + (a.x - minX) * sc + (MAP.w - (maxX - minX) * sc) / 2
  const mz = (a) => MAP.y + (a.z - minZ) * sc + (MAP.h - (maxZ - minZ) * sc) / 2

  // значение в точке i: если не записано — ближайшее записанное
  const val = (arr, i) => {
    for (let k = 0; k < 6; k++) {
      if (arr[Math.min(N - 1, i + k)] >= 0) return arr[Math.min(N - 1, i + k)]
      if (arr[Math.max(0, i - k)] >= 0) return arr[Math.max(0, i - k)]
    }
    return null
  }
  function line(arr, y0, h, vmax, color, width) {
    g.strokeStyle = color
    g.lineWidth = width
    g.beginPath()
    let pen = false
    for (let i = 0; i < N; i += 2) {
      const v = arr[i]
      if (v < 0) {
        pen = false
        continue
      }
      const x = PLOT.x + (i / (N - 1)) * PLOT.w
      const y = y0 + h - (Math.min(v, vmax) / vmax) * h
      if (pen) g.lineTo(x, y)
      else g.moveTo(x, y)
      pen = true
    }
    g.stroke()
  }
  function draw() {
    g.clearRect(0, 0, W, H)
    const a = last
    const b = best
    box.querySelector('.lv-empty').hidden = !!(a || b)
    if (!a && !b) return
    const lanes = [
      { name: 'Скорость, км/ч', key: 'speed', y: 30, h: 150, max: 360 },
      { name: 'Газ', key: 'thr', y: 200, h: 55, max: 1 },
      { name: 'Тормоз', key: 'brk', y: 270, h: 55, max: 1 },
    ]
    g.font = '600 12px "Titillium Web", Arial, sans-serif'
    for (const l of lanes) {
      g.fillStyle = 'rgba(255,255,255,0.04)'
      g.fillRect(PLOT.x, l.y, PLOT.w, l.h)
      g.fillStyle = 'rgba(255,255,255,0.55)'
      g.fillText(l.name, PLOT.x + 4, l.y + 13)
      if (b) line(b[l.key], l.y, l.h, l.max, '#e10600', 1.6)
      if (a) line(a[l.key], l.y, l.h, l.max, '#f2f2f0', 1.3)
    }
    // разница по времени: последний − лучший
    const dy = 345
    const dh = 90
    g.fillStyle = 'rgba(255,255,255,0.04)'
    g.fillRect(PLOT.x, dy, PLOT.w, dh)
    g.fillStyle = 'rgba(255,255,255,0.55)'
    g.fillText('Разница, с (вверх — теряешь)', PLOT.x + 4, dy + 13)
    const mid = dy + dh / 2
    g.strokeStyle = 'rgba(255,255,255,0.2)'
    g.beginPath()
    g.moveTo(PLOT.x, mid)
    g.lineTo(PLOT.x + PLOT.w, mid)
    g.stroke()
    let gain = null
    if (a && b) {
      gain = new Float32Array(N).fill(0)
      let maxD = 0.3
      for (let i = 0; i < N; i++) if (a.t[i] >= 0 && b.t[i] >= 0) maxD = Math.max(maxD, Math.abs(a.t[i] - b.t[i]))
      g.strokeStyle = '#ffd400'
      g.lineWidth = 1.5
      g.beginPath()
      let pen = false
      let prev = 0
      for (let i = 0; i < N; i++) {
        if (a.t[i] < 0 || b.t[i] < 0) continue
        const d = a.t[i] - b.t[i]
        gain[i] = d - prev // >0 — на этом участке теряем
        prev = d
        const x = PLOT.x + (i / (N - 1)) * PLOT.w
        const y = mid - (d / maxD) * (dh / 2 - 6)
        if (pen) g.lineTo(x, y)
        else g.moveTo(x, y)
        pen = true
      }
      g.stroke()
    }
    // секторы
    g.strokeStyle = 'rgba(255,255,255,0.25)'
    g.setLineDash([3, 4])
    for (const s of track.sectors ?? []) {
      const x = PLOT.x + ((s.distance_m ?? s.distance) / L) * PLOT.w
      if (!Number.isFinite(x)) continue
      g.beginPath()
      g.moveTo(x, 30)
      g.lineTo(x, dy + dh)
      g.stroke()
    }
    g.setLineDash([])
    // дистанция
    g.fillStyle = 'rgba(255,255,255,0.45)'
    for (let km = 0; km <= L / 1000; km++) {
      const x = PLOT.x + ((km * 1000) / L) * PLOT.w
      g.fillText(`${km} км`, x - 8, dy + dh + 16)
    }
    // схема: цвет участка — где теряем и где выигрываем (сглажено по 40 м)
    g.lineWidth = 5
    g.lineCap = 'round'
    for (let i = 0; i < N - 1; i++) {
      let s = 0
      if (gain) for (let k = -10; k <= 10; k++) s += gain[(i + k + N) % N]
      g.strokeStyle = !gain ? '#8a8f98' : s > 0.004 ? '#e10600' : s < -0.004 ? '#22c55e' : '#8a8f98'
      g.beginPath()
      g.moveTo(mx(track.axis[i]), mz(track.axis[i]))
      g.lineTo(mx(track.axis[i + 1]), mz(track.axis[i + 1]))
      g.stroke()
    }
    g.lineCap = 'butt'
    g.fillStyle = 'rgba(255,255,255,0.6)'
    g.fillText('Зелёный — быстрее лучшего,', MAP.x, MAP.y + MAP.h + 26)
    g.fillText('красный — медленнее', MAP.x, MAP.y + MAP.h + 42)
    // курсор
    if (hover >= 0) {
      const x = PLOT.x + (hover / (N - 1)) * PLOT.w
      g.strokeStyle = 'rgba(255,255,255,0.7)'
      g.beginPath()
      g.moveTo(x, 30)
      g.lineTo(x, dy + dh)
      g.stroke()
      const p = track.axis[hover]
      g.fillStyle = '#fff'
      g.beginPath()
      g.arc(mx(p), mz(p), 6, 0, Math.PI * 2)
      g.fill()
      const sa = a ? val(a.speed, hover) : null
      const sb = b ? val(b.speed, hover) : null
      const d = a && b && a.t[hover] >= 0 && b.t[hover] >= 0 ? a.t[hover] - b.t[hover] : null
      box.querySelector('.lv-at').textContent = `${Math.round((hover / (N - 1)) * L)} м · ${sa != null ? Math.round(sa) : '—'} / ${sb != null ? Math.round(sb) : '—'} км/ч${d != null ? ` · ${d > 0 ? '+' : ''}${d.toFixed(2)} с` : ''}`
    } else box.querySelector('.lv-at').textContent = ''
    const fmt = (t) => (t ? `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}` : '—')
    box.querySelector('.lv-la').textContent = fmt(a?.time)
    box.querySelector('.lv-lb').textContent = fmt(b?.time)
  }

  const api = {
    get open() {
      return !box.hidden
    },
    // каждый кадр в заезде: laps — laps.js; speedKmh, input
    record(laps, speedKmh, input) {
      const st = laps.state
      if (prevCompleted === null) prevCompleted = st.completed
      // новый круг начался: прошлый засчитан — запоминаем
      if (st.lapTime < prevLapTime - 0.5) {
        if (st.completed !== prevCompleted) {
          last = { ...cur, time: st.lastLap }
          if (st.lastWasBest || !best) {
            best = last
            try {
              localStorage.setItem(KEY, JSON.stringify({ speed: pack(best.speed), thr: pack(best.thr), brk: pack(best.brk), t: Array.from(best.t, (x) => Math.round(x * 1000) / 1000), time: best.time }))
            } catch {
              // не сохранили — лучший останется до перезагрузки
            }
          }
        }
        cur = blank()
      }
      prevCompleted = st.completed
      prevLapTime = st.lapTime
      if (!st.running) return
      const i = st.idx
      if (cur.t[i] < 0) {
        cur.speed[i] = speedKmh
        cur.thr[i] = input.throttle
        cur.brk[i] = input.brake
        cur.t[i] = st.lapTime
      }
    },
    show(closeFn) {
      onClose = closeFn
      box.hidden = false
      draw()
    },
    close() {
      if (box.hidden) return
      box.hidden = true
      onClose?.()
    },
    toggle(closeFn) {
      if (box.hidden) this.show(closeFn)
      else this.close()
    },
  }
  return api
}
