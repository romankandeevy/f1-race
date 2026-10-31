import * as THREE from 'three'

const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
const AXIS_Z = new THREE.Vector3(0, 0, 1)
const AXIS_Y = new THREE.Vector3(0, 1, 0)
const AXIS_X = new THREE.Vector3(1, 0, 0)
const tmpQ = new THREE.Quaternion()
const tmpQ2 = new THREE.Quaternion()
const tmpV = new THREE.Vector3()
const tmpV2 = new THREE.Vector3()
const velDir = new THREE.Vector3()
const side = new THREE.Vector3()
const look = new THREE.Vector3()
const flatV = new THREE.Vector3()

// Насколько камера отвечает на перегрузки: едва заметно — чтобы тело чувствовало поворот, а глаз не замечал
const ROLL_PER_G = 0.004 // рад наклона горизонта на 1 g (~0,23°)
const ROLL_MAX = 0.021 // не больше ~1,2°
const SWAY_PER_G = 0.05 // м увода камеры наружу на 1 g
const SWAY_MAX = 0.25
const SLIDE_LOOK = 0.2 // в заносе камера смотрит на 20% туда, куда болид летит
// Ощущение в кабине (Рома 31.10, пункт 13): голову пилота клонит перегрузкой — в повороте наружу (горизонт наклоняется),
// на торможении кивает вперёд, на разгоне откидывает назад; на поребриках — частая дрожь, на большой скорости — мелкая
// вибрация. Голова — пружина с затуханием (чуть отстаёт и мягко докачивается). Сила — «Настройки → Камера → Голова пилота»
// (feelK; 0 — как раньше). Только камеры на болиде: из кабины в полную силу, T-камера и нос — вдвое слабее (они на кузове)
const HEAD_ROLL_PER_G = 0.018 // рад на 1 g бокового (≈1°)
const HEAD_ROLL_MAX = 0.07
const HEAD_NOD_PER_G = 0.014 // рад на 1 g продольного
const HEAD_NOD_MAX = 0.06
const HEAD_SHIFT_PER_G = 0.022 // м сдвига головы наружу / вперёд на 1 g
const HEAD_W = 9 // рад/с — собственная частота пружины головы
const HEAD_ZETA = 0.55 // затухание: немного докачивается
const KERB_SHAKE = 0.007 // м дрожи на поребрике (все колёса)
const KERB_HZ = 26
const SPEED_SHAKE = 0.0016 // м вибрации на 340 км/ч

// Обзор (Рома 29.10: «зажать мышку и поворачивать камеру во все стороны», «стрелки — камера вбок и назад»).
// Мышь: у камеры сзади она облетает болид кругом и поднимается над ним, у камер на болиде — поворачивает голову.
// Стрелки (пока держишь): ← налево, → направо, ↓ назад; отпустил — камера плавно возвращается (так же в Forza Horizon и F1: «Look Left/Right/Back»).
// У камер на болиде это поворот головы. У камеры сзади — облёт вокруг болида, как у Forza: ← камера уходит на левый борт, → на правый,
// ↓ встаёт перед болидом и смотрит назад на него и на дорогу позади, болид остаётся в кадре. Рули и педали — только W A S D.
const MOUSE_K = 0.006 // рад на пиксель
const BACK_TAU = 0.35 // с: через сколько мышиный обзор возвращается после отпускания
// Стрелки двигают камеру критически затухающей пружиной: плавный разгон и плавная остановка в обе стороны, без рывка в начале
// (Рома 29.10: «можно плавнее»). W — жёсткость, рад/с: время установки около 4/W.
const ARROW_W = 7 // голова: ~0,55 с
const ORBIT_W = 5.5 // облёт вокруг болида: ~0,7 с
const PITCH_MAX = 1.45 // рад: сверху вниз на болид
const PITCH_MIN = -0.12 // рад: чуть ниже обычного, но не под землю
const HEAD_YAW_MAX = 1.75 // голова на болиде вертится на ±100°: назад из кабины, с носа и с T-камеры смотреть нельзя (Рома 29.10)
const HEAD_PITCH_MAX = 1.0
const ONBOARD_NEAR = 0.035 // м: ближняя граница камеры из кабины

