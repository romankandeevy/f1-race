import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(process.argv[2])
let total = 0, dec = 0
const per = {}
for (const n of doc.getRoot().listNodes()) {
  const m = n.getMesh(); if (!m) continue
  let underDecals = false
  for (let p = n; p; p = p.getParentNode()) if (p.getName() === 'decals') underDecals = true
  const c = m.listPrimitives().length
  total += c; if (underDecals) dec += c
  per[n.getName()] = c
}
console.log('примитивов (вызовов отрисовки)', total, 'из них наклейки', dec)
console.log(Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => k + ':' + v).join(' '))
