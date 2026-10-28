// Границы трассы, как в F1: трасса — асфальт между белыми линиями, сама линия — часть трассы.
// Нарушение — все четыре колеса целиком за линией. Ширина до линии — width_left / width_right у точки оси.
// Без Three.js — проверяется в Node.
const TYRE_HALF = 0.2 // половина ширины шины, м: колесо «за линией», только когда ушло за неё целиком
const HOLD = 0.15 // с: короткий заезд колёсами за линию на кочке не считается

// все ли четыре колеса за белой линией. body — тело Rapier (translation, rotation), idx — ближайшая точка оси
export function wheelsOut(axis, idx, body, T) {
  const p = body.translation()
  const q = body.rotation()
  const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
  const fx = Math.sin(yaw)
  const fz = Math.cos(yaw)
  const lx = Math.cos(yaw)
  const lz = -Math.sin(yaw)
  const a = axis[idx]
  const b = axis[(idx + 1) % axis.length]
  const tx = b.x - a.x
  const tz = b.z - a.z
  const len = Math.hypot(tx, tz) || 1
  for (const [sx, sz] of [[T.front.x, T.front.z], [-T.front.x, T.front.z], [T.rear.x, T.rear.z], [-T.rear.x, T.rear.z]]) {
    const wx = p.x + fx * sz + lx * sx
    const wz = p.z + fz * sz + lz * sx
    const lat = ((wx - a.x) * tz - (wz - a.z) * tx) / len // + — влево от оси
    const edge = lat > 0 ? a.width_left : a.width_right
    if (Math.abs(lat) - TYRE_HALF <= edge) return false // это колесо ещё на трассе
  }
  return true
}

// счётчик нарушений: update возвращает true в момент нового нарушения (один раз за выезд)
export function createLimits() {
  const st = { strikes: 0, out: 0, counted: false }
  return {
    state: st,
    reset() {
      st.strikes = 0
      st.out = 0
      st.counted = false
    },
    update(dt, out) {
      st.out = out ? st.out + dt : 0
      if (!out) st.counted = false
      if (out && !st.counted && st.out >= HOLD) {
        st.counted = true
        st.strikes++
        return true
      }
      return false
    },
  }
}
