// Настоящая трасса из модели: картинка, физика и служебные точки. С 30.10 по умолчанию — public/models/marina.glb
// (Marina Bay, пока только асфальт, пит-лейн и разметка — окружение будет потом), прежняя — track.glb («LUMEN RING», адрес ?track=lumen).
// Физика берётся из групп модели по именам:
//   «Покрытие (коллизия)» и «Газон…» — по чему едут колёса (тип покрытия — по имени детали);
//   «Поребрики красные/белые» — в модели они в разметке без коллизии, здесь делаем их физическими:
//     они на 3 см выше асфальта, болид на них подпрыгивает и чуть теряет сцепление;
//   «Ограждения (коллизия)» без «Сетки» — стены, в которые болид упирается.
// Служебные точки: «Старт P1…P20», «Ось трассы» (каждые 2 м, ширина в extras), «Финиш и сектора».
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { STATIC_GROUPS } from './vehicle.js'

const nameOf = (s) => THREE.PropertyBinding.sanitizeNodeName(s)

function surfaceByName(name) {
  if (/^Гравий/.test(name)) return 'gravel'
  if (/^Газон|^Трава/.test(name)) return 'grass'
  if (/^Поребрики/.test(name)) return 'kerb'
  return 'asphalt' // полотно, зоны безопасности, пит-лейн, пол боксов
}

// Повтор асфальтовой плитки (4 м) на единицу UV каждой модели: у LUMEN RING одна единица ≈ 8 м, у Marina Bay — метры
const ASPHALT_UV_REPEAT = { '/models/track.glb': [2, 2], '/models/marina.glb': [0.25, 0.25] }

// Асфальт трассы: ровный тёмно-серый битум, как на фото трасс (Poly Haven, asphalt_track, CC0): мелкое сглаженное
// зерно и редкие светлые точки крошки. Никаких пятен и крупных узоров: полотно однотонное, отличие — только у гоночной
// линии (темнее от резины) и за ней. Зерно сглажено (2 px, без попиксельного шума — он рябит на ходу).
// Точки у края плитки рисуются с другой стороны, поэтому стык не виден.
function asphaltTexture(repeatX, repeatY) {
  const size = 512
  const cell = 2
  const n = size / cell
  const small = document.createElement('canvas')
  small.width = small.height = n
  const sg = small.getContext('2d')
  const sImg = sg.createImageData(n, n)
  for (let i = 0; i < n * n; i++) {
    const v = (Math.random() - 0.5) * 14
    sImg.data[i * 4] = 42 + v
    sImg.data[i * 4 + 1] = 42 + v
    sImg.data[i * 4 + 2] = 44 + v
    sImg.data[i * 4 + 3] = 255
  }
  sg.putImageData(sImg, 0, 0)
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  g.imageSmoothingEnabled = true
  g.drawImage(small, 0, 0, size, size)
  g.fillStyle = 'rgba(96, 96, 98, 0.3)'
  for (let k = 0; k < 900; k++) {
    const x = Math.random() * size
    const y = Math.random() * size
    const r = 0.6 + Math.random() * 0.8
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        g.beginPath()
        g.arc(x + dx, y + dy, r, 0, Math.PI * 2)
        g.fill()
      }
    }
  }
  // рельеф по тому же зерну: матовый битум ловит свет неровностями, поэтому зерно видно и с дистанции камеры
  const h = g.getImageData(0, 0, size, size).data
  const nc = document.createElement('canvas')
  nc.width = nc.height = size
  const ng = nc.getContext('2d')
  const nImg = ng.createImageData(size, size)
  const at = (x, y) => h[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = -(at(x + 1, y) - at(x - 1, y)) * 8
      const ny = -(at(x, y + 1) - at(x, y - 1)) * 8
      const len = Math.hypot(nx, ny, 1)
      const i = (y * size + x) * 4
      nImg.data[i] = (nx / len * 0.5 + 0.5) * 255
      nImg.data[i + 1] = (ny / len * 0.5 + 0.5) * 255
      nImg.data[i + 2] = (1 / len * 0.5 + 0.5) * 255
      nImg.data[i + 3] = 255
    }
  }
  ng.putImageData(nImg, 0, 0)
  const normal = new THREE.CanvasTexture(nc)
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping
  normal.repeat.set(repeatX, repeatY)
  normal.anisotropy = 8

  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(repeatX, repeatY)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return { map: t, normal }
}

