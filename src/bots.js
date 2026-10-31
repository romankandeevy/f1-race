// Боты на трассе (11 штук): копии болида, ИИ-водители (ai.js), решётка, возврат на трассу, пит-стопы.
// Физика у ботов та же, что у игрока (vehicle.js): шины стираются и греются, удары ломают, настройка —
// «Универсальная», ABS включён. Каждый старт — новая гонка: пилоты (имя + цвет) встают на решётку вразброс,
// у каждого свой номер темпа 1…11, своя траектория и манера (makePilots в ai.js), свои стартовые шины и план.
//
// Тактика: мягкие на старте — заезд на 2–3-м круге, средние — на 3-м; раньше — если шины стёрлись больше
// 62%, прокол или крыло сломано; правило двух составов — не позже предпоследнего круга.
import { createVehicle, stepVehicle, setGhost } from './vehicle.js'
import { SETUP_DEFAULT } from './tuning.js'
import { createRaceLine, createAiDriver, makePilots, AI_LEVELS } from './ai.js'
import { freshTyres } from './wear.js'
import { createPitStop, defaultPlan, rainTyreFor } from './pit.js'
import { retireReason, mechanicalFlag } from './stewards.js'
import { TWO_COMPOUND_MIN_LAPS } from './race.js'
import { buildTuning, randomBuild, STOCK_BUILD } from './build.js'

export const BOT_COUNT = 11 // с игроком 12 болидов (Рома 28.10)
// трёхбуквенные коды, как в таблице F1; имена выдуманные
export const NAMES = ['БЕЛ', 'ГРО', 'ДАН', 'ЖУК', 'КОС', 'ЛИС', 'МОР', 'ОРЛ', 'СОК', 'ТИХ', 'ЯКО']
export const PAINTS = ['#1f5fbf', '#f07a12', '#0d7a55', '#e9e6df', '#1a1c20', '#2bb5c9', '#d4b21c', '#7a1f2b', '#5a6470', '#8fd14f', '#e05a9c']
const STUCK_RESET = 3 // с: стоит на месте после старта — вернуть на трассу
const LOST_RESET = 25 // м от линии — улетел, вернуть
const PIT_DECIDE = [100, 25] // м до въезда в пит-лейн, где бот решает заехать
const GHOST_TIME = 3 // с: после возврата на трассу бот проходит сквозь болиды (как в F1 25)
const RECOVERY_TIME = 90 // с: запасной срок; обычно болид убирает эвакуатор (flags.js, tow.js), и bots.remove(id) срабатывает раньше

// без картинки (сервер, тесты): болид-пустышка, ничего не рисует и в сцену не ставится
const NO_CAR = { spawn: () => ({ group: { visible: true }, snapshot() {}, setCompound() {}, sync() {} }) }

// lane — пит-лейн (pit.js) или null; car и scene — картинка (без них боты только едут, для сервера); rand — ГПСЧ (по умолчанию Math.random);
// builds — у каждого бота своя сборка болида (build.js, в рамках бюджета); без него — у всех стандартная
// Подтягивание «Сложных» (Рома 31.10: «я легко обгоняю ботов даже на первом круге, и они меня никогда не догонят; если я
// жёстко обогнал — у меня не должно быть шанса легко выиграть, они должны пытаться догнать; а если я не могу их догнать —
// чтобы шанс был»). Не по физике: бот, от которого игрок уехал, получает сцепление, мощность и тормоза (и ИИ едет на столько
// же быстрее по профилю), бот далеко впереди игрока — чуть меньше. Рядом с игроком (−RUBBER_NEAR…+RUBBER_NEAR м) — честно.
// gap — на сколько метров игрок впереди бота (по прогрессу гонки), отрицательный — бот впереди.
const RUBBER_NEAR = 25 // м: ближе — без подтягивания, честная борьба
const RUBBER_UP = 0.07 // до +7% сцепления, мощности и тормозов у отставшего от игрока (круг на ~6% быстрее)
const RUBBER_UP_AT = 400 // м отставания, на которых прибавка полная
const RUBBER_DOWN = 0.03 // до −3% у уехавшего вперёд от игрока
const RUBBER_DOWN_FROM = 80 // м: ближе впереди игрока — не сбавляет (борьба за место)
const RUBBER_DOWN_AT = 500
const RUBBER_TAU = 1.5 // с: прибавка меняется плавно
export function rubberK(gap) {
  if (gap > RUBBER_NEAR) {
    const x = Math.min(1, (gap - RUBBER_NEAR) / (RUBBER_UP_AT - RUBBER_NEAR))
    return 1 + RUBBER_UP * x * (2 - x) // быстро растёт и плавно выходит на полную
  }
  if (gap < -RUBBER_DOWN_FROM) return 1 - RUBBER_DOWN * Math.min(1, (-gap - RUBBER_DOWN_FROM) / (RUBBER_DOWN_AT - RUBBER_DOWN_FROM))
  return 1
}

