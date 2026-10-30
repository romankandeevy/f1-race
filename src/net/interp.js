// Интерполяция чужих машин по снапшотам (этап 1 онлайна, _materials/f1-online-ru.md).
// Чистые функции: одинаковы в браузере и в проверочном скрипте на Node (server/netsim.mjs).
// Снапшот: { t (мс серверного времени), p [x,y,z], q [x,y,z,w], v [x,y,z] (скорость, м/с) }.

// дальше последнего снапшота экстраполируем по скорости, но не дольше этого (мс)
export const MAX_EXTRAP = 150

// кубический Эрмит по позиции и скорости на концах отрезка, поворот — slerp
// rt — момент отображения в серверном времени (мс). Возвращает { p, q, extrap } или null, если снапшотов нет.
export function sampleCar(buf, rt) {
  const n = buf.length
  if (!n) return null
  const first = buf[0]
  const last = buf[n - 1]
  if (rt <= first.t) return { p: first.p.slice(), q: first.q.slice(), extrap: false }
  if (rt >= last.t) {
    const dt = Math.min(rt - last.t, MAX_EXTRAP) / 1000
    return { p: [0, 1, 2].map((i) => last.p[i] + last.v[i] * dt), q: last.q.slice(), extrap: rt - last.t > 0 }
  }
  // двоичный поиск: buf[lo].t <= rt < buf[lo+1].t
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (buf[mid].t <= rt) lo = mid
    else hi = mid
  }
  const a = buf[lo]
  const b = buf[lo + 1]
  const span = b.t - a.t
  const h = span / 1000
  const u = (rt - a.t) / span
  const u2 = u * u
  const u3 = u2 * u
  const h00 = 2 * u3 - 3 * u2 + 1
  const h10 = u3 - 2 * u2 + u
  const h01 = -2 * u3 + 3 * u2
  const h11 = u3 - u2
  const p = [0, 1, 2].map((i) => h00 * a.p[i] + h10 * h * a.v[i] + h01 * b.p[i] + h11 * h * b.v[i])
  return { p, q: slerp(a.q, b.q, u), extrap: false }
}

export function slerp(a, b, u) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const s = dot < 0 ? -1 : 1
  dot = Math.abs(dot)
  if (dot > 0.9995) {
    const r = [0, 1, 2, 3].map((i) => a[i] + (s * b[i] - a[i]) * u)
    const len = Math.hypot(...r) || 1
    return r.map((x) => x / len)
  }
  const th = Math.acos(dot)
  const wa = Math.sin((1 - u) * th) / Math.sin(th)
  const wb = (s * Math.sin(u * th)) / Math.sin(th)
  return [0, 1, 2, 3].map((i) => wa * a[i] + wb * b[i])
}

// оставить снапшоты не старше keepMs от времени rt (буфер не растёт без границ)
export function prune(buf, rt, keepMs = 1000) {
  while (buf.length > 2 && buf[1].t < rt - keepMs) buf.shift()
}
