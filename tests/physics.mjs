// Проверки физики болида без браузера: `npm test`.
// Каждое изменение физики или tuning.js — прогнать. Пороги взяты из реальных цифр F1 2022–25
// (Brembo, Mercedes, Formula1.com) и из жалоб на «ощущение руля», которые уже исправлены.
import fs from 'fs'
import RAPIER from '@dimforge/rapier3d-compat'
import { createVehicle, stepVehicle, collectImpacts, setGhost, STATIC_GROUPS } from '../src/vehicle.js'
import { TUNING } from '../src/tuning.js'
import * as THREE from 'three'
import { createStart } from '../src/start.js'
import { createRaceLine, createAiDriver, makePilots } from '../src/ai.js'
import { createRace } from '../src/race.js'
import { wheelsOut, createLimits } from '../src/limits.js'
import { tyreGrip, aeroDamage, suspDamageAt, freshDamage, repairSeconds, applyRepair, setFuel, fuelForRace, FUEL_PER_KM, wetGrip, updateBrakes, updateEngineHeat } from '../src/wear.js'
import { retireReason, mechanicalFlag, judgeContact, contactPenalty } from '../src/stewards.js'
import { createFlags, SC_SPEED, VSC_SPEED, RED_SPEED, RED_MAX } from '../src/flags.js'
import { createSafetyCar } from '../src/safetycar.js'
import { createTow } from '../src/tow.js'
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
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
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
  check('разгон 0–100 (с картой мотора)', t100, t100 !== null && t100 < 3.8, ' с')
  check('максимальная скорость (закрытые крылья)', kmh(w), kmh(w) > 305 && kmh(w) < 335, ' км/ч')
}

// 2b. Воздух и мотор держат болид (Рома 29.10: «где сопротивление воздуха, он просто летает»): сброс газа с 300 км/ч
// даёт замедление около 1 g, как у настоящего болида (сопротивление ~0,6 g + торможение мотором и ERS), с 100 — около 0,25 g;
// до 300 км/ч с места не быстрее 12 с и не дольше 16 с
{
  const coast = (k) => {
    const w = fresh()
    w.v.body.setLinvel({ x: 0, y: 0, z: k / 3.6 }, true)
    run(w, NONE, 0.3)
    const v0 = w.v.body.linvel().z
    run(w, NONE, 1)
    return (v0 - w.v.body.linvel().z) / 9.81
  }
  const g300 = coast(300)
  const g100 = coast(100)
  check('сброс газа: замедление от воздуха и мотора', `${g100.toFixed(2)} g со 100 км/ч, ${g300.toFixed(2)} g с 300 км/ч`, g300 > 0.8 && g300 < 1.1 && g100 > 0.18 && g100 < 0.35)
  const w = fresh()
  run(w, NONE, 0.5)
  let t300 = null
  run(w, { throttle: 1 }, 40, (t) => {
    if (t300 === null && kmh(w) >= 300) t300 = t
  })
  check('разгон 0–300 км/ч', t300, t300 !== null && t300 > 12 && t300 < 16, ' с')
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
import { measure as measurePreset, rates as presetRates } from '../tools/setup/presets.mjs'
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
// готовые настройки: оценки на карточках гаража (1–5) совпадают с замером (tools/setup/presets.mjs — та же физика)
{
  const bad = []
  const all = Object.entries(SETUP_PRESETS).map(([id, p]) => {
    const m = measurePreset(p.values)
    const r = presetRates(m)
    if (r.straight !== p.rate.straight || r.corners !== p.rate.corners || r.forgiving !== p.rate.forgiving) bad.push(`${p.name}: замер ${r.straight}/${r.corners}/${r.forgiving}, в карточке ${p.rate.straight}/${p.rate.corners}/${p.rate.forgiving}`)
    return `${p.name} ${m.top.toFixed(0)} км/ч, ${m.g200.toFixed(2)} g, занос ${m.trail.toFixed(1)}°`
  })
  check('готовые настройки: оценки совпадают с замером', bad.length ? bad.join('; ') : all.join(' · '), bad.length === 0)
}
// новые параметры настройки (30.10) — каждый что-то меняет
{
  // торможение мотором: сброс газа на 200 км/ч, замедление за 1 с
  const lift = (engineBraking) =>
    withSetup({ engineBraking }, () => {
      const w = fresh()
      run(w, NONE, 0.5)
      accelTo(w, 200)
      const v0 = kmh(w)
      run(w, NONE, 1)
      return v0 - kmh(w)
    })
  const lo = lift(0)
  const hi = lift(100)
  check('торможение мотором: 100% тормозит на сбросе сильнее 0%', `−${lo.toFixed(1)} против −${hi.toFixed(1)} км/ч за 1 с с 200`, hi > lo + 1.5)
  // угол поворота колёс: на 25 км/ч с рулём до упора радиус меньше при 30°, чем при 18°
  const radius = (steerLock) =>
    withSetup({ steerLock }, () => {
      const w = fresh()
      run(w, NONE, 0.5)
      accelTo(w, 25)
      run(w, () => ({ ...hold(w, 25), steer: 1 }), 3)
      const lv = w.v.body.linvel()
      return Math.hypot(lv.x, lv.z) / Math.abs(w.v.body.angvel().y)
    })
  const r18 = radius(18)
  const r30 = radius(30)
  check('угол поворота колёс: 30° — шпилька круче, чем 18°', `радиус ${r30.toFixed(1)} против ${r18.toFixed(1)} м на 25 км/ч`, r30 < r18 - 1)
  // амортизаторы: болид падает с 8 см — мягкие качаются дольше
  const bounce = (d) =>
    withSetup({ damperF: d, damperR: d }, () => {
      const w = fresh()
      run(w, NONE, 1)
      const p = w.v.body.translation()
      w.v.body.setTranslation({ x: p.x, y: p.y + 0.08, z: p.z }, true)
      const ys = []
      run(w, NONE, 1.5, () => ys.push(w.v.body.translation().y))
      const end = ys[ys.length - 1]
      return ys.reduce((a, y) => a + Math.abs(y - end), 0) / ys.length // средний размах качания вокруг конечного положения
    })
  const soft = bounce(1)
  const stiff = bounce(11)
  check('амортизаторы: мягкие гасят качание дольше жёстких', `средний размах ${(soft * 1000).toFixed(2)} против ${(stiff * 1000).toFixed(2)} мм`, soft > stiff)
  // охлаждение тормозов: горячие диски (800°) за 10 с на 180 км/ч без торможения
  const brakesAfter = (brakeDucts) => {
    const v = { T: { setup: { brakeDucts } }, damage: { brakes: 0 }, brakeTemp: [800, 800, 800, 800], wheels: [0, 1, 2, 3].map(() => ({ brakeP: 0 })) }
    for (let t = 0; t < 10; t += 0.05) updateBrakes(v, 0.05, 50)
    return v.brakeTemp[0]
  }
  const ductsClosed = brakesAfter(1)
  const ductsOpen = brakesAfter(6)
  check('охлаждение тормозов: открытые воздуховоды остужают диски быстрее', `${ductsClosed.toFixed(0)}° при 1 против ${ductsOpen.toFixed(0)}° при 6`, ductsOpen < ductsClosed - 80)
  // радиаторы: газ в пол на медленной трассе (25 м/с) минуту — закрытые греют мотор сильнее; открытые — тормозят воздухом
  const heatAfter = (radiator) => {
    const v = { T: { setup: { radiator } }, damage: freshDamage(), pu: { failed: false }, engineHeat: 0.5, hotTime: 0 }
    for (let t = 0; t < 60; t += 0.05) updateEngineHeat(v, 0.05, 1, 25)
    return v.engineHeat
  }
  const radClosed = heatAfter(1)
  const radOpen = heatAfter(6)
  const topRad = (radiator) =>
    withSetup({ radiator, brakeDucts: radiator }, () => {
      const w = fresh()
      run(w, NONE, 0.5)
      run(w, { throttle: 1 }, 40)
      return kmh(w)
    })
  const vClosed = topRad(1)
  const vOpen = topRad(6)
  check('охлаждение мотора: закрытые радиаторы греют (но не убивают), открытые тормозят воздухом', `нагрев ${radClosed.toFixed(2)} против ${radOpen.toFixed(2)} (смерть мотора — выше 1,15); максималка ${vClosed.toFixed(0)} против ${vOpen.toFixed(0)} км/ч`, radClosed > radOpen + 0.15 && radClosed < 1.12 && vClosed > vOpen + 3)
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
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
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
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
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
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
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
  check('бот в потоке: восемь со старта стоя, без ударов', `глубже всего ${(worstDeep * 100).toFixed(1)} см, касаются бортами до ${worstTouch.toFixed(2)} с, от оси до ${worstOff.toFixed(2)} м, обгонов ${passes}`, worstDeep < NEAR_TOUCH && worstTouch < 3 && worstOff < 6.05 && passes >= 3)
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

// 20i. Столкновения (Рома 29.10: «пружинятся, топорные»): корпус на высоте центра масс, трение и упругость корпуса минимальные,
// после удара ~0,5 с подскок, клевок и раскрутка гасятся. Стена — тонкая сетка без толщины, как «Ограждения» в модели трассы.
// wallDeg — на сколько стена повёрнута от лобового положения (0 — лоб, 70 — скользящий под ~20°)
function hitWall(kmhIn, wallDeg) {
  const world = newWorld()
  const a = (wallDeg * Math.PI) / 180
  const wall = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 200.5).setRotation({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }))
  const verts = new Float32Array([-300, 0, 0, 300, 0, 0, 300, 2, 0, -300, 2, 0])
  world.createCollider(RAPIER.ColliderDesc.trimesh(verts, new Uint32Array([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2])).setFriction(0.3).setRestitution(0.05).setCollisionGroups(STATIC_GROUPS), wall)
  const v = createVehicle(RAPIER, world, { x: 0, y: 0.05, z: 175, wear: false }, TUNING)
  v.body.setLinvel({ x: 0, y: 0, z: kmhIn / 3.6 }, true)
  let hit = false
  let tHit = 0
  let maxY = 0
  let maxYaw = 0
  let rebound = 0
  let after = 0
  const events = new RAPIER.EventQueue(true)
  for (let t = 0; t < 4; t += DT) {
    stepVehicle(v, NONE, DT, () => 'asphalt')
    const yawNow = Math.abs(v.body.angvel().y) // уже после «разгрузки» удара: один шаг решателя 4 мс раскрутки не в счёт
    world.step(events)
    collectImpacts(events)
    const lv = v.body.linvel()
    const sp = Math.hypot(lv.x, lv.z)
    if (!hit && sp < (kmhIn / 3.6) * 0.93) {
      hit = true
      tHit = t
    }
    if (hit) {
      maxY = Math.max(maxY, v.body.translation().y)
      maxYaw = Math.max(maxYaw, yawNow)
      rebound = Math.min(rebound, lv.z)
      if (Math.abs(t - tHit - 0.2) < DT / 2) after = sp * 3.6
    }
  }
  return { hit, maxY, maxYaw, rebound: -rebound * 3.6, after }
}
{
  const head = hitWall(250, 0)
  check('удар в стену в лоб на 250 км/ч: без подскока и отскока', `подскок ${(head.maxY * 100).toFixed(0)} см, отскок назад ${head.rebound.toFixed(0)} км/ч, вращение до ${head.maxYaw.toFixed(1)} рад/с`, head.hit && head.maxY < 0.05 && head.rebound < 10 && head.maxYaw <= 4.01)
  const glance = hitWall(250, 70)
  check('скользящий удар в стену под 20°: скользит вдоль, скорость не пропадает', `через 0,2 с ${glance.after.toFixed(0)} из 250 км/ч, вращение до ${glance.maxYaw.toFixed(1)} рад/с, подскок ${(glance.maxY * 100).toFixed(0)} см`, glance.hit && glance.after > 200 && glance.maxYaw <= 4.01 && glance.maxY < 0.05)
  const mid = hitWall(250, 40)
  check('удар в стену под 50°: без раскрутки волчком', `вращение до ${mid.maxYaw.toFixed(1)} рад/с, подскок ${(mid.maxY * 100).toFixed(0)} см`, mid.hit && mid.maxYaw <= 4.01 && mid.maxY < 0.08)
}
// болиды друг о друга: сзади с разницей 100 км/ч — не подпрыгивают и не разлетаются, дальше идут почти вместе
{
  const world = newWorld()
  const a = createVehicle(RAPIER, world, { x: 0, y: 0.05, z: 0, wear: false }, TUNING)
  const b = createVehicle(RAPIER, world, { x: 0, y: 0.05, z: 16, wear: false }, TUNING)
  a.body.setLinvel({ x: 0, y: 0, z: 160 / 3.6 }, true)
  b.body.setLinvel({ x: 0, y: 0, z: 60 / 3.6 }, true)
  let maxY = 0
  let maxW = 0
  const events2 = new RAPIER.EventQueue(true)
  for (let t = 0; t < 2; t += DT) {
    stepVehicle(a, NONE, DT, () => 'asphalt')
    stepVehicle(b, NONE, DT, () => 'asphalt')
    world.step(events2)
    collectImpacts(events2)
    for (const c of [a, b]) {
      maxY = Math.max(maxY, c.body.translation().y)
      maxW = Math.max(maxW, Math.hypot(c.body.angvel().x, c.body.angvel().y, c.body.angvel().z))
    }
  }
  const gap = Math.abs(a.body.linvel().z - b.body.linvel().z) * 3.6
  check('болид в болид сзади на 100 км/ч: не подпрыгивают', `подскок ${(maxY * 100).toFixed(0)} см, вращение до ${maxW.toFixed(1)} рад/с, разница скоростей после ${gap.toFixed(0)} км/ч`, maxY < 0.1 && maxW < 3 && gap < 20)
}

