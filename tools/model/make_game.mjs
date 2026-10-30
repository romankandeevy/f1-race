// Игровая версия болида из полной модели Lumen (SF26_доработка.glb) для f1-race.
// usage: node make_game.mjs <полная.glb> <нынешняя игровая f1.glb (колёса берём оттуда)> <выход.glb> [ошибка упрощения]
import { NodeIO, Document } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRLightsPunctual } from '@gltf-transform/extensions'
import { mergeDocuments, joinPrimitives, transformPrimitive, simplifyPrimitive, weld, prune, dedup, textureCompress, getBounds, unpartition } from '@gltf-transform/functions'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
import { mat4 } from 'gl-matrix'

const [SRC, GAME, OUT, ERR = '0.0004'] = process.argv.slice(2)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(SRC)
const root = doc.getRoot()
const scene = root.getDefaultScene() || root.listScenes()[0]
const byName = (n) => root.listNodes().find((x) => x.getName() === n)
const tri = (d) => d.getRoot().listMeshes().reduce((a, m) => a + m.listPrimitives().reduce((b, p) => b + (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3, 0), 0)
const log = (...a) => console.log(...a)
log('исходник: треугольников', Math.round(tri(doc)), 'узлов', root.listNodes().length)

// 1. студия: пол, тени, свет — вон
const car = byName('Ferrari_SF26_16')
for (const n of scene.listChildren()) if (n !== car) disposeTree(n)
for (const n of car.listChildren()) if (/^contact_shadow|^studio_floor/.test(n.getName())) disposeTree(n)
for (const ext of root.listExtensionsUsed()) if (ext.extensionName === KHRLightsPunctual.EXTENSION_NAME) ext.dispose()
car.setName('car_root')
function disposeTree(n) {
  for (const c of n.listChildren()) disposeTree(c)
  n.dispose()
}

// 2. материалы под код игры
const mats = () => root.listMaterials()
const mat = (n) => mats().find((m) => m.getName() === n)
const livery = mat('paint_livery_rosso_white_pearl')
const white = mat('paint_white_pearl')
const rosso = mat('paint_rosso_corsa')
const dark = mat('inlet_dark')
// paint: красный цвет без текстуры (перекраска — paint.color), с лаком; белая зона — paint_secondary
const paint = rosso
paint.setName('paint')
white.setName('paint_secondary')
mat('paint_ibm_blue').setName('accent_blue')
// задний фонарь: кольцо светодиодов, линза и светодиоды на торцах крыла — один материал light_rear (код меняет яркость)
const light = mat('rear_light_led_ring')
light.setName('light_rear')
if (light.getEmissiveFactor().every((v) => v === 0)) light.setEmissiveFactor([1, 0.02, 0.02])
for (const n of root.listNodes()) {
  const m = n.getMesh()
  if (!m) continue
  for (const p of m.listPrimitives()) {
    const pm = p.getMaterial()?.getName()
    if (pm === 'rear_light_led' || pm === 'rear_light_lens') p.setMaterial(light)
  }
}

// 3. ливрея остаётся текстурой (ровный белый овал с окантовкой); перекраску делает игра — перерисовывает её на холсте
// (car.js recolorLivery). Резать кузов по цвету треугольников нельзя: край белой зоны идёт зубцами
livery.setName('paint_livery')

// 4. колёса — из нынешней игровой модели (по 8,7 тыс. треугольников, материалы tyre_*, brake_disc для свечения)
const game = await io.read(GAME)
const gRoot = game.getRoot()
const gScene = gRoot.getDefaultScene() || gRoot.listScenes()[0]
const gWheels = Object.fromEntries(['FL', 'FR', 'RL', 'RR'].map((k) => [k, gRoot.listNodes().find((n) => n.getName() === 'wheel_' + k)]))
// всё, кроме колёс, из игровой модели не нужно
const keepG = new Set()
for (const w of Object.values(gWheels)) w.traverse((n) => keepG.add(n))
const map = mergeDocuments(doc, game)
for (const k of ['FL', 'FR', 'RL', 'RR']) {
  const nw = byName('wheel_' + k) // новый
  const gw = map.get(gWheels[k])
  for (const c of nw.listChildren()) disposeTree(c)
  for (const c of gw.listChildren()) nw.addChild(c)
  // нынешняя игра крутит колесо вокруг локальной X, начало — центр оси: проверяем, что совпадает
  const a = nw.getWorldTranslation()
  const b = gw.getWorldTranslation()
  if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 0.003) log('ВНИМАНИЕ: центр колеса', k, 'разный', a, b)
}
// сцену игровой модели (без колёс) — вон
for (const s of root.listScenes()) if (s !== scene) {
  for (const n of s.listChildren()) disposeTree(n)
  s.dispose()
}
// после слияния материалы игровых колёс могут повторять имена — у нас из новой модели колёс больше нет, конфликтов нет

