// Онлайн-заезд на время (Рома 30.10): все игроки на трассе одновременно, болиды — призраки (сквозь друг друга, без
// столкновений), сессия N минут, кругов сколько успеешь, в зачёт лучший. Круг, начатый до конца времени, можно доехать
// (как в квалификации F1, но не дольше OVERTIME); круг со срезкой (все колёса за белой линией) не засчитывается. Ботов нет.
// Снаружи — те же методы, что у race-session.js (сервер ведёт оба режима одинаково) плюс table() — таблица лучших кругов.
import { createVehicle, stepVehicle, collectImpacts, setGhost, clearHullOwners } from '../vehicle.js'
import { TUNING } from '../tuning.js'
import { seededRandom } from './rng.js'
import { createLaps } from '../laps.js'
import { createStart } from '../start.js'
import { createLimits, wheelsOut } from '../limits.js'
import { freshTyres, freshDamage, freshPowerUnit, freshBrakes, COMPOUNDS } from '../wear.js'
import { retireReason } from '../stewards.js'
import { createRaceLine, createAiDriver } from '../ai.js'
import { cleanInput, STEP } from './race-session.js'

const OVERTIME = 180 // с после конца сессии: дольше начатый круг не ждём
const WRONG_WAY_RESET = 3 // с против хода — вернуть на трассу
const yawOf = (q) => Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))

