// Гонка для сервера (и для проверок в Node): то же, что main.js в гонке с ботами, без картинки, звука и клавиатуры.
// Одна гонка — один мир физики и один ГПСЧ (seed). Живых игроков сколько угодно (онлайн), боты — на свободных местах
// решётки (всего 12 болидов). Ввод игроков приходит по шагам 1/240 с, боты решают раз в 4 шага.
// Есть: огни старта, боты, круги, границы трассы, пит-стоп (заказ и автопилот у въезда), стюарды (контакты, наказания),
// сход, чёрно-оранжевый флаг, классификация, автопилот игрока (обрыв связи — болид едет сам), флаги (жёлтые, VSC,
// машина безопасности, красный с рестартом), эвакуатор, отказ мотора у бота — как в main.js. Машина безопасности и эвакуатор
// считаются те же (safetycar.js, tow.js) с пустой сценой; клиенту — события (takeNews) и положение машины безопасности.
// Несколько гонок в одном процессе можно: удары разбираются по своему миру физики (collectImpacts(…, physics)).
import * as THREE from 'three'
import { createVehicle, stepVehicle, collectImpacts, setGhost, clearHullOwners } from '../vehicle.js'
import { createFlags, VSC_SPEED } from '../flags.js'
import { createSafetyCar } from '../safetycar.js'
import { createTow } from '../tow.js'
import { TUNING } from '../tuning.js'
import { seededRandom } from './rng.js'
import { createBots, BOT_COUNT } from '../bots.js'
import { createRace, RACE_LAPS } from '../race.js'
import { createLaps } from '../laps.js'
import { createStart } from '../start.js'
import { createLimits, wheelsOut } from '../limits.js'
import { createPitLane, createPitStop, pitEntryHit, pitLimiter, defaultPlan } from '../pit.js'
import { freshTyres, freshDamage, freshPowerUnit, freshBrakes, setFuel, fuelForRace, COMPOUNDS } from '../wear.js'
import { retireReason, mechanicalFlag, judgeContact, contactPenalty, ORANGE_LAPS, nextPenalty, DRIVE_LAPS, DRIVE_LATE } from '../stewards.js'
import { createRaceLine, createAiDriver } from '../ai.js'
import { buildTuning, cleanBuild, STOCK_BUILD } from '../build.js'
import { SETUP_DEFAULT } from '../tuning.js'

export const STEP = 1 / 240 // шаг физики, как в main.js
export const CARS = BOT_COUNT + 1 // болидов в гонке: 12
const WINDOW = 4 // шагов на одно окно: боты решают 60 раз в секунду
const PIT_TAKEOVER = [100, 25] // м до въезда: автопилот берёт руль (как у ботов)
const PIT_NEAR = 4 // м за край пит-лейна: пересечение белой линии при въезде и выезде не считается
const PIT_GRACE = 8 // с после пит-стопа: выезд из пит-лейна не считается нарушением границ
const WRONG_WAY_RESET = 3 // с: против хода гонки — вернуть на трассу
const LIMIT_WARNINGS = 3
const LIMIT_PENALTY = 5 // с к гонке за выезд после предупреждений
const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: false, abs: false, aero: false, aeroZone: false, boost: false, ersMode: 'balanced', hold: false }
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))
const clampSteer = (x) => Math.max(-1, Math.min(1, Number(x) || 0))
const yawOf = (q) => Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
const BOT_FAIL_CHANCE = 0.45 // как в main.js: в гонке от 2 кругов у случайного бота отказывает мотор (инцидент → SC или VSC)
const NO_SCENE = { add() {}, remove() {} } // машина безопасности и эвакуатор на сервере — без картинки
const FLAG_TICK = 0.25 // с: флаги решают 4 раза в секунду
const PASS_PENALTY = 5 // с: обгон под флагом

// ограничитель под флагами (как у игрока в main.js; клиент повторяет его в предсказании): cap — м/с, speed — скорость вперёд
// настройка болида игрока из сети: только известные поля и только числа, остальное — по умолчанию
export function cleanSetup(raw) {
  const out = { ...SETUP_DEFAULT }
  if (raw && typeof raw === 'object') for (const k of Object.keys(SETUP_DEFAULT)) if (Number.isFinite(Number(raw[k]))) out[k] = Number(raw[k])
  return out
}

export function capInput(cmd, speed, cap) {
  cmd.boost = false
  cmd.aero = false
  if (cap <= 0) {
    cmd.throttle = 0
    cmd.brake = Math.max(cmd.brake, speed > 1 ? 0.8 : 0.3)
  } else {
    if (speed > cap - 1) cmd.throttle = 0
    if (speed > cap + 1) cmd.brake = Math.max(cmd.brake, Math.min(1, (speed - cap) * 0.25))
  }
  return cmd
}

