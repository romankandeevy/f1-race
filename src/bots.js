// Боты на трассе (11 штук): копии болида, ИИ-водители (ai.js), решётка, возврат на трассу, пит-стопы.
// Физика у ботов та же, что у игрока (vehicle.js): шины стираются и греются, удары ломают, настройка —
// «Универсальная», ABS включён. Каждый старт — новая гонка: пилоты (имя + цвет) встают на решётку вразброс,
// у каждого свой номер темпа 1…11, своя траектория и манера (makePilots в ai.js), свои стартовые шины и план.
//
// Тактика: мягкие на старте — заезд на 2–3-м круге, средние — на 3-м; раньше — если шины стёрлись больше
// 62%, прокол или крыло сломано; правило двух составов — не позже предпоследнего круга.
import { createVehicle, stepVehicle, setGhost } from './vehicle.js'
import { TUNING, SETUP_DEFAULT } from './tuning.js'
import { createRaceLine, createAiDriver, makePilots } from './ai.js'
import { freshTyres } from './wear.js'
import { createPitStop, defaultPlan, rainTyreFor } from './pit.js'
import { retireReason, mechanicalFlag } from './stewards.js'

export const BOT_COUNT = 11 // с игроком 12 болидов (Рома 28.10)
// трёхбуквенные коды, как в таблице F1; имена выдуманные
const NAMES = ['БЕЛ', 'ГРО', 'ДАН', 'ЖУК', 'КОС', 'ЛИС', 'МОР', 'ОРЛ', 'СОК', 'ТИХ', 'ЯКО']
const PAINTS = ['#1f5fbf', '#f07a12', '#0d7a55', '#e9e6df', '#1a1c20', '#2bb5c9', '#d4b21c', '#7a1f2b', '#5a6470', '#8fd14f', '#e05a9c']
const STUCK_RESET = 3 // с: стоит на месте после старта — вернуть на трассу
const LOST_RESET = 25 // м от линии — улетел, вернуть
const PIT_DECIDE = [100, 25] // м до въезда в пит-лейн, где бот решает заехать
const GHOST_TIME = 3 // с: после возврата на трассу бот проходит сквозь болиды (как в F1 25)
const RECOVERY_TIME = 90 // с: запасной срок; обычно болид убирает эвакуатор (flags.js, tow.js), и bots.remove(id) срабатывает раньше

// lane — пит-лейн (pit.js) или null
export function createBots({ RAPIER, world, scene, track, car, lane }) {
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
    // чёрно-оранжевый флаг или заметно побитый болид: в боксы, как делает команда в F1
    const dm = b.v.damage
    if (mechanicalFlag(b.v) || Math.max(dm.wingL, dm.wingR, dm.rearWing, dm.floor, dm.sideL, dm.sideR) > 0.4) return true
    // погода: на сликах пошёл дождь или на дождевых трасса подсохла — менять шины
    const need = rainTyreFor(b.v.wet || 0)
    const onRain = b.v.compound === 'intermediate' || b.v.compound === 'wet'
    if ((need && need !== b.v.compound) || (!need && onRain && (b.v.wet || 0) < 0.2)) return true
    if (b.stops === 0 && (lap >= b.planLap || lap >= laps - 1)) return true
    return wear > 0.62 && lap < laps
  }

  const api = {
    get list() {
      return list
    },

    clear() {
      for (const b of list) {
        world.removeRigidBody(b.v.body)
        scene.remove(b.car.group)
      }
      list = []
    },

    // level: light | medium | hard; slots — позиции на решётке
    spawn(level, slots) {
      api.clear()
      // пилоты вразброс по решётке: имя и цвет — один пилот, номер темпа — новый на каждую гонку
      const pilots = makePilots(BOT_COUNT)
      const order = Array.from({ length: BOT_COUNT }, (_, i) => i)
      for (let k = order.length - 1; k > 0; k--) {
        const r = Math.floor(Math.random() * (k + 1))
        ;[order[k], order[r]] = [order[r], order[k]]
      }
      list = slots.slice(0, BOT_COUNT).map((p, slot) => {
        const i = order[slot]
        // своя копия чисел: у бота своя настройка, игрок свою крутит в гараже
        const T = { ...TUNING, setup: { ...SETUP_DEFAULT } }
        const v = createVehicle(RAPIER, world, { x: p.x, y: (p.y || 0) + 0.05, z: p.z, yaw: p.yaw }, T)
        // стартовые шины и план: мягкие — заезд на 2–3-м круге, средние — на 3-м
        v.compound = Math.random() < 0.55 ? 'soft' : 'medium'
        v.tyres = freshTyres(80)
        const planLap = v.compound === 'soft' ? 2 + Math.round(Math.random()) : 3
        const c = car.spawn(PAINTS[i % PAINTS.length])
        scene.add(c.group)
        const pilot = pilots[slot]
        const d = createAiDriver(createRaceLine(track.axis, level, T, pilot), { T, zone: track.straightZone })
        return { id: 'bot' + i, name: NAMES[i % NAMES.length], paint: PAINTS[i % PAINTS.length], pilot, v, car: c, d, input: d.input, box: slot, stops: 0, planLap, pit: null }
      })
    },

    // раз в кадр: решения водителей. player — { x, z, speed }; hold — держать на решётке;
    // race — { lapOf(id), laps, onPit(id, compound), onRetire(id) } или null
    think(dt, player, hold, racing, race) {
      const pos = list.map((b) => {
        const t = b.v.body.translation()
        return { x: t.x, z: t.z, speed: b.v.state.fwdSpeed }
      })
      list.forEach((b, i) => {
        if (b.gone) return
        // призрак снимается, только когда рядом никого: иначе болиды окажутся друг в друге
        if (b.ghost > 0 && (b.ghost -= dt) <= 0) {
          const me = pos[i]
          const near = [...pos.filter((_, j) => j !== i && !list[j].gone), player].some((o) => Math.hypot(o.x - me.x, o.z - me.z) < 6)
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
        others.push(player)
        // флаги: потолок скорости и запрет обгона (race.limit — из main.js, там знают флаги и порядок)
        const lim = race?.limit?.(b)
        b.d.state.cap = lim ? lim.cap : Infinity
        b.d.state.noPass = lim ? lim.noPass : false
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
            b.pit = createPitStop(lane, b.box, defaultPlan(b.v, Math.max(1, race.laps - race.lapOf(b.id))), { T: b.v.T, damage: b.v.damage, hold: race.hold })
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

    // эвакуатор забрал болид: убираем с трассы
    remove(id) {
      const b = list.find((x) => x.id === id)
      if (!b || b.gone) return
      b.gone = true
      b.car.group.visible = false
      b.v.body.setEnabled(false)
    },

    distanceOf: (b) => track.axis[b.pit ? mainIdx(b) : b.d.state.idx].distance_m,
  }
  return api
}
