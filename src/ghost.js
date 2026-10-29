// Призрак лучшего круга (Рома 29.10): полупрозрачный болид едет по твоему рекорду — видно, где теряешь.
// Показывается в заезде на время и в квалификации (в гонке — нет). Запись — положение и поворот кузова
// 20 раз в секунду по времени круга; лучший круг (laps.js: lastWasBest) сохраняется в localStorage рядом с рекордом.
// Призрак — копия болида с прозрачными копиями материалов: на настоящий болид и ботов не влияет.
import * as THREE from 'three'

const RATE = 20 // Гц
const OPACITY = 0.3

export function createGhost(scene, car, key) {
  let best = null
  try {
    const s = JSON.parse(localStorage.getItem(key) || 'null')
    if (s?.t?.length) best = { time: s.time, t: Float32Array.from(s.t), p: Float32Array.from(s.p), q: Float32Array.from(s.q) }
  } catch {
    best = null
  }
  const rec = { t: [], p: [], q: [] }
  let recLap = -1
  let acc = 0
  let lastCompleted = null
  let at = 0

  const ghost = car.spawn('#8fd3ff')
  ghost.group.traverse((o) => {
    if (!o.isMesh) return
    o.castShadow = o.receiveShadow = false
    o.renderOrder = 5
    const see = (m) => {
      const c = m.clone()
      c.transparent = true
      c.opacity = OPACITY
      c.depthWrite = false
      return c
    }
    o.material = Array.isArray(o.material) ? o.material.map(see) : see(o.material)
  })
  ghost.group.visible = false
  scene.add(ghost.group)
  const qa = new THREE.Quaternion()
  const qb = new THREE.Quaternion()

  const clearRec = () => {
    rec.t.length = rec.p.length = rec.q.length = 0
    acc = 0
  }
  const sample = (time, body) => {
    const p = body.translation()
    const r = body.rotation()
    rec.t.push(+time.toFixed(3))
    rec.p.push(+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2))
    rec.q.push(+r.x.toFixed(4), +r.y.toFixed(4), +r.z.toFixed(4), +r.w.toFixed(4))
  }
  const save = (time) => {
    best = { time, t: Float32Array.from(rec.t), p: Float32Array.from(rec.p), q: Float32Array.from(rec.q) }
    try {
      localStorage.setItem(key, JSON.stringify({ time, t: rec.t, p: rec.p, q: rec.q }))
    } catch {
      // приватное окно — призрак живёт до перезагрузки
    }
  }

  return {
    // после laps.update: st — laps.state, body — кузов игрока; show — показывать ли призрака
    update(dt, st, body, show) {
      // круг закрыт (засчитан): если он лучший — запись становится призраком
      if (lastCompleted === null) lastCompleted = st.completed
      if (st.completed !== lastCompleted) {
        lastCompleted = st.completed
        if (st.lastWasBest && recLap === st.lap - 1 && rec.t.length > RATE) {
          sample(st.lastLap, body)
          save(st.lastLap)
        }
      }
      // новый круг — новая запись; круг не считается (R, срезка назад) — запись выкидываем
      if (st.lap !== recLap || !st.running) {
        clearRec()
        recLap = st.running ? st.lap : -1
      }
      if (st.running && dt > 0) {
        acc += dt
        if (!rec.t.length || acc >= 1 / RATE) {
          acc = 0
          sample(st.lapTime, body)
        }
      }

      // показ: по времени текущего круга между двумя записями
      const on = show && best && st.running && st.lapTime <= best.time
      if (!on) {
        if (ghost.group.visible) ghost.group.visible = false
        at = 0
        return
      }
      const t = best.t
      if (at >= t.length - 1 || t[at] > st.lapTime) at = 0
      while (at < t.length - 2 && t[at + 1] < st.lapTime) at++
      const k = Math.min(1, Math.max(0, (st.lapTime - t[at]) / (t[at + 1] - t[at] || 1)))
      const p = best.p
      const i = at * 3
      ghost.group.position.set(p[i] + (p[i + 3] - p[i]) * k, p[i + 1] + (p[i + 4] - p[i + 1]) * k, p[i + 2] + (p[i + 5] - p[i + 2]) * k)
      const q = best.q
      const j = at * 4
      qa.set(q[j], q[j + 1], q[j + 2], q[j + 3])
      qb.set(q[j + 4], q[j + 5], q[j + 6], q[j + 7])
      ghost.group.quaternion.slerpQuaternions(qa, qb, k)
      ghost.group.visible = true
    },
    hide() {
      ghost.group.visible = false
    },
  }
}
