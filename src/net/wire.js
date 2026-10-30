// Двоичный снапшот машин (сервер → клиент), little-endian. Общий для server/game-server.mjs и net/online.js.
// Заголовок 7 байт: u8 вид (1), u32 тик, i8 огни старта (−1 — не горят), u8 число болидов.
// Болид 30 байт: u8 номер в составе, f32 x y z, i16 поворот ×32767 (x y z w), i16 скорость ×100 м/с (x y z),
// i16 руль ×10000 рад, u8 флаги (тормоз, DRS, переднее и заднее крыло отвалились, 4 бита — нет колеса).
// Хвост: u8 фаза машины безопасности (0 — нет); если есть — f32 s, l, v, t и u8 «armed» (0, 1, 2 — проехала въезд).
// JSON того же снапшота был ~1 КБ, двоичный — ~370 байт: трафик на игрока втрое меньше.
const CAR = 30
const HEAD = 7
const SC_PHASES = ['off', 'out', 'lead', 'in', 'leave']
const i16 = (x) => Math.max(-32767, Math.min(32767, Math.round(x)))

// cars: [{ i, p: {x,y,z}, q: {x,y,z,w}, v: {x,y,z}, steer, f }]; sc — { phase, s, l, v, t, armed } или null
export function packSnapshot(tick, lights, cars, sc) {
  const size = HEAD + cars.length * CAR + 1 + (sc ? 17 : 0)
  const buf = new ArrayBuffer(size)
  const d = new DataView(buf)
  let o = 0
  d.setUint8(o++, 1)
  d.setUint32(o, tick, true)
  o += 4
  d.setInt8(o++, lights)
  d.setUint8(o++, cars.length)
  for (const c of cars) {
    d.setUint8(o++, c.i)
    d.setFloat32(o, c.p.x, true)
    d.setFloat32(o + 4, c.p.y, true)
    d.setFloat32(o + 8, c.p.z, true)
    o += 12
    for (const k of ['x', 'y', 'z', 'w']) {
      d.setInt16(o, i16(c.q[k] * 32767), true)
      o += 2
    }
    for (const k of ['x', 'y', 'z']) {
      d.setInt16(o, i16(c.v[k] * 100), true)
      o += 2
    }
    d.setInt16(o, i16(c.steer * 10000), true)
    o += 2
    d.setUint8(o++, c.f)
  }
  const ph = sc ? Math.max(0, SC_PHASES.indexOf(sc.phase)) : 0
  d.setUint8(o++, ph)
  if (sc) {
    d.setFloat32(o, sc.s, true)
    d.setFloat32(o + 4, sc.l, true)
    d.setFloat32(o + 8, sc.v, true)
    d.setFloat32(o + 12, sc.t, true)
    d.setUint8(o + 16, sc.armed === 'passed' ? 2 : sc.armed ? 1 : 0)
  }
  return new Uint8Array(buf)
}

// → { tick, lights, cars: [{ i, p: [x,y,z], q: [x,y,z,w], v: [x,y,z], steer, f }], sc }
export function unpackSnapshot(ab) {
  const d = new DataView(ab instanceof ArrayBuffer ? ab : ab.buffer, ab.byteOffset ?? 0, ab.byteLength)
  let o = 0
  if (d.getUint8(o++) !== 1) return null
  const tick = d.getUint32(o, true)
  o += 4
  const lights = d.getInt8(o++)
  const n = d.getUint8(o++)
  const cars = []
  for (let k = 0; k < n; k++) {
    const i = d.getUint8(o++)
    const p = [d.getFloat32(o, true), d.getFloat32(o + 4, true), d.getFloat32(o + 8, true)]
    o += 12
    const q = [0, 0, 0, 0].map((_, j) => d.getInt16(o + j * 2, true) / 32767)
    o += 8
    const v = [0, 0, 0].map((_, j) => d.getInt16(o + j * 2, true) / 100)
    o += 6
    const steer = d.getInt16(o, true) / 10000
    o += 2
    const f = d.getUint8(o++)
    cars.push({ i, p, q, v, steer, f })
  }
  const ph = d.getUint8(o++)
  let sc = null
  if (ph) {
    const a = d.getUint8(o + 16)
    sc = { phase: SC_PHASES[ph], s: d.getFloat32(o, true), l: d.getFloat32(o + 4, true), v: d.getFloat32(o + 8, true), t: d.getFloat32(o + 12, true), armed: a === 2 ? 'passed' : a === 1 }
  }
  return { tick, lights, cars, sc }
}
