// Лес (Рома 01.11: «деревья» — после «всё невзрачное»). В модели Спа лес — три склеенные сетки («Лес — ели», «Лес —
// лиственные», «Лес — стволы»; 8700 деревьев): ель — пара голых конусов по ~10 точек, крона — многогранник. Издалека
// ещё ничего, а у трассы видно «игрушку».
// Здесь склеенные сетки крон разбираются на отдельные деревья (связные куски сетки → место, высота, ширина, цвет), и вместо
// них ставятся свои деревья экземплярами (InstancedMesh): ель — шесть ярусов «лап» с рваным свисающим краем, лиственное —
// крона из нескольких комков. Тень внутри кроны (ниже и ближе к стволу темнее), у каждого дерева свой оттенок и поворот,
// верх качается от ветра. Ближние (до NEAR м от камеры) — подробные, дальние — простые; деление пересчитывается раз в
// RESORT кадров. Стволы остаются из модели.
import * as THREE from 'three'

const NEAR = 320 // м: ближе — подробные деревья
const RESORT = 20 // кадров между пересортировками ближних/дальних
const FOREST = /^Лес/ // склеенные сетки крон (Спа)

// ---- шаблоны (ось Y вверх, основание кроны в 0, высота 1, радиус 1) ----

// ель: ярусы-юбки, каждый — конус с рваным свисающим краем
function spruce(tiers, seg) {
  const pos = []
  const col = []
  const idx = []
  const rnd = mulberry(7)
  for (let t = 0; t < tiers; t++) {
    const k = t / tiers
    const y0 = k * 0.88 // низ яруса
    const y1 = Math.min(1, y0 + 0.3) // верх яруса
    const r = (1 - k) * 1.0 + 0.06
    const top = pos.length / 3
    pos.push(0, y1, 0)
    col.push(1.08, 1.08, 1.08)
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2 + t * 0.7
      const jag = i % 2 ? 0.72 : 1 + (rnd() - 0.5) * 0.15 // зубцы «лап»
      const rr = r * jag
      const droop = i % 2 ? 0.05 : -0.02 // концы лап ниже
      pos.push(Math.cos(a) * rr, y0 - droop * (1 - k), Math.sin(a) * rr)
      // нижняя сторона и глубина — темнее (заменяет тень внутри кроны)
      const ao = 0.55 + 0.35 * k + (i % 2 ? -0.1 : 0.05)
      col.push(ao, ao, ao)
    }
    for (let i = 0; i < seg; i++) idx.push(top, top + 1 + i + 1, top + 1 + i)
  }
  return geo(pos, col, idx, 'cone')
}

// лиственное: несколько сплюснутых комков
function crown(detail, lumps) {
  const parts = []
  const rnd = mulberry(11)
  for (let l = 0; l < lumps; l++) {
    const s = l === 0 ? 0.75 : 0.42 + rnd() * 0.18
    const a = (l / lumps) * Math.PI * 2
    const ox = l === 0 ? 0 : Math.cos(a) * 0.5
    const oz = l === 0 ? 0 : Math.sin(a) * 0.5
    const oy = l === 0 ? 0.55 : 0.35 + rnd() * 0.4
    const g = new THREE.IcosahedronGeometry(s, detail)
    const p = g.getAttribute('position')
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const y = p.getY(i)
      const z = p.getZ(i)
      const n = 1 + (Math.sin(x * 9.1 + z * 5.3) * Math.cos(y * 7.7)) * 0.08 // неровный край
      p.setXYZ(i, ox + x * n, oy + y * n * 0.85, oz + z * n)
    }
    parts.push(g.toNonIndexed())
  }
  const pos = []
  const col = []
  for (const g of parts) {
    const p = g.getAttribute('position')
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const y = p.getY(i)
      const z = p.getZ(i)
      pos.push(x, y, z)
      const ao = 0.5 + 0.55 * Math.min(1, Math.max(0, y)) * (0.7 + 0.3 * Math.min(1, Math.hypot(x, z)))
      col.push(ao, ao, ao)
    }
  }
  return geo(pos, col, null, 'blob')
}