// болиды друг о друга (Рома 29.10: «столкновения с другими болидами — полное дерьмо»): после удара расходятся, а не слипаются;
// смещённый удар сзади не разворачивает волчком; бок о бок — касание и разошлись, без «склейки»
{
  const meet = ({ va, vb, xa = 0, zb = 16, lat = 0 }) => {
    const world = newWorld()
    const a = createVehicle(RAPIER, world, { x: xa, y: 0.05, z: 0, wear: false }, TUNING)
    const b = createVehicle(RAPIER, world, { x: 0, y: 0.05, z: zb, wear: false }, TUNING)
    a.body.setLinvel({ x: lat, y: 0, z: va / 3.6 }, true)
    b.body.setLinvel({ x: 0, y: 0, z: vb / 3.6 }, true)
    const ev = new RAPIER.EventQueue(true)
    let touch = 0
    for (let t = 0; t < 3; t += DT) {
      stepVehicle(a, NONE, DT, () => 'asphalt')
      stepVehicle(b, NONE, DT, () => 'asphalt')
      world.step(ev)
      collectImpacts(ev)
      if (a.impactT > 0 && b.impactT > 0) touch += DT
    }
    const la = a.body.linvel()
    const lb = b.body.linvel()
    return { rel: Math.hypot(la.x - lb.x, la.z - lb.z) * 3.6, yawA: Math.abs(deg(yawOf(a.body.rotation()))), yawB: Math.abs(deg(yawOf(b.body.rotation()))), gapX: Math.abs(a.body.translation().x - b.body.translation().x), touch }
  }
  const straight = meet({ va: 160, vb: 60 })
  check('болиды после удара сзади расходятся, а не слипаются', `разница скоростей после ${straight.rel.toFixed(0)} км/ч (упругость ${TUNING.carRestitution} от 100 → ~15)`, straight.rel > 5 && straight.rel < 30)
  const offset = meet({ va: 160, vb: 60, xa: 0.8 })
  check('смещённый удар сзади на 100 км/ч не разворачивает волчком', `курс после: ударивший ${offset.yawA.toFixed(0)}°, ударенный ${offset.yawB.toFixed(0)}°`, offset.yawA < 30 && offset.yawB < 30)
  const swipe = meet({ va: 220, vb: 220, xa: -1.5, zb: 0, lat: 1.5 })
  check('бок о бок: коснулись и разошлись, без склейки', `держатся ударом ${swipe.touch.toFixed(2)} с, разница скоростей ${swipe.rel.toFixed(1)} км/ч`, swipe.touch < 0.7 && swipe.rel < 3)
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
  check('боты на LUMEN RING: круг', `${hard.lap.toFixed(1)} / ${medium.lap.toFixed(1)} / ${light.lap.toFixed(1)} с (сложные / средние / лёгкие)`, hard.lap < medium.lap && medium.lap < light.lap && light.lap < 92 && hard.lap < 70.5)
  const worst = Math.max(hard.over, medium.over, light.over)
  check('боты на LUMEN RING не съезжают с асфальта', `запас до края ${(-worst).toFixed(2)} м`, worst < 0)
}

