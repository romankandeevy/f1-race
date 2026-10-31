// Износ и поломки: шины (состав, износ, температура, прокол), повреждения от ударов (крылья, днище,
// подвеска), силовая установка (ДВС, ERS, коробка — износ копится между гонками, у изношенной растёт
// риск отказа), температура тормозов и топливо. Без Three.js — проверяется в Node. Физика читает отсюда множители (vehicle.js).
//
// Шина работает: боковая сила × скольжение (увод) × скорость, плюс пробуксовка/блокировка — это и нагревает,
// и стирает её. Числа подобраны по замеру на LUMEN RING (сложный бот, круг ~67 с): средняя работа шины
// 2,5–6 кВт. Средние живут ~6 кругов, мягкие ~3,5, твёрдые ~10 — на гонку в 5 кругов нужна тактика.
import { brakeCoolOf, engineCoolOf } from './tuning.js'

// wet — сцепление на сухой, полумокрой и совсем мокрой трассе (доля от сухого), между точками — плавно.
// Слики в дождь почти не держат; промежуточные лучше всех на влажной, дождевые — в ливень; на сухой обе дождевые
// перегреваются (окно ниже) и стираются в разы быстрее (rain — во сколько раз быстрее на сухой).
export const COMPOUNDS = {
  soft: { name: 'Мягкие', short: 'М', color: '#E10600', grip: 1.04, wear: 1.7, window: [85, 105], wet: [1, 0.62, 0.45] },
  medium: { name: 'Средние', short: 'С', color: '#FFC400', grip: 1, wear: 1, window: [90, 110], wet: [1, 0.6, 0.44] },
  hard: { name: 'Твёрдые', short: 'Т', color: '#F4F4F2', grip: 0.965, wear: 0.6, window: [95, 115], wet: [1, 0.58, 0.42] },
  intermediate: { name: 'Промежуточные', short: 'П', color: '#43B02A', grip: 1, wear: 1.2, window: [55, 85], wet: [0.88, 0.86, 0.72], rain: 2.5 },
  wet: { name: 'Дождевые', short: 'Д', color: '#2E8BE6', grip: 1, wear: 1.3, window: [45, 75], wet: [0.79, 0.81, 0.83], rain: 4 },
}
export const COMPOUND_ORDER = ['soft', 'medium', 'hard', 'intermediate', 'wet']
export const isRainTyre = (c) => !!COMPOUNDS[c]?.rain

// доля сухого сцепления на трассе мокрой на wet (0 — сухо, 1 — ливень)
export function wetGrip(compound, wet) {
  const [a, b, c] = COMPOUNDS[compound].wet
  return wet <= 0.5 ? a + (b - a) * (wet / 0.5) : b + (c - b) * ((wet - 0.5) / 0.5)
}

const WEAR_RATE = 0.00194 // доля шины в секунду у средних при средней работе (≈13% за круг)
const WEAR_BASE = 0.3 // износ просто от качения
const WORK_REF = 6000 // Вт
const AMBIENT = 25 // °C
const HEAT_WORK = 0.25 // °C/с на кВт работы
// Потолок скольжения, которое считается «работой» шины (нагрев и износ). Рома 29.10: «держу A/D весь поворот» — на упоре клавиши
// передняя шина идёт на ~4,6° скольжения вместо ~2,2° у плавного руля, работа вырастала вчетверо, перед перегревался до 140°,
// стирался втрое быстрее задних и лопался за два круга. Сцепление не меняем — только счёт износа и нагрева: клавиатура не должна
// наказываться за то, что руль нельзя держать «на полшага».
const SLIP_CAP = 0.03 // рад (~1,7°)
const HEAT_ROLL = 0.045 // °C/с на м/с скорости
const COOL = 0.02 // охлаждение, 1/с (на скорости сильнее); шина тяжёлая — греется и остывает за десятки секунд
export const BLANKET = 75 // °C — шины из грелок, чуть холоднее рабочего окна

