// Погода (Рома 29.10: «дождь»): сухо, дождь с самого старта или «может пойти дождь» по ходу гонки.
// rain — сила дождя сейчас (0…1), wet — насколько мокрая трасса (0…1): под дождём намокает за ~1–1,5 мин,
// без дождя подсыхает за ~5 мин. wet читают шины (wear.js wetGrip через v.wet), боты (ai.js) и брызги (particles.js).
// Картинка: капли вокруг камеры, небо и свет темнее, асфальт, поребрики и бетон темнеют и блестят (меньше шероховатость).
import * as THREE from 'three'

export const WEATHERS = {
  dry: { name: 'Сухо', about: 'Солнце, сухая трасса — обычные слики.' },
  rain: { name: 'Дождь', about: 'Дождь с самого старта: трасса мокрая, на сликах почти не держит. Промежуточные — когда влажно, дождевые — в ливень.' },
  mixed: { name: 'Может пойти дождь', about: 'Старт на сухой трассе, по ходу гонки может пойти дождь, а потом трасса подсохнет. Кто вовремя сменит шины — тот выиграл.' },
}
export const WEATHER_ORDER = ['dry', 'rain', 'mixed']

const WET_MATS = ['Асфальт', 'Пол боксов', 'Поребрик красный', 'Поребрик белый', 'Линия белая', 'Линия чёрная', 'Бетон', 'Разметка мест команд']
const SOAK = 0.016 // 1/с — насколько быстро намокает под сильным дождём
const DRY = 0.0035 // 1/с — подсыхает без дождя
const DROPS = 4000
const BOX = 22 // м — полкуба капель вокруг камеры (по высоте — половина)
const FALL = 11 // м/с — скорость капли
const EXPOSE = 0.035 // с — «выдержка»: капля рисуется отрезком, который она проходит относительно камеры
const rnd = (a, b) => a + Math.random() * (b - a)

