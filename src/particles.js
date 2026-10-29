// Частицы (Рома 29.10: «частицы, вспышки»): искры, дым шин, гравий и пыль с обочины, дым мотора.
// Всё — точки (THREE.Points) с готовыми буферами: частицы не создаются, а берутся по кругу из пула,
// поэтому в кадре ничего не выделяется в памяти. Источники читаются из физики (vehicle.js):
//   искры      — днище по асфальту (state.plankContact: низкий клиренс, оторванное колесо, сломанная подвеска) и удары (impactShake)
//   дым шин    — блокировка, пробуксовка, сильный занос (w.sliding, большой увод) на асфальте и поребрике
//   гравий     — камешки и пыль из-под колёс на гравии; на траве — комья и пыль
//   дым мотора — отказ силовой установки (чёрный) и перегрев (белый пар)
import * as THREE from 'three'

const VERT = `
attribute float size;
attribute float alpha;
attribute vec3 tint;
uniform float uScale;
varying float vAlpha;
varying vec3 vTint;
void main() {
  vAlpha = alpha;
  vTint = tint;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = alpha > 0.0 ? max(1.0, size * uScale / -mv.z) : 0.0;
  gl_Position = projectionMatrix * mv;
}`
const FRAG = `
uniform float uSoft;
varying float vAlpha;
varying vec3 vTint;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = vAlpha * (1.0 - smoothstep(uSoft, 1.0, d));
  if (a < 0.003) discard;
  gl_FragColor = vec4(vTint, a);
}`

const FAR = 150 // м от камеры: дальше частицы не рождаются
const rnd = (a, b) => a + Math.random() * (b - a)

// пул частиц одного вида; emit(...) кладёт частицу на место самой старой
function createPool(scene, n, { additive = false, soft = 0, order = 10, fadeIn = false }) {
  const pos = new Float32Array(n * 3)
  const tint = new Float32Array(n * 3)
  const size = new Float32Array(n)
  const alpha = new Float32Array(n)
  const vel = new Float32Array(n * 3)
  const life = new Float32Array(n)
  const age = new Float32Array(n)
  const s0 = new Float32Array(n)
  const grow = new Float32Array(n)
  const a0 = new Float32Array(n)
  const grav = new Float32Array(n)
  const drag = new Float32Array(n)
  const floor = new Float32Array(n).fill(-1e9)
  const geo = new THREE.BufferGeometry()
  const attr = (arr, k) => new THREE.BufferAttribute(arr, k).setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('position', attr(pos, 3))
  geo.setAttribute('tint', attr(tint, 3))
  geo.setAttribute('size', attr(size, 1))
  geo.setAttribute('alpha', attr(alpha, 1))
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 800 }, uSoft: { value: soft } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  points.renderOrder = order
  scene.add(points)
  let next = 0
  let active = false

  return {
    mat,
    emit(x, y, z, vx, vy, vz, lifeS, sz, gr, r, g, b, a, gravity, dragK, floorY = -1e9) {
      const i = next
      next = (next + 1) % n
      pos[i * 3] = x
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = z
      vel[i * 3] = vx
      vel[i * 3 + 1] = vy
      vel[i * 3 + 2] = vz
      tint[i * 3] = r
      tint[i * 3 + 1] = g
      tint[i * 3 + 2] = b
      life[i] = lifeS
      age[i] = 0
      s0[i] = size[i] = sz
      grow[i] = gr
      a0[i] = a
      alpha[i] = fadeIn ? 0 : a
      grav[i] = gravity
      drag[i] = dragK
      floor[i] = floorY
      active = true
    },
    update(dt) {
      if (!active) return
      let alive = false
      for (let i = 0; i < n; i++) {
        if (age[i] >= life[i]) {
          alpha[i] = 0
          continue
        }
        alive = true
        age[i] += dt
        const t = age[i] / life[i]
        const k = Math.exp(-drag[i] * dt)
        const j = i * 3
        vel[j + 1] += grav[i] * dt
        vel[j] *= k
        vel[j + 1] *= k
        vel[j + 2] *= k
        pos[j] += vel[j] * dt
        pos[j + 1] += vel[j + 1] * dt
        pos[j + 2] += vel[j + 2] * dt
        // искры и камешки отскакивают от земли и теряют скорость
        if (pos[j + 1] < floor[i]) {
          pos[j + 1] = floor[i]
          vel[j + 1] = -vel[j + 1] * 0.3
          vel[j] *= 0.6
          vel[j + 2] *= 0.6
        }
        size[i] = s0[i] + grow[i] * age[i]
        alpha[i] = Math.max(0, a0[i] * (fadeIn ? Math.min(1, t * 8) : 1) * (1 - t))
      }
      const g = geo.attributes
      g.position.needsUpdate = g.size.needsUpdate = g.alpha.needsUpdate = g.tint.needsUpdate = true
      active = alive
    },
    clear() {
      life.fill(0)
      age.fill(0)
      alpha.fill(0)
      geo.attributes.alpha.needsUpdate = true
      active = false
    },
  }
}

