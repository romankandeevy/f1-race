// Гоночная линия на асфальте и тормозные таблички (Рома 31.10: обучение, «подсветку линии делать»).
// Линия — та же, по которой едут боты (createRaceLine, уровень «Средние»): лента шириной 1 м чуть над асфальтом,
// видна на 30…250 м впереди (дальше на скорости). Цвет — как в играх F1: зелёный — можно газ, жёлтый — сбрось,
// красный — тормози. Считается от твоей скорости: какое замедление нужно, чтобы к этой точке линии ехать не быстрее
// её скорости по профилю (need); больше 60% тормозов болида — красный, больше 20% — жёлтый. Режимы (Настройки → Помощники
// → «Гоночная линия»): off, brake — только где тормозить, full — вся. Обучение включает полную сама.
// Тормозные таблички 100 / 50 / 25 м — перед каждым сильным торможением по профилю (скорость падает больше чем на 12 м/с),
// отсчёт до точки, где торможение кончается; стоят с той стороны, где больше места, лицом к едущим. Видны всегда — как на
// настоящей трассе.
import * as THREE from 'three'

const HALF = 0.5 // м, полширины ленты
const LIFT = 0.1 // м над осью (ниже — вдали тонет в асфальте: полотно с горбом, края ниже оси)
const NEAR = 8 // точек (по 2 м) впереди — с них лента начинается
const BOARDS = [100, 50, 25]
const COLORS = { go: [0.15, 0.9, 0.3], lift: [1, 0.82, 0.1], brake: [1, 0.12, 0.08] }

function boardTexture(text) {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 96
  const g = c.getContext('2d')
  g.fillStyle = '#f4f4f2'
  g.fillRect(0, 0, 128, 96)
  g.strokeStyle = '#d7141a'
  g.lineWidth = 8
  g.strokeRect(4, 4, 120, 88)
  g.fillStyle = '#16181c'
  g.font = '900 italic 54px "Titillium Web", Arial, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, 64, 52)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

// track — circuit.js (axis), line — createRaceLine(...)
export function createRacingLine(scene, track, line) {
  const axis = track.axis
  const n = line.n
  const at = (i) => ((i % n) + n) % n
  // ---- лента ----
  const pos = new Float32Array(n * 2 * 3)
  const col = new Float32Array(n * 2 * 4)
  for (let i = 0; i < n; i++) {
    const a = at(i - 1)
    const b = at(i + 1)
    let dx = line.x[b] - line.x[a]
    let dz = line.z[b] - line.z[a]
    const len = Math.hypot(dx, dz) || 1
    dx /= len
    dz /= len
    // нормаль вбок
    const sx = dz * HALF
    const sz = -dx * HALF
    const y = (axis[i].y || 0) + LIFT
    pos.set([line.x[i] + sx, y, line.z[i] + sz, line.x[i] - sx, y, line.z[i] - sz], i * 6)
  }
  const idx = []
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    idx.push(i * 2, j * 2, i * 2 + 1, i * 2 + 1, j * 2, j * 2 + 1)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const colAttr = new THREE.BufferAttribute(col, 4)
  colAttr.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('color', colAttr)
  geo.setIndex(idx)
  geo.computeBoundingSphere()
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, toneMapped: false })
  const ribbon = new THREE.Mesh(geo, mat)
  ribbon.renderOrder = 2
  ribbon.frustumCulled = false
  ribbon.visible = false
  scene.add(ribbon)
  const painted = new Set()

  // ---- тормозные таблички ----
  const boards = new THREE.Group()
  boards.name = 'Тормозные таблички'
  const texs = Object.fromEntries(BOARDS.map((m) => [m, boardTexture(String(m))]))
  const postMat = new THREE.MeshLambertMaterial({ color: 0x2a2d33 })
  const postGeo = new THREE.BoxGeometry(0.08, 1.2, 0.08)
  const signGeo = new THREE.PlaneGeometry(1.3, 0.98)
  const sp = line.speed
  const ds = typeof line.ds === 'number' ? line.ds : (line.total ?? 2 * n) / n // ds у линии — массив длин отрезков; нам хватит среднего шага
  for (let i = 0; i < n; i++) {
    // конец торможения: здесь скорость минимальна, а за 150 м до неё была заметно выше
    const v = sp[i]
    if (!(v < sp[at(i - 1)] && v <= sp[at(i + 1)])) continue
    let peak = v
    for (let k = 1; k <= Math.round(150 / ds); k++) peak = Math.max(peak, sp[at(i - k)])
    if (peak - v < 12) continue
    for (const m of BOARDS) {
      const j = at(i - Math.round(m / ds))
      const a = axis[j]
      const b = axis[at(j + 1)]
      const yaw = Math.atan2(b.x - a.x, b.z - a.z)
      const wl = a.width_left ?? 6
      const wr = a.width_right ?? 6
      const side = wl >= wr ? 1 : -1
      const off = side * ((side > 0 ? wl : wr) + 3)
      // «влево» от направления: (cos yaw, −sin yaw) — как у оси в safetycar.js
      const x = a.x + Math.cos(yaw) * off
      const z = a.z - Math.sin(yaw) * off
      const y = a.y || 0
      const post = new THREE.Mesh(postGeo, postMat)
      post.position.set(x, y + 0.6, z)
      const sign = new THREE.Mesh(signGeo, new THREE.MeshLambertMaterial({ map: texs[m], emissive: 0xffffff, emissiveMap: texs[m], emissiveIntensity: 0.25 }))
      sign.position.set(x, y + 1.55, z)
      sign.rotation.y = yaw + Math.PI // лицом к едущим
      post.castShadow = sign.castShadow = true
      boards.add(post, sign)
    }
  }
  scene.add(boards)

  return {
    line,
    boards,
    // каждый кадр: i — точка оси, где болид; speed — м/с; mode — off | brake | full
    update(i, speed, mode) {
      ribbon.visible = mode !== 'off'
      if (!ribbon.visible) return
      for (const k of painted) col[k * 8 + 3] = col[k * 8 + 7] = 0
      painted.clear()
      const ahead = Math.round((30 + Math.min(220, speed * 3.2)) / ds)
      const v2 = speed * speed
      const cap = line.brakeAcc(Math.max(10, speed))
      for (let k = NEAR / 2; k < ahead; k++) {
        const j = at(i + k)
        const d = k * ds
        const t = sp[j]
        const need = (v2 - t * t) / (2 * d)
        const c = need > cap * 0.6 ? COLORS.brake : need > cap * 0.2 ? COLORS.lift : COLORS.go
        if (mode === 'brake' && c === COLORS.go) continue
        // края окна — плавно
        const a = Math.min(1, (k - NEAR / 2) / 6, (ahead - k) / 12) * 0.85
        col.set([...c, a, ...c, a], j * 8)
        painted.add(j)
      }
      colAttr.needsUpdate = true
    },
    dispose() {
      scene.remove(ribbon, boards)
      geo.dispose()
    },
  }
}
