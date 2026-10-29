// Эвакуатор с краном (Рома 29.10: «эвакуатор, как в Формуле-1»; потом «он не поднимает болид краном, он просто пропадает»).
// Грузовик из коробок едет по оси трассы, встаёт бортом к остановившемуся болиду, стрела разворачивается над ним, крюк опускается, болид
// поднимается, стрела уносит его к платформе, опускает и грузовик увозит болид. Болид — настоящий объект игры (car.group): пока кран
// работает, его положение и поворот задаёт этот модуль.
import * as THREE from 'three'

const SPEED = 26 // м/с (~94 км/ч)
const START_BEFORE = 380 // м до инцидента, откуда выезжает
const LEAVE_TIME = 14 // с: уезжает дальше и исчезает
const SIDE = 4 // м: на сколько сбоку от болида встаёт грузовик (длина стрелы при подъёме)
const PIVOT_Z = 0.8 // место крана на платформе (вперёд от центра грузовика)
const BED_TOP = 1.25 // высота платформы над землёй
const MAST = 4.2 // высота шарнира стрелы
const LIFT = 2.2 // на сколько поднимают болид
const SET_Z = -2.6 // где на платформе стоит болид (назад от центра)
const HOOK_Y = 1.15 // за что цепляет: высота над землёй крюка на болиде
const STOW_REACH = PIVOT_Z - SET_Z // вылет стрелы над платформой

// длительности фаз, с
const T_SWING = 1.8 // стрела поворачивается к болиду
const T_LOWER = 1.4 // крюк вниз
const T_LIFT = 2 // болид вверх
const T_CARRY = 2.6 // стрела несёт болид к платформе
const T_SET = 1.6 // опускает на платформу
const T_STRAP = 0.8 // закрепили

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))
const lerp = (a, b, t) => a + (b - a) * t
const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))

function buildTruck() {
  const g = new THREE.Group()
  const mat = (c, e = 0) => new THREE.MeshLambertMaterial({ color: c, emissive: e })
  const box = (w, h, d, c, x, y, z, e = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c, e))
    m.position.set(x, y, z)
    g.add(m)
    return m
  }
  // рама и платформа (длиннее болида), кабина впереди
  box(2.5, 0.5, 8.4, 0xe8e8e4, 0, 0.85, -1.4)
  box(2.45, 0.12, 7.4, 0x2a2d33, 0, BED_TOP - 0.06, -1.9)
  box(2.4, 1.5, 2.2, 0xf2a900, 0, 1.55, 3.2)
  box(2.0, 0.6, 0.1, 0x1a2a3a, 0, 1.95, 4.32)
  const lightL = box(0.5, 0.25, 0.4, 0xff8800, -0.7, 2.45, 3.2, 0xff6600)
  const lightR = box(0.5, 0.25, 0.4, 0xff8800, 0.7, 2.45, 3.2, 0xff6600)
  // колёса: по две оси сзади, одна спереди
  for (const x of [-1.15, 1.15]) {
    for (const z of [-4.3, -2.9, 3.3]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.4, 14), mat(0x111214))
      w.rotation.z = Math.PI / 2
      w.position.set(x, 0.5, z)
      g.add(w)
    }
  }
  // кран: мачта на платформе, на ней поворотная стрела с противовесом и тросом
  box(0.45, MAST - BED_TOP, 0.45, 0x464b53, 0, (MAST + BED_TOP) / 2, PIVOT_Z)
  const swing = new THREE.Group() // вращается вокруг вертикали
  swing.position.set(0, MAST, PIVOT_Z)
  const arm = new THREE.Mesh(new THREE.BoxGeometry(1, 0.3, 0.3), mat(0xf2a900)) // длина — scale.x, выдвигается
  const weight = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.5), mat(0x2a2d33))
  weight.position.set(-0.9, 0, 0)
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 6), mat(0x111214))
  const hook = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), mat(0xcc2200))
  swing.add(arm, weight, cable, hook)
  g.add(swing)
  g.userData = { lights: [lightL, lightR], swing, arm, cable, hook }
  return g
}

// вылет r (м) и длина троса h (м): положение стрелы, троса и крюка
function setBoom(mesh, angle, reach, cableLen) {
  const { swing, arm, cable, hook } = mesh.userData
  swing.rotation.y = angle
  arm.scale.x = Math.max(0.5, reach)
  arm.position.x = reach / 2
  cable.scale.y = Math.max(0.05, cableLen)
  cable.position.set(reach, -cableLen / 2, 0)
  hook.position.set(reach, -cableLen, 0)
}

