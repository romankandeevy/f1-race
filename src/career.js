// Чемпионат (Рома 30.10: «карьера — серия гонок с очками и таблицей, бюджет на детали зарабатываешь в гонках»).
// Сезон — календарь из 4/6/8 этапов на трассах игры (по очереди; Marina Bay — ночью, как Сингапур), у всех этапов одни круги
// и уровень соперников. Перед каждой гонкой — квалификация. Очки F1 (25-18-15-12-10-8-6-4-2-1), сошедшим и дисквалифицированным —
// ноль. Соперники на весь сезон одни и те же: у каждого свой темп (makePilots) и своя сборка болида — таблица имеет смысл.
// Сборка игрока в сезоне своя (не та, что в свободной игре) и её бюджет растёт: START_BUDGET на старте сезона
// (стандартная сборка 68 + чуть-чуть) и призовые за каждый этап — тем больше, чем больше очков. Хранится в localStorage.
// Модуль без Three.js и DOM: только числа (main.js ведёт гонки, screens.js рисует).
import { makePilots } from './ai.js'
import { randomBuild, STOCK_BUILD, cleanBuild } from './build.js'

const KEY = 'f1-race.season.v1'
export const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]
export const START_BUDGET = 76
export const ROUNDS = [4, 6, 8]
export const SEASON_LAPS = [3, 5, 10]
// призовые за этап: 4 за участие и половина очков (победа +17, десятое место +5, сход +4)
export const prizeFor = (pts) => 4 + Math.round(pts / 2)

// новый сезон: tracks — id трасс игры по порядку календаря; botCount — соперников
export function newSeason({ rounds = 6, laps = 5, level = 'medium', tracks = ['lumen'], botCount = 11 }, rand = Math.random) {
  const first = Math.floor(rand() * tracks.length)
  const calendar = Array.from({ length: rounds }, (_, i) => {
    const track = tracks[(first + i) % tracks.length]
    return { track, night: track === 'marina' }
  })
  const pilots = makePilots(botCount, rand)
  const points = { player: 0 }
  for (let i = 0; i < botCount; i++) points['bot' + i] = 0
  return {
    v: 1,
    rounds,
    laps,
    level,
    calendar,
    round: 0, // сколько этапов уже проехано
    budget: START_BUDGET,
    build: { ...STOCK_BUILD },
    pilots, // по номеру бота: темп и манера на весь сезон
    builds: pilots.map(() => randomBuild(rand)), // сборки соперников (их бюджет — обычный, 100)
    points,
    results: [], // по этапам: { track, order: [id…], pos, pts, prize, dnf }
  }
}

export const isOver = (s) => !!s && s.round >= s.rounds
export const nextRound = (s) => (s && !isOver(s) ? s.calendar[s.round] : null)

// итог этапа: order — порядок финиша [{ id, dnf, dsq }] (как race.state.order). Начисляет очки и призовые, сдвигает этап.
export function applyResult(s, order) {
  let place = 0
  let mine = null
  const ids = []
  for (const c of order) {
    ids.push(c.id)
    const out = c.dnf || c.dsq
    const pts = out ? 0 : POINTS[place] ?? 0
    if (!out) place++
    s.points[c.id] = (s.points[c.id] ?? 0) + pts
    if (c.id === 'player') mine = { pos: out ? null : place, pts, dnf: out }
  }
  mine = mine ?? { pos: null, pts: 0, dnf: true }
  const prize = prizeFor(mine.pts)
  s.budget += prize
  s.results.push({ track: s.calendar[s.round]?.track, order: ids, pos: mine.pos, pts: mine.pts, prize, dnf: mine.dnf })
  s.round++
  return { ...mine, prize, budget: s.budget }
}

// таблица: [{ id, points, wins }] по очкам (при равенстве — по победам)
export function standings(s) {
  const wins = {}
  for (const r of s.results) if (r.order[0]) wins[r.order[0]] = (wins[r.order[0]] ?? 0) + 1
  return Object.entries(s.points)
    .map(([id, points]) => ({ id, points, wins: wins[id] ?? 0 }))
    .sort((a, b) => b.points - a.points || b.wins - a.wins)
}

export function loadSeason() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!s || s.v !== 1 || !Array.isArray(s.calendar)) return null
    s.build = cleanBuild(s.build, s.budget)
    return s
  } catch {
    return null
  }
}
export function saveSeason(s) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s))
    else localStorage.removeItem(KEY)
  } catch {
    // не сохранилось — сезон живёт до перезагрузки
  }
}
