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
const TYRE_MARK = { soft: null, medium: [255, 196, 0], hard: [244, 244, 242], intermediate: [67, 176, 42], wet: [46, 139, 230] }

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

// Ливрея модели 30.10 — текстура (красный кузов, белый перламутровый овал вокруг кокпита с тонкой окантовкой, чёрные вставки).
// Картинку запоминаем до выгрузки в видеокарту, перекраска рисует её заново: красное → цвет кузова, белое → цвет зоны,
// чёрное не трогаем. Резать кузов на материалы по цвету нельзя: край белой зоны шёл зубцами.
function liveryPixels(map) {
  const img = map.image
  const cv = document.createElement('canvas')
  cv.width = img.width
  cv.height = img.height
  const c = cv.getContext('2d', { willReadFrequently: true })
  c.drawImage(img, 0, 0)
  return { w: cv.width, h: cv.height, data: c.getImageData(0, 0, cv.width, cv.height).data, map }
}
const rgbOf = (hex) => {
  const n = parseInt(new THREE.Color(hex).getHexString(), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function recolorLivery(base, primary, secondary) {
  const cv = document.createElement('canvas')
  cv.width = base.w
  cv.height = base.h
  const c = cv.getContext('2d')
  const out = c.createImageData(base.w, base.h)
  const s = base.data
  const d = out.data
  const P = rgbOf(primary)
  const W = rgbOf(secondary)
  for (let i = 0; i < s.length; i += 4) {
    const r = s[i]
    const g = s[i + 1]
    const b = s[i + 2]
    d[i + 3] = 255
    if (Math.max(r, g, b) < 45) {
      // чёрные вставки (номерной квадрат, воздухозаборник) — как были
      d[i] = r
      d[i + 1] = g
      d[i + 2] = b
      continue
    }
    const w = Math.min(1, Math.max(0, (Math.min(g, b) - 40) / 170)) // 0 — красное, 1 — белое
    d[i] = P[0] + (W[0] - P[0]) * w
    d[i + 1] = P[1] + (W[1] - P[1]) * w
    d[i + 2] = P[2] + (W[2] - P[2]) * w
  }
  c.putImageData(out, 0, 0)
  const t = new THREE.CanvasTexture(cv)
  const m = base.map
  t.colorSpace = m.colorSpace
  t.flipY = m.flipY
  t.wrapS = m.wrapS
  t.wrapT = m.wrapT
  t.anisotropy = m.anisotropy
  t.channel = m.channel
  return t
}

// Надписи на любом фоне (Рома 30.10: «текст не видно на тёмных штуках»). Одноцветная наклейка (Ray-Ban, ZYN, Peroni…),
// которая почти сливается с фоном под ней, перерисовывается белой (на тёмном) или почти чёрной (на светлом). Фон — деталь
// под центром наклейки: ливрея (по её текстуре — поле кузова или зона у кокпита, их цвета меняет перекраска), краска или
// постоянный цвет (карбон). Разноцветные логотипы (Shell, щит Ferrari) не трогаем. Картинки снимаем до выгрузки в видеокарту.
const lumHex = (hex) => {
  const [r, g, b] = rgbOf(hex)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}
const isDecalMat = (m) => !!m && /^decal_|^Наклейка/.test(m.name)
function decalInfo(scene, liveryBase) {
  scene.updateMatrixWorld(true)
  const pts = []
  const v = new THREE.Vector3()
  scene.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material) || isDecalMat(o.material) || o.material.transparent) return
    const pos = o.geometry.attributes.position
    for (let i = 0; i < pos.count; i += 3) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld)
      pts.push({ x: v.x, y: v.y, z: v.z, o, i })
    }
  })
  const out = []
  const seen = new Set()
  scene.traverse((o) => {
    if (!o.isMesh || !isDecalMat(o.material)) return
    // одна наклейка бывает на разном фоне (UniCredit на носу и на карбоне крыла) — у каждой детали свой материал
    if (seen.has(o.material)) o.material = o.material.clone()
    const mat = o.material
    seen.add(mat)
    mat.polygonOffset = true // наклейка поверх кузова, даже если упрощённый кузов чуть ближе
    mat.polygonOffsetFactor = -2
    mat.polygonOffsetUnits = -2
    const img = mat.map?.image
    if (!img?.width) return
    const cv = document.createElement('canvas')
    cv.width = img.width
    cv.height = img.height
    const c = cv.getContext('2d', { willReadFrequently: true })
    c.drawImage(img, 0, 0)
    const d = c.getImageData(0, 0, cv.width, cv.height).data
    let n = 0
    let r = 0
    let g = 0
    let b = 0
    let spread = 0
    for (let i = 0; i < d.length; i += 16) {
      if (d[i + 3] < 128) continue
      n++
      r += d[i]
      g += d[i + 1]
      b += d[i + 2]
      spread += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2])
    }
    if (!n || spread / n > 45) return // пусто или разноцветный логотип
    const textLum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / n / 255
    o.geometry.computeBoundingBox()
    const ctr = o.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(o.matrixWorld)
    let best = null
    let bd = Infinity
    for (const p of pts) {
      const dd = (p.x - ctr.x) ** 2 + (p.y - ctr.y) ** 2 + (p.z - ctr.z) ** 2
      if (dd < bd) (bd = dd), (best = p)
    }
    if (!best) return
    const bm = best.o.material
    let bg
    if (bm.name === 'paint_livery' && liveryBase) {
      const uv = best.o.geometry.attributes.uv
      const px = Math.min(liveryBase.w - 1, Math.floor((((uv.getX(best.i) % 1) + 1) % 1) * liveryBase.w))
      const py = Math.min(liveryBase.h - 1, Math.floor((((uv.getY(best.i) % 1) + 1) % 1) * liveryBase.h))
      const k = (py * liveryBase.w + px) * 4
      const s = liveryBase.data
      bg = Math.max(s[k], s[k + 1], s[k + 2]) < 45 ? { lum: 0.02 } : Math.min(s[k + 1], s[k + 2]) > 120 ? { zone: 'secondary' } : { zone: 'primary' }
    } else if (bm.name === 'paint') bg = { zone: 'primary' }
    else if (bm.name === 'paint_secondary') bg = { zone: 'secondary' }
    else bg = { lum: lumHex('#' + bm.color.getHexString()) * (bm.map ? 0.6 : 1) }
    out.push({ mat, map: mat.map, canvas: cv, textLum, bg, state: null, tex: {} })
  })
  return out
}
function recolorDecal(src, light, map) {
  const cv = document.createElement('canvas')
  cv.width = src.width
  cv.height = src.height
  const c = cv.getContext('2d')
  c.drawImage(src, 0, 0)
  const px = c.getImageData(0, 0, cv.width, cv.height)
  const d = px.data
  const col = light ? [242, 242, 238] : [22, 22, 24]
  for (let i = 0; i < d.length; i += 4) {
    d[i] = col[0]
    d[i + 1] = col[1]
    d[i + 2] = col[2]
  }
  c.putImageData(px, 0, 0)
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = map.colorSpace
  t.flipY = map.flipY
  t.wrapS = map.wrapS
  t.wrapT = map.wrapT
  t.anisotropy = map.anisotropy
  t.channel = map.channel
  return t
}
function decalContrast(list, primary, secondary) {
  for (const d of list) {
    const bgLum = d.bg.zone ? lumHex(d.bg.zone === 'primary' ? primary : secondary) : d.bg.lum
    // на тёмном фоне надпись должна быть почти белой, на светлом — почти чёрной (серый Ray-Ban на карбоне читался плохо)
    const need = bgLum < 0.45 ? (d.textLum < 0.75 ? 'light' : null) : d.textLum > 0.3 ? 'dark' : null
    if (need === d.state) continue
    d.state = need
    d.mat.map = need ? (d.tex[need] ||= recolorDecal(d.canvas, need === 'light', d.map)) : d.map
    d.mat.needsUpdate = true
  }
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
  const liveryBase = materials.paint_livery?.map ? liveryPixels(materials.paint_livery.map) : null
  const decals = decalInfo(scene, liveryBase)
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
  const car = build(scene, carRoot, materials, sidewalls, sidewallMats, liveryBase, decals)
  // копия болида для бота: свой цвет и свои стоп-сигналы, тени не отбрасывает (дорого)
  car.spawn = (paint) => {
    const copy = template.clone(true)
    // наклейки (~50 отдельных деталей со своими материалами) — только у болида игрока: у 11 ботов это +550 вызовов отрисовки
    copy.getObjectByName('decals')?.removeFromParent()
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
    const bot = build(copy, copy.getObjectByName('car_root'), { ...materials, ...own }, botSidewalls, sidewallMats, liveryBase)
    bot.setLivery({ primary: paint, secondary: car.defaults.secondary, accent: car.defaults.accent })
    return bot
  }
  return car
}

