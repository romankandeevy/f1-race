// Проверка этапа 3 (_materials/f1-online-ru.md, ворота: «повтор записи ввода даёт тот же итог; расхождение итогов 0»).
// Гонка на сервере (src/core/race-session.js) на трассе из GLB. Игрока ведёт водитель ИИ (ai.js), его ввод пишется по шагам.
// Потом та же гонка идёт заново: с тем же seed (повтор) и по записанному вводу (воспроизведение), и с другим seed (контроль).
// Запуск (из папки server/): node race-check.mjs [--laps=2] [--seed=7]
import { fileURLToPath } from 'node:url'
import RAPIER from '@dimforge/rapier3d-compat'
import { loadTrack } from './track-node.mjs'
import { createRaceSession, STEP } from '../src/core/race-session.js'
import { createRaceLine, createAiDriver, makePilots } from '../src/ai.js'
import { TUNING } from '../src/tuning.js'
import { seededRandom } from '../src/core/rng.js'
import { BOT_COUNT } from '../src/bots.js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const LAPS = Number(args.laps ?? 2)
const SEED = Number(args.seed ?? 7)
const MAX_TICKS = LAPS * 400 / STEP // предохранитель: не дольше 400 с на круг

await RAPIER.init()
const track = loadTrack(fileURLToPath(new URL('../public/models/marina.glb', import.meta.url)))

// одна гонка: driver — водитель игрока (ИИ), replay — записанный ввод по шагам (вместо водителя)
function run({ seed, replay = null }) {
  const session = createRaceSession({ RAPIER, track, seed, laps: LAPS, botLevel: 'medium', slot: BOT_COUNT })
  const driver = replay
    ? null
    : createAiDriver(createRaceLine(track.axis, 'medium', TUNING, makePilots(1, seededRandom(seed + 1000))[0]), { T: TUNING, zone: track.straightZone })
  const log = []
  while (!session.isOver() && session.tick < MAX_TICKS) {
    let raw
    if (replay) raw = replay[session.tick]
    else {
      // на огнях водитель не нужен: болид держат тормоза (как бот на решётке); потом ведёт ИИ
      if (session.waiting) raw = { throttle: 0, brake: 1, steer: 0, abs: true }
      else {
        const i = driver.update(session.vehicle, STEP, session.others())
        raw = { throttle: i.throttle, brake: i.brake, steer: i.steer, abs: i.abs }
      }
      log.push(raw)
    }
    session.step(raw)
  }
  const result = session.result()
  const ticks = session.tick
  session.dispose()
  return { result, log, ticks }
}

const t0 = Date.now()
const a = run({ seed: SEED })
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`гонка: ${LAPS} круга, seed ${SEED}, шагов ${a.ticks} (${(a.ticks * STEP).toFixed(1)} с физики), сек. на расчёт ${elapsed}`)
for (const r of a.result) {
  const status = r.dsq ? `ДСК: ${r.reason ?? "правило двух составов"}` : r.dnf ? `сход: ${r.reason}` : r.finished ? `финиш ${r.finishTime.toFixed(2)} с` : 'не финишировал'
  console.log(`  ${String(r.pos).padStart(2)}. ${r.id.padEnd(8)} круг ${r.lap}  штраф ${r.penalty} с  ${status}  пит-стопов ${r.stops}`)
}

const b = run({ seed: SEED, replay: a.log })
const c = run({ seed: SEED })
const d = run({ seed: SEED + 1 })
const same = (x, y) => JSON.stringify(x.result) === JSON.stringify(y.result) && x.ticks === y.ticks

console.log('\nповтор с тем же seed:        ', same(a, c) ? 'совпадает' : 'РАСХОЖДЕНИЕ')
console.log('воспроизведение по записи:   ', same(a, b) ? 'совпадает' : 'РАСХОЖДЕНИЕ')
console.log('другой seed (контроль):      ', same(a, d) ? 'итог тот же — подозрительно' : 'итог другой, как и должно быть')
const ok = same(a, b) && same(a, c)
console.log(ok ? '\nВОРОТА ПРОЙДЕНЫ: расхождение итогов 0' : '\nВОРОТА НЕ ПРОЙДЕНЫ')
process.exitCode = ok ? 0 : 1
