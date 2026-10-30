// Внутреннее состояние болида, которого не видно по кузову (этап 2): сервер шлёт его в снапшоте,
// клиент подставляет при откате. Без него предсказание расходится: шины помнят скольжение, педали сглажены,
// подвеска помнит сжатие. Используется и сервером (экспорт), и клиентом (импорт).
const r = (x) => Math.round(x * 1e5) / 1e5 // пять знаков хватает, размер снапшота меньше

// износ и поломки (wear.js) тоже живут между шагами: шины греются, тормоза и мотор нагреваются, части бьются.
// Их шлём целиком — иначе при откате клиент переиграет окна поверх своих уже учтённых нагревов.
const wearOf = (v) => ({
  tyres: v.tyres ? v.tyres.map((t) => [r(t.wear), r(t.temp), !!t.puncture]) : null,
  brakeTemp: v.brakeTemp ? v.brakeTemp.map(r) : null,
  brakeHot: !!v.brakeHot,
  engineHeat: r(v.engineHeat ?? 0),
  hotTime: r(v.hotTime ?? 0),
  pu: v.pu ? { ice: r(v.pu.ice), ers: r(v.pu.ers), gearbox: r(v.pu.gearbox), failed: !!v.pu.failed } : null,
  damage: v.damage ? JSON.parse(JSON.stringify(v.damage)) : null,
  fuel: r(v.fuel ?? 0),
})

export function exportVehicle(v) {
  return {
    wear: wearOf(v),
    steer: [r(v.steerIn), r(v.steerCmd), r(v.steerVel)],
    pedals: [r(v.throttle), r(v.brake)],
    battery: r(v.battery),
    aeroOn: !!v.aeroOn,
    impactT: r(v.impactT ?? 0),
    prevVel: [r(v.prevVel?.x ?? 0), r(v.prevVel?.y ?? 0), r(v.prevVel?.z ?? 0)], // до первого шага prevVel ещё не создан
    wheels: v.wheels.map((w) => [r(w.compression), r(w.prevCompression), !!w.contact, r(w.slip), r(w.omega), r(w.spin), r(w.steer), r(w.grip)]),
  }
}

export function importVehicle(v, s) {
  const k = s.wear
  if (k.tyres) k.tyres.forEach((t, i) => Object.assign(v.tyres[i], { wear: t[0], temp: t[1], puncture: t[2] }))
  if (k.brakeTemp) v.brakeTemp = k.brakeTemp.slice()
  v.brakeHot = k.brakeHot
  v.engineHeat = k.engineHeat
  v.hotTime = k.hotTime
  if (k.pu) Object.assign(v.pu, k.pu)
  if (k.damage) v.damage = JSON.parse(JSON.stringify(k.damage))
  v.fuel = k.fuel
  v.steerIn = s.steer[0]
  v.steerCmd = s.steer[1]
  v.steerVel = s.steer[2]
  v.throttle = s.pedals[0]
  v.brake = s.pedals[1]
  v.battery = s.battery
  v.aeroOn = s.aeroOn
  v.impactT = s.impactT
  v.prevVel = { x: s.prevVel[0], y: s.prevVel[1], z: s.prevVel[2] }
  s.wheels.forEach((k, i) => {
    const w = v.wheels[i]
    w.compression = k[0]
    w.prevCompression = k[1]
    w.contact = k[2]
    w.slip = k[3]
    w.omega = k[4]
    w.spin = k[5]
    w.steer = k[6]
    w.grip = k[7]
  })
}