// Камеры (клавиша C по кругу; ТВ-камеру и вертолёт Рома 29.10 попросил убрать). mount — камера на болиде в точке модели (x, y, z) и повороте по курсу; fov — поле зрения.
// Точки в осях модели: нос смотрит в +Z, высота над землёй как у машины. T-камера — над воздухозаборником, нос — над носовым
// конусом лицом вперёд (на рёбрах носа ~0,55 м у z=1,75, камера на 17 см выше). Камеру «назад» с заднего крыла Рома 29.10 попросил убрать.
const MODES = [
  { id: 'chase', name: 'Сзади' },
  { id: 'onboard', name: 'Из кабины', mount: 'onboard', fov: 88, lean: true, drop: 0.07 }, // drop — опустить глаза ниже cam_onboard на 7 см (Рома 29.10: «чуть опусти»): дуга Halo уходит выше
  { id: 'tcam', name: 'T-камера', mount: { pos: [0, 1.03, -0.3], pitch: -0.05, yaw: 0 }, fov: 82 },
  { id: 'nose', name: 'Нос болида', mount: { pos: [0, 0.72, 1.75], pitch: -0.1, yaw: 0 }, fov: 86 },
]

// Камеры сзади и на болиде. Все передают, что происходит с болидом:
// перегрузки (камеру слегка уводит и наклоняет), занос (камера смотрит туда, куда болид летит),
// неровности (лёгкая тряска на гравии, траве и когда днище чиркает по асфальту).
// гараж: куда смотреть на деталь — at (точка в осях болида: +Z нос, +X левый борт), angle (0 — спереди, π/2 — слева), lift, dist
export const GARAGE_FOCUS = {
  engine: { at: [0, 0.65, -0.7], angle: 2.35, lift: 0.45, dist: 3.6 },
  ers: { at: [0, 0.45, 0], angle: 1.57, lift: 0.35, dist: 3.4 },
  gearbox: { at: [0, 0.45, -2], angle: 2.75, lift: 0.3, dist: 3 },
  aero: { at: [0, 0.45, 0.4], angle: 0.75, lift: 0.5, dist: 6.4 },
  brakes: { at: [0.75, 0.33, 1.7], angle: 1.05, lift: 0.15, dist: 2.1 },
  cooling: { at: [0.5, 0.5, -0.2], angle: 1.25, lift: 0.25, dist: 2.7 },
  chassis: { at: [0, 0.45, 0.4], angle: 1.57, lift: 0.75, dist: 5.4 },
  driver: { at: [0, 0.8, 0.1], angle: 0.55, lift: 0.25, dist: 1.9 },
}

export class CameraRig {
  constructor(camera, car) {
    this.camera = camera
    this.car = car
    this.modeIdx = 0
    this.pos = new THREE.Vector3()
    this.heading = new THREE.Vector3(0, 0, 1)
    this.fresh = true
    this.g = { lat: 0, long: 0 }
    this.shake = 0
    this.hitShake = 0
    this.t = 0
    this.mouse = { x: 0, y: 0 } // накопленный обзор мышью: x вправо, y вниз (в пикселях × MOUSE_K)
    this.arrowV = { yaw: 0, orbit: 0 } // скорости пружины стрелок
    this.arrow = { yaw: 0, orbit: 0 } // стрелки: поворот головы у камер на болиде (налево +) и облёт болида у камеры сзади (вправо +), рад
    this.zoom = 1 // колесо мыши: расстояние до болида у камеры сзади
    // из настроек игрока (settings.js): чувствительность мыши, обратная вертикаль, тряска и поле зрения
    this.mouseK = 1
    this.invertY = false
    this.shakeK = 1
    this.feelK = 1 // ощущение в кабине: голова пилота и дрожь
    this.head = { roll: 0, vr: 0, nod: 0, vn: 0, x: 0, vx: 0, z: 0, vz: 0, kerb: 0 }
    this.fovK = 1
    this.fovBase = 60
    this.shakeAmt = 0
    // витрина главного меню и гаража: камера медленно кружит вокруг болида, мышью можно покрутить; shift сдвигает болид вправо от панели меню
    this.showcase = false
    this.showShift = 0.17
    this.showAngle = 0.7
    this.showLift = 0.05
    this.showHold = 0
    this.showDist = 8.4
    this.focus = null // гараж: деталь крупно (GARAGE_FOCUS), null — обычный облёт
    this.lookLocal = new THREE.Vector3(0, 0.5, 0) // куда смотрит витрина, в осях болида (плавно)
    this.distNow = 8.4
    // точки крепления на болиде — пустые узлы рядом с cam_onboard, камера берёт их мировое положение
    this.mounts = {}
    const parent = car.onboard.parent
    for (const m of MODES) {
      if (!m.mount || m.mount === 'onboard') continue
      const o = new THREE.Object3D()
      o.position.set(...m.mount.pos)
      o.rotation.set(m.mount.pitch, m.mount.yaw, 0, 'YXZ')
      parent.add(o)
      this.mounts[m.id] = o
    }
    this.mounts.onboard = car.onboard
  }

