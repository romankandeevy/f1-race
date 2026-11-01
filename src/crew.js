// Механики на пит-стопе (Рома 31.10: «анимация механиков»). Модель — public/models/crew.glb (Blender, tools/model/make_crew.py):
// механик с суставами (тело → плечо → предплечье, бедро → голень) и инструменты: гайковёрт, домкрат, табличка выпуска.
// Бригада из семи человек ждёт в своём боксе, пока болид подъезжает (ближе READY_DIST м): четыре механика с гайковёртами
// присели у колёс, передний и задний с домкратами, у носа — с табличкой. Болид встал — домкраты поднимают его, гайковёрты
// жужжат; обслужили — болид опускают, передний механик с домкратом уходит в сторону, табличка поднимается, болид уезжает,
// бригада встаёт и через пару секунд уходит в гараж (пропадает). Руки ставятся двухзвенной кинематикой к рукояткам инструментов.
// Цвет комбинезонов — цвет команды болида. Положение — в осях бокса (точка бокса на пит-лейне, ось — по ходу).
import * as THREE from 'three'
import { PropertyBinding } from 'three'

const READY_DIST = 70 // м до бокса: бригада выходит из гаража
const GONE_AFTER = 3 // с после выезда: бригада уходит
const LIFT = 0.06 // м: болид на домкратах
const POOL = 4 // бригад одновременно (больше пит-стопов разом почти не бывает)
// длины костей (из make_crew.py, оси three.js: механик смотрит в +Z, вверх +Y)
const UPPER = 0.29
const FORE = 0.31
const SHOULDER_Y = 0.45 // над тазом
const SHOULDER_X = 0.22
const HIP_H = 0.95 // таз над землёй стоя
const KNEEL_H = 0.5
// ступица колеса в осях болида (x — к левому борту, z — вперёд) и высота
const WHEEL_Z = [1.7, -1.7]
const WHEEL_X = [0.81, 0.754]
const HUB_Y = 0.36
const OUTER = 0.2 // полширины колеса до внешней стороны (с гайкой)

const nameOf = (n) => PropertyBinding.sanitizeNodeName(n)
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

// роли бригады: где стоит (оси болида), куда смотрит (yaw: 0 — по ходу болида), поза
function roles(garage) {
  const r = []
  for (let a = 0; a < 2; a++) {
    for (const sx of [1, -1]) {
      const x = sx * (WHEEL_X[a] + OUTER + 0.5)
      r.push({ kind: 'gun', wheel: { x: sx * (WHEEL_X[a] + OUTER + 0.05), z: WHEEL_Z[a] }, x, z: WHEEL_Z[a] + (a ? -0.08 : 0.08), yaw: -sx * Math.PI / 2, out: sx })
    }
  }
  r.push({ kind: 'jack', front: true, x: 0, z: 3.85, yaw: Math.PI, out: garage })
  r.push({ kind: 'jack', front: false, x: 0, z: -3.35, yaw: 0, out: garage })
  r.push({ kind: 'sign', x: garage * 1.35, z: 3.4, yaw: Math.PI - garage * 0.5, out: garage })
  return r
}