export function createBots({ RAPIER, world, scene = null, track, car = NO_CAR, lane, rand = Math.random, builds = false }) {
  let rubberOn = false // уровень с подтягиванием (pro)
  let list = []
  // где на оси трассы начинается пит-лейн
  let entryS = null
  if (lane) {
    const a0 = lane.axis[0]
    let bd = Infinity
    for (const a of track.axis) {
      const d = (a.x - a0.x) ** 2 + (a.z - a0.z) ** 2
      if (d < bd) {
        bd = d
        entryS = a.distance_m
      }
    }
  }
  const L = track.length

  function placeAt(b, p) {
    const v = b.v
    v.body.setTranslation({ x: p.x, y: (p.y || 0) + 0.1, z: p.z }, true)
    v.body.setRotation({ x: 0, y: Math.sin(p.yaw / 2), z: 0, w: Math.cos(p.yaw / 2) }, true)
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    v.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    v.steerIn = v.steerCmd = v.steerVel = v.delta = 0
    b.d.reset()
    setGhost(v, true)
    b.ghost = GHOST_TIME
  }

  // ближайшая точка оси трассы около прошлой (в пит-лейне водитель не обновляет свою)
  function mainIdx(b) {
    const t = b.v.body.translation()
    const n = track.axis.length
    let bi = b.mainIdx ?? b.d.state.idx
    let bd = Infinity
    for (let k = -20; k <= 60; k++) {
      const i = (((b.mainIdx ?? b.d.state.idx) + k) % n + n) % n
      const a = track.axis[i]
      const d = (a.x - t.x) ** 2 + (a.z - t.z) ** 2
      if (d < bd) {
        bd = d
        bi = i
      }
    }
    b.mainIdx = bi
    return bi
  }

  function wantsPit(b, lap, laps) {
    if (!lane || lap < 1 || lap > laps) return false
    const t = b.v.tyres
    const wear = (t[0].wear + t[1].wear + t[2].wear + t[3].wear) / 4
    if (t.some((x) => x.puncture)) return true
    // последний круг: до финиша доедут и так (крыло, износ, погода, флаг — уже не важно), заезд — только с проколом
    if (lap >= laps) return false
    // чёрно-оранжевый флаг или заметно побитый болид: в боксы, как делает команда в F1
    const dm = b.v.damage
    if (mechanicalFlag(b.v) || Math.max(dm.wingL, dm.wingR, dm.rearWing, dm.floor, dm.sideL, dm.sideR) > 0.4) return true
    // погода: на сликах пошёл дождь или на дождевых трасса подсохла — менять шины
    const need = rainTyreFor(b.v.wet || 0)
    const onRain = b.v.compound === 'intermediate' || b.v.compound === 'wet'
    if ((need && need !== b.v.compound) || (!need && onRain && (b.v.wet || 0) < 0.2)) return true
    if (laps >= TWO_COMPOUND_MIN_LAPS && b.stops === 0 && (lap >= b.planLap || lap >= laps - 1)) return true
    return wear > 0.62 && lap < laps
  }

  const api = {
    get list() {
      return list
    },

    clear() {
      for (const b of list) {
        world.removeRigidBody(b.v.body)
        scene?.remove(b.car.group)
      }
      list = []
    },

    // level: light | medium | hard; slots — позиции на решётке; season — чемпионат (career.js): у каждого бота свой темп
    // и своя сборка на весь сезон ({ pilots, builds } по номеру бота), а не новые на каждую гонку
    spawn(level, slots, season = null) {
      api.clear()
      rubberOn = !!AI_LEVELS[level]?.rubber
      // пилоты вразброс по решётке: имя и цвет — один пилот, номер темпа — новый на каждую гонку
      const pilots = makePilots(BOT_COUNT, rand)
      const order = Array.from({ length: BOT_COUNT }, (_, i) => i)
      for (let k = order.length - 1; k > 0; k--) {
        const r = Math.floor(rand() * (k + 1))
        ;[order[k], order[r]] = [order[r], order[k]]
      }
      list = slots.slice(0, BOT_COUNT).map((p, slot) => {
        const i = order[slot]
        // своя копия чисел: у бота своя настройка (игрок свою крутит в гараже) и своя сборка болида
        const build = season ? { ...season.builds[i] } : builds ? randomBuild(rand) : { ...STOCK_BUILD }
        const T = buildTuning(build, { ...SETUP_DEFAULT })
        const v = createVehicle(RAPIER, world, { x: p.x, y: (p.y || 0) + 0.05, z: p.z, yaw: p.yaw }, T)
        // стартовые шины и план: мягкие — заезд на 2–3-м круге, средние — на 3-м
        v.compound = rand() < 0.55 ? 'soft' : 'medium'
        v.tyres = freshTyres(80)
        v.rand = rand
        const planLap = v.compound === 'soft' ? 2 + Math.round(rand()) : 3
        const c = car.spawn(PAINTS[i % PAINTS.length])
        scene?.add(c.group)
        const pilot = season ? season.pilots[i] : pilots[slot]
        const d = createAiDriver(createRaceLine(track.axis, level, T, pilot), { T, zone: track.straightZone })
        // базовые числа для подтягивания: сцепление, мощность, тяга, тормоза (см. rubberK)
        const T0 = { tireMu: T.tireMu, power: T.power, maxDriveForce: T.maxDriveForce, brakeForce: T.brakeForce }
        return { id: 'bot' + i, name: NAMES[i % NAMES.length], paint: PAINTS[i % PAINTS.length], pilot, build, v, car: c, d, input: d.input, box: slot, stops: 0, planLap, pit: null, T0, rub: 1 }
      })
    },

    // раз в кадр: решения водителей. player — { x, z, speed } или список таких (онлайн: несколько живых игроков);
    // hold — держать на решётке; race — { lapOf(id), laps, onPit(id, compound), onRetire(id) } или null
    think(dt, player, hold, racing, race) {
      const people = Array.isArray(player) ? player : [player]
      const pos = list.map((b) => {
        const t = b.v.body.translation()
        return { x: t.x, z: t.z, speed: b.v.state.fwdSpeed }
      })
      list.forEach((b, i) => {
        if (b.gone) return
        // призрак снимается, только когда рядом никого: иначе болиды окажутся друг в друге
        if (b.ghost > 0 && (b.ghost -= dt) <= 0) {
          const me = pos[i]
          const near = [...pos.filter((_, j) => j !== i && !list[j].gone), ...people].some((o) => Math.hypot(o.x - me.x, o.z - me.z) < 6)
          if (near) b.ghost = 0.3
          else setGhost(b.v, false)
        }
        // отказ мотора или разрушенный болид — катится и встаёт, сошёл; через RECOVERY_TIME с его убирает эвакуатор
        const why = b.v.pu.failed ? 'Отказ силовой установки' : retireReason(b.v)
        if (why) {
          b.input = b.d.input
          b.input.throttle = 0
          b.input.brake = b.v.state.fwdSpeed > 1 ? 0.5 : 0.1
          if (!b.retired) {
            b.retired = true
            b.retiredT = 0
            b.pit = null
            race?.onRetire(b.id, why)
          }
          b.retiredT += dt
          if (b.retiredT > RECOVERY_TIME) {
            b.gone = true
            b.car.group.visible = false
            b.v.body.setEnabled(false)
          }
          return
        }
        // в пит-лейне ведёт пит-стоп
        if (b.pit) {
          const phase = b.pit.state.phase
          b.input = b.pit.update(b.v, dt)
          if (phase === 'service' && b.pit.state.phase === 'release') {
            b.stops++
            race?.onPit(b.id, b.v.compound)
          }
          if (b.pit.state.phase === 'done' || b.pit.state.phase === 'abort') {
            b.pit = null
            b.d.reset()
          }
          return
        }
        const others = pos.filter((_, j) => j !== i && !list[j].gone)
        others.push(...people)
        // «Сложные»: подтягивание к игроку (race.gapToPlayer — сколько метров игрок впереди этого бота)
        const want = rubberOn && racing && race?.gapToPlayer ? rubberK(race.gapToPlayer(b.id)) : 1
        b.rub += (want - b.rub) * Math.min(1, dt / RUBBER_TAU)
        if (Math.abs(b.rub - 1) > 1e-4 || b.v.T.tireMu !== b.T0.tireMu) {
          const T = b.v.T
          T.tireMu = b.T0.tireMu * b.rub
          T.power = b.T0.power * b.rub
          T.maxDriveForce = b.T0.maxDriveForce * b.rub
          T.brakeForce = b.T0.brakeForce * b.rub
          b.d.state.rubber = Math.sqrt(b.rub) // скорость в повороте растёт как корень из сцепления: иначе ИИ выносит за линию
        }
        // флаги: потолок скорости и запрет обгона (race.limit — из main.js, там знают флаги и порядок)
        const lim = race?.limit?.(b)
        b.d.state.cap = lim ? lim.cap : Infinity
        b.d.state.noPass = lim ? lim.noPass : false
        // под огнями водитель стоит на своём месте решётки: иначе он «думал» на месте — видел стоящих соседей, бросал
        // стартовую полосу и к отмашке рвался на гоночную линию поперёк решётки (Марина, 30.10: завал со 2-го ряда)
        if (!racing) {
          b.d.reset(b.d.state.idx)
          b.d.state.raceT = 0 // время с отмашки — с нуля (возврат на трассу его не трогает)
        }
        b.input = b.d.update(b.v, dt, others)
        if (hold) hold(b.input)
        const st = b.d.state
        // на решётке под огнями бот стоит не потому, что застрял: иначе к старту у всех набегало >3 с
        // и всех разом «спасало» на середину трассы — ехали колонной
        if (!racing) st.stuck = 0
        if (st.stuck > STUCK_RESET || st.dist > LOST_RESET) {
          const t = b.v.body.translation()
          placeAt(b, track.poseNear(t.x, t.z))
          return
        }
        // пит-стоп: перед въездом в пит-лейн решаем, заезжать ли
        if (race && racing && entryS !== null) {
          const s = track.axis[st.idx].distance_m
          const toEntry = (entryS - s + L) % L
          if (toEntry < PIT_DECIDE[0] && toEntry > PIT_DECIDE[1] && (lim?.redPit || wantsPit(b, race.lapOf(b.id), race.laps))) {
            // красный флаг: все в боксы, там стоят, пока флаг не снимут (race.hold)
            b.pit = createPitStop(lane, b.box, defaultPlan(b.v, Math.max(1, race.laps - race.lapOf(b.id))), { T: b.v.T, damage: b.v.damage, hold: race.hold, rand })
            b.mainIdx = st.idx
          }
        }
      })
    },

    step(dt, surfaceAt, wet = 0) {
      for (const b of list) {
        if (b.gone) continue
        b.v.wet = wet
        b.car.snapshot(b.v.body)
        stepVehicle(b.v, b.input, dt, surfaceAt)
        b.v.events.length = 0 // события ботов игроку не показываем
      }
    },

    sync(alpha) {
      for (const b of list) {
        if (b.gone) continue
        b.car.setCompound(b.v.compound)
        b.car.sync(alpha, b.v, b.input)
      }
    },

    // расстояние по оси трассы: точки гоночной линии идут в том же порядке, что и ось;
    // в пит-лейне — по ближайшей точке оси (пит-лейн идёт вдоль главной прямой)
    // эвакуатор поднял болид краном: тело отключено, водитель не думает, а рисует болид уже эвакуатор (tow.js)
    lift(id) {
      const b = list.find((x) => x.id === id)
      if (!b || b.gone) return null
      b.gone = true
      b.v.body.setEnabled(false)
      return b.car.group
    },

    // красный флаг кончился: болид на место решётки, пит-стоп и разгон забыты
    regrid(id, p) {
      const b = list.find((x) => x.id === id)
      if (!b || b.gone) return
      const v = b.v
      v.body.setTranslation({ x: p.x, y: (p.y || 0) + 0.05, z: p.z }, true)
      v.body.setRotation({ x: 0, y: Math.sin(p.yaw / 2), z: 0, w: Math.cos(p.yaw / 2) }, true)
      v.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
      v.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
      v.steerIn = v.steerCmd = v.steerVel = v.delta = 0
      b.pit = null
      b.d.reset()
      // расстояние по оси у водителя — по новой точке, иначе на кадр остаётся прежнее
      let bi = 0
      let bd = Infinity
      track.axis.forEach((a, i) => {
        const d = (a.x - p.x) ** 2 + (a.z - p.z) ** 2
        if (d < bd) {
          bd = d
          bi = i
        }
      })
      b.d.state.idx = bi
      b.mainIdx = bi
    },

    // эвакуатор забрал болид: убираем с трассы. Поднятый краном уже `gone` (lift) — его тоже прятать: раньше тут был
    // выход по `gone`, и болид оставался висеть в воздухе там, где его последним держал кран (Рома 30.10)
    remove(id) {
      const b = list.find((x) => x.id === id)
      if (!b) return
      b.gone = true
      b.car.group.visible = false
      b.v.body.setEnabled(false)
    },

    distanceOf: (b) => track.axis[b.pit ? mainIdx(b) : b.d.state.idx].distance_m,
  }
  return api
}
