import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { TUNING } from './tuning.js'

const WHEELS = ['FL', 'FR', 'RL', 'RR']

// Вмятины (Рома 31.10: «видимые повреждения»): удар мнёт кузов в месте удара — точки модели в шаре вокруг места
// сдвигаются внутрь по направлению толчка с «мятым» разбросом, нормали наклоняются (свет ложится по-мятому).
// Детали, которые помялись, получают свою копию геометрии (у ботов она общая), починили в боксах или новый старт — оригинал обратно.
// Половина переднего крыла, разрушенная на 90%, отваливается (её точки схлопываются), обе — крыло исчезает целиком (как раньше).
const DENT_SKIP = /^(pivot_|camber_|wheel_|steering_wheel|driver|cam_|mirror)/
const DENT_ZONE_KEYS = { front: ['wingL', 'wingR'], rear: ['rearWing'], left: ['sideL'], right: ['sideR'] }
const DENT_GAP = 0.12 // с: при скольжении вдоль стены удары идут подряд — мнём не чаще
const DENT_MAX = 0.22 // м: глубже одна вмятина не бывает
const hash = (i) => {
  const x = Math.sin(i * 12.9898) * 43758.5453
  return x - Math.floor(x)
}
const MAX_SPIN_PER_FRAME = 0.3 // рад за кадр, ~17°: меньше половины шага спиц (10 спиц — 36°)
export const PAINTS = ['#c4101a', '#f07a12', '#0d7a55', '#1f5fbf', '#e9e6df', '#1a1c20']

// Цвет маркировки на боковине по составу, как у Pirelli: мягкие красные, средние жёлтые, твёрдые белые.
// В модели есть только красные (мягкие): остальные делаем из той же картинки, переводя красный в нужный цвет.
// Рома 29.10: «шины не меняются, хотя на диске I у нас есть модель шин» — та модель (80 МБ, все пять комплектов) в игру не идёт,
// а перекраска боковины даёт то же самое по виду за пару мегабайт.
const TYRE_MARK = { soft: null, medium: [255, 196, 0], hard: [244, 244, 242], intermediate: [67, 176, 42], wet: [46, 139, 230] }

// Протектор — матовая чёрная резина, как у слика Pirelli: ровное мелкое зерно без полос и пятен
function rubberTexture() {
  const size = 1024
  const cell = 2
  const n = size / cell
  const small = document.createElement('canvas')
  small.width = small.height = n
  const sg = small.getContext('2d')
  const sImg = sg.createImageData(n, n)
  for (let i = 0; i < n * n; i++) {
    const v = (Math.random() - 0.5) * 6
    sImg.data[i * 4] = 28 + v
    sImg.data[i * 4 + 1] = 28 + v
    sImg.data[i * 4 + 2] = 30 + v
    sImg.data[i * 4 + 3] = 255
  }
  sg.putImageData(sImg, 0, 0)
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  g.imageSmoothingEnabled = true
  g.drawImage(small, 0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

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
    out.push({ name: o.name, mat, map: mat.map, canvas: cv, textLum, bg, state: null, tex: {} })
  })
  return out
}
// Наклейка, у которой ближайшая деталь кузова лежит внутри одной из parts, переезжает в эту деталь (мировое место то же).
// Ближайшая — по вершинам (через три, как в decalInfo); parts — от самой вложенной (закрылок внутри заднего крыла)
function attachPartDecals(scene, carRoot, parts) {
  const holder = scene.getObjectByName('decals')
  const list = parts.filter(Boolean)
  if (!holder || !list.length) return
  scene.updateMatrixWorld(true)
  const partOf = (o) => {
    for (let p = o; p; p = p.parent) if (list.includes(p)) return p
    return null
  }
  const xyz = []
  const owner = []
  const v = new THREE.Vector3()
  carRoot.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material) || isDecalMat(o.material)) return
    const part = partOf(o)
    const pos = o.geometry.attributes.position
    for (let i = 0; i < pos.count; i += 3) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld)
      xyz.push(v.x, v.y, v.z)
      owner.push(part)
    }
  })
  const decals = []
  holder.traverse((o) => {
    if (o.isMesh && isDecalMat(o.material)) decals.push(o)
  })
  for (const d of decals) {
    d.geometry.computeBoundingBox()
    const c = d.geometry.boundingBox.getCenter(v).applyMatrix4(d.matrixWorld)
    let best = -1
    let bd = Infinity
    for (let k = 0; k < owner.length; k++) {
      const dd = (xyz[k * 3] - c.x) ** 2 + (xyz[k * 3 + 1] - c.y) ** 2 + (xyz[k * 3 + 2] - c.z) ** 2
      if (dd < bd) (bd = dd), (best = k)
    }
    if (best >= 0 && owner[best]) owner[best].attach(d)
  }
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

