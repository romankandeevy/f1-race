import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { TUNING } from './tuning.js'

const WHEELS = ['FL', 'FR', 'RL', 'RR']
const MAX_SPIN_PER_FRAME = 0.5 // рад за кадр, ~29°
export const PAINTS = ['#c4101a', '#f07a12', '#0d7a55', '#1f5fbf', '#e9e6df', '#1a1c20']

// Цвет маркировки на боковине по составу, как у Pirelli: мягкие красные, средние жёлтые, твёрдые белые.
// В модели есть только красные (мягкие): остальные делаем из той же картинки, переводя красный в нужный цвет.
// Рома 29.10: «шины не меняются, хотя на диске I у нас есть модель шин» — та модель (80 МБ, все пять комплектов) в игру не идёт,
// а перекраска боковины даёт то же самое по виду за пару мегабайт.
const TYRE_MARK = { soft: null, medium: [255, 196, 0], hard: [244, 244, 242] }

function recolorSidewall(map, rgb) {
  const img = map.image
  const w = img.width
  const h = img.height
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const c = cv.getContext('2d', { willReadFrequently: true })
  c.drawImage(img, 0, 0)
  const px = c.getImageData(0, 0, w, h)
  const d = px.data
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]
    const g = d[i + 1]
    const b = d[i + 2]
    // «красность»: насколько красный перевешивает остальные; у чёрной резины и серых надписей она ~0
    const red = Math.max(0, r - Math.max(g, b))
    if (red < 6) continue
    const k = Math.min(1, red / Math.max(1, r))
    const base = Math.max(g, b)
    d[i] = base + (rgb[0] * (r / 255) - base) * k
    d[i + 1] = base + (rgb[1] * (r / 255) - base) * k
    d[i + 2] = base + (rgb[2] * (r / 255) - base) * k
  }
  c.putImageData(px, 0, 0)
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = map.colorSpace
  t.flipY = map.flipY
  t.wrapS = map.wrapS
  t.wrapT = map.wrapT
  t.anisotropy = map.anisotropy
  return t
}

// Загружает модель болида, подготавливает её к игре и привязывает к физике.
export async function loadCar(url, renderer, onProgress) {
  const gltf = await new GLTFLoader().loadAsync(url, onProgress)
  const scene = gltf.scene

  // рабочая подсветка редактора в игре не нужна
  const trash = []
  scene.traverse((o) => {
    if (o.isLight || o.userData?.lumenRig) trash.push(o)
  })
  trash.forEach((o) => o.removeFromParent())

  const carRoot = scene.getObjectByName('car_root')
  const need = ['body', 'drs_flap', 'cam_onboard', ...WHEELS.map((k) => 'wheel_' + k)]
  for (const name of need) {
    if (!carRoot.getObjectByName(name)) throw new Error('В модели нет узла ' + name)
  }
  carRoot.getObjectByName('collider_body')?.removeFromParent()

  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  const materials = {}
  const textures = new Set()
  const sidewalls = [] // боковины шин: на них меняем материал под состав
  carRoot.traverse((o) => {
    if (!o.isMesh) return
    o.castShadow = true
    o.receiveShadow = true
    const list = Array.isArray(o.material) ? o.material : [o.material]
    if (list.some((m) => m.name === 'tyre_sidewall_soft')) sidewalls.push(o)
    for (const m of list) {
      materials[m.name] = m
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
        if (!m[key]) continue
        m[key].anisotropy = maxAniso
        textures.add(m[key])
      }
    }
  })

  // боковины под состав: красная — из модели, жёлтую и белую делаем из неё же (пока картинка ещё не выгружена)
  const sidewallMats = { soft: materials.tyre_sidewall_soft }
  if (materials.tyre_sidewall_soft?.map?.image) {
    const src = materials.tyre_sidewall_soft
    for (const [id, rgb] of Object.entries(TYRE_MARK)) {
      if (!rgb) continue
      const m = src.clone()
      m.name = 'tyre_sidewall_' + id
      m.map = recolorSidewall(src.map, rgb)
      sidewallMats[id] = m
      textures.add(m.map)
    }
  }

  // Картинки текстур нужны только чтобы один раз отправить их в видеокарту. После этого
  // распакованная копия в обычной памяти (~60 МБ) больше не нужна — отпускаем её.
  for (const t of textures) renderer.initTexture(t)
  for (const t of textures) {
    const img = t.image
    if (!img || !img.width) continue
    const size = { width: img.width, height: img.height }
    if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) img.close()
    t.source.data = size
  }

  // заготовка для копий (боты): геометрия и текстуры общие, копируются только узлы
  const template = scene.clone(true)
  const car = build(scene, carRoot, materials, sidewalls, sidewallMats)
  // копия болида для бота: свой цвет и свои стоп-сигналы, тени не отбрасывает (дорого)
  car.spawn = (paint) => {
    const copy = template.clone(true)
    const own = {}
    copy.traverse((o) => {
      if (!o.isMesh) return
      o.castShadow = false
      const swap = (m) => {
        if (!PER_CAR.includes(m.name)) return m
        if (!own[m.name]) own[m.name] = m.clone()
        return own[m.name]
      }
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material)
    })
    const botSidewalls = []
    copy.traverse((o) => {
      if (o.isMesh && [].concat(o.material).some((m) => m.name === 'tyre_sidewall_soft')) botSidewalls.push(o)
    })
    const bot = build(copy, copy.getObjectByName('car_root'), { ...materials, ...own }, botSidewalls, sidewallMats)
    bot.setLivery({ primary: paint, secondary: car.defaults.secondary, accent: car.defaults.accent })
    return bot
  }
  return car
}

