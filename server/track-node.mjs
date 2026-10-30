// Трасса для сервера (Node, без three.js): читает GLB напрямую и собирает то же, что circuit.js в браузере —
// ось, решётку, пит-лейн, сектора, зоны режима прямой и коллизию по тем же именам деталей. Гонка на сервере
// должна ехать по той же геометрии, что у игрока, иначе предсказание и итоги разойдутся.
// Мировые матрицы узлов считаем сами (glTF хранит иерархию), поэтому работает и без translation у узла.
import fs from 'node:fs'
import { STATIC_GROUPS } from '../src/vehicle.js'

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }
const SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }

// glTF-матрицы хранятся по столбцам: элемент (строка r, столбец c) — в [c * 4 + r]
function mul(a, b) {
  const o = new Array(16)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      o[c * 4 + r] = s
    }
  return o
}

function localMatrix(n) {
  if (n.matrix) return n.matrix.slice()
  const [x, y, z] = n.translation || [0, 0, 0]
  const [qx, qy, qz, qw] = n.rotation || [0, 0, 0, 1]
  const [sx, sy, sz] = n.scale || [1, 1, 1]
  return [
    (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
    2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
    2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
    x, y, z, 1,
  ]
}

// читает GLB: JSON-часть и бинарную (BIN), без внешних зависимостей
function readGLB(file) {
  const buf = fs.readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${file}: не GLB`)
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  const binStart = 20 + jsonLen + 8
  const bin = buf.subarray(binStart)
  return { json, view: new DataView(bin.buffer, bin.byteOffset, bin.byteLength) }
}

function readAccessor(glb, index) {
  const { json, view } = glb
  const acc = json.accessors[index]
  const bv = json.bufferViews[acc.bufferView]
  const n = COUNT[acc.type]
  const size = SIZE[acc.componentType]
  const stride = bv.byteStride || n * size
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0)
  const out = new Float32Array(acc.count * n)
  for (let i = 0; i < acc.count; i++)
    for (let c = 0; c < n; c++) {
      const o = base + i * stride + c * size
      let v
      switch (acc.componentType) {
        case 5126:
          v = view.getFloat32(o, true)
          break
        case 5125:
          v = view.getUint32(o, true)
          break
        case 5123:
          v = view.getUint16(o, true)
          break
        case 5121:
          v = view.getUint8(o)
          break
        case 5122:
          v = view.getInt16(o, true)
          break
        default:
          v = view.getInt8(o)
      }
      out[i * n + c] = v
    }
  return out
}

// Загрузка трассы из GLB. Возвращает объект с тем же набором полей, что у createTrack в circuit.js,
// плюс attachPhysics(RAPIER, world): коллайдеры трассы в мире физики (вызывается один раз на мир)
export function loadTrack(file) {
  const glb = readGLB(file)
  const { json } = glb
  const parent = new Array(json.nodes.length).fill(-1)
  json.nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)))
  const world = new Array(json.nodes.length)
  const visit = (i, pw) => {
    const w = mul(pw, localMatrix(json.nodes[i]))
    world[i] = w
    for (const c of json.nodes[i].children || []) visit(c, w)
  }
  for (const r of json.scenes[json.scene ?? 0].nodes) visit(r, IDENT)

  // имена в GLB — с пробелами, как в файле (circuit.js ищет те же имена через sanitizeNodeName)
  const byName = (name) => json.nodes.findIndex((n) => n.name === name)
  const find = (name) => {
    const i = byName(name)
    return i < 0 ? null : i
  }
  const subtree = (i) => {
    const out = []
    const walk = (k) => {
      out.push(k)
      for (const c of json.nodes[k].children || []) walk(c)
    }
    if (i !== null) walk(i)
    return out
  }
  const isInside = (i, ancestor) => {
    for (let p = i; p >= 0; p = parent[p]) if (p === ancestor) return true
    return false
  }
  const childrenOf = (name) => (find(name) === null ? [] : json.nodes[find(name)].children || [])
  const nameOfMesh = (i) => {
    let p = i
    let name = json.nodes[p].name || ''
    while (/_\d+$/.test(name) && parent[p] >= 0) {
      p = parent[p]
      name = json.nodes[p].name || ''
    }
    return name.replace(/_/g, ' ')
  }

  const pose = (i) => {
    const w = world[i]
    const dx = w[8]
    const dz = w[10]
    return { x: w[12], y: w[13], z: w[14], yaw: Math.atan2(dx, dz) }
  }
  const extrasOf = (i) => json.nodes[i].extras || {}

  // ось трассы: дочерние точки каждые 2 м, по distance_m
  const axis = childrenOf('Ось трассы')
    .map((i) => ({ ...pose(i), ...extrasOf(i) }))
    .sort((a, b) => a.distance_m - b.distance_m)
  const startI = find('Старт P1')
  const startPose = startI !== null ? pose(startI) : axis[0] || { x: 0, z: 0, yaw: 0 }
  const grid = []
  for (let k = 1; k <= 20; k++) {
    const i = find(`Старт P${k}`)
    if (i !== null) grid.push(pose(i))
  }
  const length = axis.length ? axis[axis.length - 1].distance_m + 2 : 0
  const straightZone = straightZones(axis)

  const pitAxis = childrenOf('Ось пит-лейна')
    .map((i) => ({ ...pose(i), ...extrasOf(i) }))
    .sort((a, b) => a.distance_m - b.distance_m)
  const pitBoxes = []
  for (let k = 1; k <= 20; k++) {
    const i = find(`Пит-бокс ${k}`)
    if (i !== null) pitBoxes.push(pose(i))
  }
  const limStart = find('Пит лимит начало')
  const limEnd = find('Пит лимит конец')
  const pit =
    pitAxis.length > 10 && pitBoxes.length
      ? {
          axis: pitAxis,
          boxes: pitBoxes,
          limitStart: limStart !== null ? extrasOf(limStart).distance_m ?? 0 : 0,
          limitEnd: limEnd !== null ? extrasOf(limEnd).distance_m ?? pitAxis[pitAxis.length - 1].distance_m : pitAxis[pitAxis.length - 1].distance_m,
        }
      : null

  const sectors = childrenOf('Финиш и сектора').map((i) => ({ name: (json.nodes[i].name || '').replace(/_/g, ' '), ...pose(i), ...extrasOf(i) }))

  // коллизия: сетки треугольников в мировых координатах, как addTrimesh в circuit.js
  const meshesOf = (name, skip) => {
    const i = find(name)
    if (i === null) return []
    return subtree(i).filter((k) => json.nodes[k].mesh !== undefined && !(skip && skip(k)))
  }
  const primitives = (k) => json.meshes[json.nodes[k].mesh].primitives.filter((p) => (p.mode ?? 4) === 4)
  const surfaceByName = (name) => {
    if (/^Гравий/.test(name)) return 'gravel'
    if (/^Газон|^Трава/.test(name)) return 'grass'
    if (/^Поребрики/.test(name)) return 'kerb'
    return 'asphalt'
  }
  const pieces = []
  for (const k of meshesOf('Покрытие (коллизия)')) for (const p of primitives(k)) pieces.push({ node: k, prim: p, surface: surfaceByName(nameOfMesh(k)), friction: 1 })
  for (const name of ['Газон', 'Газон (инфилд)', 'Газон (у пит-уолла)']) for (const k of meshesOf(name)) for (const p of primitives(k)) pieces.push({ node: k, prim: p, surface: 'grass', friction: 1 })
  for (const name of ['Поребрики красные', 'Поребрики белые']) for (const k of meshesOf(name)) for (const p of primitives(k)) pieces.push({ node: k, prim: p, surface: 'kerb', friction: 1 })
  const fenceI = find('Сетка (без коллизии)')
  for (const k of meshesOf('Ограждения (коллизия)', (k) => fenceI !== null && isInside(k, fenceI))) for (const p of primitives(k)) pieces.push({ node: k, prim: p, surface: null, friction: 0.3 })

  // сборка буферов: вершины — в мировых координатах, индексы — как в файле
  const built = pieces.map((pc) => {
    const pos = readAccessor(glb, pc.prim.attributes.POSITION)
    const count = pos.length / 3
    const m = world[pc.node]
    const verts = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const x = pos[i * 3]
      const y = pos[i * 3 + 1]
      const z = pos[i * 3 + 2]
      verts[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12]
      verts[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
      verts[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]
    }
    const idx = pc.prim.indices !== undefined ? Uint32Array.from(readAccessor(glb, pc.prim.indices)) : Uint32Array.from({ length: count }, (_, i) => i)
    return { verts, idx, surface: pc.surface, friction: pc.friction }
  })
  // самая низкая точка покрытия: страховочная земля ниже неё
  let lowest = 0
  for (const b of built) if (b.surface) for (let i = 1; i < b.verts.length; i += 3) if (b.verts[i] < lowest) lowest = b.verts[i]

  let surfaceOf = new Map()
  const track = {
    length,
    axis,
    sectors,
    startPose,
    grid,
    pit,
    straightZone,
    lamps: [],
    stats: { pieces: built.length, axisPoints: axis.length, triangles: built.reduce((a, b) => a + b.idx.length / 3, 0) },
    // покрытие под колесом: по детали, в которую попал луч подвески (как в circuit.js)
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
    attachPhysics(RAPIER, physicsWorld) {
      surfaceOf = new Map()
      const body = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed())
      for (const b of built) {
        const c = physicsWorld.createCollider(RAPIER.ColliderDesc.trimesh(b.verts, b.idx).setFriction(b.friction).setRestitution(0.05).setCollisionGroups(STATIC_GROUPS), body)
        if (b.surface) surfaceOf.set(c.handle, b.surface)
      }
      const floorTop = Math.min(0, lowest) - 0.02
      const floor = physicsWorld.createCollider(RAPIER.ColliderDesc.cuboid(3000, 0.5, 3000).setTranslation(0, floorTop - 0.5, 0).setFriction(1).setCollisionGroups(STATIC_GROUPS), body)
      surfaceOf.set(floor.handle, 'grass')
    },
  }
  return track
}

// Зоны режима прямой — та же логика, что в circuit.js (прямая длиннее 300 м по оси)
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
