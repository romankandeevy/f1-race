// Ночное освещение трассы фонарями (Рома 30.10: «только трасса освещается от фонарей, свет и тени — от них»).
// Фонари — настоящие источники света (SpotLight) в местах прожекторов трассы, каждый смотрит на ближайшую точку оси.
// У Marina Bay прожекторы есть в модели: «Панели прожекторов» с материалом «прожектор» — точки берём из их вершин
// (кучки вершин = отдельные панели), ночью панели светятся ярче. У трасс без своих прожекторов (LUMEN RING) — свои мачты
// через 50 м по обе стороны (InstancedMesh, видны только ночью).
// Светит пул из POOL ближайших к болиду фонарей (впереди по ходу — важнее): сотни источников браузер не потянет, а дальние
// и так не видны. У SHADOWS ближайших — тени. Источник у края пула гаснет плавно, поэтому при смене фонаря свет не мигает.
import * as THREE from 'three'

const LAMP_MATERIAL = 'прожектор' // материал панелей прожекторов в модели трассы
const LAMP_NIGHT = 4 // яркость панелей ночью (днём — как в модели)
// Ровная база (Рома 30.10: «не должно быть чёрных пятен, я должен видеть всё впереди»): как на настоящей ночной гонке,
// где сотни прожекторов заливают трассу равномерно, поверхности трассы ночью светятся долей своего цвета по всей длине.
// Пул фонарей ниже даёт поверх неё объём и тени рядом с болидом.
const TRACK_PARTS = ['Покрытие (коллизия)', 'Разметка (без коллизии)', 'Поребрики красные', 'Поребрики белые', 'Ограждения (коллизия)', 'Газон', 'Газон (инфилд)', 'Газон (у пит-уолла)']
// свечение = цвет поверхности × GLOW. Днём асфальт светлым делает отражённое небо (его ночью нет), поэтому нужно больше 1:
// при 0,6 асфальт Марины (#2c2d31) оставался чёрным, при 2,5 — как днём; 2 — светлая трасса, но ночь
const GLOW = 2
const POOL = 12 // одновременно светящих фонарей (у Марины они парами через ~30 м: ±90 м вокруг болида)
const SHADOWS = 3 // из них с тенями (ближайшие)
// Тени фонарей (Рома 31.10: «вижу лесенки на трассе, вижу, как всё прорисовывается»): раньше пул каждый кадр раздавался заново
// по расстоянию — фонарь прыгал между слотами с тенью и без, тени на асфальте мигали; карта 1024 на весь конус 115° до 160 м —
// крупные ступеньки. Теперь фонарь держит свой слот, пока светит; тень переходит к другому, только если тот заметно ближе
// (SHADOW_SWAP); тень считается в середине конуса (SHADOW_FOCUS) и до SHADOW_FAR м, карта — по качеству (setShadowSize), края мягче
const SHADOW_SWAP = 0.8 // новый фонарь забирает тень, если он ближе 0,8 расстояния до самого дальнего из «теневых»
const SHADOW_FOCUS = 0.55
const SHADOW_FAR = 70
const INTENSITY = 900 // кд: поверх ровной базы — светлее под фонарём, но без резких пятен
const RANGE = 160 // м: дальше свет фонаря не считаем
const ANGLE = 1.0 // рад, половина конуса: пятна соседних фонарей перекрываются, между ними нет тёмных полос
const AHEAD = 15 // м: центр выбора фонарей — чуть впереди болида (сам болид и асфальт под ним тоже под фонарями)
const MERGE = 4 // м: вершины ближе — одна панель
const TRACK_NEAR = 70 // м: дальше от оси трассы — не фонарь трассы
const EVERY = 25 // своих мачт: точек оси (по 2 м) — мачта каждые 50 м
const OUT = 5 // м за край асфальта
const HEIGHT = 16 // м
const PIT_CLEAR = 14 // м: у пит-лейна своих мачт нет
const TILT = 0.45 // рад: голова своей мачты смотрит вниз, на трассу
// Болиды ночью (Рома 30.10: «машина тёмная»): асфальт светится ровно, а кузов от пары фонарей сбоку сверху и тёмного неба
// почти не освещён. У болидов ночью своё окружение «стадиона» (envMap только на их материалах): тёмное небо, яркое кольцо
// прожекторов у горизонта, светлая трасса снизу — кузов освещён со всех сторон и блестит прожекторами, город остаётся тёмным.
const CAR_ENV = 1.1 // сила этого окружения на кузове

