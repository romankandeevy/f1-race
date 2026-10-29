import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { createEnvironment } from './env.js'
import { buildTrack } from './track.js'
import { loadCircuit } from './circuit.js'
import { loadCar, PAINTS } from './car.js'
import { createVehicle, stepVehicle, collectImpacts, setGhost } from './vehicle.js'
import { CameraRig } from './camera.js'
import { createHud, createTelemetry } from './hud.js'
import { scanCar } from './carScan.js'
import { createParticles } from './particles.js'
import { createTrackMarks } from './debris.js'
import { createGhost } from './ghost.js'
import { createWeather } from './weather.js'
import { input } from './input.js'
import { TUNING } from './tuning.js'
import { createSetupScreen } from './setup.js'
import { createSound } from './sound.js'
import { createLaps, formatTime } from './laps.js'
import { createStart } from './start.js'
import { createPauseMenu } from './menu.js'
import { createBots, BOT_COUNT } from './bots.js'
import { createRace } from './race.js'
import { AI_LEVELS } from './ai.js'
import { wheelsOut, createLimits } from './limits.js'
import { COMPOUNDS, COMPOUND_ORDER, freshTyres, freshDamage, freshPowerUnit, freshBrakes, setFuel, fuelForRace, FUEL_PER_KM } from './wear.js'
import { createPitLane, pitEntryHit, createPitStop, defaultPlan, pitLimiter, rainTyreFor } from './pit.js'
import { RACE_LAPS } from './race.js'
import { settings, QUALITY } from './settings.js'
import { createScreens } from './screens.js'
import { retireReason, mechanicalFlag, ORANGE_LAPS, judgeContact, contactPenalty } from './stewards.js'
import { repairSeconds } from './wear.js'
import { createFlags, VSC_SPEED } from './flags.js'
import { createTow } from './tow.js'
import { createSafetyCar } from './safetycar.js'
import { loadLivery, saveLivery } from './teams.js'

const STEP = 1 / 240 // шины жёсткие: на 240 Гц их силы считаются без дрожи

// Экономия энергии: ретина ×2 со сглаживанием — это ~16 млн точек за кадр, ×1,5 почти не видно глазом,
// а точек на 44% меньше. На экранах 120 Гц браузер зовёт кадр вдвое чаще — по умолчанию рисуем не чаще 60 раз в секунду.
// Качество и лимит кадров игрок меняет в настройках (settings.js).
const pixelRatioFor = (q) => Math.min(devicePixelRatio, QUALITY[q].ratio)
const CAREER_KEY = 'f1-race.career.v1'
const WRONG_WAY_RESET = 3 // с