export function createTow(scene, axis, length) {
  const ds = axis.length > 1 ? axis[1].distance_m - axis[0].distance_m : 2
  const jobs = []
  // точка оси с интерполяцией между отсчётами (шаг оси 2 м — иначе грузовик «прыгал» бы на метр от болида)
  const at = (s) => {
    const f = Math.min(axis.length - 1.001, Math.max(0, (((s % length) + length) % length) / ds))
    const i = Math.floor(f)
    const u = f - i
    const p = axis[i]
    const q = axis[i + 1]
    return { x: lerp(p.x, q.x, u), y: lerp(p.y || 0, q.y || 0, u), z: lerp(p.z, q.z, u), yaw: p.yaw + angleDiff(p.yaw, q.yaw) * u }
  }

  const e = new THREE.Euler()
  const v = new THREE.Vector3()

  // положение болида на платформе (мировое), позу задаёт грузовик
  function bedPose(job, out) {
    out.position.set(0, BED_TOP + job.restH, SET_Z)
    job.mesh.localToWorld(out.position)
    out.quaternion.setFromEuler(e.set(0, job.mesh.rotation.y, 0))
  }

  return {
    // inc: { id, s, l } — где стоит болид; opts: { object() — болид (Object3D), lift() — крюк взял (тело отключить), done() — увезли }
    dispatch(inc, opts = {}) {
      const mesh = buildTruck()
      scene.add(mesh)
      // к стоящему болиду едем с той стороны, где от него до края трассы ближе… проще: ставим грузовик между болидом и краем (знак как у `l`)
      const side = inc.l >= 0 ? SIDE : -SIDE
      const job = {
        inc,
        mesh,
        opts,
        side,
        s: inc.s - START_BEFORE,
        phase: 'go',
        t: 0,
        speed: SPEED,
        obj: null,
        restPos: new THREE.Vector3(),
        restQuat: new THREE.Quaternion(),
        restH: 0.3,
      }
      setBoom(mesh, Math.PI / 2, STOW_REACH, 1.2)
      jobs.push(job)
      return job
    },

    // вызывать после того, как кадр нарисовал болиды (иначе sync болида затрёт позу)
    update(dt) {
      for (let k = jobs.length - 1; k >= 0; k--) {
        const j = jobs[k]
        j.t += dt
        const stopS = j.inc.s - PIVOT_Z // шарнир крана ровно против болида
        let off
        if (j.phase === 'go') {
          // едет по линии болида, на последних 120 м уходит в сторону; тормозит плавно
          const dist = stopS - j.s
          j.speed = Math.min(SPEED, Math.max(2.5, Math.sqrt(2 * 3.5 * Math.max(0, dist))))
          j.s += j.speed * dt
          if (dist <= 0.15) {
            j.s = stopS
            j.phase = 'swing'
            j.t = 0
            j.obj = j.opts.object?.() || null
            if (j.obj) {
              j.restPos.copy(j.obj.position)
              j.restQuat.copy(j.obj.quaternion)
              const a = at(j.inc.s)
              j.restH = Math.max(0.05, j.restPos.y - (a.y || 0))
            }
          }
          const w = smooth((j.s - (j.inc.s - 120)) / 100)
          off = j.inc.l * 0.5 * (1 - w) + (j.inc.l + j.side) * w
        } else {
          off = j.inc.l + j.side
        }
        if (j.phase === 'swing' || j.phase === 'lower' || j.phase === 'lift' || j.phase === 'carry' || j.phase === 'set' || j.phase === 'strap') this.crane(j)
        if (j.phase === 'leave') {
          j.speed = Math.min(SPEED, j.speed + 4 * dt)
          j.s += j.speed * dt
          if (j.t > LEAVE_TIME) {
            scene.remove(j.mesh)
            j.opts.done?.()
            jobs.splice(k, 1)
            continue
          }
        }
        const a = at(j.s)
        j.mesh.position.set(a.x + Math.cos(a.yaw) * off, a.y || 0, a.z - Math.sin(a.yaw) * off)
        j.mesh.rotation.y = a.yaw
        j.mesh.updateMatrixWorld(true)
        if (j.obj && (j.phase === 'carry' || j.phase === 'set' || j.phase === 'strap' || j.phase === 'leave')) this.carry(j)
        const blink = Math.floor(j.t * 4 + (j.s % 3)) % 2 === 0
        j.mesh.userData.lights[0].visible = blink
        j.mesh.userData.lights[1].visible = !blink
      }
    },

    // фазы крана: поворот к болиду → крюк вниз → подъём → перенос → на платформу → закрепили
    crane(j) {
      // к болиду стрела смотрит поперёк грузовика: слева (+x) или справа (−x); над платформой — назад (−z)
      const toCar = j.side > 0 ? Math.PI : 0 // болид справа от грузовика, если грузовик слева от него
      const stow = Math.PI / 2
      const lowLen = MAST - HOOK_Y
      const liftLen = MAST - HOOK_Y - LIFT
      if (j.phase === 'swing') {
        const u = smooth(j.t / T_SWING)
        setBoom(j.mesh, stow + angleDiff(stow, toCar) * u, lerp(STOW_REACH, SIDE, u), 1.2)
        if (j.t >= T_SWING) {
          j.phase = 'lower'
          j.t = 0
        }
      } else if (j.phase === 'lower') {
        setBoom(j.mesh, toCar, SIDE, lerp(1.2, lowLen, smooth(j.t / T_LOWER)))
        if (j.t >= T_LOWER) {
          j.phase = 'lift'
          j.t = 0
          j.opts.lift?.()
        }
      } else if (j.phase === 'lift') {
        const u = smooth(j.t / T_LIFT)
        setBoom(j.mesh, toCar, SIDE, lerp(lowLen, liftLen, u))
        if (j.obj) {
          j.obj.position.copy(j.restPos)
          j.obj.position.y += LIFT * u
          j.obj.quaternion.copy(j.restQuat)
        }
        if (j.t >= T_LIFT) {
          j.phase = 'carry'
          j.t = 0
          j.liftPos = j.restPos.clone().setY(j.restPos.y + LIFT)
        }
      } else if (j.phase === 'carry') {
        const u = smooth(j.t / T_CARRY)
        setBoom(j.mesh, toCar + angleDiff(toCar, stow) * u, lerp(SIDE, STOW_REACH, u), liftLen)
        if (j.t >= T_CARRY) {
          j.phase = 'set'
          j.t = 0
        }
      } else if (j.phase === 'set') {
        const u = smooth(j.t / T_SET)
        setBoom(j.mesh, stow, STOW_REACH, lerp(liftLen, liftLen + LIFT, u))
        if (j.t >= T_SET) {
          j.phase = 'strap'
          j.t = 0
        }
      } else if (j.phase === 'strap') {
        setBoom(j.mesh, stow, STOW_REACH, 1.2 + (liftLen + LIFT - 1.2) * (1 - smooth(j.t / T_STRAP)))
        if (j.t >= T_STRAP) {
          j.phase = 'leave'
          j.t = 0
          j.opts.loaded?.()
        }
      }
    },

    // болид, пока его несут: висит на крюке (крюк идёт по дуге стрелы), потом лежит на платформе и едет вместе с грузовиком
    carry(j) {
      const o = j.obj
      const bed = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
      bedPose(j, bed)
      if (j.phase === 'strap' || j.phase === 'leave') {
        o.position.copy(bed.position)
        o.quaternion.copy(bed.quaternion)
        return
      }
      const hookW = j.hookW || (j.hookW = new THREE.Vector3())
      j.mesh.userData.hook.getWorldPosition(hookW)
      if (!j.hang0) {
        // как болид висит под крюком в начале переноса и как должен висеть над платформой в конце
        j.hang0 = j.liftPos.clone().sub(hookW)
        const target = bed.position.clone().setY(bed.position.y + LIFT)
        const hookEnd = j.mesh.localToWorld(new THREE.Vector3(0, MAST - (MAST - HOOK_Y - LIFT), SET_Z))
        j.hangEnd = target.sub(hookEnd)
      }
      if (j.phase === 'carry') {
        const u = smooth(j.t / T_CARRY)
        o.position.copy(hookW).add(v.lerpVectors(j.hang0, j.hangEnd, u))
        o.quaternion.slerpQuaternions(j.restQuat, bed.quaternion, u)
      } else {
        o.position.copy(hookW).add(j.hangEnd)
        o.quaternion.copy(bed.quaternion)
      }
    },

    clear() {
      for (const j of jobs) scene.remove(j.mesh)
      jobs.length = 0
    },
    get busy() {
      return jobs.length > 0
    },
  }
}