// окружение «стадиона» для болидов: картинка-развёртка → PMREM (как небо в env.js)
function stadiumEnv(renderer) {
  const W = 512
  const H = 256
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  const grad = g.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, '#05070d') // небо
  grad.addColorStop(0.34, '#121826')
  grad.addColorStop(0.4, '#cfc8b8') // кольцо прожекторов
  grad.addColorStop(0.47, '#f2ece0')
  grad.addColorStop(0.52, '#8a8a8c') // освещённая трасса и ограждения
  grad.addColorStop(1, '#4a4b4f')
  g.fillStyle = grad
  g.fillRect(0, 0, W, H)
  // отдельные прожекторы в кольце — блики на кузове, а не ровная полоса
  g.fillStyle = '#ffffff'
  for (let i = 0; i < 24; i++) g.fillRect((i + 0.5) * (W / 24) - 6, H * 0.37, 12, 7)
  const tex = new THREE.CanvasTexture(c)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.colorSpace = THREE.SRGBColorSpace
  const pmrem = new THREE.PMREMGenerator(renderer)
  const target = pmrem.fromEquirectangular(tex)
  tex.dispose()
  pmrem.dispose()
  return target.texture
}

// renderer — для окружения болидов ночью (без него болиды освещаются только фонарями)
export function createFloodlights(scene, track, renderer = null) {
  const axis = track.axis || []
  const nearestAxis = (x, z) => {
    let best = Infinity
    let bi = 0
    for (let i = 0; i < axis.length; i++) {
      const d = (axis[i].x - x) ** 2 + (axis[i].z - z) ** 2
      if (d < best) {
        best = d
        bi = i
      }
    }
    return { a: axis[bi], d: Math.sqrt(best) }
  }

  // панели прожекторов модели: материалы (для свечения) и меши (для мест фонарей)
  const lampMats = new Set()
  const lampMeshes = []
  scene.traverse((o) => {
    if (!o.isMesh) return
    for (const m of Array.isArray(o.material) ? o.material : [o.material])
      if (m.name === LAMP_MATERIAL && m.emissive) {
        lampMats.add(m)
        lampMeshes.push(o)
      }
  })
  const dayGlow = new Map([...lampMats].map((m) => [m, m.emissiveIntensity]))

  // поверхности трассы для ровной базы: без цвета по вершинам и без прозрачных (сетка) — у них свечение было бы не того цвета.
  // Текстуру (асфальт, трава у LUMEN RING) ставим и в свечение — сразу, чтобы шейдер собрался один раз
  const glowMats = new Map() // материал → его свечение днём
  for (const name of TRACK_PARTS) {
    scene.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name))?.traverse((o) => {
      if (!o.isMesh) return
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m.emissive || m.vertexColors || m.transparent || m.alphaTest > 0 || glowMats.has(m) || lampMats.has(m)) continue
        if (m.emissive.getHex() !== 0) continue // своё свечение днём — не трогаем
        glowMats.set(m, m.emissive.clone())
        if (m.map && !m.emissiveMap) {
          m.emissiveMap = m.map
          m.needsUpdate = true
        }
      }
    })
  }

  const lamps = [] // { p: Vector3, t: Vector3 } — где фонарь и куда светит
  let masts = null
  if (lampMeshes.length) {
    // кучки вершин → центры панелей
    const v = new THREE.Vector3()
    const groups = []
    for (const mesh of new Set(lampMeshes)) {
      mesh.updateWorldMatrix(true, false)
      const pos = mesh.geometry.getAttribute('position')
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
        let g = groups.find((c) => c.n && (c.x / c.n - v.x) ** 2 + (c.y / c.n - v.y) ** 2 + (c.z / c.n - v.z) ** 2 < MERGE * MERGE)
        if (!g) groups.push((g = { x: 0, y: 0, z: 0, n: 0 }))
        g.x += v.x
        g.y += v.y
        g.z += v.z
        g.n++
      }
    }
    for (const g of groups) {
      const p = new THREE.Vector3(g.x / g.n, g.y / g.n, g.z / g.n)
      const near = nearestAxis(p.x, p.z)
      if (!near.a || near.d > TRACK_NEAR) continue
      lamps.push({ p, t: new THREE.Vector3(near.a.x, near.a.y || 0, near.a.z) })
    }
  } else {
    masts = buildMasts(scene, track, lamps)
  }

  // пул источников: позиции и цели меняются каждый кадр, число источников постоянно (шейдер не пересобирается)
  const lights = new THREE.Group()
  const pool = []
  for (let i = 0; i < POOL; i++) {
    const l = new THREE.SpotLight(0xfff3e2, 0, RANGE, ANGLE, 0.6, 2)
    if (i < SHADOWS) {
      l.castShadow = true
      l.shadow.mapSize.set(1024, 1024)
      l.shadow.camera.near = 2
      l.shadow.camera.far = SHADOW_FAR
      l.shadow.focus = SHADOW_FOCUS
      l.shadow.radius = 2
      l.shadow.bias = -0.0004
      l.shadow.normalBias = 0.04
    }
    lights.add(l, l.target)
    pool.push(l)
  }
  lights.visible = false
  scene.add(lights)

  const ahead = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const order = lamps.map((_, i) => i)
  const dist = new Float32Array(lamps.length)
  const slotLamp = new Int32Array(POOL).fill(-1) // какой фонарь в каком слоте пула (держится, пока фонарь в пуле)
  const wanted = new Uint8Array(lamps.length)
  let night = 0

  // материалы болидов → их собственное окружение днём ({ map, k }); ночью на них окружение «стадиона»
  const carEnv = renderer ? stadiumEnv(renderer) : null
  let carMats = new Map()
  const applyCars = () => {
    for (const [m, own] of carMats) {
      m.envMap = night > 0.5 && carEnv ? carEnv : own.map
      m.envMapIntensity = night > 0.5 && carEnv ? CAR_ENV : own.k
    }
  }

  return {
    count: lamps.length,
    // 0 — день: фонари выключены, мачт нет; 1 — ночь
    setNight(k) {
      night = k
      lights.visible = k > 0.5 && lamps.length > 0
      if (masts) masts.visible = k > 0.5
      for (const m of lampMats) m.emissiveIntensity = dayGlow.get(m) + (LAMP_NIGHT - dayGlow.get(m)) * k
      for (const [m, day] of glowMats) m.emissive.copy(day).lerp(m.color, GLOW * k)
      applyCars()
    },
    // какие болиды сейчас на трассе (игрок и боты; после каждой расстановки): ночью на них окружение «стадиона»
    cars(groups) {
      for (const [m, own] of carMats) {
        m.envMap = own.map
        m.envMapIntensity = own.k
      }
      carMats = new Map()
      for (const gr of groups)
        gr?.traverse((o) => {
          if (!o.isMesh) return
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m.isMeshStandardMaterial && !carMats.has(m)) carMats.set(m, { map: m.envMap, k: m.envMapIntensity })
        })
      applyCars()
    },
    // размер карты теней фонарей (качество графики)
    setShadowSize(n) {
      for (let i = 0; i < SHADOWS; i++) {
        const sh = pool[i].shadow
        if (sh.mapSize.x === n) continue
        sh.mapSize.set(n, n)
        sh.map?.dispose()
        sh.map = null
      }
    },
    // раз в кадр: ближайшие к болиду фонари (центр — впереди по ходу) светят, у края пула гаснут плавно
    update(car) {
      if (!lights.visible) return
      fwd.set(0, 0, 1).applyQuaternion(car.quaternion)
      ahead.copy(car.position).addScaledVector(fwd, AHEAD)
      for (let i = 0; i < lamps.length; i++) dist[i] = lamps[i].p.distanceToSquared(ahead)
      order.sort((a, b) => dist[a] - dist[b])
      const edge = Math.sqrt(dist[order[Math.min(POOL, order.length - 1)]])
      // слоты: фонарь, который остался в пуле, остаётся в своём слоте; ушедшие освобождают место новым
      wanted.fill(0)
      const n = Math.min(POOL, order.length)
      for (let r = 0; r < n; r++) wanted[order[r]] = 1
      for (let i = 0; i < POOL; i++) if (slotLamp[i] >= 0 && !wanted[slotLamp[i]]) slotLamp[i] = -1
      for (let r = 0; r < n; r++) {
        const k = order[r]
        if (slotLamp.includes(k)) continue
        // ближние (r < SHADOWS) — сначала в свободный слот с тенью, остальные — сначала в слот без тени
        let free = -1
        for (let i = r < SHADOWS ? 0 : SHADOWS; i < POOL && free < 0; i++) if (slotLamp[i] < 0) free = i
        for (let i = 0; i < POOL && free < 0; i++) if (slotLamp[i] < 0) free = i
        slotLamp[free] = k
      }
      // тень — ближайшим, но с запасом: самый дальний из «теневых» отдаёт её, только если есть заметно ближе (не мигает)
      let far = -1
      for (let i = 0; i < SHADOWS; i++) if (far < 0 || slotLamp[i] < 0 || (slotLamp[far] >= 0 && dist[slotLamp[i]] > dist[slotLamp[far]])) far = i
      let near = -1
      for (let i = SHADOWS; i < POOL; i++) if (slotLamp[i] >= 0 && (near < 0 || dist[slotLamp[i]] < dist[slotLamp[near]])) near = i
      if (far >= 0 && near >= 0 && (slotLamp[far] < 0 || dist[slotLamp[near]] < dist[slotLamp[far]] * SHADOW_SWAP * SHADOW_SWAP)) {
        const t = slotLamp[far]
        slotLamp[far] = slotLamp[near]
        slotLamp[near] = t
      }
      for (let i = 0; i < POOL; i++) {
        const l = pool[i]
        const k = slotLamp[i]
        if (k < 0) {
          l.intensity = 0
          continue
        }
        const d = Math.sqrt(dist[k])
        const fade = order.length > POOL ? THREE.MathUtils.clamp((edge - d) / (edge * 0.35), 0, 1) : 1
        l.position.copy(lamps[k].p)
        l.target.position.copy(lamps[k].t)
        l.intensity = INTENSITY * fade * night
      }
    },
  }
}

