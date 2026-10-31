// Сборка болида (Рома 30.10: «строить болид, что у него под капотом»): детали с компромиссами в рамках бюджета, как
// ограничение бюджета в F1. Настройка (setup.js) подстраивает болид под трассу, сборка — то, из чего он сделан.
// Каждая деталь — множители и прибавки к числам физики (tuning.js) и к износу/нагреву (wear.js). «Стандарт» во всех узлах —
// ровно нынешний болид (физика и тесты не меняются). Лучше одно — хуже другое: мощнее мотор — быстрее изнашивается и
// греется; больше прижима — ниже максималка; легче шасси — дороже. На всё лучшее бюджета не хватит.
// Боты получают свои сборки (randomBuild), онлайн — «свои сборки» или «одинаковые болиды» (настройка комнаты).
import { TUNING, BALLAST_STEP } from './tuning.js'

export const BUDGET = 100
const TOP_STOCK = 319 // км/ч: замер стандартного болида без режима прямой (tests/physics.mjs)
const KEY = 'f1-race.build'

// mods: множители (×) к числам TUNING; add — прибавки; свои поля сборки: iceWear, boxWear (износ мотора и коробки),
// heatK (нагрев мотора), brakeCoolK / brakeHeatK (остывание и нагрев тормозов), damageK (тяжесть ударов), buildMass (кг),
// comDrop (центр масс ниже, м), ballastK (во сколько раз дальше двигает вес «Балласт» в настройке)
export const PARTS = [
  {
    id: 'engine',
    name: 'Мотор',
    options: [
      { id: 'durable', name: 'Надёжный', cost: 8, about: 'Мощность −4%, износ вдвое медленнее, греется меньше.', mods: { power: 0.96, iceWear: 0.5, heatK: 0.9 } },
      { id: 'std', name: 'Стандарт', cost: 14, about: 'Мотор 2025 года: ~610 кВт.', mods: {} },
      { id: 'boost', name: 'Форсированный', cost: 19, about: 'Мощность +5%, но износ ×1,6 и нагрев выше.', mods: { power: 1.05, maxDriveForce: 1.03, iceWear: 1.6, heatK: 1.12 } },
      { id: 'quali', name: 'Квалификационный', cost: 25, about: 'Мощность +8%: на круг — лучший, в гонке может не дожить (износ ×2,6, сильный нагрев).', mods: { power: 1.08, maxDriveForce: 1.05, iceWear: 2.6, heatK: 1.25 } },
    ],
  },
  {
    id: 'ers',
    name: 'Батарея',
    options: [
      { id: 'light', name: 'Лёгкая', cost: 6, about: 'Энергии −25%, болид легче на 6 кг.', mods: { batteryMJ: 0.75, buildMass: -6 } },
      { id: 'std', name: 'Стандарт', cost: 10, about: '2 МДж, «Обгон» +160 кВт.', mods: {} },
      { id: 'big', name: 'Ёмкая', cost: 14, about: 'Энергии +30% (дольше «Обгон»), но тяжелее на 8 кг.', mods: { batteryMJ: 1.3, buildMass: 8 } },
      { id: 'punch', name: 'Мощная отдача', cost: 16, about: '«Обгон» +25% мощности, энергии −10%.', mods: { boostPower: 1.25, boostForce: 1.2, batteryMJ: 0.9 } },
    ],
  },
  {
    id: 'gearbox',
    name: 'Коробка передач',
    options: [
      { id: 'std', name: 'Стандарт', cost: 8, about: 'Восемь передач, ровная разгонная кривая.', mods: {} },
      { id: 'short', name: 'Короткая', cost: 16, about: 'Разгон и выход из медленных поворотов лучше (для городских трасс), максималка чуть ниже, коробка изнашивается в 1,3 раза быстрее.', mods: { maxDriveForce: 1.05, lowSpeedDrive: 0.05, power: 0.98, boxWear: 1.3 } },
      { id: 'long', name: 'Длинная', cost: 5, about: 'Дешёвая и долговечная: мотор на низких оборотах (износ −15%), коробка служит почти вдвое дольше, но разгон хуже.', mods: { maxDriveForce: 0.96, iceWear: 0.85, boxWear: 0.55 } },
      { id: 'seamless', name: 'Бесшовная', cost: 16, about: 'Переключения без провала: немного лучше везде, но изнашивается в 1,4 раза быстрее.', mods: { maxDriveForce: 1.03, power: 1.01, boxWear: 1.4 } },
    ],
  },
  {
    id: 'aero',
    name: 'Аэропакет',
    options: [
      { id: 'low', name: 'Низкий прижим', cost: 6, about: 'Дешёвый пакет: сопротивление −12% — быстро на прямых, но в поворотах держит хуже (прижим −10%).', mods: { downforceK: 0.9, dragK: 0.88 } },
      { id: 'std', name: 'Стандарт', cost: 12, about: 'Универсальный пакет.', mods: {} },
      { id: 'high', name: 'Высокий прижим', cost: 20, about: 'Прижим +12% в поворотах, сопротивление +12%: на прямых медленнее.', mods: { downforceK: 1.12, dragK: 1.12 } },
      { id: 'efficient', name: 'Эффективный', cost: 28, about: 'Прижим +12% при сопротивлении −2%: лучше везде, но очень дорого.', mods: { downforceK: 1.12, dragK: 0.98 } },
    ],
  },
  {
    id: 'brakes',
    name: 'Тормоза',
    options: [
      { id: 'std', name: 'Стандарт', cost: 8, about: 'Углеродные диски, рабочее окно 350–1000 °C.', mods: {} },
      { id: 'strong', name: 'Мощные', cost: 12, about: 'Тормозят на 10% сильнее, но греются быстрее.', mods: { brakeForce: 1.1, brakeHeatK: 1.15 } },
      { id: 'cool', name: 'Стойкие', cost: 12, about: 'Остывают на 35% быстрее — не «плывут» на длинной гонке; сила −3%.', mods: { brakeForce: 0.97, brakeCoolK: 1.35 } },
    ],
  },
  {
    id: 'cooling',
    name: 'Охлаждение мотора',
    options: [
      { id: 'tight', name: 'Минимальное', cost: 4, about: 'Сопротивление −1,5%, но мотор греется сильнее (+15%).', mods: { dragK: 0.985, heatK: 1.15 } },
      { id: 'std', name: 'Стандарт', cost: 6, about: 'Радиаторы под обычную погоду.', mods: {} },
      { id: 'big', name: 'Усиленное', cost: 10, about: 'Мотор греется на 18% меньше, сопротивление +2%.', mods: { dragK: 1.02, heatK: 0.82 } },
    ],
  },
  {
    id: 'chassis',
    name: 'Шасси',
    options: [
      { id: 'std', name: 'Стандарт', cost: 10, about: '800 кг с пилотом, как требует регламент.', mods: {} },
      { id: 'light', name: 'Лёгкое + балласт', cost: 13, about: 'Как в F1: шасси строят легче минимума и добирают до 800 кг вольфрамовым балластом на днище. Вес тот же, но центр масс на 1,5 см ниже, а «Балласт» в настройке болида двигает вес вдвое дальше (±6 см вместо ±3).', mods: { comDrop: 0.015, ballastK: 2 } },
      { id: 'strong', name: 'Прочное', cost: 14, about: 'Удары ломают на 30% меньше, но тяжелее на 8 кг.', mods: { damageK: 0.7, buildMass: 8 } },
    ],
  },
]

