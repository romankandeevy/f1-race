import * as THREE from 'three'

const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
const AXIS_Z = new THREE.Vector3(0, 0, 1)
const tmpQ = new THREE.Quaternion()
const tmpV = new THREE.Vector3()
const velDir = new THREE.Vector3()
const side = new THREE.Vector3()

// Насколько камера отвечает на перегрузки: едва заметно — чтобы тело чувствовало поворот, а глаз не замечал
const ROLL_PER_G = 0.004 // рад наклона горизонта на 1 g (~0,23°)
const ROLL_MAX = 0.021 // не больше ~1,2°
const SWAY_PER_G = 0.05 // м увода камеры наружу на 1 g
const SWAY_MAX = 0.25
const SLIDE_LOOK = 0.2 // в заносе камера смотрит на 20% туда, куда болид летит

// Две камеры: сзади и из кабины. Обе передают, что происходит с болидом:
// перегрузки (камеру слегка уводит и наклоняет), занос (камера смотрит туда, куда болид летит),
// неровности (лёгкая тряска на гравии, траве и когда днище чиркает по асфальту).
export class CameraRig {
  constructor(camera, car) {
    this.camera = camera
    this.car = car
    this.mode = 'chase'
    this.pos = new THREE.Vector3()
    this.heading = new THREE.Vector3(0, 0, 1)
    this.fresh = true
    this.g = { lat: 0, long: 0 }
    this.shake = 0
    this.t = 0
  }

  toggle() {
    this.mode = this.mode === 'chase' ? 'onboard' : 'chase'
    this.fresh = true
  }

  setFov(v) {
    if (Math.abs(this.camera.fov - v) > 0.05) {
      this.camera.fov = v
      this.camera.updateProjectionMatrix()
    }
  }

  // тряска: шум из синусов разной частоты — плавный, без «телепортов» камеры
  noise(seed) {
    const t = this.t
    return Math.sin(t * 37.1 + seed) * 0.5 + Math.sin(t * 23.7 + seed * 2.3) * 0.35 + Math.sin(t * 61.3 + seed * 4.1) * 0.15
  }

  update(dt, v) {
    const car = this.car.group
    car.updateMatrixWorld(true)
    const st = v.state
    const speedKmh = st.speedKmh
    this.t += dt

    // перегрузки сглажены: камера отвечает на них мягко, как голова пилота
    const k = 1 - Math.exp(-dt * 6)
    this.g.lat += (st.gLat - this.g.lat) * k
    this.g.long += (st.gLong - this.g.long) * k

    // тряска: гравий и трава, днище по асфальту, чуть-чуть от скорости
    const offTrack = st.surfaces.filter((s) => s !== 'asphalt').length / 4
    const wantShake = Math.min(1, offTrack * (speedKmh / 120)) * 0.05 + Math.min(1, st.plankContact / 6000) * 0.04 + (speedKmh / 340) * 0.004
    this.shake += (wantShake - this.shake) * (1 - Math.exp(-dt * 10))

    if (this.mode === 'onboard') {
      this.car.onboard.getWorldPosition(this.camera.position)
      this.car.onboard.getWorldQuaternion(tmpQ)
      this.camera.quaternion.copy(tmpQ.multiply(FLIP))
      // голову пилота клонит перегрузкой: в повороте наружу, при торможении вперёд
      tmpV.set(-this.g.lat * 0.012, 0, this.g.long * -0.012).applyQuaternion(car.quaternion)
      this.camera.position.add(tmpV)
      this.camera.position.y += this.noise(1) * this.shake * 0.6
      this.camera.rotateZ(THREE.MathUtils.clamp(this.g.lat * ROLL_PER_G, -ROLL_MAX, ROLL_MAX) + this.noise(7) * this.shake * 0.15)
      this.setFov(88)
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
    const dist = 5.3 + speedK * 0.7 + this.g.long * 0.18
    const wantY = car.position.y + 1.9 - Math.min(0, this.g.long) * 0.06
    const sway = THREE.MathUtils.clamp(-this.g.lat * SWAY_PER_G, -SWAY_MAX, SWAY_MAX)
    this.pos.x = car.position.x - this.heading.x * dist + side.x * sway
    this.pos.z = car.position.z - this.heading.z * dist + side.z * sway
    this.pos.y = this.fresh ? wantY : this.pos.y + (wantY - this.pos.y) * (1 - Math.exp(-dt * 6))
    this.pos.y = Math.max(this.pos.y, 0.6)
    this.camera.position.copy(this.pos)
    this.camera.position.x += this.noise(3) * this.shake
    this.camera.position.y += this.noise(5) * this.shake

    tmpV.copy(car.position).addScaledVector(this.heading, 5)
    tmpV.y = car.position.y + 0.7
    this.camera.lookAt(tmpV)
    // наклон горизонта с боковой перегрузкой — едва заметный, но тело его чувствует
    tmpQ.setFromAxisAngle(AXIS_Z, THREE.MathUtils.clamp(-this.g.lat * ROLL_PER_G, -ROLL_MAX, ROLL_MAX))
    this.camera.quaternion.multiply(tmpQ)

    this.setFov(THREE.MathUtils.lerp(this.camera.fov, 60 + speedK * 8 + Math.max(0, this.g.long) * 1.5, 1 - Math.exp(-dt * 3)))
    this.fresh = false
  }
}