export function createCrew(scene, gltf, lane) {
  if (!gltf || !lane?.boxes?.length) return null
  const tpl = gltf.scene
  const find = (n) => tpl.getObjectByName(nameOf(n))
  const bodyTpl = find('mech_body')
  const tools = { gun: find('tool_gun'), jack: find('tool_jack'), sign: find('tool_sign') }
  if (!bodyTpl) return null
  // инструменты в модели стоят в стороне: начало каждого — в его рукоятке, обнуляем положение
  for (const t of Object.values(tools)) if (t) t.position.set(0, 0, 0)

  // точка бокса и направление пит-лейна
  const frames = lane.boxes.map((b) => {
    const a = lane.axis
    let i = 0
    while (i < lane.n - 1 && a[i].distance_m < b.s) i++
    const p = a[Math.max(0, i - 1)]
    const q = a[Math.min(lane.n - 1, i + 1)]
    const yaw = Math.atan2(q.x - p.x, q.z - p.z)
    const garage = Math.sign(b.off - lane.fast) || 1
    return { x: a[i].x + b.off * lane.nx[i], y: a[i].y ?? 0, z: a[i].z + b.off * lane.nz[i], yaw, garage }
  })

  function makeCrew() {
    const group = new THREE.Group()
    group.visible = false
    scene.add(group)
    const suit = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 })
    const people = []
    for (let k = 0; k < 7; k++) {
      const root = new THREE.Group()
      const body = bodyTpl.clone(true)
      body.position.set(0, HIP_H, 0)
      body.traverse((o) => {
        if (!o.isMesh) return
        o.castShadow = true
        if (o.material?.name === 'suit') o.material = suit
        else if (Array.isArray(o.material)) o.material = o.material.map((m) => (m.name === 'suit' ? suit : m))
      })
      const j = (n) => body.getObjectByName(nameOf(n))
      const p = {
        root,
        body,
        upL: j('mech_upperarm_L'),
        upR: j('mech_upperarm_R'),
        foL: j('mech_forearm_L'),
        foR: j('mech_forearm_R'),
        thL: j('mech_thigh_L'),
        thR: j('mech_thigh_R'),
        shL: j('mech_shin_L'),
        shR: j('mech_shin_R'),
        tool: null,
      }
      root.add(body)
      group.add(root)
      people.push(p)
    }
    return { group, suit, people, key: null, frame: null, roles: null, t: 0, leftT: 0, lift: 0 }
  }
  const pool = Array.from({ length: POOL }, makeCrew)

  function giveTool(p, kind) {
    if (p.toolKind === kind) return
    if (p.tool) p.root.remove(p.tool)
    p.tool = tools[kind] ? tools[kind].clone(true) : null
    p.toolKind = kind
    if (p.tool) {
      p.tool.traverse((o) => o.isMesh && (o.castShadow = true))
      p.root.add(p.tool)
    }
  }

  // двухзвенная рука в плоскости механика (y — вверх, z — вперёд): плечо в (sy, sz), цель (ty, tz) — оба в осях тела
  function reach(up, fo, sy, sz, ty, tz) {
    let dy = ty - sy
    let dz = tz - sz
    let d = Math.hypot(dy, dz)
    const max = UPPER + FORE - 0.002
    if (d > max) {
      dy *= max / d
      dz *= max / d
      d = max
    }
    d = Math.max(d, 0.08)
    const base = Math.atan2(dz, dy) // угол от +Y к +Z
    const al = Math.acos(Math.min(1, Math.max(-1, (UPPER * UPPER + d * d - FORE * FORE) / (2 * UPPER * d))))
    // локоть — вниз и назад: плечо отклоняем от цели к −Z
    const ua = base - al
    const ey = sy + UPPER * Math.cos(ua)
    const ez = sz + UPPER * Math.sin(ua)
    const fa = Math.atan2(sz + dz - ez, sy + dy - ey)
    // кость висит вдоль −Y; поворот x = φ ведёт её к (−cos φ, −sin φ): угол от +Y a ↔ φ = a − π (по знаку: z = −sin φ)
    up.rotation.set(Math.atan2(-Math.sin(ua), -Math.cos(ua)), 0, 0)
    const fw = Math.atan2(-Math.sin(fa), -Math.cos(fa))
    fo.rotation.set(fw - up.rotation.x, 0, 0)
  }
  const v3 = new THREE.Vector3()
  const invM = new THREE.Matrix4()
  // цель (в осях механика root) → в оси тела: учитываем наклон тела и высоту таза
  function toBody(p, y, z) {
    v3.set(0, y, z)
    p.body.updateMatrix()
    v3.applyMatrix4(invM.copy(p.body.matrix).invert())
    return v3
  }
  function arms(p, tL, tR) {
    // tL, tR — точки хвата в осях root: { y, z }
    const a = toBody(p, tL.y, tL.z)
    reach(p.upL, p.foL, SHOULDER_Y, 0, a.y, a.z)
    const b = toBody(p, tR.y, tR.z)
    reach(p.upR, p.foR, SHOULDER_Y, 0, b.y, b.z)
  }
  function legs(p, kind, k) {
    // k — доля позы (0 — стоит, 1 — полностью)
    if (kind === 'kneel') {
      p.thR.rotation.x = -0.15 * k
      p.shR.rotation.x = 1.5 * k
      p.thL.rotation.x = -1.45 * k
      p.shL.rotation.x = 1.45 * k
      p.body.position.y = HIP_H + (KNEEL_H - HIP_H) * k
    } else if (kind === 'brace') {
      p.thR.rotation.x = 0.35 * k
      p.shR.rotation.x = 0.25 * k
      p.thL.rotation.x = -0.55 * k
      p.shL.rotation.x = 0.5 * k
      p.body.position.y = HIP_H - 0.09 * k
    } else {
      p.thR.rotation.x = p.shR.rotation.x = p.thL.rotation.x = p.shL.rotation.x = 0
      p.body.position.y = HIP_H
    }
  }
  function run(p, phase, k) {
    const s = Math.sin(phase)
    p.thL.rotation.x = 0.55 * s * k
    p.thR.rotation.x = -0.55 * s * k
    p.shL.rotation.x = (0.3 + 0.5 * Math.max(0, -s)) * k
    p.shR.rotation.x = (0.3 + 0.5 * Math.max(0, s)) * k
    p.body.position.y = HIP_H - 0.03 + 0.03 * Math.abs(Math.cos(phase)) * k
  }

  // одна бригада на кадр: c — бригада, info — { phase, t, service, near }
  function pose(c, dt, info, carGroup) {
    const f = c.frame
    c.group.position.set(f.x, f.y, f.z)
    c.group.rotation.y = f.yaw
    const servicing = info.phase === 'service'
    const done = info.phase === 'release' || info.phase === 'out' || info.phase === 'done' || info.phase === 'gone'
    const sinceDone = done ? info.since : 0
    // подъём: домкраты поднимают за 0,25 с после остановки, опускают за 0,3 с до конца
    const liftK = servicing ? ease(info.t / 0.25) * (1 - ease((info.t - (info.service - 0.3)) / 0.25)) : 0
    c.lift = liftK
    if (carGroup && liftK > 0) carGroup.position.y += LIFT * liftK
    c.roles.forEach((r, i) => {
      const p = c.people[i]
      p.root.position.set(r.x, 0, r.z)
      p.root.rotation.set(0, r.yaw, 0)
      p.body.rotation.set(0, 0, 0)
      if (r.kind === 'gun') {
        giveTool(p, 'gun')
        // готов — присел у колеса; закончил — встаёт и отходит от болида (наружу)
        const up = done ? ease(sinceDone / 0.35) : 0
        const back = done ? ease((sinceDone - 0.2) / 0.6) * 1.1 : 0
        p.root.position.x += r.out * back
        legs(p, 'kneel', 1 - up)
        p.body.rotation.x = 0.3 * (1 - up)
        // гайковёрт — на ступице: в осях механика это прямо перед ним на расстоянии до колеса
        const reachZ = Math.abs(r.x - r.wheel.x) + back
        // головка гайковёрта на 0,26 м впереди рукоятки — упирается в гайку
        const gz = Math.max(0.2, reachZ - 0.26) * (1 - up) + 0.3 * up
        const gy = HUB_Y * (1 - up) + 0.95 * up
        // жужжит: во время обслуживания чуть дрожит
        const buzz = servicing ? Math.sin(info.t * 90) * 0.004 : 0
        p.tool.position.set(-0.05, gy - 0.08 + buzz, gz)
        p.tool.rotation.set(0, 0, servicing ? Math.sin(info.t * 70) * 0.03 : 0)
        arms(p, { y: gy + 0.03, z: gz - 0.08 }, { y: gy - 0.04, z: gz - 0.02 })
      } else if (r.kind === 'jack') {
        giveTool(p, 'jack')
        // передний: после обслуживания вытаскивает домкрат и уходит в сторону гаража (освобождает выезд)
        const aside = r.front && done ? ease(sinceDone / 0.5) : 0
        const away = !r.front && done ? ease(sinceDone / 0.6) : 0
        p.root.position.x += r.out * 2.4 * aside
        p.root.position.z += (r.front ? 0.6 : -0.9) * Math.max(aside, away)
        // ручка домкрата: опущена — болид поднят
        const press = liftK
        legs(p, 'brace', 1)
        p.body.rotation.x = 0.15 + 0.25 * press
        const hy = 0.95 - 0.35 * press
        p.tool.position.set(0, hy, 0.25 + 0.1 * press)
        // домкрат в модели: от ручки вперёд-вниз к опоре; наклоняем по высоте ручки
        p.tool.rotation.set(-0.35 * press, 0, 0)
        p.tool.scale.set(1, 1, 1)
        arms(p, { y: hy, z: 0.25 + 0.1 * press }, { y: hy, z: 0.25 + 0.1 * press })
        // ручка поперёк: руки чуть в стороны — двигать не нужно, плечи и так над ней
      } else {
        giveTool(p, 'sign')
        // табличка: пока обслуживают — опущена перед носом, обслужили — поднята вверх
        const upK = done ? ease(sinceDone / 0.25) : 0
        legs(p, 'stand', 0)
        p.tool.position.set(0.15, 0.95 + 0.6 * upK, 0.38 - 0.1 * upK)
        p.tool.rotation.set(0.2 - 0.2 * upK, 0, 0)
        arms(p, { y: 1.0 + 0.6 * upK, z: 0.35 - 0.1 * upK }, { y: 1.15 + 0.6 * upK, z: 0.32 - 0.1 * upK })
      }
    })
  }

  // все крутящиеся стоянки за кадр: stops — [{ key, ctl, box, group, color }]
  function update(dt, stops) {
    const seen = new Set()
    for (const s of stops) {
      const st = s.ctl?.state
      let c = pool.find((x) => x.key === s.key)
      const box = Math.max(0, s.box % frames.length)
      // где болид: подъезжает (in, ближе READY_DIST), стоит, выехал
      let phase = st?.phase ?? 'gone'
      if (phase === 'in' && st.s < lane.boxes[box].s - READY_DIST) phase = 'far'
      if (phase === 'far' || phase === 'abort' || (!c && (phase === 'out' || phase === 'done' || phase === 'gone'))) continue
      if (!c) {
        c = pool.find((x) => !x.key)
        if (!c) continue
        c.key = s.key
        c.frame = frames[box]
        c.roles = roles(c.frame.garage)
        c.suit.color.set(s.color || '#d0d0d0')
        c.leftT = 0
        c.group.visible = true
      }
      seen.add(c.key)
      if (phase === 'service') c.serviceT = st.t
      const done = phase === 'release' || phase === 'out' || phase === 'done' || phase === 'gone'
      c.leftT = done ? c.leftT + dt : 0
      pose(c, dt, { phase, t: st?.t ?? 0, service: st?.service ?? 2.5, since: c.leftT }, phase === 'service' || phase === 'release' ? s.group : null)
      if (c.leftT > GONE_AFTER + 1) free(c)
    }
    // стоянка пропала из списка (болид уехал, пит-контроллер обнулён) — бригада ещё немного стоит, потом уходит
    for (const c of pool) {
      if (!c.key || seen.has(c.key)) continue
      c.leftT += dt
      pose(c, dt, { phase: 'gone', t: 0, service: 2.5, since: c.leftT }, null)
      if (c.leftT > GONE_AFTER) free(c)
    }
  }
  function free(c) {
    c.key = null
    c.group.visible = false
  }
  function clear() {
    for (const c of pool) free(c)
  }
  return { update, clear }
}
