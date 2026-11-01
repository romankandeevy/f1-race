// Обломки (Рома 29.10).
// Обломки: при ударе от болида отлетают куски карбона (и крашеные — цветом болида), кувыркаются, отскакивают
// и остаются лежать на трассе; болид, проехавший рядом, их подбрасывает. На физику болидов не влияют.
// Следов шин на трассе нет (Рома 01.11: «убери полностью след колёс с трассы»; были тёмные полосы от блокировки и заноса) — не возвращать.
// Всё — готовые буферы по кругу: в кадре ничего не создаётся.
import * as THREE from 'three'

const DEBRIS_MAX = 260
const DEBRIS_PER_HIT = 14
const KICK_R = 1.3 // м: ближе — колесо/днище подбрасывает обломок
const rnd = (a, b) => a + Math.random() * (b - a)
const CARBON = new THREE.Color(0x141414)

// точка удара в осях болида: нос +Z, левый борт +X
const ZONES = {
  front: [0, 0.15, 2.6, 0.9, 0.3],
  rear: [0, 0.6, -2.3, 0.6, 0.3],
  left: [0.85, 0.3, 0, 0.15, 1.6],
  right: [-0.85, 0.3, 0, 0.15, 1.6],
}

function createDebris(scene) {
  const geo = new THREE.BoxGeometry(0.2, 0.012, 0.11)
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.2 })
  const mesh = new THREE.InstancedMesh(geo, mat, DEBRIS_MAX)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.count = 0
  mesh.frustumCulled = false
  mesh.castShadow = false
  for (let i = 0; i < DEBRIS_MAX; i++) mesh.setColorAt(i, CARBON)
  scene.add(mesh)
  const P = Array.from({ length: DEBRIS_MAX }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), s: 1, floor: 0, rest: true }))
  let next = 0
  let used = 0
  let moving = false
  const m4 = new THREE.Matrix4()
  const sc = new THREE.Vector3()
  const dq = new THREE.Quaternion()
  const tmp = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const color = new THREE.Color()
  const euler = new THREE.Euler()

  const write = (i) => {
    const d = P[i]
    sc.set(d.s, 1, d.s * rnd(0.8, 1.2))
    m4.compose(d.p, d.q, sc)
    mesh.setMatrixAt(i, m4)
  }

  return {
    // удар: r — результат applyImpact (sev, zone, broke, big); paint — цвет болида.
    // Обломков столько, сколько реально отломилось (Рома 29.10: «не от мелкого столкновения… пропорционально»):
    // царапина и касание — ни одного, разбитая часть второй раз не сыплется. В основном мелкая крошка карбона 4–12 см,
    // крупный кусок (половина крыла, шайба) — только когда часть разрушена этим ударом.
    spawn(v, r, paint) {
      const z = ZONES[r.zone] || ZONES.front
      const broke = r.broke ?? r.sev
      if (broke < 0.35) return // до ~25 км/ч в стену — только царапины
      const big = r.big || 0
      const n = Math.min(DEBRIS_PER_HIT, Math.round(broke * 7) + big)
      const t = v.body.translation()
      const rot = v.body.rotation()
      const lv = v.body.linvel()
      q.set(rot.x, rot.y, rot.z, rot.w)
      for (let k = 0; k < n; k++) {
        const i = next
        next = (next + 1) % DEBRIS_MAX
        used = Math.min(DEBRIS_MAX, used + 1)
        const d = P[i]
        tmp.set(z[0] + rnd(-z[3], z[3]), z[1] + rnd(0, 0.25), z[2] + rnd(-z[4], z[4])).applyQuaternion(q)
        d.p.set(t.x + tmp.x, t.y + tmp.y, t.z + tmp.z)
        const m = rnd(0.2, 0.8)
        const kick = 1 + 3 * r.sev
        d.v.set(lv.x * m + rnd(-kick, kick), rnd(0.5, 1 + 3 * r.sev), lv.z * m + rnd(-kick, kick))
        d.q.setFromEuler(euler.set(rnd(0, 6.3), rnd(0, 6.3), rnd(0, 6.3)))
        d.w.set(rnd(-14, 14), rnd(-14, 14), rnd(-14, 14))
        d.s = k < big ? rnd(1.6, 2.6) : rnd(0.2, 0.6)
        d.floor = t.y + 0.008
        d.rest = false
        mesh.setColorAt(i, paint && Math.random() < 0.35 ? color.set(paint) : CARBON)
        write(i)
      }
      mesh.count = used
      mesh.instanceColor.needsUpdate = true
      mesh.instanceMatrix.needsUpdate = true
      moving = true
    },
    update(dt, cars) {
      if (!used) return
      // проехал рядом — обломок подпрыгивает и летит
      for (const v of cars) {
        const t = v.body.translation()
        const lv = v.body.linvel()
        const sp = Math.hypot(lv.x, lv.z)
        if (sp < 3) continue
        for (let i = 0; i < used; i++) {
          const d = P[i]
          if (!d.rest && d.v.lengthSq() > 4) continue // уже летит
          const dx = d.p.x - t.x
          const dz = d.p.z - t.z
          if (dx * dx + dz * dz > 2.6 * 2.6) continue
          // габарит болида ~1,9 × 5,4 м: в его осях
          const r = v.body.rotation()
          q.set(r.x, r.y, r.z, -r.w) // обратный поворот
          tmp.set(dx, 0, dz).applyQuaternion(q)
          if (Math.abs(tmp.x) > 0.95 + KICK_R * 0.3 || Math.abs(tmp.z) > 2.7) continue
          const m = rnd(0.3, 0.9)
          d.v.set(lv.x * m + rnd(-2, 2), rnd(0.5, 2.5) + sp * 0.02, lv.z * m + rnd(-2, 2))
          d.w.set(rnd(-18, 18), rnd(-18, 18), rnd(-18, 18))
          d.rest = false
          moving = true
        }
      }
      if (!moving) return
      let any = false
      for (let i = 0; i < used; i++) {
        const d = P[i]
        if (d.rest) continue
        any = true
        d.v.y -= 9.8 * dt
        d.p.addScaledVector(d.v, dt)
        const ang = d.w.length()
        if (ang > 1e-3) {
          dq.setFromAxisAngle(tmp.copy(d.w).divideScalar(ang), ang * dt)
          d.q.premultiply(dq)
        }
        if (d.p.y < d.floor) {
          d.p.y = d.floor
          d.v.y = -d.v.y * 0.25
          d.v.x *= 0.55
          d.v.z *= 0.55
          d.w.multiplyScalar(0.5)
          // успокоился — ложится плашмя
          if (Math.abs(d.v.y) < 0.4 && Math.hypot(d.v.x, d.v.z) < 0.4) {
            d.rest = true
            const yaw = Math.atan2(2 * (d.q.w * d.q.y + d.q.x * d.q.z), 1 - 2 * (d.q.y * d.q.y + d.q.x * d.q.x))
            d.q.setFromAxisAngle(tmp.set(0, 1, 0), yaw)
          }
        }
        write(i)
      }
      mesh.instanceMatrix.needsUpdate = true
      moving = any
    },
    clear() {
      used = 0
      next = 0
      mesh.count = 0
      moving = false
    },
  }
}

export function createTrackMarks(scene) {
  const debris = createDebris(scene)
  const cars = []
  return {
    debris,
    // раз в кадр: все болиды (игрок и не убранные боты)
    update(dt, player, bots) {
      if (dt <= 0) return
      cars.length = 0
      cars.push(player)
      if (bots) for (const b of bots) if (!b.gone) cars.push(b.v)
      debris.update(dt, cars)
    },
    clear() {
      debris.clear()
    },
  }
}