const SHADOW_MIN = 0.2 // м: радиус детали, с которого она отбрасывает тень

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
  // тень отбрасывают только крупные детали (01.11, Рома: «всё подлагивает, дёргается»): было все 240 деталей — каждая
  // рисовалась второй раз в карту теней (~240 лишних вызовов за кадр); тень от болтов, наклеек и кнопок руля не видна
  carRoot.updateMatrixWorld(true)
  const scaleOf = new THREE.Vector3()
  carRoot.traverse((o) => {
    if (!o.isMesh) return
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere()
    o.getWorldScale(scaleOf)
    o.castShadow = o.geometry.boundingSphere.radius * Math.max(scaleOf.x, scaleOf.y, scaleOf.z) >= SHADOW_MIN
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

  // Колёса целиком из «ШИНЫ.glb» (Рома 30.10: «взять полностью каждое колесо — со спицами, колодками, со всем»):
  // public/models/wheels.glb, собирает tools/model/make_wheels.mjs. wheel_spin — что крутится (обод, спицы, ступица с гайкой,
  // карбоновый тормозной диск), wheel_caliper — суппорт (на стойке, не крутится), *_lo — облегчённые для ботов,
  // tyre_<состав> — шины пяти составов. Центр — центр колеса, ось X, внешняя сторона +X. Нет файла — колёса из модели болида.
  let tyreSets = null
  try {
    const tg = await new GLTFLoader().loadAsync('/models/wheels.glb')
    tyreSets = { width: 0.376 }
    for (const id of ['soft', 'medium', 'hard', 'intermediate', 'wet']) {
      const n = tg.scene.getObjectByName('tyre_' + id)
      if (n) tyreSets[id] = n
    }
    for (const [key, name] of [['spin', 'wheel_spin'], ['caliper', 'wheel_caliper'], ['spinLo', 'wheel_spin_lo'], ['caliperLo', 'wheel_caliper_lo']])
      tyreSets[key] = tg.scene.getObjectByName(name)
    if (tyreSets.soft) {
      const b = new THREE.Box3().setFromObject(tyreSets.soft)
      tyreSets.width = b.max.x - b.min.x
    }
    // протектор: матовая резина вместо размазанной картинки из модели (она давала полосы); цвет — из текстуры
    const rubber = rubberTexture()
    tg.scene.traverse((o) => {
      if (!o.isMesh) return
      for (const m of [].concat(o.material)) {
        if (!m.name.startsWith('tyre_tread_')) continue
        m.map = rubber
        m.color.set(0xffffff)
      }
    })
    tg.scene.traverse((o) => {
      if (!o.isMesh) return
      o.castShadow = true
      o.receiveShadow = true
      for (const m of [].concat(o.material))
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
          if (!m[key]) continue
          m[key].anisotropy = maxAniso
          textures.add(m[key])
        }
    })
  } catch {
    tyreSets = null
  }

  // Пилот (Рома 31.10: «сделай человечка и посади в болид, пусть его тоже кастомить можно», потом «детализированного, и чтобы
  // руки были у руля — чтобы он реально управлял»): public/models/driver.glb, сделан в Forma («Шлем пилота»). Тело «Пилот»
  // (шлем, HANS, плечи, ремни) неподвижно; руки — три сегмента («Рука плечо», «Рука предплечье», «Рука кисть»: начало в суставе,
  // вдоль +Y), их каждый кадр ставит sync — кисти держат ручки руля и поворачиваются вместе с ним. Детали одного материала в
  // каждой части склеиваются. Перекрашиваются шлем (основа и полоса), комбинезон и перчатки (setDriver).
  let driverTpl = null
  try {
    const dg = await new GLTFLoader().loadAsync('/models/driver.glb')
    dg.scene.updateMatrixWorld(true)
    const merged = (root) => {
      const inv = new THREE.Matrix4().copy(root.matrixWorld).invert()
      const groups = new Map()
      root.traverse((o) => {
        if (!o.isMesh) return
        const g = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld))
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k)
        const name = o.material.name
        if (!groups.has(name)) groups.set(name, { mat: o.material, geos: [] })
        groups.get(name).geos.push(g.index ? g.toNonIndexed() : g)
      })
      const out = new THREE.Group()
      for (const [name, { mat, geos }] of groups) {
        const m = new THREE.Mesh(mergeGeometries(geos), mat)
        m.name = 'driver_' + name
        out.add(m)
      }
      return out
    }
    const part = (name) => dg.scene.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name)) // пробелы в именах загрузчик меняет на _
    // «Пилот» — голова (шлем, HANS, шея: из кабины прячется), «Пилот тело» — торс, ремни, ноги (Рома 31.10: «полноценного, с ногами»)
    if (part('Пилот') && part('Рука кисть')) driverTpl = { head: merged(part('Пилот')), body: part('Пилот тело') ? merged(part('Пилот тело')) : null, upper: merged(part('Рука плечо')), fore: merged(part('Рука предплечье')), hand: merged(part('Рука кисть')) }
  } catch {
    driverTpl = null // нет файла — болид без пилота, как раньше
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
  const car = build(scene, carRoot, materials, sidewalls, sidewallMats, liveryBase, decals, tyreSets, true, driverTpl)
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
    const bot = build(copy, copy.getObjectByName('car_root'), { ...materials, ...own }, botSidewalls, sidewallMats, liveryBase, [], tyreSets, false, driverTpl)
    bot.setLivery({ primary: paint, secondary: car.defaults.secondary, accent: car.defaults.accent })
    // у соперников шлем свой (случайный из палитры), комбинезон в цвет болида
    const H = ['#f2f2f2', '#15171b', '#ffc400', '#2f7bff', '#e10600', '#22d36b', '#b9bec6', '#f07a12']
    bot.setDriver({ helmet: H[Math.floor(Math.random() * H.length)], helmet2: paint, suit: paint, gloves: '#15171b' })
    return bot
  }
  return car
}

// где глаза пилота в driver.glb (середина визора), м; материалы, которые перекрашиваются (свои у каждого болида)
const DRIVER_EYE = [0, 0.146, 0.08]
const DRIVER_PAINT = ['helmet_main', 'helmet_stripe', 'driver_suit', 'driver_gloves']
// накладка на тыльной стороне и раструб перчатки — всегда тёмные (Рома 31.10 «что с рукой?»: в цвет перчаток/комбинезона кисть
// сливалась в один брусок, пальцев не видно)
const GLOVE_TRIM = '#26282d'
// руки (driver.glb): плечевой сустав в осях пилота (левая; правая — зеркально по X), длины плеча и предплечья до запястья,
// запястье — на grip не доходя до ручки руля
const ARM = { shoulder: [0.165, -0.085, -0.03], upper: 0.27, fore: 0.25, grip: 0.075 }
// руль на экране: угол колёс → поворот руля (у F1 ~±90° от упора до упора)
const WHEEL_TURN = 3.4

