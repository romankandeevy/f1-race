// Физика болида без привязки к Three.js: чтобы её можно было гонять и без браузера.
// Подвеска — лучи из точек крепления с пружинами, двухступенчатыми амортизаторами и стабилизаторами;
// геометрия — развал (статический + от хода и крена) и схождение; шина — упрощённая формула Пацейки
// с общим запасом сцепления на тягу/тормоз и поворот; аэро — крылья, граунд-эффект днища, наклон кузова.
// Rapier только интегрирует кузов как твёрдое тело. Настройка болида — TUNING.setup.
// Износ шин, повреждения и износ мотора — wear.js: здесь только применяются их множители.
import { TUNING, setupPhysics, engineBrakeOf, damperOf, steerLockOf, coolDragOf } from './tuning.js'
import { freshTyres, tyreGrip, updateTyres, freshDamage, aeroDamage, applyImpact, freshPowerUnit, updatePowerUnit, powerFactor, suspDamageAt, SUSP_BROKEN, updateEngineHeat, freshBrakes, brakeEff, updateBrakes, updateFuel } from './wear.js'

// кузов → болид: по коллайдеру из событий удара Rapier найти, чей это болид.
// Дескрипторы коллайдеров свои у каждого мира физики: на сервере несколько комнат (миров) в одном процессе,
// поэтому список — по миру (collectImpacts(…, world)); общий hullOwners — для игры в браузере, где мир один
export const hullOwners = new Map()
const hullsByWorld = new WeakMap()
// новая гонка начинает с чистого общего списка, иначе старый болид получит чужие удары
export function clearHullOwners() {
  hullOwners.clear()
}
function registerHull(world, handle, v) {
  hullOwners.set(handle, v)
  let m = hullsByWorld.get(world)
  if (!m) hullsByWorld.set(world, (m = new Map()))
  m.set(handle, v)
}

// Группы столкновений Rapier: (кто я << 16) | (с кем сталкиваюсь). Трасса — все биты по умолчанию.
// Лучи подвески и днища видят только трассу: иначе колесо «вставало» на соседний болид и подвеска
// выстреливала обе машины в небо (Рома 28.10). «Призрак» — после возврата на трассу 3 с сквозь болиды.
// Два корпуса на болид (Рома 29.10: «столкновения с другими болидами — полное дерьмо»): о стены и поребрики болид бьётся
// корпусом WALL (скользит почти без трения и не отскакивает), а о другие болиды — корпусом CC: с трением и небольшим
// упругим откатом, чтобы болиды расходились после удара, а не слипались и ехали вместе.
const CAR = 0x0002
const CC = 0x0004
const WALL_GROUPS = (CAR << 16) | (0xffff & ~(CAR | CC))
const CC_GROUPS = (CC << 16) | CC
const GHOST_CC = (CC << 16) | 0
const RAY_GROUPS = (0x0001 << 16) | (0xffff & ~(CAR | CC))
// трасса, стены и земля: членство только «0001», поэтому корпус CC (он сталкивается лишь с группой CC) их не видит;
// с группой «все биты» по умолчанию он бился бы о стены с трением 0,3 и отскакивал. Все статичные коллайдеры — с этой маской
export const STATIC_GROUPS = (0x0001 << 16) | 0xffff
export function setGhost(v, on) {
  v.hullCar.setCollisionGroups(on ? GHOST_CC : CC_GROUPS)
}

// После world.step(events): удары по кузову → повреждения. Сила удара и направление — по тому,
// как резко изменилась скорость кузова за шаг (prevVel — скорость в начале шага; шины и мотор
// за шаг дают меньше 0,2 м/с, удар о стену — метры в секунду). onImpact(v, { sev, hits }) — для сообщений.
export function collectImpacts(events, onImpact, onContact, world = null) {
  const owners = (world && hullsByWorld.get(world)) || hullOwners
  const hit = new Set()
  events.drainContactForceEvents((e) => {
    // два болида: сообщаем стюардам, кто с кем (onContact(a, b, сила, Н))
    const va = owners.get(e.collider1())
    const vb = owners.get(e.collider2())
    if (va && vb && va !== vb && onContact) onContact(va, vb, e.totalForceMagnitude())
    for (const h of [e.collider1(), e.collider2()]) {
      const v = owners.get(h)
      if (!v) continue
      v.impactT = IMPACT_TIME
      // тряска камеры: чем сильнее удар, тем резче (200 кН и больше — на полную)
      v.impactShake = Math.max(v.impactShake, clamp(e.totalForceMagnitude() / 200000, 0.2, 1))
      if (v.wearOn && !v.autopilot) hit.add(v) // автопилот пит-стопа: новых повреждений нет
    }
  })
  for (const v of hit) {
    const lv = v.body.linvel()
    const r = applyImpact(v, lv.x - v.prevVel.x, lv.z - v.prevVel.z, v.rand)
    if (r && onImpact) onImpact(v, r)
  }
}

// после сильного удара, событие контакта (v.impactT секунд) корпус не подпрыгивает, не клюёт и не раскручивается: вертикальная скорость ≤ IMPACT_VY,
// крен и тангаж гасятся, рыскание ограничено; шины в это время держат хуже (болид скребёт, а не отскакивает)
const IMPACT_TIME = 0.5 // с
const IMPACT_VY = 0.4 // м/с
const IMPACT_TILT = 0.6 // множитель крена и тангажа за шаг
const IMPACT_YAW = 4 // рад/с
const IMPACT_GRIP = 0.35 // доля сцепления шин, которая теряется сразу после удара
const G = 9.81
const DEG = Math.PI / 180
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