// 22b. Старт на настоящей решётке LUMEN RING (11 ботов, P1…P11, две колонны через 6 м): поле разгоняется вместе (последний до 100 км/ч
// не дольше чем за 3,6 с — лидер за 3 с), первые 6 с каждый держит свою полосу (не сбегается к линии в колонну), без ударов
{
  const glb = fs.readFileSync(new URL('../public/models/track.glb', import.meta.url))
  const json = JSON.parse(glb.slice(20, 20 + glb.readUInt32LE(12)).toString())
  const tpos = (n) => n.translation || [n.matrix[12], n.matrix[13], n.matrix[14]]
  const axis = json.nodes
    .find((n) => n.name === 'Ось трассы')
    .children.map((i) => {
      const n = json.nodes[i]
      const t = tpos(n)
      return { x: t[0], z: t[2], ...n.extras }
    })
    .sort((a, b) => a.distance_m - b.distance_m)
  const nearest = (p) => axis.reduce((b, a, i) => ((a.x - p.x) ** 2 + (a.z - p.z) ** 2 < b.d ? { i, d: (a.x - p.x) ** 2 + (a.z - p.z) ** 2 } : b), { i: 0, d: Infinity }).i
  const latOf = (p) => {
    const i = nearest(p)
    const a = axis[i]
    const b = axis[(i + 1) % axis.length]
    const tx = b.x - a.x
    const tz = b.z - a.z
    return ((p.x - a.x) * tz - (p.z - a.z) * tx) / Math.hypot(tx, tz)
  }
  const world = newWorld()
  let rs = 5
  const rand = () => (rs = (rs * 1664525 + 1013904223) % 4294967296) / 4294967296
  const pilots = makePilots(11, rand)
  const cars = []
  for (let slot = 0; slot < 11; slot++) {
    const n = json.nodes.find((q) => q.name === `Старт P${slot + 1}`)
    const t = tpos(n)
    const i = nearest({ x: t[0], z: t[2] })
    const yaw = Math.atan2(axis[(i + 1) % axis.length].x - axis[i].x, axis[(i + 1) % axis.length].z - axis[i].z)
    const v = createVehicle(RAPIER, world, { x: t[0], y: 0.05, z: t[2], yaw, wear: false }, TUNING)
    cars.push({ v, body: v.body, d: createAiDriver(createRaceLine(axis, 'medium', TUNING, pilots[slot]), { idx: i }), lane: latOf({ x: t[0], z: t[2] }), t100: null, drift: 0 })
  }
  let worstDeep = 0
  let touchSteps = 0
  for (let t = 0; t < 6.5; t += DT) {
    const ps = cars.map((c) => posOf(c.v))
    cars.forEach((c, i) => {
      const input = c.d.update(c.v, DT, ps.filter((_, j) => j !== i))
      stepVehicle(c.v, t < 0.5 ? { ...input, throttle: 0, brake: 0, boost: false } : input, DT, () => 'asphalt') // до 0,5 с — огни
      if (c.t100 === null && c.v.state.speedKmh >= 100) c.t100 = t - 0.5
    })
    world.step()
    const { deep, touching } = penetration(world, cars.map((c) => c.v))
    worstDeep = Math.max(worstDeep, deep)
    if (touching) touchSteps++
    if (Math.round(t / DT) % 24 === 0 && t > 1) for (const c of cars) c.drift = Math.max(c.drift, Math.abs(latOf(c.v.body.translation()) - c.lane))
  }
  const slowest = Math.max(...cars.map((c) => c.t100 ?? Infinity))
  const fastest = Math.min(...cars.map((c) => c.t100 ?? Infinity))
  const drift = Math.max(...cars.map((c) => c.drift))
  check('старт на решётке: поле разгоняется вместе', `до 100 км/ч: лидер ${fastest.toFixed(2)} с, последний ${slowest.toFixed(2)} с`, slowest < 3.6)
  check('старт на решётке: каждый держит свою полосу, без ударов', `за 6 с ушёл вбок не дальше ${drift.toFixed(2)} м, глубже всего ${(worstDeep * 100).toFixed(1)} см, касаются ${(touchSteps * DT).toFixed(2)} с`, drift < 1.2 && worstDeep < NEAR_TOUCH && touchSteps * DT < 1)
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
    world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
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

  // Руль, зажатый на упор (Рома 29.10: «держу A/D весь поворот»): передние шины не должны гореть втрое быстрее задних и лопаться за два круга.
  // Бот ведёт круг, но его руль превращён в «клавишу»: либо полный угол, либо ноль.
  const held = (shape) => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    world.timestep = DT
    const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
    const yaw = Math.atan2(axis[1].x - axis[0].x, axis[1].z - axis[0].z)
    const v = createVehicle(RAPIER, world, { x: axis[0].x, y: 0.05, z: axis[0].z, yaw }, TUNING)
    v.compound = 'soft'
    const d = createAiDriver(createRaceLine(axis, 'medium'), { idx: 0 })
    let prev = 0
    let laps = 0
    let tmax = 0
    for (let t = 0; t < 300 && laps < 2; t += DT) {
      const inp = { ...d.update(v, DT), abs: true }
      inp.steer = shape(inp.steer)
      stepVehicle(v, inp, DT, () => 'asphalt')
      world.step()
      for (const ty of v.tyres) tmax = Math.max(tmax, ty.temp)
      const sNow = axis[d.state.idx].distance_m
      if (prev > len * 0.75 && sNow < len * 0.25) laps++
      prev = sNow
    }
    const w = v.tyres.map((x) => x.wear)
    return { front: (w[0] + w[1]) / 2, rear: (w[2] + w[3]) / 2, max: Math.max(...w), tmax, punct: v.tyres.some((x) => x.puncture) }
  }
  const smooth = held((s) => s)
  const key = held((s) => (Math.abs(s) > 0.05 ? Math.sign(s) : 0))
  check('руль зажат на упор: передние не горят втрое быстрее задних, нет прокола за 2 круга', `перед ${Math.round(key.front * 100)}% / зад ${Math.round(key.rear * 100)}%, макс. ${Math.round(key.tmax)}° (плавный руль: перед ${Math.round(smooth.front * 100)}%, зад ${Math.round(smooth.rear * 100)}%)`, !key.punct && key.front < key.rear * 1.6 && key.max < smooth.max * 2 && key.tmax < 130)

  // 25. Удары: лобовой на 60 км/ч ломает переднее крыло (прижим спереди падает), лёгкий накат на 10 км/ч — нет
  const crash = (kmh) => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    world.timestep = DT
    const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
    world.createCollider(RAPIER.ColliderDesc.cuboid(20, 1, 0.5).setTranslation(0, 1, 12).setCollisionGroups(STATIC_GROUPS), g)
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

  // Повреждённая подвеска (Рома 29.10: «что происходит, когда ломаются палки… и не так сильно уводить»): помятая слегка тянет в сторону,
// сломанная проседает и уводит заметнее, но не разворачивает болид; шины повреждённой стороны стираются быстрее
{
  const drive = (d, kmh) => {
    const w = fresh()
    run(w, NONE, 1)
    w.v.damage.suspL = d
    w.v.body.setLinvel({ x: 0, y: 0, z: kmh / 3.6 }, true)
    let c = 0
    run(w, () => ({ throttle: kmh > 150 ? 0.4 : 0.2 }), 4, () => (c = Math.max(c, w.v.wheels[0].compression)))
    return { yaw: Math.abs(deg(yawOf(w.v.body.rotation()))), side: Math.abs(w.v.body.translation().x), c }
  }
  const ok = drive(0, 200)
  const bent = drive(0.3, 200)
  const broke = drive(1, 200)
  check('подвеска слева: помятая (30%) почти не уводит, сломанная (100%) уводит мягко и проседает', `помятая: курс ${bent.yaw.toFixed(1)}°, ${bent.side.toFixed(0)} м; сломанная: курс ${broke.yaw.toFixed(1)}°, ${broke.side.toFixed(0)} м, перед сжат на ${((broke.c - ok.c) * 100).toFixed(1)} см больше (за 4 с на 200 км/ч)`, ok.yaw < 0.5 && bent.yaw < 4 && broke.yaw < 18 && broke.yaw > bent.yaw && broke.c - ok.c > 0.01)
  const dmg = { suspL: 1, suspR: 0 }
  check('сломанная подвеска: перед сильнее заднего, шина стирается быстрее', `перед ${suspDamageAt(dmg, true, 1)}, зад ${suspDamageAt(dmg, false, 1)}, другая сторона ${suspDamageAt(dmg, true, -1)}`, suspDamageAt(dmg, true, 1) === 1 && suspDamageAt(dmg, false, 1) === 0.5 && suspDamageAt(dmg, true, -1) === 0)
}

