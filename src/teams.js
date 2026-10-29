// Команды и ливрея болида (главное меню → Гараж). Команды выдуманные: настоящих названий и логотипов в игре нет.
// У болида два цвета: кузов (материал paint) и белая зона вокруг кокпита (paint_secondary); низ крыльев — accent.
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

const DEFAULT = { team: 'rossa', primary: TEAMS[0].primary, secondary: TEAMS[0].secondary, accent: TEAMS[0].accent }
const HEX = /^#[0-9a-f]{6}$/i

export function loadLivery() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (s && HEX.test(s.primary) && HEX.test(s.secondary)) return { team: typeof s.team === 'string' ? s.team : 'own', primary: s.primary, secondary: s.secondary, accent: HEX.test(s.accent) ? s.accent : TEAMS[0].accent }
  } catch {
    // нет хранилища или запись повреждена — болид базовой команды
  }
  return { ...DEFAULT }
}

export function saveLivery(l) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l))
  } catch {
    // не сохранилось — в этой сессии ливрея всё равно действует
  }
}

export const teamById = (id) => TEAMS.find((t) => t.id === id) || null
