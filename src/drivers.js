// Пилоты-соперники с характером (Рома 31.10: «боты с характером», имена выдуманные). Одиннадцать постоянных пилотов:
// имя, код из трёх букв (таблица гонки), номер, цвет команды, характер и рейтинг. Раньше темп и манера раздавались на
// каждую гонку случайно — теперь они закреплены за пилотом. Рейтинг (60…95) — это темп: 95 — предел уровня, каждое очко
// ниже −0,23%. После каждой гонки с соперниками рейтинг меняется: финишировал выше ожидаемого — растёт, ниже — падает
// (не больше ±2 за гонку), хранится в localStorage `f1-race.drivers.v1`.
// Характер влияет по-настоящему (числа — в pilotOf):
//  агрессивный — охотно атакует и закрывается, срезает повороты по полной, чуть хуже тормозит;
//  осторожный — почти не закрывается, тормозит раньше, зато стабилен;
//  защитник — закрывается всегда, обгоняет неохотно;
//  квалификатор — на одном круге +0,4% (квалификация), шины стирает на 10% быстрее;
//  хранитель шин — шины стирает на 15% медленнее, на одном круге −0,2%;
//  дождевик — по мокрой трассе на 2,5% быстрее остальных.
export const TRAITS = {
  aggressive: { name: 'Агрессивный', about: 'Атакует и закрывается, режет повороты' },
  careful: { name: 'Осторожный', about: 'Тормозит раньше, в борьбу лезет редко' },
  defender: { name: 'Защитник', about: 'Держит позицию любой ценой' },
  qualifier: { name: 'Квалификатор', about: 'Быстр на одном круге, жжёт шины' },
  tyres: { name: 'Хранитель шин', about: 'Шины живут дольше' },
  rain: { name: 'Дождевик', about: 'Быстрее всех по мокрой' },
}

// по номеру бота (bot0…bot10): цвета совпадают с PAINTS в bots.js
export const ROSTER = [
  { code: 'БЕЛ', name: 'Артём Белозёров', number: 7, trait: 'defender', rating: 88 },
  { code: 'ГРО', name: 'Мирон Громов', number: 23, trait: 'aggressive', rating: 90 },
  { code: 'ДАН', name: 'Лука Данич', number: 11, trait: 'tyres', rating: 84 },
  { code: 'ЖУК', name: 'Эрик Жуковский', number: 31, trait: 'careful', rating: 80 },
  { code: 'КОС', name: 'Тимур Костров', number: 5, trait: 'qualifier', rating: 92 },
  { code: 'ЛИС', name: 'Ян Лисовский', number: 18, trait: 'rain', rating: 85 },
  { code: 'МОР', name: 'Савва Морозов', number: 3, trait: 'aggressive', rating: 82 },
  { code: 'ОРЛ', name: 'Глеб Орлов', number: 27, trait: 'qualifier', rating: 86 },
  { code: 'СОК', name: 'Давид Соколовский', number: 9, trait: 'defender', rating: 78 },
  { code: 'ТИХ', name: 'Нико Тихонов', number: 14, trait: 'tyres', rating: 81 },
  { code: 'ЯКО', name: 'Роберт Яковлев', number: 21, trait: 'careful', rating: 76 },
]

const KEY = 'f1-race.drivers.v1'
const MIN = 60
const MAX = 95
const STEP = 0.0023 // доля темпа на очко рейтинга

// сохранённое: { ratings: [11 чисел], races: [...], wins: [...] }
export function loadDrivers() {
  const base = { ratings: ROSTER.map((d) => d.rating), races: ROSTER.map(() => 0), wins: ROSTER.map(() => 0), podiums: ROSTER.map(() => 0) }
  try {
    const s = JSON.parse(localStorage.getItem(KEY))
    if (!s || !Array.isArray(s.ratings) || s.ratings.length !== ROSTER.length) return base
    for (const k of Object.keys(base)) if (Array.isArray(s[k]) && s[k].length === ROSTER.length && s[k].every((x) => Number.isFinite(x))) base[k] = s[k]
    base.ratings = base.ratings.map((r) => Math.min(MAX, Math.max(MIN, r)))
  } catch {
    // нет или испорчено — стартовые рейтинги
  }
  return base
}
function saveDrivers(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // не сохранили — рейтинг останется прежним до следующей гонки
  }
}

// пилот для ИИ (ai.js читает pace, line, brake, look, aggression; bots.js — tyreK, wetK, qualiK, defend)
// rand — для небольшого разброса манеры от гонки к гонке (у живых пилотов тоже бывают дни лучше и хуже)
export function pilotOf(i, rating, rand = Math.random) {
  const d = ROSTER[i % ROSTER.length]
  const t = d.trait
  const day = (rand() - 0.5) * 0.004 // ±0,2% — день на день не приходится
  const p = {
    id: i,
    code: d.code,
    name: d.name,
    number: d.number,
    trait: t,
    rating,
    pace: 1 - (MAX - rating) * STEP + day,
    line: t === 'aggressive' ? 1 : t === 'careful' ? 0.85 : 0.9 + rand() * 0.08,
    brake: t === 'careful' ? 0.95 : t === 'aggressive' ? 0.97 : 0.98,
    look: t === 'careful' ? 1.08 : 1,
    aggression: t === 'aggressive' ? 0.9 : t === 'defender' ? 0.75 : t === 'careful' ? 0.12 : 0.4 + rand() * 0.2,
    passBias: t === 'defender' ? 0.3 : 0, // защитник обгоняет неохотно: м/с к нужной разнице скоростей
    tyreK: t === 'tyres' ? 0.85 : t === 'qualifier' ? 1.1 : 1,
    wetK: t === 'rain' ? 1.025 : 1,
    qualiK: t === 'qualifier' ? 1.004 : t === 'tyres' ? 0.998 : 1,
  }
  return p
}

// все одиннадцать на гонку (по номеру бота)
export function rosterPilots(rand = Math.random) {
  const s = loadDrivers()
  return ROSTER.map((_, i) => pilotOf(i, s.ratings[i], rand))
}

// после гонки: order — места (id ботов 'bot0'…, игрок 'player'), dnf — сошедшие. Ожидаемое место — по рейтингу среди
// участников; разница с фактическим двигает рейтинг (±2 максимум). Возвращает изменения [{ i, delta }]
export function rateRace(order, dnf = new Set()) {
  const s = loadDrivers()
  const bots = order.filter((id) => id.startsWith('bot'))
  const byRating = bots.map((id) => Number(id.slice(3))).sort((a, b) => s.ratings[b] - s.ratings[a])
  const changes = []
  bots.forEach((id, pos) => {
    const i = Number(id.slice(3))
    const expected = byRating.indexOf(i) // место среди ботов по рейтингу
    const delta = dnf.has(id) ? -1 : Math.max(-2, Math.min(2, (expected - pos) * 0.35))
    s.ratings[i] = Math.round(Math.min(MAX, Math.max(MIN, s.ratings[i] + delta)) * 10) / 10
    s.races[i]++
    const overall = order.indexOf(id)
    if (overall === 0) s.wins[i]++
    if (overall < 3) s.podiums[i]++
    changes.push({ i, delta })
  })
  saveDrivers(s)
  return changes
}

// таблица для экрана «Пилоты»: по рейтингу
export function driverTable() {
  const s = loadDrivers()
  return ROSTER.map((d, i) => ({ ...d, i, rating: s.ratings[i], races: s.races[i], wins: s.wins[i], podiums: s.podiums[i], traitName: TRAITS[d.trait].name, traitAbout: TRAITS[d.trait].about })).sort((a, b) => b.rating - a.rating)
}
