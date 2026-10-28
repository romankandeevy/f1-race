// Проверки физики болида без браузера: `npm test`.
// Каждое изменение физики или tuning.js — прогнать. Пороги взяты из реальных цифр F1 2022–25
// (Brembo, Mercedes, Formula1.com) и из жалоб на «ощущение руля», которые уже исправлены.
import fs from 'fs'
import RAPIER from '@dimforge/rapier3d-compat'
import { createVehicle, stepVehicle, collectImpacts, setGhost } from '../src/vehicle.js'
import { TUNING } from '../src/tuning.js'
import * as THREE from 'three'
import { createStart } from '../src/start.js'
import { createRaceLine, createAiDriver, makePilots } from '../src/ai.js'
import { createRace } from '../src/race.js'
import { wheelsOut, createLimits } from '../src/limits.js'
import { tyreGrip, aeroDamage } from '../src/wear.js'
import { createPitLane, createPitStop, pitEntryHit, pitLimiter } from '../src/pit.js'

await RAPIER.init()
const DT = 1 / 240
const NONE = { throttle: 0, brake: 0, steer: 0, handbrake: false, aero: false }
const deg = (r) => (r * 180) / Math.PI
const yawOf = (q) => Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
const upY = (q) => 1 - 2 * (q.x * q.x + q.z * q.z)

function fresh(surfaceAt) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0), g)
  const v = createVehicle(RAPIER, world, { y: 0.05, wear: false }, TUNING)
  return { world, v, surfaceAt: surfaceAt || (() => 'asphalt') }
}
function run(w, input, seconds, cb) {
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) {
    stepVehicle(w.v, { ...NONE, ...(typeof input === 'function' ? input(i * DT) : input) }, DT, w.surfaceAt)
    w.world.step()
    cb && cb(i * DT)
  }
}
const kmh = (w) => w.v.state.speedKmh
const hold = (w, target) => ({ throttle: kmh(w) < target ? Math.min(1, (target - kmh(w)) * 0.15 + 0.2) : 0, brake: kmh(w) > target + 8 ? 0.4 : 0 })
function accelTo(w, target) {
  for (let t = 0; t < 60 && kmh(w) < target; t += DT) run(w, { throttle: 1 }, DT)
}
function steady(target, steer = 1) {
  const w = fresh()
  run(w, NONE, 0.5)
  accelTo(w, target)
  let minUp = 1
  run(w, () => ({ ...hold(w, target), steer }), 4, () => (minUp = Math.min(minUp, upY(w.v.body.rotation()))))
  const lv = w.v.body.linvel()
  const sp = Math.hypot(lv.x, lv.z)
  const rate = Math.abs(w.v.body.angvel().y)
  return { w, sp, radius: sp / rate, g: (rate * sp) / 9.81, minUp }
}

