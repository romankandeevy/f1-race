// Материалы: цвет, текстуры, кто ими пользуется (узлы) и сколько треугольников
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(process.argv[2])
const root = doc.getRoot()
const use = new Map()
for (const node of root.listNodes()) {
  const mesh = node.getMesh()
  if (!mesh) continue
  for (const p of mesh.listPrimitives()) {
    const m = p.getMaterial()
    const k = m ? m.getName() : '(нет)'
    const idx = p.getIndices()
    const tri = (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3
    const e = use.get(k) || { tri: 0, nodes: [] }
    e.tri += tri
    e.nodes.push(node.getName())
    use.set(k, e)
  }
}
for (const m of root.listMaterials()) {
  const tex = ['BaseColor', 'MetallicRoughness', 'Normal', 'Emissive', 'Occlusion'].filter((t) => m[`get${t}Texture`]()).join('+')
  const exts = m.listExtensions().map((e) => e.extensionName.replace('KHR_materials_', '')).join(',')
  const u = use.get(m.getName())
  console.log(`${m.getName()} | цвет ${m.getBaseColorFactor().map((v) => v.toFixed(2)).join(',')} | тексты ${tex || '—'} | ${m.getAlphaMode()} | ${exts} | ${u ? Math.round(u.tri) + ' тр. ' + [...new Set(u.nodes)].slice(0, 6).join(',') : 'не используется'}`)
}
