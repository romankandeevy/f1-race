// Скан болида сверху для табло «Состояние болида» (справа внизу): белые контуры всех деталей.
// Считается один раз при загрузке игры из той же модели, что едет (main.js → hud.setCarScan),
// поэтому новая модель болида сама даёт новый скан. ~0,25 с, пока висит «Загрузка болида».
//
// Как работает: копия болида рисуется ортокамерой строго сверху, каждая деталь своим цветом
// (номер детали в цвете). По картинке номеров для каждой детали обводится видимый сверху контур
// (границы пикселей → упрощение Дугласа — Пекера → плавные кривые). Отдельно собираются
// заливки частей, которые ломаются (крылья, днище, бокподы, монокок, мотор, подвеска), и колёса.

import * as THREE from 'three'

const PX_PER_M = 200 // разрешение снимка
const HALF_X = 1.05 // м, полширины кадра
const Z_TOP = 3.08 // м, нос
const Z_BOTTOM = -2.6 // м, корма
const VB = 196 // высота viewBox; ширина кадра 196, из неё показываем середину
const VB_X0 = 28 // слева и справа от болида — место под подписи шин
const VB_W = 140
const MIN_AREA = 150 // пикселей: мельче — ремни, гайки, щели (на схеме это мусор)
const EPS = 1.6 // пикселей: допуск упрощения контура

// к какой ломающейся части относится деталь (по узлам модели)
function partOf(o) {
  for (let p = o; p; p = p.parent) {
    const n = p.name
    if (/^wheel_(FL|FR|RL|RR)$/.test(n)) return n
    if (n === 'front_wing' || n.startsWith('decal_fw')) return 'wing'
    if (n === 'rear_wing' || n.startsWith('decal_rw') || n.startsWith('rw_led')) return 'rearWing'
    if (n === 'floor_diffuser' || n === 'plank') return 'floor'
    if (n === 'sidepods_engine_cover') return 'side'
    if (n === 'suspension_front' || n === 'suspension_rear') return 'susp'
    if (['airbox_spine', 'tcam_fin', 'exhaust', 'gearbox_crash_fairing', 'rear_light_housing'].includes(n) || n.startsWith('rear_light')) return 'engine'
  }
  return 'chassis'
}

// деталь для обводки: подсетки «mesh_N» (разбиение по материалам) сливаются в свой узел, колесо — целиком
function detailOf(o) {
  for (let p = o; p; p = p.parent) if (/^wheel_(FL|FR|RL|RR)$/.test(p.name)) return p.name
  let n = o
  while (n.parent && n.name.startsWith('mesh_')) n = n.parent
  return n.name || o.uuid
}