// нормали «как у шара/конуса»: от оси наружу и вверх — крона освещается мягко целиком, без граней
function geo(pos, col, idx, kind) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  if (idx) g.setIndex(idx)
  const nrm = []
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i]
    const y = pos[i + 1]
    const z = pos[i + 2]
    const v = kind === 'cone' ? new THREE.Vector3(x, 0.6, z) : new THREE.Vector3(x, y - 0.45, z)
    if (v.lengthSq() < 1e-6) v.set(0, 1, 0)
    v.normalize()
    nrm.push(v.x, v.y, v.z)
  }
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  return g
}

function mulberry(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- разбор склеенной сетки на деревья ----
function splitTrees(mesh) {
  const g = mesh.geometry
  const p = g.getAttribute('position')
  const c = g.getAttribute('color')
  const n = p.count
  // одинаковые точки — одна вершина (сетка без общих вершин у граней)
  const parent = new Int32Array(n).map((_, i) => i)
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const join = (a, b) => {
    a = find(a)
    b = find(b)
    if (a !== b) parent[a] = b
  }
  const seen = new Map()
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(p.getX(i) * 100)},${Math.round(p.getY(i) * 100)},${Math.round(p.getZ(i) * 100)}`
    const j = seen.get(k)
    if (j !== undefined) join(i, j)
    else seen.set(k, i)
  }
  const index = g.index
  const tris = index ? index.count : n
  for (let t = 0; t < tris; t += 3) {
    const a = index ? index.getX(t) : t
    join(a, index ? index.getX(t + 1) : t + 1)
    join(a, index ? index.getX(t + 2) : t + 2)
  }
  const trees = new Map()
  const v = new THREE.Vector3()
  mesh.updateWorldMatrix(true, false)
  for (let i = 0; i < n; i++) {
    const r = find(i)
    let t = trees.get(r)
    if (!t) trees.set(r, (t = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity, r: 0, g: 0, b: 0, n: 0 }))
    v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld)
    t.x0 = Math.min(t.x0, v.x)
    t.x1 = Math.max(t.x1, v.x)
    t.y0 = Math.min(t.y0, v.y)
    t.y1 = Math.max(t.y1, v.y)
    t.z0 = Math.min(t.z0, v.z)
    t.z1 = Math.max(t.z1, v.z)
    if (c) {
      t.r += c.getX(i)
      t.g += c.getY(i)
      t.b += c.getZ(i)
    }
    t.n++
  }
  // в модели ель — два отдельных конуса один над другим: куски с одним центром (ближе MERGE м) — одно дерево
  const MERGE = 0.8
  const cell = new Map()
  const out = []
  for (const t of trees.values()) {
    const cx = (t.x0 + t.x1) / 2
    const cz = (t.z0 + t.z1) / 2
    const kx = Math.round(cx / MERGE)
    const kz = Math.round(cz / MERGE)
    let hit = null
    for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (let dz = -1; dz <= 1 && !hit; dz++) {
        for (const o of cell.get(`${kx + dx},${kz + dz}`) || []) {
          if (Math.hypot((o.x0 + o.x1) / 2 - cx, (o.z0 + o.z1) / 2 - cz) < MERGE) {
            hit = o
            break
          }
        }
      }
    }
    if (hit) {
      hit.x0 = Math.min(hit.x0, t.x0)
      hit.x1 = Math.max(hit.x1, t.x1)
      hit.y0 = Math.min(hit.y0, t.y0)
      hit.y1 = Math.max(hit.y1, t.y1)
      hit.z0 = Math.min(hit.z0, t.z0)
      hit.z1 = Math.max(hit.z1, t.z1)
      hit.r += t.r
      hit.g += t.g
      hit.b += t.b
      hit.n += t.n
      continue
    }
    const k = `${kx},${kz}`
    if (!cell.has(k)) cell.set(k, [])
    cell.get(k).push(t)
    out.push(t)
  }
  return out.filter((t) => t.y1 - t.y0 > 0.5)
}

// материал: цвет по вершинам (тень внутри кроны) × цвет дерева (экземпляр) × материал модели; верх качается от ветра
function treeMaterial(src, sway) {
  const m = new THREE.MeshStandardMaterial({ color: src.color, roughness: 0.9, metalness: 0, vertexColors: true })
  m.name = src.name
  m.onBeforeCompile = (sh) => {
    sh.uniforms.lkTime = sway
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float lkTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 base = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float ph = dot(base.xz, vec2(0.13, 0.071));
          float w = transformed.y * transformed.y;
          transformed.x += w * 0.035 * sin(lkTime * 1.3 + ph);
          transformed.z += w * 0.025 * sin(lkTime * 0.9 + ph * 1.7);
        }`,
      )
  }
  m.customProgramCacheKey = () => 'lk-tree'
  return m
}