// материалы, которые у каждого болида свои: цвет кузова и то, что светится при торможении
const PER_CAR = ['paint', 'paint_secondary', 'accent_blue', 'light_rear', 'brake_disc']

function build(scene, carRoot, materials, sidewalls = [], sidewallMats = {}) {
  // у колеса центр вращения на оси: оборачиваем его, чтобы отдельно рулить и крутить
  const wheels = WHEELS.map((k) => {
    const node = carRoot.getObjectByName('wheel_' + k)
    // pivot — поворот руля и схождение (вокруг вертикали), camber — развал (вокруг оси вперёд),
    // внутри колесо крутится вокруг своей оси
    const pivot = new THREE.Group()
    pivot.name = 'pivot_' + k
    pivot.position.copy(node.position)
    carRoot.add(pivot)
    const camber = new THREE.Group()
    camber.name = 'camber_' + k
    pivot.add(camber)
    node.position.set(0, 0, 0)
    camber.add(node)
    return { pivot, camber, node, side: pivot.position.x > 0 ? 1 : -1 }
  })

  const group = new THREE.Group()
  group.add(scene)

  const drs = carRoot.getObjectByName('drs_flap')
  const frontWingNode = carRoot.getObjectByName('front_wing')
  const rearWingNode = carRoot.getObjectByName('rear_wing')
  const onboard = carRoot.getObjectByName('cam_onboard')

  const prev = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() }
  const cur = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() }
  let first = true

  let current = 'soft'
  const car = {
    group,
    onboard,
    materials,

    setPaint(hex) {
      materials.paint?.color.set(hex)
    },

    // состав шин: цвет маркировки на боковинах (мягкие красные, средние жёлтые, твёрдые белые); вызывать можно каждый кадр
    setCompound(id) {
      const m = sidewallMats[id] || sidewallMats.soft
      if (!m || current === id) return
      current = id
      for (const o of sidewalls) o.material = Array.isArray(o.material) ? o.material.map(() => m) : m
    },

    // ливрея: кузов, белая зона вокруг кокпита и низ крыльев (любой из трёх можно не указывать)
    setLivery({ primary, secondary, accent }) {
      if (primary) materials.paint?.color.set(primary)
      if (secondary) materials.paint_secondary?.color.set(secondary)
      if (accent) materials.accent_blue?.color.set(accent)
    },

    // цвета из самой модели: ими красим соперников, чтобы они не наследовали ливрею игрока
    defaults: {
      secondary: '#' + (materials.paint_secondary?.color.getHexString() ?? 'f2f0ea'),
      accent: '#' + (materials.accent_blue?.color.getHexString() ?? '2845c8'),
    },

    // вызывать перед каждым шагом физики
    snapshot(body) {
      const t = body.translation()
      const r = body.rotation()
      if (first) {
        cur.pos.set(t.x, t.y, t.z)
        cur.quat.set(r.x, r.y, r.z, r.w)
        first = false
      }
      prev.pos.copy(cur.pos)
      prev.quat.copy(cur.quat)
      cur.pos.set(t.x, t.y, t.z)
      cur.quat.set(r.x, r.y, r.z, r.w)
    },

    sync(alpha, v, input) {
      group.position.lerpVectors(prev.pos, cur.pos, alpha)
      group.quaternion.slerpQuaternions(prev.quat, cur.quat, alpha)

      for (let i = 0; i < 4; i++) {
        const w = wheels[i]
        const pw = v.wheels[i]
        // ход подвески: центр колеса в осях кузова (клиренс и сжатие)
        w.pivot.position.y = pw.centerY
        // оторванное колесо исчезает с оси (в F1 оно ещё висит на тросах, но ехать уже нельзя)
        w.node.visible = !v.damage.lost[i]
        // малые углы на экране как в физике (видно на скорости), большие плавно ограничены,
        // чтобы на упоре колёса не выглядели перекошенными
        const m = TUNING.steerVisualMax
        w.pivot.rotation.y = m * Math.tanh(pw.steer / m)
        // развал: отрицательный — верх колеса к кузову
        w.camber.rotation.z = -w.side * pw.camberBody

        // Колесо на экране не должно проворачиваться за кадр больше, чем половина шага между
        // прорезями диска (72° / 2): иначе глаз видит вращение назад или остановку («эффект колеса»)
        const phys = pw.spin
        if (w.lastPhys === undefined) w.lastPhys = phys
        const step = THREE.MathUtils.clamp(phys - w.lastPhys, -MAX_SPIN_PER_FRAME, MAX_SPIN_PER_FRAME)
        w.lastPhys = phys
        w.spin = ((w.spin || 0) + step) % (Math.PI * 2)
        w.node.rotation.x = w.spin
      }

      drs.rotation.x = TUNING.aeroOpenRad * v.aero
      // разрушенные крылья отваливаются: переднее — обе половины выше 90%, заднее — выше 95%
      const dm = v.damage
      if (frontWingNode) frontWingNode.visible = Math.min(dm.wingL, dm.wingR) < 0.9
      if (rearWingNode) rearWingNode.visible = dm.rearWing < 0.95
      drs.visible = dm.rearWing < 0.95

      // задние огни и диски разогреваются при торможении
      const braking = v.state.braking ? 1 : 0
      const rear = materials.light_rear
      if (rear) rear.emissiveIntensity = THREE.MathUtils.lerp(rear.emissiveIntensity, braking ? 5 : 0.8, 0.3)
      const disc = materials.brake_disc
      if (disc) {
        disc.emissive.set(0xff5a14)
        disc.emissiveIntensity = THREE.MathUtils.lerp(disc.emissiveIntensity, braking ? 1.6 : 0, 0.08)
      }
    },
  }
  return car
}