  get mode() {
    return MODES[this.modeIdx].id
  }

  get modeName() {
    return MODES[this.modeIdx].name
  }

  // следующая камера по кругу; возвращает её название
  next() {
    this.modeIdx = (this.modeIdx + 1) % MODES.length
    this.fresh = true
    return this.modeName
  }

  // выбрать камеру по id: chase | onboard | tcam | nose
  setMode(id) {
    const i = MODES.findIndex((m) => m.id === id)
    if (i >= 0) {
      this.modeIdx = i
      this.fresh = true
    }
  }

  // оставлено для старых вызовов: C переключает на следующую
  toggle() {
    return this.next()
  }

  // v — обычное поле зрения камеры; множитель из настроек применяется здесь
  setFov(v) {
    const t = v * this.fovK
    if (Math.abs(this.camera.fov - t) > 0.05) {
      this.camera.fov = t
      this.camera.updateProjectionMatrix()
    }
  }

  // витрина: включить/выключить; при выключении сбрасываем сдвиг картинки
  setShowcase(on, shift = 0.17) {
    this.showcase = on
    this.showShift = shift
    this.fresh = true
    if (!on) {
      this.camera.clearViewOffset()
      this.mouse.x = this.mouse.y = 0
      this.zoom = 1
    }
  }

  // гараж: показать деталь крупно (id из GARAGE_FOCUS) или вернуть облёт (null)
  setFocus(id) {
    const f = id ? GARAGE_FOCUS[id] ?? null : null
    if (f === this.focus) return
    this.focus = f
    this.showHold = 0
    if (f) this.zoom = 1
  }

  // тряска: шум из синусов разной частоты — плавный, без «телепортов» камеры
  noise(seed) {
    const t = this.t
    return Math.sin(t * 37.1 + seed) * 0.5 + Math.sin(t * 23.7 + seed * 2.3) * 0.35 + Math.sin(t * 61.3 + seed * 4.1) * 0.15
  }