// root — сцена трассы. Возвращает { update(camera, dt) } или null, если в модели нет склеенного леса
export function createForest(root) {
  const sway = { value: 0 }
  const groups = []
  const meshes = []
  root.traverse((o) => {
    if (o.isMesh && !o.isInstancedMesh && FOREST.test(o.name.replace(/_/g, ' '))) meshes.push(o)
  })
  for (const mesh of meshes) {
    const src = [].concat(mesh.material)[0]
    const kind = /хвоя/i.test(src.name) ? 'spruce' : /листв/i.test(src.name) ? 'crown' : null
    if (!kind) continue
    const trees = splitTrees(mesh)
    if (trees.length < 20) continue
    // ближние: ель 84 треугольника, крона 320; дальние: 18 и 40 — весь лес Спа ~0,3 млн треугольников за один вызов на вид
    const near = kind === 'spruce' ? spruce(6, 14) : crown(1, 4)
    const far = kind === 'spruce' ? spruce(3, 6) : crown(0, 2)
    const mat = treeMaterial(src, sway)
    const mk = (g) => {
      const im = new THREE.InstancedMesh(g, mat, trees.length)
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(trees.length * 3), 3)
      im.count = 0
      im.frustumCulled = false
      im.receiveShadow = true
      im.name = mesh.name + (g === near ? ' (близко)' : ' (далеко)')
      root.add(im)
      return im
    }
    const nearIm = mk(near)
    const farIm = mk(far)
    // матрица и цвет каждого дерева — один раз
    const rnd = mulberry(23)
    const mats = trees.map((t) => {
      const w = Math.max(t.x1 - t.x0, t.z1 - t.z0) / 2
      const h = t.y1 - t.y0
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3((t.x0 + t.x1) / 2, t.y0 - (kind === 'crown' ? h * 0.05 : 0), (t.z0 + t.z1) / 2),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2),
        kind === 'spruce' ? new THREE.Vector3(w * 1.05, h * 1.04, w * 1.05) : new THREE.Vector3(w * 0.95, h * 0.92, w * 0.95),
      )
      // цвет дерева: из модели (там уже есть разброс) плюс свой оттенок
      const base = t.n ? new THREE.Color(t.r / t.n, t.g / t.n, t.b / t.n) : new THREE.Color(1, 1, 1)
      const hsl = {}
      base.getHSL(hsl)
      base.setHSL(hsl.h + (rnd() - 0.5) * 0.04, Math.min(1, hsl.s * (0.9 + rnd() * 0.3)), hsl.l * (0.85 + rnd() * 0.3))
      return { m, c: base, x: (t.x0 + t.x1) / 2, z: (t.z0 + t.z1) / 2 }
    })
    mesh.visible = false
    groups.push({ mats, nearIm, farIm })
  }
  if (!groups.length) return null
  let frame = RESORT
  return {
    update(camera, dt) {
      sway.value += dt
      if (++frame < RESORT) return
      frame = 0
      const cx = camera.position.x
      const cz = camera.position.z
      for (const g of groups) {
        let a = 0
        let b = 0
        for (const t of g.mats) {
          const near = (t.x - cx) ** 2 + (t.z - cz) ** 2 < NEAR * NEAR
          const im = near ? g.nearIm : g.farIm
          const i = near ? a++ : b++
          im.setMatrixAt(i, t.m)
          im.setColorAt(i, t.c)
        }
        g.nearIm.count = a
        g.farIm.count = b
        for (const im of [g.nearIm, g.farIm]) {
          im.instanceMatrix.needsUpdate = true
          im.instanceColor.needsUpdate = true
        }
      }
    },
  }
}