// новый комплект
export function freshTyres(temp = BLANKET) {
  return [0, 1, 2, 3].map(() => ({ wear: 0, temp, puncture: false }))
}

// множитель сцепления шины: состав, износ («обрыв» после 70%), температура вне окна, прокол, мокрая трасса
export function tyreGrip(t, compound, wet = 0) {
  if (t.puncture) return 0.35
  const c = COMPOUNDS[compound]
  const w = t.wear
  let g = c.grip * wetGrip(compound, wet) * (1 - 0.08 * w - (w > 0.7 ? (w - 0.7) * 0.6 : 0))
  const [lo, hi] = c.window
  const off = t.temp < lo ? lo - t.temp : t.temp > hi ? t.temp - hi : 0
  return g * (1 - Math.min(0.15, off * 0.004))
}

// после шага физики: износ и температура каждой шины. Возвращает индекс шины, которая только что лопнула (или −1)
export function updateTyres(v, dt) {
  const c = COMPOUNDS[v.compound]
  const speed = Math.abs(v.state.fwdSpeed)
  let popped = -1
  for (let i = 0; i < 4; i++) {
    const w = v.wheels[i]
    const t = v.tyres[i]
    const work = w.contact ? Math.abs(w.fy) * Math.min(Math.abs(Math.sin(w.slip)), SLIP_CAP) * speed + (w.sliding ? Math.abs(w.fx) * Math.min(speed, 30) * 0.3 : 0) : 0
    if (!t.puncture) {
      const hot = t.temp > c.window[1] + 10 ? 1.3 : 1 // перегретая стирается быстрее
      // шина на повреждённой стороне стирается быстрее: колесо стоит под неправильным углом
      const bent = 1 + 1.2 * suspDamageAt(v.damage, w.front, w.side)
      // дождевые на подсыхающей трассе «горят»: протектор для воды, на сухом он рвётся
      const dry = c.rain ? 1 + c.rain * (1 - (v.wet || 0)) : 1
      t.wear = Math.min(1, t.wear + dt * WEAR_RATE * c.wear * hot * bent * dry * ((w.contact ? WEAR_BASE * Math.min(1, speed / 40) : 0) + work / WORK_REF))
      if (t.wear >= 1) {
        t.puncture = true // стёрта до корда — лопнула
        popped = i
      }
    }
    // вода на трассе остужает шины: слики в дождь выходят из окна и держат ещё хуже
    t.temp += dt * ((HEAT_WORK * work) / 1000 + HEAT_ROLL * speed - COOL * (t.temp - AMBIENT) * (1 + speed / 40) * (1 + 1.5 * (v.wet || 0)))
  }
  return popped
}

// ——— повреждения ———
// Рома 29.10: «я врезаюсь спокойненько и доезжаю до пит-стопа, так обгоню всех. Надо жёстче наказывать: чтобы ломалась любая часть,
// и это влияло на игру — как в настоящей Формуле-1». Теперь болид состоит из частей, у каждой своё повреждение 0…1 и своя роль:
//   wingL, wingR   переднее крыло (две половины) — прижим спереди
//   rearWing       заднее крыло — прижим сзади
//   floor          днище — граунд-эффект
//   sideL, sideR   бокподы с радиаторами — охлаждение мотора: разбитый бокпод перегревает и убивает мотор
//   brakes         тормозные каналы — слабее тормоза
//   suspL, suspR   подвеска стороны (см. ниже) — сцепление, схождение, проседание
//   chassis        монокок — от самых сильных ударов; 100% — болид разрушен, сход
//   lost[4]        оторванное колесо (ПЛ, ПП, ЗЛ, ЗП): болид дальше ехать не может
// Крыло, днище, бокподы и тормозные каналы меняют в боксах (время стоянки растёт с повреждением), подвеску, монокок и колесо — нет.