// halo из кабины в режиме «Прозрачный»: доля непрозрачности
const HALO_FADE = 0.22

// покрытие кузова: undefined — как в модели
export const FINISHES = {
  gloss: { name: 'Глянец' },
  matte: { name: 'Мат', roughness: 0.62, metalness: 0, clearcoat: 0 },
  metal: { name: 'Металлик', roughness: 0.32, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.05 },
  chrome: { name: 'Хром', roughness: 0.07, metalness: 1, clearcoat: 0 },
}

// узлы сборки → детали модели (подсветка в гараже)
const PART_MESHES = {
  engine: ['sidepods_engine_cover', 'airbox_spine', 'exhaust'],
  ers: ['sidepods_engine_cover', 'monocoque_nose'],
  gearbox: ['gearbox_crash_fairing', 'rear_light_housing'],
  aero: ['front_wing', 'rear_wing', 'drs_flap', 'floor_diffuser'],
  brakes: ['brake_duct_FL', 'brake_duct_FR', 'brake_duct_RL', 'brake_duct_RR'],
  cooling: ['sidepod_inlet', 'sidepods_engine_cover'],
  chassis: ['monocoque_nose', 'headrest', 'halo', 'floor_diffuser'],
}

// рамка непрозрачных пикселей картинки наклейки
function alphaBox(cv) {
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
  let x0 = cv.width, y0 = cv.height, x1 = 0, y1 = 0
  for (let y = 0; y < cv.height; y++)
    for (let x = 0; x < cv.width; x++)
      if (d[(y * cv.width + x) * 4 + 3] > 100) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: cv.width, h: cv.height }
}
// свой номер в рамке старых цифр: жирный, белый
function drawNumber(src, box, text) {
  const cv = document.createElement('canvas')
  cv.width = src.width
  cv.height = src.height
  const c = cv.getContext('2d')
  let size = box.h * 1.36
  c.font = `900 ${size}px "Titillium Web", sans-serif`
  const w = c.measureText(text).width
  if (w > box.w * 1.15) size *= (box.w * 1.15) / w
  c.font = `900 ${size}px "Titillium Web", sans-serif`
  c.fillStyle = '#ffffff'
  c.textAlign = 'center'
  c.textBaseline = 'alphabetic'
  const m = c.measureText(text)
  const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
  // в картинке модели цифры лежат вверх ногами (так их кладёт развёртка носа) — рисуем так же
  c.translate(box.x + box.w / 2, box.y + box.h / 2)
  c.rotate(Math.PI)
  c.fillText(text, 0, h / 2 - m.actualBoundingBoxDescent)
  return cv
}
function textureLike(cv, map) {
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = map.colorSpace
  t.flipY = map.flipY
  t.wrapS = map.wrapS
  t.wrapT = map.wrapT
  t.anisotropy = map.anisotropy
  t.channel = map.channel
  return t
}

// материалы, которые у каждого болида свои: цвет кузова и стоп-сигналы. Свечения раскалённых тормозов нет
// (Рома 30.10: «убери свечение тормозов вообще, и из кода»): диск и пятно у ступицы больше не светятся
const tmpQ = new THREE.Quaternion()
const Z_AXIS = new THREE.Vector3(0, 0, 1)
const PER_CAR = ['paint', 'paint_livery', 'paint_secondary', 'accent_blue', 'light_rear']

// Светодиоды торцов заднего крыла (две вертикальные полоски, x ±0,585, y 0,87–0,97, z −2,5) лежат в одной детали `lights` вместе с
// дождевым фонарём на коробке передач (y ~0,35, z −2,26). Крыло разбито (v.damage.rearWing ≥ 0,95) — прячется rear_wing, а огни
// оставались висеть в воздухе (Рома 10.11: «2 линии — это огни от спойлера, они остались, хотя спойлер отлетел»). Делим деталь по
// высоте: полоски переезжают внутрь rear_wing и пропадают вместе с ним, фонарь остаётся. Геометрия делится один раз на все болиды.
const WING_LED_Y = 0.6 // м, в осях болида: между фонарём (0,35) и полосками (0,87)
const wingLedSplit = new WeakMap()
const IDENTITY = new THREE.Matrix4()
function moveWingLeds(carRoot, rearWingNode) {
  const lights = carRoot.getObjectByName('lights')
  // у обеих деталей в модели единичная матрица и один родитель — тогда координаты вершин не меняются; иначе не трогаем
  if (!lights?.isMesh || !rearWingNode || lights.parent !== rearWingNode.parent) return
  if (!lights.matrix.equals(IDENTITY) || !rearWingNode.matrix.equals(IDENTITY)) return
  let split = wingLedSplit.get(lights.geometry)
  if (!split) {
    const g = lights.geometry
    const pos = g.attributes.position
    const index = g.index
    const tris = (index ? index.count : pos.count) / 3
    const body = []
    const wing = []
    for (let t = 0; t < tris; t++) {
      const ids = [0, 1, 2].map((k) => (index ? index.getX(t * 3 + k) : t * 3 + k))
      const y = (pos.getY(ids[0]) + pos.getY(ids[1]) + pos.getY(ids[2])) / 3
      ;(y > WING_LED_Y ? wing : body).push(...ids)
    }
    if (!wing.length || !body.length) return // нечего делить — оставляем как есть
    const part = (ids) => {
      const p = g.clone()
      p.setIndex(ids)
      return p
    }
    split = { body: part(body), wing: part(wing) }
    wingLedSplit.set(g, split)
  }
  lights.geometry = split.body
  const leds = new THREE.Mesh(split.wing, lights.material)
  leds.name = 'lights_wing'
  leds.receiveShadow = lights.receiveShadow
  rearWingNode.add(leds)
}