// материалы, которые у каждого болида свои: цвет кузова и то, что светится при торможении
const PER_CAR = ['paint', 'paint_livery', 'paint_secondary', 'accent_blue', 'light_rear', 'brake_disc']

// свечение раскалённого тормоза: диск спрятан внутри колёсного диска модели, и его свечения снаружи почти не видно
// (Рома 29.10: «сильнее, сейчас почти не видно»). Поэтому на наружной стороне ступицы — мягкое оранжевое пятно
// (спрайт, складывается со светом), как свет, пробивающийся сквозь спицы. Картинка одна на все болиды.
let glowTex = null
function brakeGlowTexture() {
  if (glowTex) return glowTex
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,220,150,1)')
  grad.addColorStop(0.25, 'rgba(255,140,40,0.85)')
  grad.addColorStop(0.6, 'rgba(255,60,10,0.3)')
  grad.addColorStop(1, 'rgba(255,30,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  glowTex = new THREE.CanvasTexture(c)
  glowTex.colorSpace = THREE.SRGBColorSpace
  return glowTex
}
const GLOW_OUT = 0.21 // м от центра колеса наружу: чуть за плоскостью обода
const GLOW_SIZE = 0.62 // м

function build(scene, carRoot, materials, sidewalls = [], sidewallMats = {}, liveryBase = null, decals = []) {
  const livery = { primary: '#' + (materials.paint?.color.getHexString() ?? 'c8102e'), secondary: '#' + (materials.paint_secondary?.color.getHexString() ?? 'f2f0ea'), tex: null }
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
    // суппорт, тормозной воздуховод и барабан (модель 30.10) стоят на стойке: поворачиваются с колесом (руль, развал), но не крутятся
    carRoot.updateMatrixWorld(true)
    for (const pre of ['caliper_', 'brake_duct_', 'brake_drum_lip_', 'brake_drum_']) {
      const part = carRoot.getObjectByName(pre + k)
      if (part) camber.attach(part)
    }
    const side = pivot.position.x > 0 ? 1 : -1
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: brakeGlowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }))
    glow.position.set(side * GLOW_OUT, 0, 0)
    glow.scale.setScalar(GLOW_SIZE)
    glow.visible = false
    glow.renderOrder = 5
    node.add(glow)
    return { pivot, camber, node, side, glow }
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
  decalContrast(decals, livery.primary, livery.secondary) // надписи на родной ливрее (Ray-Ban на карбоне крыла) — тоже читаемые
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
      // ливрея-текстура: перерисовать, только если цвет кузова или зоны поменялся
      const lm = materials.paint_livery
      if (liveryBase && lm && ((primary && primary !== livery.primary) || (secondary && secondary !== livery.secondary) || !livery.tex)) {
        if (primary) livery.primary = primary
        if (secondary) livery.secondary = secondary
        livery.tex?.dispose()
        livery.tex = recolorLivery(liveryBase, livery.primary, livery.secondary)
        lm.map = livery.tex
        lm.color.set('#ffffff')
        lm.needsUpdate = true
      }
      decalContrast(decals, primary || livery.primary, secondary || livery.secondary)
    },

    // цвета из самой модели: ими красим соперников, чтобы они не наследовали ливрею игрока
    defaults: {
      secondary: '#' + (materials.paint_secondary?.color.getHexString() ?? 'f2f0ea'),
      accent: '#' + (materials.accent_blue?.color.getHexString() ?? '2845c8'),
    },

    // Зеркала заднего вида (Рома 30.10: «чтобы работали полноценно»): стекло каждого зеркала — экран, на который смотрит своя
    // камера назад из точки зеркала (чуть наружу). Обновляются по очереди (левое/правое — каждое через кадр) и только когда их
    // видно (вид из кабины и T-камера); тени при этом не пересчитываются. Ставит main.js для болида игрока.
    initMirrors() {
      const holder = carRoot.getObjectByName('mirrors')
      let glass = null
      holder?.traverse((o) => {
        if (o.isMesh && o.material?.name === 'mirror_glass_silver') glass = o
      })
      if (!glass) return null
      carRoot.updateMatrixWorld(true)
      const inv = new THREE.Matrix4().copy(carRoot.matrixWorld).invert()
      const pos = glass.geometry.attributes.position
      const v = new THREE.Vector3()
      const sides = { L: new THREE.Box3(), R: new THREE.Box3() }
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(glass.matrixWorld).applyMatrix4(inv)
        sides[v.x > 0 ? 'L' : 'R'].expandByPoint(v)
      }
      glass.visible = false
      const list = []
      for (const [k, box] of Object.entries(sides)) {
        if (box.isEmpty()) continue
        const size = box.getSize(new THREE.Vector3())
        const ctr = box.getCenter(new THREE.Vector3())
        const rt = new THREE.WebGLRenderTarget(200, 90)
        // экран чуть ближе к пилоту, чем стекло. Отражение получается само: камера смотрит назад, и левое сзади (+X) у неё
        // справа на картинке — а пилот видит правую часть текстуры (+X экрана) слева от себя, как в настоящем зеркале
        const geo = new THREE.PlaneGeometry(size.x * 0.96, size.y * 0.9)
        const mat = new THREE.MeshBasicMaterial({ map: rt.texture, side: THREE.DoubleSide })
        const screen = new THREE.Mesh(geo, mat)
        screen.name = 'mirror_screen_' + k
        screen.position.set(ctr.x, ctr.y, box.min.z - 0.002)
        carRoot.add(screen)
        // камера: из точки зеркала назад, чуть развёрнута наружу (видно заднее колесо и трассу сбоку)
        const cam = new THREE.PerspectiveCamera(22, size.x / size.y, 0.3, 400)
        cam.position.set(ctr.x * 1.05, ctr.y + 0.02, box.min.z - 0.03)
        cam.rotation.set(0, Math.PI - (k === 'L' ? -1 : 1) * 0.12, 0)
        carRoot.add(cam)
        list.push({ rt, cam, screen })
      }
      let turn = 0
      return {
        // renderer, scene; visible — зеркала видно с этой камеры
        update(renderer, scene, visible) {
          for (const m of list) m.screen.visible = visible
          if (!visible || !list.length) return
          const m = list[turn++ % list.length]
          const auto = renderer.shadowMap.autoUpdate
          renderer.shadowMap.autoUpdate = false
          m.screen.visible = false
          renderer.setRenderTarget(m.rt)
          renderer.render(scene, m.cam)
          renderer.setRenderTarget(null)
          m.screen.visible = true
          renderer.shadowMap.autoUpdate = auto
        },
      }
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

      // задние огни горят при торможении; диски светятся по температуре (wear.js): от ~330° тускло-красным, к 750° — ярко-оранжевым
      const braking = v.state.braking ? 1 : 0
      const rear = materials.light_rear
      if (rear) rear.emissiveIntensity = THREE.MathUtils.lerp(rear.emissiveIntensity, braking ? 5 : 0.8, 0.3)
      const disc = materials.brake_disc
      if (disc) {
        const bt = Math.max(v.brakeTemp[0], v.brakeTemp[1])
        // Рома 29.10: «сильнее, сейчас почти не видно» — светиться начинает с 330° (было 480°: за круг диски редко
        // грелись выше ~520°, и свечения почти не было), к 750° горит в полную силу; горячее — желтее
        const glow = THREE.MathUtils.clamp((bt - 330) / 420, 0, 1)
        disc.emissive.setRGB(1, 0.12 + 0.4 * glow * glow, 0.02 + 0.08 * glow * glow)
        disc.emissiveIntensity = THREE.MathUtils.lerp(disc.emissiveIntensity, 9 * glow, 0.2)
      }
      // свечение у ступицы — у каждого колеса по своему диску
      wheels.forEach((w, i) => {
        const k = THREE.MathUtils.clamp((v.brakeTemp[i] - 330) / 420, 0, 1)
        const m = w.glow.material
        m.opacity = THREE.MathUtils.lerp(m.opacity, 0.9 * k, 0.2)
        w.glow.visible = m.opacity > 0.02
        w.glow.scale.setScalar(GLOW_SIZE * (0.75 + 0.35 * k))
      })
    },
  }
  return car
}
