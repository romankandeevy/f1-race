// Сводка GLB: узлы (дерево), материалы, треугольники, текстуры, обязательные узлы игры
import fs from 'fs'
const f = process.argv[2]
const buf = fs.readFileSync(f)
const len = buf.readUInt32LE(12)
const json = JSON.parse(buf.slice(20, 20 + len).toString('utf8'))
const binStart = 20 + len + 8
const need = ['car_root', 'body', 'front_wing', 'rear_wing', 'drs_flap', 'halo', 'driver', 'plank', 'wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR', 'cam_onboard']
const names = (json.nodes || []).map((n) => n.name)
console.log('файл', (buf.length / 1e6).toFixed(1), 'МБ; узлов', names.length, 'мешей', (json.meshes || []).length, 'материалов', (json.materials || []).length, 'текстур', (json.images || []).length)
console.log('нет обязательных:', need.filter((n) => !names.includes(n)).join(', ') || '—')
console.log('extensionsUsed:', (json.extensionsUsed || []).join(', ') || '—')
// треугольники по мешам
const tri = (m) => m.primitives.reduce((a, p) => a + (p.indices != null ? json.accessors[p.indices].count : json.accessors[p.attributes.POSITION].count) / 3, 0)
let total = 0
const meshTri = (json.meshes || []).map((m) => {
  const t = tri(m)
  total += t
  return t
})
console.log('треугольников всего', Math.round(total))
// дерево верхних уровней с треугольниками поддерева
const sub = (i) => {
  const n = json.nodes[i]
  let t = n.mesh != null ? meshTri[n.mesh] : 0
  for (const c of n.children || []) t += sub(c)
  return t
}
const show = (i, d) => {
  const n = json.nodes[i]
  if (d > 3) return
  const tr = n.translation ? ' t=' + n.translation.map((v) => v.toFixed(3)).join(',') : ''
  const r = n.rotation ? ' r=' + n.rotation.map((v) => v.toFixed(3)).join(',') : ''
  const s = n.scale ? ' s=' + n.scale.map((v) => v.toFixed(3)).join(',') : ''
  console.log('  '.repeat(d) + (n.name || '(без имени)') + (n.mesh != null ? ' [mesh]' : '') + ` ${Math.round(sub(i))} тр.` + tr + r + s + (n.extras ? ' extras=' + JSON.stringify(n.extras).slice(0, 80) : ''))
  for (const c of n.children || []) show(c, d + 1)
}
for (const sc of json.scenes || []) for (const r of sc.nodes) show(r, 0)
console.log('материалы:', (json.materials || []).map((m) => m.name).join(', '))
const imgs = (json.images || []).map((im, i) => {
  const bv = json.bufferViews[im.bufferView]
  let wh = ''
  const b = buf.slice(binStart + (bv.byteOffset || 0), binStart + (bv.byteOffset || 0) + bv.byteLength)
  if (im.mimeType === 'image/png') wh = b.readUInt32BE(16) + 'x' + b.readUInt32BE(20)
  else if (im.mimeType === 'image/jpeg') {
    for (let k = 2; k < b.length; ) {
      const mk = b.readUInt16BE(k)
      const l = b.readUInt16BE(k + 2)
      if (mk >= 0xffc0 && mk <= 0xffc3) {
        wh = b.readUInt16BE(k + 7) + 'x' + b.readUInt16BE(k + 5)
        break
      }
      k += 2 + l
    }
  }
  return `${im.name || i} ${im.mimeType} ${wh} ${(bv.byteLength / 1e6).toFixed(2)}МБ`
})
console.log('текстуры:\n  ' + imgs.join('\n  '))