function build(scene, carRoot, materials, sidewalls = [], sidewallMats = {}, liveryBase = null, decals = [], tyreSets = null, shadows = true, driverTpl = null) {
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
    // колёса из wheels.glb: всё колесо из модели болида (шины, обод, диск) прячем, суппорт и тормозной барабан болида — тоже
    // (барабан закрыл бы новый диск и суппорт); воздуховод остаётся. Ставим обод с диском, суппорт и пять комплектов шин —
    // виден комплект текущего состава. Ширина в файле одна, у болида передние уже, задние шире: масштаб по оси.
    // Правые колёса развёрнуты на 180° (внешняя сторона −X), суппорт справа отражён — стоит там же, где слева (сзади сверху)
    const tyres = {}
    if (tyreSets) {
      node.updateMatrixWorld(true)
      const inv = new THREE.Matrix4().copy(node.matrixWorld).invert()
      const box = new THREE.Box3()
      for (const pre of ['tyre_tread_', 'tyre_sidewall_outer_', 'tyre_sidewall_inner_']) {
        const o = node.getObjectByName(pre + k)
        if (!o) continue
        o.geometry.computeBoundingBox()
        box.union(o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)))
        o.visible = false
      }
      const width = box.isEmpty() ? tyreSets.width : box.max.x - box.min.x
      const sx = width / tyreSets.width
      const old = node.getObjectByName('tyre_soft_' + k)
      if (old) old.visible = false
      for (const pre of ['caliper_', 'brake_drum_lip_', 'brake_drum_']) {
        const part = camber.getObjectByName(pre + k)
        if (part) part.visible = false
      }
      const own = (t) => {
        t.traverse((o) => {
          if (!o.isMesh) return
          if (!shadows) o.castShadow = false
        })
        return t
      }
      const spinSrc = shadows ? tyreSets.spin : tyreSets.spinLo || tyreSets.spin
      if (spinSrc) {
        const r = own(spinSrc.clone(true))
        r.position.set(0, 0, 0)
        r.rotation.set(0, side > 0 ? 0 : Math.PI, 0)
        r.scale.set(sx, 1, 1)
        node.add(r)
      }
      const calSrc = shadows ? tyreSets.caliper : tyreSets.caliperLo || tyreSets.caliper
      if (calSrc) {
        const c = own(calSrc.clone(true))
        c.position.set(0, 0, 0)
        c.rotation.set(0, 0, 0)
        c.scale.set(side * sx, 1, 1)
        camber.add(c)
      }
      for (const id of ['soft', 'medium', 'hard', 'intermediate', 'wet']) {
        if (!tyreSets[id]) continue
        const t = tyreSets[id].clone(true)
        t.position.set(0, 0, 0)
        t.rotation.set(0, side > 0 ? 0 : Math.PI, 0)
        t.scale.set(sx, 1, 1)
        t.visible = id === 'soft'
        if (!shadows) t.traverse((o) => o.isMesh && (o.castShadow = false))
        node.add(t)
        tyres[id] = t
      }
    }
    return { pivot, camber, node, side, tyres }
  })

  const group = new THREE.Group()
  group.add(scene)

  const drs = carRoot.getObjectByName('drs_flap')
  const frontWingNode = carRoot.getObjectByName('front_wing')
  const rearWingNode = carRoot.getObjectByName('rear_wing')
  moveWingLeds(carRoot, rearWingNode)
  const onboard = carRoot.getObjectByName('cam_onboard')
  // наклейки крыльев и закрылка — внутрь своей детали: крыло отвалилось — пропадают и его надписи (Рома 30.10: в меню
  // крыла не было, а V-Power и Ray-Ban висели над асфальтом); надписи на закрылке поворачиваются вместе с ним
  if (shadows) attachPartDecals(scene, carRoot, [drs, frontWingNode, rearWingNode])

  // Руль (часть «cockpit»: кнопки, экран, ручки — материалы sw_*; корпус и лепестки сзади — карбон кокпита, их берём по месту:
  // небольшая карбоновая деталь в коробке руля) — на свою ось, чтобы крутить его вместе с колёсами (Рома 31.10: «крутятся только
  // кнопки, а сам руль — нет»). Ось — направление наименьшего разброса точек руля (он плоский), к пилоту. Ручки — по краям руля
  let sw = null
  {
    const parts = []
    const box = new THREE.Box3()
    const inWheel = (o) => {
      box.setFromObject(o)
      const c = box.getCenter(new THREE.Vector3()).applyMatrix4(new THREE.Matrix4().copy(carRoot.matrixWorld).invert())
      return Math.abs(c.x) < 0.05 && c.y > 0.45 && c.y < 0.66 && c.z > 0.48 && c.z < 0.72 && box.max.x - box.min.x < 0.32
    }
    carRoot.updateMatrixWorld(true)
    carRoot.traverse((o) => {
      if (!o.isMesh || o.parent?.name !== 'cockpit') return
      const n = o.material?.name ?? ''
      if (/^sw_/.test(n) || (/carbon/.test(n) && inWheel(o))) parts.push(o)
    })
    if (parts.length) {
      carRoot.updateMatrixWorld(true)
      const inv = new THREE.Matrix4().copy(carRoot.matrixWorld).invert()
      const pts = []
      const v = new THREE.Vector3()
      for (const o of parts) {
        const pos = o.geometry.attributes.position
        const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)
        for (let i = 0; i < pos.count; i += 2) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(m).clone())
      }
      const c = pts.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / pts.length)
      // плоскость руля: X — поперёк болида, «вверх» и ось — из наклона по Y/Z (ковариация в плоскости YZ)
      let yy = 0, zz = 0, yz = 0
      for (const q of pts) {
        yy += (q.y - c.y) ** 2
        zz += (q.z - c.z) ** 2
        yz += (q.y - c.y) * (q.z - c.z)
      }
      const ang = 0.5 * Math.atan2(2 * yz, yy - zz) // направление наибольшего разброса в YZ — «вверх» по рулю
      const up = new THREE.Vector3(0, Math.cos(ang), Math.sin(ang))
      if (up.y < 0) up.negate()
      const axis = new THREE.Vector3(1, 0, 0).cross(up).normalize() // к пилоту или от него
      if (axis.z > 0) axis.negate() // к пилоту (он сзади, −Z)
      let half = 0
      for (const q of pts) half = Math.max(half, Math.abs(q.x - c.x))
      const pivot = new THREE.Group()
      pivot.name = 'steering_wheel'
      pivot.position.copy(c)
      pivot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(up.clone().cross(axis).normalize(), up, axis))
      carRoot.add(pivot)
      for (const o of parts) pivot.attach(o)
      sw = { pivot, base: pivot.quaternion.clone(), axis, grip: half * 0.86 }
    }
  }

  // пилот в кокпите: глаза — там, где камера из кабины (cam_onboard, на 7 см ниже — как в camera.js); свои материалы цвета
  let driver = null
  let driverHead = null // шлем, HANS, шея — из кабины прячется
  const driverMats = {}
  const arms = []
  if (driverTpl) {
    const own = (t) => {
      const c = t.clone(true)
      c.traverse((o) => {
        if (!o.isMesh) return
        const n = o.material.name
        if (DRIVER_PAINT.includes(n)) o.material = driverMats[n] ||= o.material.clone()
        o.castShadow = shadows
        o.receiveShadow = shadows
      })
      return c
    }
    driverTpl.hand.traverse((o) => o.isMesh && o.material.name === 'driver_gloves2' && o.material.color.set(GLOVE_TRIM))
    driverTpl.fore.traverse((o) => o.isMesh && o.material.name === 'driver_gloves2' && o.material.color.set(GLOVE_TRIM))
    driver = new THREE.Group()
    driver.name = 'driver'
    driverHead = own(driverTpl.head)
    driver.add(driverHead)
    if (driverTpl.body) driver.add(own(driverTpl.body))
    // ремни пустого кокпита из модели болида — у пилота свои (шеститочечные), иначе пересекаются с ним
    if (driverTpl.body) carRoot.getObjectByName('cockpit')?.traverse((o) => o.isMesh && /^belt_/.test(o.material?.name ?? '') && (o.visible = false))
    const eye = onboard.position
    driver.position.set(eye.x - DRIVER_EYE[0], eye.y - 0.07 - DRIVER_EYE[1], eye.z - DRIVER_EYE[2])
    onboard.parent.add(driver)
    // руки — только у болида игрока (кисть ~22 тыс. треугольников; у ботов снаружи их почти не видно)
    if (sw && shadows) {
      for (const side of [1, -1]) {
        const a = { side, upper: own(driverTpl.upper), fore: own(driverTpl.fore), hand: own(driverTpl.hand) }
        // руки — в осях болида (не пилота), чтобы проще считать ручки руля
        a.hand.matrixAutoUpdate = false // кисть ставим матрицей: у левой она зеркальная
        carRoot.add(a.upper, a.fore, a.hand)
        arms.push(a)
      }
    }
  }
  // руки к ручкам руля: два сегмента (плечо, предплечье) — локоть наружу и вниз; кисть вдоль руки, обхват — по ручке
  const ik = { S: new THREE.Vector3(), G: new THREE.Vector3(), W: new THREE.Vector3(), E: new THREE.Vector3(), d: new THREE.Vector3(), pole: new THREE.Vector3(), t: new THREE.Vector3(), x: new THREE.Vector3(), m: new THREE.Matrix4(), Y: new THREE.Vector3(0, 1, 0) }
  function poseArms() {
    if (!arms.length) return
    sw.pivot.updateMatrix()
    for (const a of arms) {
      const { S, G, W, E, d, pole, t, x, m, Y } = ik
      S.set(a.side * ARM.shoulder[0], ARM.shoulder[1], ARM.shoulder[2]).add(driver.position)
      G.set(-a.side * sw.grip, -0.01, 0).applyMatrix4(sw.pivot.matrix) // ручка руля (X руля смотрит вправо, −X болида)
      t.set(0, 1, 0).applyQuaternion(sw.pivot.quaternion) // направление ручки (вдоль руля «вверх»)
      d.subVectors(G, S).normalize()
      W.copy(G).addScaledVector(d, -ARM.grip) // запястье — чуть не доходя до ручки
      let dist = W.distanceTo(S)
      const L1 = ARM.upper
      const L2 = ARM.fore
      const k = dist > (L1 + L2) * 0.995 ? dist / ((L1 + L2) * 0.995) : 1 // не достаёт — руки чуть длиннее, без разрыва
      const l1 = L1 * k
      const l2 = L2 * k
      dist = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(dist, l1 + l2 - 1e-4))
      d.subVectors(W, S).normalize()
      const along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist)
      const h = Math.sqrt(Math.max(0, l1 * l1 - along * along))
      pole.set(a.side, -0.7, -0.2).addScaledVector(d, -pole.set(a.side, -0.7, -0.2).dot(d)).normalize()
      E.copy(S).addScaledVector(d, along).addScaledVector(pole, h)
      a.upper.position.copy(S)
      a.upper.quaternion.setFromUnitVectors(Y, x.subVectors(E, S).normalize())
      a.upper.scale.set(1, k, 1)
      a.fore.position.copy(E)
      a.fore.quaternion.setFromUnitVectors(Y, x.subVectors(W, E).normalize())
      a.fore.scale.set(1, k, 1)
      // кисть: Y — от запястья к ручке, X — вдоль ручки, большой палец сверху; тыльная сторона (−Z модели) — наружу и к пилоту,
      // пальцы обхватывают ручку снаружи. Кисть в модели — правая; левая — её зеркало (Рома 31.10: «рука вывернута, вижу ладонь,
      // а должен видеть верх руки» — раньше левую просто поворачивали, и одна из рук держала руль ладонью наружу, крючком)
      const hy = x.subVectors(G, W).normalize()
      const hx = t.clone().addScaledVector(hy, -t.dot(hy)).normalize()
      const hz = new THREE.Vector3().crossVectors(hx, hy)
      if (a.side > 0) hz.negate() // левая: зеркало (определитель −1 — three.js сам развернёт грани)
      m.makeBasis(hx, hy, hz).setPosition(W)
      a.hand.matrix.copy(m)
    }
  }
  poseArms()

  // подсветка узла сборки в гараже (Рома: «камера к детали»): поверх деталей узла — полупрозрачная копия, мерцает
  const hlMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
  const hlCache = {}
  let hlOn = null
  const hlMeshes = (id) => {
    if (hlCache[id]) return hlCache[id]
    const list = []
    for (const name of PART_MESHES[id] ?? []) {
      const node = carRoot.getObjectByName(name)
      if (!node) continue
      const own = node.isMesh ? [node] : node.children.filter((c) => c.isMesh)
      for (const m of own) {
        const o = new THREE.Mesh(m.geometry, hlMat)
        o.visible = false
        o.renderOrder = 5
        m.add(o)
        list.push(o)
      }
    }
    return (hlCache[id] = list)
  }

  let haloMode = 'show'
  let haloParts = null // детали дуги halo со своими материалами (setHaloView)

  // покрытие кузова (глянец, мат, металлик, хром): меняем шероховатость, металл и лак у краски болида
  const finishBase = new Map()

  const prev = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() }
  const cur = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() }
  let first = true

  let current = 'soft'
  decalContrast(decals, livery.primary, livery.secondary) // надписи на родной ливрее (Ray-Ban на карбоне крыла) — тоже читаемые
  // --- вмятины ---
  let dents = null // [{ o, orig, box, wing, zones: Set }]
  let dentAt = 0
  const lostHalf = { wingL: false, wingR: false }
  const rootInv = new THREE.Matrix4()
  const toMesh = new THREE.Matrix4()
  const dc = new THREE.Vector3()
  const dd = new THREE.Vector3()
  const dp = new THREE.Vector3()
  const dn = new THREE.Vector3()
  const sphere = new THREE.Sphere()
  function dentTargets() {
    dents = []
    carRoot.updateMatrixWorld(true)
    rootInv.copy(carRoot.matrixWorld).invert()
    carRoot.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes.position) return
      let wing = false
      for (let p = o; p && p !== carRoot; p = p.parent) {
        if (DENT_SKIP.test(p.name)) return
        if (p === frontWingNode) wing = true
      }
      // наклейки тоже: мнутся вместе с кузовом и отваливаются вместе с половиной крыла
      o.geometry.computeBoundingBox()
      const box = o.geometry.boundingBox.clone().applyMatrix4(toMesh.multiplyMatrices(rootInv, o.matrixWorld))
      dents.push({ o, orig: null, box, wing, zones: new Set() })
    })
  }
  const leftX = () => Math.sign(wheels[0].pivot.position.x) || 1
  function own(e) {
    if (e.orig) return
    e.orig = e.o.geometry
    e.o.geometry = e.orig.clone()
    e.basePos = e.orig.attributes.position
  }
  // вдавить шар радиусом rad вокруг c (оси болида) на depth по направлению dir (оси болида)
  function press(c, dir, rad, depth, zone, sag) {
    sphere.set(c, rad)
    for (const e of dents) {
      if (!e.box.intersectsSphere(sphere)) continue
      // в осях детали: из осей болида в её собственные
      toMesh.multiplyMatrices(rootInv, e.o.matrixWorld)
      const sc = toMesh.getMaxScaleOnAxis() || 1
      const inv = toMesh.clone().invert()
      const lc = dc.copy(c).applyMatrix4(inv)
      const ld = dd.copy(dir).transformDirection(inv)
      const lr = rad / sc
      const lk = depth / sc
      const pos = e.o.geometry.attributes.position
      let touched = false
      for (let i = 0; i < pos.count; i++) {
        dp.fromBufferAttribute(pos, i)
        const d = dp.distanceTo(lc)
        if (d >= lr) continue
        if (!touched) {
          own(e)
          touched = true
        }
        const f = (1 - d / lr) ** 2
        const k = lk * f * (0.45 + 0.9 * hash(i + pos.count))
        const p = e.o.geometry.attributes.position
        p.setXYZ(i, p.getX(i) + ld.x * k, p.getY(i) + ld.y * k - (e.wing && sag ? (sag * f) / sc : 0), p.getZ(i) + ld.z * k)
        const n = e.o.geometry.attributes.normal
        if (n) {
          dn.fromBufferAttribute(n, i)
          // мятый металл: нормаль уводим вбок на случайный угол, сильнее в центре вмятины
          dn.x += (hash(i * 3 + 1) - 0.5) * 1.6 * f
          dn.y += (hash(i * 3 + 2) - 0.5) * 1.6 * f
          dn.z += (hash(i * 3 + 3) - 0.5) * 1.6 * f
          dn.normalize()
          n.setXYZ(i, dn.x, dn.y, dn.z)
        }
      }
      if (touched) {
        e.zones.add(zone)
        e.o.geometry.attributes.position.needsUpdate = true
        if (e.o.geometry.attributes.normal) e.o.geometry.attributes.normal.needsUpdate = true
        e.o.geometry.computeBoundingSphere()
      }
    }
  }
  // половина переднего крыла отлетела: её точки схлопываются в одну (треугольники пропадают)
  function dropWingHalf(sideX) {
    for (const e of dents) {
      if (!e.wing) continue
      own(e)
      e.zones.add('front')
      toMesh.multiplyMatrices(rootInv, e.o.matrixWorld)
      const inv = toMesh.clone().invert()
      const pos = e.o.geometry.attributes.position
      const hide = dc.set(sideX * 0.1, 0.1, 2.6).applyMatrix4(inv)
      for (let i = 0; i < pos.count; i++) {
        dp.fromBufferAttribute(pos, i).applyMatrix4(toMesh)
        if (dp.x * sideX > 0.14) pos.setXYZ(i, hide.x, hide.y, hide.z)
      }
      pos.needsUpdate = true
    }
  }
  // починили (повреждения зоны снова 0) — у деталей, помятых только там, исходная геометрия
  function dentRepairs(dm) {
    for (const k of ['wingL', 'wingR']) {
      if (dm[k] >= 0.9 && !lostHalf[k] && dm.wingL + dm.wingR < 1.8) {
        lostHalf[k] = true
        // wingL — левая половина: та, что со стороны левых колёс
        dropWingHalf(k === 'wingL' ? leftX() : -leftX())
      }
    }
    for (const e of dents) {
      if (!e.orig) continue
      let fixed = true
      for (const z of e.zones) for (const key of DENT_ZONE_KEYS[z]) if (dm[key] > 0) fixed = false
      if (dm.chassis > 0 && e.zones.size) fixed = false
      if (!fixed) continue
      e.o.geometry.dispose()
      e.o.geometry = e.orig
      e.orig = null
      e.zones.clear()
    }
    if (dm.wingL < 0.9) lostHalf.wingL = false
    if (dm.wingR < 0.9) lostHalf.wingR = false
  }

  const car = {
    group,
    onboard,
    materials,

    // для повтора гонки (replay.js): средний угол передних колёс и вращение колёс на экране
    wheelPose() {
      return { steer: wheels[0].pivot.rotation.y, spin: wheels[2].spin || 0 }
    },
    setWheelPose(steer, spin) {
      for (const w of wheels) {
        if (w === wheels[0] || w === wheels[1]) w.pivot.rotation.y = steer
        w.node.rotation.x = spin
      }
      if (sw) {
        sw.pivot.quaternion.copy(sw.base).multiply(tmpQ.setFromAxisAngle(Z_AXIS, THREE.MathUtils.clamp((steer / TUNING.steerVisualMax) * 0.42 * WHEEL_TURN, -1.7, 1.7)))
        poseArms()
      }
    },

    // удар (r — результат applyImpact): вмятина в месте удара, глубже — сильнее удар
    dent(r) {
      if (!r || r.sev < 0.05) return
      const now = performance.now() / 1000
      if (now - dentAt < DENT_GAP) return
      dentAt = now
      if (!dents) dentTargets()
      const lx = leftX()
      const rnd = Math.random
      const k = Math.min(1, r.sev)
      const rad = 0.22 + 0.35 * k
      const depth = Math.min(DENT_MAX, 0.035 + 0.18 * k)
      // side > 0 — толкнуло влево, значит удар справа
      const hitX = r.side > 0 ? -lx : lx
      if (r.zone === 'front') press(dc.set(hitX * (0.2 + 0.5 * rnd()), 0.12 + 0.15 * rnd(), 2.35 + 0.5 * rnd()).clone(), new THREE.Vector3(-hitX * 0.25, -0.15, -1).normalize(), rad * 1.2, depth, 'front', 0.05 * k)
      else if (r.zone === 'rear') press(dc.set((rnd() - 0.5) * 0.8, 0.35 + 0.5 * rnd(), -2.3 - 0.3 * rnd()).clone(), new THREE.Vector3(0, -0.1, 1).normalize(), rad, depth, 'rear', 0)
      else press(dc.set(hitX * 0.8, 0.3 + 0.25 * rnd(), (rnd() - 0.4) * 2.4).clone(), new THREE.Vector3(-hitX, 0, (rnd() - 0.5) * 0.4).normalize(), rad, depth, r.zone, 0)
    },

    setPaint(hex) {
      materials.paint?.color.set(hex)
    },

    // состав шин: цвет маркировки на боковинах (мягкие красные, средние жёлтые, твёрдые белые); вызывать можно каждый кадр
    setCompound(id) {
      if (current === id) return
      if (wheels[0].tyres[id]) {
        current = id
        for (const w of wheels) for (const [c, t] of Object.entries(w.tyres)) t.visible = c === id
        return
      }
      const m = sidewallMats[id] || sidewallMats.soft
      if (!m) return
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

    driver,
    get driverHead() {
      return driverHead
    },

    // пилот: helmet — основа шлема, helmet2 — полоса, suit — комбинезон, gloves — перчатки (любой можно не указывать)
    setDriver({ helmet, helmet2, suit, gloves }) {
      if (helmet) driverMats.helmet_main?.color.set(helmet)
      if (helmet2) driverMats.helmet_stripe?.color.set(helmet2)
      if (suit) driverMats.driver_suit?.color.set(suit)
      if (gloves) driverMats.driver_gloves?.color.set(gloves)
    },

    setFinish(id) {
      const f = FINISHES[id] ?? FINISHES.gloss
      for (const n of ['paint', 'paint_livery', 'paint_secondary']) {
        const m = materials[n]
        if (!m) continue
        if (!finishBase.has(m)) finishBase.set(m, { roughness: m.roughness, metalness: m.metalness, clearcoat: m.clearcoat, clearcoatRoughness: m.clearcoatRoughness })
        const b = finishBase.get(m)
        m.roughness = f.roughness ?? b.roughness
        m.metalness = f.metalness ?? b.metalness
        if (m.isMeshPhysicalMaterial) {
          m.clearcoat = f.clearcoat ?? b.clearcoat
          m.clearcoatRoughness = f.clearcoatRoughness ?? b.clearcoatRoughness
        }
      }
    },

    // номер на носу и по бокам (были «16»): рисуем свой поверх места старых цифр, тем же белым — контраст сделает decalContrast
    setNumber(n) {
      const list = decals.filter((d) => /number/.test(d.name))
      if (!list.length) return
      const text = String(n)
      for (const d of list) {
        d.orig ||= { canvas: d.canvas, map: d.map, box: alphaBox(d.canvas) }
        if (text === '16') {
          d.canvas = d.orig.canvas
          d.map = d.orig.map
        } else {
          d.canvas = drawNumber(d.orig.canvas, d.orig.box, text)
          d.map = textureLike(d.canvas, d.orig.map)
        }
        d.tex = {}
        d.state = 'x' // заставить decalContrast поставить картинку заново
        d.mat.map = d.map
        d.mat.needsUpdate = true
      }
      decalContrast(list, livery.primary, livery.secondary)
    },

    // halo из кабины (Рома 31.10: «палка перед глазами, я не вижу поворота»): show — как есть, fade — полупрозрачный, hide — нет.
    // Материалы дуги и её наклеек у болида игрока — свои копии (у ботов дуга обычная). Вызывать можно каждый кадр
    setHaloView(mode) {
      if (mode === haloMode) return
      haloMode = mode
      if (!haloParts) {
        haloParts = []
        const take = (o) => {
          if (!o.isMesh) return
          o.material = o.material.clone()
          haloParts.push({ o, opacity: o.material.opacity, transparent: o.material.transparent }) // глубину пишет: размытие в движении её не смазывает
        }
        carRoot.getObjectByName('halo')?.traverse(take)
        scene.getObjectByName('decals')?.traverse((o) => /halo/.test(o.name) && take(o))
      }
      for (const p of haloParts) {
        const m = p.o.material
        p.o.visible = mode !== 'hide'
        m.transparent = mode === 'fade' ? true : p.transparent
        m.opacity = mode === 'fade' ? p.opacity * HALO_FADE : p.opacity
        m.needsUpdate = true
      }
    },

    // подсветить детали узла сборки (engine, aero…) или снять (null); t — время, для мерцания
    highlight(id, t = 0) {
      if (hlOn !== id) {
        if (hlOn) for (const o of hlMeshes(hlOn)) o.visible = false
        hlOn = id
        if (id) for (const o of hlMeshes(id)) o.visible = true
      }
      if (id) hlMat.opacity = 0.12 + 0.12 * (0.5 + 0.5 * Math.sin(t * 4))
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
        const rt = new THREE.WebGLRenderTarget(400, 180, { samples: 2 }) // вдвое чётче, со сглаживанием (было 200×90 — «пиксели»)
        // экран чуть ближе к пилоту, чем стекло. Отражение получается само: камера смотрит назад, и левое сзади (+X) у неё
        // справа на картинке — а пилот видит правую часть текстуры (+X экрана) слева от себя, как в настоящем зеркале
        const geo = new THREE.PlaneGeometry(size.x * 0.96, size.y * 0.9)
        const mat = new THREE.MeshBasicMaterial({ map: rt.texture, side: THREE.DoubleSide })
        const screen = new THREE.Mesh(geo, mat)
        screen.name = 'mirror_screen_' + k
        screen.position.set(ctr.x, ctr.y, box.min.z - 0.002)
        carRoot.add(screen)
        // камера: из точки зеркала назад, чуть развёрнута наружу (видно заднее колесо и трассу сбоку). Камера three.js и так
        // смотрит в −Z, а нос болида — +Z: то есть назад без разворота (30.10 был разворот на 180° — зеркала показывали перед)
        const cam = new THREE.PerspectiveCamera(22, size.x / size.y, 0.3, 400)
        cam.position.set(ctr.x * 1.05, ctr.y + 0.02, box.min.z - 0.03)
        cam.rotation.set(0, k === 'L' ? -0.12 : 0.12, 0)
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
        // спицами (36° / 2 у диска из wheels.glb): иначе глаз видит вращение назад или остановку («эффект колеса»)
        const phys = pw.spin
        if (w.lastPhys === undefined) w.lastPhys = phys
        const step = THREE.MathUtils.clamp(phys - w.lastPhys, -MAX_SPIN_PER_FRAME, MAX_SPIN_PER_FRAME)
        w.lastPhys = phys
        w.spin = ((w.spin || 0) + step) % (Math.PI * 2)
        w.node.rotation.x = w.spin
      }

      // руль крутится с колёсами, руки — за ним
      if (sw) {
        const steer = (v.wheels[0].steer + v.wheels[1].steer) / 2
        sw.pivot.quaternion.copy(sw.base).multiply(tmpQ.setFromAxisAngle(Z_AXIS, THREE.MathUtils.clamp(steer * WHEEL_TURN, -1.7, 1.7)))
        poseArms()
      }

      drs.rotation.x = TUNING.aeroOpenRad * v.aero
      // разрушенные крылья отваливаются: переднее — обе половины выше 90%, заднее — выше 95%
      const dm = v.damage
      if (frontWingNode) frontWingNode.visible = Math.min(dm.wingL, dm.wingR) < 0.9
      if (dents) dentRepairs(dm)
      if (rearWingNode) rearWingNode.visible = dm.rearWing < 0.95
      drs.visible = dm.rearWing < 0.95

      // задние огни горят при торможении
      const braking = v.state.braking ? 1 : 0
      const rear = materials.light_rear
      if (rear) rear.emissiveIntensity = THREE.MathUtils.lerp(rear.emissiveIntensity, braking ? 5 : 0.8, 0.3)
    },
  }
  return car
}
