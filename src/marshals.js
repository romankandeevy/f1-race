// Световые панели маршалов у трассы (10.11, Рома: «детализированнее, реалистичнее, с помощью Forma»).
// Модель — public/models/marshal.glb (Forma, «Световая панель маршала»: бетонное основание, оцинкованная стойка 3,7 м,
// панель 0,86 × 0,86 м с козырьком, блок управления, кабели; 3,8 тыс. треугольников; экран — деталь «Экран», лицом к +Z).
// Стоят через ~320 м по оси трассы, по очереди слева и справа, за ограждением: луч физики вбок от края асфальта находит
// стену — панель сразу за ней; стены нет — в 12 м от края (за гравием). Со стороны пит-лейна не ставим.
// Экран показывает то же, что флаги гонки (flags.js): жёлтый участок — мигает жёлтым, SC и VSC — все жёлтым,
// красный флаг — все красным, после нейтрализации и на старте — зелёный на несколько секунд; в остальное время погашен.
// Рисуется девятью вызовами на всю трассу: детали склеены по материалам в InstancedMesh, экраны — один InstancedMesh
// с цветом на панель (MeshBasicMaterial, яркость больше 1 — подхватывает свечение).
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const SPACING = 320 // м между панелями
const EYE = 0.7 // м над асфальтом: высота луча, который ищет ограждение
const REACH = 45 // м: дальше ограждение не ищем
const BEHIND = 0.9 // м за ограждением
const OPEN = 12 // м от края асфальта, если ограждения нет
const PIT_CLEAR = 14 // м: ближе к оси пит-лейна панель не ставим
const SCALE = 1.35 // модель 3,7 м с экраном 0,86 м; в игре крупнее — экран ~1,15 м читается на скорости с 150 м
const GREEN_TIME = 6 // с горит зелёный после старта и после нейтрализации
const OFF = [0.015, 0.016, 0.018]
const COLORS = { yellow: [3.2, 2.3, 0.1], red: [3.4, 0.12, 0.08], green: [0.15, 2.8, 0.5] }

// точки светодиодов: 24 × 24, мягкие кружки на чёрном
function ledTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 192
  const g = c.getContext('2d')
  g.fillStyle = '#000'
  g.fillRect(0, 0, 192, 192)
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const r = g.createRadialGradient(x * 8 + 4, y * 8 + 4, 0.5, x * 8 + 4, y * 8 + 4, 3.6)
      r.addColorStop(0, '#fff')
      r.addColorStop(0.55, '#bbb')
      r.addColorStop(1, '#000')
      g.fillStyle = r
      g.fillRect(x * 8, y * 8, 8, 8)
    }
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

