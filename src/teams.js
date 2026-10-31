// Команды и ливрея болида (главное меню → Гараж). Команды выдуманные: настоящих названий и логотипов в игре нет.
// У болида три цвета: кузов (материал paint), белая зона вокруг кокпита (paint_secondary) и акцент (accent_blue) — и покрытие.
const KEY = 'f1-race.livery.v1'

export const TEAMS = [
  { id: 'rossa', name: 'Росса Корса', primary: '#C4101A', secondary: '#F2F0EA', accent: '#2845C8', about: 'Классический красный с белой зоной. Болид, с которого всё начиналось.' },
  { id: 'aqua', name: 'Аква Марина', primary: '#12A3B4', secondary: '#0C1F29', accent: '#F4F4F2', about: 'Бирюза и глубокий синий. На тёмном асфальте видно издалека.' },
  { id: 'rift', name: 'Оранж Рифт', primary: '#F07A12', secondary: '#1A1C20', accent: '#F4F4F2', about: 'Оранжевый с чёрной зоной: агрессивный и очень заметный.' },
  { id: 'argent', name: 'Аржан', primary: '#B9BEC6', secondary: '#E10600', accent: '#1A1C20', about: 'Серебро с красной вставкой, как у старых гоночных болидов.' },
  { id: 'verde', name: 'Верде Бритиш', primary: '#0D7A55', secondary: '#E9E6DF', accent: '#FFC400', about: 'Тёмно-зелёный с кремовой зоной. Спокойный и дорогой.' },
  { id: 'azur', name: 'Азур Фронт', primary: '#1F5FBF', secondary: '#F4F4F2', accent: '#E10600', about: 'Синий с белым. Чистая и строгая ливрея.' },
  { id: 'noir', name: 'Нуар Лёд', primary: '#1A1C20', secondary: '#E10600', accent: '#F4F4F2', about: 'Почти чёрный болид с красной зоной вокруг кокпита.' },
  { id: 'giallo', name: 'Джалло Молния', primary: '#E6BC18', secondary: '#15171B', accent: '#15171B', about: 'Жёлтый с чёрным: ночью и в дождь его видно лучше всех.' },
]

// готовые цвета для своей ливреи
export const BODY_SWATCHES = ['#C4101A', '#F07A12', '#E6BC18', '#8FD14F', '#0D7A55', '#12A3B4', '#1F5FBF', '#4B3FD1', '#E05A9C', '#7A1F2B', '#B9BEC6', '#1A1C20']
export const ZONE_SWATCHES = ['#F2F0EA', '#15171B', '#E10600', '#FFC400', '#2F7BFF', '#22D36B', '#B9BEC6', '#7A1F2B']

export const ACCENT_SWATCHES = ['#2845C8', '#F4F4F2', '#15171B', '#E10600', '#FFC400', '#22D36B', '#12A3B4', '#F07A12']
// пилот: шлем, полоса шлема, комбинезон, перчатки
export const HELMET_SWATCHES = ['#F2F2F2', '#15171B', '#E10600', '#FFC400', '#2F7BFF', '#22D36B', '#F07A12', '#E05A9C', '#B9BEC6', '#12A3B4']
export const SUIT_SWATCHES = ['#C4101A', '#15171B', '#F2F0EA', '#1F5FBF', '#0D7A55', '#F07A12', '#E6BC18', '#12A3B4', '#B9BEC6', '#7A1F2B']
export const GLOVE_SWATCHES = ['#15171B', '#F2F2F2', '#E10600', '#FFC400', '#2F7BFF', '#B9BEC6']
export const FINISH_IDS = ['gloss', 'matte', 'metal', 'chrome']

// Ливрея — и болид, и пилот: цвета кузова, зоны, акцента и покрытие; шлем, комбинезон, перчатки, номер и три буквы
const DEFAULT = { team: 'rossa', primary: TEAMS[0].primary, secondary: TEAMS[0].secondary, accent: TEAMS[0].accent, finish: 'gloss', helmet: '#F2F2F2', helmet2: '#E10600', suit: '#C4101A', gloves: '#15171B', number: 16, tag: '' }
const HEX = /^#[0-9a-f]{6}$/i

// три буквы как в F1 (ВЕР, ЛЕК): русские или латинские, заглавные
export const cleanTag = (s) => String(s ?? '').toUpperCase().replace(/[^A-ZА-ЯЁ]/g, '').slice(0, 3)
export const cleanNumber = (n) => {
  const v = Math.round(Number(n))
  return v >= 1 && v <= 99 ? v : 16
}

// из чего угодно (хранилище, «Мои ливреи»): незнакомое — по умолчанию
export function cleanLivery(s) {
  if (!s || !HEX.test(s.primary) || !HEX.test(s.secondary)) return { ...DEFAULT }
  const hex = (v, d) => (HEX.test(v) ? v : d)
  return {
    team: typeof s.team === 'string' ? s.team : 'own',
    primary: s.primary,
    secondary: s.secondary,
    accent: hex(s.accent, DEFAULT.accent),
    finish: FINISH_IDS.includes(s.finish) ? s.finish : 'gloss',
    helmet: hex(s.helmet, DEFAULT.helmet),
    helmet2: hex(s.helmet2, DEFAULT.helmet2),
    suit: hex(s.suit, DEFAULT.suit),
    gloves: hex(s.gloves, DEFAULT.gloves),
    number: cleanNumber(s.number ?? 16),
    tag: cleanTag(s.tag),
  }
}

export function loadLivery() {
  try {
    return cleanLivery(JSON.parse(localStorage.getItem(KEY) || 'null'))
  } catch {
    // нет хранилища или запись повреждена — болид базовой команды
  }
  return { ...DEFAULT }
}

// «Мои ливреи»: сохранённые под своим названием раскраски (болид и пилот целиком)
const MINE_KEY = 'f1-race.livery.mine'
export const LIVERY_NAME_MAX = 24
export function loadMyLiveries() {
  try {
    const list = JSON.parse(localStorage.getItem(MINE_KEY) || '[]')
    return Array.isArray(list) ? list.filter((m) => typeof m?.name === 'string').map((m) => ({ name: m.name.slice(0, LIVERY_NAME_MAX), livery: cleanLivery(m.livery) })) : []
  } catch {
    return []
  }
}
export function saveMyLiveries(list) {
  try {
    localStorage.setItem(MINE_KEY, JSON.stringify(list))
  } catch {
    // не сохранилось — до перезагрузки список останется
  }
}

export function saveLivery(l) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l))
  } catch {
    // не сохранилось — в этой сессии ливрея всё равно действует
  }
}

export const teamById = (id) => TEAMS.find((t) => t.id === id) || null
