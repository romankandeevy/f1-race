// Повтор гонки (Рома 31.10). Пока идёт гонка, 30 раз в секунду пишется положение каждого болида (кузов, поворот руля,
// вращение колёс, виден ли) и машины безопасности; после финиша на экране итогов — «Повтор»: физика стоит, болиды ставятся
// по записи, камеры как в трансляции. Управление: пробел — пауза, ← → — ±5 с, ↑ ↓ — скорость (¼…4×), C — камера,
// Tab или [ ] — чей болид показывать, Esc — назад к итогам. Внизу полоса: время, перемотка мышью, кнопки.
// Память: 12 болидов × 30 в секунду × 11 чисел ≈ 16 КБ/с, 10-минутная гонка ~9 МБ; дольше LIMIT секунд не пишем.
import * as THREE from 'three'

const RATE = 30 // записей в секунду
const LIMIT = 40 * 60 // с
const F = 11 // t, x, y, z, qx, qy, qz, qw, руль, вращение колёс, виден
const SPEEDS = [0.25, 0.5, 1, 2, 4]
const CAMS = [
  { id: 'tv', name: 'Трансляция' },
  { id: 'chase', name: 'Сзади' },
  { id: 'onboard', name: 'Из кабины' },
  { id: 'heli', name: 'Вертолёт' },
]
const TV_STEP = 110 // м между камерами у трассы
const TV_SIDE = 16 // м от оси трассы
const TV_H = 5

const fmt = (t) => {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))

function newRec(n = RATE * 120 * F) {
  return { data: new Float32Array(n), n: 0 }
}
function push(tr, vals) {
  if (tr.n + F > tr.data.length) {
    const d = new Float32Array(tr.data.length * 2)
    d.set(tr.data)
    tr.data = d
  }
  tr.data.set(vals, tr.n)
  tr.n += F
}