export const STOCK_BUILD = Object.fromEntries(PARTS.map((p) => [p.id, 'std']))
const optionOf = (part, id) => part.options.find((o) => o.id === id) ?? part.options.find((o) => o.id === 'std')

// стоимость сборки (очки бюджета)
export const buildCost = (build) => PARTS.reduce((s, p) => s + optionOf(p, build?.[p.id]).cost, 0)

// сборка из чего угодно (хранилище, сеть): незнакомые детали — стандарт, вышла за бюджет — вся стандартная
// (budget — свой у сборки сезона в чемпионате, career.js)
export function cleanBuild(raw, budget = BUDGET) {
  const b = Object.fromEntries(PARTS.map((p) => [p.id, optionOf(p, raw?.[p.id]).id]))
  return buildCost(b) <= budget ? b : { ...STOCK_BUILD }
}

const ADD = new Set(['lowSpeedDrive', 'buildMass', 'comDrop'])
// числа физики для болида с этой сборкой: копия TUNING (setup — свой объект настройки или общий у игрока)
export function buildTuning(build, setup = TUNING.setup, base = TUNING) {
  const T = { ...base, setup, iceWear: 1, boxWear: 1, heatK: 1, brakeCoolK: 1, brakeHeatK: 1, damageK: 1, buildMass: 0, comDrop: 0, ballastK: 1 }
  for (const p of PARTS) {
    const mods = optionOf(p, build?.[p.id]).mods
    for (const [k, v] of Object.entries(mods)) T[k] = ADD.has(k) ? (T[k] ?? 0) + v : (T[k] ?? 1) * v
  }
  return T
}

// цифры для карточки болида: мощность, максималка, прижим, вес, надёжность
export function buildStats(build) {
  const T = buildTuning(build)
  const S = buildTuning(STOCK_BUILD)
  // максималка: мощность = сопротивление воздуха × скорость → v ∝ ∛(мощность / сопротивление); от замера стандартного болида
  const top = (t) => Math.cbrt(t.power / t.dragK)
  return {
    cost: buildCost(build),
    powerKw: Math.round(T.power / 1000),
    hp: Math.round(T.power / 745.7),
    topKmh: Math.round((TOP_STOCK * top(T)) / top(S)),
    topStock: TOP_STOCK,
    accel: T.maxDriveForce / S.maxDriveForce, // тяга с места относительно стандарта
    downforce: T.downforceK / S.downforceK,
    drag: T.dragK / S.dragK,
    mass: Math.round(T.mass + T.buildMass),
    batteryMJ: T.batteryMJ,
    brakes: T.brakeForce / S.brakeForce,
    // надёжность: чем быстрее изнашиваются мотор и коробка и чем сильнее греется — тем ниже (стандарт — 100%)
    reliability: Math.round(100 / (T.iceWear * 0.6 + T.boxWear * 0.25 + T.heatK * 0.15)),
    comDropCm: Math.round(T.comDrop * 1000) / 10, // центр масс ниже стандарта, см
    ballastCm: Math.round(T.ballastK * 5 * BALLAST_STEP * 1000) / 10, // ход балласта в настройке, ± см
  }
}

// случайная сборка в рамках бюджета (боты): каждый узел по очереди, дорогие — реже; не влезла — стандарт
export function randomBuild(rand = Math.random) {
  for (let tries = 0; tries < 20; tries++) {
    const b = {}
    for (const p of PARTS) b[p.id] = p.options[Math.floor(rand() * p.options.length)].id
    if (buildCost(b) <= BUDGET) return b
  }
  return { ...STOCK_BUILD }
}

export function loadBuild() {
  try {
    return cleanBuild(JSON.parse(localStorage.getItem(KEY) || 'null'))
  } catch {
    return { ...STOCK_BUILD }
  }
}
export function saveBuild(build) {
  try {
    localStorage.setItem(KEY, JSON.stringify(build))
  } catch {
    // не запомнили — до перезагрузки останется
  }
}
