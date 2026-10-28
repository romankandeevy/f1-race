import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { createEnvironment } from './env.js'
import { buildTrack } from './track.js'
import { loadCircuit } from './circuit.js'
import { loadCar, PAINTS } from './car.js'
import { createVehicle, stepVehicle, collectImpacts, setGhost } from './vehicle.js'
import { CameraRig } from './camera.js'
import { createHud, createTelemetry } from './hud.js'
import { input } from './input.js'
import { TUNING } from './tuning.js'
import { createSetupScreen } from './setup.js'
import { createSound } from './sound.js'
import { createLaps } from './laps.js'
import { createStart } from './start.js'
import { createPauseMenu } from './menu.js'
import { createBots, BOT_COUNT } from './bots.js'
import { createRace } from './race.js'
import { AI_LEVELS } from './ai.js'
import { wheelsOut, createLimits } from './limits.js'
import { COMPOUNDS, COMPOUND_ORDER, freshTyres, freshDamage, freshPowerUnit } from './wear.js'
import { createPitLane, pitEntryHit, createPitStop, defaultPlan, pitLimiter } from './pit.js'
import { RACE_LAPS } from './race.js'

const STEP = 1 / 240 // шины жёсткие: на 240 Гц их силы считаются без дрожи

// Экономия энергии: ретина ×2 со сглаживанием — это ~16 млн точек за кадр, ×1,5 почти не видно глазом,
// а точек на 44% меньше. На экранах 120 Гц браузер зовёт кадр вдвое чаще — рисуем не чаще 60 раз в секунду.
const MAX_PIXEL_RATIO = 1.5
const MAX_FPS = 60
const WRONG_WAY_RESET = 3 // с

