// Стюарды (Рома 29.10: «хочу максимально реалистично, как в Формуле-1, чтобы я был пилотом»): что считается сходом, когда показывают
// чёрно-оранжевый флаг, кто виноват в столкновении и какой штраф. Без Three.js: проверяется в Node. Решения принимает main.js (игрок) и bots.js (боты).
import { SUSP_BROKEN } from './wear.js'

const yawOfBody = (b) => {
  const q = b.rotation()
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
}

// Болид дальше ехать не может: сход. Возвращает причину или null. Отказ мотора (pu.failed) — тоже сход, но сообщает его сам износ.
export function retireReason(v) {
  const d = v.damage
  if (d.chassis >= 1) return 'Монокок разрушен'
  if (d.lost.some(Boolean)) return 'Оторвано колесо'
  if (Math.max(d.suspL, d.suspR) >= 1) return 'Подвеска разрушена'
  return null
}

// Болид небезопасен — чёрно-оранжевый флаг: обязан заехать в боксы на ремонт. Возвращает причину или null.
// (Подвеска сломана, но не разрушена — флаг не показывают: в боксах её не чинят, пилот сам решает, ехать ли дальше.)
export function mechanicalFlag(v) {
  const d = v.damage
  if (Math.max(d.wingL, d.wingR) >= 0.8) return 'Переднее крыло разрушено'
  if (d.rearWing >= 0.9) return 'Заднее крыло разрушено'
  if (d.floor >= 0.8) return 'Днище разрушено'
  if (Math.max(d.sideL, d.sideR) >= 0.8) return 'Бокпод разбит, мотор перегреется'
  if (d.brakes >= 0.7) return 'Тормозные каналы разбиты'
  if (v.engineHeat > 1.05) return 'Мотор перегревается'
  return null
}
export const ORANGE_LAPS = 2 // кругов на то, чтобы заехать в боксы; иначе чёрный флаг — дисквалификация
export { SUSP_BROKEN }

// Кто виноват в столкновении двух болидов. Смотрим на положение и скорость до удара (prevVel — скорость в начале шага).
// Возвращает { fault: a | b | null, closing } — closing — скорость сближения, м/с.
// Виноват тот, кто въехал в заднюю часть другого (нос одного в корму другого), или тот, кто сам пошёл боком на соседа; иначе — гоночный инцидент.
export function judgeContact(a, b) {
  const pa = a.body.translation()
  const pb = b.body.translation()
  const ya = yawOfBody(a.body)
  const yb = yawOfBody(b.body)
  const dx = pb.x - pa.x
  const dz = pb.z - pa.z
  const fa = [Math.sin(ya), Math.cos(ya)]
  const fb = [Math.sin(yb), Math.cos(yb)]
  const ra = [Math.cos(ya), -Math.sin(ya)] // «влево» у a
  const va = a.prevVel
  const vb = b.prevVel
  const closing = Math.hypot(va.x - vb.x, va.z - vb.z)
  const ahead = dx * fa[0] + dz * fa[1] // b впереди a (в осях a)
  const lat = dx * ra[0] + dz * ra[1] // b слева от a
  const aheadB = -dx * fb[0] - dz * fb[1] // a впереди b (в осях b)
  const sameWay = fa[0] * fb[0] + fa[1] * fb[1] > 0.5 // ехали в одну сторону
  // сзади: нос a въехал в корму b (b впереди почти по линии, a быстрее вдоль движения)
  const approachA = (va.x - vb.x) * fa[0] + (va.z - vb.z) * fa[1]
  const approachB = (vb.x - va.x) * fb[0] + (vb.z - va.z) * fb[1]
  if (sameWay && ahead > 1.2 && Math.abs(lat) < 1.6 && approachA > 2.5) return { fault: a, victim: b, closing }
  if (sameWay && aheadB > 1.2 && Math.abs(lat) < 1.6 && approachB > 2.5) return { fault: b, victim: a, closing }
  // бок о бок: виноват тот, кто двигался на соседа поперёк быстрее
  if (Math.abs(ahead) <= 1.2 || Math.abs(lat) >= 1.6) {
    const sideA = ((va.x - vb.x) * ra[0] + (va.z - vb.z) * ra[1]) * Math.sign(lat || 1) // a идёт на b поперёк
    const sideB = ((vb.x - va.x) * ra[0] + (vb.z - va.z) * ra[1]) * -Math.sign(lat || 1)
    if (sideA > 2.5 && sideA > sideB * 1.8) return { fault: a, victim: b, closing }
    if (sideB > 2.5 && sideB > sideA * 1.8) return { fault: b, victim: a, closing }
  }
  return { fault: null, victim: null, closing }
}

// Штраф за вину в столкновении, с: лёгкий контакт — без штрафа, заметный — 5 с, тяжёлый — 10 с
export function contactPenalty(closing) {
  return closing > 20 ? 10 : closing > 6 ? 5 : 0
}
