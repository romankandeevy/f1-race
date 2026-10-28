import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { TUNING } from './tuning.js'

const WHEELS = ['FL', 'FR', 'RL', 'RR']
const MAX_SPIN_PER_FRAME = 0.5 // рад за кадр, ~29°
export const PAINTS = ['#c4101a', '#f07a12', '#0d7a55', '#1f5fbf', '#e9e6df', '#1a1c20']

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
  carRoot.traverse((o) => {
    if (!o.isMesh) return
    o.castShadow = true
    o.receiveShadow = true
    const list = Array.isArray(o.material) ? o.material : [o.material]
    for (const m of list) {
      materials[m.name] = m
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
        if (!m[key]) continue
        m[key].anisotropy = maxAniso
        textures.add(m[key])
      }
    }
  })

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
  const car = build(scene, carRoot, materials)
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
    const bot = build(copy, copy.getObjectByName('car_root'), { ...materials, ...own })
    bot.setPaint(paint)
    return bot
  }
  return car
}

// материалы, которые у каждого болида свои: цвет кузова и то, что светится при торможении
const PER_CAR = ['paint', 'light_rear', 'brake_disc']

function build(scene, carRoot, materials) {
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
  const onboard = carRoot.getObjectByName('cam_onboard')

  const prev = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() }
  const cur = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() }
  let first = true

  const car = {
    group,
    onboard,
    materials,

    setPaint(hex) {
      materials.paint?.color.set(hex)
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