async function main() {
  await RAPIER.init()

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_PIXEL_RATIO))
  renderer.setSize(innerWidth, innerHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  document.body.prepend(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 3500)
  const env = createEnvironment(renderer, scene)

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = STEP
  const bar = document.querySelector('#bar i')
  // настоящая трасса из модели; плоская тестовая — по адресу ?track=test (удобно для настройки физики)
  const useTest = new URLSearchParams(location.search).get('track') === 'test'
  const track = useTest
    ? buildTrack(scene, RAPIER, world)
    : await loadCircuit('/models/track.glb', scene, renderer, RAPIER, world, (e) => {
        if (e.total) bar.style.width = (e.loaded / e.total) * 50 + '%'
      })
  const car = await loadCar('/models/f1.glb', renderer, (e) => {
    if (e.total) bar.style.width = (useTest ? 0 : 50) + (e.loaded / e.total) * (useTest ? 100 : 50) + '%'
  })
  scene.add(car.group)

  const pose = track.startPose
  const vehicle = createVehicle(RAPIER, world, { x: pose.x, y: (pose.y || 0) + 0.05, z: pose.z, yaw: pose.yaw })
  const rig = new CameraRig(camera, car)
  const hud = createHud(track)
  // круги считаем только на настоящей трассе (у тестовой нет оси); лучший круг — свой для каждой длины трассы.
  // laps2: с 28.10 считаются границы трассы — старые рекорды со срезками не берём
  const laps = track.axis?.length ? createLaps(track, `f1-race.laps2.${Math.round(track.length)}`) : null
  const start = track.lamps?.length ? createStart(track.lamps) : null
  let goShownUntil = 0
  const limits = createLimits()
  const LIMIT_WARNINGS = 3 // три предупреждения, дальше +5 с за каждый выезд: в гонке — к итогу, в заезде на время — к кругу
  const LIMIT_PENALTY = 5
  // износ мотора копится между гонками; стартовые шины — выбор игрока (меню)
  const PU_KEY = 'f1-race.pu'
  const TYRES_KEY = 'f1-race.tyres'
  try {
    Object.assign(vehicle.pu, JSON.parse(localStorage.getItem(PU_KEY) || '{}'))
  } catch {
    // нет хранилища — мотор новый
  }
  let startCompound = 'medium'
  try {
    if (COMPOUNDS[localStorage.getItem(TYRES_KEY)]) startCompound = localStorage.getItem(TYRES_KEY)
  } catch {
    startCompound = 'medium'
  }
  const savePU = () => {
    try {
      localStorage.setItem(PU_KEY, JSON.stringify(vehicle.pu))
    } catch {
      // не сохранилось — не страшно
    }
  }
  let lastPuSave = 0
  // пит-лейн и пит-стоп игрока (как в F1 25: въехал — дальше ведёт игра, выпуск — газом)
  const lane = track.pit ? createPitLane(track.pit) : null
  const PLAYER_BOX = BOT_COUNT // боксы 1…11 у ботов, 12-й — игрока
  let pitCtl = null
  let pitPlan = { compound: 'soft', wing: false }
  const lapsLeft = () => (race ? Math.max(0, race.state.laps - race.car('player').lap) : RACE_LAPS)
  const events = new RAPIER.EventQueue(true) // удары по кузовам → повреждения
  const telemetry = createTelemetry()
  const setupScreen = createSetupScreen()
  const sound = createSound()

  // ABS: включает сам игрок (B), выбор помним между заходами
  const ABS_KEY = 'f1-race.abs'
  const ERS_KEY = 'f1-race.ers'
  try {
    input.abs = localStorage.getItem(ABS_KEY) === '1'
    input.ersMode = TUNING.ersModes[localStorage.getItem(ERS_KEY)] ? localStorage.getItem(ERS_KEY) : 'balanced'
  } catch {
    input.abs = false
  }

  let paintIndex = 0
  car.setPaint(PAINTS[0])
  let muted = false

  // соперники: выкл — заезд на время; light / medium / hard — гонка с ботами (выбор помним)
  const BOTS_KEY = 'f1-race.bots'
  const BOT_LEVELS = ['off', 'light', 'medium', 'hard']
  let botLevel = 'medium'
  try {
    botLevel = BOT_LEVELS.includes(localStorage.getItem(BOTS_KEY)) ? localStorage.getItem(BOTS_KEY) : 'medium'
  } catch {
    botLevel = 'medium'
  }
  const canRace = !!(track.grid?.length > BOT_COUNT && track.axis?.length)
  const bots = canRace ? createBots({ RAPIER, world, scene, track, car, lane }) : null
  let race = null
  const botLevelName = () => (botLevel === 'off' ? 'выкл' : AI_LEVELS[botLevel].name.toLowerCase())

  // меню паузы (Esc); гараж, открытый из меню, по закрытии возвращает в меню
  let setupFromMenu = false
  const menu = createPauseMenu(
    {
      setup: () => openSetup(true),
      restart: () => (start ? gridStart() : resetToTrack()),
      sound: () => (muted = sound.toggleMute()),
      telemetry: () => telemetry.toggle(),
      paint: () => car.setPaint(PAINTS[++paintIndex % PAINTS.length]),
      bots: () => {
        botLevel = BOT_LEVELS[(BOT_LEVELS.indexOf(botLevel) + 1) % BOT_LEVELS.length]
        try {
          localStorage.setItem(BOTS_KEY, botLevel)
        } catch {
          // не запомнили — при следующем заходе будут средние
        }
        if (start) gridStart()
      },
      tyres: () => {
        startCompound = COMPOUND_ORDER[(COMPOUND_ORDER.indexOf(startCompound) + 1) % COMPOUND_ORDER.length]
        try {
          localStorage.setItem(TYRES_KEY, startCompound)
        } catch {
          // не запомнили
        }
        if (start) gridStart()
      },
      pu: () => {
        vehicle.pu = freshPowerUnit()
        savePU()
        hud.notify('Новая силовая установка', false, 3)
      },
    },
    () => ({ muted, telemetry: !document.getElementById('telemetry').hidden, bots: canRace ? botLevelName() : null, tyres: COMPOUNDS[startCompound].name, vehicle }),
  )
  function openSetup(fromMenu) {
    setupFromMenu = fromMenu
    menu.close()
    setupScreen.open()
  }
  setupScreen.onClose = () => {
    if (setupFromMenu) {
      setupFromMenu = false
      menu.open()
    }
  }

  function resetToTrack() {
    const p = track.poseNear(vehicle.body.translation().x, vehicle.body.translation().z)
    vehicle.body.setTranslation({ x: p.x, y: (p.y || 0) + 0.1, z: p.z }, true)
    vehicle.body.setRotation({ x: 0, y: Math.sin(p.yaw / 2), z: 0, w: Math.cos(p.yaw / 2) }, true)
    vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    vehicle.steerIn = vehicle.steerCmd = vehicle.steerVel = 0
    vehicle.delta = 0
    rig.fresh = true
    laps?.invalidate()
    // 3 с сквозь болиды — чтобы не появиться внутри соседа и не сбить едущих
    setGhost(vehicle, true)
    ghostUntil = performance.now() + 3000
  }
  let ghostUntil = 0

  // новый старт: огни заново. С соперниками — гонка: боты на первых местах решётки, игрок за ними;
  // без соперников — заезд на время с первого места
  function gridStart() {
    race = null
    limits.reset()
    bots?.clear()
    hud.showResults(null)
    // болид к старту: свежие шины выбранного состава, без повреждений; отказавший мотор — на новый
    pitCtl = null
    if (vehicle.pu.failed) {
      vehicle.pu = freshPowerUnit()
      savePU()
      hud.notify('Старый мотор отказал — поставили новый', false, 4)
    }
    vehicle.compound = startCompound
    vehicle.tyres = freshTyres(80)
    vehicle.damage = freshDamage()
    let s = track.startPose
    if (bots && botLevel !== 'off') {
      bots.spawn(botLevel, track.grid)
      s = track.grid[BOT_COUNT]
      race = createRace(track.length, [{ id: 'player', name: 'ТЫ', player: true, paint: PAINTS[paintIndex % PAINTS.length], compound: startCompound }, ...bots.list.map((b) => ({ id: b.id, name: b.name, paint: b.paint, compound: b.v.compound }))])
    }
    hud.setMode(race ? `Гонка · ${AI_LEVELS[botLevel].name.toLowerCase()} соперники` : 'Заезд на время')
    vehicle.body.setTranslation({ x: s.x, y: (s.y || 0) + 0.05, z: s.z }, true)
    vehicle.body.setRotation({ x: 0, y: Math.sin(s.yaw / 2), z: 0, w: Math.cos(s.yaw / 2) }, true)
    vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    vehicle.steerIn = vehicle.steerCmd = vehicle.steerVel = vehicle.delta = 0
    vehicle.throttle = vehicle.brake = 0
    vehicle.battery = 1 // на старт — с полной батареей
    rig.fresh = true
    laps?.restart()
    start?.begin()
    pitPlan = defaultPlan(vehicle, lapsLeft())
  }

  // быстрые настройки по ходу, как MFD в F1: баланс тормозов и дифференциал
  const ERS_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 }
  const mfdTexts = () => ({ brakeBias: TUNING.setup.brakeBias + '%', diffOn: TUNING.setup.diffOn + '%', ers: TUNING.ersModes[input.ersMode].name, pitTyre: COMPOUNDS[pitPlan.compound].name, pitWing: pitPlan.wing ? 'менять' : 'не менять' })
  const MFD_KEYS = { BracketLeft: ['brakeBias', -1, 50, 70], BracketRight: ['brakeBias', 1, 50, 70], Minus: ['diffOn', -5, 10, 100], Equal: ['diffOn', 5, 10, 100] }

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight)
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
  })

  document.getElementById('loader').classList.add('done')
  // гонка начинается со старта с решётки
  if (start) gridStart()

  let acc = 0
  let last = performance.now()
  let lastInput = input.read()
  const minFrameMs = 1000 / MAX_FPS - 1.5

  function frame(now) {
    requestAnimationFrame(frame)
    if (now - last < minFrameMs) return
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now

    for (const code of input.takePressed()) {
      // в гараже и меню свои клавиши (стрелки, Enter, Q, E) — игровые не трогаем
      if ((setupScreen.isOpen() || menu.isOpen()) && code !== 'KeyG' && code !== 'Escape') continue
      if (code === 'KeyC') rig.toggle()
      if (code === 'KeyR') resetToTrack()
      if (code === 'KeyF') input.aero = true // режим прямой: откроется, только если болид в зоне прямой
      if (code === 'KeyB') {
        input.abs = !input.abs
        try {
          localStorage.setItem(ABS_KEY, input.abs ? '1' : '0')
        } catch {
          // не запомнили — при следующем заходе ABS будет выключен
        }
      }
      if (code === 'KeyP') car.setPaint(PAINTS[++paintIndex % PAINTS.length])
      if (code === 'KeyT') telemetry.toggle()
      if (code === 'KeyG') {
        if (setupScreen.isOpen()) setupScreen.close()
        else openSetup(menu.isOpen())
      }
      if (code === 'Escape') {
        if (setupScreen.isOpen()) setupScreen.close()
        else menu.toggle()
      }
      if (code === 'KeyM') muted = sound.toggleMute()
      if (code === 'KeyN' && start) gridStart()
      if (MFD_KEYS[code]) {
        const [key, step, min, max] = MFD_KEYS[code]
        TUNING.setup[key] = Math.min(max, Math.max(min, TUNING.setup[key] + step))
        setupScreen.save()
        hud.showMfd(mfdTexts(), key)
      }
      // план пит-стопа (как MFD в F1): I — состав шин, K — менять ли переднее крыло
      if (code === 'KeyI') {
        pitPlan.compound = COMPOUND_ORDER[(COMPOUND_ORDER.indexOf(pitPlan.compound) + 1) % COMPOUND_ORDER.length]
        hud.showMfd(mfdTexts(), 'pitTyre')
      }
      if (code === 'KeyK') {
        pitPlan.wing = !pitPlan.wing
        hud.showMfd(mfdTexts(), 'pitWing')
      }
      if (code in ERS_KEYS) {
        input.ersMode = TUNING.ersOrder[ERS_KEYS[code]]
        try {
          localStorage.setItem(ERS_KEY, input.ersMode)
        } catch {
          // не запомнили — при следующем заходе будет «Баланс»
        }
        hud.showMfd(mfdTexts(), 'ers')
      }
    }

    // пока открыты гараж или меню — гонка на паузе
    const paused = setupScreen.isOpen() || menu.isOpen()
    if (paused) acc = 0
    else acc += dt
    let simDt = 0
    // зона режима прямой — по ближайшей точке оси трассы (на тестовой трассе оси нет — можно везде)
    input.aeroZone = laps && track.straightZone ? track.straightZone[laps.state.idx] === 1 : true
    // боты решают раз в кадр (60 Гц хватает), а едут на каждом шаге физики
    if (bots?.list.length && acc >= STEP) {
      const p = vehicle.body.translation()
      const ctx = race && { laps: race.state.laps, lapOf: (id) => race.car(id).lap, onPit: (id, c) => race.pitStop(id, c), onRetire: (id) => race.retire(id) }
      bots.think(dt, { x: p.x, z: p.z, speed: vehicle.state.fwdSpeed }, start?.waiting ? start.hold : null, !start?.waiting, ctx)
    }
    // въехал в пит-лейн — дальше ведёт игра
    if (lane && !pitCtl && !start?.waiting && !vehicle.pu.failed && acc >= STEP) {
      const p = vehicle.body.translation()
      const q = vehicle.body.rotation()
      const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
      if (pitEntryHit(lane, p.x, p.z, yaw)) {
        pitCtl = createPitStop(lane, PLAYER_BOX, { ...pitPlan }, { player: true })
        input.aero = false
        hud.notify(`Пит-лейн · едешь сам, ограничитель 80 · шины: ${COMPOUNDS[pitPlan.compound].name}${pitPlan.wing ? ', крыло' : ''}`, false, 4)
      }
    }
    while (acc >= STEP) {
      simDt += STEP
      if (pitCtl) {
        // пит-лейн: игрок едет сам с ограничителем; игра ставит в бокс и ждёт газ на выпуск
        const phase = pitCtl.state.phase
        const raw = input.read()
        lastInput = pitCtl.update(vehicle, STEP, raw.throttle > 0.5) || pitLimiter(pitCtl, vehicle, raw)
        if (phase === 'service' && pitCtl.state.phase === 'release') {
          race?.pitStop('player', vehicle.compound)
          hud.notify('Зелёный — жми газ!', false, 2)
        }
        if (phase === 'release' && pitCtl.state.phase === 'free') hud.notify(`Выпуск · реакция ${pitCtl.state.reaction.toFixed(2)} с · стоянка ${(pitCtl.state.service + pitCtl.state.reaction).toFixed(1)} с — управление твоё`, false, 3)
        if (phase === 'lane' && pitCtl.state.phase === 'in') hud.notify('Заезд в бокс', false, 2)
      } else {
        // пока горят огни старта, педали не работают
        lastInput = start ? start.hold(input.read()) : input.read()
      }
      car.snapshot(vehicle.body)
      stepVehicle(vehicle, lastInput, STEP, track.surfaceAt)
      bots?.step(STEP, track.surfaceAt)
      world.step(events)
      collectImpacts(events, (v, r) => {
        if (v === vehicle) hud.notify(`Повреждение: ${r.hits.join(', ')}`, true, 3)
      })
      acc -= STEP
    }
    // крылья закрылись (тормоз, руль, конец прямой) или F нажата вне зоны — просьба гаснет, на следующей прямой жать снова
    if (simDt > 0 && !vehicle.aeroOn) input.aero = false
    if (pitCtl?.state.phase === 'done' || pitCtl?.state.phase === 'abort') {
      if (pitCtl.state.phase === 'abort') hud.notify('Не пит-лейн — управление твоё', false, 3)
      pitCtl = null
      pitPlan = defaultPlan(vehicle, lapsLeft())
    }
    // прокол, отказ мотора
    for (const e of vehicle.events) {
      hud.notify(e, true, 5)
      if (/Отказ/.test(e)) {
        race?.retire('player')
        savePU()
      }
    }
    vehicle.events.length = 0
    if (ghostUntil && now > ghostUntil) {
      // снимаем, только когда рядом никого
      const p = vehicle.body.translation()
      const near = bots?.list.some((b) => {
        const t = b.v.body.translation()
        return Math.hypot(t.x - p.x, t.z - p.z) < 6
      })
      if (near) ghostUntil = now + 300
      else {
        ghostUntil = 0
        setGhost(vehicle, false)
      }
    }
    if (now - lastPuSave > 10000) {
      lastPuSave = now
      savePU()
    }

    if (start && simDt > 0) {
      const wasWaiting = start.waiting
      start.update(simDt)
      if (wasWaiting && !start.waiting) {
        goShownUntil = performance.now() + 1500
        race?.go()
      }
    }
    if (start) hud.setLights(start.state.lit, start.waiting || performance.now() < goShownUntil)

    if (laps && simDt > 0) {
      const p = vehicle.body.translation()
      const q = vehicle.body.rotation()
      const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
      laps.update(simDt, p.x, p.z, yaw, vehicle.state.fwdSpeed)
      // едет против хода гонки 3 секунды — возвращаем на трассу носом в нужную сторону
      if (!pitCtl && laps.state.wrongWay > WRONG_WAY_RESET) resetToTrack()
      // границы трассы: все четыре колеса за белой линией (в пит-лейне не считаются)
      if (!start?.waiting && limits.update(simDt, !pitCtl && wheelsOut(track.axis, laps.state.idx, vehicle.body, TUNING))) {
        const me = race?.car('player')
        if (limits.state.strikes <= LIMIT_WARNINGS) hud.notify(`Границы трассы · предупреждение ${limits.state.strikes}/${LIMIT_WARNINGS}`, true, 3)
        else if (race?.state.running && !me.finished) {
          race.addPenalty('player', LIMIT_PENALTY)
          hud.notify(`Границы трассы · +${LIMIT_PENALTY} с к гонке (всего +${me.penalty} с)`, true, 4)
        } else if (!race) {
          laps.addPenalty(LIMIT_PENALTY)
          hud.notify(`Границы трассы · +${LIMIT_PENALTY} с к кругу`, true, 4)
        }
      }
    }
    if (race && simDt > 0) {
      const byId = new Map(bots.list.map((b) => [b.id, b]))
      // для таблицы: состав шин и «в боксах»
      for (const c of race.state.cars) {
        const b = byId.get(c.id)
        c.compound = c.player ? vehicle.compound : b.v.compound
        c.inPit = c.player ? !!pitCtl : !!b.pit
      }
      const wasDone = race.state.playerDone
      race.update(simDt, (c) => (c.player ? laps.state.s : bots.distanceOf(byId.get(c.id))))
      if (!wasDone && race.state.playerDone) hud.showResults(race.state)
    }

    car.sync(acc / STEP, vehicle, lastInput)
    bots?.sync(acc / STEP)
    env.follow(car.group.position)
    rig.update(dt, vehicle)
    hud.update(vehicle.state, vehicle.aero, laps, car.group.position, input.abs, bots?.list)
    hud.updateRace(race?.state, bots?.list)
    hud.updateCar(vehicle, pitPlan, pitCtl)
    telemetry.update(vehicle)
    sound.update(vehicle, lastInput, paused)
    renderer.render(scene, camera)
  }
  requestAnimationFrame(frame)

  // для проверок и настройки из консоли браузера
  window.__game = { THREE, scene, camera, renderer, vehicle, car, track, input, rig, telemetry, setupScreen, sound, laps, start, gridStart, menu, bots, hud, limits, getRace: () => race, tuning: TUNING, resetToTrack }
}

main().catch((e) => {
  console.error(e)
  document.getElementById('loader').querySelector('.caps').textContent = 'Ошибка: ' + e.message
})