export function freshDamage() {
  return { wingL: 0, wingR: 0, rearWing: 0, floor: 0, suspL: 0, suspR: 0, sideL: 0, sideR: 0, brakes: 0, chassis: 0, lost: [0, 0, 0, 0] }
}

const IMPACT_MIN = 2.5 // м/с за шаг (~9 км/ч): слабее — касание без последствий (толкнулись с соседом, задел стену)
const CHASSIS_DV = 14 // м/с (~50 км/ч): слабее монокок держит без последствий
const CHASSIS_K = 0.035 // доля монокока на 1 м/с сверх: на 100 км/ч в стену −49%, на 160 — болид разрушен

// удар: dvx, dvz — изменение скорости кузова за шаг сверх того, что дают шины и мотор (мир, м/с).
// Направление удара в осях болида решает, что ломается. rand — для прокола. Возвращает, что сломалось.
export function applyImpact(v, dvx, dvz, rand = Math.random) {
  const dv = Math.hypot(dvx, dvz)
  if (dv < IMPACT_MIN) return null
  // тяжесть 0…1: слабый контакт — царапины, ~90 км/ч в стену — всё, что может сломаться по этому направлению, разрушено
  const sev = Math.min(1, ((dv - IMPACT_MIN) / 22) * (v.T?.damageK ?? 1)) // прочное шасси (build.js) — удары ломают меньше
  const q = v.body.rotation()
  const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
  const along = dvx * Math.sin(yaw) + dvz * Math.cos(yaw) // < 0 — толкнуло назад (удар носом)
  const side = dvx * Math.cos(yaw) - dvz * Math.sin(yaw) // > 0 — толкнуло влево (удар справа)
  const d = v.damage
  // broke — сколько всего отломилось за этот удар (сумма прибавок, у разбитой части прибавки нет), big — части, разрушенные сейчас:
  // по ним debris.js решает, сколько и каких обломков (царапина — ни одного, через 3–4 удара болид не рассыпается)
  let broke = 0
  let big = 0
  const up = (key, x) => {
    const was = d[key]
    d[key] = Math.min(1, was + x)
    if (key !== 'chassis' && !key.startsWith('susp')) broke += d[key] - was
    if (was < 0.9 && d[key] >= 0.9 && key !== 'chassis') big++
  }
  const hits = []
  let zone // где удар: для обломков (debris.js)
  if (-along > Math.abs(side) * 0.7) {
    zone = 'front'
    // удар носом: крыло со стороны удара сильнее, тормозные каналы в носу, на сильном ударе — обе передние подвески
    const right = side > 0 ? 0.65 : 0.35
    up('wingR', sev * right * 2.2)
    up('wingL', sev * (1 - right) * 2.2)
    hits.push('Переднее крыло')
    if (sev > 0.4) {
      up('brakes', sev * 0.5)
      hits.push('Тормозные каналы')
    }
    if (dv > 12) {
      up('suspL', (dv - 12) * 0.04)
      up('suspR', (dv - 12) * 0.04)
      hits.push('Передняя подвеска')
    }
  } else if (along > Math.abs(side) * 0.7) {
    zone = 'rear'
    up('rearWing', sev * 1.7)
    up('floor', sev * 0.45)
    hits.push('Заднее крыло')
    // коробка передач стоит сзади: сильный удар в корму её ломает, и это остаётся до новой силовой установки
    if (dv > 10 && v.pu) {
      v.pu.gearbox = Math.min(1, v.pu.gearbox + (dv - 10) * 0.03)
      hits.push('Коробка передач')
    }
  } else {
    // боком: подвеска и бокпод этой стороны, днище, может лопнуть шина, а на сильном ударе — оторваться колесо
    const key = side > 0 ? 'suspR' : 'suspL'
    const pod = side > 0 ? 'sideR' : 'sideL'
    zone = side > 0 ? 'right' : 'left'
    up(key, sev * 1.2)
    up(pod, sev * 1.4)
    up('floor', sev * 0.3)
    hits.push(side > 0 ? 'Подвеска справа' : 'Подвеска слева', side > 0 ? 'Бокпод справа' : 'Бокпод слева')
    if (sev > 0.25 && rand() < sev) {
      const i = side > 0 ? (rand() < 0.5 ? 1 : 3) : rand() < 0.5 ? 0 : 2
      if (!v.tyres[i].puncture) {
        v.tyres[i].puncture = true
        hits.push('Прокол')
      }
    }
    const front = side > 0 ? 1 : 0
    const rear = side > 0 ? 3 : 2
    if (d[key] >= 1 && dv > 12 && !d.lost[front]) {
      d.lost[front] = 1
      broke += 0.5
      hits.push('Оторвано колесо')
    } else if (d[key] >= 1 && dv > 22 && !d.lost[rear]) {
      d.lost[rear] = 1
      broke += 0.5
      hits.push('Оторвано колесо')
    }
  }
  // монокок: любой удар сильнее ~50 км/ч по нему тоже бьёт
  if (dv > CHASSIS_DV) {
    up('chassis', (dv - CHASSIS_DV) * CHASSIS_K)
    hits.push('Монокок')
  }
  return { sev, hits, zone, broke, big, along, side, dv } // along/side — направление толчка в осях болида: куда мнётся кузов (car.dent)
}

