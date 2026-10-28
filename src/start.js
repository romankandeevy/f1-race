// Старт как в F1: пять пар красных огней на стартовом портале загораются по одной в секунду,
// затем после случайной паузы 0,2–3 с все гаснут — это старт. Пока огни горят, болид держится на месте:
// фальстарта нет совсем (Рома 28.10: штраф +5 с не мешал уехать вперёд от всех). N — новый старт.
import * as THREE from 'three'

export function createStart(lamps) {
  // у ламп общий материал — даём каждой свой, чтобы зажигать по одной
  const columns = lamps.map((col) =>
    col.map((mesh) => {
      mesh.material = mesh.material.clone()
      mesh.material.emissive = new THREE.Color(0xff0000)
      mesh.material.color.set(0x000000)
      // без тональной коррекции: она уводит яркий красный в оранжевый
      mesh.material.toneMapped = false
      return mesh
    }),
  )
  const setLit = (n) =>
    columns.forEach((col, i) => col.forEach((m) => (m.material.emissiveIntensity = i < n ? 1 : 0.06)))
  setLit(0)

  const st = { phase: 'idle', lit: 0, t: 0, outAt: 0 }

  return {
    state: st,

    // поставить болид на решётку (это делает main) и запустить огни
    begin() {
      st.phase = 'lights'
      st.t = 0
      st.lit = 0
      st.outAt = 5 + 0.2 + Math.random() * 2.8
      setLit(0)
    },

    update(dt) {
      if (st.phase !== 'lights') return
      st.t += dt
      if (st.t >= st.outAt) {
        st.phase = 'go'
        st.lit = 0
      } else st.lit = Math.min(5, Math.floor(st.t))
      setLit(st.lit)
    },

    // пока горят огни, педали не работают: болид стоит на решётке
    hold(input) {
      if (st.phase !== 'lights') return input
      input.throttle = 0
      input.brake = 0
      input.boost = false
      return input
    },

    get waiting() {
      return st.phase === 'lights'
    },
  }
}