// 5. drs_flap: верхний закрылок заднего крыла с шарниром у задней кромки; cam_onboard на уровне глаз
const flap = byName('rw_flap_top')
const rw = byName('rear_wing')
const fb = getBounds(flap)
const hinge = [0, fb.max[1] - 0.012, fb.min[2] + 0.005]
const drs = doc.createNode('drs_flap').setTranslation(hinge)
// rear_wing в начале координат (проверка): тогда мировые = локальные rear_wing
log('rear_wing t', rw.getTranslation(), 'закрылок', fb.min.map((v) => +v.toFixed(3)), fb.max.map((v) => +v.toFixed(3)), 'шарнир', hinge.map((v) => +v.toFixed(3)))
rw.addChild(drs)
const ft = flap.getTranslation()
flap.setTranslation([ft[0] - hinge[0], ft[1] - hinge[1], ft[2] - hinge[2]])
drs.addChild(flap)
car.addChild(doc.createNode('cam_onboard').setTranslation([0, 0.86, 0.1]))

// 6. объединение деталей по материалам внутри «единиц» (узлы, которые знает код: car.js, carScan.js, debris…)
const UNITS = new Set(['cam_onboard', 'car_root', 'body', 'front_wing', 'rear_wing', 'drs_flap', 'halo', 'cockpit', 'suspension_front', 'suspension_rear', 'floor_diffuser', 'plank', 'mirrors', 'lights', 'brakes', 'monocoque_nose', 'headrest', 'sidepods_engine_cover', 'airbox_spine', 'tcam_fin', 'exhaust', 'gearbox_crash_fairing', 'rear_light_housing', 'sidepod_inlet', 'decals'])
for (const k of ['FL', 'FR', 'RL', 'RR']) ['caliper_', 'brake_duct_', 'brake_drum_', 'brake_drum_lip_', 'wheel_'].forEach((p) => UNITS.add(p + k))
const isUnit = (n) => UNITS.has(n.getName())
const worldM = (n) => n.getWorldMatrix()
function joinInto(u) {
  if (u.getName().startsWith('wheel_') || u.getName() === 'decals') return // колёса уже игровые; наклейки — у каждой свой материал
  const inv = mat4.invert(mat4.create(), worldM(u))
  const items = []
  const walk = (n, top) => {
    if (!top && isUnit(n)) return
    const m = n.getMesh()
    if (m) items.push(n)
    for (const c of n.listChildren()) walk(c, false)
  }
  walk(u, true)
  if (!items.length || (items.length === 1 && items[0] === u)) return
  const groups = new Map()
  for (const n of items) {
    const rel = mat4.multiply(mat4.create(), inv, worldM(n))
    for (const p of n.getMesh().listPrimitives()) {
      const q = p.clone()
      transformPrimitive(q, rel)
      if (!q.getIndices()) {
        const cnt = q.getAttribute('POSITION').getCount()
        q.setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from({ length: cnt }, (_, i) => i)).setBuffer(root.listBuffers()[0]))
      }
      const sem = q.listSemantics().sort().map((s) => {
        const a = q.getAttribute(s)
        return `${s}:${a.getComponentType()}:${a.getNormalized()}:${a.getType()}`
      })
      const key = (p.getMaterial()?.getName() ?? '') + '#' + mats().indexOf(p.getMaterial()) + '|' + sem.join(',') + '|' + q.getMode() + '|' + q.getIndices().getComponentType() + '|' + q.listTargets().length
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(q)
    }
  }
  const mesh = doc.createMesh(u.getName())
  for (const list of groups.values()) {
    let j = list[0]
    if (list.length > 1) {
      try {
        j = joinPrimitives(list)
      } catch (e) {
        log('не объединилось', u.getName(), list.length, e.message.slice(0, 60))
        list.forEach((q) => mesh.addPrimitive(q))
        continue
      }
    }
    mesh.addPrimitive(j)
    if (list.length > 1) list.forEach((q) => q.dispose())
  }
  // снять меши с потомков (кроме единиц), пустые потомки удалить
  const strip = (n, top) => {
    for (const c of n.listChildren()) {
      if (isUnit(c)) continue
      strip(c, false)
    }
    if (!top) {
      const old = n.getMesh()
      n.setMesh(null)
      if (!n.listChildren().length) n.dispose()
    }
  }
  const old = u.getMesh()
  strip(u, true)
  u.setMesh(mesh)
}
// снизу вверх: сначала глубокие единицы
const units = root.listNodes().filter(isUnit)
const depth = (n) => {
  let d = 0
  for (let p = n.getParentNode(); p; p = p.getParentNode()) d++
  return d
}
units.sort((a, b) => depth(b) - depth(a))
for (const u of units) joinInto(u)
log('после объединения: мешей', root.listMeshes().length, 'узлов', root.listNodes().length)