const results = []
function check(name, value, ok, unit = '') {
  results.push({ name, value, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}: ${typeof value === 'number' ? value.toFixed(2) : value}${unit}`)
}

// 1. стоит ровно и не ползёт
{
  const w = fresh()
  run(w, NONE, 3)
  const p0 = w.v.body.translation()
  run(w, NONE, 5)
  const p1 = w.v.body.translation()
  check('покой: сползло за 5 с', Math.hypot(p1.x - p0.x, p1.z - p0.z) * 1000, Math.hypot(p1.x - p0.x, p1.z - p0.z) < 0.001, ' мм')
}

// 2. разгон и максималка (~340–350 км/ч у болидов 2022–25)
{
  const w = fresh()
  run(w, NONE, 0.5)
  let t100 = null
  run(w, { throttle: 1 }, 40, (t) => {
    if (t100 === null && kmh(w) >= 100) t100 = t
  })
  check('разгон 0–100 (с картой мотора)', t100, t100 !== null && t100 < 3.6, ' с')
  check('максимальная скорость', kmh(w), kmh(w) > 320 && kmh(w) < 360, ' км/ч')
}

// 3. торможение с 300: пик 4–5,5 g (Brembo: 4,7 g в Монце)
{
  const w = fresh()
  run(w, NONE, 0.5)
  accelTo(w, 300)
  let peak = 0
  let prev = w.v.state.fwdSpeed
  run(w, { brake: 1 }, 3, () => {
    const s = w.v.state.fwdSpeed
    peak = Math.max(peak, (prev - s) / DT / 9.81)
    prev = s
  })
  check('пиковое торможение с 300 (ослаблено по просьбе Ромы)', peak, peak > 2.5 && peak < 4, ' g')
}

// 4. боковое: на высокой скорости держит прижим, на малой — только шина
{
  const fast = steady(280)
  check('боковое на ~270 км/ч', fast.g, fast.g > 4.8 && fast.g < 6.2, ' g')
  check('не опрокидывается в повороте', fast.minUp, fast.minUp > 0.95)
  const slow = steady(50)
  check('боковое на 50 км/ч', slow.g, slow.g > 1.3 && slow.g < 2.2, ' g')
  const hairpin = steady(30)
  check('радиус шпильки на 30 км/ч', hairpin.radius, hairpin.radius < 9.5, ' м')
}

// 5. короткое касание руля на 250 не швыряет болид
{
  const w = fresh()
  run(w, NONE, 0.5)
  accelTo(w, 250)
  const y0 = yawOf(w.v.body.rotation())
  const p0 = w.v.body.translation()
  run(w, (t) => ({ ...hold(w, 250), steer: t < 0.1 ? 1 : 0 }), 2)
  const p1 = w.v.body.translation()
  const side = (p1.x - p0.x) * Math.cos(y0) - (p1.z - p0.z) * Math.sin(y0)
  check('касание 0,1 с на 250: сдвиг вбок', Math.abs(side), Math.abs(side) < 2.5, ' м')
}

// 6. отпустил руль — выпрямился; змейка не раскачивает
{
  const w = fresh()
  run(w, NONE, 0.5)
  accelTo(w, 60)
  run(w, () => ({ ...hold(w, 60), steer: 1 }), 1.5)
  run(w, () => hold(w, 60), 1)
  let maxRate = 0
  run(w, () => hold(w, 60), 2, () => (maxRate = Math.max(maxRate, Math.abs(w.v.body.angvel().y))))
  check('отпустил руль на 60: вращение через 1 с', deg(maxRate), deg(maxRate) < 1, '°/с')

  const s = fresh()
  run(s, NONE, 0.5)
  accelTo(s, 200)
  run(s, (t) => ({ ...hold(s, 200), steer: Math.floor(t / 0.5) % 2 ? -1 : 1 }), 4)
  run(s, () => hold(s, 200), 2)
  const r = deg(Math.abs(s.v.body.angvel().y))
  check('змейка на 200: вращение через 2 с', r, r < 1, '°/с')
}

// 7. Занос — только если постараться (просьба Ромы): газ в пол с полным рулём на выходе из шпильки
// даёт занос, который ловится; развернуть болид можно ручником
function slideAngle(w) {
  const lv = w.v.body.linvel()
  const sp = Math.hypot(lv.x, lv.z)
  if (sp < 4) return 0
  const q = w.v.body.rotation()
  const fx = 2 * (q.x * q.z + q.w * q.y)
  const fz = 1 - 2 * (q.x * q.x + q.y * q.y)
  return deg(Math.acos(Math.max(-1, Math.min(1, (fx * lv.x + fz * lv.z) / (Math.hypot(fx, fz) * sp)))))
}
for (const speed of [40, 60, 100]) {
  const w = fresh()
  run(w, NONE, 0.5)
  accelTo(w, speed)
  run(w, () => ({ ...hold(w, speed), steer: 1 }), 1)
  let m = 0
  run(w, { throttle: 1, steer: 1 }, 2.5, () => (m = Math.max(m, slideAngle(w))))
  check(`газ в пол с полным рулём на ${speed} км/ч: не разворачивает`, m, m < 25, '°')
}
{
  const w = fresh()
  run(w, NONE, 0.5)
  accelTo(w, 70)
  let m = 0
  run(w, { handbrake: true, steer: 1 }, 1.5, () => (m = Math.max(m, slideAngle(w))))
  check('ручник с рулём на 70 км/ч: разворачивает (постарался — получил)', m, m > 60, '°')
}

// 8. задел гравий одной стороной — не «магнитит»
{
  let edge = false
  const w = fresh((x) => (edge && x > 0.5 ? 'gravel' : 'asphalt'))
  run(w, NONE, 0.5)
  accelTo(w, 160)
  edge = true
  const y0 = yawOf(w.v.body.rotation())
  run(w, () => hold(w, 160), 1.5)
  const turned = Math.abs(deg(yawOf(w.v.body.rotation()) - y0))
  check('гравий одной стороной на 160: увод курса', turned, turned < 2, '°')
}

// 9. на 300 по прямой — ни малейшей раскачки, днище не в асфальте
{
  const w = fresh()
  run(w, NONE, 0.5)
  accelTo(w, 300)
  let maxLat = 0
  run(w, () => hold(w, 300), 3, () => {
    const lv = w.v.body.linvel()
    const yaw = yawOf(w.v.body.rotation())
    maxLat = Math.max(maxLat, Math.abs(lv.x * Math.cos(yaw) - lv.z * Math.sin(yaw)))
  })
  check('прямая 300: скорость вбок', maxLat, maxLat < 0.05, ' м/с')
  const comp = Math.max(...w.v.wheels.map((x) => x.compression))
  check('прямая 300: сжатие подвески', comp * 1000, comp < TUNING.bumpStop, ' мм')
}

// 10. задний ход
{
  const w = fresh()
  run(w, NONE, 0.5)
  run(w, { brake: 1 }, 4)
  check('задний ход', w.v.state.fwdSpeed * 3.6, w.v.state.fwdSpeed < -5, ' км/ч')
}


// 11b. ABS (кнопка B): без него тормоз в пол на повороте руля блокирует колёса, с ним — нет
function hardBrake(absOn) {
  const w = fresh()
  run(w, NONE, 0.5)
  accelTo(w, 250)
  let lit = false
  let locked = false
  run(w, { brake: 1, steer: 0.4, abs: absOn }, 1.5, () => {
    if (w.v.state.absActive) lit = true
    if (w.v.wheels.some((x) => x.sliding)) locked = true
  })
  return { lit, locked }
}
{
  const off = hardBrake(false)
  const on = hardBrake(true)
  check('без ABS тормоз в пол блокирует колёса', `блок ${off.locked ? 'да' : 'нет'}`, off.locked && !off.lit)
  check('с ABS колёса не блокируются', `блок ${on.locked ? 'да' : 'нет'}, ABS работал ${on.lit ? 'да' : 'нет'}`, !on.locked && on.lit)
}

// 12. Настройка болида действительно меняет поведение
import { SETUP_DEFAULT, SETUP_PRESETS } from '../src/tuning.js'
function withSetup(values, fn) {
  Object.assign(TUNING.setup, SETUP_DEFAULT, values)
  try {
    return fn()
  } finally {
    Object.assign(TUNING.setup, SETUP_DEFAULT)
  }
}
function aeroAt(kmhTarget) {
  const w = fresh()
  run(w, NONE, 0.5)
  accelTo(w, kmhTarget)
  run(w, () => hold(w, kmhTarget), 1.5)
  return w.v.state
}
{
  const base = withSetup({}, () => aeroAt(250).aeroMult)
  const high = withSetup({ rideF: 31, rideR: 31 }, () => aeroAt(250).aeroMult)
  check('клиренс +20 мм: граунд-эффект слабее', `${base.toFixed(3)} → ${high.toFixed(3)}`, high < base - 0.02)
  const low = withSetup({ rideF: 1, rideR: 1, suspF: 1, suspR: 1 }, () => aeroAt(300).plankContact)
  check('низко и мягко на 300: днище чиркает', low, low > 0, ' Н')
}
{
  const top = (preset) =>
    withSetup(SETUP_PRESETS[preset].values, () => {
      const w = fresh()
      run(w, NONE, 0.5)
      run(w, { throttle: 1 }, 40)
      return kmh(w)
    })
  const straights = top('straights')
  const balanced = top('balanced')
  const corners = top('corners')
  check('пресеты: «Прямые» > «Универсальная» > «Повороты» на прямой', `${straights.toFixed(0)} / ${balanced.toFixed(0)} / ${corners.toFixed(0)} км/ч`, straights > balanced + 5 && balanced > corners + 5)
}
{
  const rear = (preset) =>
    withSetup(SETUP_PRESETS[preset].values, () => {
      const r = steady(150)
      return Math.abs(deg((r.w.v.wheels[2].slip + r.w.v.wheels[3].slip) / 2))
    })
  const rookie = rear('rookie')
  const middle = rear('balanced')
  const sharp = rear('sharp')
  check('пресеты: «Новичок» прощает больше «Универсальной», та — больше «Пилота»', `увод зада ${rookie.toFixed(2)}° / ${middle.toFixed(2)}° / ${sharp.toFixed(2)}°`, rookie < middle && middle < sharp)
}
{
  const g = (camberF) => withSetup({ camberF }, () => steady(150).g)
  const a = g(-3.5)
  const b = g(-2.5)
  check('развал меняет сцепление в повороте', `${a.toFixed(3)} g при −3,5° против ${b.toFixed(3)} g при −2,5°`, Math.abs(a - b) > 0.005)
}

// 13. Тормозной путь с 250 до 100 км/ч — надо тормозить заранее (у настоящего F1 ~55 м, у нас длиннее нарочно)
{
  const w = fresh()
  run(w, NONE, 0.5)
  accelTo(w, 250)
  const p0 = w.v.body.translation()
  let t = 0
  for (; t < 10 && kmh(w) > 100; t += DT) run(w, { brake: 1 }, DT)
  const p1 = w.v.body.translation()
  const dist = Math.hypot(p1.x - p0.x, p1.z - p0.z)
  check('тормозной путь 250→100 км/ч', `${dist.toFixed(0)} м за ${t.toFixed(2)} с`, dist > 65 && dist < 120)
}
// 14. Дифференциал: заблокированный на газу — болид устойчивее (меньше увод зада), открытый — живее
{
  const rear = (diffOn) =>
    withSetup({ diffOn }, () => {
      const w = fresh()
      run(w, NONE, 0.5)
      accelTo(w, 80)
      run(w, () => ({ ...hold(w, 80), steer: 1 }), 1)
      let m = 0
      run(w, { throttle: 1, steer: 1 }, 2, () => (m = Math.max(m, Math.abs(deg(w.v.wheels[2].slip)), Math.abs(deg(w.v.wheels[3].slip)))))
      return m
    })
  const locked = rear(100)
  const open = rear(10)
  check('дифференциал 100% устойчивее, чем 10%', `увод зада ${locked.toFixed(2)}° против ${open.toFixed(2)}°`, locked < open)
}
// 15. Давление шин: ниже — больше сцепления в повороте
{
  const g = (pf, pr) => withSetup({ tyreFL: pf, tyreFR: pf, tyreRL: pr, tyreRR: pr }, () => steady(120).g)
  const soft = g(22.5, 20.5)
  const hard = g(29.5, 26.5)
  check('давление шин ниже — больше сцепления', `${soft.toFixed(3)} g против ${hard.toFixed(3)} g`, soft > hard)
}

// 16. Старт: пять огней по одному в секунду, гаснут через 5,2–8 с; пока горят — болид с газом в пол стоит
{
  const mk = () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
  const s = createStart([0, 1, 2, 3, 4].map(() => [mk(), mk()]))
  s.begin()
  const w = fresh()
  run(w, NONE, 0.5)
  let maxLit = 0
  let moved = 0
  for (let t = 0; t < 10 && s.waiting; t += DT) {
    stepVehicle(w.v, s.hold({ ...NONE, throttle: 1, boost: true }), DT, w.surfaceAt)
    w.world.step()
    s.update(DT)
    maxLit = Math.max(maxLit, s.state.lit)
    moved = Math.max(moved, Math.abs(w.v.state.speedKmh))
  }
  check('огни старта', `${maxLit} огней, погасли на ${s.state.outAt.toFixed(2)} с`, maxLit === 5 && s.state.outAt >= 5.2 && s.state.outAt <= 8 && s.state.phase === 'go')
  check('до погасания огней болид не едет', `${moved.toFixed(2)} км/ч с газом в пол`, moved < 1)
  run(w, { throttle: 1 }, 1)
  check('после огней едет', `${kmh(w).toFixed(0)} км/ч за 1 с`, kmh(w) > 20)
}

// 17. Режим обгона (Shift): разгон быстрее, батарея тратится; на торможении заряжается
{
  const to250 = (boost) => {
    const w = fresh()
    run(w, NONE, 0.5)
    let t = 0
    for (; t < 30 && kmh(w) < 250; t += DT) run(w, { throttle: 1, boost }, DT)
    return { t, battery: w.v.battery, w }
  }
  const plain = to250(false)
  const fast = to250(true)
  check('режим обгона: 0–250 быстрее', `${fast.t.toFixed(2)} с против ${plain.t.toFixed(2)} с, батарея ${Math.round(fast.battery * 100)}%`, fast.t < plain.t - 0.3 && fast.battery < 0.75)
  const before = fast.w.v.battery
  run(fast.w, { brake: 1 }, 1.5)
  const after = fast.w.v.battery
  check('торможение заряжает батарею', `${Math.round(before * 100)}% → ${Math.round(after * 100)}%`, after > before + 0.05)
}

// 18. Режимы батареи (1–4): «Зарядка» медленнее, но заряжает на газу; «Быстрый круг» быстрее «Баланса»
{
  const to250 = (ersMode, battery = 0.5) => {
    const w = fresh()
    w.v.battery = battery
    run(w, NONE, 0.5)
    let t = 0
    for (; t < 30 && kmh(w) < 250; t += DT) run(w, { throttle: 1, ersMode }, DT)
    return { t, battery: w.v.battery }
  }
  const harvest = to250('harvest')
  const balanced = to250('balanced')
  const hotlap = to250('hotlap')
  check('режимы батареи: быстрый круг > баланс > зарядка', `${hotlap.t.toFixed(2)} / ${balanced.t.toFixed(2)} / ${harvest.t.toFixed(2)} с до 250`, hotlap.t < balanced.t && balanced.t < harvest.t)
  check('«Зарядка» заряжает на газу, «Баланс» не трогает', `${Math.round(harvest.battery * 100)}% и ${Math.round(balanced.battery * 100)}% (было 50%)`, harvest.battery > 0.55 && Math.abs(balanced.battery - 0.5) < 0.005)
}

// 18b. Оценка «держит повороты» у пресетов: боковая перегрузка в быстром повороте
{
  const g = (preset) => withSetup(SETUP_PRESETS[preset].values, () => steady(200).g)
  const corners = g('corners')
  const balanced = g('balanced')
  const straights = g('straights')
  check('пресеты: «Повороты» > «Универсальная» > «Прямые» в повороте', `${corners.toFixed(2)} / ${balanced.toFixed(2)} / ${straights.toFixed(2)} g на 200 км/ч`, corners > balanced && balanced > straights)
}

// 19. Активная аэродинамика 2026: режим прямой быстрее на прямой; тормоз, руль и конец зоны его закрывают
{
  const top = (aero) => {
    const w = fresh()
    run(w, NONE, 0.5)
    run(w, { throttle: 1, aero, aeroZone: true }, 40)
    return kmh(w)
  }
  const closed = top(false)
  const open = top(true)
  check('режим прямой: максималка выше', `${open.toFixed(0)} км/ч против ${closed.toFixed(0)}`, open > closed + 8)

  const w = fresh()
  run(w, NONE, 0.5)
  accelTo(w, 200)
  run(w, { throttle: 1, aero: true, aeroZone: true }, 0.5)
  const opened = w.v.aeroOn && w.v.aero > 0.9
  run(w, { brake: 1, aero: true, aeroZone: true }, 0.2)
  const byBrake = !w.v.aeroOn && w.v.aero < 0.1
  run(w, { throttle: 1, aero: true, aeroZone: true }, 0.5)
  run(w, { throttle: 1, steer: 1, aero: true, aeroZone: true }, 0.5)
  const bySteer = !w.v.aeroOn
  run(w, { throttle: 1, aero: true, aeroZone: false }, 0.3)
  const byZone = !w.v.aeroOn
  check('крылья закрываются сами', `открылись ${opened ? 'да' : 'нет'}, тормоз ${byBrake ? 'да' : 'нет'}, руль ${bySteer ? 'да' : 'нет'}, вне зоны ${byZone ? 'да' : 'нет'}`, opened && byBrake && bySteer && byZone)
}

// 20. Боты: на овале (прямые 400 м, повороты R 60 м, ширина 12,7 м) проходят круги, не вылетают,
// сложные быстрее средних, средние быстрее лёгких; два бота друг в друга не врезаются
function oval() {
  const pts = []
  const S = 400
  const R = 60
  const len = 2 * S + 2 * Math.PI * R
  for (let d = 0; d < len; d += 2) {
    let x
    let z
    if (d < S) [x, z] = [0, d]
    else if (d < S + Math.PI * R) [x, z] = [R - R * Math.cos((d - S) / R), S + R * Math.sin((d - S) / R)]
    else if (d < 2 * S + Math.PI * R) [x, z] = [2 * R, S - (d - S - Math.PI * R)]
    else [x, z] = [R + R * Math.cos((d - 2 * S - Math.PI * R) / R), -R * Math.sin((d - 2 * S - Math.PI * R) / R)]
    pts.push({ x, z, distance_m: d, width_left: 6.35, width_right: 6.35 })
  }
  return pts
}
const OVAL = oval()
const offAxis = (p) => Math.sqrt(Math.min(...OVAL.map((a) => (a.x - p.x) ** 2 + (a.z - p.z) ** 2)))
function botLaps(level, seconds) {
  const w = fresh()
  const d = createAiDriver(createRaceLine(OVAL, level), { idx: 0 })
  let dev = 0
  let prev = 0
  let last = null
  const times = []
  for (let t = 0; t < seconds; t += DT) {
    stepVehicle(w.v, d.update(w.v, DT), DT, w.surfaceAt)
    w.world.step()
    if (t > 1 && Math.round(t / DT) % 24 === 0) dev = Math.max(dev, offAxis(w.v.body.translation()))
    const s = OVAL[d.state.idx].distance_m
    if (prev > 900 && s < 100) {
      if (last !== null) times.push(t - last)
      last = t
    }
    prev = s
  }
  return { lap: times.length ? times[times.length - 1] : Infinity, dev }
}
{
  const light = botLaps('light', 75)
  const medium = botLaps('medium', 65)
  const hard = botLaps('hard', 60)
  check('боты: сложные > средние > лёгкие', `круг ${hard.lap.toFixed(2)} / ${medium.lap.toFixed(2)} / ${light.lap.toFixed(2)} с`, hard.lap < medium.lap && medium.lap < light.lap)
  const dev = Math.max(light.dev, medium.dev, hard.dev)
  check('боты не вылетают с асфальта', `до ${dev.toFixed(2)} м от оси (край асфальта для центра болида 6,05)`, dev < 6.05)
}
{
  // медленный бот впереди, быстрый догоняет: обгоняет без удара
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0), g)
  const slow = createVehicle(RAPIER, world, { x: 0, y: 0.05, z: 60, wear: false }, TUNING)
  const fast = createVehicle(RAPIER, world, { x: 0, y: 0.05, z: 0, wear: false }, TUNING)
  const ds = createAiDriver(createRaceLine(OVAL, 'light'), { idx: 30, skill: 0.8 })
  const df = createAiDriver(createRaceLine(OVAL, 'hard'), { idx: 0 })
  const pos = (v) => ({ x: v.body.translation().x, z: v.body.translation().z, speed: v.state.fwdSpeed })
  let hit = 0
  let passed = false
  for (let t = 0; t < 60; t += DT) {
    const a = ds.update(slow, DT, [pos(fast)])
    const b = df.update(fast, DT, [pos(slow)])
    stepVehicle(slow, a, DT, () => 'asphalt')
    stepVehicle(fast, b, DT, () => 'asphalt')
    world.step()
    const p = slow.body.translation()
    const q = fast.body.translation()
    if (Math.hypot(p.x - q.x, p.z - q.z) < 2.2) hit++
    const sa = OVAL[ds.state.idx].distance_m
    const sb = OVAL[df.state.idx].distance_m
    if (t > 5 && sb > sa + 20 && sb - sa < 600) passed = true
  }
  check('бот обгоняет медленного без удара', `обогнал ${passed ? 'да' : 'нет'}, касаний ${hit}`, passed && hit === 0)
}

// 20b. Старт бок о бок: пока боты едут рядом, не лезут на линию поверх соседа — не сходятся вплотную, не касаются
{
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0), g)
  const left = createVehicle(RAPIER, world, { x: 2.6, y: 0.05, z: 8, wear: false }, TUNING)
  const right = createVehicle(RAPIER, world, { x: -2.6, y: 0.05, z: 0, wear: false }, TUNING)
  const line = createRaceLine(OVAL, 'hard')
  const dl = createAiDriver(line, {})
  const dr = createAiDriver(line, {})
  const pos = (v) => ({ x: v.body.translation().x, z: v.body.translation().z, speed: v.state.fwdSpeed })
  let early = Infinity
  let touch = 0
  for (let t = 0; t < 12; t += DT) {
    const a = dl.update(left, DT, [pos(right)])
    const b = dr.update(right, DT, [pos(left)])
    stepVehicle(left, a, DT, () => 'asphalt')
    stepVehicle(right, b, DT, () => 'asphalt')
    world.step()
    const p = left.body.translation()
    const q = right.body.translation()
    if (Math.abs(p.z - q.z) < 5.5) early = Math.min(early, Math.abs(p.x - q.x)) // корпуса перекрываются по длине
    if (Math.hypot(p.x - q.x, p.z - q.z) < 2.2) touch++
  }
  check('старт бок о бок: держат дистанцию, без касаний', `пока рядом — не ближе ${early.toFixed(1)} м, касаний ${touch}`, early > 2.1 && touch === 0)
}
// 20d. Пилоты: номер 1 быстрее номера 11; номера на гонку — все 1…11 вразброс
{
  const lapWith = (pilot) => {
    const w = fresh()
    const d = createAiDriver(createRaceLine(OVAL, 'hard', TUNING, pilot), { idx: 0 })
    let prev = 0
    let last = null
    let lap = null
    for (let t = 0; t < 80 && lap === null; t += DT) {
      stepVehicle(w.v, d.update(w.v, DT), DT, w.surfaceAt)
      w.world.step()
      const s2 = OVAL[d.state.idx].distance_m
      if (prev > 900 && s2 < 100) {
        if (last !== null) lap = t - last
        last = t
      }
      prev = s2
    }
    return lap
  }
  const one = lapWith({ pace: 1, line: 1, brake: 1, look: 1 })
  const eleven = lapWith({ pace: 0.95, line: 0.85, brake: 0.95, look: 1 })
  const ranks = makePilots(11).map((x) => x.rank).sort((a, b) => a - b).join(',')
  check('пилоты: №1 быстрее №11', `${one.toFixed(2)} против ${eleven.toFixed(2)} с; номера ${ranks}`, one < eleven - 0.2 && ranks === '1,2,3,4,5,6,7,8,9,10,11')
}

// 20c. Защита: средний бот на прямой видит, что его догоняют слева, — перестраивается влево (одно перестроение)
{
  const w = fresh()
  w.v.body.setTranslation({ x: 0, y: 0.05, z: 60 }, true)
  const d = createAiDriver(createRaceLine(OVAL, 'medium'), { skill: 0.75 })
  let startX = null
  let moved = 0
  for (let t = 0; t < 6; t += DT) {
    const p = w.v.body.translation()
    if (t > 2 && startX === null) startX = p.x
    // догоняющий: 3 м левее (+x) и на 20 м сзади, на 8 м/с быстрее
    const attacker = t > 2 ? [{ x: p.x + 3, z: p.z - 20, speed: w.v.state.fwdSpeed + 8 }] : []
    stepVehicle(w.v, d.update(w.v, DT, attacker), DT, w.surfaceAt)
    w.world.step()
    if (startX !== null) moved = Math.max(moved, w.v.body.translation().x - startX)
  }
  check('защита позиции: перестраивается навстречу', `сдвинулся на ${moved.toFixed(1)} м в сторону догоняющего`, moved > 1.5)
}

// 20e–20h. Боты в потоке (прогноз столкновений, полосы, автомат обгона). Касание считаем по физике Rapier:
// самая глубокая точка контакта между болидами (глубже 2 см — удар, мельче — скользящее касание бортов)
const NEAR_TOUCH = 0.02
const penetration = (world, cars) => {
  let deep = 0
  let touching = false
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      for (let a = 0; a < cars[i].body.numColliders(); a++) {
        for (let b = 0; b < cars[j].body.numColliders(); b++) {
          world.contactPair(cars[i].body.collider(a), cars[j].body.collider(b), (m) => {
            for (let k = 0; k < m.numContacts(); k++) {
              if (m.contactDist(k) < 0) {
                touching = true
                deep = Math.max(deep, -m.contactDist(k))
              }
            }
          })
        }
      }
    }
  }
  return { deep, touching }
}
const newWorld = () => {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0), g)
  return world
}
const posOf = (v) => ({ x: v.body.translation().x, z: v.body.translation().z, speed: v.state.fwdSpeed })

// 20e. Восемь ботов стоя на решётке 2×4 (ряды через 9 м), темп и агрессия у всех разные, 45 с на овале:
// ударов нет, касаются бортами меньше 2 с в сумме, с асфальта не уходят, обгоны случаются
{
  let worstDeep = 0
  let worstTouch = 0
  let worstOff = 0
  let passes = 0
  for (const seed of [1, 2, 3]) {
    let rs = seed
    const rand = () => (rs = (rs * 1664525 + 1013904223) % 4294967296) / 4294967296
    const world = newWorld()
    const cars = []
    for (let i = 0; i < 8; i++) {
      const v = createVehicle(RAPIER, world, { x: i % 2 ? 2.6 : -2.6, y: 0.05, z: 300 - Math.floor(i / 2) * 9 - (i % 2) * 4, wear: false }, TUNING)
      const pilot = { pace: 1 - 0.01 * i, line: 0.9, brake: 1, look: 1, aggression: rand() }
      cars.push({ v, body: v.body, d: createAiDriver(createRaceLine(OVAL, 'hard', TUNING, pilot), { skill: 0.82 + rand() * 0.18 }), lap: 0, last: 0, s: 0 })
    }
    let touchSteps = 0
    for (let t = 0; t < 45; t += DT) {
      const ps = cars.map((c) => posOf(c.v))
      const inputs = cars.map((c, i) => c.d.update(c.v, DT, ps.filter((_, j) => j !== i)))
      cars.forEach((c, i) => stepVehicle(c.v, inputs[i], DT, () => 'asphalt'))
      world.step()
      const { deep, touching } = penetration(world, cars.map((c) => c.v))
      worstDeep = Math.max(worstDeep, deep)
      if (touching) touchSteps++
      if (Math.round(t / DT) % 24 === 0) {
        for (const c of cars) {
          worstOff = Math.max(worstOff, offAxis(c.v.body.translation()))
          const sNow = OVAL[c.d.state.idx].distance_m
          if (sNow < c.last - 500) c.lap++ // перешли через ноль круга
          c.last = sNow
          const prev = c.s
          c.s = c.lap * 1000 + sNow
          if (t > 1) {
            for (const o of cars) if (o !== c && prev < o.sPrev && c.s > o.s && Math.abs(c.s - o.s) < 60) passes++
          }
          c.sPrev = prev
        }
      }
    }
    worstTouch = Math.max(worstTouch, touchSteps * DT)
  }
  check('бот в потоке: восемь со старта стоя, без ударов', `глубже всего ${(worstDeep * 100).toFixed(1)} см, касаются бортами до ${worstTouch.toFixed(2)} с, от оси до ${worstOff.toFixed(2)} м, обгонов ${passes}`, worstDeep < NEAR_TOUCH && worstTouch < 2 && worstOff < 6.05 && passes >= 3)
}

// 20f. Болид в соседней полосе — не повод тормозить: быстрый бот догоняет медленный, едущий в 5 м сбоку,
// и проезжает рядом, не сбавляя газ и не уходя со своей линии
{
  const world = newWorld()
  const line = createRaceLine(OVAL, 'hard')
  const i0 = 20 // 40 м от старта прямой
  const v = createVehicle(RAPIER, world, { x: line.x[i0], y: 0.05, z: line.z[i0], wear: false }, TUNING)
  v.body.setLinvel({ x: 0, y: 0, z: 45 }, true)
  const d = createAiDriver(line, { idx: i0 })
  const lane = line.x[i0] - 5 // болид справа от линии бота на 5 м
  let z = line.z[i0] + 50
  let maxBrake = 0
  let maxOff = 0
  let passed = false
  for (let t = 0; t < 4; t += DT) { // до торможения перед поворотом
    z += 25 * DT
    const input = d.update(v, DT, [{ x: lane, z, speed: 25 }])
    stepVehicle(v, input, DT, () => 'asphalt')
    world.step()
    if (t > 0.5) {
      maxBrake = Math.max(maxBrake, input.brake)
      maxOff = Math.max(maxOff, Math.abs(d.state.offset))
    }
    if (v.body.translation().z > z + 20) passed = true
  }
  check('бот не тормозит за соседом в другой полосе', `обогнал ${passed ? 'да' : 'нет'}, педаль тормоза до ${maxBrake.toFixed(2)}, ушёл от линии не дальше ${maxOff.toFixed(2)} м`, passed && maxBrake < 0.05 && maxOff < 1)
}

// 20g. Обгон в колонне: быстрый бот идёт за тремя медленными в разных полосах — обгоняет всех, без ударов, а боковое
// смещение гладкое: скорость до 3,3 м/с, ускорение до 5,5 м/с² (и в режиме «следом» тормозит, не прыгая вбок)
{
  const world = newWorld()
  const fastLine = createRaceLine(OVAL, 'hard')
  const slowLine = createRaceLine(OVAL, 'light')
  const mk = (x, z, v0) => {
    const v = createVehicle(RAPIER, world, { x, y: 0.05, z, wear: false }, TUNING)
    v.body.setLinvel({ x: 0, y: 0, z: v0 }, true)
    return v
  }
  const fast = mk(fastLine.x[10], 20, 40)
  const slowIdx = [60, 85, 110]
  const slow = slowIdx.map((i, k) => mk(slowLine.x[i] + (k === 1 ? 2.2 : -1.5), slowLine.z[i], 32))
  const df = createAiDriver(fastLine, { idx: 10 })
  const ds = slow.map((_, k) => createAiDriver(slowLine, { idx: slowIdx[k], skill: 0.62 }))
  const all = [fast, ...slow]
  let worstDeep = 0
  let maxV = 0
  let maxA = 0
  let prevO = null
  let prevV = 0
  let passedAll = false
  for (let t = 0; t < 40; t += DT) {
    const ps = all.map(posOf)
    stepVehicle(fast, df.update(fast, DT, ps.slice(1)), DT, () => 'asphalt')
    slow.forEach((v, k) => stepVehicle(v, ds[k].update(v, DT, ps.filter((_, j) => j !== k + 1)), DT, () => 'asphalt'))
    world.step()
    worstDeep = Math.max(worstDeep, penetration(world, all).deep)
    const o = df.state.offset
    if (t > 1 && prevO !== null) {
      const vl = (o - prevO) / DT
      maxV = Math.max(maxV, Math.abs(vl))
      if (t > 1.1) maxA = Math.max(maxA, Math.abs((vl - prevV) / DT))
      prevV = vl
    }
    prevO = o
    if (slow.every((v) => fast.body.translation().z > v.body.translation().z + 12)) passedAll = true
  }
  check('обгон колонны: без ударов, всех обогнал', `обогнал ${passedAll ? 'всех' : 'не всех'}, глубже всего ${(worstDeep * 100).toFixed(1)} см`, passedAll && worstDeep < NEAR_TOUCH)
  check('боковое смещение при обгоне без рывков', `скорость до ${maxV.toFixed(2)} м/с, ускорение до ${maxA.toFixed(1)} м/с²`, maxV < 3.3 && maxA < 5.5)
}

// 21. Учёт гонки: круги со старта за линией, места, отставание, финиш через N кругов
{
  const L = 1000
  const race = createRace(L, [{ id: 'a', name: 'A', player: true }, { id: 'b', name: 'B' }], 2)
  // оба стоят за линией старта, b на 10 м впереди; b едет 50 м/с, a — 40
  const pos = { a: L - 30, b: L - 20 }
  race.update(0, (c) => pos[c.id])
  race.go()
  let gapB = 0
  for (let t = 0; t < 80; t += 0.05) {
    pos.a = (pos.a + 40 * 0.05) % L
    pos.b = (pos.b + 50 * 0.05) % L
    race.update(0.05, (c) => pos[c.id])
    if (t > 10 && t < 10.06) gapB = race.car('a').gap
  }
  const st = race.state
  check('гонка: круги, места и финиш', `победил ${st.order[0].name} за ${st.order[0].finishTime.toFixed(1)} с, отставание A на 10-й с ${gapB.toFixed(1)} с`, st.order[0].id === 'b' && st.order[0].finished && Math.abs(st.order[0].finishTime - 40.4) < 0.2 && st.playerDone && gapB > 2 && gapB < 3.5)
}

// 22. Боты на настоящей LUMEN RING (ось из public/models/track.glb, земля плоская): круг в пределах асфальта,
// уровни по порядку. Края асфальта — asphalt_half_width оси (7 м), центр болида не дальше 6,05 м
{
  const glb = fs.readFileSync(new URL('../public/models/track.glb', import.meta.url))
  const json = JSON.parse(glb.slice(20, 20 + glb.readUInt32LE(12)).toString())
  const axis = json.nodes
    .find((n) => n.name === 'Ось трассы')
    .children.map((i) => {
      const n = json.nodes[i]
      const t = n.translation || [n.matrix[12], n.matrix[13], n.matrix[14]]
      return { x: t[0], z: t[2], ...n.extras }
    })
    .sort((a, b) => a.distance_m - b.distance_m)
  const len = axis[axis.length - 1].distance_m + 2
  const ringLap = (level) => {
    const w = fresh()
    const a0 = axis[0]
    const a1 = axis[1]
    w.v.body.setTranslation({ x: a0.x, y: 0.05, z: a0.z }, true)
    const yaw = Math.atan2(a1.x - a0.x, a1.z - a0.z)
    w.v.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true)
    const d = createAiDriver(createRaceLine(axis, level), { idx: 0 })
    let prev = 0
    let last = null
    let lap = null
    let over = -Infinity
    for (let t = 0; t < 200 && lap === null; t += DT) {
      stepVehicle(w.v, d.update(w.v, DT), DT, w.surfaceAt)
      w.world.step()
      const p = w.v.body.translation()
      const i = d.state.idx
      const a = axis[i]
      const b = axis[(i + 1) % axis.length]
      const tx = b.x - a.x
      const tz = b.z - a.z
      const lat = ((p.x - a.x) * tz - (p.z - a.z) * tx) / Math.hypot(tx, tz)
      over = Math.max(over, Math.abs(lat) - ((a.asphalt_half_width ?? 7) - 0.95))
      if (prev > len * 0.75 && a.distance_m < len * 0.25) {
        if (last !== null) lap = t - last
        last = t
      }
      prev = a.distance_m
    }
    return { lap: lap ?? Infinity, over }
  }
  const hard = ringLap('hard')
  const medium = ringLap('medium')
  const light = ringLap('light')
  check('боты на LUMEN RING: круг', `${hard.lap.toFixed(1)} / ${medium.lap.toFixed(1)} / ${light.lap.toFixed(1)} с (сложные / средние / лёгкие)`, hard.lap < medium.lap && medium.lap < light.lap && light.lap < 90 && hard.lap < 68.5)
  const worst = Math.max(hard.over, medium.over, light.over)
  check('боты на LUMEN RING не съезжают с асфальта', `запас до края ${(-worst).toFixed(2)} м`, worst < 0)
}

// 23. Границы трассы: колёса на белой линии — можно; все четыре целиком за линией — нарушение;
// заезд короче 0,15 с не считается; штраф +5 с меняет места на финише
{
  // прямая ось вдоль +z, до белой линии 6,35 м с каждой стороны
  const axis = Array.from({ length: 50 }, (_, i) => ({ x: 0, z: i * 2, width_left: 6.35, width_right: 6.35 }))
  const at = (x) => ({ translation: () => ({ x, y: 0, z: 40 }), rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }) })
  const onLine = wheelsOut(axis, 20, at(6.35), TUNING) // наружные колёса за линией, внутренние на трассе
  const farOut = wheelsOut(axis, 20, at(-8), TUNING)
  const inside = wheelsOut(axis, 20, at(0), TUNING)
  const lim = createLimits()
  let short = 0
  for (let t = 0; t < 0.1; t += 0.01) short += lim.update(0.01, true) ? 1 : 0
  lim.update(0.01, false)
  let long = 0
  for (let t = 0; t < 1; t += 0.01) long += lim.update(0.01, true) ? 1 : 0
  check('границы трассы: что считается выездом', `центр 0 м — ${inside ? 'выезд' : 'нет'}, центр на линии — ${onLine ? 'выезд' : 'нет'}, 8 м — ${farOut ? 'выезд' : 'нет'}; 0,1 с — ${short}, 1 с — ${long} нарушение`, !inside && !onLine && farOut && short === 0 && long === 1)

  const race = createRace(1000, [{ id: 'a', name: 'A', player: true }, { id: 'b', name: 'B' }], 1)
  const pos = { a: 995, b: 990 }
  race.update(0, (c) => pos[c.id])
  race.go()
  race.addPenalty('a', 5)
  for (let t = 0; t < 30; t += 0.05) {
    pos.a = (pos.a + 50 * 0.05) % 1000
    pos.b = (pos.b + 49 * 0.05) % 1000
    race.update(0.05, (c) => pos[c.id])
  }
  check('штраф +5 с за границы трассы меняет места', `первым ${race.state.order[0].name}`, race.state.order[0].id === 'b')
}

// 24. Износ шин на LUMEN RING (сложный бот, 2 круга на каждом составе): мягкие стираются быстрее средних,
// средние — быстрее твёрдых; средние ~10–25% за круг на самой нагруженной шине; температура в разумных пределах
{
  const glb = fs.readFileSync(new URL('../public/models/track.glb', import.meta.url))
  const json = JSON.parse(glb.slice(20, 20 + glb.readUInt32LE(12)).toString())
  const P = (n) => n.translation || [n.matrix[12], n.matrix[13], n.matrix[14]]
  const kids = (name) => json.nodes.find((n) => n.name === name).children.map((i) => json.nodes[i])
  const axis = kids('Ось трассы').map((n) => ({ x: P(n)[0], z: P(n)[2], ...n.extras })).sort((a, b) => a.distance_m - b.distance_m)
  const len = axis[axis.length - 1].distance_m + 2
  const perLap = (compound) => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    world.timestep = DT
    const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0), g)
    const yaw = Math.atan2(axis[1].x - axis[0].x, axis[1].z - axis[0].z)
    const v = createVehicle(RAPIER, world, { x: axis[0].x, y: 0.05, z: axis[0].z, yaw }, TUNING)
    v.compound = compound
    const d = createAiDriver(createRaceLine(axis, 'hard'), { idx: 0 })
    let prev = 0
    let at1 = null
    let tmax = 0
    for (let t = 0; t < 200; t += DT) {
      stepVehicle(v, d.update(v, DT), DT, () => 'asphalt')
      world.step()
      if (t > 40) for (const ty of v.tyres) tmax = Math.max(tmax, ty.temp)
      const sNow = axis[d.state.idx].distance_m
      if (prev > len * 0.75 && sNow < len * 0.25) {
        if (at1 === null) at1 = Math.max(...v.tyres.map((x) => x.wear))
        else return { lap: Math.max(...v.tyres.map((x) => x.wear)) - at1, tmax }
      }
      prev = sNow
    }
    return { lap: NaN, tmax }
  }
  const soft = perLap('soft')
  const medium = perLap('medium')
  const hard = perLap('hard')
  check('износ шин за круг: мягкие > средние > твёрдые', `${Math.round(soft.lap * 100)}% / ${Math.round(medium.lap * 100)}% / ${Math.round(hard.lap * 100)}% (самая нагруженная шина)`, soft.lap > medium.lap && medium.lap > hard.lap && medium.lap > 0.1 && medium.lap < 0.25)
  check('температура шин в разумных пределах', `до ${Math.round(medium.tmax)}° на средних`, medium.tmax > 90 && medium.tmax < 140)
  const worn = tyreGrip({ wear: 0.9, temp: 100, puncture: false }, 'medium')
  const fresh2 = tyreGrip({ wear: 0, temp: 100, puncture: false }, 'medium')
  const cold = tyreGrip({ wear: 0, temp: 60, puncture: false }, 'medium')
  check('стёртая и холодная шина держат хуже', `свежая ${fresh2.toFixed(2)}, стёртая на 90% ${worn.toFixed(2)}, холодная ${cold.toFixed(2)}`, worn < fresh2 * 0.85 && cold < fresh2)

  // 25. Удары: лобовой на 60 км/ч ломает переднее крыло (прижим спереди падает), лёгкий накат на 10 км/ч — нет
  const crash = (kmh) => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    world.timestep = DT
    const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0), g)
    world.createCollider(RAPIER.ColliderDesc.cuboid(20, 1, 0.5).setTranslation(0, 1, 12), g)
    const v = createVehicle(RAPIER, world, { y: 0.05 }, TUNING)
    v.body.setLinvel({ x: 0, y: 0, z: kmh / 3.6 }, true)
    const ev = new RAPIER.EventQueue(true)
    for (let t = 0; t < 3; t += DT) {
      stepVehicle(v, { throttle: kmh > 20 ? 0.3 : 0, brake: 0, steer: 0 }, DT, () => 'asphalt')
      world.step(ev)
      collectImpacts(ev)
    }
    return v.damage
  }
  const hit = crash(60)
  const tap = crash(10)
  check('удар носом на 60 км/ч ломает крыло, касание на 10 — нет', `крыло ${Math.round(Math.max(hit.wingL, hit.wingR) * 100)}% (прижим спереди ×${aeroDamage(hit).front.toFixed(2)}), касание ${Math.round(Math.max(tap.wingL, tap.wingR) * 100)}%`, Math.max(hit.wingL, hit.wingR) > 0.6 && Math.max(tap.wingL, tap.wingR) < 0.15)

  // 26. Пит-стоп на пит-лейне LUMEN RING. Бот: целиком на автомате — въезд с 220 км/ч, в зоне не больше 80,
  // точно в бокс, новые шины, выезд; в пит-лейне 25–35 с. Игрок: по пит-лейну едет сам (здесь «водитель» рулит
  // по пит-лейну и держит газ в пол — ограничитель не даёт больше 80), игра ставит в бокс, после газа — снова сам.
  const pitAxis = kids('Ось пит-лейна').map((n) => ({ x: P(n)[0], z: P(n)[2], ...n.extras })).sort((a, b) => a.distance_m - b.distance_m)
  const boxes = kids('Пит-боксы').map((n) => ({ x: P(n)[0], z: P(n)[2] }))
  const ex = (name) => json.nodes.find((n) => n.name === name).extras.distance_m
  const lane = createPitLane({ axis: pitAxis, boxes, limitStart: ex('Пит лимит начало'), limitEnd: ex('Пит лимит конец') })
  const pitRun = (player) => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    world.timestep = DT
    const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0), g)
    const v = createVehicle(RAPIER, world, { x: pitAxis[0].x - 80, y: 0.05, z: 0, yaw: Math.PI / 2 }, TUNING)
    v.body.setLinvel({ x: 61, y: 0, z: 0 }, true)
    v.compound = 'soft'
    v.tyres.forEach((t) => (t.wear = 0.6))
    const plan = { compound: 'medium', wing: false }
    const stop = createPitStop(lane, 11, plan, { player })
    const human = createPitStop(lane, 11, plan, {}) // руль «водителя»
    let err = null
    let vmax = 0
    const phases = new Set()
    for (let t = 0; t < 80 && stop.state.phase !== 'done' && stop.state.phase !== 'abort'; t += DT) {
      phases.add(stop.state.phase)
      const auto = stop.update(v, DT, stop.state.phase === 'release' && stop.state.t > 0.3)
      let inp = auto
      if (!inp) {
        if (stop.state.phase === 'free') human.state.phase = 'out'
        const h = human.update(v, DT)
        inp = pitLimiter(stop, v, { ...h, throttle: 1, brake: stop.state.s < lane.limitStart - 10 ? h.brake : 0 })
      }
      stepVehicle(v, inp, DT, () => 'asphalt')
      world.step()
      if (stop.inLimit) vmax = Math.max(vmax, v.state.speedKmh)
      if (stop.state.phase === 'service' && err === null) {
        const p = v.body.translation()
        err = Math.hypot(p.x - boxes[11].x, p.z - boxes[11].z)
      }
    }
    return { stop, v, err, vmax, phases: [...phases].join('→') }
  }
  {
    const r = pitRun(false)
    check('пит-стоп бота: бокс, шины, выезд', `промах ${r.err?.toFixed(2)} м, в зоне до ${r.vmax.toFixed(0)} км/ч, в пит-лейне ${r.stop.state.total.toFixed(1)} с, шины ${r.v.compound} износ ${Math.round(r.v.tyres[0].wear * 100)}%`, r.stop.state.phase === 'done' && r.err < 1.2 && r.vmax <= 81 && r.stop.state.total > 25 && r.stop.state.total < 35 && r.v.compound === 'medium' && r.v.tyres[0].wear < 0.05)
    const me = pitRun(true)
    check('пит-стоп игрока: едет сам, ограничитель, бокс', `фазы ${me.phases}, промах ${me.err?.toFixed(2)} м, в зоне до ${me.vmax.toFixed(0)} км/ч (газ в пол), шины ${me.v.compound}`, me.stop.state.phase === 'done' && me.phases.startsWith('lane→in→service→release→free') && me.err < 1.5 && me.vmax <= 84 && me.v.compound === 'medium')
    // ложный въезд: главная прямая идёт по +x на z≈0; край асфальта — 7 м, пит-лейн начинается дальше 11 м
    const falseHits = [0, 3, 6, 8, 9.5].filter((z) => [-250, -240, -230, -220, -210].some((x) => pitEntryHit(lane, x, z, Math.PI / 2))).length
    const realHit = pitEntryHit(lane, pitAxis[20].x, pitAxis[20].z, Math.PI / 2)
    check('въезд в пит-лейн только с дороги пит-лейна', `ложных срабатываний у края трассы ${falseHits}, на пит-лейне ${realHit ? 'въезд' : 'нет'}`, falseHits === 0 && realHit)
  }
}
// 27. Правило двух составов: без смены шин — дисквалификация, со сменой — нет
{
  const race = createRace(1000, [{ id: 'a', name: 'A', player: true, compound: 'medium' }, { id: 'b', name: 'B', compound: 'soft' }], 2)
  const pos = { a: 990, b: 995 }
  race.update(0, (c) => pos[c.id])
  race.go()
  race.pitStop('b', 'medium')
  for (let t = 0; t < 60; t += 0.05) {
    pos.a = (pos.a + 50 * 0.05) % 1000
    pos.b = (pos.b + 45 * 0.05) % 1000
    race.update(0.05, (c) => pos[c.id])
  }
  const a = race.car('a')
  const b = race.car('b')
  check('правило двух составов', `A (один состав) — ${a.dsq ? 'ДСК' : 'зачёт'}, B (сменил) — ${b.dsq ? 'ДСК' : 'зачёт'}, первым ${race.state.order[0].name}`, a.dsq && !b.dsq && race.state.order[0].id === 'b')
}

// 28. Случай из гонки Ромы (28.10): болид стоит на трассе, другой врезается на 150 км/ч — никого не уносит в небо
// (лучи подвески видят только трассу, а не соседний болид); бот перед стоящим не встаёт, а объезжает;
// «призрак» проходит сквозь болид
{
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0), g)
  const parked = createVehicle(RAPIER, world, { x: 0.6, y: 0.05, z: 60 }, TUNING)
  const hitter = createVehicle(RAPIER, world, { x: 0, y: 0.05, z: 0 }, TUNING)
  hitter.body.setLinvel({ x: 0, y: 0, z: 150 / 3.6 }, true)
  let top = 0
  for (let t = 0; t < 4; t += DT) {
    stepVehicle(parked, { throttle: 0, brake: 0, steer: 0, handbrake: true }, DT, () => 'asphalt')
    stepVehicle(hitter, { throttle: 1, brake: 0, steer: 0 }, DT, () => 'asphalt')
    world.step()
    top = Math.max(top, parked.body.translation().y, hitter.body.translation().y)
  }
  check('удар в стоящий болид не уносит в небо', `выше всего ${top.toFixed(2)} м`, top < 1.5)
}
{
  const w = fresh()
  const stopped = createVehicle(RAPIER, w.world, { x: 0, y: 0.05, z: 200, wear: false }, TUNING)
  const d = createAiDriver(createRaceLine(OVAL, 'hard'), { idx: 0 })
  run(w, NONE, 0.3)
  accelTo(w, 150)
  let minKmh = Infinity
  let passed = false
  for (let t = 0; t < 8; t += DT) {
    const sp = stopped.body.translation()
    stepVehicle(w.v, d.update(w.v, DT, [{ x: sp.x, z: sp.z, speed: 0 }]), DT, w.surfaceAt)
    stepVehicle(stopped, { throttle: 0, brake: 0, steer: 0, handbrake: true }, DT, () => 'asphalt')
    w.world.step()
    const p = w.v.body.translation()
    if (p.z < sp.z) minKmh = Math.min(minKmh, kmh(w))
    if (p.z > sp.z + 10) passed = true
  }
  check('бот объезжает стоящий болид, а не встаёт за ним', `объехал ${passed ? 'да' : 'нет'}, скорость не ниже ${minKmh.toFixed(0)} км/ч`, passed && minKmh > 60)
}
{
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0), g)
  const a = createVehicle(RAPIER, world, { x: 0, y: 0.05, z: 20, wear: false }, TUNING)
  const b = createVehicle(RAPIER, world, { x: 0, y: 0.05, z: 0, wear: false }, TUNING)
  setGhost(b, true)
  b.body.setLinvel({ x: 0, y: 0, z: 25 }, true)
  for (let t = 0; t < 2.5; t += DT) {
    stepVehicle(a, { throttle: 0, brake: 0, steer: 0, handbrake: true }, DT, () => 'asphalt')
    stepVehicle(b, { throttle: 0.5, brake: 0, steer: 0 }, DT, () => 'asphalt')
    world.step()
  }
  check('«призрак» проходит сквозь болид', `стоящий сдвинулся на ${Math.abs(a.body.translation().z - 20).toFixed(2)} м, призрак уехал на ${b.body.translation().z.toFixed(0)} м`, Math.abs(a.body.translation().z - 20) < 0.3 && b.body.translation().z > 40)
}

const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `\nНе прошло: ${failed.length} из ${results.length}` : `\nВсё прошло: ${results.length} проверок`)
process.exit(failed.length ? 1 : 0)