// Повреждения как в Формуле-1 (Рома 29.10: «врезаюсь спокойненько и доезжаю до пит-стопа — надо жёстче наказывать»): каждая часть ломается по-своему,
// сильный удар разрушает болид (сход), разбитый бокпод перегревает и убивает мотор, виноватому в столкновении штраф, в боксах чинят только кузов
{
  const wall = (kmh, yaw = 0) => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    world.timestep = DT
    const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
    world.createCollider(RAPIER.ColliderDesc.cuboid(20, 1, 0.5).setTranslation(0, 1, 12).setCollisionGroups(STATIC_GROUPS), g)
    const v = createVehicle(RAPIER, world, { y: 0.05, yaw }, TUNING)
    v.body.setLinvel({ x: 0, y: 0, z: kmh / 3.6 }, true)
    const ev = new RAPIER.EventQueue(true)
    for (let t = 0; t < 3; t += DT) {
      stepVehicle(v, { throttle: 0.3, brake: 0, steer: 0 }, DT, () => 'asphalt')
      world.step(ev)
      collectImpacts(ev, () => {})
    }
    return v
  }
  const tap = wall(25)
  const mid = wall(80)
  const big = wall(180)
  check('удар в стену: на 25 км/ч — крыло помято, едешь; на 80 — крыло снесено и флаг в боксы; на 180 — монокок разрушен, сход', `25: крыло ${Math.round(Math.max(tap.damage.wingL, tap.damage.wingR) * 100)}%, флаг ${mechanicalFlag(tap) ? 'да' : 'нет'}, сход ${retireReason(tap) ? 'да' : 'нет'}; 80: крыло ${Math.round(Math.max(mid.damage.wingL, mid.damage.wingR) * 100)}%, флаг «${mechanicalFlag(mid)}», сход ${retireReason(mid) ? 'да' : 'нет'}; 180: монокок ${Math.round(big.damage.chassis * 100)}%, ${retireReason(big)}`, !retireReason(tap) && !mechanicalFlag(tap) && Math.max(tap.damage.wingL, tap.damage.wingR) > 0.1 && !retireReason(mid) && !!mechanicalFlag(mid) && retireReason(big) === 'Монокок разрушен')
  const side = wall(150, Math.PI / 2)
  check('удар боком на 150 км/ч: бокпод и подвеска разбиты, оторвано колесо, сход', `бокпод ${Math.round(Math.max(side.damage.sideL, side.damage.sideR) * 100)}%, подвеска ${Math.round(Math.max(side.damage.suspL, side.damage.suspR) * 100)}%, колёса [${side.damage.lost}], ${retireReason(side)}`, retireReason(side) === 'Оторвано колесо' && side.damage.lost.some(Boolean))
  const rear = wall(80, Math.PI)
  check('удар в корму на 80 км/ч: заднее крыло снесено, коробка передач повреждена', `заднее крыло ${Math.round(rear.damage.rearWing * 100)}%, коробка ${Math.round(rear.pu.gearbox * 100)}%`, rear.damage.rearWing > 0.9 && rear.pu.gearbox > 0.2)

  // перегрев: целый болид держит полный газ на скорости, с разбитым бокподом мотор умирает
  const heatRun = (podDamage) => {
    // с износом и поломками (wear: true), иначе нагрев мотора не считается
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    world.timestep = DT
    const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
    const w = { world, v: createVehicle(RAPIER, world, { y: 0.05 }, TUNING), surfaceAt: () => 'asphalt' }
    run(w, NONE, 1)
    w.v.damage.sideL = podDamage
    w.v.body.setLinvel({ x: 0, y: 0, z: 70 }, true)
    let diedAt = null
    run(w, { throttle: 1 }, 90, (t) => {
      if (diedAt === null && w.v.pu.failed) diedAt = t
    })
    return { heat: w.v.engineHeat, diedAt }
  }
  const cool = heatRun(0)
  const hot = heatRun(0.9)
  check('разбитый бокпод перегревает мотор: целый держит полный газ, с повреждением 90% мотор умирает', `целый: нагрев ${cool.heat.toFixed(2)}, ${cool.diedAt === null ? 'жив' : 'умер'}; бокпод 90%: ${hot.diedAt === null ? 'жив' : 'мотор умер через ' + hot.diedAt.toFixed(0) + ' с'}`, cool.diedAt === null && cool.heat < 0.9 && hot.diedAt !== null && hot.diedAt < 60)

  // стюарды: виноват тот, кто въехал в корму; бок о бок и касание без штрафа
  const pair = (gapZ, vA, vB, yawB = 0) => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    world.timestep = DT
    const a = createVehicle(RAPIER, world, { x: 0, y: 0.05, z: 0 }, TUNING)
    const b = createVehicle(RAPIER, world, { x: 0, y: 0.05, z: gapZ, yaw: yawB }, TUNING)
    a.body.setLinvel({ x: 0, y: 0, z: vA / 3.6 }, true)
    b.body.setLinvel({ x: 0, y: 0, z: vB / 3.6 }, true)
    a.prevVel = { x: 0, y: 0, z: vA / 3.6 }
    b.prevVel = { x: 0, y: 0, z: vB / 3.6 }
    return { a, b }
  }
  const hit = pair(6, 160, 60)
  const j1 = judgeContact(hit.a, hit.b)
  const j2 = judgeContact(hit.b, hit.a)
  check('стюарды: виноват тот, кто въехал в корму; штраф по скорости сближения', `сзади на 100 км/ч быстрее: виноват ${j1.fault === hit.a ? 'задний' : j1.fault === hit.b ? 'передний' : 'никто'} (то же при обратном порядке: ${j2.fault === hit.a ? 'задний' : j2.fault === hit.b ? 'передний' : 'никто'}), сближение ${j1.closing.toFixed(0)} м/с → штраф ${contactPenalty(j1.closing)} с; касание 3 м/с → ${contactPenalty(3)} с; 8 м/с → ${contactPenalty(8)} с`, j1.fault === hit.a && j2.fault === hit.a && contactPenalty(j1.closing) === 10 && contactPenalty(3) === 0 && contactPenalty(8) === 5)
  const eq = pair(6, 120, 120)
  check('стюарды: едут рядом с одной скоростью — виноватых нет', `виноват ${judgeContact(eq.a, eq.b).fault ? 'кто-то' : 'никто'}`, !judgeContact(eq.a, eq.b).fault)

  // ремонт: время стоянки растёт с повреждением, чинятся крылья, днище, бокподы и тормозные каналы; подвеска и монокок нет
  const dmg = freshDamage()
  const t0 = repairSeconds(dmg)
  dmg.wingL = 0.9
  dmg.rearWing = 0.5
  dmg.floor = 0.4
  dmg.suspL = 0.8
  dmg.chassis = 0.3
  const tw = repairSeconds(dmg)
  const fake = { damage: dmg }
  applyRepair(fake)
  check('ремонт в боксах: чем больше сломано, тем дольше; подвеску и монокок не чинят', `целый ${t0} с, крылья и днище ${tw} с; после ремонта крыло ${dmg.wingL}, подвеска ${dmg.suspL}, монокок ${dmg.chassis}`, t0 === 0 && tw >= 20 && dmg.wingL === 0 && dmg.rearWing === 0 && dmg.floor === 0 && dmg.suspL === 0.8 && dmg.chassis === 0.3)
}

