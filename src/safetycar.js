// Машина безопасности (Рома 29.10: «настоящая машина безопасности, едущая перед лидером»). Серебристый спорткар с мигалками на крыше
// выезжает из пит-лейна, обгоняет колонну, встаёт перед лидером и держит ~60 м впереди него; когда нейтрализация кончается — гасит мигалки
// и в конце круга уходит в пит-лейн. Кинематическая: едет по оси трассы, в физике её нет (лидеру её не обогнать — держит потолок скорости,
// см. flags.cap с параметром sc). Три.js нужен только для картинки; движение — простая модель, считается сама.
import * as THREE from 'three'
import { SC_SPEED } from './flags.js'

const CATCH_SPEED = 70 // м/с: догоняет колонну, если выехала позади лидера
const GAP = 60 // м: сколько держит впереди лидера
const MIN_SPEED = 24
const MAX_SPEED = 44
const ACCEL = 9 // м/с²
const SHIFT_SPEED = 4 // м/с: уход вбок
const TO_PIT = 380 // м до въезда в пит-лейн: начинает уходить к нему

function buildCar() {
  const g = new THREE.Group()
  const mat = (c, e = 0, rough = true) => (rough ? new THREE.MeshLambertMaterial({ color: c, emissive: e }) : new THREE.MeshStandardMaterial({ color: c, metalness: 0.7, roughness: 0.25 }))
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.5, 4.7), mat(0xc9ccd1, 0, false))
  body.position.set(0, 0.62, 0)
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.28, 1.3), mat(0xc9ccd1, 0, false))
  nose.position.set(0, 0.5, 2.7)
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.5, 2.1), mat(0x15181c))
  cab.position.set(0, 1.07, -0.25)
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 4.7), mat(0x0f6b3c))
  stripe.position.set(0, 0.88, 0)
  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.07, 0.55), mat(0x15181c))
  spoiler.position.set(0, 1.12, -2.45)
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 0.32), mat(0x222222))
  bar.position.set(0, 1.38, -0.2)
  // мигалки: две половины светового бруса, горят попеременно
  const lampL = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 0.28), mat(0xff9d00, 0xff7a00))
  const lampR = lampL.clone()
  lampL.material = lampL.material.clone()
  lampR.material = lampR.material.clone()
  lampL.position.set(-0.35, 1.48, -0.2)
  lampR.position.set(0.35, 1.48, -0.2)
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.05), mat(0xffffff, 0xcfe8ff))
  head.position.set(0, 0.62, 3.36)
  g.add(body, nose, cab, stripe, spoiler, bar, lampL, lampR, head)
  for (const x of [-0.98, 0.98]) {
    for (const z of [-1.5, 1.7]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.3, 14), mat(0x111214))
      w.rotation.z = Math.PI / 2
      w.position.set(x, 0.36, z)
      g.add(w)
    }
  }
  g.userData.lamps = [lampL, lampR]
  return g
}