export function scanCar(renderer, group) {
  const T = THREE
  const W = Math.round(2 * HALF_X * PX_PER_M)
  const H = Math.round((Z_TOP - Z_BOTTOM) * PX_PER_M)
  const model = group.clone(true)
  model.position.set(0, 0, 0)
  model.quaternion.identity()
  model.scale.set(1, 1, 1)
  const details = []
  const detailIds = new Map()
  const meshes = []
  model.traverse((o) => {
    if (!o.isMesh) return
    const key = detailOf(o)
    if (!detailIds.has(key)) {
      detailIds.set(key, details.length + 1)
      details.push({ key, part: partOf(o) })
    }
    const id = detailIds.get(key)
    o.material = new T.MeshBasicMaterial({ color: new T.Color((id & 255) / 255, (id >> 8) / 255, 0), side: T.DoubleSide, toneMapped: false })
    o.castShadow = o.receiveShadow = false
    meshes.push(o)
  })
  model.traverse((o) => { if (o.isLight) o.visible = false })
  const scene = new T.Scene()
  scene.add(model)
  model.updateMatrixWorld(true)
  // сверху: нос вверх по кадру, как болид едет (Рома 29.10: «нос спереди, зад задом»), правый борт (−X) справа
  const zc = (Z_TOP + Z_BOTTOM) / 2
  const cam = new T.OrthographicCamera(-HALF_X, HALF_X, (Z_TOP - Z_BOTTOM) / 2, -(Z_TOP - Z_BOTTOM) / 2, 0.1, 30)
  cam.position.set(0, 10, zc)
  cam.up.set(0, 0, 1)
  cam.lookAt(0, 0, zc)
  const r = renderer
  const rt = new T.WebGLRenderTarget(W, H)
  const prevRT = r.getRenderTarget()
  const prevClear = r.getClearColor(new T.Color())
  const prevAlpha = r.getClearAlpha()
  r.setRenderTarget(rt)
  r.setClearColor(0x000000, 1)
  r.clear()
  r.render(scene, cam)
  const buf = new Uint8Array(W * H * 4)
  r.readRenderTargetPixels(rt, 0, 0, W, H, buf)
  r.setRenderTarget(prevRT)
  r.setClearColor(prevClear, prevAlpha)
  rt.dispose()
  meshes.forEach((m) => m.material.dispose())

  // номер детали по пикселю, строки сверху вниз
  const label = new Int32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = ((H - 1 - y) * W + x) * 4
      label[y * W + x] = buf[i] + (buf[i + 1] << 8)
    }
  }
  const xOf = (px) => HALF_X - ((px + 0.5) * 2 * HALF_X) / W // координата X болида по столбцу (слева +X)
  const k = VB / H
  const vx = (px) => VB / 2 + (px - W / 2) * k
  const vy = (py) => py * k

  // ломающаяся часть пикселя: крылья и подвеска делятся по борту, бокподы — бокпод/мотор по |X|
  const partName = (id, px) => {
    const p = details[id - 1]?.part
    if (!p) return null
    const X = xOf(px)
    if (p === 'wing') return X > 0 ? 'pWingL' : 'pWingR'
    if (p === 'susp') return X > 0 ? 'pSuspL' : 'pSuspR'
    if (p === 'side') return Math.abs(X) < 0.2 ? 'pEngine' : X > 0 ? 'pSideL' : 'pSideR'
    if (p.startsWith('wheel_')) return null
    return 'p' + p[0].toUpperCase() + p.slice(1)
  }

  // контуры области: направленные рёбра по границам пикселей, сцепленные в петли
  function loops(test) {
    const next = new Map()
    const add = (x1, y1, x2, y2) => {
      const a = y1 * (W + 1) + x1
      let list = next.get(a)
      if (!list) next.set(a, (list = []))
      list.push(y2 * (W + 1) + x2)
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!test(x, y)) continue
        if (y === 0 || !test(x, y - 1)) add(x, y, x + 1, y)
        if (x === W - 1 || !test(x + 1, y)) add(x + 1, y, x + 1, y + 1)
        if (y === H - 1 || !test(x, y + 1)) add(x + 1, y + 1, x, y + 1)
        if (x === 0 || !test(x - 1, y)) add(x, y + 1, x, y)
      }
    }
    const out = []
    for (const start of next.keys()) {
      const first = next.get(start)
      while (first.length) {
        const pts = []
        let cur = start
        for (;;) {
          const list = next.get(cur)
          if (!list || !list.length) break
          pts.push([cur % (W + 1), Math.floor(cur / (W + 1))])
          cur = list.pop()
          if (cur === start) break
        }
        let area = 0
        for (let i = 0; i < pts.length; i++) {
          const [x1, y1] = pts[i]
          const [x2, y2] = pts[(i + 1) % pts.length]
          area += x1 * y2 - x2 * y1
        }
        if (Math.abs(area / 2) >= MIN_AREA) out.push(pts)
      }
    }
    return out
  }

  function simplify(pts, eps) {
    const dp = (a, b, keep) => {
      const [x1, y1] = pts[a]
      const [x2, y2] = pts[b]
      const len = Math.hypot(x2 - x1, y2 - y1) || 1
      let best = 0
      let at = -1
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((x2 - x1) * (y1 - pts[i][1]) - (x1 - pts[i][0]) * (y2 - y1)) / len
        if (d > best) (best = d), (at = i)
      }
      if (best > eps) {
        dp(a, at, keep)
        keep.push(pts[at])
        dp(at, b, keep)
      }
    }
    // замкнутая петля: делим на две половины через самую дальнюю от начала точку
    let far = 0
    let farD = 0
    pts.forEach(([x, y], i) => {
      const d = Math.hypot(x - pts[0][0], y - pts[0][1])
      if (d > farD) (farD = d), (far = i)
    })
    const ring = [...pts, pts[0]]
    pts = ring
    const keep = [ring[0]]
    dp(0, far, keep)
    keep.push(ring[far])
    dp(far, ring.length - 1, keep)
    return keep
  }

  // плавный контур: кривые через середины сторон, вершины — контрольные точки (лестница пикселей уходит);
  // острый угол (крыло, шайба) остаётся углом, иначе прямоугольник превращается в овал
  const f = (v) => +v.toFixed(1)
  const SHARP = Math.cos((40 * Math.PI) / 180)
  const smooth = (pts) => {
    const n = pts.length
    const mid = (i) => {
      const [x1, y1] = pts[i]
      const [x2, y2] = pts[(i + 1) % n]
      return `${f(vx((x1 + x2) / 2))} ${f(vy((y1 + y2) / 2))}`
    }
    let d = 'M' + mid(n - 1)
    for (let i = 0; i < n; i++) {
      const [ax, ay] = pts[(i + n - 1) % n]
      const [bx, by] = pts[i]
      const [cx, cy] = pts[(i + 1) % n]
      const ux = bx - ax, uy = by - ay, wx = cx - bx, wy = cy - by
      const cos = (ux * wx + uy * wy) / (Math.hypot(ux, uy) * Math.hypot(wx, wy) || 1)
      const p = `${f(vx(bx))} ${f(vy(by))}`
      d += cos < SHARP ? `L${p}L${mid(i)}` : `Q${p} ${mid(i)}`
    }
    return d + 'Z'
  }

  const toD = (rings) =>
    rings
      .map((pts) => simplify(pts, EPS).slice(0, -1))
      .filter((pts) => pts.length >= 3)
      .map(smooth)
      .join('')

  // обводки всех деталей, кроме колёс (колёса — отдельные элементы с состоянием шины)
  const lines = []
  details.forEach((d, i) => {
    if (d.part.startsWith('wheel_')) return
    const id = i + 1
    const path = toD(loops((x, y) => label[y * W + x] === id))
    if (path) lines.push(path)
  })

  // заливки ломающихся частей
  const fills = {}
  for (const name of ['pFloor', 'pSideL', 'pSideR', 'pEngine', 'pChassis', 'pWingL', 'pWingR', 'pRearWing', 'pSuspL', 'pSuspR']) {
    fills[name] = toD(loops((x, y) => {
      const id = label[y * W + x]
      return id > 0 && partName(id, x) === name
    }))
  }

  // колёса: контур шины, тормозной диск (полоска по габаритам диска), центр для подписи
  const wheels = {}
  for (const w of ['FL', 'FR', 'RL', 'RR']) {
    const ids = new Set(details.map((d, i) => (d.key === 'wheel_' + w ? i + 1 : 0)).filter(Boolean))
    const node = model.getObjectByName('wheel_' + w)
    const disc = model.getObjectByName('brake_disc_' + w)
    const bw = new T.Box3().setFromObject(node)
    const bd = new T.Box3().setFromObject(disc)
    const sx = (X) => VB / 2 - (X * VB) / (Z_TOP - Z_BOTTOM) // X болида → x viewBox
    const sy = (Z) => ((Z_TOP - Z) * VB) / (Z_TOP - Z_BOTTOM)
    wheels[w] = {
      d: toD(loops((x, y) => ids.has(label[y * W + x]))),
      brake: [sx(bd.max.x), sy(bd.max.z), sx(bd.min.x) - sx(bd.max.x), sy(bd.min.z) - sy(bd.max.z)].map((v) => +v.toFixed(1)),
      cx: +sx((bw.min.x + bw.max.x) / 2).toFixed(1),
      cy: +sy((bw.min.z + bw.max.z) / 2).toFixed(1),
      outer: +sx(bw.min.x < 0 ? bw.min.x : bw.max.x).toFixed(1),
    }
  }
  // общий силуэт болида без колёс — толстой линией поверх тонких контуров деталей
  // (у колёс свой контур: оторванное колесо рисуется красным пунктиром, силуэт его не перекрывает)
  const isWheel = details.map((d) => d.part.startsWith('wheel_'))
  const outline = toD(loops((x, y) => {
    const id = label[y * W + x]
    return id > 0 && !isWheel[id - 1]
  }))
  return { viewBox: `${VB_X0} 0 ${VB_W} ${VB}`, lines: lines.join(''), outline, fills, wheels }
}