export function createWeather(scene, env) {
  const st = { mode: 'dry', rain: 0, target: 0, wet: 0, t: 0, plan: null }
  // материалы трассы, которые мокнут: запоминаем сухой вид
  const mats = []
  scene.traverse((o) => {
    if (!o.isMesh) return
    for (const m of [].concat(o.material)) if (WET_MATS.includes(m.name) && !mats.some((x) => x.m === m)) mats.push({ m, color: m.color.clone(), rough: m.roughness })
  })

  // капли: отрезки в мире (не привязаны к камере — на скорости несутся навстречу), падают с ветром;
  // вышла из куба вокруг камеры — переносится на другую его сторону
  const off = new Float32Array(DROPS * 3) // мировые координаты капель
  let seeded = false
  const camPrev = new THREE.Vector3()
  const pos = new Float32Array(DROPS * 6)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage))
  const mat = new THREE.LineBasicMaterial({ color: 0xd5dee6, transparent: true, opacity: 0, depthWrite: false })
  const drops = new THREE.LineSegments(geo, mat)
  drops.frustumCulled = false
  drops.visible = false
  drops.renderOrder = 20
  scene.add(drops)
  let shownWet = -1

  function look() {
    const gloom = Math.max(st.rain, st.wet * 0.45)
    env.setGloom(gloom)
    // мокрый асфальт: темнее и глаже (в нём отражается небо)
    if (Math.abs(st.wet - shownWet) > 0.01) {
      shownWet = st.wet
      for (const { m, color, rough } of mats) {
        m.color.copy(color).multiplyScalar(1 - 0.38 * st.wet)
        m.roughness = rough * (1 - 0.82 * st.wet) // мокрый асфальт почти зеркальный: в нём небо и огни
      }
    }
  }

  return {
    state: st,
    // новый старт: погода сначала (mixed — план дождя на эту гонку)
    set(mode) {
      st.mode = WEATHERS[mode] ? mode : 'dry'
      st.t = 0
      st.plan = null
      if (st.mode === 'rain') st.rain = st.target = st.wet = rnd(0.75, 0.95)
      else {
        st.rain = st.target = st.wet = 0
        if (st.mode === 'mixed') st.plan = { start: rnd(45, 140), length: rnd(90, 180), peak: rnd(0.55, 1) }
      }
      look()
    },
    // running — идёт заезд (на паузе и в меню дождь не продвигается)
    update(dt, camera, running) {
      if (running && dt > 0) {
        st.t += dt
        if (st.plan) st.target = st.t > st.plan.start && st.t < st.plan.start + st.plan.length ? st.plan.peak : 0
        st.rain += (st.target - st.rain) * Math.min(1, dt / 8)
        if (st.rain > st.wet) st.wet = Math.min(1, st.wet + dt * SOAK * st.rain)
        else st.wet = Math.max(0, st.wet - dt * DRY * (1 - st.rain))
        look()
      }
      const on = st.rain > 0.02
      drops.visible = on
      if (!on) return
      mat.opacity = 0.22 + 0.33 * st.rain
      const c = camera.position
      if (!seeded) {
        seeded = true
        camPrev.copy(c)
        for (let i = 0; i < DROPS; i++) {
          off[i * 3] = c.x + rnd(-BOX, BOX)
          off[i * 3 + 1] = c.y + rnd(-BOX / 2, BOX / 2)
          off[i * 3 + 2] = c.z + rnd(-BOX, BOX)
        }
      }
      // скорость камеры (болид): капля рисуется следом относительно неё — на 250 км/ч это длинные штрихи навстречу
      const inv = dt > 0 ? 1 / dt : 0
      let cvx = (c.x - camPrev.x) * inv
      let cvy = (c.y - camPrev.y) * inv
      let cvz = (c.z - camPrev.z) * inv
      if (cvx * cvx + cvy * cvy + cvz * cvz > 150 * 150) cvx = cvy = cvz = 0 // перескок камеры (новый старт, смена вида)
      camPrev.copy(c)
      const wind = 1.2
      const fall = dt * FALL
      const lx = (wind - cvx) * EXPOSE
      const ly = Math.min(0.9, (FALL + cvy) * EXPOSE + 0.25 * st.rain)
      const lz = -cvz * EXPOSE
      const B2 = BOX * 2
      for (let i = 0; i < DROPS; i++) {
        const j = i * 3
        let x = off[j] + wind * dt
        let y = off[j + 1] - fall
        let z = off[j + 2]
        if (x - c.x > BOX) x -= B2
        else if (x - c.x < -BOX) x += B2
        if (z - c.z > BOX) z -= B2
        else if (z - c.z < -BOX) z += B2
        if (y - c.y < -BOX / 2) {
          y += BOX
          x = c.x + rnd(-BOX, BOX)
          z = c.z + rnd(-BOX, BOX)
        } else if (y - c.y > BOX / 2) y -= BOX
        off[j] = x
        off[j + 1] = y
        off[j + 2] = z
        const k = i * 6
        pos[k] = x
        pos[k + 1] = y
        pos[k + 2] = z
        pos[k + 3] = x - lx
        pos[k + 4] = y + ly
        pos[k + 5] = z - lz
      }
      // реже рисуем дальние: в ливень капель видно все, в морось — часть
      geo.setDrawRange(0, Math.round(DROPS * (0.35 + 0.65 * st.rain)) * 2)
      geo.attributes.position.needsUpdate = true
    },
    // строка для табло: что с трассой
    label() {
      if (st.wet < 0.04 && st.rain < 0.04) return null
      const w = Math.round(st.wet * 100)
      const state = st.wet > 0.6 ? `мокрая ${w}%` : st.wet > 0.2 ? `влажная ${w}%` : `подсыхает ${w}%`
      return st.rain > 0.08 ? `дождь · ${state}` : state
    },
  }
}