// Шаг идёт 240 раз в секунду, поэтому векторы не создаются заново, а пишутся в готовые объекты:
// иначе сборщик мусора периодически останавливает игру.
const vec = () => ({ x: 0, y: 0, z: 0 })
const S = { fwd: vec(), up: vec(), left: vec(), down: vec(), o: vec(), origin: vec(), fw: vec(), lat: vec(), pv: vec(), force: vec(), p: vec() }
const AXLES = [
  [0, 1, 'arbF'],
  [2, 3, 'arbR'],
]
const PLANK_ENDS = [1, -1]
const TYRE_KEYS = ['tyreFL', 'tyreFR', 'tyreRL', 'tyreRR']

// поворот вектора кватернионом, результат в out
function rot(q, x, y, z, out) {
  const tx = 2 * (q.y * z - q.z * y)
  const ty = 2 * (q.z * x - q.x * z)
  const tz = 2 * (q.x * y - q.y * x)
  out.x = x + q.w * tx + (q.y * tz - q.z * ty)
  out.y = y + q.w * ty + (q.z * tx - q.x * tz)
  out.z = z + q.w * tz + (q.x * ty - q.y * tx)
  return out
}
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
function cross(a, b, out) {
  const x = a.y * b.z - a.z * b.y
  const y = a.z * b.x - a.x * b.z
  const z = a.x * b.y - a.y * b.x
  out.x = x
  out.y = y
  out.z = z
  return out
}
function norm(a) {
  const l = Math.hypot(a.x, a.y, a.z) || 1
  a.x /= l
  a.y /= l
  a.z /= l
  return a
}

// точка крепления подвески: выше клиренс — точка ниже в кузове, кузов сидит выше над колёсами
function hardYOf(T, w) {
  const P = setupPhysics(T.setup)
  const ride = w.front ? P.rideF : P.rideR
  return T.wheelY + T.suspensionRest - T.staticSag - ride
}

// двухступенчатый амортизатор: медленная фаза (крен, клевки) жёсткая, быстрая (бордюры) мягче
function damperForce(T, speed, slow) {
  const a = Math.abs(speed)
  const f = a <= T.damperKnee ? slow * a : slow * T.damperKnee + slow * T.damperFastRatio * (a - T.damperKnee)
  return Math.sign(speed) * f
}

// крылья: доли прижима осей и сопротивление (при 30/30 — ровно как в таблице tuning.js)
function aeroOf(T) {
  // 0–50, при 30 — ровно как в таблице tuning.js
  const fw = T.setup.frontWing / 50
  const rw = T.setup.rearWing / 50
  return {
    front: T.aeroFrontShare * (0.7 + 0.5 * fw),
    rear: (1 - T.aeroFrontShare) * (0.7 + 0.5 * rw),
    drag: 0.85 + 0.25 * rw,
  }
}

