// Проверка онлайн-заезда на время без сети: два игрока (ведёт ИИ), призраки, сессия --minutes мин (можно дробно),
// таблица по лучшему кругу, начатый к концу круг доезжается, сессия кончается.
// Запуск (из папки server/): node quali-check.mjs [--minutes=3]
import { fileURLToPath } from 'node:url'
import RAPIER from '@dimforge/rapier3d-compat'
import { loadTrack } from './track-node.mjs'
import { createQualiSession } from '../src/core/quali-session.js'
import { STEP } from '../src/core/race-session.js'
import { formatTime } from '../src/laps.js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
await RAPIER.init()
const track = loadTrack(fileURLToPath(new URL('../public/models/marina.glb', import.meta.url)))
const s = createQualiSession({ RAPIER, track, seed: 5, minutes: Number(args.minutes ?? 3), humans: [{ id: 'a', name: 'Рома', paint: '#e10600', compound: 'soft' }, { id: 'b', name: 'Друг', paint: '#2bb5c9', compound: 'medium' }] })
s.setAutopilot('a', true)
s.setAutopilot('b', true)
let lastPrint = -1
let overAt = null
while (!s.isOver() && s.time < 20 * 60) {
  s.stepAll({})
  const t = s.table()
  if (t.over && overAt === null) {
    overAt = s.time
    console.log(`время вышло на ${s.time.toFixed(0)} с; доезжают: ${t.rows.filter((r) => !r.done).map((r) => r.name).join(', ') || 'никто'}`)
  }
  if (Math.floor(s.time / 30) !== lastPrint) {
    lastPrint = Math.floor(s.time / 30)
    console.log(`${s.time.toFixed(0)} с · осталось ${t.left.toFixed(0)} с · ${t.rows.map((r) => `${r.name} ${r.best === null ? '—' : formatTime(r.best)} (${r.laps} кр.)`).join(' · ')}`)
  }
}
const rows = s.result()
console.log(`\nсессия окончена на ${s.time.toFixed(0)} с (доезд ${overAt === null ? '—' : (s.time - overAt).toFixed(0) + ' с'})`)
rows.forEach((r, i) => console.log(`  ${i + 1}. ${r.name} — лучший ${r.best === null ? 'нет' : formatTime(r.best)}, кругов ${r.laps}`))
const ok = s.isOver() && rows.some((r) => r.best !== null) && rows[0].best <= (rows[1].best ?? Infinity)
console.log(ok ? 'ЗАЕЗД НА ВРЕМЯ РАБОТАЕТ' : 'НЕ РАБОТАЕТ')
s.dispose()
process.exitCode = ok ? 0 : 1