// 7. упрощение (колёса не трогаем — они уже игровые) и сжатие
await MeshoptSimplifier.ready
const wheelMeshes = new Set()
for (const k of ['FL', 'FR', 'RL', 'RR']) byName('wheel_' + k).traverse((n) => n.getMesh() && wheelMeshes.add(n.getMesh()))
await doc.transform(dedup(), prune({ keepLeaves: true }))
await doc.transform(weld({ tolerance: 0.0001, toleranceNormal: 0.5 }))
const before = tri(doc)
// наклейки: не упрощаем и приподнимаем над кузовом на DECAL_LIFT по нормали — кузов упрощён с допуском ~1 мм и местами
// вылезал поверх наклейки («16» и HP выглядели съеденными, Рома 30.10)
const DECAL_LIFT = 0.0025
const decalMeshes = new Set()
for (const n of root.listNodes()) {
  let d = false
  for (let p = n; p; p = p.getParentNode()) if (p.getName() === 'decals' || p.getName().startsWith('decal_')) d = true
  if (d && n.getMesh()) decalMeshes.add(n.getMesh())
}
for (const m of decalMeshes) {
  for (const p of m.listPrimitives()) {
    const pos = p.getAttribute('POSITION')
    const nor = p.getAttribute('NORMAL')
    if (!nor) continue
    const a = [0, 0, 0]
    const b = [0, 0, 0]
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, a)
      nor.getElement(i, b)
      pos.setElement(i, [a[0] + b[0] * DECAL_LIFT, a[1] + b[1] * DECAL_LIFT, a[2] + b[2] * DECAL_LIFT])
    }
  }
}
log('наклеек', decalMeshes.size)
for (const m of root.listMeshes()) {
  if (wheelMeshes.has(m)) continue
  const decal = decalMeshes.has(m)
  for (const p of m.listPrimitives()) {
    if (!p.getIndices() || p.getIndices().getCount() <= 300) continue
    // ошибка упрощения у meshopt — доля размера детали; держим одинаковую в метрах (ERR × 2,75 м ≈ 1 мм), иначе мелочь не упрощается
    const pos = p.getAttribute('POSITION')
    const mn = pos.getMin([])
    const mx = pos.getMax([])
    const r = Math.max(0.01, Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2)
    // у кусков ливреи граница красного и белого — край куска: держим её на месте, иначе белая зона идёт рваными пятнами
    const zone = ['paint', 'paint_secondary', 'inlet_dark'].includes(p.getMaterial()?.getName())
    // наклейки — допуск 0,3 мм (они подняты на 2,5 мм), край не двигаем: иначе обрежется буква
    const abs = decal ? 0.0003 : +ERR * 2.75
    simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: 0, error: Math.min(0.05, abs / r), lockBorder: zone || decal })
  }
}
log('упрощение:', Math.round(before), '→', Math.round(tri(doc)))
await doc.transform(
  prune({ keepLeaves: true }),
  dedup(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 85 }),
)
// у колёс при упрощении могли пострадать надписи — проверка, что колёса не тронуты: число треугольников
const wt = [...wheelMeshes].reduce((a, m) => a + m.listPrimitives().reduce((b, p) => b + p.getIndices().getCount() / 3, 0), 0)
log('колёса:', Math.round(wt), 'треугольников')
await doc.transform(unpartition())
await io.write(OUT, doc)
log('готово: треугольников', Math.round(tri(doc)), 'материалов', root.listMaterials().length, 'текстур', root.listTextures().length)