export function createVehicle(RAPIER, world, spawn = {}, T = TUNING) {
  const { x = 0, y = 0.05, z = 0, yaw = 0, wear = true } = spawn // wear: false — без износа и поломок (проверки физики)

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setAngularDamping(T.angularDamping)
      .setCanSleep(false)
      .setCcdEnabled(true),
  )
  // низкий «грузовой» блок: даёт массу и задаёт центр масс. Длина подобрана под инерцию
  // поворота ~1150 кг·м², как у болида (чем меньше, тем охотнее болид поворачивается)
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.55, 0.175, 2.0)
      .setCollisionGroups(WALL_GROUPS) // как корпус: стены видит, других болидов — нет
      .setTranslation(0, T.comY, T.comZ)
      .setMass(T.mass)
      .setFriction(0.1)
      .setRestitution(0),
    body,
  )
  // внешний габарит для столкновений со стенами: массы не имеет. Сильный контакт — событие удара (повреждения)
  const hull = world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.95, 0.2, 2.68)
      .setCollisionGroups(WALL_GROUPS)
      .setTranslation(0, T.comY, 0.16)
      .setDensity(0)
      .setFriction(0.05)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setRestitution(0)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(15000),
    body,
  )
  // габарит для встречи с другими болидами: такой же, но трение T.carFriction и упругость T.carRestitution
  const hullCar = world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.95, 0.2, 2.68)
      .setCollisionGroups(CC_GROUPS)
      .setTranslation(0, T.comY, 0.16)
      .setDensity(0)
      .setFriction(T.carFriction)
      .setRestitution(T.carRestitution)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(15000),
    body,
  )

  const spots = [
    { x: T.front.x, z: T.front.z, front: true },
    { x: -T.front.x, z: T.front.z, front: true },
    { x: T.rear.x, z: T.rear.z, front: false },
    { x: -T.rear.x, z: T.rear.z, front: false },
  ]
  const wheels = spots.map((s) => ({
    ...s,
    side: s.x > 0 ? 1 : -1, // +1 левое колесо, −1 правое
    hardY: hardYOf(T, s),
    contact: false,
    compression: T.staticSag,
    prevCompression: T.staticSag,
    centerY: T.wheelY, // центр колеса в осях кузова — для картинки
    camberBody: 0, // развал относительно кузова, рад (для картинки)
    camberGround: 0, // развал относительно дороги, рад (для шины)
    point: vec(),
    normal: vec(),
    load: 0,
    steer: 0,
    slip: 0,
    omega: 0,
    spin: 0,
    sliding: false,
    surface: 'asphalt',
    grip: 1, // сглаженное сцепление покрытия под колесом
    rolling: T.surfaces.asphalt.rolling,
    fx: 0,
    fy: 0,
    cap: 0,
    brakeP: 0, // мощность, которую тормоз колеса переводит в тепло диска, Вт
  }))

  const v = {
    T,
    world,
    body,
    wheels,
    ray: new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }),
    impactT: 0, // сколько ещё секунд идёт «разгрузка» после удара
    engineHeat: 0.3, // перегрев мотора: 0,6 — норма на полном газу, выше 0,9 мощность падает, выше 1,15 мотор умирает (см. wear.js)
    hotTime: 0,
    impactShake: 0, // сила тряски камеры от удара, 0..1; гаснет за ~0,5 с
    throttle: 0, // педали после плавного нажатия, 0..1
    brake: 0,
    steerCmd: 0, // команда руля с клавиатуры, -1..1
    steerIn: 0, // сглаженное положение руля
    steerVel: 0,
    delta: 0, // средний угол передних колёс, рад
    aero: 0, // раскрытие крыльев в режиме прямой 0…1
    aeroOn: false, // режим прямой включён
    battery: 1, // заряд батареи 0…1
    aeroK: T.downforceK, // текущий коэффициент прижима (нужен рулю)
    state: {
      speedKmh: 0,
      fwdSpeed: 0,
      gear: 1,
      rpm: 0,
      battery: 1, // заряд батареи 0…1
      boosting: false, // режим обгона работает
      ersMode: 'balanced', // режим батареи (с учётом Shift)
      aeroOn: false, // режим прямой
      aeroZone: false, // болид в зоне прямой
      ersFlow: 0, // поток энергии: + отдаёт в колёса, − заряжается (доля от максимума)
      surfaces: ['asphalt', 'asphalt', 'asphalt', 'asphalt'],
      braking: false,
      gLong: 0,
      gLat: 0,
      rideF: T.plankY * 1000, // клиренс днища спереди и сзади, мм
      rideR: T.plankY * 1000,
      aeroMult: 1, // граунд-эффект: во сколько раз прижим больше табличного
      plankContact: 0, // сила, с которой днище трётся об асфальт, Н
    },
    // износ и поломки (wear.js)
    compound: 'medium',
    tyres: freshTyres(80),
    damage: freshDamage(),
    pu: freshPowerUnit(),
    brakeTemp: freshBrakes(), // температура тормозных дисков ПЛ, ПП, ЗЛ, ЗП, °C
    brakeHot: false,
    fuelOn: false, // топливо считается только в гонке (setFuel в wear.js); иначе бак не тратится и ничего не весит
    fuel: 0, // кг
    fuelStart: 0,
    massFuel: 0, // сколько топлива сейчас учтено в массе кузова
    events: [], // что случилось за шаг (прокол, отказ мотора) — main показывает игроку
    wearOn: wear,
    wet: 0, // насколько мокрая трасса 0…1 (погода, main.js); шины держат по wetGrip
  }
  v.hullCar = hullCar
  registerHull(world, hull.handle, v)
  registerHull(world, hullCar.handle, v)
  return v
}

export function gearInfo(speedKmh, T = TUNING) {
  const tops = T.gearTopKmh
  let g = 0
  while (g < tops.length - 1 && speedKmh > tops[g]) g++
  const low = g === 0 ? 0 : tops[g - 1]
  const t = clamp((speedKmh - low) / (tops[g] - low), 0, 1)
  return { gear: g + 1, rpm: 0.55 + 0.45 * t }
}