// Флаги и машина безопасности (flags.js): остановившийся на асфальте болид — SC, у трассы — VSC, два на асфальте — красный; обгон под флагом запрещён,
// эвакуатор выезжает через несколько секунд, после уборки — ещё немного нейтрализации, потом зелёный
{
  const L = 2000
  const axisS = Array.from({ length: 1000 }, (_, i) => ({ x: 0, z: i * 2, yaw: 0, distance_m: i * 2, width_left: 8, width_right: 8 }))
  const run2 = (cars, secs, f) => {
    const ev = []
    for (let t = 0; t < secs; t += 0.25) ev.push(...f.update(0.25, cars))
    return ev
  }
  const car = (id, x, z, extra = {}) => ({ id, x, z, speed: 0, retired: true, inPit: false, ...extra })
  // на асфальте: инцидент → машина безопасности → эвакуатор → уборка → конец → зелёный
  const f1 = createFlags(axisS, L)
  const ev1 = run2([car('a', 1, 800)], 8, f1)
  const sc = ev1.find((e) => e.type === 'sc')
  const tow1 = ev1.find((e) => e.type === 'tow')
  f1.clear('a')
  const ev1b = run2([], 30, f1)
  check('болид остановился на асфальте: машина безопасности, эвакуатор, после уборки зелёный флаг', `инцидент ${ev1.some((e) => e.type === 'incident') ? 'да' : 'нет'}, SC ${sc ? 'да' : 'нет'}, эвакуатор ${tow1 ? 'да' : 'нет'}, после уборки зелёный ${ev1b.some((e) => e.type === 'green') ? 'да' : 'нет'}, режим ${f1.mode}`, !!sc && !!tow1 && ev1b.some((e) => e.type === 'green') && f1.mode === 'green')
  // скорость и жёлтый участок
  const f2 = createFlags(axisS, L)
  run2([car('a', 1, 800)], 6, f2)
  check('под машиной безопасности: потолок скорости, колонна смыкается, жёлтый участок и запрет обгона', `лидер ${(f2.cap(700, 0) * 3.6).toFixed(0)} км/ч, отставший на 100 м ${(f2.cap(700, 100) * 3.6).toFixed(0)} км/ч, жёлтый за 100 м до болида: ${f2.inYellow(700)}, за 400 м: ${f2.inYellow(400)}, через 30 м после: ${f2.inYellow(830)}, через 100 м после: ${f2.inYellow(900)}`, f2.mode === 'sc' && Math.abs(f2.cap(700, 0) - SC_SPEED) < 1e-9 && f2.cap(700, 100) > f2.cap(700, 0) && f2.inYellow(700) && !f2.inYellow(400) && f2.inYellow(830) && !f2.inYellow(900) && f2.noPass(400))
  // у трассы — только VSC
  const f3 = createFlags(axisS, L)
  const ev3 = run2([car('a', 20, 800)], 8, f3)
  check('болид остановился у трассы: виртуальная машина безопасности, не SC', `режим ${f3.mode}, лимит ${(f3.cap(100) * 3.6).toFixed(0)} км/ч`, f3.mode === 'vsc' && Math.abs(f3.cap(100) - VSC_SPEED) < 1e-9 && !ev3.some((e) => e.type === 'sc'))
  // два на асфальте — красный флаг: едут в боксы, там ждут, потом старт с места (событие restart) и зелёный
  const f4 = createFlags(axisS, L)
  const ev4 = run2([car('a', 1, 800), car('b', -2, 1200)], 8, f4)
  const redNow = f4.mode === 'red' && Math.abs(f4.cap(0) - RED_SPEED) < 1e-9 && f4.noPass(0)
  // едут по трассе — флаг держится (до RED_MAX)
  const driving = [car('a', 1, 800), car('b', -2, 1200), { id: 'p', x: 0, z: 100, speed: 25, retired: false, inPit: false }]
  const ev4a = run2(driving, 60, f4)
  const stillRed = f4.mode === 'red' && !ev4a.some((e) => e.type === 'restart') && f4.redInfo().left === null
  // все встали в боксах — отсчёт, потом старт
  const parked = [car('a', 1, 800), car('b', -2, 1200), { id: 'p', x: 0, z: 100, speed: 0, retired: false, inPit: true }]
  const ev4b = run2(parked, 10, f4)
  const counting = f4.redInfo()?.allIn && f4.redInfo().left > 0
  const ev4c = run2(parked, 20, f4)
  const restart = ev4c.find((e) => e.type === 'restart')
  check('два болида на асфальте: красный флаг — все в боксы, ждём, потом старт с места', `красный ${redNow ? 'да, едут не быстрее ' + (RED_SPEED * 3.6).toFixed(0) + ' км/ч' : 'нет'}, пока едут — флаг ${stillRed ? 'держится' : 'снят'}, встали — ${counting ? 'отсчёт' : 'нет отсчёта'}, старт ${restart ? 'да' : 'нет'}, трасса ${ev4c.some((e) => e.type === 'clear-all') ? 'очищена' : 'не очищена'}, режим ${f4.mode}`, redNow && stillRed && counting && !!restart && ev4c.some((e) => e.type === 'clear-all') && f4.mode === 'green')
  // не дождались остальных за RED_MAX — всё равно старт
  const f4b = createFlags(axisS, L)
  run2([car('a', 1, 800), car('b', -2, 1200)], 8, f4b)
  const ev4d = run2(driving, RED_MAX + 5, f4b)
  check('красный флаг: не дождались всех — старт через RED_MAX', `старт ${ev4d.some((e) => e.type === 'restart') ? 'да' : 'нет'}`, ev4d.some((e) => e.type === 'restart'))
  // с машиной безопасности зелёный флаг — только когда она зашла в боксы
  const f6 = createFlags(axisS, L, { safetyCar: true })
  run2([car('a', 1, 800)], 6, f6)
  f6.clear('a')
  const ev6 = run2([], 60, f6)
  const stillSc = f6.mode === 'sc' && f6.ending()
  f6.scHome()
  const ev6b = run2([], 2, f6)
  check('зелёный флаг ждёт машину безопасности: пока на трассе — SC, зашла в боксы — зелёный', `через 60 с ${stillSc ? 'ещё SC' : f6.mode}, после захода ${ev6b.some((e) => e.type === 'green') ? 'зелёный' : 'нет'}`, stillSc && !ev6.some((e) => e.type === 'green') && ev6b.some((e) => e.type === 'green'))
  // лидер не может догнать машину безопасности
  const capFar = f2.cap(700, 0, { gap: 300, speed: 38 })
  const capNear = f2.cap(700, 0, { gap: 20, speed: 38 })
  check('лидер под SC: далеко — потолок SC, близко к ней — медленнее', `далеко ${(capFar * 3.6).toFixed(0)} км/ч, в 20 м ${(capNear * 3.6).toFixed(0)} км/ч`, Math.abs(capFar - SC_SPEED) < 1e-9 && capNear < SC_SPEED - 3)
  // настоящая машина безопасности (safetycar.js): выезжает, встаёт перед лидером и держит зазор, в конце уходит в боксы
  {
    const scene = { add() {} }
    const fakeLane = { axis: [{ x: 12, z: 1500 }, { x: 12, z: 1700 }], n: 2 }
    const simSc = (leader0, endAt) => {
      const sc = createSafetyCar(scene, axisS, L, fakeLane)
      let leader = leader0
      sc.deploy(leader)
      const phases = new Set()
      let minGap = Infinity
      let home = false
      let ended = false
      const cap = createFlags(axisS, L)
      for (let t = 0; t < 400 && !home; t += 0.05) {
        const gap = sc.gapFrom(leader)
        // лидер едет с потолком SC (как flags.cap с параметром sc)
        const v = gap === null ? SC_SPEED : cap.cap(0, 0, { gap, speed: sc.speed }) || 0
        const vv = gap === null ? SC_SPEED : Math.min(SC_SPEED, sc.speed + (gap - 35) * 0.35)
        leader = (leader + Math.max(0, vv) * 0.05) % L
        ended = ended || t > endAt
        home = sc.update(0.05, leader, ended)
        phases.add(sc.state.phase)
        if (gap !== null && t > 30 && !ended) minGap = Math.min(minGap, gap)
      }
      return { sc, phases: [...phases].join('→'), minGap, gap: sc.gapFrom(leader), home }
    }
    const a1 = simSc(1000, 120)
    check('машина безопасности: ждёт лидера впереди, держит ~60 м, потом уходит в боксы', `фазы ${a1.phases}, самый малый зазор ${a1.minGap.toFixed(0)} м, зашла в боксы ${a1.home ? 'да' : 'нет'}`, a1.home && a1.minGap > 25 && a1.minGap < 120 && a1.phases.includes('lead') && /in|leave/.test(a1.phases))
    // выезд из пит-лейна позади лидера — не догоняет полкруга, а сразу встаёт перед ним (Рома 30.10)
    const a2 = simSc(1800, 150)
    const g0 = (() => {
      const sc = createSafetyCar(scene, axisS, L, fakeLane)
      sc.deploy(1800)
      return sc.gapFrom(1800)
    })()
    check('машина безопасности при выезде позади лидера сразу встаёт перед ним', `зазор при выезде ${g0?.toFixed(0)} м, фазы ${a2.phases}, самый малый зазор ${a2.minGap.toFixed(0)} м`, g0 > 100 && g0 < 200 && a2.phases.startsWith('lead') && a2.minGap > 25 && a2.home)
  }

  // эвакуатор с краном (tow.js): грузовик встаёт бортом, стрела поднимает болид над землёй и кладёт на платформу, увозит
  {
    const added = []
    const scene = { add: (o) => added.push(o), remove() {} }
    const tow = createTow(scene, axisS, L)
    const obj = new THREE.Object3D()
    obj.position.set(3, 0.3, 800)
    const rest = obj.position.clone()
    let lifted = false
    let loaded = false
    let done = false
    const job = tow.dispatch({ id: 'a', s: 800, l: 3 }, { object: () => obj, lift: () => (lifted = true), loaded: () => (loaded = true), done: () => (done = true) })
    let maxUp = 0
    let underHook = Infinity
    let onBed = null
    const phases = []
    const hookW = new THREE.Vector3()
    for (let t = 0; t < 120 && !done; t += 0.05) {
      tow.update(0.05)
      if (phases[phases.length - 1] !== job.phase) phases.push(job.phase)
      if (lifted && job.phase === 'lift') maxUp = Math.max(maxUp, obj.position.y - rest.y)
      if (job.phase === 'lift' && job.t > 1.2) {
        job.mesh.userData.hook.getWorldPosition(hookW)
        underHook = Math.min(underHook, Math.hypot(hookW.x - obj.position.x, hookW.z - obj.position.z))
      }
      if (job.phase === 'leave' && job.t > 0.2 && !onBed) onBed = job.mesh.worldToLocal(obj.position.clone())
    }
    check('эвакуатор с краном: стрела над болидом, подъём, платформа, увозит', `фазы ${phases.join('→')}, поднят на ${maxUp.toFixed(1)} м, крюк над болидом (отклонение ${underHook.toFixed(2)} м), на платформе (${onBed?.x.toFixed(1)}, ${onBed?.y.toFixed(1)}, ${onBed?.z.toFixed(1)}), закреплён ${loaded ? 'да' : 'нет'}, уехал ${done ? 'да' : 'нет'}`, lifted && loaded && done && maxUp > 1.9 && underHook < 0.5 && onBed && Math.abs(onBed.x) < 0.2 && onBed.y > 1.4 && onBed.y < 1.8 && Math.abs(onBed.z + 2.6) < 0.2 && phases.join('→') === 'go→swing→lower→lift→carry→set→strap→leave')
  }

  // перестановка на решётку после красного флага: у всех один круг, порядок сохраняется, линия старта не считается лишней
  {
    const r = createRace(2000, [{ id: 'a' }, { id: 'b' }, { id: 'c', dnf: true }], 5)
    const pos = { a: 500, b: 1500, c: 300 }
    r.state.cars[0].lap = 2
    r.state.cars[1].lap = 3
    r.state.cars[2].dnf = true
    r.update(0.1, (c) => pos[c.id])
    const lead = r.state.order[0]
    r.regrid(lead.lap)
    // болиды на решётке перед линией; несколько кадров расстояние ещё старое, потом настоящее
    const grid = { a: 1990, b: 1980, c: 300 }
    for (let k = 0; k < 8; k++) r.update(0.1, (c) => (k < 2 ? pos[c.id] : grid[c.id]))
    const la = r.car('a').lap
    const lb = r.car('b').lap
    // b стоял впереди — на решётке впереди (1990), a — вторым (1980): кадр за линию — круг добавляется один раз
    r.update(0.1, (c) => (c.id === 'b' ? 20 : grid[c.id]))
    check('после красного флага: один круг у всех, пересечение линии — +1', `a ${la}, b ${lb}, после линии b ${r.car('b').lap}`, la === 3 && lb === 3 && r.car('b').lap === 4)
  }

  // болид в боксах, едущий или ненадолго вставший несошедший — не инцидент
  const f5 = createFlags(axisS, L)
  const ev5 = run2([car('a', 1, 800, { inPit: true }), car('b', 1, 900, { retired: false, speed: 20 }), car('c', 1, 1000, { retired: false, speed: 0 })], 4, f5)
  check('стоящий в боксах, едущий и вставший на 4 с болид не вызывают флаги', `событий ${ev5.length}`, ev5.length === 0 && f5.mode === 'green')
  // несошедший болид стоит на трассе дольше 5 с (развернуло, упёрся) — инцидент и машина безопасности, без эвакуатора; поехал — снят
  {
    const fs = createFlags(axisS, L)
    const stuck = car('s', 1, 800, { retired: false, speed: 0 })
    const evs = run2([stuck], 10, fs)
    const live = fs.incidents[0]
    stuck.speed = 20
    run2([stuck], 1, fs)
    check('несошедший болид стоит на трассе 10 с: SC без эвакуатора, поехал — инцидент снят', `${evs.map((e) => e.type).join(', ')}; снят: ${live?.cleared}`, evs.some((e) => e.type === 'sc') && !evs.some((e) => e.type === 'tow') && live?.live && live.cleared)
  }
}

