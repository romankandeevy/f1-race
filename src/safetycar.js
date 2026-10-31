// Машина безопасности (Рома 29.10: «настоящая машина безопасности, едущая перед лидером»). Серебристый спорткар с мигалками на крыше
// выезжает из пит-лейна, обгоняет колонну, встаёт перед лидером и держит ~60 м впереди него; когда нейтрализация кончается — гасит мигалки
// и в конце круга уходит в пит-лейн. Кинематическая: едет по оси трассы, в физике её нет (лидеру её не обогнать — держит потолок скорости,
// см. flags.cap с параметром sc). Три.js нужен только для картинки; движение — простая модель, считается сама.
import * as THREE from 'three'
import { SC_SPEED } from './flags.js'

const CATCH_SPEED = 70 // м/с: догоняет колонну, если выехала позади лидера
const GAP = 60 // м: сколько держит впереди лидера
const MIN_SPEED = 32
const MAX_SPEED = 60
const LEAD_START = 150 // м перед лидером: где появляется, если выезд из пит-лейна далеко
const PIT_NEAR = 900 // м: въезд ближе — уходит в боксы, дальше — съезжает на служебный выезд (не ждём целый круг)
const OFF_ROAD_TIME = 4 // с: гасит огни, отходит вбок и пропадает
const ACCEL = 9 // м/с²
const SHIFT_SPEED = 4 // м/с: уход вбок
const TO_PIT = 380 // м до въезда в пит-лейн: начинает уходить к нему
// Объезд болидов (Рома: «машина безопасности едет сквозь болиды»): в физике её нет, поэтому болиды впереди и сбоку она видит сама —
// впереди ближе LOOK м и в полосе ближе SIDE_GAP вбок — уходит на свободную сторону; места нет — едет за ним со скоростью болида
const LOOK = 45
const SIDE_GAP = 2.7 // м центр к центру: машина 2 м, болид 1,9
const EDGE = 1.3 // м от белой линии
const AVOID_SHIFT = 6 // м/с: уход вбок при объезде

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
  const wl = (a) => (a.width_left ?? 6) - EDGE
  const wr = (a) => (a.width_right ?? 6) - EDGE
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
  // где болиды относительно машины — по оси трассы (вдоль: на сколько метров впереди по оси, вбок: от оси, как st.l).
  // В её собственных осях нельзя: в повороте болид впереди в той же полосе казался сбоку, и она въезжала в него
  const near = []
  function sense(cars) {
    near.length = 0
    if (!cars || !mesh.visible) return
    const n = axis.length
    const i0 = Math.round((((st.s % length) + length) % length) / ds)
    for (const c of cars) {
      if ((c.x - mesh.position.x) ** 2 + (c.z - mesh.position.z) ** 2 > (LOOK + 10) ** 2) continue
      let bi = i0
      let bd = Infinity
      for (let k = -8; k <= Math.ceil(LOOK / ds) + 4; k++) {
        const i = (((i0 + k) % n) + n) % n
        const d = (axis[i].x - c.x) ** 2 + (axis[i].z - c.z) ** 2
        if (d < bd) {
          bd = d
          bi = i
        }
      }
      let along = axis[bi].distance_m - (((st.s % length) + length) % length)
      if (along > length / 2) along -= length
      if (along < -length / 2) along += length
      if (along < -8 || along > LOOK) continue
      const l = latOf(c, axis[bi])
      near.push({ along, l, v: c.speed ?? 0 })
    }
  }
  // куда сместиться и до какой скорости ехать, чтобы не въехать ни в кого; want — куда хотела сама
  let hard = false // кто-то вплотную впереди в полосе: тормозит сильнее
  function avoid(want, target) {
    const a = axis[Math.min(axis.length - 1, Math.max(0, Math.round((((st.s % length) + length) % length) / ds)))]
    const hiL = a ? wl(a) : 5
    const loL = a ? -wr(a) : -5
    const blocks = (l, c) => Math.abs(c.l - l) < SIDE_GAP
    const ahead = near.filter((c) => c.along > 0)
    const beside = near.filter((c) => c.along <= 0 || c.along < 5.5)
    // свободна ли полоса l: никого рядом сбоку и впереди в ней
    const free = (l) => !near.some((c) => blocks(l, c))
    let l = Math.max(loL, Math.min(hiL, want))
    if (!free(l)) {
      // ближайшая свободная полоса по обе стороны (шаг 0,5 м)
      let best = null
      for (let d = 0.5; d <= hiL - loL; d += 0.5) {
        for (const c of [l - d, l + d]) if (c >= loL && c <= hiL && free(c)) best = best ?? c
        if (best !== null) break
      }
      if (best !== null) l = best
    }
    // в полосе впереди всё равно кто-то (не успела уйти или места нет) — не догонять его
    let v = target
    hard = false
    for (const c of ahead) {
      // мешает и тот, кто в полосе сейчас, и тот, кто в полосе, куда уходим
      const lat = Math.min(Math.abs(c.l - st.l), Math.abs(c.l - l))
      if (lat > SIDE_GAP) continue
      const room = c.along - 7
      // успеть оттормозиться до его скорости: и по запасу, и по тормозному пути
      v = Math.min(v, Math.max(0, c.v + 0.5 * room), Math.sqrt(c.v * c.v + 2 * ACCEL * Math.max(0, room)))
      if (c.along < 14) hard = true
    }
    // сбоку вплотную — не прижиматься: ширина коридора с той стороны
    for (const c of beside) {
      if (Math.abs(c.along) > 5.5) continue
      if (c.l > st.l) l = Math.min(l, c.l - SIDE_GAP)
      else l = Math.max(l, c.l + SIDE_GAP)
    }
    return { l: Math.max(loL, Math.min(hiL, l)), v }
  }

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
    mesh,
    // для проверок: кого она видит рядом
    get near() {
      return near.slice()
    },
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

    // выезжает: leaderS — где лидер. Выезд из пит-лейна чуть впереди лидера — оттуда; иначе сразу встаёт перед лидером
    // (Рома 30.10: выезжала позади лидера и полкруга его догоняла, а все ехали на ограничителе)
    deploy(leaderS) {
      const g = leaderS == null ? 0 : ahead(leaderS, exit.s)
      const fromPit = leaderS == null || (g > 40 && g < 600)
      st.s = fromPit ? exit.s : (leaderS + LEAD_START) % length
      st.l = fromPit ? exit.l : 0
      st.v = fromPit ? 20 : SC_SPEED
      st.t = 0
      st.armed = false
      st.offT = 0
      st.phase = 'lead'
      mesh.visible = true
      place()
    },
    hide() {
      st.phase = 'off'
      mesh.visible = false
    },

    // dt — кадр; leaderS — расстояние лидера по оси (null — нет); ending — нейтрализация кончается: уходит в боксы.
    // Возвращает true в кадр, когда зашла в боксы
    update(dt, leaderS, ending, cars) {
      if (st.phase === 'off') return false
      sense(cars)
      st.t += dt
      let home = false
      if (st.phase === 'out' && leaderS != null) {
        // догнала и обогнала: пора вставать перед лидера
        const g = ahead(leaderS, st.s)
        // тормозить с погони ещё надо: пока гасит скорость до колонны, отрыв растёт на (v−SC)²/2a, это учитываем
        const extra = (Math.max(0, st.v - SC_SPEED) ** 2) / (2 * ACCEL)
        if (g > Math.max(12, GAP - extra) && g < length / 2) st.phase = 'lead'
      }
      if (ending && (st.phase === 'lead' || st.phase === 'out')) {
        // въезд в пит-лейн близко — уходит туда; далеко — гасит огни и съезжает на служебный выезд (ждать целый круг незачем)
        st.phase = ahead(st.s, entry.s) < PIT_NEAR ? 'in' : 'leave'
        st.offT = 0
      }
      if (st.phase === 'leave') {
        st.offT += dt
        st.l += SHIFT_SPEED * dt * 2
        st.s = (st.s + st.v * dt) % length
        place()
        mesh.userData.lamps.forEach((l) => (l.visible = false))
        if (st.offT > OFF_ROAD_TIME) {
          this.hide()
          return true
        }
        return false
      }
      // скорость
      let target = SC_SPEED
      if (st.phase === 'out') target = CATCH_SPEED
      else if (st.phase === 'in') target = MAX_SPEED // огни погашены — сама уходит к въезду, колонна за ней
      else if (leaderS != null) {
        // держит ~GAP впереди лидера: далеко — ждёт, близко — уходит
        const g = ahead(leaderS, st.s)
        if (g < length / 2) target = Math.max(MIN_SPEED, Math.min(MAX_SPEED, SC_SPEED + 0.12 * (GAP - g)))
      }
      // в сторону: с выезда к середине трассы, перед въездом — к пит-лейну
      let wantL = st.phase === 'in' && ahead(st.s, entry.s) < TO_PIT ? entry.l : st.phase === 'in' || st.phase === 'lead' ? 0 : 3.5
      if (st.phase === 'out' && st.t > 6) wantL = 3.5
      // у самого въезда в пит-лейн объезд не нужен (там она уже не на трассе)
      const nearEntry = st.phase === 'in' && ahead(st.s, entry.s) < 60
      const way = nearEntry ? { l: wantL, v: target } : avoid(wantL, target)
      target = way.v
      const shift = way.l !== wantL ? AVOID_SHIFT : SHIFT_SPEED
      st.v += Math.max(-ACCEL * (hard ? 3 : 1.6) * dt, Math.min(ACCEL * dt, target - st.v))
      st.s = (st.s + st.v * dt) % length
      st.l += Math.max(-shift * dt, Math.min(shift * dt, way.l - st.l))
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