// world, RAPIER — физика трассы (лучи к ограждению и к земле)
export function createMarshalPanels(scene, track, world, RAPIER) {
  const axis = track.axis || []
  const group = new THREE.Group()
  group.name = 'Световые панели маршалов'
  scene.add(group)
  let posts = null // [{ s, x, y, z, yaw }]
  let parts = null // { solids: [{ geometry, material }], led: geometry }
  let leds = null // InstancedMesh экранов
  let built = false
  let greenLeft = 0
  let lastMode = 'green'
  let shown = [] // что сейчас показывает панель — чтобы не писать цвет каждый кадр
  const color = new THREE.Color()

  new GLTFLoader().load('/models/marshal.glb', (gltf) => {
    const root = gltf.scene
    root.updateMatrixWorld(true)
    const byMat = new Map()
    let led = null
    root.traverse((o) => {
      if (!o.isMesh) return
      const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrixWorld)
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k)
      if (o.name === 'Экран') led = g
      else {
        if (!byMat.has(o.material)) byMat.set(o.material, [])
        byMat.get(o.material).push(g)
      }
    })
    if (!led) return
    parts = { solids: [...byMat].map(([material, list]) => ({ geometry: mergeGeometries(list), material })), led }
  }, undefined, () => {
    // нет файла — трасса просто без панелей
  })

  const toi = (hit) => hit?.timeOfImpact ?? hit?.toi ?? null
  const cast = (x, y, z, dx, dy, dz, max) => toi(world.castRay(new RAPIER.Ray({ x, y, z }, { x: dx, y: dy, z: dz }), max, true))
  const nearPit = (x, z) => (track.pit?.axis || []).some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < PIT_CLEAR * PIT_CLEAR)

  // место панели у точки оси i со стороны side (+1 слева, −1 справа); null — нельзя
  function place(i, side) {
    const a = axis[i]
    // влево от оси: (cos yaw, −sin yaw) — как в flags.js
    const lx = Math.cos(a.yaw) * side
    const lz = -Math.sin(a.yaw) * side
    const half = (side > 0 ? a.width_left : a.width_right) ?? 7
    const ox = a.x + lx * (half + 0.6)
    const oz = a.z + lz * (half + 0.6)
    const hit = cast(ox, (a.y || 0) + EYE, oz, lx, 0, lz, REACH)
    const d = hit === null ? OPEN : hit + BEHIND
    if (hit !== null && hit < 1.2) return null // стена вплотную к асфальту с этой стороны и луч начался в ней — не рискуем
    const x = ox + lx * d
    const z = oz + lz * d
    if (nearPit(x, z)) return null
    const down = cast(x, (a.y || 0) + 40, z, 0, -1, 0, 120)
    const y = down === null ? a.y || 0 : (a.y || 0) + 40 - down
    if (Math.abs(y - (a.y || 0)) > 6) return null // крыша здания или обрыв
    // лицом к едущим: смотрит на ось трассы в 70 м раньше по ходу
    const back = axis[(i - 35 + axis.length) % axis.length]
    return { s: a.distance_m, x, y, z, yaw: Math.atan2(back.x - x, back.z - z) }
  }

  function build() {
    built = true
    const n = axis.length
    const count = Math.max(4, Math.round(track.length / SPACING))
    posts = []
    for (let k = 0; k < count; k++) {
      const i = Math.floor(((k + 0.5) / count) * n)
      const side = k % 2 ? -1 : 1
      // сначала своя сторона, потом другая; не вышло — сдвигаемся на 30 м вперёд, до трёх раз
      let p = null
      for (let shift = 0; shift < 4 && !p; shift++) p = place((i + shift * 15) % n, side) || place((i + shift * 15) % n, -side)
      if (p) posts.push(p)
    }
    if (!posts.length) return
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const one = new THREE.Vector3(SCALE, SCALE, SCALE)
    const mats = posts.map((p) => m.clone().compose(new THREE.Vector3(p.x, p.y - 0.06, p.z), q.setFromAxisAngle(up, p.yaw), one))
    const fill = (mesh) => {
      mats.forEach((mm, k) => mesh.setMatrixAt(k, mm))
      mesh.instanceMatrix.needsUpdate = true
      mesh.frustumCulled = false // панели разбросаны по всей трассе: общий объём — вся трасса
      mesh.receiveShadow = true
      group.add(mesh)
    }
    for (const s of parts.solids) fill(new THREE.InstancedMesh(s.geometry, s.material, posts.length))
    leds = new THREE.InstancedMesh(parts.led, new THREE.MeshBasicMaterial({ map: ledTexture(), toneMapped: false }), posts.length)
    fill(leds)
    shown = posts.map(() => '')
    posts.forEach((_, k) => leds.setColorAt(k, color.setRGB(...OFF)))
    leds.instanceColor.needsUpdate = true
  }

  return {
    group,
    get posts() {
      return posts
    },
    // зелёный на всех панелях на GREEN_TIME секунд (погасли огни старта)
    green() {
      greenLeft = GREEN_TIME
    },
    // flags — createFlags(...) или null (вне гонки панели погашены); t — время, с; dt — шаг кадра
    update(dt, t, flags) {
      if (!built) {
        // физика должна шагнуть хотя бы раз, иначе лучи не видят трассу
        if (parts && axis.length > 50 && t > 0.5) build()
        return
      }
      if (!leds) return
      const mode = flags?.mode ?? 'green'
      if (mode !== lastMode) {
        if (mode === 'green' && lastMode !== 'green') greenLeft = GREEN_TIME
        lastMode = mode
      }
      if (!flags) greenLeft = 0
      else if (greenLeft > 0) greenLeft -= dt
      const blink = (t * 2) % 1 < 0.55 // два раза в секунду
      const any = flags?.incidents.some((i) => !i.cleared)
      let dirty = false
      for (let k = 0; k < posts.length; k++) {
        let want = 'off'
        if (mode === 'red') want = blink ? 'red' : 'off'
        else if (mode === 'sc' || mode === 'vsc') want = blink ? 'yellow' : 'off'
        else if (any && flags.inYellow(posts[k].s)) want = blink ? 'yellow' : 'off'
        else if (greenLeft > 0) want = 'green'
        if (shown[k] === want) continue
        shown[k] = want
        leds.setColorAt(k, color.setRGB(...(COLORS[want] || OFF)))
        dirty = true
      }
      if (dirty) leds.instanceColor.needsUpdate = true
    },
  }
}
