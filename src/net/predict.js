// Предсказание своей машины (этап 2 онлайна): клиент ведёт свой болид той же физикой (stepVehicle), что сервер.
// Ввод — кусками по 1/60 с (4 шага физики). Неподтверждённые куски храним; когда сервер присылает своё состояние
// с номером последнего применённого ввода, откатываем к нему и переигрываем хвост.
import { createVehicle, stepVehicle, STATIC_GROUPS } from '../vehicle.js'
import { TUNING } from '../tuning.js'
import { importVehicle } from './state.js'

export const DT = 1 / 240
export const INPUT_STEPS = 4

export function createPredictor(RAPIER, spawn) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = DT
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setCollisionGroups(STATIC_GROUPS), ground)
  const v = createVehicle(RAPIER, world, { x: spawn.x, y: spawn.y, z: spawn.z, yaw: 0 }, TUNING)
  const surface = () => 'asphalt'
  const pending = [] // { seq, input }: отправлено, сервер ещё не подтвердил

  const run = (input) => {
    for (let i = 0; i < INPUT_STEPS; i++) {
      stepVehicle(v, input, DT, surface)
      world.step()
    }
  }

  function setState(s) {
    v.body.setTranslation({ x: s.p[0], y: s.p[1], z: s.p[2] }, true)
    v.body.setRotation({ x: s.q[0], y: s.q[1], z: s.q[2], w: s.q[3] }, true)
    v.body.setLinvel({ x: s.v[0], y: s.v[1], z: s.v[2] }, true)
    v.body.setAngvel({ x: s.w[0], y: s.w[1], z: s.w[2] }, true)
    importVehicle(v, s.st)
  }

  return {
    // новый ввод: запоминаем (для переигрывания) и применяем сразу
    step(seq, input) {
      pending.push({ seq, input })
      run(input)
    },
    // сервер: состояние после ввода seq. Откатываем, переигрываем неподтверждённый хвост
    reconcile(seq, s) {
      setState(s)
      while (pending.length && pending[0].seq <= seq) pending.shift()
      for (const p of pending) run(p.input)
    },
    pos() {
      const t = v.body.translation()
      return [t.x, t.y, t.z]
    },
    quat() {
      const r = v.body.rotation()
      return [r.x, r.y, r.z, r.w]
    },
    pending: () => pending.length,
  }
}
