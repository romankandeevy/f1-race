// Проверка флагов на сервере: в гонке у бота глохнет мотор → инцидент, нейтрализация (VSC или машина безопасности),
// эвакуатор увозит болид, зелёный флаг. Печатает ход событий и положение машины безопасности.
// Запуск (из папки server/): node flags-check.mjs [--seed=3] [--bot=bot3]
import { fileURLToPath } from 'node:url'
import RAPIER from '@dimforge/rapier3d-compat'
import { loadTrack } from './track-node.mjs'
import { createRaceSession, STEP } from '../src/core/race-session.js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
await RAPIER.init()
const track = loadTrack(fileURLToPath(new URL('../public/models/marina.glb', import.meta.url)))
const s = createRaceSession({ RAPIER, track, seed: Number(args.seed ?? 3), laps: 3, botLevel: 'medium', humans: [{ id: 'p1', name: 'Рома', paint: '#e10600', slot: 11 }] })
s.setAutopilot('p1', true) // игрока ведёт ИИ: под флагами он тоже обязан сбросить скорость
const victim = args.bot ?? 'bot3'
let go = null
let failed = false
let lastMode = 'green'
let scSeen = 0
let removedAt = null
const seen = new Set()
const T = (t) => `${(t - (go ?? 0)).toFixed(1)}с`
for (let i = 0; i < 240 * 240; i++) {
  s.stepAll({})
  if (go === null && !s.waiting) go = s.time
  if (go !== null && !failed && s.time - go > 20) {
    s.failEngine(victim)
    failed = true
    console.log(`${T(s.time)} мотор ${victim} заглох`)
  }
  for (const n of s.takeNews()) {
    if (n.to) continue
    console.log(`${T(s.time)} событие ${n.type}${n.id ? ' ' + n.id : ''}${n.inc ? ' ' + n.inc.id : ''}${n.text ? ': ' + n.text : ''}`)
    seen.add(n.type)
  }
  if (s.flagMode !== lastMode) {
    lastMode = s.flagMode
    console.log(`${T(s.time)} режим: ${lastMode}`)
  }
  const st = s.scState()
  if (st) scSeen++
  if (failed && removedAt === null && !s.cars().some((c) => c.id === victim)) {
    removedAt = s.time
    console.log(`${T(s.time)} ${victim} увезли — его нет в снапшоте`)
  }
  if (failed && removedAt !== null && lastMode === 'green' && s.time - removedAt > 3) break
}
const h = s.human('p1')
console.log(`\nмашина безопасности на трассе: ${(scSeen * STEP).toFixed(1)} с; у игрока потолок сейчас ${isFinite(h.cap) ? (h.cap * 3.6).toFixed(0) + ' км/ч' : 'нет'}`)
const ok = seen.has('incident') && seen.has('tow') && removedAt !== null && (seen.has('sc') || seen.has('vsc')) && seen.has('green')
console.log(ok ? 'ФЛАГИ РАБОТАЮТ: инцидент → нейтрализация → эвакуатор → зелёный' : 'НЕ ВСЁ: ' + [...seen].join(', '))
s.dispose()
process.exitCode = ok ? 0 : 1