// Руль. Клавиша — это только «влево/вправо/ничего», поэтому:
// 1) команда руля едет к цели с ограниченной скоростью (на скорости медленнее — короткое касание
//    даёт маленький угол), а сам руль догоняет команду пружиной с демпфером — без рывков;
// 2) упор зависит от скорости: колёса поворачиваются ровно настолько, чтобы шина вышла на пик
//    сцепления, — дальше болид просто пойдёт в снос;
// 3) когда клавиши отпущены, колёса сами встают по направлению движения центра масс и ловят занос.
//    Именно центра масс: скорость передней оси при вращении уходит в сторону вращения,
//    и руль по ней раскручивал бы болид ещё сильнее.
function updateSteering(v, input, dt, fwdSpeed, latSpeed) {
  const T = v.T
  const speed = Math.abs(fwdSpeed)
  const target = clamp(input.steer, -1, 1)
  // слой 1: команда руля едет к цели с ограниченной скоростью — на скорости медленнее,
  // поэтому короткое касание даёт маленький угол
  const k = speed / T.steerRateSpeedRef
  const returning = Math.abs(target) < Math.abs(v.steerCmd) || target * v.steerCmd < 0
  const rate = returning ? T.steerReturnRate : T.steerRate / (1 + k * k)
  v.steerCmd += clamp(target - v.steerCmd, -rate * dt, rate * dt)
  // слой 2: пружина с демпфером к команде — скругляет начало и конец движения, без рывков
  const w0 = T.steerOmega
  v.steerVel += (w0 * w0 * (v.steerCmd - v.steerIn) - 2 * w0 * v.steerVel) * dt
  v.steerIn = clamp(v.steerIn + v.steerVel * dt, -1, 1)

  const shaped = Math.sign(v.steerIn) * Math.pow(Math.abs(v.steerIn), T.steerCurve)
  const aLim = T.tireMu * G * (1 + (v.aeroK * speed * speed) / (T.mass * G))
  const gripAngle = Math.atan((T.wheelBase * aLim) / Math.max(speed * speed, 1)) + T.steerSlipMargin
  const lock = steerLockOf(T.setup, T) // угол поворота колёс — из настройки (по умолчанию 24°, как было)
  let want = Math.min(lock, gripAngle) * shaped

  // самовозврат: колёса по направлению движения (угол скольжения кузова)
  if (fwdSpeed > 3) {
    let align = Math.atan2(latSpeed, fwdSpeed)
    align = Math.sign(align) * Math.max(0, Math.abs(align) - T.selfSteerDeadzone)
    const weight = T.selfSteer * (1 - Math.abs(shaped)) * clamp((fwdSpeed - 3) / 7, 0, 1)
    want += weight * align
  }
  want += aeroDamage(v.damage).pull // погнутая подвеска и сломанное крыло тянут в сторону
  want = clamp(want, -lock, lock)
  v.delta += clamp(want - v.delta, -T.maxSteerSpeed * dt, T.maxSteerSpeed * dt)

  // Аккерман: внутреннее колесо поворачивается чуть больше внешнего
  let left = v.delta
  let right = v.delta
  if (Math.abs(v.delta) > 1e-4) {
    const radius = T.wheelBase / Math.tan(Math.abs(v.delta))
    const inner = Math.atan(T.wheelBase / (radius - T.frontTrack / 2))
    const outer = Math.atan(T.wheelBase / (radius + T.frontTrack / 2))
    left = v.delta > 0 ? inner : -outer
    right = v.delta > 0 ? outer : -inner
  }
  // схождение: спереди колёса чуть смотрят наружу (острее вход), сзади — внутрь (устойчивость)
  const toeF = T.setup.toeF * DEG
  const toeR = T.setup.toeR * DEG
  v.wheels[0].steer = left + toeF
  v.wheels[1].steer = right - toeF
  // подвеска повреждена: у колеса смещено схождение (смотрит наружу), а у сломанной — перестаёт слушаться руля и болтается
  for (const w of [v.wheels[0], v.wheels[1]]) {
    const sd = suspDamageAt(v.damage, true, w.side)
    if (sd <= 0) continue
    const broken = clamp((sd - SUSP_BROKEN) / (1 - SUSP_BROKEN), 0, 1)
    w.steer += w.side * sd * 0.004
    w.steer = w.steer * (1 - 0.8 * broken) + w.side * 0.025 * 0.8 * broken
  }
  v.wheels[2].steer = -toeR
  v.wheels[3].steer = toeR
}

// input: { throttle 0..1, brake 0..1, steer -1..1 (влево +), handbrake bool, aero bool (просит режим прямой), aeroZone bool (болид в зоне прямой) }
// surfaceAt(x, z, collider) -> 'asphalt' | 'gravel' | 'grass' | 'kerb' (collider — деталь трассы под колесом)
// Автопилот пит-стопа (v.autopilot, ставит main.js, пока пит-контроллер ведёт болид): физика едет как у целого болида —
// побитые крылья, днище, подвеска, оторванное колесо и прокол не мешают доехать до бокса (Рома 30.10: «даже автопилот не
// смог заехать, меня настолько разъебало»). Настоящие повреждения не трогаются: их чинят в боксе, табло их показывает.
const CLEAN = freshDamage()
const punctures = [false, false, false, false]
export function stepVehicle(v, input, dt, surfaceAt = () => 'asphalt') {
  if (!v.autopilot || !v.wearOn) return stepVehicleRaw(v, input, dt, surfaceAt)
  const real = v.damage
  for (const k in CLEAN) if (k !== 'lost') CLEAN[k] = 0
  CLEAN.lost.fill(0)
  v.damage = CLEAN
  v.tyres.forEach((t, i) => {
    punctures[i] = t.puncture
    t.puncture = false
  })
  try {
    stepVehicleRaw(v, input, dt, surfaceAt)
  } finally {
    v.damage = real
    v.tyres.forEach((t, i) => (t.puncture = t.puncture || punctures[i]))
  }
}

