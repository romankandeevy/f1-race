// Износ и поломки: шины (состав, износ, температура, прокол), повреждения от ударов (крылья, днище,
// подвеска), силовая установка (ДВС, ERS, коробка — износ копится между гонками, у изношенной растёт
// риск отказа). Без Three.js — проверяется в Node. Физика читает отсюда множители (vehicle.js).
//
// Шина работает: боковая сила × скольжение (увод) × скорость, плюс пробуксовка/блокировка — это и нагревает,
// и стирает её. Числа подобраны по замеру на LUMEN RING (сложный бот, круг ~67 с): средняя работа шины
// 2,5–6 кВт. Средние живут ~6 кругов, мягкие ~3,5, твёрдые ~10 — на гонку в 5 кругов нужна тактика.

export const COMPOUNDS = {
  soft: { name: 'Мягкие', short: 'М', color: '#E10600', grip: 1.04, wear: 1.7, window: [85, 105] },
  medium: { name: 'Средние', short: 'С', color: '#FFC400', grip: 1, wear: 1, window: [90, 110] },
  hard: { name: 'Твёрдые', short: 'Т', color: '#F4F4F2', grip: 0.965, wear: 0.6, window: [95, 115] },
}
export const COMPOUND_ORDER = ['soft', 'medium', 'hard']

const WEAR_RATE = 0.00194 // доля шины в секунду у средних при средней работе (≈13% за круг)
const WEAR_BASE = 0.3 // износ просто от качения
const WORK_REF = 6000 // Вт
const AMBIENT = 25 // °C
const HEAT_WORK = 0.25 // °C/с на кВт работы
const HEAT_ROLL = 0.045 // °C/с на м/с скорости
const COOL = 0.02 // охлаждение, 1/с (на скорости сильнее); шина тяжёлая — греется и остывает за десятки секунд
export const BLANKET = 75 // °C — шины из грелок, чуть холоднее рабочего окна

// новый комплект
export function freshTyres(temp = BLANKET) {
  return [0, 1, 2, 3].map(() => ({ wear: 0, temp, puncture: false }))
}

// множитель сцепления шины: состав, износ («обрыв» после 70%), температура вне окна, прокол
export function tyreGrip(t, compound) {
  if (t.puncture) return 0.35
  const c = COMPOUNDS[compound]
  const w = t.wear
  let g = c.grip * (1 - 0.08 * w - (w > 0.7 ? (w - 0.7) * 0.6 : 0))
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
    const work = w.contact ? Math.abs(w.fy * Math.sin(w.slip)) * speed + (w.sliding ? Math.abs(w.fx) * Math.min(speed, 30) * 0.3 : 0) : 0
    if (!t.puncture) {
      const hot = t.temp > c.window[1] + 10 ? 1.3 : 1 // перегретая стирается быстрее
      t.wear = Math.min(1, t.wear + dt * WEAR_RATE * c.wear * hot * ((w.contact ? WEAR_BASE * Math.min(1, speed / 40) : 0) + work / WORK_REF))
      if (t.wear >= 1) {
        t.puncture = true // стёрта до корда — лопнула
        popped = i
      }
    }
    t.temp += dt * ((HEAT_WORK * work) / 1000 + HEAT_ROLL * speed - COOL * (t.temp - AMBIENT) * (1 + speed / 40))
  }
  return popped
}

// ——— повреждения ———

export function freshDamage() {
  return { wingL: 0, wingR: 0, rearWing: 0, floor: 0, suspL: 0, suspR: 0 }
}

const IMPACT_MIN = 2.5 // м/с за шаг (~9 км/ч): слабее — касание без последствий (толкнулись с соседом, задел стену)
const IMPACT_K = 0.037 // доля поломки на 1 м/с удара: на ~25 км/ч в стену крыло помято наполовину, на 60 — снесено

// удар: dvx, dvz — изменение скорости кузова за шаг сверх того, что дают шины и мотор (мир, м/с).
// Направление удара в осях болида решает, что ломается. rand — для прокола. Возвращает, что сломалось.
export function applyImpact(v, dvx, dvz, rand = Math.random) {
  const dv = Math.hypot(dvx, dvz)
  if (dv < IMPACT_MIN) return null
  const sev = Math.min(1, (dv - IMPACT_MIN) * IMPACT_K * 3)
  const q = v.body.rotation()
  const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
  const along = dvx * Math.sin(yaw) + dvz * Math.cos(yaw) // < 0 — толкнуло назад (удар носом)
  const side = dvx * Math.cos(yaw) - dvz * Math.sin(yaw) // > 0 — толкнуло влево (удар справа)
  const d = v.damage
  const hits = []
  if (-along > Math.abs(side) * 0.7) {
    // удар носом: крыло со стороны удара сильнее
    const right = side > 0 ? 0.65 : 0.35
    d.wingR = Math.min(1, d.wingR + sev * right * 2)
    d.wingL = Math.min(1, d.wingL + sev * (1 - right) * 2)
    hits.push('Переднее крыло')
  } else if (along > Math.abs(side) * 0.7) {
    d.rearWing = Math.min(1, d.rearWing + sev * 1.4)
    d.floor = Math.min(1, d.floor + sev * 0.4)
    hits.push('Заднее крыло')
  } else {
    // боком: подвеска этой стороны, может лопнуть шина
    const key = side > 0 ? 'suspR' : 'suspL'
    d[key] = Math.min(1, d[key] + sev * 1.2)
    d.floor = Math.min(1, d.floor + sev * 0.3)
    hits.push(side > 0 ? 'Подвеска справа' : 'Подвеска слева')
    if (sev > 0.25 && rand() < sev) {
      const i = side > 0 ? (rand() < 0.5 ? 1 : 3) : rand() < 0.5 ? 0 : 2
      if (!v.tyres[i].puncture) {
        v.tyres[i].puncture = true
        hits.push('Прокол')
      }
    }
  }
  return { sev, hits }
}

// множители аэродинамики от повреждений
export function aeroDamage(d) {
  const front = (d.wingL + d.wingR) / 2
  return {
    front: 1 - 0.45 * front,
    rear: 1 - 0.5 * d.rearWing,
    ground: 1 - 0.3 * d.floor,
    drag: 1 + 0.08 * (front + d.rearWing),
    pull: (d.suspL - d.suspR) * 0.035 + (d.wingL - d.wingR) * 0.01, // рад: болид тянет в сторону
  }
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
  pu.ice = Math.min(1, pu.ice + dt * ICE_RATE * throttle * (0.6 + 0.4 * v.state.rpm) * (1 + 0.6 * deployShare))
  pu.ers = Math.min(1, pu.ers + dt * ERS_RATE * deployShare * 3)
  pu.gearbox = Math.min(1, pu.gearbox + dt * BOX_RATE * throttle)
  // отказ: только у сильно изношенного (риск растёт после 90%)
  const worst = Math.max(pu.ice, pu.gearbox)
  if (worst > 0.9 && rand() < (worst - 0.9) * 0.02 * dt) {
    pu.failed = true
    return true
  }
  return false
}

// множитель мощности от износа (после 70% — заметно слабее); отказавший — 0
export function powerFactor(pu) {
  if (pu.failed) return 0
  return 1 - Math.max(0, pu.ice - 0.7) * 0.4
}