// lane — пит-лейн (pit.js); из него берём, где у трассы въезд и выезд и насколько они в стороне
export function createSafetyCar(scene, axis, length, lane) {
  const ds = axis.length > 1 ? axis[1].distance_m - axis[0].distance_m : 2
  const ahead = (s1, s2) => (((s2 - s1) % length) + length) % length
  const nearestIdx = (x, z) => {
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < axis.length; i++) {
      const d = (axis[i].x - x) ** 2 + (axis[i].z - z) ** 2
      if (d < bd) {
        bd = d
        bi = i
      }
    }
    return bi
  }
  const latOf = (p, a) => (p.x - a.x) * Math.cos(a.yaw) - (p.z - a.z) * Math.sin(a.yaw)
  // въезд и выезд пит-лейна на оси трассы: где и на каком расстоянии вбок
  let entry = { s: 0, l: 0 }
  let exit = { s: 0, l: 0 }
  if (lane) {
    const a0 = lane.axis[0]
    const a1 = lane.axis[lane.n - 1]
    const i0 = nearestIdx(a0.x, a0.z)
    const i1 = nearestIdx(a1.x, a1.z)
    entry = { s: axis[i0].distance_m, l: latOf(a0, axis[i0]) }
    exit = { s: axis[i1].distance_m, l: latOf(a1, axis[i1]) }
  }

  const mesh = buildCar()
  mesh.visible = false
  scene.add(mesh)
  // phase: off | out (выехала позади лидера, догоняет) | lead (впереди лидера) | in (гасит огни, уходит в боксы)
  const st = { phase: 'off', s: 0, l: 0, v: 0, t: 0 }

  // между отсчётами оси (шаг 2 м) — интерполяция, иначе на 38 м/с машина дёргалась бы
  function place() {
    const f = Math.min(axis.length - 1.001, Math.max(0, (((st.s % length) + length) % length) / ds))
    const i = Math.floor(f)
    const u = f - i
    const p = axis[i]
    const q = axis[i + 1]
    const dyaw = Math.atan2(Math.sin(q.yaw - p.yaw), Math.cos(q.yaw - p.yaw))
    const yaw = p.yaw + dyaw * u
    const x = p.x + (q.x - p.x) * u
    const z = p.z + (q.z - p.z) * u
    const y = (p.y || 0) + ((q.y || 0) - (p.y || 0)) * u
    mesh.position.set(x + Math.cos(yaw) * st.l, y, z - Math.sin(yaw) * st.l)
    mesh.rotation.y = yaw
  }

  return {
    state: st,
    get active() {
      return st.phase !== 'off'
    },
    // сколько метров от s вперёд до машины безопасности; null — её нет впереди (нет или ещё догоняет)
    gapFrom(s) {
      if (st.phase !== 'lead' && st.phase !== 'in') return null
      return ahead(s, st.s)
    },
    get speed() {
      return st.v
    },
    get lamps() {
      return st.phase === 'out' || st.phase === 'lead'
    },

    // выезжает из пит-лейна: leaderS — где лидер
    deploy(leaderS) {
      st.s = exit.s
      st.l = exit.l
      st.v = 20
      st.t = 0
      st.armed = false
      // выехала позади лидера (он ушёл дальше) — догоняет; впереди — просто ждёт его
      st.phase = leaderS == null || ahead(leaderS, st.s) < length / 2 ? 'lead' : 'out'
      mesh.visible = true
      place()
    },
    hide() {
      st.phase = 'off'
      mesh.visible = false
    },

    // dt — кадр; leaderS — расстояние лидера по оси (null — нет); ending — нейтрализация кончается: уходит в боксы.
    // Возвращает true в кадр, когда зашла в боксы
    update(dt, leaderS, ending) {
      if (st.phase === 'off') return false
      st.t += dt
      let home = false
      if (st.phase === 'out' && leaderS != null) {
        // догнала и обогнала: пора вставать перед лидера
        const g = ahead(leaderS, st.s)
        // тормозить с погони ещё надо: пока гасит скорость до колонны, отрыв растёт на (v−SC)²/2a, это учитываем
        const extra = (Math.max(0, st.v - SC_SPEED) ** 2) / (2 * ACCEL)
        if (g > Math.max(12, GAP - extra) && g < length / 2) st.phase = 'lead'
      }
      if (ending && (st.phase === 'lead' || st.phase === 'out')) st.phase = 'in'
      // скорость
      let target = SC_SPEED
      if (st.phase === 'out') target = CATCH_SPEED
      else if (leaderS != null) {
        // держит ~GAP впереди лидера: далеко — ждёт, близко — уходит
        const g = ahead(leaderS, st.s)
        if (g < length / 2) target = Math.max(MIN_SPEED, Math.min(MAX_SPEED, SC_SPEED + 0.12 * (GAP - g)))
      }
      st.v += Math.max(-ACCEL * dt, Math.min(ACCEL * dt, target - st.v))
      st.s = (st.s + st.v * dt) % length
      // в сторону: с выезда к середине трассы, перед въездом — к пит-лейну
      let wantL = st.phase === 'in' && ahead(st.s, entry.s) < TO_PIT ? entry.l : st.phase === 'in' || st.phase === 'lead' ? 0 : 3.5
      if (st.phase === 'out' && st.t > 6) wantL = 3.5
      st.l += Math.max(-SHIFT_SPEED * dt, Math.min(SHIFT_SPEED * dt, wantL - st.l))
      // въезд в пит-лейн: сначала должен оказаться впереди (если только что проехала его — идёт ещё круг)
      if (st.phase === 'in') {
        const d = ahead(st.s, entry.s)
        if (d < length / 2) st.armed = true
        else if (st.armed) st.armed = 'passed'
      }
      if (st.phase === 'in' && (st.armed === 'passed' || (st.armed && ahead(st.s, entry.s) < 6))) {
        home = true
        this.hide()
        return home
      }
      place()
      // мигалки горят попеременно, в конце — выключены
      const [a, b] = mesh.userData.lamps
      const on = this.lamps
      const blink = Math.floor(st.t * 4) % 2 === 0
      a.visible = on && blink
      b.visible = on && !blink
      return home
    },
  }
}