// ввод игрока из сети/записи → полный ввод физики (лишнее отбрасываем, диапазоны режем)
export function cleanInput(raw = {}) {
  return {
    ...NEUTRAL,
    throttle: clamp01(raw.throttle),
    brake: clamp01(raw.brake),
    steer: clampSteer(raw.steer),
    abs: !!raw.abs,
    aero: !!raw.aero,
    boost: !!raw.boost,
    ersMode: TUNING.ersModes[raw.ersMode] ? raw.ersMode : 'balanced',
  }
}

// track — из server/track-node.mjs (или circuit.js в браузере).
// humans — [{ id, name, paint, slot, compound, build, setup }]: живые игроки, их места на решётке (0 — поул), сборка болида
// (build.js) и настройка. Без него — один игрок 'player' на месте slot (проверки в Node, race-check).
// builds — сборки включены (свои у игроков, случайные у ботов); выключены — у всех стандартный болид
export function createRaceSession({ RAPIER, track, seed = 1, laps: lapCount = RACE_LAPS, botLevel = 'medium', humans = null, slot = BOT_COUNT, compound = 'medium', paint = '#e9e6df', builds = false }) {
  clearHullOwners() // общий список (для браузера) серверу не нужен — не копим в нём болиды прошлых гонок
  const rand = seededRandom(seed)
  const physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  physics.timestep = STEP
  track.attachPhysics(RAPIER, physics)
  const events = new RAPIER.EventQueue(true)
  const lane = track.pit ? createPitLane(track.pit, track.axis) : null
  const L = track.length
  // где на оси трассы начинается пит-лейн
  let entryS = null
  if (lane) {
    let bd = Infinity
    for (const a of track.axis) {
      const d = (a.x - lane.axis[0].x) ** 2 + (a.z - lane.axis[0].z) ** 2
      if (d < bd) {
        bd = d
        entryS = a.distance_m
      }
    }
  }

  // места на решётке: свои у игроков, остальные (по порядку) — ботам
  const gridN = Math.min(CARS, track.grid.length)
  const people = (humans ?? [{ id: 'player', name: 'ТЫ', paint, slot, compound }]).slice(0, gridN)
  const taken = new Set()
  for (const h of people) {
    let s = Math.min(Math.max(0, h.slot ?? gridN - 1), gridN - 1)
    while (taken.has(s)) s = (s + 1) % gridN
    taken.add(s)
    h.slot = s
  }
  const botSlots = [...Array(gridN).keys()].filter((i) => !taken.has(i))
  // числа физики игрока: его сборка (если сборки включены) и его настройка болида (крылья, подвеска…)
  const tuningOf = (h) => buildTuning(builds ? cleanBuild(h.build) : STOCK_BUILD, cleanSetup(h.setup))
  const tank = fuelForRace(lapCount, track.length)

  const H = people.map((h, k) => {
    const g = track.grid[h.slot]
    const v = createVehicle(RAPIER, physics, { x: g.x, y: (g.y || 0) + 0.05, z: g.z, yaw: g.yaw }, tuningOf(h))
    v.rand = rand
    v.compound = COMPOUNDS[h.compound] ? h.compound : 'medium'
    v.tyres = freshTyres(80)
    v.damage = freshDamage()
    v.pu = freshPowerUnit()
    v.engineHeat = 0.3
    v.hotTime = 0
    v.brakeTemp = freshBrakes()
    v.brakeHot = false
    v.wet = 0
    v.battery = 1
    setFuel(v, tank)
    return {
      id: h.id,
      name: h.name,
      paint: h.paint,
      slot: h.slot,
      v,
      box: botSlots.length + k, // боксы 0…боты−1 у ботов, дальше — игроков
      laps: createLaps(track, 'race-session'),
      limits: createLimits(),
      pitCtl: null,
      pitRequest: false,
      pitPlan: defaultPlan(v, lapCount),
      pitSince: -1e9, // с: когда закончился пит-стоп
      ghostUntil: 0, // с: призрак после возврата на трассу
      retired: false,
      orange: null, // чёрно-оранжевый флаг: { reason, lap }
      drive: null, // штраф «проезд по пит-лейну»: { lap, why }
      book: { count: 0 }, // штрафов за гонку (каждый третий — проезд, stewards.js)
      raw: cleanInput(),
      auto: null, // водитель ИИ, пока игрок без связи (автопилот)
      gap: 1000, // м до болида впереди по трассе (коридор под машиной безопасности)
      cap: Infinity, // м/с: потолок скорости под флагами сейчас
      prevAhead: null, // кто был впереди при флагах: обогнал — штраф
      lastPass: -1e9,
      removed: false, // эвакуатор увёз
      banner: null, // табло флагов для этого игрока: [текст, вид]
    }
  })
  const byHuman = new Map(H.map((h) => [h.id, h]))

  const bots = createBots({ RAPIER, world: physics, track, lane, rand, builds })
  bots.spawn(botLevel, botSlots.map((i) => track.grid[i]))
  for (const b of bots.list) setFuel(b.v, tank)

  const race = createRace(
    track.length,
    [...H.map((h) => ({ id: h.id, name: h.name, player: true, paint: h.paint, compound: h.v.compound })), ...bots.list.map((b) => ({ id: b.id, name: b.name, paint: b.paint, compound: b.v.compound }))],
    lapCount,
  )
  const start = createStart([], rand)
  start.begin()

  // флаги, машина безопасности, эвакуатор (как в main.js; картинки нет — сцена пустая)
  const sc = lane ? createSafetyCar(NO_SCENE, track.axis, track.length, lane) : null
  const flags = createFlags(track.axis, track.length, { safetyCar: !!sc })
  const tow = createTow(NO_SCENE, track.axis, track.length)
  let flagAcc = 0
  let redGrid = null // порядок и круг лидера в момент красного флага
  const news = [] // события для клиентов: { type, text, id?, inc?, to? }
  let botFail = null // { id, at — пройденные лидером метры }
  if (lapCount >= 2 && bots.list.length && rand() < BOT_FAIL_CHANCE) {
    const b = bots.list[Math.floor(rand() * bots.list.length)]
    botFail = { id: b.id, at: (0.3 + rand() * (lapCount - 0.8)) * track.length }
  }

  const ctx = {
    laps: race.state.laps,
    lapOf: (id) => race.car(id).lap,
    onPit: (id, c) => race.pitStop(id, c),
    onRetire: (id, why) => race.retire(id, why),
    limit: (b) => botLimit(b),
    hold: () => flags.mode === 'red',
  }

  let tick = 0
  const contactSeen = new Map() // пара болидов → когда стюарды уже разбирали контакт (раз в 4 с)
  const time = () => tick * STEP
  const idOf = (v) => H.find((h) => h.v === v)?.id ?? bots.list.find((b) => b.v === v)?.id
  const lapsLeft = (h) => Math.max(0, race.state.laps - race.car(h.id).lap)
  const nearPitLane = (x, z) => !!lane && lane.near(x, z, PIT_NEAR)
  const posOf = (h) => {
    const p = h.v.body.translation()
    return { x: p.x, z: p.z, speed: h.v.state.fwdSpeed }
  }
  // соперники для водителя ИИ (автопилот игрока, проверки): все, кроме этого болида
  const othersOf = (me) => [
    ...H.filter((h) => h !== me).map(posOf),
    ...bots.list.filter((b) => !b.gone).map((b) => ({ x: b.v.body.translation().x, z: b.v.body.translation().z, speed: b.v.state.fwdSpeed })),
  ]

  // ---------- флаги (как в main.js) ----------
  const botOf = (id) => bots.list.find((b) => b.id === id)
  const sOfId = (id) => (byHuman.has(id) ? byHuman.get(id).laps.state.s : bots.distanceOf(botOf(id)))
  // лидер гонки среди тех, кто на трассе (не в боксах и не сошёл): за ним держится машина безопасности
  const raceLead = () => race.state.order.find((c) => !c.dnf && !c.inPit) ?? null
  // лидеру нельзя догнать машину безопасности: зазор и её скорость
  const scAhead = (id) => {
    const lead = raceLead()
    if (!sc || lead?.id !== id) return null
    const gap = sc.gapFrom(lead.s)
    return gap === null ? null : { gap, speed: sc.speed }
  }
  // зазор по трассе до ближайшего болида впереди — физически, а не по порядку гонки
  function physGap(s, selfId) {
    let best = Infinity
    const test = (s2) => {
      const d = (((s2 - s) % L) + L) % L
      if (d > 0.5 && d < best) best = d
    }
    for (const h of H) if (h.id !== selfId && !h.retired && !h.pitCtl && !h.removed) test(h.laps.state.s)
    for (const b of bots.list) if (b.id !== selfId && !b.gone && !b.retired && !b.pit) test(bots.distanceOf(b))
    return best === Infinity ? 1000 : best
  }
  function botLimit(b) {
    if (flags.mode === 'green' && !flags.incidents.length) return null
    const s = bots.distanceOf(b)
    return { cap: flags.botCap(s, physGap(s, b.id), scAhead(b.id)), noPass: flags.noPass(s), redPit: flags.mode === 'red' }
  }
  const vehicleOf = (id) => byHuman.get(id)?.v ?? botOf(id)?.v
  // эвакуатор поднял болид: физика выключена; увёз — болида больше нет на трассе
  function liftCar(id) {
    const h = byHuman.get(id)
    if (h) h.v.body.setEnabled(false)
    else bots.lift(id)
  }
  function removeCar(id) {
    const h = byHuman.get(id)
    if (h) {
      h.v.body.setEnabled(false)
      h.removed = true
    } else bots.remove(id)
  }
  // эвакуатор: тот же tow.js, что у клиента (те же фазы и длительности), — болид исчезает, когда у всех кран его увёз
  function dispatchTow(inc) {
    const obj = new THREE.Group() // кран двигает «болид»; на сервере это пустышка на месте болида
    const v = vehicleOf(inc.id)
    if (v) {
      const t = v.body.translation()
      const q = v.body.rotation()
      obj.position.set(t.x, t.y, t.z)
      obj.quaternion.set(q.x, q.y, q.z, q.w)
    }
    tow.dispatch(inc, { object: () => obj, lift: () => liftCar(inc.id), loaded: () => flags.clear(inc.id), done: () => removeCar(inc.id) })
  }
  // красный флаг кончился: болиды (кроме сошедших) на решётку в порядке гонки, огни старта
  function restartFromGrid() {
    const order = (redGrid ? redGrid.ids.map((id) => race.car(id)) : race.state.order).filter((c) => c && !c.dnf)
    if (!order.length) return
    const lap = redGrid ? redGrid.lap : order[0].lap
    redGrid = null
    order.forEach((c, i) => {
      const p = track.grid[Math.min(i, track.grid.length - 1)]
      const h = byHuman.get(c.id)
      if (h) {
        const v = h.v
        v.body.setTranslation({ x: p.x, y: (p.y || 0) + 0.05, z: p.z }, true)
        v.body.setRotation({ x: 0, y: Math.sin(p.yaw / 2), z: 0, w: Math.cos(p.yaw / 2) }, true)
        v.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
        v.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
        v.steerIn = v.steerCmd = v.steerVel = v.delta = 0
        v.throttle = v.brake = 0
        h.pitCtl = null
        h.pitRequest = false
        h.pitSince = time()
        h.prevAhead = null
        h.pitPlan = defaultPlan(v, lapsLeft(h))
        h.laps.restart()
      } else bots.regrid(c.id, p)
    })
    race.regrid(lap)
    sc?.hide()
    start.begin()
  }
  function onFlagEvent(ev) {
    if (ev.type === 'incident') news.push({ type: 'incident', id: ev.inc.id, text: ev.text })
    else if (ev.type === 'tow') {
      dispatchTow(ev.inc)
      news.push({ type: 'tow', inc: { id: ev.inc.id, s: ev.inc.s, l: ev.inc.l } })
    } else if (ev.type === 'clear-all') {
      const ids = flags.incidents.map((i) => i.id)
      for (const id of ids) removeCar(id)
      tow.clear()
      news.push({ type: 'clear-all', ids })
    } else if (ev.type === 'sc') {
      sc?.deploy(raceLead()?.s ?? null)
      news.push({ type: 'sc', text: ev.text })
    } else if (ev.type === 'red') {
      const ord = race.state.order.filter((c) => !c.dnf)
      redGrid = { ids: ord.map((c) => c.id), lap: ord[0]?.lap ?? 0 }
      sc?.hide()
      // все в боксы — игроков тоже заводит автопилот у въезда
      for (const h of H) {
        if (h.retired || h.pitCtl) continue
        h.pitPlan = defaultPlan(h.v, Math.max(1, lapsLeft(h)))
        h.pitRequest = true
      }
      news.push({ type: 'red', text: ev.text })
    } else if (ev.type === 'restart') {
      restartFromGrid()
      news.push({ type: 'restart', text: ev.text })
    } else if (ev.type === 'green') {
      sc?.hide()
      news.push({ type: 'green', text: ev.text })
    } else if (ev.text) news.push({ type: ev.type, text: ev.text })
  }
  // табло флагов для игрока (как в main.js): [текст, вид] или null
  function bannerOf(h) {
    const sMe = h.laps.state.s
    if (flags.mode === 'red') {
      const info = flags.redInfo()
      return [!info.allIn ? (h.pitCtl ? 'Красный флаг · в боксах · ждём остальных' : 'Красный флаг · езжай в боксы') : `Красный флаг · старт с места через ${Math.ceil(info.left)} с`, 'red']
    }
    if (flags.mode === 'sc') return [flags.ending() ? 'Машина безопасности заходит в боксы · зелёный флаг, когда она зайдёт' : `Машина безопасности · лимит ${Math.round(flags.cap(sMe, h.gap, scAhead(h.id)) * 3.6)} км/ч · обгон запрещён`, 'sc']
    if (flags.mode === 'vsc') return [`Виртуальная машина безопасности · лимит ${Math.round(VSC_SPEED * 3.6)} км/ч`, 'vsc']
    if (flags.inYellow(sMe)) {
      const d = flags.nextIncident(sMe)
      return [`Жёлтый флаг · ${d !== null ? `остановившийся болид через ${Math.round(d)} м` : 'остановившийся болид рядом'} · обгон запрещён`, '']
    }
    return null
  }
  // раз в FLAG_TICK: инциденты, машина безопасности, эвакуатор, обгон под флагом у игроков
  function flagTick(dt) {
    const cars = [
      ...H.filter((h) => !h.removed).map((h) => {
        const p = h.v.body.translation()
        return { id: h.id, x: p.x, z: p.z, speed: Math.abs(h.v.state.fwdSpeed), retired: h.retired, inPit: !!h.pitCtl, parked: h.pitCtl?.state.phase === 'service' || h.pitCtl?.state.phase === 'release' }
      }),
      ...bots.list.filter((b) => !b.gone).map((b) => ({ id: b.id, x: b.v.body.translation().x, z: b.v.body.translation().z, speed: Math.abs(b.v.state.fwdSpeed), retired: !!b.retired, inPit: !!b.pit, parked: b.pit?.state.phase === 'service' || b.pit?.state.phase === 'release' })),
    ]
    for (const ev of flags.update(dt, cars)) onFlagEvent(ev)
    const order = race.state.order
    for (const h of H) {
      h.gap = physGap(h.laps.state.s, h.id)
      h.banner = bannerOf(h)
      const mei = order.findIndex((c) => c.id === h.id)
      const flagged = flags.mode !== 'green' || flags.noPass(h.laps.state.s)
      if (flagged && !h.retired && mei >= 0) {
        const ahead = new Set(order.slice(0, mei).filter((c) => !c.dnf && !c.inPit).map((c) => c.id))
        if (h.prevAhead) {
          for (const id of h.prevAhead) {
            if (!ahead.has(id) && !race.car(id).dnf && !race.car(id).inPit && time() - h.lastPass > 10) {
              h.lastPass = time()
              penalize(h, PASS_PENALTY, `обгон ${race.car(id).name} под флагом`, true)
            }
          }
        }
        h.prevAhead = ahead
      } else h.prevAhead = null
    }
  }

  function judgeContactPair(a, b) {
    if (!race.state.running) return
    const ia = idOf(a)
    const ib = idOf(b)
    if (!ia || !ib) return
    const key = ia < ib ? ia + '|' + ib : ib + '|' + ia
    const now = time()
    if (now - (contactSeen.get(key) ?? -1e9) < 4) return
    const j = judgeContact(a, b)
    if (j.closing < 4) return // касание бортами: не разбираем
    contactSeen.set(key, now)
    const pen = contactPenalty(j.closing)
    if (!j.fault || !pen) return
    const fh = byHuman.get(idOf(j.fault))
    if (fh) penalize(fh, pen, `столкновение с ${race.car(fh.id === ia ? ib : ia).name}`, true)
    else race.addPenalty(idOf(j.fault), pen)
  }

  // штраф игроку: секунды — или каждый третий за гонку проезд по пит-лейну (как в одиночной игре, stewards.js)
  function penalize(h, sec, why, say) {
    const me = race.car(h.id)
    if (me.finished) return
    const kind = nextPenalty(h.book, !!h.drive, race.state.laps - me.lap)
    if (kind === 'drive') {
      h.drive = { lap: me.lap, why }
      news.push({ type: 'note', to: h.id, warn: true, text: `Стюарды: ${why} · повторное нарушение — проезд по пит-лейну за ${DRIVE_LAPS} кр. (L), иначе дисквалификация` })
      return
    }
    if (kind === 'late') {
      race.addPenalty(h.id, DRIVE_LATE)
      news.push({ type: 'note', to: h.id, warn: true, text: `Стюарды: ${why} · повторное нарушение — проезд по пит-лейну, до финиша не успеть: +${DRIVE_LATE} с` })
      return
    }
    race.addPenalty(h.id, sec)
    if (say) news.push({ type: 'note', to: h.id, warn: true, text: `Стюарды: ${why} · штраф +${sec} с` })
  }

  function endRun(h, reason, kind = 'dnf') {
    if (h.retired) return
    h.retired = true
    h.pitCtl = null
    h.pitRequest = false
    h.orange = null
    h.drive = null
    if (kind === 'dsq') race.disqualify(h.id, reason)
    else race.retire(h.id, reason)
  }

  function resetToTrack(h) {
    const v = h.v
    const p = track.poseNear(v.body.translation().x, v.body.translation().z)
    v.body.setTranslation({ x: p.x, y: (p.y || 0) + 0.1, z: p.z }, true)
    v.body.setRotation({ x: 0, y: Math.sin(p.yaw / 2), z: 0, w: Math.cos(p.yaw / 2) }, true)
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    v.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    v.steerIn = v.steerCmd = v.steerVel = 0
    v.delta = 0
    h.laps.invalidate()
    setGhost(v, true)
    h.ghostUntil = time() + 3
  }

  // команда игрока на этот шаг: в пит-лейне ведёт пит-стоп, на старте педали заперты огнями, сошедший катится
  function commandOf(h) {
    const v = h.v
    let input = h.raw
    if (h.auto && !h.retired) {
      const a = start.waiting ? { throttle: 0, brake: 1, steer: 0 } : h.auto.update(v, STEP, othersOf(h))
      input = cleanInput({ throttle: a.throttle, brake: a.brake, steer: a.steer, abs: true })
    }
    input = { ...input, aeroZone: track.straightZone[h.laps.state.idx] === 1 }
    // въезд в пит-лейн: заказ — автопилот у въезда; без заказа — тоже, если сам заехал. Только в гонке после линии старта
    const open = race.state.running && h.laps.state.lap >= 1
    if (lane && !h.pitCtl && !start.waiting && open && !v.pu.failed && !h.retired) {
      const p = v.body.translation()
      const toEntry = entryS === null ? Infinity : (entryS - track.axis[h.laps.state.idx].distance_m + L) % L
      if ((h.pitRequest && toEntry < PIT_TAKEOVER[0] && toEntry > PIT_TAKEOVER[1]) || pitEntryHit(lane, p.x, p.z, yawOf(v.body.rotation()))) {
        // ждёт проезд по пит-лейну — этот заезд и есть проезд (без остановки); чёрно-оранжевый флаг важнее — сначала ремонт
        h.pitCtl = createPitStop(lane, h.box, { ...h.pitPlan }, { player: true, auto: true, T: v.T, damage: v.damage, hold: () => flags.mode === 'red', rand, drive: !!h.drive && !h.orange })
        h.pitRequest = false
        input.aero = false
      }
    }
    let cmd
    if (h.pitCtl) {
      const phase = h.pitCtl.state.phase
      cmd = h.pitCtl.update(v, STEP, input.throttle > 0.5) || pitLimiter(h.pitCtl, v, input)
      if (phase === 'service' && h.pitCtl.state.phase === 'release') {
        race.pitStop(h.id, v.compound)
        h.orange = null
      }
    } else cmd = start.hold({ ...input })
    // машина безопасности, VSC, красный флаг: ограничитель скорости (в F1 это делает сам пилот по дельте)
    h.cap = Infinity
    if (race.state.running && !h.retired && !h.pitCtl && flags.mode !== 'green') {
      h.cap = flags.cap(h.laps.state.s, h.gap, scAhead(h.id))
      cmd = capInput({ ...cmd }, v.state.fwdSpeed, h.cap)
    }
    if (h.retired) cmd = { ...cmd, throttle: 0, brake: v.state.fwdSpeed > 1 ? 0.5 : 0.15, steer: 0, boost: false, aero: false, handbrake: false, hold: true }
    v.autopilot = !!h.pitCtl
    return cmd
  }

  // после шага физики: отказы, сход, флаг, круги, границы, пит-стоп закончен
  function afterStep(h) {
    const v = h.v
    for (const e of v.events) if (/Отказ/.test(e)) endRun(h, e.replace(/^Отказ силовой установки:?\s*/, '') || 'Отказ силовой установки')
    v.events.length = 0
    if (!h.retired && !start.waiting) {
      const why = retireReason(v)
      if (why) endRun(h, why)
    }
    if (race.state.running && !h.retired) {
      const me = race.car(h.id)
      const flag = mechanicalFlag(v)
      if (flag && !h.orange && !h.pitCtl) h.orange = { reason: flag, lap: me.lap }
      if (h.orange && !flag) h.orange = null
      if (h.orange && ORANGE_LAPS - (me.lap - h.orange.lap) <= 0 && !h.pitCtl) endRun(h, 'небезопасный болид не заехал в боксы', 'dsq')
      else if (h.drive && !h.orange && DRIVE_LAPS - (me.lap - h.drive.lap) <= 0 && !h.pitCtl) endRun(h, 'не отбыл проезд по пит-лейну', 'dsq')
    }
    const p = v.body.translation()
    h.laps.update(STEP, p.x, p.z, yawOf(v.body.rotation()), v.state.fwdSpeed)
    if (!h.pitCtl && h.laps.state.wrongWay > WRONG_WAY_RESET) resetToTrack(h)
    if (h.ghostUntil && time() > h.ghostUntil && !h.pitCtl) {
      const near = othersOf(h).some((o) => Math.hypot(o.x - p.x, o.z - p.z) < 6)
      if (!near) {
        h.ghostUntil = 0
        setGhost(v, false)
      } else h.ghostUntil = time() + 0.3
    }
    const inPitArea = !!h.pitCtl || h.pitRequest || time() - h.pitSince < PIT_GRACE || nearPitLane(p.x, p.z)
    if (!start.waiting && h.limits.update(STEP, !inPitArea && wheelsOut(track.axis, h.laps.state.idx, v.body, TUNING))) {
      const me = race.car(h.id)
      if (h.limits.state.strikes > LIMIT_WARNINGS && race.state.running && !me.finished) penalize(h, LIMIT_PENALTY, 'границы трассы', false)
    }
    if (h.pitCtl?.state.phase === 'done' || h.pitCtl?.state.phase === 'abort') {
      if (h.pitCtl.state.phase === 'done' && h.pitCtl.state.drive && h.drive) {
        h.drive = null
        news.push({ type: 'note', to: h.id, text: 'Штраф отбыт: проезд по пит-лейну' })
      }
      h.pitSince = time()
      h.pitCtl = null
      h.pitPlan = defaultPlan(v, lapsLeft(h))
    }
  }

  // один шаг физики. inputs — { id: ввод } для каждого игрока (кого нет — едет с прошлым вводом)
  function stepAll(inputs = {}) {
    for (const h of H) {
      const raw = inputs[h.id]
      if (!raw) continue
      h.raw = cleanInput(raw)
      if (!h.pitCtl && raw.pitRequest !== undefined) h.pitRequest = !!raw.pitRequest || flags.mode === 'red' // красный — в боксы всем
      if (raw.plan && COMPOUNDS[raw.plan.compound]) h.pitPlan = { compound: raw.plan.compound, wing: !!raw.plan.wing }
    }
    // боты решают раз в окно (60 Гц), едут на каждом шаге
    if (tick % WINDOW === 0) bots.think(STEP * WINDOW, H.map(posOf), start.waiting ? start.hold : null, !start.waiting, ctx)
    const cmds = H.map(commandOf)
    H.forEach((h, k) => stepVehicle(h.v, cmds[k], STEP, track.surfaceAt))
    bots.step(STEP, track.surfaceAt, 0)
    physics.step(events)
    collectImpacts(
      events,
      () => {},
      (a, b) => judgeContactPair(a, b),
      physics,
    )
    if (start.waiting) {
      start.update(STEP)
      if (!start.waiting) race.go()
    }
    for (const h of H) afterStep(h)

    // классификация: состав и «в боксах» для таблицы, затем продвижение гонки
    const botById = new Map(bots.list.map((b) => [b.id, b]))
    for (const c of race.state.cars) {
      const h = byHuman.get(c.id)
      if (h) {
        c.compound = h.v.compound
        c.inPit = !!h.pitCtl
      } else {
        const b = botById.get(c.id)
        c.compound = b.v.compound
        c.inPit = !!b.pit
      }
    }
    race.update(STEP, (c) => (byHuman.has(c.id) ? byHuman.get(c.id).laps.state.s : bots.distanceOf(botById.get(c.id))))

    // флаги: отказ мотора у бота (в случайный момент гонки), раз в FLAG_TICK — инциденты и нейтрализация;
    // машина безопасности и эвакуатор — каждый шаг
    if (race.state.running && botFail) {
      const lead = race.state.order[0]
      const leadDone = lead && lead.lap >= 1 ? lead.progress - track.length : -1
      if (leadDone >= botFail.at) {
        const b = botOf(botFail.id)
        if (b && !b.gone && !b.retired && !b.pit) b.v.pu.failed = true
        botFail = b?.pit ? { ...botFail, at: botFail.at + 400 } : null // в боксах — откажет чуть позже, на трассе
      }
    }
    flagAcc = start.waiting ? 0 : flagAcc + STEP
    if (race.state.running && !start.waiting && flagAcc > FLAG_TICK) {
      flagTick(flagAcc)
      flagAcc = 0
    }
    if (sc?.active && sc.update(STEP, raceLead()?.s ?? null, flags.ending())) {
      flags.scHome()
      news.push({ type: 'note', text: 'Машина безопасности зашла в боксы' })
    }
    tow.update(STEP)
    tick++
  }

  const first = H[0]
  return {
    // один игрок (проверки): шаг с его вводом
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
    get race() {
      return race
    },
    get bots() {
      return bots
    },
    // огни старта горят: болиды стоят на решётке, педали не работают
    get waiting() {
      return start.waiting
    },
    lights: () => ({ waiting: start.waiting, lit: start.state.lit }),
    // состав гонки для клиентов: id, имя, цвет, живой ли игрок
    roster: () => race.state.cars.map((c) => ({ id: c.id, name: c.name, paint: c.paint, human: !!c.player })),
    // игрок: его болид и что с ним сейчас (auto — едет не по вводу игрока: пит-стоп или сход)
    human(id) {
      const h = byHuman.get(id)
      if (!h) return null
      const orange =
        h.orange && race.state.running
          ? `Чёрно-оранжевый флаг · ${h.orange.reason} · в боксы (L) · осталось ${Math.max(0, ORANGE_LAPS - (race.car(h.id).lap - h.orange.lap))} кр.`
          : h.drive && race.state.running
            ? `Проезд по пит-лейну · ${h.drive.why} · в боксы (L) · осталось ${Math.max(0, DRIVE_LAPS - (race.car(h.id).lap - h.drive.lap))} кр.`
            : null
      return { v: h.v, slot: h.slot, auto: !!h.pitCtl || h.retired, pit: h.pitCtl?.state.phase ?? null, retired: h.retired, removed: h.removed, pitRequest: h.pitRequest, autopilot: !!h.auto, lap: h.laps.state, cap: h.cap, banner: h.banner, orange }
    },
    // события для клиентов с прошлого раза (флаги, эвакуатор, штрафы) — забрать и очистить
    takeNews() {
      return news.splice(0)
    },
    // машина безопасности: фаза и место по оси трассы — клиент ставит свою картинку туда же (null — её нет на трассе)
    scState() {
      if (!sc || !sc.active) return null
      const s = sc.state
      return { phase: s.phase, s: s.s, l: s.l, v: s.v, t: s.t, armed: s.armed }
    },
    get flagMode() {
      return flags.mode
    },
    // настройку болида игрок поменял по ходу (баланс тормозов, дифференциал — быстрые клавиши): её же считает и сервер
    setSetup(id, setup) {
      const h = byHuman.get(id)
      if (h) Object.assign(h.v.T.setup, cleanSetup(setup))
    },
    // проверки: остановить мотор у болида (инцидент) — как отказ в гонке
    failEngine(id) {
      const v = vehicleOf(id)
      if (v) v.pu.failed = true
    },
    // обрыв связи: болид игрока ведёт водитель ИИ (гонка не встаёт); вернулся — снова его ввод
    setAutopilot(id, on) {
      const h = byHuman.get(id)
      if (!h) return
      h.auto = on ? createAiDriver(createRaceLine(track.axis, 'medium', h.v.T, {}), { T: h.v.T, zone: track.straightZone }) : null
    },
    // болиды для снапшота: id, позиция, поворот, скорость, руль, тормоз, DRS, повреждения
    cars() {
      const out = H.filter((h) => !h.removed).map((h) => ({ id: h.id, v: h.v }))
      for (const b of bots.list) if (!b.gone) out.push({ id: b.id, v: b.v })
      return out
    },
    // положения соперников для водителя первого игрока (проверки)
    others: () => othersOf(first),
    // гонка окончена: все машины финишировали, сошли или дисквалифицированы
    isOver() {
      return race.state.cars.every((c) => c.finished || c.dnf || c.dsq)
    },
    // итог по местам: место, круги, время с штрафом, статус — одинаково от запуска к запуску при одинаковом seed и вводе
    result() {
      return race.state.order.map((c, i) => ({
        pos: i + 1,
        id: c.id,
        lap: c.lap,
        finished: c.finished,
        finishTime: c.finished ? c.finishTime : null,
        penalty: c.penalty,
        dnf: c.dnf,
        dsq: c.dsq,
        reason: c.reason ?? null,
        stops: c.stops,
      }))
    },
    dispose() {
      physics.free()
    },
  }
}