  // мышь и стрелки → обзор. view: { dragging, dx, dy, wheel, arrows: { left, right, back } } или null (меню, пауза)
  updateView(dt, view) {
    const m = this.mouse
    if (this.showcase) {
      // витрина: мышь крутит камеру насовсем (без возврата), пока тянут и ещё 2 с после — авто-вращение стоит
      if (view?.dragging) {
        this.showAngle += view.dx * MOUSE_K * this.mouseK
        this.showLift = THREE.MathUtils.clamp(this.showLift + view.dy * MOUSE_K * this.mouseK * (this.invertY ? -1 : 1), -0.15, 1.2)
        this.showHold = 2
      } else this.showHold = Math.max(0, this.showHold - dt)
      if (view?.wheel) this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp(view.wheel * 0.001), 0.6, 1.8)
      return
    }
    if (view) {
      if (view.dragging) {
        m.x += view.dx * MOUSE_K * this.mouseK
        m.y += view.dy * MOUSE_K * this.mouseK * (this.invertY ? -1 : 1)
      } else {
        const k = Math.exp(-dt / BACK_TAU)
        m.x *= k
        m.y *= k
      }
      if (view.wheel) this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp(view.wheel * 0.001), 0.55, 2.4)
    } else {
      m.x *= Math.exp(-dt / BACK_TAU)
      m.y *= Math.exp(-dt / BACK_TAU)
    }
    const a = view?.arrows
    // у камер на болиде назад не смотрим (↓ там ничего не делает), только влево и вправо
    const mounted = !!MODES[this.modeIdx].mount
    const want = a ? (a.left ? Math.PI / 2 : a.right ? -Math.PI / 2 : a.back && !mounted ? Math.PI : 0) : 0
    this.spring('yaw', want, dt, ARROW_W)
    // облёт: налево — камера на левый борт (угол −90°), направо — на правый (+90°), назад — перед болидом (180°); чуть медленнее головы
    const wantOrbit = a ? (a.back ? Math.PI : a.left ? -Math.PI / 2 : a.right ? Math.PI / 2 : 0) : 0
    this.spring('orbit', wantOrbit, dt, ORBIT_W)
  }

  // критически затухающая пружина к цели (точное решение за шаг dt, устойчиво при любом кадре)
  spring(key, target, dt, w) {
    const x = this.arrow[key] - target
    const v = this.arrowV[key]
    const e = Math.exp(-w * dt)
    const c = v + w * x
    this.arrow[key] = target + (x + c * dt) * e
    this.arrowV[key] = (v - w * c * dt) * e
  }

  // повернуть уже выставленную камеру «головой»: влево (yaw) — вокруг вертикали мира, вверх (pitch) — вокруг правой оси камеры.
  // Влево именно вокруг вертикали, а не вокруг оси самой камеры: у камер с наклоном вниз (нос, T-камера) поворот назад иначе
  // задирал бы взгляд вверх на тот же угол (Рома 29.10: «высота по стрелкам не должна меняться»).
  turnHead(yaw, pitch) {
    if (Math.abs(yaw) < 1e-4 && Math.abs(pitch) < 1e-4) return
    tmpQ.setFromAxisAngle(AXIS_Y, yaw)
    this.camera.quaternion.premultiply(tmpQ)
    tmpQ2.setFromAxisAngle(AXIS_X, pitch)
    this.camera.quaternion.multiply(tmpQ2)
  }

  update(dt, v, view = null) {
    const car = this.car.group
    car.updateMatrixWorld(true)
    const st = v.state
    const speedKmh = st.speedKmh
    this.t += dt
    this.updateView(dt, view)
    // из кабины подголовник и борта кокпита — в паре сантиметров от глаз: с обычной ближней границей (10 см) при повороте
    // головы их срезало плоскостью (Рома 31.10: «камера не должна заезжать в текстуру»)
    const near = !this.showcase && this.mode === 'onboard' ? ONBOARD_NEAR : 0.1
    if (this.camera.near !== near) {
      this.camera.near = near
      this.camera.updateProjectionMatrix()
    }
    if (this.showcase) {
      this.updateShowcase(dt, car)
      return
    }

    // перегрузки сглажены: камера отвечает на них мягко, как голова пилота
    const k = 1 - Math.exp(-dt * 6)
    this.g.lat += (st.gLat - this.g.lat) * k
    this.g.long += (st.gLong - this.g.long) * k

    // тряска: гравий и трава, днище по асфальту, чуть-чуть от скорости
    const offTrack = st.surfaces.filter((s) => s !== 'asphalt').length / 4
    const wantShake = Math.min(1, offTrack * (speedKmh / 120)) * 0.05 + Math.min(1, st.plankContact / 6000) * 0.04 + (speedKmh / 340) * 0.004
    // удар (болид о болид, о стену): резкий толчок, быстро затухает, независимо от сглаживания остального
    this.shake += (wantShake - this.shake) * (1 - Math.exp(-dt * 10))
    this.hitShake = v.impactShake * 0.16
    this.shakeAmt = (this.shake + this.hitShake) * this.shakeK

    const def = MODES[this.modeIdx]
    // голова: мышь у камер на болиде крутит её в стороны и вверх-вниз, стрелки добавляют поворот налево, направо и назад
    const headYaw = THREE.MathUtils.clamp(-this.mouse.x + this.arrow.yaw, -HEAD_YAW_MAX, HEAD_YAW_MAX)
    const headPitch = THREE.MathUtils.clamp(-this.mouse.y, -HEAD_PITCH_MAX, HEAD_PITCH_MAX)

    if (def.mount) {
      const mount = this.mounts[def.id]
      mount.getWorldPosition(this.camera.position)
      mount.getWorldQuaternion(tmpQ)
      this.camera.quaternion.copy(tmpQ.multiply(FLIP))
      // голову пилота клонит перегрузкой: в повороте наружу, при торможении вперёд
      const lean = def.lean ? 0.012 : 0.006
      // голова — пружина: цель от перегрузок, движение с отставанием и лёгким докачиванием
      const fk = this.feelK * (def.lean ? 1 : 0.5)
      const H = this.head
      const spring = (key, vkey, target) => {
        const a = HEAD_W * HEAD_W * (target - H[key]) - 2 * HEAD_ZETA * HEAD_W * H[vkey]
        H[vkey] += a * Math.min(dt, 0.05)
        H[key] += H[vkey] * Math.min(dt, 0.05)
      }
      spring('roll', 'vr', THREE.MathUtils.clamp(st.gLat * HEAD_ROLL_PER_G, -HEAD_ROLL_MAX, HEAD_ROLL_MAX) * fk)
      spring('nod', 'vn', THREE.MathUtils.clamp(st.gLong * HEAD_NOD_PER_G, -HEAD_NOD_MAX, HEAD_NOD_MAX) * fk)
      spring('x', 'vx', -st.gLat * HEAD_SHIFT_PER_G * fk)
      spring('z', 'vz', -st.gLong * HEAD_SHIFT_PER_G * fk)
      // поребрик: сколько колёс на нём; дрожь частая, сильнее со скоростью
      const onKerb = st.surfaces.filter((s) => s === 'kerb').length / 4
      H.kerb += (onKerb * Math.min(1, speedKmh / 120) - H.kerb) * (1 - Math.exp(-dt * 20))
      const buzz = Math.sin(this.t * KERB_HZ * Math.PI * 2) * 0.6 + Math.sin(this.t * KERB_HZ * 1.37 * Math.PI * 2) * 0.4
      const vib = (H.kerb * KERB_SHAKE * buzz + Math.max(0, speedKmh - 180) / 160 * SPEED_SHAKE * this.noise(11)) * this.feelK * (def.lean ? 1 : 0.6)
      tmpV.set(-this.g.lat * lean + H.x, -(def.drop || 0) + vib, this.g.long * -lean + H.z).applyQuaternion(car.quaternion)
      this.camera.position.add(tmpV)
      const sh = this.shakeAmt
      this.camera.position.y += this.noise(1) * sh * 0.6
      this.camera.rotateZ(THREE.MathUtils.clamp(this.g.lat * ROLL_PER_G, -ROLL_MAX, ROLL_MAX) + H.roll + this.noise(7) * sh * 0.15 + vib * 1.5)
      this.camera.rotateX(H.nod)
      this.turnHead(headYaw, headPitch)
      this.setFov(def.fov)
      return
    }

    // курс: в заносе камера немного смотрит туда, куда болид реально летит
    tmpV.set(0, 0, 1).applyQuaternion(car.quaternion)
    tmpV.y = 0
    tmpV.normalize()
    const lv = v.body.linvel()
    velDir.set(lv.x, 0, lv.z)
    if (velDir.lengthSq() > 64 && v.state.fwdSpeed > 8) tmpV.lerp(velDir.normalize(), SLIDE_LOOK).normalize()
    if (this.fresh) this.heading.copy(tmpV)
    this.heading.lerp(tmpV, 1 - Math.exp(-dt * 8)).normalize()
    side.set(this.heading.z, 0, -this.heading.x) // «влево» от курса

    // Расстояние жёсткое: сглаживаем только поворот курса, иначе на скорости камера отстаёт на v/k метров.
    // Перегрузки сдвигают камеру: в повороте её уводит наружу, при разгоне чуть назад, при торможении вперёд
    const speedK = Math.min(speedKmh / 340, 1)
    const dist = (5.3 + speedK * 0.7 + this.g.long * 0.18) * this.zoom
    const wantY = car.position.y + 1.9 - Math.min(0, this.g.long) * 0.06
    const sway = THREE.MathUtils.clamp(-this.g.lat * SWAY_PER_G, -SWAY_MAX, SWAY_MAX)
    // облёт мышью: x — вокруг болида (вправо — камера уходит на правый борт), y — вверх (вниз по экрану — камера выше)
    const orbit = this.mouse.x + this.arrow.orbit
    const lift = THREE.MathUtils.clamp(this.mouse.y, PITCH_MIN, PITCH_MAX)
    const cs = Math.cos(orbit)
    const sn = Math.sin(orbit)
    const ox = -this.heading.x * dist + side.x * sway
    const oz = -this.heading.z * dist + side.z * sway
    const horiz = Math.cos(Math.max(0, lift))
    this.pos.x = car.position.x + (ox * cs + oz * sn) * horiz
    this.pos.z = car.position.z + (-ox * sn + oz * cs) * horiz
    const y = wantY + Math.sin(lift) * dist * 1.4
    this.pos.y = this.fresh ? y : this.pos.y + (y - this.pos.y) * (1 - Math.exp(-dt * 6))
    this.pos.y = Math.max(this.pos.y, 0.5)
    this.camera.position.copy(this.pos)
    this.camera.position.x += this.noise(3) * this.shakeAmt
    this.camera.position.y += this.noise(5) * this.shakeAmt

    // взгляд: с обычного места — на 5 м впереди болида, сбоку и сверху — на сам болид
    const away = Math.min(1, Math.abs(orbit) / 0.7 + Math.max(0, lift) / 0.5)
    look.copy(car.position).addScaledVector(this.heading, 5 * (1 - away))
    look.y = car.position.y + 0.7
    // Наклон взгляда вниз всегда как на обычном месте сзади (высота камеры тоже не меняется): облёт стрелками вокруг болида
    // поворачивает только вбок. Мышью тянут вверх — тогда наклон свободный.
    const fromCam = (this.camera.position.y - (car.position.y + 0.7)) / (dist + 5)
    const mouseFree = THREE.MathUtils.clamp(lift / 0.1, 0, 1)
    if (mouseFree < 1) {
      tmpV.set(look.x - this.camera.position.x, 0, look.z - this.camera.position.z)
      const hLen = tmpV.length() || 1
      tmpV.multiplyScalar(1 / hLen)
      flatV.copy(this.camera.position).addScaledVector(tmpV, 10)
      flatV.y = this.camera.position.y - 10 * fromCam
      look.lerp(flatV, 1 - mouseFree)
    }
    this.camera.lookAt(look)
    // наклон горизонта с боковой перегрузкой — едва заметный, но тело его чувствует
    tmpQ.setFromAxisAngle(AXIS_Z, THREE.MathUtils.clamp(-this.g.lat * ROLL_PER_G, -ROLL_MAX, ROLL_MAX))
    this.camera.quaternion.multiply(tmpQ)

    this.fovBase = this.fresh ? 60 : THREE.MathUtils.lerp(this.fovBase, 60 + speedK * 8 + Math.max(0, this.g.long) * 1.5, 1 - Math.exp(-dt * 3))
    this.setFov(this.fovBase)
    this.fresh = false
  }

  // Витрина: камера кружит вокруг стоящего болида и чуть покачивается по высоте; мышь облетает вручную, колесо — ближе и дальше.
  // Болид сдвигаем вправо смещением кадра: слева стоит панель меню.
  updateShowcase(dt, car) {
    const f = this.focus
    const k = 1 - Math.exp(-dt * 3)
    if (f) {
      // к детали: угол — в осях болида (0 — спереди, π/2 — с левого борта), пока не крутят мышью
      tmpV.set(0, 0, 1).applyQuaternion(car.quaternion)
      const yaw = Math.atan2(tmpV.x, tmpV.z)
      if (this.showHold <= 0) {
        let d = yaw + f.angle - this.showAngle
        d = Math.atan2(Math.sin(d), Math.cos(d))
        this.showAngle += d * k
        this.showLift += (f.lift - this.showLift) * k
      }
      this.lookLocal.lerp(tmpV2.set(...f.at), k)
      this.distNow += (f.dist - this.distNow) * k
    } else {
      if (this.showHold <= 0) this.showAngle += dt * 0.12
      this.lookLocal.lerp(tmpV2.set(0, 0.5, 0), k)
      this.distNow += (this.showDist - this.distNow) * k
    }
    const a = this.showAngle
    const lift = this.showLift
    const dist = this.distNow * this.zoom
    const horiz = Math.cos(Math.max(0, lift))
    // точка взгляда — в осях болида; камера кружит вокруг неё
    look.copy(this.lookLocal).applyQuaternion(car.quaternion).add(car.position)
    if (!f) look.y = car.position.y + this.lookLocal.y
    this.camera.position.set(look.x + Math.sin(a) * dist * horiz, look.y + 0.75 + Math.sin(lift) * dist - (f ? 0.75 : 0) + Math.sin(this.t * 0.35) * 0.06, look.z + Math.cos(a) * dist * horiz)
    this.camera.position.y = Math.max(this.camera.position.y, 0.35)
    this.camera.lookAt(look)
    this.setFov(34)
    const w = innerWidth
    const h = innerHeight
    this.camera.setViewOffset(w, h, -w * this.showShift, 0, w, h)
    this.fresh = false
  }
}