export async function loadCircuit(url, scene, renderer, RAPIER, world, onProgress) {
  const gltf = await new GLTFLoader().loadAsync(url, onProgress)
  const root = gltf.scene
  root.updateMatrixWorld(true)
  const find = (name) => root.getObjectByName(nameOf(name))

  // картинка: трасса тени принимает, но не отбрасывает (тень считается только рядом с болидом)
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  root.traverse((o) => {
    if (!o.isMesh) return
    o.receiveShadow = true
    o.castShadow = false
    // у Marina Bay (30.10, вторая версия) в файле нет нормалей — загрузчик тогда рисует гранями; считаем гладкие
    if (!o.geometry.getAttribute('normal')) {
      o.geometry.computeVertexNormals()
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        m.flatShading = false
        m.needsUpdate = true
      }
    }
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
        if (m[key]) m[key].anisotropy = maxAniso
      }
    }
  })
  // асфальт: процедурная текстура вместо плоского цвета из модели; матовый, без бликов
  const [repeatX, repeatY] = ASPHALT_UV_REPEAT[url] || [1, 1]
  const asphalt = asphaltTexture(repeatX, repeatY)
  const doneAsphalt = new Set()
  root.traverse((o) => {
    if (!o.isMesh) return
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (doneAsphalt.has(m) || !/^(асфальт|asphalt)$/i.test(m.name)) continue
      doneAsphalt.add(m)
      m.map = asphalt.map
      m.normalMap = asphalt.normal
      m.color.set(0xffffff)
      m.roughness = 0.95
      m.metalness = 0
      m.needsUpdate = true
    }
  })
  // разметка лежит на 1 см выше асфальта — вдали этого мало, добавляем сдвиг глубины
  find('Разметка (без коллизии)')?.traverse((o) => {
    if (!o.isMesh) return
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      m.polygonOffset = true
      m.polygonOffsetFactor = -1
      m.polygonOffsetUnits = -4
    }
  })
  scene.add(root)

  // физика: каждая деталь — сетка треугольников в мировых координатах
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  const surfaceOf = new Map()
  const v = new THREE.Vector3()
  let lowest = 0 // самая низкая точка покрытия: страховочная земля должна быть ниже
  function addTrimesh(mesh, surface, friction = 1) {
    const pos = mesh.geometry.getAttribute('position')
    const verts = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
      verts[i * 3] = v.x
      verts[i * 3 + 1] = v.y
      verts[i * 3 + 2] = v.z
      if (surface && v.y < lowest) lowest = v.y
    }
    const index = mesh.geometry.index
    const idx = index ? Uint32Array.from(index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i)
    const collider = world.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx).setFriction(friction).setRestitution(0.05).setCollisionGroups(STATIC_GROUPS), body)
    if (surface) surfaceOf.set(collider.handle, surface)
  }
  const meshesIn = (obj, skip) => {
    const out = []
    obj?.traverse((o) => {
      if (o.isMesh && !o.isInstancedMesh && !(skip && skip(o))) out.push(o)
    })
    return out
  }
  // ближайшее «говорящее» имя: у деталей из нескольких материалов имя у родителя
  const ownName = (o) => {
    let p = o
    while (p && /_\d+$/.test(p.name) && p.parent) p = p.parent
    return p.name.replace(/_/g, ' ')
  }

  for (const m of meshesIn(find('Покрытие (коллизия)'))) addTrimesh(m, surfaceByName(ownName(m)))
  for (const name of ['Газон', 'Газон (инфилд)', 'Газон (у пит-уолла)']) for (const m of meshesIn(find(name))) addTrimesh(m, 'grass')
  for (const name of ['Поребрики красные', 'Поребрики белые']) for (const m of meshesIn(find(name))) addTrimesh(m, 'kerb')
  const fence = find('Сетка (без коллизии)')
  for (const m of meshesIn(find('Ограждения (коллизия)'), (o) => fence && isInside(o, fence))) addTrimesh(m, null, 0.3)

  // страховочная земля чуть ниже всего: если между деталями есть щель, болид не провалится.
  // У Marina Bay улицы с горбом: края асфальта на 11 см ниже оси — земля на 2 см ниже самой низкой точки покрытия
  const floorTop = Math.min(0, lowest) - 0.02
  const floor = world.createCollider(RAPIER.ColliderDesc.cuboid(3000, 0.5, 3000).setTranslation(0, floorTop - 0.5, 0).setFriction(1).setCollisionGroups(STATIC_GROUPS), body)
  surfaceOf.set(floor.handle, 'grass')
  // трасса без газона и без своей земли (Marina Bay пока только асфальт): видимая земля под ней, иначе под краем асфальта пустота.
  // Своя земля у Marina Bay будет «Земля города» (ТЗ окружения, на −0,2 м) — тогда наша не нужна, иначе закроет её
  if (!find('Газон') && !find('Земля города')) {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshLambertMaterial({ color: 0x3d4a35 }))
    ground.rotation.x = -Math.PI / 2
    ground.position.y = floorTop - 0.01
    ground.receiveShadow = true
    ground.renderOrder = -1
    ground.material.depthWrite = false
    scene.add(ground)
  }

  // служебные точки
  const dir = new THREE.Vector3()
  const pose = (o) => {
    o.getWorldPosition(v)
    o.getWorldDirection(dir)
    return { x: v.x, y: v.y, z: v.z, yaw: Math.atan2(dir.x, dir.z) }
  }
  // по distance_m: в файле Marina Bay точки записаны с конца
  const axis = (find('Ось трассы')?.children || []).map((o) => ({ ...pose(o), ...o.userData })).sort((a, b) => a.distance_m - b.distance_m)
  const start = find('Старт P1')
  const startPose = start ? pose(start) : axis[0] || { x: 0, z: 0, yaw: 0 }
  // решётка: P1…P20 по порядку (для гонки с ботами)
  const grid = []
  for (let i = 1; i <= 20; i++) {
    const o = find(`Старт P${i}`)
    if (o) grid.push(pose(o))
  }
  const length = axis.length ? axis[axis.length - 1].distance_m + 2 : 0
  const straightZone = straightZones(axis)
  // огни старта: пять колонн по две лампы («Огонь старта N верх/низ»)
  // пит-лейн: ось (точки каждые 2 м), 20 боксов, зона ограничителя 80 км/ч (distance_m по оси пит-лейна)
  const pitAxis = (find('Ось пит-лейна')?.children || []).map((o) => ({ ...pose(o), ...o.userData })).sort((a, b) => a.distance_m - b.distance_m)
  const pitBoxes = []
  for (let i = 1; i <= 20; i++) {
    const o = find(`Пит-бокс ${i}`)
    if (o) pitBoxes.push(pose(o))
  }
  const pit = pitAxis.length > 10 && pitBoxes.length
    ? { axis: pitAxis, boxes: pitBoxes, limitStart: find('Пит лимит начало')?.userData.distance_m ?? 0, limitEnd: find('Пит лимит конец')?.userData.distance_m ?? pitAxis[pitAxis.length - 1].distance_m }
    : null
  const lamps = [1, 2, 3, 4, 5].map((n) => [`Огонь старта ${n} верх`, `Огонь старта ${n} низ`].map(find).filter((o) => o && o.isMesh))
  const sectors = (find('Финиш и сектора')?.children || []).map((o) => ({ name: o.name.replace(/_/g, ' '), ...pose(o), ...o.userData }))

  return {
    length,
    axis,
    sectors,
    startPose,
    grid,
    // покрытие под колесом: по детали, в которую попал луч подвески
    surfaceAt(x, z, collider) {
      return (collider && surfaceOf.get(collider.handle)) || 'grass'
    },
    // ближайшая точка оси — для возврата на трассу
    poseNear(x, z) {
      let best = Infinity
      let bi = 0
      for (let i = 0; i < axis.length; i++) {
        const d = (axis[i].x - x) ** 2 + (axis[i].z - z) ** 2
        if (d < best) {
          best = d
          bi = i
        }
      }
      const a = axis[bi]
      return a ? { x: a.x, y: a.y, z: a.z, yaw: a.yaw } : startPose
    },
    lamps,
    pit,
    straightZone,
    stats: { colliders: surfaceOf.size, axisPoints: axis.length },
  }
}

function isInside(o, parent) {
  for (let p = o; p; p = p.parent) if (p === parent) return true
  return false
}

// Зоны режима прямой (активная аэродинамика 2026): прямые длиннее 300 м по оси трассы.
// Точка «на прямой», если за следующие 40 м ось поворачивает меньше чем на 3°; зона начинается через 30 м после начала прямой.
// На LUMEN RING это главная прямая (через финиш) и задняя прямая.
function straightZones(axis) {
  const n = axis.length
  const zone = new Uint8Array(n)
  if (!n) return zone
  const flat = axis.map((a, i) => {
    const d = axis[(i + 20) % n].yaw - a.yaw
    return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) < 0.052
  })
  const from = flat.indexOf(false)
  if (from < 0) return zone.fill(1)
  let run = []
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n
    if (flat[i]) run.push(i)
    else {
      if (run.length * 2 >= 300) run.slice(15).forEach((j) => (zone[j] = 1))
      run = []
    }
  }
  return zone
}