// 26. Пит-стоп на пит-лейне LUMEN RING. Бот: целиком на автомате — въезд с 220 км/ч, в зоне не больше 80,
  // точно в бокс, новые шины, выезд; в пит-лейне 25–35 с. Игрок: по пит-лейну едет сам (здесь «водитель» рулит
  // по пит-лейну и держит газ в пол — ограничитель не даёт больше 80), игра ставит в бокс, после газа — снова сам.
  const pitAxis = kids('Ось пит-лейна').map((n) => ({ x: P(n)[0], z: P(n)[2], ...n.extras })).sort((a, b) => a.distance_m - b.distance_m)
  const boxes = kids('Пит-боксы').map((n) => ({ x: P(n)[0], z: P(n)[2] }))
  const ex = (name) => json.nodes.find((n) => n.name === name).extras.distance_m
  const lane = createPitLane({ axis: pitAxis, boxes, limitStart: ex('Пит лимит начало'), limitEnd: ex('Пит лимит конец') })
  const pitRun = (player, auto = false) => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    world.timestep = DT
    const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
    const v = createVehicle(RAPIER, world, { x: pitAxis[0].x - 80, y: 0.05, z: 0, yaw: Math.PI / 2 }, TUNING)
    v.body.setLinvel({ x: 61, y: 0, z: 0 }, true)
    v.compound = 'soft'
    v.tyres.forEach((t) => (t.wear = 0.6))
    const plan = { compound: 'medium', wing: false }
    const stop = createPitStop(lane, 11, plan, { player, auto })
    const human = createPitStop(lane, 11, plan, {}) // руль «водителя»
    let err = null
    let vmax = 0
    let p0 = null // где встал, когда начали обслуживать: за время стоянки болид не должен сдвинуться
    let drift = 0
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
      if (stop.state.phase === 'service' || stop.state.phase === 'release') {
        const p = v.body.translation()
        p0 = p0 || { x: p.x, z: p.z }
        drift = Math.max(drift, Math.hypot(p.x - p0.x, p.z - p0.z))
      }
    }
    return { stop, v, err, vmax, drift, phases: [...phases].join('→') }
  }
  {
    const r = pitRun(false)
    check('пит-стоп бота: бокс, шины, выезд', `промах ${r.err?.toFixed(2)} м, в зоне до ${r.vmax.toFixed(0)} км/ч, в пит-лейне ${r.stop.state.total.toFixed(1)} с, шины ${r.v.compound} износ ${Math.round(r.v.tyres[0].wear * 100)}%`, r.stop.state.phase === 'done' && r.err < 1.2 && r.vmax <= 81 && r.stop.state.total > 25 && r.stop.state.total < 35 && r.v.compound === 'medium' && r.v.tyres[0].wear < 0.05)
    const me = pitRun(true)
    check('пит-стоп игрока: едет сам, ограничитель, бокс', `фазы ${me.phases}, промах ${me.err?.toFixed(2)} м, в зоне до ${me.vmax.toFixed(0)} км/ч (газ в пол), шины ${me.v.compound}`, me.stop.state.phase === 'done' && me.phases.startsWith('lane→in→service→release→free') && me.err < 1.5 && me.vmax <= 84 && me.v.compound === 'medium')
    // автопилот игрока (Рома 29.10: «на пит-стопе можно отдохнуть»): весь пит-лейн сам, выпуск без газа, управление
    // возвращается у конца ограничителя; за время стоянки болид стоит на месте (раньше тормоз включал задний ход)
    const auto = pitRun(true, true)
    check('пит-стоп игрока на автопилоте: весь пит-лейн сам', `фазы ${auto.phases}, промах ${auto.err?.toFixed(2)} м, в зоне до ${auto.vmax.toFixed(0)} км/ч, сдвиг за стоянку ${(auto.drift * 100).toFixed(1)} см, ${auto.stop.state.total.toFixed(1)} с, шины ${auto.v.compound}`, auto.stop.state.phase === 'done' && auto.phases === 'in→service→release→out' && auto.err < 1.5 && auto.vmax <= 82 && auto.drift < 0.05 && auto.v.compound === 'medium' && auto.stop.state.total < 40)
    check('в боксе болид не едет назад (бот)', `сдвиг за стоянку ${(r.drift * 100).toFixed(1)} см`, r.drift < 0.05)
    // тормоз на месте: с hold держит, без hold включает задний ход (так игрок сдаёт назад клавишей S)
    const idle = (inp) => {
      const w = fresh()
      run(w, NONE, 1)
      const z0 = w.v.body.translation().z
      run(w, inp, 5)
      return w.v.body.translation().z - z0
    }
    const rolled = idle({ brake: 1 })
    const held = idle({ brake: 1, hold: true })
    check('тормоз с hold держит на месте, без hold — задний ход', `с hold ${(held * 100).toFixed(1)} см, без hold ${rolled.toFixed(1)} м`, Math.abs(held) < 0.05 && rolled < -5)
    // границы трассы не считаются в пит-лейне и на его въезде/выезде, но считаются на самой трассе и у её обочины, пока пит-лейн идёт параллельно
    const inLane = pitAxis.every((p) => lane.near(p.x, p.z, 4))
    const beside = pitAxis.filter((p) => p.distance_m > 130 && p.distance_m < 390).filter((p, i) => i % 6 === 0).filter((p) => lane.near(p.x, 0, 4) || lane.near(p.x, 8, 4) || lane.near(p.x, -8, 4)).length
    check('пит-лейн не считается выездом за границы трассы', `вся ось внутри: ${inLane}, точек трассы и её обочины, ошибочно принятых за пит-лейн: ${beside}`, inLane && beside === 0)
    // ложный въезд: главная прямая идёт по +x на z≈0; край асфальта — 7 м, пит-лейн начинается дальше 11 м
    const falseHits = [0, 3, 6, 8, 9.5].filter((z) => [-250, -240, -230, -220, -210].some((x) => pitEntryHit(lane, x, z, Math.PI / 2))).length
    const realHit = pitEntryHit(lane, pitAxis[20].x, pitAxis[20].z, Math.PI / 2)
    check('въезд в пит-лейн только с дороги пит-лейна', `ложных срабатываний у края трассы ${falseHits}, на пит-лейне ${realHit ? 'въезд' : 'нет'}`, falseHits === 0 && realHit)
  }
}
// 26б. Автопилот пит-стопа: разбитый болид (оторвано колесо, подвеска и крыло сломаны, прокол) едет как целый, повреждения не исчезают
{
  const wreck = (auto) => {
    const w = fresh()
    w.v.wearOn = true
    const d = w.v.damage
    d.lost[0] = 1
    d.suspL = 1
    d.wingL = d.wingR = 1
    w.v.tyres[1].puncture = true
    w.v.autopilot = auto
    let maxDev = 0
    run(w, { throttle: 0.6 }, 4, () => (maxDev = Math.max(maxDev, Math.abs(w.v.body.translation().x))))
    return { kmh: kmh(w), dev: maxDev, kept: d.lost[0] === 1 && d.suspL === 1 && w.v.tyres[1].puncture }
  }
  const off = wreck(false)
  const on = wreck(true)
  check('автопилот пит-стопа: разбитый болид едет как целый, повреждения остаются', `без автопилота ${off.kmh.toFixed(0)} км/ч и ${off.dev.toFixed(1)} м вбок, с ним ${on.kmh.toFixed(0)} км/ч и ${on.dev.toFixed(2)} м, повреждения ${on.kept ? 'на месте' : 'пропали'}`, on.dev < 0.3 && on.kmh > off.kmh && on.kept)
}
// 27. Правило двух составов: без смены шин — дисквалификация, со сменой — нет; в спринте на 1–2 круга правила нет
{
  const sprint = createRace(1000, [{ id: 'a', name: 'A', player: true, compound: 'medium' }], 3)
  const ps = { a: 990 }
  sprint.update(0, (c) => ps[c.id])
  sprint.go()
  for (let t = 0; t < 70; t += 0.05) {
    ps.a = (ps.a + 50 * 0.05) % 1000
    sprint.update(0.05, (c) => ps[c.id])
  }
  check('гонка на 3 круга: без пит-стопа не дисквалифицируют (правило двух составов — с 5 кругов)', `${sprint.car('a').finished ? 'финиш' : 'едет'}, ${sprint.car('a').dsq ? 'ДСК' : 'зачёт'}`, sprint.car('a').finished && !sprint.car('a').dsq)
  const race = createRace(1000, [{ id: 'a', name: 'A', player: true, compound: 'medium' }, { id: 'b', name: 'B', compound: 'soft' }], 5)
  const pos = { a: 990, b: 995 }
  race.update(0, (c) => pos[c.id])
  race.go()
  race.pitStop('b', 'medium')
  for (let t = 0; t < 140; t += 0.05) {
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
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
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
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
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

// Тормоза и топливо (Рома 29.10: «частицы, тормоза, топливо»): диск греется торможением и остывает на скорости, перегретый и
// холодный берут слабее; топливо тратится по газу, добавляет массу, на гонку его хватает с запасом, пустой бак — сход
{
  const withWear = () => {
    const w = fresh()
    w.v.wearOn = true
    return w
  }
  // одно торможение 300 → 100 км/ч
  const w = withWear()
  run(w, NONE, 0.5)
  accelTo(w, 300)
  const t0 = [...w.v.brakeTemp]
  for (let t = 0; t < 10 && kmh(w) > 100; t += DT) run(w, { brake: 1 }, DT)
  const rise = w.v.brakeTemp.map((x, i) => x - t0[i])
  const front = (rise[0] + rise[1]) / 2
  const rear = (rise[2] + rise[3]) / 2
  check('тормоза: 300 → 100 км/ч греет передний диск сильнее заднего', `перед +${Math.round(front)}°, зад +${Math.round(rear)}° (с ${Math.round(t0[0])}°)`, front > 150 && front < 450 && rear < front)
  // остывание на прямой
  const hot = w.v.brakeTemp[0]
  run(w, () => hold(w, 250), 10)
  check('тормоза остывают на прямой', `${Math.round(hot)}° → ${Math.round(w.v.brakeTemp[0])}° за 10 с на 250 км/ч`, w.v.brakeTemp[0] < hot * 0.6)
  // перегретые и холодные берут слабее
  const stop = (temp) => {
    const s = withWear()
    run(s, NONE, 0.5)
    accelTo(s, 250)
    s.v.brakeTemp = [temp, temp, temp, temp]
    const z0 = s.v.body.translation()
    for (let t = 0; t < 10 && kmh(s) > 100; t += DT) run(s, { brake: 0.8 }, DT)
    const z1 = s.v.body.translation()
    return Math.hypot(z1.x - z0.x, z1.z - z0.z)
  }
  const ok = stop(650)
  const faded = stop(1350)
  const cold = stop(60)
  check('перегретые и холодные тормоза: путь 250 → 100 длиннее', `в окне ${ok.toFixed(0)} м, перегретые ${faded.toFixed(0)} м, холодные ${cold.toFixed(0)} м`, faded > ok * 1.15 && cold > ok * 1.03 && cold < faded)

  // топливо: масса замедляет разгон
  const to200 = (kg) => {
    const s = withWear()
    setFuel(s.v, kg)
    run(s, NONE, 0.5)
    let t = 0
    while (kmh(s) < 200 && t < 20) {
      run(s, { throttle: 1 }, DT)
      t += DT
    }
    return t
  }
  const light = to200(1)
  const heavy = to200(110)
  check('полный бак медленнее разгоняется', `0–200: ${light.toFixed(2)} с почти пустой, ${heavy.toFixed(2)} с со 110 кг`, heavy > light * 1.03 && heavy < light * 1.2)
  // пустой бак: мотор не тянет, сход
  const e = withWear()
  setFuel(e.v, 0.05)
  run(e, NONE, 0.5)
  run(e, { throttle: 1 }, 6)
  check('кончилось топливо — мотор глохнет и сход', `${kmh(e).toFixed(0)} км/ч через 6 с газа, ${retireReason(e.v) || 'нет схода'}`, kmh(e) < 60 && retireReason(e.v) === 'Кончилось топливо')

  // расход за круг LUMEN RING (сложный бот) и что бака на гонку хватает
  const glb = fs.readFileSync(new URL('../public/models/track.glb', import.meta.url))
  const json = JSON.parse(glb.slice(20, 20 + glb.readUInt32LE(12)).toString())
  const P = (n) => n.translation || [n.matrix[12], n.matrix[13], n.matrix[14]]
  const kids = (name) => json.nodes.find((n) => n.name === name).children.map((i) => json.nodes[i])
  const axis = kids('Ось трассы').map((n) => ({ x: P(n)[0], z: P(n)[2], ...n.extras })).sort((a, b) => a.distance_m - b.distance_m)
  const len = axis[axis.length - 1].distance_m + 2
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), g)
  const yaw = Math.atan2(axis[1].x - axis[0].x, axis[1].z - axis[0].z)
  const v = createVehicle(RAPIER, world, { x: axis[0].x, y: 0.05, z: axis[0].z, yaw }, TUNING)
  setFuel(v, 30)
  const d = createAiDriver(createRaceLine(axis, 'hard'), { idx: 0 })
  let prev = 0
  let at1 = null
  let lapKg = NaN
  let bmax = 0
  for (let t = 0; t < 200; t += DT) {
    stepVehicle(v, d.update(v, DT), DT, () => 'asphalt')
    world.step()
    if (at1 !== null) bmax = Math.max(bmax, ...v.brakeTemp)
    const sNow = axis[d.state.idx].distance_m
    if (prev > len * 0.75 && sNow < len * 0.25) {
      if (at1 === null) at1 = v.fuel
      else {
        lapKg = at1 - v.fuel
        break
      }
    }
    prev = sNow
  }
  const perKm = lapKg / (len / 1000)
  const tank = fuelForRace(5, len)
  check('топливо за круг LUMEN RING и бак на 5 кругов', `${lapKg.toFixed(2)} кг за круг (${perKm.toFixed(2)} кг/км, в расчёте бака ${FUEL_PER_KM}), бак ${tank} кг — запас ${(tank / lapKg - 5).toFixed(1)} кр.`, lapKg > 0.8 && lapKg < 1.7 && Math.abs(perKm / FUEL_PER_KM - 1) < 0.2 && tank / lapKg - 5 > 0.6)
  check('тормоза за круг в рабочем окне', `до ${Math.round(bmax)}°`, bmax > 450 && bmax < 1000)
}