// свои мачты вдоль трассы (для трасс без прожекторов в модели): по обе стороны через 50 м, голова — фонарь
function buildMasts(scene, track, lamps) {
  const axis = track.axis || []
  const pit = track.pit?.axis || []
  const nearPit = (x, z) => pit.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < PIT_CLEAR * PIT_CLEAR)
  const spots = []
  for (let i = 0; i < axis.length; i += EVERY) {
    const a = axis[i]
    const fx = Math.sin(a.yaw)
    const fz = Math.cos(a.yaw)
    // ширина в обе стороны — по большей: мачта никогда не встанет на асфальт
    const w = Math.max(a.width_left ?? 7, a.width_right ?? 7) + OUT
    for (const side of [1, -1]) {
      const x = a.x + side * fz * w
      const z = a.z - side * fx * w
      if (nearPit(x, z)) continue
      spots.push({ x, y: a.y || 0, z, face: Math.atan2(a.x - x, a.z - z), a })
    }
  }
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.2, HEIGHT, 6).translate(0, HEIGHT / 2, 0)
  const headGeo = new THREE.BoxGeometry(2.4, 1, 0.35)
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b2e34, roughness: 0.6, metalness: 0.5 })
  // голова светится сама: без тональной коррекции — чисто белая
  const headMat = new THREE.MeshBasicMaterial({ color: 0xfff7e8, toneMapped: false })
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, spots.length)
  const heads = new THREE.InstancedMesh(headGeo, headMat, spots.length)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const e = new THREE.Euler()
  const p = new THREE.Vector3()
  const one = new THREE.Vector3(1, 1, 1)
  spots.forEach((s, i) => {
    q.setFromEuler(e.set(0, s.face, 0))
    poles.setMatrixAt(i, m.compose(p.set(s.x, s.y, s.z), q, one))
    // голова — на верхушке, чуть вынесена к трассе и наклонена вниз; оттуда же светит фонарь
    q.setFromEuler(e.set(TILT, s.face, 0, 'YXZ'))
    const head = new THREE.Vector3(s.x + Math.sin(s.face) * 0.6, s.y + HEIGHT + 0.3, s.z + Math.cos(s.face) * 0.6)
    heads.setMatrixAt(i, m.compose(head, q, one))
    lamps.push({ p: head.clone().setY(head.y - 0.6), t: new THREE.Vector3(s.a.x, s.a.y || 0, s.a.z) })
  })
  for (const mesh of [poles, heads]) {
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
  }
  const group = new THREE.Group()
  group.add(poles, heads)
  group.visible = false
  scene.add(group)
  return group
}