export function createParticles(scene) {
  const sparks = createPool(scene, 1400, { additive: true, soft: 0.45, order: 12 })
  const smoke = createPool(scene, 700, { soft: 0, order: 10, fadeIn: true })
  const bits = createPool(scene, 700, { soft: 0.55, order: 11 })
  const pools = [sparks, smoke, bits]
  const state = new WeakMap() // свои счётчики у каждого болида: сколько частиц «накопилось» к рождению
  const q = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const buf = new THREE.Vector2()

  // точка в осях болида (как в модели: нос +Z, верх +Y) → мир
  const local = (v, x, y, z) => {
    const r = v.body.rotation()
    const t = v.body.translation()
    q.set(r.x, r.y, r.z, r.w)
    p.set(x, y, z).applyQuaternion(q)
    p.x += t.x
    p.y += t.y
    p.z += t.z
    return p
  }
  // дробное число частиц за кадр: копим до целого
  const count = (st, key, rate, dt) => {
    st[key] = (st[key] || 0) + rate * dt
    const n = Math.floor(st[key])
    st[key] -= n
    return n
  }

  function emitCar(v, dt, cam) {
    const t = v.body.translation()
    if ((t.x - cam.x) ** 2 + (t.z - cam.z) ** 2 > FAR * FAR) return
    let st = state.get(v)
    if (!st) state.set(v, (st = { shake: 0 }))
    const lv = v.body.linvel()
    const speed = Math.hypot(lv.x, lv.z)

    // 1. днище по асфальту: искры из-под планки (в F1 — титановые накладки), летят назад и вверх, отскакивают от асфальта
    const pc = v.state.plankContact
    if (pc > 300 && speed > 6) {
      const n = count(st, 'spark', Math.min(1, pc / 12000) * 900 * Math.min(1, speed / 30), dt)
      for (let k = 0; k < n; k++) {
        const w = local(v, rnd(-0.18, 0.18), 0.03, rnd(-1.25, 0.9))
        const m = rnd(0.3, 0.75)
        sparks.emit(w.x, w.y, w.z, lv.x * m + rnd(-1.5, 1.5), rnd(0.5, 3.2), lv.z * m + rnd(-1.5, 1.5), rnd(0.18, 0.5), rnd(0.03, 0.06), -0.03, 1, rnd(0.75, 0.95), rnd(0.35, 0.6), 1, -9.8, 1.2, t.y + 0.01)
      }
    }

    // 2. удар: сноп искр по корпусу
    if (v.impactShake > st.shake + 0.12) {
      const n = Math.round(30 + 70 * v.impactShake)
      for (let k = 0; k < n; k++) {
        const w = local(v, rnd(-0.95, 0.95), rnd(0.1, 0.5), rnd(-2.4, 2.6))
        sparks.emit(w.x, w.y, w.z, lv.x * 0.4 + rnd(-6, 6), rnd(1, 6), lv.z * 0.4 + rnd(-6, 6), rnd(0.25, 0.7), rnd(0.03, 0.07), -0.03, 1, rnd(0.75, 0.95), rnd(0.35, 0.6), 1, -9.8, 1.5, t.y + 0.01)
      }
    }
    st.shake = v.impactShake

    // 3. колёса
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i]
      if (!w.contact || v.damage.lost[i]) continue
      const surf = w.surface
      if (surf === 'asphalt' || surf === 'kerb') {
        // дым шин: блокировка, пробуксовка, сильный занос
        const slide = w.sliding || Math.abs(w.slip) > 0.16
        if (!slide || speed < 4) continue
        const n = count(st, 'smoke' + i, 40 * Math.min(1, speed / 20), dt)
        for (let k = 0; k < n; k++) {
          const g = rnd(0.86, 0.96)
          smoke.emit(w.point.x + rnd(-0.15, 0.15), w.point.y + 0.15, w.point.z + rnd(-0.15, 0.15), lv.x * 0.25 + rnd(-0.6, 0.6), rnd(0.3, 0.9), lv.z * 0.25 + rnd(-0.6, 0.6), rnd(1, 1.8), rnd(0.35, 0.55), 1.3, g, g, g, 0.42, 0.25, 1.2)
        }
      } else if ((surf === 'gravel' || surf === 'grass') && speed > 3) {
        // гравий и трава: камешки/комья из-под колёс (задние сильнее — они тянут) и облако пыли
        const gravel = surf === 'gravel'
        const rate = (w.front ? 0.5 : 1) * (20 + speed * 4)
        const n = count(st, 'bits' + i, rate, dt)
        for (let k = 0; k < n; k++) {
          const m = rnd(0.15, 0.5)
          const c = gravel ? rnd(0.85, 1.1) : 1
          const soil = !gravel && Math.random() < 0.4
          const [r, g, b] = gravel ? [0.66 * c, 0.58 * c, 0.45 * c] : soil ? [0.36, 0.27, 0.17] : [0.28, 0.42, 0.16]
          bits.emit(w.point.x, w.point.y + 0.05, w.point.z, lv.x * m + rnd(-1.6, 1.6), rnd(1.2, 3.8), lv.z * m + rnd(-1.6, 1.6), rnd(0.5, 1), rnd(0.06, 0.11), 0, r, g, b, 1, -9.8, 0.8, w.point.y)
        }
        const nd = count(st, 'dust' + i, rate * 0.35, dt)
        for (let k = 0; k < nd; k++) {
          const [r, g, b] = gravel ? [0.74, 0.66, 0.52] : [0.52, 0.47, 0.36]
          smoke.emit(w.point.x, w.point.y + 0.2, w.point.z, lv.x * 0.3 + rnd(-0.8, 0.8), rnd(0.4, 1.2), lv.z * 0.3 + rnd(-0.8, 0.8), rnd(1.2, 2.2), rnd(0.45, 0.7), 1.6, r, g, b, gravel ? 0.28 : 0.2, 0.1, 1.4)
        }
      }
    }

    // 4. мотор: отказ — чёрный дым, перегрев — белый пар из выхлопа
    const failed = v.pu.failed
    if (failed || v.engineHeat > 1.0) {
      const n = count(st, 'engine', failed ? 28 : 18, dt)
      for (let k = 0; k < n; k++) {
        const w = local(v, rnd(-0.05, 0.05), 0.5, -2.15)
        const g = failed ? rnd(0.12, 0.22) : rnd(0.85, 0.95)
        smoke.emit(w.x, w.y, w.z, lv.x * 0.3 + rnd(-0.4, 0.4), rnd(0.6, 1.3), lv.z * 0.3 + rnd(-0.4, 0.4), rnd(1.5, 2.5), rnd(0.25, 0.4), 1.5, g, g, g, failed ? 0.5 : 0.28, 0.35, 0.9)
      }
    }
  }

  return {
    // раз в кадр после того, как болиды выставлены; dt = 0 на паузе — всё замирает
    update(dt, player, bots, camera, renderer) {
      if (dt <= 0) return
      const cam = camera.position
      emitCar(player, dt, cam)
      if (bots) for (const b of bots) if (!b.gone) emitCar(b.v, dt, cam)
      // размер точки на экране: метры → пиксели (высота кадра в пикселях / 2·tg(половины угла обзора))
      renderer.getDrawingBufferSize(buf)
      const scale = buf.y / (2 * Math.tan((camera.fov * Math.PI) / 360))
      for (const pool of pools) {
        pool.mat.uniforms.uScale.value = scale
        pool.update(dt)
      }
    },
    clear() {
      for (const pool of pools) pool.clear()
    },
  }
}