// Повреждённая подвеска (Рома 29.10: «что происходит, когда ломаются палки, которые соединяют колесо с болидом?»).
// d.suspL / d.suspR — 0…1 для левой и правой стороны; страдает в основном переднее колесо, заднее вдвое слабее.
// До SUSP_BROKEN подвеска «помята»: смещаются развал и схождение, сцепление чуть ниже, шина стирается быстрее.
// Выше — «сломана»: сторона проседает (пружина не работает), сцепление колеса падает почти вдвое, колесо перестаёт слушаться руля.
export const SUSP_BROKEN = 0.7
export const suspDamageAt = (d, front, side) => (side > 0 ? d.suspL : d.suspR) * (front ? 1 : 0.5)

// множители аэродинамики от повреждений
export function aeroDamage(d) {
  const front = (d.wingL + d.wingR) / 2
  const pods = (d.sideL + d.sideR) / 2
  return {
    front: 1 - 0.65 * front,
    rear: 1 - 0.7 * d.rearWing,
    ground: 1 - 0.5 * d.floor - 0.1 * pods,
    drag: 1 + 0.15 * (front + d.rearWing) + 0.12 * pods,
    pull: (d.suspL - d.suspR) * 0.002 + (d.wingL - d.wingR) * 0.001, // рад: чуть тянет в сторону (Рома 29.10: «не так сильно уводить»); остальное делают сами колёса
  }
}

// ——— перегрев мотора: радиаторы стоят в бокподах ———
// Мотор греется от газа и остывает потоком воздуха через бокподы. Целая машина на полном газу на скорости держит ~0,6;
// разбитый бокпод режет охлаждение: при 80% повреждения на скорости уже >1,8 — мощность падает, а через ~10 с мотор умирает (сход).
export const ENGINE_HOT = 0.9
export const ENGINE_DEAD = 1.15
export const coolingOf = (d) => 1 - 0.85 * Math.max(d.sideL, d.sideR)
export const heatPowerFactor = (heat) => 1 - Math.min(0.5, Math.max(0, heat - ENGINE_HOT) * 1.5)

// за шаг; возвращает true, когда мотор только что умер
export function updateEngineHeat(v, dt, throttle, speed) {
  if (v.pu.failed) return false
  const air = 0.4 + 0.6 * Math.min(1, speed / 60)
  // радиаторы из настройки (вкладка «Охлаждение»): закрытые — меньше сопротивления, но на медленной трассе мотор греется
  // heatK — мотор и охлаждение из сборки (build.js): форсированный греется сильнее, усиленное охлаждение — меньше
  const target = Math.min(1.8, ((0.2 + 0.4 * throttle) * (v.T?.heatK ?? 1)) / (coolingOf(v.damage) * engineCoolOf(v.T?.setup ?? {}) * air))
  v.engineHeat += (target - v.engineHeat) * (1 - Math.exp(-dt / 12))
  if (v.engineHeat > ENGINE_DEAD) {
    v.hotTime += dt
    if (v.hotTime > 3) {
      v.pu.failed = true
      return true
    }
  } else v.hotTime = Math.max(0, v.hotTime - dt)
  return false
}