export function createQualiSession({ RAPIER, track, seed = 1, minutes = 10, humans }) {
  clearHullOwners()
  const rand = seededRandom(seed)
  const physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  physics.timestep = STEP
  track.attachPhysics(RAPIER, physics)
  const events = new RAPIER.EventQueue(true)
  const gridN = Math.min(12, track.grid.length)
  const length = minutes * 60
  const news = []

  const fresh = (v, compound) => {
    v.compound = COMPOUNDS[compound] ? compound : 'medium'
    v.tyres = freshTyres(80)
    v.damage = freshDamage()
    v.pu = freshPowerUnit()
    v.engineHeat = 0.3
    v.hotTime = 0
    v.brakeTemp = freshBrakes()
    v.brakeHot = false
    v.wet = 0
    v.battery = 1
  }

  const H = humans.slice(0, gridN).map((h, k) => {
    const slot = Math.min(k, gridN - 1)
    const g = track.grid[slot]
    const v = createVehicle(RAPIER, physics, { x: g.x, y: (g.y || 0) + 0.05, z: g.z, yaw: g.yaw }, TUNING)
    v.rand = rand
    fresh(v, h.compound)
    setGhost(v, true) // призраки: болиды друг друга не видят, стены и трасса — как обычно
    return { id: h.id, name: h.name, paint: h.paint, slot, compound: v.compound, v, laps: createLaps(track, 'quali-session'), limits: createLimits(), raw: cleanInput(), auto: null, resetSeen: false, done: false, seen: 0 }
  })
  const byId = new Map(H.map((h) => [h.id, h]))
  const start = createStart([], rand)
  start.begin()

  let tick = 0
  let goAt = null // с: когда погасли огни — с этого момента идёт время сессии
  const time = () => tick * STEP
  const left = () => (goAt === null ? length : Math.max(0, goAt + length - time()))
  const others = (me) =>
    H.filter((h) => h !== me).map((h) => {
      const p = h.v.body.translation()
      return { x: p.x, z: p.z, speed: h.v.state.fwdSpeed }
    })

  function resetToTrack(h, why) {
    const v = h.v
    const p = track.poseNear(v.body.translation().x, v.body.translation().z)
    v.body.setTranslation({ x: p.x, y: (p.y || 0) + 0.1, z: p.z }, true)
    v.body.setRotation({ x: 0, y: Math.sin(p.yaw / 2), z: 0, w: Math.cos(p.yaw / 2) }, true)
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    v.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    v.steerIn = v.steerCmd = v.steerVel = v.delta = 0
    h.laps.invalidate()
    if (why) news.push({ type: 'note', to: h.id, warn: true, text: why })
  }

  function stepAll(inputs = {}) {
    for (const h of H) {
      const raw = inputs[h.id]
      if (!raw) continue
      h.raw = cleanInput(raw)
      // R — вернуться на трассу (круг не в зачёт); по фронту, чтобы держать клавишу было безопасно
      if (raw.reset && !h.resetSeen) resetToTrack(h)
      h.resetSeen = !!raw.reset
    }
    for (const h of H) {
      let input = h.raw
      if (h.auto) {
        const a = start.waiting ? { throttle: 0, brake: 1, steer: 0 } : h.auto.update(h.v, STEP, others(h))
        input = cleanInput({ throttle: a.throttle, brake: a.brake, steer: a.steer, abs: true })
      }
      // время вышло и круг не идёт (или уже закрыт) — болид стоит: сессия для него кончилась
      if (h.done) input = { ...input, throttle: 0, brake: 1, boost: false }
      const cmd = start.hold({ ...input, aeroZone: track.straightZone[h.laps.state.idx] === 1 })
      stepVehicle(h.v, cmd, STEP, track.surfaceAt)
    }
    physics.step(events)
    collectImpacts(events, null, null, physics)
    if (start.waiting) {
      start.update(STEP)
      if (!start.waiting) goAt = time()
    }
    const over = goAt !== null && left() <= 0
    for (const h of H) {
      const v = h.v
      v.events.length = 0
      // разбил болид или заглох мотор — новый на том же месте, круг не в зачёт
      if (!start.waiting && (v.pu.failed || retireReason(v))) {
        fresh(v, h.compound)
        resetToTrack(h, 'Болид разбит — дали новый, круг не засчитан')
      }
      const p = v.body.translation()
      const wasRunning = h.laps.state.running
      const completed = h.laps.state.completed
      h.laps.update(STEP, p.x, p.z, yawOf(v.body.rotation()), v.state.fwdSpeed)
      if (h.laps.state.wrongWay > WRONG_WAY_RESET) resetToTrack(h)
      // срезка: все колёса за белой линией — круг не засчитывается
      if (!start.waiting && h.limits.update(STEP, wheelsOut(track.axis, h.laps.state.idx, v.body, TUNING)) && h.laps.state.running) h.laps.invalidate()
      // время вышло: доезжаем только круг, начатый до конца сессии
      if (over && !h.done) {
        if (h.laps.state.completed !== completed || !h.laps.state.running || (!wasRunning && h.laps.state.running)) h.done = true
        if (time() - (goAt + length) > OVERTIME) h.done = true
      }
    }
    tick++
  }

  // таблица: по лучшему кругу (без круга — в конце); seen — сколько засчитанных кругов
  function rows() {
    return H.map((h) => ({ id: h.id, name: h.name, paint: h.paint, best: h.laps.state.bestLap, last: h.laps.state.lastLap, laps: h.laps.state.completed, done: h.done })).sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity))
  }

  const first = H[0]
  return {
    mode: 'quali',
    step: (raw = {}) => stepAll({ [first.id]: raw }),
    stepAll,
    get tick() {
      return tick
    },
    get time() {
      return time()
    },
    get vehicle() {
      return first.v
    },
    get waiting() {
      return start.waiting
    },
    lights: () => ({ waiting: start.waiting, lit: start.state.lit }),
    roster: () => H.map((h) => ({ id: h.id, name: h.name, paint: h.paint, human: true })),
    human(id) {
      const h = byId.get(id)
      if (!h) return null
      return { v: h.v, slot: h.slot, auto: false, pit: null, retired: false, removed: false, pitRequest: false, autopilot: !!h.auto, lap: h.laps.state, cap: Infinity, banner: null, orange: null }
    },
    setAutopilot(id, on) {
      const h = byId.get(id)
      if (h) h.auto = on ? createAiDriver(createRaceLine(track.axis, 'medium', TUNING, {}), { T: TUNING, zone: track.straightZone }) : null
    },
    cars: () => H.map((h) => ({ id: h.id, v: h.v })),
    takeNews: () => news.splice(0),
    scState: () => null,
    // секунды до конца сессии, идёт ли доезд, лучшие круги
    table: () => ({ minutes, left: left(), started: goAt !== null, over: goAt !== null && left() <= 0, rows: rows() }),
    // сессия окончена: время вышло и все доехали свой последний круг
    isOver: () => goAt !== null && left() <= 0 && H.every((h) => h.done),
    result: () => rows(),
    dispose() {
      physics.free()
    },
  }
}