// Дождь (Рома 29.10): слики на мокрой почти не держат, промежуточные — лучшие на влажной, дождевые — в ливень;
// на сухой дождевые медленнее и горят; бот на дождевых по мокрой LUMEN RING едет медленнее и не вылетает
{
  const g = (c, w) => wetGrip(c, w)
  check('сцепление по погоде: сухо — слики, влажно — промежуточные, ливень — дождевые', `сухо ${g('medium', 0).toFixed(2)}/${g('intermediate', 0).toFixed(2)}/${g('wet', 0).toFixed(2)}, влажно ${g('medium', 0.5).toFixed(2)}/${g('intermediate', 0.5).toFixed(2)}/${g('wet', 0.5).toFixed(2)}, ливень ${g('medium', 1).toFixed(2)}/${g('intermediate', 1).toFixed(2)}/${g('wet', 1).toFixed(2)} (средние/промежуточные/дождевые)`, g('medium', 0) > g('intermediate', 0) && g('intermediate', 0) > g('wet', 0) && g('intermediate', 0.5) > g('wet', 0.5) && g('intermediate', 0.5) > g('medium', 0.5) && g('wet', 1) > g('intermediate', 1) && g('intermediate', 1) > g('medium', 1))
  const brake = (compound, wet) => {
    const w = fresh()
    w.v.wearOn = true
    w.v.compound = compound
    w.v.wet = wet
    run(w, NONE, 0.5)
    accelTo(w, 200)
    w.v.tyres.forEach((t) => (t.temp = compound === 'medium' ? 100 : 65))
    const z0 = w.v.body.translation()
    for (let t = 0; t < 15 && kmh(w) > 80; t += DT) run(w, { brake: 1, abs: true }, DT)
    const z1 = w.v.body.translation()
    return Math.hypot(z1.x - z0.x, z1.z - z0.z)
  }
  const dry = brake('medium', 0)
  const slickWet = brake('medium', 0.9)
  const wetWet = brake('wet', 0.9)
  check('торможение 200 → 80 км/ч: на мокрой сликах сильно дольше, на дождевых — ближе к сухому', `сухо ${dry.toFixed(0)} м, слики в дождь ${slickWet.toFixed(0)} м, дождевые в дождь ${wetWet.toFixed(0)} м`, slickWet > dry * 1.5 && wetWet < slickWet * 0.8 && wetWet > dry)
  const wearOn = (compound) => {
    const w = fresh()
    w.v.wearOn = true
    w.v.compound = compound
    run(w, NONE, 0.5)
    accelTo(w, 200)
    run(w, () => ({ ...hold(w, 200), steer: 0.15 }), 20)
    return Math.max(...w.v.tyres.map((t) => t.wear))
  }
  const mWear = wearOn('medium')
  const iWear = wearOn('intermediate')
  check('промежуточные на сухой горят', `за 20 с на 200 км/ч: средние ${(mWear * 100).toFixed(1)}%, промежуточные ${(iWear * 100).toFixed(1)}%`, iWear > mWear * 2.5)

  // бот на мокрой LUMEN RING
  const glb = fs.readFileSync(new URL('../public/models/track.glb', import.meta.url))
  const json = JSON.parse(glb.slice(20, 20 + glb.readUInt32LE(12)).toString())
  const P = (n) => n.translation || [n.matrix[12], n.matrix[13], n.matrix[14]]
  const kids = (name) => json.nodes.find((n) => n.name === name).children.map((i) => json.nodes[i])
  const axis = kids('Ось трассы').map((n) => ({ x: P(n)[0], z: P(n)[2], ...n.extras })).sort((a, b) => a.distance_m - b.distance_m)
  const len = axis[axis.length - 1].distance_m + 2
  const lapOn = (compound, wet) => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    world.timestep = DT
    const gr = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), gr)
    const yaw = Math.atan2(axis[1].x - axis[0].x, axis[1].z - axis[0].z)
    const v = createVehicle(RAPIER, world, { x: axis[0].x, y: 0.05, z: axis[0].z, yaw }, TUNING)
    v.compound = compound
    v.wet = wet
    v.tyres.forEach((t) => (t.temp = compound === 'medium' ? 95 : 60))
    const d = createAiDriver(createRaceLine(axis, 'hard'), { idx: 0 })
    let prev = 0
    let last = null
    let over = -Infinity
    for (let t = 0; t < 260; t += DT) {
      stepVehicle(v, d.update(v, DT), DT, () => 'asphalt')
      world.step()
      const p = v.body.translation()
      const i = d.state.idx
      const a = axis[i]
      const b = axis[(i + 1) % axis.length]
      const tx = b.x - a.x
      const tz = b.z - a.z
      if (last !== null) over = Math.max(over, Math.abs(((p.x - a.x) * tz - (p.z - a.z) * tx) / Math.hypot(tx, tz)) - ((a.asphalt_half_width ?? 7) - 0.95))
      if (prev > len * 0.75 && a.distance_m < len * 0.25) {
        if (last !== null) return { lap: t - last, over }
        last = t
      }
      prev = a.distance_m
    }
    return { lap: Infinity, over }
  }
  const dryLap = lapOn('medium', 0)
  const wetLap = lapOn('wet', 0.9)
  check('бот в дождь на дождевых: медленнее и в пределах асфальта', `сухо ${dryLap.lap.toFixed(1)} с, дождь ${wetLap.lap.toFixed(1)} с, запас до края в дождь ${(-wetLap.over).toFixed(2)} м`, wetLap.lap > dryLap.lap * 1.05 && wetLap.lap < dryLap.lap * 1.35 && wetLap.over < 0.3)
}

const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `\nНе прошло: ${failed.length} из ${results.length}` : `\nВсё прошло: ${results.length} проверок`)
process.exit(failed.length ? 1 : 0)