// ——— тормоза: углеродные диски греются торможением и остывают потоком воздуха ———
// Рабочее окно углерода в F1 ~350–1000 °C: холодный тормоз берёт слабее, выше 1000° — «отказ» (fade), берёт всё слабее.
// Тепло на колесо = тормозная сила колеса × скорость (vehicle.js, w.brakeP). Диск ~1,4 кг углерода (теплоёмкость ~1700 Дж/°C).
// Остывает тем быстрее, чем быстрее едешь; разбитые тормозные каналы (damage.brakes) режут охлаждение.
// Замер (npm test): торможение 300→100 км/ч греет передний диск на ~260°, за 10 с на 250 км/ч он остывает с ~410° до ~230°,
// за круг LUMEN RING у сложного бота — до ~520°. Выше 1000° — только с разбитыми каналами или если ехать с ногой на тормозе.
export const BRAKE_START = 300 // °C — после прогревочного круга
const BRAKE_AMBIENT = 30
const BRAKE_HEAT_CAP = 1700 // Дж/°C на диск
const BRAKE_COOL = 0.012 // 1/с на месте
const BRAKE_COOL_V = 0.0009 // 1/с на каждый м/с скорости
export const BRAKE_COLD = 350 // ниже — тормоз берёт слабее
export const BRAKE_FADE = 1000 // выше — тормоз «плывёт»
export const BRAKE_HOT_NOTE = 1050

export const freshBrakes = () => [BRAKE_START, BRAKE_START, BRAKE_START, BRAKE_START]

// сколько тормоз колеса берёт от нормы: холодный до −15%, перегретый на 350° сверх окна — до −45%
export function brakeEff(temp) {
  const cold = Math.min(1, Math.max(0, (BRAKE_COLD - temp) / 250))
  const fade = Math.min(1, Math.max(0, (temp - BRAKE_FADE) / 350))
  return (1 - 0.15 * cold) * (1 - 0.45 * fade)
}

// за шаг; возвращает true, когда тормоза только что перегрелись (для строки на экране; снова — после остывания ниже 950°)
export function updateBrakes(v, dt, speed) {
  // воздуховоды тормозов из настройки: открытые — остывают быстрее, но сопротивления больше (coolDragOf)
  // тормоза из сборки (build.js): стойкие остывают быстрее, мощные греются сильнее
  const cool = (BRAKE_COOL + BRAKE_COOL_V * speed) * (1 - 0.7 * v.damage.brakes) * brakeCoolOf(v.T?.setup ?? {}) * (v.T?.brakeCoolK ?? 1)
  const heatK = v.T?.brakeHeatK ?? 1
  let hottest = 0
  for (let i = 0; i < 4; i++) {
    const t = v.brakeTemp[i] + dt * ((v.wheels[i].brakeP * heatK) / BRAKE_HEAT_CAP - (v.brakeTemp[i] - BRAKE_AMBIENT) * cool)
    v.brakeTemp[i] = t
    hottest = Math.max(hottest, t)
  }
  if (!v.brakeHot && hottest > BRAKE_HOT_NOTE) return (v.brakeHot = true)
  if (v.brakeHot && hottest < 950) v.brakeHot = false
  return false
}