function stepVehicleRaw(v, input, dt, surfaceAt) {
  const { T, body, wheels, world } = v
  const setup = T.setup
  // в Rapier добавленные силы копятся между шагами, пока их не сбросить
  body.resetForces(true)
  body.resetTorques(true)
  // топливо — масса: пересчитываем массу кузова, когда бак изменился на 0,25 кг (Rapier пересчитывает и инерцию)
  const fuelKg = v.fuelOn ? v.fuel : 0
  if (Math.abs(fuelKg - v.massFuel) > 0.25 || (fuelKg === 0 && v.massFuel !== 0)) {
    body.setAdditionalMass(fuelKg, true)
    v.massFuel = fuelKg
  }

  const q = body.rotation()
  const pos = body.translation()
  const vel = body.linvel()
  const fwd = rot(q, 0, 0, 1, S.fwd)
  const up = rot(q, 0, 1, 0, S.up)
  const left = rot(q, 1, 0, 0, S.left)
  const speed = Math.hypot(vel.x, vel.y, vel.z)
  const fwdSpeed = dot(vel, fwd)

  // перегрузки для телеметрии и камеры: ускорение кузова в его осях, сглаженное
  const pv0 = v.prevVel
  if (pv0) {
    const ax = (vel.x - pv0.x) / dt
    const az = (vel.z - pv0.z) / dt
    const k = Math.min(1, dt / 0.08)
    v.state.gLong += ((ax * fwd.x + az * fwd.z) / G - v.state.gLong) * k
    v.state.gLat += ((ax * left.x + az * left.z) / G - v.state.gLat) * k
  } else v.prevVel = vec()
  // после сильного удара (collectImpacts ставит impactT): Rapier гасит скорость жёстко, и без «разгрузки» корпус подпрыгивает,
  // клюёт и крутится, как на пружине (Рома 29.10: «столкновения пружинятся»)
  v.impactShake *= Math.exp(-dt * 5)
  if (v.impactT > 0) {
    v.impactT -= dt
    const av = body.angvel()
    if (vel.y > IMPACT_VY) body.setLinvel({ x: vel.x, y: IMPACT_VY, z: vel.z }, true)
    body.setAngvel({ x: av.x * IMPACT_TILT, y: clamp(av.y, -IMPACT_YAW, IMPACT_YAW), z: av.z * IMPACT_TILT }, true)
  }
  v.prevVel.x = vel.x
  v.prevVel.y = vel.y
  v.prevVel.z = vel.z

  updateSteering(v, input, dt, fwdSpeed, dot(vel, left))

  // активная аэродинамика: режим прямой только в зоне; тормоз, руль или конец зоны его закрывают
  const zone = input.aeroZone !== false
  if (!zone || input.brake > 0.05 || Math.abs(v.steerIn) > T.aeroCloseSteer) v.aeroOn = false
  else if (input.aero) v.aeroOn = true
  v.aero += clamp((v.aeroOn ? 1 : 0) - v.aero, -dt * T.aeroCloseRate, dt * T.aeroOpenRate)

  // педали: клавиша нажимает педаль плавно, как нога
  const pedal = (cur, want, rise, fall) => cur + clamp(want - cur, -fall * dt, rise * dt)
  v.throttle = pedal(v.throttle, input.throttle, T.throttleRise, T.throttleFall)
  v.brake = pedal(v.brake, input.brake, T.brakeRise, T.brakeFall)
  const throttle = v.throttle
  const brakePedal = v.brake

  // тяга и тормоз по педалям
  let drive = 0
  let brake = 0
  // режим обгона: Shift + газ, пока в батарее есть заряд
  // режим батареи: клавиши 1–4, Shift — мгновенный «Обгон»
  const ersMode = input.boost ? 'overtake' : T.ersModes[input.ersMode] ? input.ersMode : 'balanced'
  const ers = T.ersModes[ersMode]
  const driving = throttle > 0.05 && fwdSpeed > -1
  // отдаёт, пока есть заряд; «Зарядка» забирает мощность всегда
  const deploy = ers.deploy > 0 ? (driving && v.battery > 0 ? ers.deploy : 0) : ers.deploy
  const boosting = !!input.boost && deploy > 0
  if (throttle > 0.001) {
    if (fwdSpeed < -1) brake = throttle
    else {
      // карта мотора: на малой скорости мощность отдаётся мягче (в F1 так настраивают мотор, это не антипробуксовка)
      const map = T.lowSpeedDrive + (1 - T.lowSpeedDrive) * clamp(Math.abs(fwdSpeed) / T.torqueMapSpeed, 0, 1)
      const force = T.maxDriveForce + (T.boostForce * deploy) / T.boostPower // «Зарядка» тягу забирает
      const power = T.power + deploy
      const dry = v.fuelOn && v.fuel <= 0 // бак пуст — мотор глохнет
      drive = dry ? 0 : Math.min(force * map, power / Math.max(Math.abs(fwdSpeed), 1)) * throttle * powerFactor(v.pu, v.engineHeat)
    }
  } else if (brakePedal > 0.001) {
    // hold — стоим в боксе: тормоз держит на месте и не включает задний ход (иначе болид в пит-стопе сам едет назад)
    if (fwdSpeed > 1 || input.hold) brake = brakePedal
    else if (fwdSpeed > -T.reverseMaxSpeed) drive = -T.reverseForce * brakePedal
  }
  const brakeTotal = (brake * T.brakeForce * setup.brakePressure * (1 - 0.4 * v.damage.brakes)) / 100 // разбитые тормозные каналы — слабее тормоза

  // батарея: обгон тратит, торможение заряжает
  const spend = Math.max(0, deploy) * throttle
  const charge = driving ? ers.charge * throttle : 0
  const harvest = (brakeTotal > 0 && fwdSpeed > 1 ? Math.min(T.harvestPower, brakeTotal * fwdSpeed * T.harvestShare) : 0) + charge
  v.battery = clamp(v.battery + ((harvest - spend) * dt) / (T.batteryMJ * 1e6), 0, 1)
  const biasF = setup.brakeBias / 100
  const P = setupPhysics(setup)

  // Дифференциал (вкладка «Трансмиссия»): заблокированный перекидывает тягу на медленное (внутреннее) колесо —
  // болид устойчивее на выходе, но ленивее поворачивает. На сбросе газа так же делит торможение мотором.
  const wy = body.angvel().y
  // торможение мотором на сбросе: растёт со скоростью (обороты выше — тормозит сильнее); с 300 км/ч сброс газа даёт около 1 g
  const engineBrake = throttle < 0.01 && fwdSpeed > 2 ? (T.engineBrake + T.engineBrakeSpeed * fwdSpeed) * clamp(fwdSpeed / 2, 0, 1) * engineBrakeOf(setup) : 0
  const rearTotal = drive - engineBrake
  const lock = (throttle > 0.01 ? setup.diffOn : setup.diffOff) / 100
  const dvRear = -2 * wy * T.rear.x // левое минус правое: в левом повороте левое медленнее
  const transfer = clamp(lock * T.diffK * dvRear, -Math.abs(rearTotal) / 2, Math.abs(rearTotal) / 2)
  const rearFx = [rearTotal / 2 - transfer, rearTotal / 2 + transfer]

  // 1. подвеска: луч из точки крепления вниз
  const maxToi = T.suspensionRest + T.wheelRadius + 0.05
  const down = S.down
  down.x = -up.x
  down.y = -up.y
  down.z = -up.z
  const origin = S.origin
  v.ray.origin = origin
  v.ray.dir = down
  for (let wi = 0; wi < 4; wi++) {
    const w = wheels[wi]
    w.hardY = hardYOf(T, w)
    // оторванное колесо: у этого угла опоры нет, болид садится на днище
    if (v.damage.lost[wi]) {
      w.contact = false
      w.hitCollider = null
      w.compression = 0
      w.centerY = w.hardY - T.suspensionRest
      w.load = 0
      continue
    }
    const o = rot(q, w.x, w.hardY, w.z, S.o)
    origin.x = pos.x + o.x
    origin.y = pos.y + o.y
    origin.z = pos.z + o.z
    const hit = world.castRayAndGetNormal(v.ray, maxToi, true, undefined, RAY_GROUPS, undefined, body)
    w.prevCompression = w.compression
    const c = hit ? T.suspensionRest + T.wheelRadius - hit.timeOfImpact : 0
    if (hit && c > 0) {
      w.contact = true
      w.hitCollider = hit.collider
      w.compression = Math.min(c, T.suspensionRest + T.wheelRadius * 0.5)
      w.point.x = origin.x + down.x * hit.timeOfImpact
      w.point.y = origin.y + down.y * hit.timeOfImpact
      w.point.z = origin.z + down.z * hit.timeOfImpact
      const n = Math.hypot(hit.normal.x, hit.normal.y, hit.normal.z) > 0.5 ? hit.normal : up
      w.normal.x = n.x
      w.normal.y = n.y
      w.normal.z = n.z
    } else {
      w.contact = false
      w.hitCollider = null
      w.compression = 0
    }
    w.centerY = w.hardY - T.suspensionRest + w.compression
    if (!w.contact) {
      w.load = 0
      continue
    }
    const cdot = clamp((w.compression - w.prevCompression) / dt, -5, 5)
    // сломанная подвеска: пружина перестаёт держать угол — он проседает до отбойника, днище чиркает по асфальту
    const sd = suspDamageAt(v.damage, w.front, w.side)
    const broken = clamp((sd - SUSP_BROKEN) / (1 - SUSP_BROKEN), 0, 1)
    const spring = (w.front ? P.springF : P.springR) * (1 - 0.9 * broken)
    const damp = (cdot > 0 ? T.damperBump : T.damperRebound) * damperOf(T.setup, w.front)
    let f = spring * w.compression + damperForce(T, cdot, damp)
    if (w.compression > T.bumpStop) f += (w.compression - T.bumpStop) * T.bumpStopK
    w.load = Math.max(0, f)
  }
  // стабилизаторы и развал: крен оси наклоняет колёса, сжатие добавляет отрицательный развал
  for (const [a, b, key] of AXLES) {
    const wa = wheels[a]
    const wb = wheels[b]
    const both = wa.contact && wb.contact
    if (both) {
      const f = (wa.compression - wb.compression) * P[key]
      wa.load = Math.max(0, wa.load + f)
      wb.load = Math.max(0, wb.load - f)
    }
    const roll = both ? (wa.compression - wb.compression) / (2 * Math.abs(wa.x)) : 0
    for (const w of [wa, wb]) {
      const stat = (w.front ? setup.camberF : setup.camberR) * DEG
      // помятая подвеска теряет отрицательный развал (до +1,7° при полном повреждении): шина стоит на кромке, держит хуже
      w.camberBody = stat + T.camberGain * (w.compression - T.staticSag) + suspDamageAt(v.damage, w.front, w.side) * 0.03
      w.camberGround = w.camberBody + w.side * roll
    }
  }

  // 2. шины
  const Fn0 = (T.mass * G) / 4
  const optimum = T.camberOptimum * DEG
  let braking = false
  let absWorking = false // ABS в этот шаг ограничил тормоз хотя бы на одном колесе
  let rollingTotal = 0
  for (let i = 0; i < wheels.length; i++) {
    const w = wheels[i]
    if (!w.contact) {
      w.omega *= 0.995
      w.slip = 0
      w.sliding = false
      w.fx = w.fy = w.cap = w.brakeP = 0
      w.spin += w.omega * dt
      continue
    }
    const n = w.normal
    // направление качения колеса в плоскости дороги
    const fw = rot(q, Math.sin(w.steer), 0, Math.cos(w.steer), S.fw)
    const k = dot(fw, n)
    fw.x -= n.x * k
    fw.y -= n.y * k
    fw.z -= n.z * k
    norm(fw)
    const lat = norm(cross(n, fw, S.lat))

    const pv = body.velocityAtPoint(w.point, S.pv)
    const vLong = dot(pv, fw)
    const vLat = dot(pv, lat)

    w.surface = surfaceAt(w.point.x, w.point.z, w.hitCollider)
    v.state.surfaces[i] = w.surface
    const surf = T.surfaces[w.surface] || T.surfaces.asphalt
    const blend = Math.min(1, dt / T.surfaceBlend)
    w.grip += (surf.grip - w.grip) * blend
    w.rolling += (surf.rolling - w.rolling) * blend
    rollingTotal += w.rolling / 4 + (v.tyres[i].puncture ? 0.012 : 0) // проколотая шина тормозит
    // давление шин (вкладка «Шины»): выше нормы — меньше сцепления, но острее отклик; ниже — наоборот
    const pd = (setup[TYRE_KEYS[i]] - (w.front ? T.tyreRef.front : T.tyreRef.rear)) / 3.5
    const mu = T.tireMu * w.grip * (v.wearOn ? tyreGrip(v.tyres[i], v.compound, v.wet) : 1) * Math.pow(Math.max(w.load, 200) / Fn0, -T.loadSensitivity) * (w.front ? 1 : T.rearGrip) * (1 - T.tyrePressureGrip * pd)
    const sdw = suspDamageAt(v.damage, w.front, w.side)
    const gripLoss = (1 - 0.3 * sdw) * (1 - 0.35 * clamp((sdw - SUSP_BROKEN) / (1 - SUSP_BROKEN), 0, 1))
    const cap = mu * gripLoss * w.load * (1 - IMPACT_GRIP * clamp(v.impactT / IMPACT_TIME, 0, 1))
    // развал: вбок шина держит лучше всего около оптимума, а для тормоза и газа лучше ровное колесо
    const off = w.camberGround - optimum
    const capY = cap * clamp(1 - T.camberLatLoss * off * off, 0.8, 1)
    const capX = cap * clamp(1 - T.camberLongLoss * w.camberGround * w.camberGround, 0.85, 1)

    // продольная сила: тяга, тормоз, торможение двигателем
    let fx = 0
    if (!w.front) fx += rearFx[i - 2]
    const share = w.front ? biasF : 1 - biasF
    // холодный или перегретый диск берёт слабее (wear.js brakeEff)
    const brakeW = ((brakeTotal * share) / 2) * (v.wearOn ? brakeEff(v.brakeTemp[i]) : 1)
    fx -= brakeW * clamp(vLong / 0.3, -1, 1)
    if (brakeTotal > 0) braking = true

    // боковая сила по кривой шины: угол увода с запаздыванием шины
    const alpha = Math.atan2(vLat, Math.max(Math.abs(vLong), T.slipSpeedFloor))
    w.slip += (alpha - w.slip) * Math.min(1, ((Math.abs(vLong) + 1) * dt) / (T.relaxLength * (1 - 0.3 * pd)))
    const B = (w.front ? T.frontB : T.rearB) * (1 + T.tyrePressureSharp * pd)
    const Ba = B * w.slip
    const curve = Math.sin(T.tireC * Math.atan(Ba - T.tireE * (Ba - Math.atan(Ba))))

    let sliding = false
    let excess = 0 // во сколько раз тяга/тормоз превысили запас шины
    if (input.handbrake && !w.front && Math.abs(vLong) > 0.3) {
      // ручник блокирует задние колёса
      sliding = true
      excess = 10
      fx = -Math.sign(vLong) * capX * T.slideMu
    } else {
      const isBrake = fx * vLong < 0
      const assisted = isBrake && input.abs
      // ABS (кнопка B) оставляет шине запас на поворот: тормоз не больше,
      // чем позволяет круг трения при текущей боковой нагрузке
      const room = assisted ? Math.max(T.absFloor, Math.sqrt(Math.max(0, 1 - curve * curve))) * capX * T.absLimit : capX
      if (Math.abs(fx) > room) {
        if (assisted) {
          fx = Math.sign(fx) * room
          absWorking = true
        } else {
          sliding = true
          excess = Math.abs(fx) / capX
          fx = Math.sign(fx) * capX * T.slideMu
        }
      }
    }

    // колесо только коснулось земли и нагрузки ещё нет: 0/0 даст NaN, и Rapier отключит кузов
    const used = capX > 1e-6 ? fx / capX : 0
    // круг трения мягче строгого: у предела тяга забирает часть боковой силы, а не всю
    let latScale = Math.max(0, 1 - T.combinedLoss * used * used)
    // пробуксовка/блокировка: боковая сила падает тем сильнее, чем сильнее перебор, — без резкого скачка
    if (sliding) latScale = Math.min(latScale, T.slideLatKeep + (1 - T.slideLatKeep) * clamp(1 - (excess - 1) / T.spinSoftness, 0, 1))
    // наклонённое колесо само тянет в сторону наклона (у отрицательного развала — внутрь)
    const thrust = w.side * T.camberThrust * w.camberGround * w.load * latScale * clamp(Math.abs(vLong) / 2, 0, 1)
    const fy = clamp(-curve * capY * latScale + thrust, -capY, capY)

    const F = S.force
    F.x = n.x * w.load + fw.x * fx + lat.x * fy
    F.y = n.y * w.load + fw.y * fx + lat.y * fy
    F.z = n.z * w.load + fw.z * fx + lat.z * fy
    body.addForceAtPoint(F, w.point, true)

    // для телеметрии
    w.fx = fx
    w.fy = fy
    w.cap = cap
    w.sliding = sliding
    // заблокированное колесо диск не греет: скользит шина
    w.brakeP = sliding && fx * vLong < 0 ? 0 : brakeW * Math.abs(vLong)
    if (sliding && fx * vLong < 0) w.omega = 0 // заблокировано
    else if (sliding) w.omega = vLong / T.wheelRadius + Math.sign(fx) * 8 // буксует
    else w.omega = vLong / T.wheelRadius
    w.spin += w.omega * dt
  }

  // 3. днище: два луча под передним и задним краем — настоящий клиренс с креном и тангажом.
  // Если днище коснулось асфальта, оно упирается и трётся (теряется скорость, летят искры)
  const F = S.force
  let plankForce = 0
  const rides = [0, 0]
  for (let e = 0; e < 2; e++) {
    const p = rot(q, 0, T.plankY + 0.3, PLANK_ENDS[e] * T.plankZ, S.p)
    origin.x = pos.x + p.x
    origin.y = pos.y + p.y
    origin.z = pos.z + p.z
    const hit = world.castRayAndGetNormal(v.ray, 0.6, true, undefined, RAY_GROUPS, undefined, body)
    const clearance = hit ? hit.timeOfImpact - 0.3 : 0.3
    rides[e] = clearance
    if (clearance < 0) {
      const f = -clearance * T.plankK
      plankForce += f
      const contact = S.p
      contact.x = origin.x + down.x * 0.3
      contact.y = origin.y + down.y * 0.3
      contact.z = origin.z + down.z * 0.3
      const cv = body.velocityAtPoint(contact, S.pv)
      const cs = Math.hypot(cv.x, cv.z) || 1
      const fr = Math.min(f * T.plankFriction, f * T.plankFriction * cs)
      F.x = up.x * f - (cv.x / cs) * fr
      F.y = up.y * f
      F.z = up.z * f - (cv.z / cs) * fr
      body.addForceAtPoint(F, contact, true)
    }
  }
  const hF = rides[0]
  const hR = rides[1]

  // 4. аэродинамика: крылья задают доли осей, днище — граунд-эффект, наклон кузова — баланс
  const aero = aeroOf(T)
  const dmg = aeroDamage(v.damage)
  aero.front *= dmg.front
  aero.rear *= dmg.rear
  aero.drag *= dmg.drag
  const hMean = (hF + hR) / 2
  let ground = clamp(1 + T.groundEffect * (T.groundRef - hMean), T.groundMin, T.groundMax) * dmg.ground
  if (hMean < 0.006) ground *= 0.92 // днище по асфальту — поток срывается
  const shareF = clamp(aero.front / (aero.front + aero.rear) + T.rakeBalance * (hR - hF), 0.3, 0.55)
  const open = v.aero
  v.aeroK = T.downforceK * (aero.front + aero.rear) * ground * (1 - (1 - T.straightDownforceFactor) * open)
  const dragK = T.dragK * aero.drag * coolDragOf(T.setup) * (1 - (1 - T.straightDragFactor) * open)
  const downTotal = v.aeroK * speed * speed
  for (let a = 0; a < 2; a++) {
    const p = rot(q, 0, 0.3, a === 0 ? T.front.z : T.rear.z, S.p)
    p.x += pos.x
    p.y += pos.y
    p.z += pos.z
    const f = downTotal * (a === 0 ? shareF : 1 - shareF)
    F.x = -up.x * f
    F.y = -up.y * f
    F.z = -up.z * f
    body.addForceAtPoint(F, p, true)
  }
  // воздух плюс сопротивление покрытия — в центре масс, без поворачивающего момента
  const roll = rollingTotal * T.mass
  F.x = -vel.x * (speed * dragK + roll)
  F.y = -vel.y * speed * dragK
  F.z = -vel.z * (speed * dragK + roll)
  body.addForce(F, true)

  const kmh = Math.abs(fwdSpeed) * 3.6
  const g = gearInfo(kmh, T)
  const st = v.state
  st.speedKmh = kmh
  st.fwdSpeed = fwdSpeed
  st.gear = fwdSpeed < -0.5 ? 'R' : g.gear
  st.rpm = g.rpm
  st.braking = braking || !!input.handbrake
  st.absActive = absWorking
  st.battery = v.battery
  st.boosting = boosting
  st.ersMode = ersMode
  st.aeroOn = v.aeroOn
  st.aeroZone = zone
  st.ersFlow = spend > 0 ? spend / T.boostPower : -harvest / T.harvestPower
  st.rideF = hF * 1000
  st.rideR = hR * 1000
  st.aeroMult = ground
  st.plankContact = plankForce

  // износ шин и мотора
  if (!v.wearOn) return
  const popped = updateTyres(v, dt)
  if (popped >= 0) v.events.push('Прокол — шина стёрта')
  if (updatePowerUnit(v, dt, throttle, Math.max(0, deploy) / T.boostPower, v.rand)) v.events.push('Отказ силовой установки')
  if (updateEngineHeat(v, dt, throttle, Math.abs(fwdSpeed))) v.events.push('Отказ силовой установки: перегрев, радиатор разбит')
  if (updateBrakes(v, dt, Math.abs(fwdSpeed))) v.events.push('Тормоза перегрелись — тормозят слабее')
  updateFuel(v, dt, throttle, powerFactor(v.pu, v.engineHeat))
}
