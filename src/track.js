import * as THREE from 'three'
import { STATIC_GROUPS } from './vehicle.js'

// Простая плоская трасса для обкатки машины. Центральная линия — замкнутая кривая.
const CONTROL = [
  [0, -200], [0, 200], [0, 600], [90, 800], [300, 860], [480, 760], [520, 560], [440, 400],
  [470, 250], [560, 120], [640, -60], [620, -300], [480, -420], [260, -440], [90, -380],
]

export const ASPHALT_HALF = 7 // половина ширины асфальта, м
export const GRAVEL_OUTER = 16 // внешний край гравия от оси, м
const LINE_W = 0.25
const SAMPLES = 1600
const TILE = 8 // сколько метров покрывает одна плитка текстуры

// Мягкие пятна плюс слабое зерно. Резкий попиксельный шум рябит и мерцает на ходу,
// поэтому основа — плавная сетка 32×32, размытая по кругу (стык плитки не виден).
function noiseTexture(base, spread, grain) {
  const size = 256
  const N = 32
  const cell = size / N
  const grid = Array.from({ length: N * N }, () => Math.random() - 0.5)
  const smooth = (t) => t * t * (3 - 2 * t)
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  const img = g.createImageData(size, size)
  for (let y = 0; y < size; y++) {
    const gy = y / cell
    const y0 = Math.floor(gy) % N
    const y1 = (y0 + 1) % N
    const fy = smooth(gy - Math.floor(gy))
    for (let x = 0; x < size; x++) {
      const gx = x / cell
      const x0 = Math.floor(gx) % N
      const x1 = (x0 + 1) % N
      const fx = smooth(gx - Math.floor(gx))
      const top = grid[y0 * N + x0] * (1 - fx) + grid[y0 * N + x1] * fx
      const bottom = grid[y1 * N + x0] * (1 - fx) + grid[y1 * N + x1] * fx
      const n = (top * (1 - fy) + bottom * fy) * spread + (Math.random() - 0.5) * grain
      const i = (y * size + x) * 4
      img.data[i] = base[0] + n
      img.data[i + 1] = base[1] + n
      img.data[i + 2] = base[2] + n
      img.data[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

// Против мерцания вдали: полосы трассы стыкуются край в край и не лежат друг на друге,
// а трава рисуется первой и не пишет глубину — всё, что сверху, просто её закрашивает.
// Так не нужна логарифмическая глубина, которая отключает у видеокарты отсечение невидимого.

// Земля и трасса матовые, отражения неба на них не видны: простой матовый материал
// в разы дешевле на точку, а их на экране половина (−13% времени кадра на видеокарте)
function layerMaterial(map) {
  return new THREE.MeshLambertMaterial({ map })
}

export function buildTrack(scene, RAPIER, world) {
  const curve = new THREE.CatmullRomCurve3(
    CONTROL.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    true,
    'centripetal',
  )
  const length = curve.getLength()
  const pts = curve.getSpacedPoints(SAMPLES).slice(0, SAMPLES)
  const n = pts.length

  // касательная и «левая» сторона в каждой точке
  const tan = pts.map((_, i) => {
    const a = pts[(i + n - 1) % n]
    const b = pts[(i + 1) % n]
    return new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize()
  })
  const left = tan.map((t) => new THREE.Vector3(t.z, 0, -t.x))
  const dist = [0]
  for (let i = 1; i <= n; i++) dist.push(dist[i - 1] + pts[i % n].distanceTo(pts[i - 1]))

  // старт на середине длинной прямой, где трасса идёт ровно
  let startIdx = 0
  for (let i = 1; i < n; i++) {
    if (Math.hypot(pts[i].x, pts[i].z) < Math.hypot(pts[startIdx].x, pts[startIdx].z)) startIdx = i
  }

  // лента вдоль трассы между двумя смещениями от оси
  function ribbon(offA, offB, y, material) {
    const pos = new Float32Array((n + 1) * 2 * 3)
    const uv = new Float32Array((n + 1) * 2 * 2)
    const nor = new Float32Array((n + 1) * 2 * 3)
    for (let i = 0; i <= n; i++) {
      const k = i % n
      const p = pts[k]
      const l = left[k]
      const a = i * 2
      const b = i * 2 + 1
      pos.set([p.x + l.x * offA, y, p.z + l.z * offA], a * 3)
      pos.set([p.x + l.x * offB, y, p.z + l.z * offB], b * 3)
      uv.set([offA / TILE, dist[i] / TILE], a * 2)
      uv.set([offB / TILE, dist[i] / TILE], b * 2)
      nor.set([0, 1, 0, 0, 1, 0], a * 3)
    }
    const idx = []
    for (let i = 0; i < n; i++) {
      const a = i * 2
      const b = a + 1
      const a2 = a + 2
      const b2 = a + 3
      idx.push(a, a2, b, b, a2, b2)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    geo.setIndex(idx)
    const mesh = new THREE.Mesh(geo, material)
    mesh.receiveShadow = true
    scene.add(mesh)
    return mesh
  }

  // земля
  const grassMap = noiseTexture([78, 104, 58], 30, 5)
  grassMap.repeat.set(800, 800)
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(8000, 8000),
    new THREE.MeshLambertMaterial({ map: grassMap, depthWrite: false }),
  )
  ground.rotation.x = -Math.PI / 2
  ground.renderOrder = -1
  ground.receiveShadow = true
  scene.add(ground)

  // полосы стыкуются край в край: гравий | белая линия | асфальт | белая линия | гравий
  const gravelMat = layerMaterial(noiseTexture([176, 158, 120], 30, 14))
  const asphaltMat = layerMaterial(noiseTexture([58, 60, 64], 10, 6))
  const lineMat = new THREE.MeshLambertMaterial({ color: 0xf2f0ea })
  const inner = ASPHALT_HALF - LINE_W
  ribbon(ASPHALT_HALF, GRAVEL_OUTER, 0, gravelMat)
  ribbon(-GRAVEL_OUTER, -ASPHALT_HALF, 0, gravelMat)
  ribbon(-inner, inner, 0, asphaltMat)
  ribbon(inner, ASPHALT_HALF, 0, lineMat)
  ribbon(-ASPHALT_HALF, -inner, 0, lineMat)

  // стартовая линия
  {
    const c = document.createElement('canvas')
    c.width = 448
    c.height = 32
    const g = c.getContext('2d')
    for (let x = 0; x < 28; x++) {
      for (let y = 0; y < 2; y++) {
        g.fillStyle = (x + y) % 2 ? '#f2f0ea' : '#15171a'
        g.fillRect(x * 16, y * 16, 16, 16)
      }
    }
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.magFilter = THREE.NearestFilter
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(ASPHALT_HALF * 2, 1),
      // лежит на асфальте: небольшой сдвиг глубины, она всегда рядом с камерой
      new THREE.MeshLambertMaterial({ map: t, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    )
    line.rotation.x = -Math.PI / 2
    const holder = new THREE.Group()
    holder.position.copy(pts[startIdx])
    holder.rotation.y = Math.atan2(tan[startIdx].x, tan[startIdx].z)
    holder.add(line)
    scene.add(holder)
  }

  // столбики вдоль трассы: без них на ровном поле не чувствуется скорость
  {
    const step = 40
    const count = Math.floor(length / step)
    const geo = new THREE.CylinderGeometry(0.18, 0.18, 2.2, 8)
    geo.translate(0, 1.1, 0)
    const mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshLambertMaterial({ color: 0xe9e6df }),
      count * 2,
    )
    const m = new THREE.Matrix4()
    let id = 0
    for (let i = 0; i < count; i++) {
      const k = Math.min(n - 1, Math.round((i * step) / (length / n)))
      for (const side of [-1, 1]) {
        const off = side * (GRAVEL_OUTER + 3)
        m.makeTranslation(pts[k].x + left[k].x * off, 0, pts[k].z + left[k].z * off)
        mesh.setMatrixAt(id++, m)
      }
    }
    mesh.castShadow = true
    scene.add(mesh)
  }

  // физика: плоский пол
  const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(4000, 0.5, 4000).setTranslation(0, -0.5, 0).setFriction(1).setCollisionGroups(STATIC_GROUPS), floor)

  function nearest(x, z) {
    let best = Infinity
    let bi = 0
    for (let i = 0; i < n; i++) {
      const dx = pts[i].x - x
      const dz = pts[i].z - z
      const d2 = dx * dx + dz * dz
      if (d2 < best) {
        best = d2
        bi = i
      }
    }
    return { d: Math.sqrt(best), i: bi }
  }

  const poseAt = (i) => ({ x: pts[i].x, z: pts[i].z, yaw: Math.atan2(tan[i].x, tan[i].z) })

  return {
    length,
    startPose: poseAt(startIdx),
    surfaceAt(x, z) {
      const { d } = nearest(x, z)
      if (d <= ASPHALT_HALF) return 'asphalt'
      if (d <= GRAVEL_OUTER) return 'gravel'
      return 'grass'
    },
    // ближайшая точка трассы для возврата на асфальт
    poseNear(x, z) {
      return poseAt(nearest(x, z).i)
    },
  }
}