// ——— топливо ———
// Предел расхода в F1 — 100 кг/ч на полной мощности; ~1,2 кг за круг LUMEN RING. Дозаправки в гонке нет (запрещена с 2010),
// поэтому топлива заливают на дистанцию с небольшим запасом: кончилось — сход. Топливо — масса: полный бак тяжелее и медленнее.
export const FUEL_FLOW_MAX = 100 / 3600 // кг/с
const FUEL_IDLE = 0.0004 // кг/с на холостых
export const FUEL_PER_KM = 0.33 // кг на км — для заправки на гонку (замер сложного бота на LUMEN RING, см. tests)

// бак на гонку: дистанция и запас в один круг
export const fuelForRace = (laps, trackLength) => +((laps + 1) * (trackLength / 1000) * FUEL_PER_KM + 0.5).toFixed(1)

export function setFuel(v, kg) {
  v.fuelOn = kg > 0
  v.fuel = kg
  v.fuelStart = kg
}

// за шаг: расход по газу; мощность изношенного или перегретого мотора ниже — и расход тоже
export function updateFuel(v, dt, throttle, power) {
  if (!v.fuelOn || v.fuel <= 0) return
  v.fuel = Math.max(0, v.fuel - dt * (FUEL_IDLE + FUEL_FLOW_MAX * throttle * power))
}

// ——— ремонт на пит-стопе ———
// Сколько секунд стоянки добавляет каждая часть (в F1 одна замена носа — ~7–10 с, кузов — дольше).
const REPAIR = [
  ['Переднее крыло', 7, (d) => Math.max(d.wingL, d.wingR) > 0.1],
  ['Заднее крыло', 9, (d) => d.rearWing > 0.1],
  ['Днище и бокподы', 8, (d) => Math.max(d.floor, d.sideL, d.sideR) > 0.15],
  ['Тормозные каналы', 4, (d) => d.brakes > 0.2],
]
export const repairList = (d) => REPAIR.filter(([, , need]) => need(d)).map(([name, sec]) => ({ name, sec }))
export const repairSeconds = (d) => repairList(d).reduce((a, r) => a + r.sec, 0)
export const needsRepair = (d) => repairList(d).length > 0
// механики поменяли всё, что можно поменять; подвеску, монокок и оторванное колесо не чинят
export function applyRepair(v) {
  const d = v.damage
  d.wingL = d.wingR = d.rearWing = d.floor = d.sideL = d.sideR = d.brakes = 0
}

// ——— силовая установка (копится между гонками) ———

export function freshPowerUnit() {
  return { ice: 0, ers: 0, gearbox: 0, failed: false }
}

const ICE_RATE = 0.00014 // ~0,6% за круг при обычной езде
const ERS_RATE = 0.00006
const BOX_RATE = 0.00005

// за шаг: износ от газа, оборотов и разряда батареи; изношенный мотор слабее и может отказать
export function updatePowerUnit(v, dt, throttle, deployShare, rand = Math.random) {
  const pu = v.pu
  if (pu.failed) return false
  // износ мотора и коробки из сборки (build.js): форсированный мотор и бесшовная коробка изнашиваются быстрее
  pu.ice = Math.min(1, pu.ice + dt * ICE_RATE * (v.T?.iceWear ?? 1) * throttle * (0.6 + 0.4 * v.state.rpm) * (1 + 0.6 * deployShare))
  pu.ers = Math.min(1, pu.ers + dt * ERS_RATE * deployShare * 3)
  pu.gearbox = Math.min(1, pu.gearbox + dt * BOX_RATE * (v.T?.boxWear ?? 1) * throttle)
  // отказ: только у сильно изношенного (риск растёт после 90%)
  const worst = Math.max(pu.ice, pu.gearbox)
  if (worst > 0.9 && rand() < (worst - 0.9) * 0.02 * dt) {
    pu.failed = true
    return true
  }
  return false
}

// множитель мощности от износа (после 70% — заметно слабее); отказавший — 0
export function powerFactor(pu, heat = 0) {
  if (pu.failed) return 0
  return (1 - Math.max(0, pu.ice - 0.7) * 0.4) * heatPowerFactor(heat)
}
