// Оснащение пит-лейна (10.11, Рома: «детализированнее, реалистичнее, с помощью Forma»).
// Модель — public/models/pitkit.glb (Forma, «Пит-комплект»), в ней две группы:
//   «Комплект бокса» (7 тыс. треугольников): консоль над местом остановки (стойка у гаража, ферма со светом, две катушки
//     со шлангами гайковёртов, сигнал выпуска), два комплекта шин в грелках на тележках, инструментальная тележка, баллоны азота.
//     Начало — точка остановки болида, +X по ходу пит-лейна, +Z к гаражу; всё, кроме фермы, стоит в 2,2…3,5 м от оси бокса.
//   «Командный мостик» (4,9 тыс.): помост у пит-уолла с тентом, пультом на шесть экранов и четырьмя креслами; +Z к трассе.
// Гаражи у трасс разные (LUMEN RING — открытые, у Марины и Спа — стена), поэтому комплект стоит перед гаражом, а не в нём:
// луч по сцене от бокса к гаражу меряет свободное место (меньше NEED — бокс пропускается), луч от оси пит-лейна к трассе
// находит пит-уолл — мостик встаёт перед ним у каждого второго бокса. Столкновений нет: в пит-лейне ведёт автопилот.
// Рисуется экземплярами (InstancedMesh по материалам): ~20 вызовов на весь пит-лейн.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const NEED = 3.7 // м от оси бокса до гаража — столько занимает комплект
const WALL_MIN = 5.2 // м от оси пит-лейна до пит-уолла: ближе мостик мешал бы проезду
const STAND_BACK = 1.45 // м от пит-уолла до центра мостика (тент не протыкает сетку)

// зеркало по X с перестановкой вершин в треугольниках (иначе грани выворачиваются)
function mirrorX(g) {
  g.scale(-1, 1, 1)
  for (const a of Object.values(g.attributes)) {
    const n = a.itemSize
    const arr = a.array
    for (let i = 0; i < a.count; i += 3) {
      for (let k = 0; k < n; k++) {
        const t = arr[(i + 1) * n + k]
        arr[(i + 1) * n + k] = arr[(i + 2) * n + k]
        arr[(i + 2) * n + k] = t
      }
    }
    a.needsUpdate = true
  }
  return g
}

// детали группы → [{ geometry, material }] по именам материалов, в осях группы
function bake(group) {
  group.updateMatrixWorld(true)
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert()
  const byMat = new Map()
  group.traverse((o) => {
    if (!o.isMesh) return
    const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld))
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k)
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2))
    const key = o.material.name || o.material.uuid
    if (!byMat.has(key)) byMat.set(key, { material: o.material, list: [] })
    byMat.get(key).list.push(g)
  })
  return [...byMat.values()].map(({ material, list }) => ({ geometry: mergeGeometries(list), material }))
}

export function createPitKit(scene, track) {
  const group = new THREE.Group()
  group.name = 'Оснащение пит-лейна'
  scene.add(group)
  const info = { kits: 0, stands: 0 }
  const pit = track.pit
  if (!pit?.boxes?.length || !track.root) return { group, info }

  new GLTFLoader().load('/models/pitkit.glb', (gltf) => {
    const kitSrc = gltf.scene.getObjectByName('Комплект_бокса') || gltf.scene.getObjectByName('Комплект бокса')
    const standSrc = gltf.scene.getObjectByName('Командный_мостик') || gltf.scene.getObjectByName('Командный мостик')
    if (!kitSrc) return
    track.root.updateMatrixWorld(true)
    const ray = new THREE.Raycaster()
    const from = new THREE.Vector3()
    const dir = new THREE.Vector3()
    // расстояние до первой видимой детали трассы (сетки ограждений не в счёт); null — свободно
    const reach = (x, y, z, dx, dz, far) => {
      ray.set(from.set(x, y, z), dir.set(dx, 0, dz))
      ray.far = far
      const hit = ray.intersectObject(track.root, true).find((h) => h.object.visible && !/сетк/i.test(h.object.name))
      return hit ? hit.distance : null
    }
    const up = new THREE.Vector3(0, 1, 0)
    const one = new THREE.Vector3(1, 1, 1)
    const q = new THREE.Quaternion()
    const kits = []
    const stands = []
    let mirror = false
    pit.boxes.forEach((b, i) => {
      // ближайшая точка оси пит-лейна: от неё к боксу — сторона гаражей
      let pa = pit.axis[0]
      let best = Infinity
      for (const p of pit.axis) {
        const d = (p.x - b.x) ** 2 + (p.z - b.z) ** 2
        if (d < best) {
          best = d
          pa = p
        }
      }
      const off = Math.hypot(b.x - pa.x, b.z - pa.z)
      if (off < 0.5) return
      const dx = (b.x - pa.x) / off
      const dz = (b.z - pa.z) / off
      const y = b.y || 0
      const yaw = Math.atan2(dx, dz) // +Z комплекта — к гаражу
      // +X комплекта должен смотреть по ходу пит-лейна (сигнал выпуска — впереди пилота), иначе модель зеркалим
      if (i === 0) mirror = Math.cos(yaw) * Math.sin(b.yaw) - Math.sin(yaw) * Math.cos(b.yaw) < 0
      const face = reach(b.x, y + 1, b.z, dx, dz, 14)
      if (face === null || face >= NEED) kits.push(new THREE.Matrix4().compose(new THREE.Vector3(b.x, y, b.z), q.setFromAxisAngle(up, yaw).clone(), one))
      if (standSrc && i % 2 === 0) {
        const wall = reach(pa.x, (pa.y || 0) + 0.6, pa.z, -dx, -dz, 30)
        if (wall !== null && wall >= WALL_MIN) {
          const d = wall - STAND_BACK
          stands.push(new THREE.Matrix4().compose(new THREE.Vector3(pa.x - dx * d, pa.y || 0, pa.z - dz * d), q.setFromAxisAngle(up, yaw + Math.PI).clone(), one))
        }
      }
    })
    const put = (src, mats, flip) => {
      if (!mats.length) return
      for (const part of bake(src)) {
        const mesh = new THREE.InstancedMesh(flip ? mirrorX(part.geometry) : part.geometry, part.material, mats.length)
        mats.forEach((m, k) => mesh.setMatrixAt(k, m))
        mesh.instanceMatrix.needsUpdate = true
        mesh.geometry.computeBoundingSphere()
        mesh.computeBoundingSphere()
        mesh.receiveShadow = true
        group.add(mesh)
      }
    }
    put(kitSrc, kits, mirror)
    if (standSrc) put(standSrc, stands, false)
    info.kits = kits.length
    info.stands = stands.length
  }, undefined, () => {
    // нет файла — пит-лейн как раньше
  })

  return { group, info }
}
