import * as THREE from 'three'

const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
const AXIS_Z = new THREE.Vector3(0, 0, 1)
const AXIS_Y = new THREE.Vector3(0, 1, 0)
const AXIS_X = new THREE.Vector3(1, 0, 0)
const tmpQ = new THREE.Quaternion()
const tmpQ2 = new THREE.Quaternion()
const tmpV = new THREE.Vector3()
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
      tmpV.set(-this.g.lat * lean, -(def.drop || 0), this.g.long * -lean).applyQuaternion(car.quaternion)
      this.camera.position.add(tmpV)
      const sh = this.shakeAmt
      this.camera.position.y += this.noise(1) * sh * 0.6
      this.camera.rotateZ(THREE.MathUtils.clamp(this.g.lat * ROLL_PER_G, -ROLL_MAX, ROLL_MAX) + this.noise(7) * sh * 0.15)
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
    if (this.showHold <= 0) this.showAngle += dt * 0.12
    const a = this.showAngle
    const lift = this.showLift
    const dist = this.showDist * this.zoom
    const horiz = Math.cos(Math.max(0, lift))
    this.camera.position.set(car.position.x + Math.sin(a) * dist * horiz, car.position.y + 1.25 + Math.sin(lift) * dist + Math.sin(this.t * 0.35) * 0.06, car.position.z + Math.cos(a) * dist * horiz)
    this.camera.position.y = Math.max(this.camera.position.y, 0.35)
    look.set(car.position.x, car.position.y + 0.5, car.position.z)
    this.camera.lookAt(look)
    this.setFov(34)
    const w = innerWidth
    const h = innerHeight
    this.camera.setViewOffset(w, h, -w * this.showShift, 0, w, h)
    this.fresh = false
  }
}