async function main() {
  await RAPIER.init()

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(pixelRatioFor(settings.get('quality')))
  renderer.setSize(innerWidth, innerHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1
  renderer.shadowMap.enabled = QUALITY[settings.get('quality')].shadows
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
  hud.setCarScan(scanCar(renderer, car.group)) // схема болида на табло — из той же модели, пока колёса и крылья на месте
  const particles = createParticles(scene)
  const marks = createTrackMarks(scene) // обломки и следы торможения
  const weather = createWeather(scene, env) // дождь и мокрая трасса
  let weatherMode = 'dry'
  let rainNeed = null // какие шины нужны сейчас (rainTyreFor): смена — подсказка и план пит-стопа
  // круги считаем только на настоящей трассе (у тестовой нет оси); лучший круг — свой для каждой длины трассы.
  // laps2: с 28.10 считаются границы трассы — старые рекорды со срезками не берём
  const laps = track.axis?.length ? createLaps(track, `f1-race.laps2.${Math.round(track.length)}`) : null
  const ghost = laps ? createGhost(scene, car, `f1-race.laps2.${Math.round(track.length)}.ghost`) : null // призрак лучшего круга
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
  // «заехать в боксы» (L, как «box this lap» в F1): когда до въезда в пит-лейн останется PIT_TAKEOVER м, автопилот
  // сам тормозит до 80, заводит в бокс, обслуживает и выпускает (Рома 29.10: «на пит-стопе можно отдохнуть»)
  let pitRequest = false
  const PIT_TAKEOVER = [100, 25] // м до въезда: автопилот берёт руль (как у ботов)
  const PIT_NEAR = 4 // м за край пит-лейна: пересечение белой линии при въезде и выезде — не нарушение границ
  let pitSince = -1e9 // когда закончился пит-стоп: ещё несколько секунд выезд из пит-лейна не считается нарушением
  let entryS = null // где на оси трассы начинается пит-лейн
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
  // машина рядом с пит-лейном (вдоль всей его оси, включая въезд и выезд)
  const nearPitLane = (x, z) => !!lane && lane.near(x, z, PIT_NEAR)
  let raceLaps = RACE_LAPS // из экрана «Гонка»
  let playerSlot = BOT_COUNT // место на решётке: 0 — поул, 11 — последнее
  // квалификация (Рома 29.10): без соперников разгонный круг и два быстрых, в зачёт лучший; решётку строит время, как в F1
  const QUALI_LAPS = 3
  const QUALI_BASE = { light: 80.6, medium: 72.8, hard: 68.9 } // с: круг LUMEN RING пилота с темпом 1 у каждого уровня (замер ботов)
  let quali = null // идёт квалификация: { level, times, seen, text }
  let qualiTime // время игрока после квалификации (null — без времени); undefined — гонка без квалификации
  let qualiFresh = false // квалификация только что кончилась — показать таблицу
  let qualiShown = false // таблица квалификации на экране — игра стоит
  function removeCar(id) {
    if (id === 'player') {
      car.group.visible = false
      vehicle.body.setEnabled(false)
    } else bots?.remove(id)
  }
  // эвакуатор поднял болид: физика выключена, картинку дальше задаёт кран
  function liftCar(id) {
    if (id === 'player') vehicle.body.setEnabled(false)
    else bots?.lift(id)
  }
  function restoreCar() {
    car.group.visible = true
    vehicle.body.setEnabled(true)
  }
  const idOf = (v) => (v === vehicle ? 'player' : bots?.list.find((b) => b.v === v)?.id)
  const nameOf = (id) => (id === 'player' ? 'ТЫ' : race?.car(id)?.name ?? id)
  const lapsLeft = () => (race ? Math.max(0, race.state.laps - race.car('player').lap) : raceLaps)
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

  // ливрея: команда и два цвета — выбор в гараже (teams.js), помним между заходами
  let livery = loadLivery()
  car.setLivery(livery)
  let paintIndex = Math.max(0, PAINTS.findIndex((c) => c.toLowerCase() === livery.primary.toLowerCase()))
  let muted = false
  // P по ходу гонки листает цвет кузова; остальная ливрея не меняется
  const cyclePaint = () => {
    livery = { ...livery, team: 'own', primary: PAINTS[++paintIndex % PAINTS.length] }
    car.setLivery(livery)
    saveLivery(livery)
  }

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
  // флаги, машина безопасности и эвакуатор (flags.js, tow.js): только в гонке с соперниками
  const sc = canRace && lane ? createSafetyCar(scene, track.axis, track.length, lane) : null // настоящая машина безопасности перед лидером
  const flags = canRace ? createFlags(track.axis, track.length, { safetyCar: !!sc }) : null
  const tow = canRace ? createTow(scene, track.axis, track.length) : null
  let flagAcc = 0
  let playerGap = 0 // зазор до болида впереди, м (для коридора под машиной безопасности)
  let prevAhead = null // кто был впереди игрока при флагах: если обогнал — штраф
  let lastPassPenalty = -1e9
  const botLevelName = () => (botLevel === 'off' ? 'выкл' : AI_LEVELS[botLevel].name.toLowerCase())

  // меню паузы (Esc); гараж, открытый из меню, по закрытии возвращает в меню
  let setupFromMenu = false
  let setupFromScreens = false // гараж настройки открыт из главного меню: по закрытии вернуть главное меню
  let settingsFromPause = false // настройки открыты из паузы: по закрытии вернуть паузу
  let inMenu = true // главное меню: болид стоит, сзади витрина
  const menu = createPauseMenu(
    {
      setup: () => openSetup(true),
      restart: () => (start ? gridStart() : resetToTrack()),
      settings: () => {
        settingsFromPause = true
        ui.open('settings')
      },
      mainmenu: () => enterMenu(),
      telemetry: () => telemetry.toggle(),
    },
    () => ({ telemetry: !document.getElementById('telemetry').hidden, vehicle }),
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
    } else if (setupFromScreens) {
      setupFromScreens = false
      ui.resume()
    }
  }

  // ---------- экраны вне гонки: главное меню, гараж, настройка гонки, настройки ----------
  const career = (() => {
    try {
      return { races: 0, wins: 0, podiums: 0, dnf: 0, ...JSON.parse(localStorage.getItem(CAREER_KEY) || '{}') }
    } catch {
      return { races: 0, wins: 0, podiums: 0, dnf: 0 }
    }
  })()
  const saveCareer = () => {
    try {
      localStorage.setItem(CAREER_KEY, JSON.stringify(career))
    } catch {
      // не сохранилось — статистика этой сессии останется на экране
    }
  }
  const ui = createScreens({
    canRace: canRace,
    trackLabel: useTest ? 'Тестовая трасса' : `LUMEN RING · ${Math.round(track.length).toLocaleString('ru-RU')} м`,
    session: { level: botLevel === 'off' ? 'medium' : botLevel, compound: startCompound, abs: input.abs },
    info: () => ({ bestLap: laps?.state.bestLap ?? null, bestSectors: laps?.state.bestSectors ?? null, pu: vehicle.pu, career, livery }),
    // витрина — только в главном меню; настройки поверх паузы показываем на фоне самой гонки
    showcase: (on, shift) => {
      if (inMenu || !on) rig.setShowcase(on, shift)
    },
    previewLivery: (l) => {
      livery = l
      car.setLivery(l)
      saveLivery(l)
    },
    previewCompound: (c) => {
      if (inMenu) vehicle.compound = c
    },
    startSession: (o) => startSession(o),
    openSetup: () => {
      setupFromScreens = true
      ui.suspend()
      setupScreen.open()
    },
    newPowerUnit: () => {
      vehicle.pu = freshPowerUnit()
      savePU()
    },
    onClose: () => {
      if (settingsFromPause) {
        settingsFromPause = false
        menu.open()
      }
    },
  })

  // в главное меню: гонка закончена, болид на старте, соперников нет, камера-витрина
  function enterMenu() {
    inMenu = true
    weather.set('dry')
    quali = null
    qualiShown = false
    ghost?.hide()
    document.body.classList.add('menu-mode')
    race = null
    pitCtl = null
    pitRequest = false
    bots?.clear()
    restoreCar()
    flags?.reset()
    sc?.hide()
    tow?.clear()
    hud.setTrackFlag(null)
    limits.reset()
    hud.showResults(null)
    menu.close()
    if (setupScreen.isOpen()) setupScreen.close()
    const s = track.startPose
    vehicle.body.setTranslation({ x: s.x, y: (s.y || 0) + 0.05, z: s.z }, true)
    vehicle.body.setRotation({ x: 0, y: Math.sin(s.yaw / 2), z: 0, w: Math.cos(s.yaw / 2) }, true)
    vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    vehicle.steerIn = vehicle.steerCmd = vehicle.steerVel = vehicle.delta = 0
    vehicle.throttle = vehicle.brake = 0
    vehicle.compound = startCompound // на витрине шины того состава, что выбран на старт
    // два снимка: иначе болид на экране остался бы на старом месте (картинка берёт предыдущий снимок)
    car.snapshot(vehicle.body)
    car.snapshot(vehicle.body)
    ui.open('main')
  }

  // начало гонки или заезда с экрана «Гонка»
  function startSession(o) {
    inMenu = false
    document.body.classList.remove('menu-mode')
    botLevel = o.mode === 'race' && canRace ? o.level : 'off'
    startCompound = o.compound
    raceLaps = o.laps
    playerSlot = o.mode === 'race' ? o.slot : BOT_COUNT
    weatherMode = o.weather || 'dry'
    quali = null
    qualiTime = undefined
    input.abs = !!o.abs
    try {
      localStorage.setItem(BOTS_KEY, botLevel)
      localStorage.setItem(TYRES_KEY, startCompound)
      localStorage.setItem(ABS_KEY, input.abs ? '1' : '0')
    } catch {
      // не запомнили — при следующем заходе значения по умолчанию
    }
    // «По квалификации»: сначала квалификация без соперников, гонка — потом (finishQuali)
    if (o.mode === 'race' && o.slot === -1 && botLevel !== 'off') {
      quali = { level: botLevel, times: [], seen: null, text: '' }
      botLevel = 'off'
      playerSlot = BOT_COUNT
    }
    rig.setMode(settings.get('camera'))
    gridStart()
  }

  // квалификация кончилась: лучшее время игрока, гонка с соперниками, решётка по времени
  function finishQuali() {
    qualiTime = quali.times.length ? Math.min(...quali.times) : null
    botLevel = quali.level
    quali = null
    qualiFresh = true
    gridStart()
  }

  // решётка по квалификации: время игрока и времена ботов (темп пилота от уровня + разброс), места по времени
  function qualiGrid() {
    const base = (QUALI_BASE[botLevel] * track.length) / 3729
    const rows = [{ id: 'player', name: 'ТЫ', paint: livery.primary, player: true, time: qualiTime ?? Infinity }, ...bots.list.map((b) => ({ id: b.id, name: b.name, paint: b.paint, time: base / b.pilot.pace + (Math.random() * 0.6 - 0.2) }))]
    rows.sort((a, b) => a.time - b.time)
    rows.forEach((r, i) => {
      if (!r.player) bots.regrid(r.id, track.grid[i])
    })
    return rows
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
  let heatSince = null
  let suspBrokenSeen = false
  // стюарды и сход (Рома 29.10: «чтобы я был пилотом Формулы-1, точь-в-точь»)
  let retired = false // болид игрока сошёл (разрушен, нет колеса, отказ мотора) или дисквалифицирован
  let retireText = ''
  let orange = null // чёрно-оранжевый флаг: { reason, lap } — обязан заехать в боксы за ORANGE_LAPS кругов, иначе чёрный флаг
  let resultsAt = 0 // когда показать экран итогов после схода (чтобы успеть увидеть, что случилось)
  const contactSeen = new Map() // пара болидов → когда стюарды уже разбирали контакт (раз в 4 с)
  let lastEngineNote = -1e9
  let lastHeatNote = -1e9

  // новый старт: огни заново. С соперниками — гонка: боты на первых местах решётки, игрок за ними;
  // без соперников — заезд на время с первого места
  function gridStart() {
    race = null
    limits.reset()
    bots?.clear()
    hud.showResults(null)
    // болид к старту: свежие шины выбранного состава, без повреждений; отказавший мотор — на новый
    pitCtl = null
    if (quali) {
      quali.times = []
      quali.seen = null
    }
    ghost?.hide()
    weather.set(weatherMode)
    vehicle.wet = weather.state.wet
    rainNeed = rainTyreFor(weather.state.wet)
    if (vehicle.pu.failed) {
      vehicle.pu = freshPowerUnit()
      savePU()
      hud.notify('Старый мотор отказал — поставили новый', false, 4)
    }
    vehicle.compound = startCompound
    vehicle.tyres = freshTyres(80)
    vehicle.damage = freshDamage()
    vehicle.engineHeat = 0.3
    vehicle.hotTime = 0
    vehicle.brakeTemp = freshBrakes()
    vehicle.brakeHot = false
    particles.clear()
    marks.clear()
    retired = false
    orange = null
    resultsAt = 0
    contactSeen.clear()
    hud.setFlag(null)
    hud.setTrackFlag(null)
    restoreCar()
    flags?.reset()
    sc?.hide()
    tow?.clear()
    prevAhead = null
    flagAcc = 0
    let s = track.startPose
    if (bots && botLevel !== 'off') {
      // игрок на выбранном месте решётки, одиннадцать соперников — на остальных
      const slot = Math.min(playerSlot, track.grid.length - 1)
      bots.spawn(botLevel, track.grid.slice(0, BOT_COUNT + 1).filter((_, i) => i !== slot))
      s = track.grid[slot]
      race = createRace(
        track.length,
        [{ id: 'player', name: 'ТЫ', player: true, paint: livery.primary, compound: startCompound }, ...bots.list.map((b) => ({ id: b.id, name: b.name, paint: b.paint, compound: b.v.compound }))],
        raceLaps,
      )
      // дождь со старта: соперники на дождевых шинах, пит-стоп — по погоде, а не по плану
      if (rainNeed) {
        for (const b of bots.list) {
          b.v.compound = rainNeed
          b.v.tyres = freshTyres(70)
          b.v.wet = weather.state.wet
          b.planLap = Infinity
        }
      }
      // после квалификации — все по её времени (и «Ещё раз» с тем же временем игрока)
      if (qualiTime !== undefined) {
        const rows = qualiGrid()
        playerSlot = rows.findIndex((r) => r.player)
        s = track.grid[playerSlot]
        if (qualiFresh) {
          qualiFresh = false
          qualiShown = true
          hud.showQuali(rows)
        }
      }
    }
    // топливо — только в гонке: бак на дистанцию с запасом в круг, у всех одинаковый (в заезде на время бак не тратится)
    const tank = race ? fuelForRace(raceLaps, track.length) : 0
    setFuel(vehicle, tank)
    for (const b of bots?.list ?? []) setFuel(b.v, tank)
    hud.setMode(race ? `Гонка · ${AI_LEVELS[botLevel].name.toLowerCase()} соперники` : quali ? `Квалификация · круг 1 из ${QUALI_LAPS}` : 'Заезд на время')
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
  const mfdTexts = () => ({ brakeBias: TUNING.setup.brakeBias + '%', diffOn: TUNING.setup.diffOn + '%', ers: TUNING.ersModes[input.ersMode].name, pitTyre: COMPOUNDS[pitPlan.compound].name, pitWing: pitPlan.wing ? 'ремонт кузова' : 'без ремонта' })
  hud.setPitPickHandler((kind, value) => {
    if (kind === 'compound') pitPlan.compound = value
    else pitPlan.wing = !pitPlan.wing
  })
  const MFD_KEYS = { BracketLeft: ['brakeBias', -1, 50, 70], BracketRight: ['brakeBias', 1, 50, 70], Minus: ['diffOn', -5, 10, 100], Equal: ['diffOn', 5, 10, 100] }

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight)
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
  })

  // настройки игрока: применить всё сразу и следить за изменениями
  const applySetting = (k) => {
    const v = settings.get(k)
    if (k === 'quality') {
      renderer.setPixelRatio(pixelRatioFor(v))
      renderer.setSize(innerWidth, innerHeight)
      if (renderer.shadowMap.enabled !== QUALITY[v].shadows) {
        renderer.shadowMap.enabled = QUALITY[v].shadows
        scene.traverse((o) => {
          const m = o.material
          if (m) for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true
        })
      }
    } else if (k === 'volume') sound.setVolume(v / 100)
    else if (k === 'mouse') rig.mouseK = v / 100
    else if (k === 'invertY') rig.invertY = v
    else if (k === 'shake') rig.shakeK = v / 100
    else if (k === 'fov') rig.fovK = v / 100
    else if (k === 'hud') document.documentElement.style.setProperty('--hud', v / 100)
    else if (k === 'units') hud.setUnits(v)
    else if (k === 'minimap') document.body.classList.toggle('no-minimap', !v)
    else if (k === 'camera' && !inMenu) rig.setMode(v)
  }
  for (const k of Object.keys(settings.all())) applySetting(k)
  settings.onChange((k) => applySetting(k))
  const goRace = () => {
    qualiShown = false
    hud.showResults(null)
  }
  hud.onResultsAction((act) => (act === 'again' ? gridStart() : act === 'race' ? goRace() : enterMenu()))

  document.getElementById('loader').classList.add('done')
  // после загрузки — главное меню; гонка начинается по кнопке «Гонка» или «Заезд на время»
  enterMenu()

  let acc = 0
  let last = performance.now()
  let lastInput = input.read()

  // разбор контакта двух болидов стюардами: кто виноват, штраф к итоговому времени (в F1: +5 с за заметный контакт, +10 за тяжёлый)
  // потолок скорости и запрет обгона для бота по флагам (flags.js): зазор до болида впереди берём из порядка гонки
  // лидер гонки среди тех, кто на трассе (не в боксах и не сошёл): за ним держится машина безопасности
  const raceLead = () => race?.state.order.find((c) => !c.dnf && !c.inPit) ?? null
  // лидеру нельзя догнать машину безопасности: зазор и её скорость
  const scAhead = (id) => {
    const lead = raceLead()
    if (!sc || lead?.id !== id) return null
    const gap = sc.gapFrom(lead.s)
    return gap === null ? null : { gap, speed: sc.speed }
  }
  function botLimit(b) {
    if (!flags || flags.mode === 'green' && !flags.incidents.length) return null
    const s = bots.distanceOf(b)
    const order = race.state.order
    const i = order.findIndex((c) => c.id === b.id)
    const gap = i > 0 ? order[i - 1].progress - order[i].progress : 0
    return { cap: flags.botCap(s, gap, scAhead(b.id)), noPass: flags.noPass(s), redPit: flags.mode === 'red' }
  }

  // красный флаг кончился: болиды (кроме сошедших) на решётку в порядке гонки, огни старта (Рома 29.10: «новый старт с места»)
  // порядок и круг лидера в момент красного флага: в боксах расстояние по оси ничего не значит (бокс у кого дальше), порядок берём оттуда
  let redGrid = null
  function restartFromGrid() {
    const order = (redGrid ? redGrid.ids.map((id) => race.car(id)) : race.state.order).filter((c) => c && !c.dnf)
    if (!order.length) return
    const lap = redGrid ? redGrid.lap : order[0].lap
    redGrid = null
    order.forEach((c, i) => {
      const p = track.grid[Math.min(i, track.grid.length - 1)]
      if (c.player) {
        vehicle.body.setTranslation({ x: p.x, y: (p.y || 0) + 0.05, z: p.z }, true)
        vehicle.body.setRotation({ x: 0, y: Math.sin(p.yaw / 2), z: 0, w: Math.cos(p.yaw / 2) }, true)
        vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
        vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
        vehicle.steerIn = vehicle.steerCmd = vehicle.steerVel = vehicle.delta = 0
        vehicle.throttle = vehicle.brake = 0
        rig.fresh = true
      } else bots.regrid(c.id, p)
    })
    race.regrid(lap)
    pitCtl = null
    pitRequest = false
    pitSince = performance.now()
    pitPlan = defaultPlan(vehicle, lapsLeft())
    laps?.restart()
    prevAhead = null
    sc?.hide()
    start?.begin()
    hud.setTrackFlag(null)
  }

  // громкость звука болида по расстоянию до камеры: рядом — полная, к 80 м — тишина
  const nearCam = (v) => {
    if (v === vehicle) return 1
    const t = v.body.translation()
    const c = camera.position
    return Math.max(0, 1 - Math.hypot(t.x - c.x, t.z - c.z) / 80)
  }

  function judgeContactPair(a, b) {
    if (!race?.state.running) return
    const ia = idOf(a)
    const ib = idOf(b)
    if (!ia || !ib) return
    const key = ia < ib ? ia + '|' + ib : ib + '|' + ia
    const now = performance.now()
    if (now - (contactSeen.get(key) ?? -1e9) < 4000) return
    const j = judgeContact(a, b)
    if (j.closing < 4) return // касание бортами: не разбираем
    contactSeen.set(key, now)
    const pen = contactPenalty(j.closing)
    if (!j.fault || !pen) {
      if (ia === 'player' || ib === 'player') hud.notify('Стюарды: гоночный инцидент, без наказания', false, 3)
      return
    }
    const fid = idOf(j.fault)
    race.addPenalty(fid, pen)
    const other = fid === ia ? ib : ia
    if (fid === 'player') hud.notify(`Стюарды: ты виноват в столкновении с ${nameOf(other)} · штраф +${pen} с`, true, 6)
    else if (other === 'player') hud.notify(`Стюарды: ${nameOf(fid)} виноват в столкновении с тобой · ему штраф +${pen} с`, false, 5)
  }

  // болид игрока вышел из гонки: разрушен, оторвано колесо, отказ мотора — или дисквалифицирован (чёрный флаг)
  function endRun(reason, kind = 'dnf') {
    if (retired) return
    retired = true
    retireText = kind === 'dsq' ? `Дисквалификация: ${reason}` : `Сход: ${reason}`
    pitCtl = null
    pitRequest = false
    orange = null
    hud.setFlag(null)
    if (kind === 'dsq') race?.disqualify('player', reason)
    else race?.retire('player', reason)
    // итоги — через пару секунд, чтобы успеть увидеть, что случилось; в гонке это же засчитывается в статистику
    resultsAt = performance.now() + 2500
    if (race) {
      career.races++
      career.dnf++
      saveCareer()
    }
    hud.notify(kind === 'dsq' ? `ДИСКВАЛИФИКАЦИЯ · ${reason}` : `СХОД · ${reason}`, true, 10)
    savePU()
  }

  function frame(now) {
    requestAnimationFrame(frame)
    const maxFps = settings.get('fps')
    if (maxFps && now - last < 1000 / maxFps - 1.5) return
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now

    for (const code of input.takePressed()) {
      // в главном меню и экранах свои клавиши (стрелки, Enter, Q, E): игровые не трогаем, кроме Esc
      if ((inMenu || ui.isOpen()) && code !== 'Escape') continue
      // в гараже и меню свои клавиши (стрелки, Enter, Q, E) — игровые не трогаем
      if ((setupScreen.isOpen() || menu.isOpen()) && code !== 'KeyG' && code !== 'Escape') continue
      if (code === 'KeyC') hud.notify('Камера: ' + rig.next(), false, 1.6)
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
      if (code === 'KeyP') cyclePaint()
      if (code === 'KeyT') telemetry.toggle()
      if (code === 'KeyG') {
        if (setupScreen.isOpen()) setupScreen.close()
        else openSetup(menu.isOpen())
      }
      if (code === 'Escape') {
        if (setupScreen.isOpen()) setupScreen.close()
        else if (ui.isOpen()) ui.back()
        else if (!inMenu) menu.toggle()
      }
      if (code === 'KeyM') muted = sound.toggleMute()
      if (code === 'KeyN' && start && !qualiShown) gridStart()
      if (code === 'Enter' && qualiShown) goRace()
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
      if (code === 'KeyL' && lane && !pitCtl) {
        pitRequest = !pitRequest
        hud.notify(pitRequest ? 'Заезд в боксы заказан: выбери шины и ремонт (I, K или клик), автопилот включится у въезда' : 'Заезд в боксы отменён', false, 3)
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
    const paused = setupScreen.isOpen() || menu.isOpen() || ui.isOpen() || inMenu || qualiShown
    if (paused) acc = 0
    else acc += dt
    let simDt = 0
    // зона режима прямой — по ближайшей точке оси трассы (на тестовой трассе оси нет — можно везде)
    input.aeroZone = laps && track.straightZone ? track.straightZone[laps.state.idx] === 1 : true
    // боты решают раз в кадр (60 Гц хватает), а едут на каждом шаге физики
    if (bots?.list.length && acc >= STEP) {
      const p = vehicle.body.translation()
      const ctx = race && { laps: race.state.laps, lapOf: (id) => race.car(id).lap, onPit: (id, c) => race.pitStop(id, c), onRetire: (id, why) => race.retire(id, why), limit: (b) => botLimit(b), hold: () => flags?.mode === 'red' }
      bots.think(dt, { x: p.x, z: p.z, speed: vehicle.state.fwdSpeed }, start?.waiting ? start.hold : null, !start?.waiting, ctx)
    }
    // въехал в пит-лейн — дальше ведёт игра
    if (lane && !pitCtl && !start?.waiting && !vehicle.pu.failed && acc >= STEP) {
      const p = vehicle.body.translation()
      const q = vehicle.body.rotation()
      const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
      const toEntry = entryS === null ? Infinity : (entryS - track.axis[laps.state.idx].distance_m + track.length) % track.length
      const planText = `шины: ${COMPOUNDS[pitPlan.compound].name}${pitPlan.wing ? ', ремонт кузова' : ''}`
      if (pitRequest && toEntry < PIT_TAKEOVER[0] && toEntry > PIT_TAKEOVER[1]) {
        // автопилот берёт руль заранее, как у ботов: не нужно успевать самому ни тормозить, ни попадать в въезд
        pitCtl = createPitStop(lane, PLAYER_BOX, { ...pitPlan }, { player: true, auto: true, damage: vehicle.damage, hold: () => flags?.mode === 'red' })
        pitRequest = false
        input.aero = false
        hud.notify(`Автопилот: заезд в боксы · ${planText}`, false, 4)
      } else if (pitEntryHit(lane, p.x, p.z, yaw)) {
        // въехал в пит-лейн сам, без заказа — дальше то же самое
        pitCtl = createPitStop(lane, PLAYER_BOX, { ...pitPlan }, { player: true, auto: true, damage: vehicle.damage, hold: () => flags?.mode === 'red' })
        pitRequest = false
        input.aero = false
        hud.notify(`Пит-лейн · автопилот, ограничитель 80 · ${planText}${pitPlan.wing ? ` · стоянка +${repairSeconds(vehicle.damage)} с` : ''}`, false, 4)
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
          if (orange) {
            orange = null
            hud.setFlag(null)
          }
          hud.notify('Шины сменили — выпускают', false, 2)
        }
        if (phase === 'release' && (pitCtl.state.phase === 'free' || pitCtl.state.phase === 'out')) hud.notify(`Выпуск · стоянка ${(pitCtl.state.service + pitCtl.state.reaction).toFixed(1)} с`, false, 3)
        if (phase === 'lane' && pitCtl.state.phase === 'in') hud.notify('Заезд в бокс', false, 2)
      } else {
        // пока горят огни старта, педали не работают
        lastInput = start ? start.hold(input.read()) : input.read()
      }
      // машина безопасности, VSC, красный флаг: ограничитель скорости, как в боксах (в F1 это делает сам пилот по дельте)
      if (flags && race?.state.running && !retired && !pitCtl && flags.mode !== 'green') {
        const cap = flags.cap(laps.state.s, playerGap, scAhead('player'))
        const sp = vehicle.state.fwdSpeed
        lastInput = { ...lastInput, boost: false, aero: false }
        if (cap <= 0) {
          lastInput.throttle = 0
          lastInput.brake = Math.max(lastInput.brake, sp > 1 ? 0.8 : 0.3)
        } else {
          if (sp > cap - 1) lastInput.throttle = 0
          if (sp > cap + 1) lastInput.brake = Math.max(lastInput.brake, Math.min(1, (sp - cap) * 0.25))
        }
      }
      // сошедший болид: мотор мёртв, педали не работают, катится и останавливается (потом эвакуатор)
      if (retired) lastInput = { ...lastInput, throttle: 0, brake: vehicle.state.fwdSpeed > 1 ? 0.5 : 0.15, steer: 0, boost: false, aero: false, handbrake: false, hold: true }
      car.snapshot(vehicle.body)
      vehicle.wet = weather.state.wet
      stepVehicle(vehicle, lastInput, STEP, track.surfaceAt)
      bots?.step(STEP, track.surfaceAt, weather.state.wet)
      world.step(events)
      collectImpacts(
        events,
        (v, r) => {
          if (v === vehicle) hud.notify(`Повреждение: ${r.hits.join(', ')}`, true, 3)
          marks.debris.spawn(v, r, v === vehicle ? livery.primary : bots?.list.find((b) => b.v === v)?.paint)
          sound.hit(r.sev, nearCam(v))
        },
        (a, b, force) => {
          judgeContactPair(a, b)
          if (a === vehicle || b === vehicle) sound.touch(Math.min(1, force / 120000), 1)
        },
      )
      acc -= STEP
    }
    // крылья закрылись (тормоз, руль, конец прямой) или F нажата вне зоны — просьба гаснет, на следующей прямой жать снова
    if (simDt > 0 && !vehicle.aeroOn) input.aero = false
    if (pitCtl?.state.phase === 'done' || pitCtl?.state.phase === 'abort') {
      if (pitCtl.state.phase === 'abort') hud.notify('Не пит-лейн — управление твоё', false, 3)
      else hud.notify('Управление твоё', false, 2)
      pitSince = performance.now()
      pitCtl = null
      pitPlan = defaultPlan(vehicle, lapsLeft())
    }
    // прокол, отказ мотора
    for (const e of vehicle.events) {
      hud.notify(e, true, 5)
      if (/Отказ/.test(e)) endRun(e.replace(/^Отказ силовой установки:?\s*/, '') || 'Отказ силовой установки')
    }
    vehicle.events.length = 0
    // болид разрушен или потерял колесо — сход (в F1 это красный флаг, кран и эвакуация)
    if (!retired && !start?.waiting) {
      const why = retireReason(vehicle)
      if (why) endRun(why)
    }
    // чёрно-оранжевый флаг: болид небезопасен — заехать в боксы за ORANGE_LAPS кругов, иначе чёрный флаг (дисквалификация)
    if (race?.state.running && !retired) {
      const me = race.car('player')
      const flag = mechanicalFlag(vehicle)
      if (flag && !orange && !pitCtl) {
        orange = { reason: flag, lap: me.lap }
        hud.notify(`Чёрно-оранжевый флаг · ${flag} · заезжай в боксы (L)`, true, 8)
      }
      if (orange && !flag) orange = null
      if (orange) {
        const left = ORANGE_LAPS - (me.lap - orange.lap)
        if (left <= 0 && !pitCtl) endRun('небезопасный болид не заехал в боксы', 'dsq')
        else hud.setFlag(`Чёрно-оранжевый флаг · ${orange.reason} · в боксы (L) · осталось ${Math.max(0, left)} кр.`)
      } else hud.setFlag(null)
    } else if (!race) hud.setFlag(null)
    // флаги раз в 0,25 с: инциденты, машина безопасности, эвакуатор, обгон под жёлтым
    flagAcc += dt
    if (flags && race?.state.running && flagAcc > 0.25) {
      const step = flagAcc
      flagAcc = 0
      const cars = [
        { id: 'player', x: vehicle.body.translation().x, z: vehicle.body.translation().z, speed: Math.abs(vehicle.state.fwdSpeed), retired, inPit: !!pitCtl, parked: pitCtl?.state.phase === 'service' || pitCtl?.state.phase === 'release' },
        ...bots.list.filter((b) => !b.gone).map((b) => ({ id: b.id, x: b.v.body.translation().x, z: b.v.body.translation().z, speed: Math.abs(b.v.state.fwdSpeed), retired: !!b.retired, inPit: !!b.pit, parked: b.pit?.state.phase === 'service' || b.pit?.state.phase === 'release' })),
      ]
      for (const ev of flags.update(step, cars)) {
        if (ev.type === 'incident') hud.notify(`Жёлтый флаг · ${nameOf(ev.inc.id)}: ${ev.text.toLowerCase()}`, true, 5)
        else if (ev.type === 'tow') tow.dispatch(ev.inc, {
          object: () => (ev.inc.id === 'player' ? car.group : bots?.list.find((b) => b.id === ev.inc.id)?.car.group),
          lift: () => liftCar(ev.inc.id), // крюк взял болид: физика выключена, дальше его двигает кран
          loaded: () => flags.clear(ev.inc.id), // закрепили на платформе — трасса свободна
          done: () => removeCar(ev.inc.id), // грузовик уехал с болидом
        })
        else if (ev.type === 'clear-all') {
          for (const i of flags.incidents) removeCar(i.id)
          tow.clear()
        } else if (ev.type === 'sc') {
          sc?.deploy(raceLead()?.s ?? null)
          hud.notify(ev.text, true, 7)
        } else if (ev.type === 'red') {
          const ord = race.state.order.filter((c) => !c.dnf)
          redGrid = { ids: ord.map((c) => c.id), lap: ord[0]?.lap ?? 0 }
          // красный флаг: машина безопасности уходит, все едут в боксы — игрок тоже (автопилот возьмёт руль у въезда)
          sc?.hide()
          if (!retired && !pitCtl) {
            pitPlan = defaultPlan(vehicle, Math.max(1, lapsLeft()))
            pitRequest = true
          }
          hud.notify(ev.text, true, 8)
        } else if (ev.type === 'restart') {
          restartFromGrid()
          hud.notify(ev.text, false, 5)
        } else if (ev.type === 'green') {
          sc?.hide()
          hud.notify(ev.text, false, 4)
        } else if (ev.text) hud.notify(ev.text, true, 7)
      }
      // зазор игрока до болида впереди и обгон под флагами (в F1 за него +5 с)
      const order = race.state.order
      const mei = order.findIndex((c) => c.player)
      playerGap = mei > 0 ? order[mei - 1].progress - order[mei].progress : 0
      const sMe = laps.state.s
      const flagged = flags.mode !== 'green' || flags.noPass(sMe)
      if (flagged && !retired && mei >= 0) {
        const ahead = new Set(order.slice(0, mei).filter((c) => !c.dnf && !c.inPit).map((c) => c.id))
        if (prevAhead) {
          for (const id of prevAhead) {
            if (!ahead.has(id) && !race.car(id).dnf && !race.car(id).inPit && now - lastPassPenalty > 10000) {
              lastPassPenalty = now
              race.addPenalty('player', 5)
              hud.notify(`Стюарды: обгон ${nameOf(id)} под флагом · штраф +5 с`, true, 6)
            }
          }
        }
        prevAhead = ahead
      } else prevAhead = null
      // табло флагов
      let text = null
      let kind = ''
      if (flags.mode === 'red') {
        const info = flags.redInfo()
        text = !info.allIn ? (pitCtl ? 'Красный флаг · в боксах · ждём остальных' : 'Красный флаг · езжай в боксы') : `Красный флаг · старт с места через ${Math.ceil(info.left)} с`
        kind = 'red'
      } else if (flags.mode === 'sc') {
        text = flags.ending() ? 'Машина безопасности заходит в боксы · зелёный флаг, когда она зайдёт' : `Машина безопасности · лимит ${Math.round(flags.cap(sMe, playerGap, scAhead('player')) * 3.6)} км/ч · обгон запрещён`
        kind = 'sc'
      } else if (flags.mode === 'vsc') {
        text = `Виртуальная машина безопасности · лимит ${Math.round(VSC_SPEED * 3.6)} км/ч`
        kind = 'vsc'
      } else if (flags.inYellow(sMe)) {
        const d = flags.nextIncident(sMe)
        text = `Жёлтый флаг · ${d !== null ? `остановившийся болид через ${Math.round(d)} м` : 'остановившийся болид рядом'} · обгон запрещён`
        kind = ''
      }
      hud.setTrackFlag(text, kind)
    }
    // мотор греется: один раз за 20 с говорим, что сбросить газ
    if (!retired && vehicle.engineHeat > 0.95 && now - lastEngineNote > 20000) {
      lastEngineNote = now
      hud.notify('Мотор перегревается: сбрось газ, радиатор не справляется', true, 5)
    }
    // перегрев шин: любая выше окна на 15° дольше двух секунд — один раз за 45 с говорим, что с этим делать (Рома 29.10: «шины горят, не понимаю почему»)
    if (!start?.waiting && !pitCtl) {
      const win = COMPOUNDS[vehicle.compound].window[1] + 15
      if (vehicle.tyres.some((t) => !t.puncture && t.temp > win)) heatSince = heatSince ?? now
      else heatSince = null
      if (heatSince !== null && now - heatSince > 2000 && now - lastHeatNote > 45000) {
        lastHeatNote = now
        hud.notify('Шины перегреваются: отпускай руль между поворотами и не держи газ в скольжении', true, 5)
      }
    }
    // подвеска сломана (выше 70%): говорим один раз, пока не починят новым стартом
    const suspBroken = Math.max(vehicle.damage.suspL, vehicle.damage.suspR) > 0.7
    if (suspBroken && !suspBrokenSeen) hud.notify('Подвеска сломана: сторона проседает, колесо не слушается руля. Подвеску в боксах не чинят — доезжай аккуратно', true, 6)
    suspBrokenSeen = suspBroken
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
      ghost?.update(simDt, laps.state, vehicle.body, !race && settings.get('ghost'))
      // квалификация: засчитанные круги, строка режима, конец после QUALI_LAPS кругов
      if (quali) {
        if (quali.seen === null) quali.seen = laps.state.completed
        if (laps.state.completed !== quali.seen) {
          quali.seen = laps.state.completed
          quali.times.push(laps.state.lastLap)
        }
        const text = `Квалификация · круг ${Math.min(Math.max(laps.state.lap, 1), QUALI_LAPS)} из ${QUALI_LAPS}` + (quali.times.length ? ` · лучший ${formatTime(Math.min(...quali.times))}` : '')
        if (text !== quali.text) hud.setMode((quali.text = text))
        if (laps.state.lap > QUALI_LAPS) finishQuali()
      }
      // едет против хода гонки 3 секунды — возвращаем на трассу носом в нужную сторону
      if (!pitCtl && laps.state.wrongWay > WRONG_WAY_RESET) resetToTrack()
      // границы трассы: все четыре колеса за белой линией (в пит-лейне не считаются)
      // в пит-лейне, на въезде и выезде границы не считаются: белую линию там пересекают по правилам
      const inPitArea = !!pitCtl || pitRequest || performance.now() - pitSince < 8000 || nearPitLane(p.x, p.z)
      if (!start?.waiting && limits.update(simDt, !inPitArea && wheelsOut(track.axis, laps.state.idx, vehicle.body, TUNING))) {
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
      if (!wasDone && race.state.playerDone) {
        hud.showResults(race.state)
        const me = race.state.cars.find((c) => c.player)
        const pos = race.state.order.indexOf(me) + 1
        career.races++
        if (me.dnf || me.dsq) career.dnf++
        else {
          if (pos === 1) career.wins++
          if (pos <= 3) career.podiums++
        }
        saveCareer()
      }
    }

    if (resultsAt && now > resultsAt) {
      resultsAt = 0
      if (race) hud.showResults(race.state)
      else hud.showRetire(retireText)
    }
    car.setCompound(vehicle.compound)
    car.sync(acc / STEP, vehicle, lastInput)
    bots?.sync(acc / STEP)
    // машина безопасности и эвакуатор — после того, как болиды выставлены: кран двигает поднятый болид сам
    if (sc?.active) {
      const home = sc.update(paused ? 0 : dt, raceLead()?.s ?? null, flags.ending())
      if (home) {
        flags.scHome()
        hud.notify('Машина безопасности зашла в боксы', false, 4)
      }
    }
    tow?.update(paused ? 0 : dt)
    weather.update(paused ? 0 : dt, camera, !inMenu && !paused)
    hud.setWeather(inMenu ? null : weather.label())
    // пошёл дождь или трасса подсохла: подсказка и план пит-стопа на нужные шины
    if (!inMenu) {
      const need = rainTyreFor(weather.state.wet)
      const onRain = vehicle.compound === 'intermediate' || vehicle.compound === 'wet'
      const now = need ?? (onRain && weather.state.wet > 0.2 ? rainNeed : null)
      if (now !== rainNeed) {
        rainNeed = now
        if (!pitCtl) pitPlan = defaultPlan(vehicle, lapsLeft())
        if (race) hud.notify(now === 'wet' ? 'Ливень — нужны дождевые шины (L — в боксы)' : now === 'intermediate' ? 'Трасса мокрая — нужны промежуточные (L — в боксы)' : 'Трасса подсохла — пора на слики (L — в боксы)', false, 6)
      }
    }
    particles.update(paused ? 0 : dt, vehicle, bots?.list, camera, renderer, weather.state.wet)
    marks.update(paused ? 0 : dt, vehicle, bots?.list, camera, weather.state.wet)
    env.follow(car.group.position)
    const view = input.takeLook()
    rig.update(dt, vehicle, paused && !rig.showcase ? null : view)
    hud.update(vehicle.state, vehicle.aero, laps, car.group.position, input.abs, bots?.list)
    hud.updateRace(race?.state, bots?.list)
    // запас топлива в кругах до финиша (как «fuel delta» на руле F1): расход за круг — по факту, пока не проехан круг — по расчёту
    if (vehicle.fuelOn && race) {
      const me = race.car('player')
      const done = me.lap > 0 ? me.lap - 1 + laps.state.s / track.length : 0 // кругов проехано (race.lap — номер текущего круга)
      const nominal = (track.length / 1000) * FUEL_PER_KM
      const perLap = done > 0.6 ? (vehicle.fuelStart - vehicle.fuel) / done : nominal
      vehicle.fuelDelta = vehicle.fuel / Math.max(perLap, nominal * 0.5) - Math.max(0, race.state.laps - done)
    } else vehicle.fuelDelta = null
    hud.updateCar(vehicle, pitPlan, pitCtl)
    hud.updatePitPlan(pitRequest && !pitCtl, pitPlan, (() => {
      if (entryS === null) return 0
      const p = (entryS - track.axis[laps.state.idx].distance_m + track.length) % track.length
      return p < track.length / 2 ? p : 0
    })(), vehicle.damage)
    telemetry.update(vehicle)
    sound.update(vehicle, lastInput, paused, { bots: bots?.list, camera, rain: weather.state.rain, dt: paused ? 0 : dt })
    renderer.render(scene, camera)
  }
  requestAnimationFrame(frame)

  // для проверок и настройки из консоли браузера
  window.__game = { THREE, scene, camera, renderer, vehicle, car, track, input, rig, telemetry, setupScreen, sound, laps, start, gridStart, menu, ui, settings, enterMenu, startSession, endRun, flags, tow, sc, frame, bots, hud, limits, getRace: () => race, tuning: TUNING, resetToTrack, particles, marks, weather }
}

main().catch((e) => {
  console.error(e)
  document.getElementById('loader').querySelector('.caps').textContent = 'Ошибка: ' + e.message
})