// axis — ось трассы (для камер у трассы); camera — камера игры
export function createReplay({ camera, axis, length }) {
  // камеры трансляции: точки снаружи оси через TV_STEP м (по очереди слева и справа)
  const tv = []
  if (axis?.length) {
    const ds = axis.length > 1 ? axis[1].distance_m - axis[0].distance_m : 2
    const step = Math.max(1, Math.round(TV_STEP / ds))
    for (let i = 0, k = 0; i < axis.length; i += step, k++) {
      const a = axis[i]
      const side = k % 2 ? 1 : -1
      const w = (side > 0 ? a.width_left : a.width_right) ?? 6
      const off = side * (w + TV_SIDE)
      tv.push({ s: a.distance_m, x: a.x + Math.cos(a.yaw) * off, y: (a.y || 0) + TV_H, z: a.z - Math.sin(a.yaw) * off })
    }
  }

  let cars = [] // [{ id, name, paint, car, rec }]
  let scRec = null
  let sc = null
  let clock = 0 // время записи: идёт только без паузы
  let lastRec = -1
  let recording = false
  const st = { active: false, t: 0, speed: 2, playing: true, cam: 0, focus: 0, total: 0 }
  const vals = new Float32Array(F)

  // ---- полоса внизу ----
  const bar = document.createElement('div')
  bar.id = 'replayBar'
  bar.hidden = true
  bar.innerHTML = `
    <div class="rp-top"><span class="rp-tag">Повтор</span><span class="rp-car"></span><span class="rp-cam"></span><span class="rp-time"></span></div>
    <input class="rp-seek" type="range" min="0" max="1000" value="0">
    <div class="rp-btns">
      <button data-a="back" title="−5 с (←)">−5 с</button>
      <button data-a="play" class="rp-play" title="Пауза (пробел)">Пауза</button>
      <button data-a="fwd" title="+5 с (→)">+5 с</button>
      <button data-a="slower" title="Медленнее (↓)">−</button><span class="rp-speed"></span><button data-a="faster" title="Быстрее (↑)">+</button>
      <button data-a="cam" title="Камера (C)">Камера</button>
      <button data-a="prev" title="Предыдущий болид ([)">‹</button><button data-a="next" title="Следующий болид (Tab)">›</button>
      <button data-a="exit" class="rp-exit" title="Назад к итогам (Esc)">К итогам</button>
    </div>`
  document.body.appendChild(bar)
  const $ = (c) => bar.querySelector(c)
  const seek = $('.rp-seek')
  let onExit = null
  seek.addEventListener('input', () => {
    st.t = (seek.value / 1000) * st.total
  })
  for (const b of bar.querySelectorAll('[data-a]')) b.addEventListener('click', () => act(b.dataset.a))

  function act(a) {
    if (a === 'play') st.playing = !st.playing
    if (a === 'back') st.t = Math.max(0, st.t - 5)
    if (a === 'fwd') st.t = Math.min(st.total, st.t + 5)
    if (a === 'slower') st.speed = Math.max(0, st.speed - 1)
    if (a === 'faster') st.speed = Math.min(SPEEDS.length - 1, st.speed + 1)
    if (a === 'cam') st.cam = (st.cam + 1) % CAMS.length
    if (a === 'next' || a === 'prev') {
      const n = cars.length
      for (let k = 1; k <= n; k++) {
        const i = (st.focus + (a === 'next' ? k : n - k)) % n
        if (cars[i].rec.n) {
          st.focus = i
          break
        }
      }
    }
    if (a === 'exit') exit()
    camFresh = true
    if (st.playing && st.t >= st.total) st.t = 0
  }

  // запись в момент t (с) для одной записи: заполняет out и возвращает true, если есть
  function sample(rec, t, out) {
    const n = rec.n / F
    if (!n) return false
    const d = rec.data
    if (t <= d[0]) {
      for (let k = 0; k < F; k++) out[k] = d[k]
      return true
    }
    if (t >= d[(n - 1) * F]) {
      for (let k = 0; k < F; k++) out[k] = d[(n - 1) * F + k]
      return true
    }
    // двоичный поиск по времени
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (d[m * F] <= t) lo = m
      else hi = m
    }
    const a = lo * F
    const b = hi * F
    const u = (t - d[a]) / Math.max(1e-6, d[b] - d[a])
    for (let k = 1; k < 4; k++) out[k] = d[a + k] + (d[b + k] - d[a + k]) * u
    qa.set(d[a + 4], d[a + 5], d[a + 6], d[a + 7])
    qb.set(d[b + 4], d[b + 5], d[b + 6], d[b + 7])
    qa.slerp(qb, u)
    out[4] = qa.x
    out[5] = qa.y
    out[6] = qa.z
    out[7] = qa.w
    out[8] = d[a + 8] + (d[b + 8] - d[a + 8]) * u
    out[9] = d[a + 9] + angDiff(d[a + 9], d[b + 9]) * u
    out[10] = u < 0.5 ? d[a + 10] : d[b + 10]
    return true
  }
  const qa = new THREE.Quaternion()
  const qb = new THREE.Quaternion()
  const tmp = new Float32Array(F)
  const fwd = new THREE.Vector3()
  const want = new THREE.Vector3()
  const look = new THREE.Vector3()
  const camPos = new THREE.Vector3()
  const camLook = new THREE.Vector3()
  let camFresh = true
  let tvIdx = -1

  function exit() {
    if (!st.active) return
    st.active = false
    bar.hidden = true
    document.body.classList.remove('replay-mode')
    camera.fov = baseFov
    camera.updateProjectionMatrix()
    // болиды — обратно как были (их положения снова ставит физика на следующем кадре)
    for (const c of cars) {
      c.car.group.visible = c.wasVisible
      if (c.car.driverHead) c.car.driverHead.visible = true
    }
    if (sc?.mesh) sc.mesh.visible = scWasVisible
    onExit?.()
  }
  let baseFov = camera.fov
  let scWasVisible = false

  return {
    state: st,
    get active() {
      return st.active
    },
    get available() {
      return cars.some((c) => c.rec.n > F * RATE * 3)
    },

    // новая гонка: list — [{ id, name, paint, car }], safety — машина безопасности (её mesh)
    begin(list, safety) {
      cars = list.map((c) => ({ ...c, rec: newRec() }))
      sc = safety
      scRec = safety?.mesh ? newRec(RATE * 60 * F) : null
      clock = 0
      lastRec = -1
      recording = true
    },
    stop() {
      recording = false
    },
    // раз в кадр, пока идёт гонка и не на паузе: dt — кадр (с)
    record(dt) {
      if (!recording || st.active) return
      clock += dt
      const t = clock
      if (t > LIMIT || t - lastRec < 1 / RATE) return
      lastRec = t
      for (const c of cars) {
        const g = c.car.group
        vals[0] = t
        vals[1] = g.position.x
        vals[2] = g.position.y
        vals[3] = g.position.z
        vals[4] = g.quaternion.x
        vals[5] = g.quaternion.y
        vals[6] = g.quaternion.z
        vals[7] = g.quaternion.w
        const w = c.car.wheelPose?.()
        vals[8] = w ? w.steer : 0
        vals[9] = w ? w.spin : 0
        vals[10] = g.visible ? 1 : 0
        push(c.rec, vals)
      }
      if (scRec) {
        const m = sc.mesh
        vals[0] = t
        vals[1] = m.position.x
        vals[2] = m.position.y
        vals[3] = m.position.z
        qa.setFromEuler(m.rotation)
        vals[4] = qa.x
        vals[5] = qa.y
        vals[6] = qa.z
        vals[7] = qa.w
        vals[8] = vals[9] = 0
        vals[10] = m.visible ? 1 : 0
        push(scRec, vals)
      }
    },

    // войти в повтор: exitFn — что делать по «К итогам»
    enter(exitFn, focusId = 'player') {
      if (!this.available) return false
      onExit = exitFn
      st.active = true
      st.total = Math.max(...cars.map((c) => (c.rec.n ? c.rec.data[c.rec.n - F] : 0)))
      st.t = 0
      st.playing = true
      st.focus = Math.max(0, cars.findIndex((c) => c.id === focusId))
      camFresh = true
      baseFov = camera.fov
      for (const c of cars) c.wasVisible = c.car.group.visible
      scWasVisible = !!sc?.mesh?.visible
      bar.hidden = false
      document.body.classList.add('replay-mode')
      return true
    },
    exit,
    key(code) {
      const map = { Space: 'play', ArrowLeft: 'back', ArrowRight: 'fwd', ArrowUp: 'faster', ArrowDown: 'slower', KeyC: 'cam', Tab: 'next', BracketRight: 'next', BracketLeft: 'prev', Escape: 'exit' }
      if (map[code]) act(map[code])
    },

    // кадр повтора: болиды по записи, камера, полоса
    update(dt) {
      if (!st.active) return
      if (st.playing) {
        st.t += dt * SPEEDS[st.speed]
        if (st.t >= st.total) {
          st.t = st.total
          st.playing = false
        }
      }
      for (const c of cars) {
        if (!sample(c.rec, st.t, tmp)) {
          c.car.group.visible = false
          continue
        }
        const g = c.car.group
        g.visible = tmp[10] > 0.5
        g.position.set(tmp[1], tmp[2], tmp[3])
        g.quaternion.set(tmp[4], tmp[5], tmp[6], tmp[7])
        c.car.setWheelPose?.(tmp[8], tmp[9])
      }
      if (scRec && sample(scRec, st.t, tmp)) {
        sc.mesh.visible = tmp[10] > 0.5
        sc.mesh.position.set(tmp[1], tmp[2], tmp[3])
        qa.set(tmp[4], tmp[5], tmp[6], tmp[7])
        sc.mesh.quaternion.copy(qa)
      }
      // камера
      const f = cars[st.focus]
      const g = f.car.group
      fwd.set(0, 0, 1).applyQuaternion(g.quaternion)
      const cam = CAMS[st.cam].id
      for (const c of cars) if (c.car.driverHead) c.car.driverHead.visible = !(c === f && cam === 'onboard')
      let fov = baseFov
      let smooth = camFresh ? 1 : 1 - Math.exp(-dt * 8)
      if (cam === 'chase') {
        want.copy(g.position).addScaledVector(fwd, -6.5)
        want.y += 2.1
        look.copy(g.position).addScaledVector(fwd, 4)
        look.y += 0.6
      } else if (cam === 'onboard' && f.car.onboard) {
        f.car.onboard.getWorldPosition(want)
        look.copy(want).addScaledVector(fwd, 10)
        smooth = 1
      } else if (cam === 'heli') {
        want.copy(g.position).addScaledVector(fwd, -14)
        want.y += 26
        look.copy(g.position).addScaledVector(fwd, 8)
        smooth = camFresh ? 1 : 1 - Math.exp(-dt * 3)
      } else {
        // трансляция: ближайшая камера у трассы, которую болид ещё не проехал далеко; стоит и поворачивается, приближает
        let best = -1
        let bd = Infinity
        for (let i = 0; i < tv.length; i++) {
          const d = (tv[i].x - g.position.x) ** 2 + (tv[i].z - g.position.z) ** 2
          if (d < bd) {
            bd = d
            best = i
          }
        }
        if (best >= 0) {
          // держим камеру, пока болид не ушёл от неё дальше соседней (без мельтешения)
          if (tvIdx >= 0 && tvIdx < tv.length) {
            const c = tv[tvIdx]
            const dc = (c.x - g.position.x) ** 2 + (c.z - g.position.z) ** 2
            if (dc < bd * 2.2 && !camFresh) best = tvIdx
          }
          if (best !== tvIdx) camFresh = true
          tvIdx = best
          const c = tv[best]
          want.set(c.x, c.y, c.z)
          look.copy(g.position)
          look.y += 0.5
          const dist = Math.sqrt((c.x - g.position.x) ** 2 + (c.z - g.position.z) ** 2)
          // ближе — шире, дальше — приближаем: болид примерно одного размера в кадре
          fov = THREE.MathUtils.clamp((2 * Math.atan(9 / Math.max(1, dist)) * 180) / Math.PI, 8, 60)
          smooth = 1
        } else {
          want.copy(g.position).addScaledVector(fwd, -7)
          want.y += 2.5
          look.copy(g.position)
        }
      }
      if (camFresh) {
        camPos.copy(want)
        camLook.copy(look)
      } else {
        camPos.lerp(want, smooth)
        camLook.lerp(look, cam === 'tv' ? 1 - Math.exp(-dt * 20) : smooth)
      }
      camFresh = false
      camera.position.copy(camPos)
      camera.lookAt(camLook)
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov += (fov - camera.fov) * (cam === 'tv' ? 1 - Math.exp(-dt * 6) : 1)
        camera.updateProjectionMatrix()
      }
      // полоса
      seek.value = st.total ? Math.round((st.t / st.total) * 1000) : 0
      $('.rp-time').textContent = `${fmt(st.t)} / ${fmt(st.total)}`
      $('.rp-car').textContent = f.name
      $('.rp-car').style.setProperty('--paint', f.paint)
      $('.rp-cam').textContent = CAMS[st.cam].name
      $('.rp-speed').textContent = `${SPEEDS[st.speed]}×`
      $('.rp-play').textContent = st.playing ? 'Пауза' : 'Играть'
    },
  }
}
