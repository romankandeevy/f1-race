// Проверка предсказания через настоящий лаб-сервер, без браузера: клиент = predict.js + состояние из снапшотов,
// ввод — тот же сценарий, что в браузерной проверке (газ, руль влево-вправо, тормоз). Выводит поправки.
import WebSocket from 'ws'
import RAPIER from '@dimforge/rapier3d-compat'
import { createPredictor, INPUT_STEPS, DT } from '../src/net/predict.js'

await RAPIER.init()
const URL = process.argv[2] ?? 'ws://localhost:8787'
const SECONDS = Number(process.argv[3] ?? 20)
const ws = new WebSocket(URL)
let me = null
let pred = null
let seq = 0
const corr = []
const script = [['W', 3], ['A', 0.9], ['D', 1.4], ['S', 0.5], ['W', 1.5], ['D', 0.8], ['A', 1.2], ['W', 2], ['A', 0.6], ['D', 1.0], ['W', 3]]
const keyAt = (t) => {
  let acc = 0
  for (const [k, d] of script) {
    if (t < acc + d) return k
    acc += d
  }
  return 'W'
}
const input = (k) => ({ throttle: k === 'W' ? 1 : 0, brake: k === 'S' ? 1 : 0, steer: k === 'D' ? 1 : k === 'A' ? -1 : 0, handbrake: false, abs: false, aero: false, aeroZone: false, boost: false, ersMode: 'balanced', hold: false })
const t0 = Date.now()
let sent = 0

ws.on('message', (raw) => {
  const m = JSON.parse(raw)
  if (m.type === 'welcome') {
    me = m.id
    pred = createPredictor(RAPIER, m.spawn)
    ws.send(JSON.stringify({ type: 'in', seq: 0, throttle: 0, brake: 0, steer: 0 }))
    startLoop()
  } else if (m.type === 'snap' && pred) {
    const p = m.players.find((x) => x.id === me)
    if (!p) return
    const before = pred.pos()
    pred.reconcile(p.seq, { p: p.p, q: p.q, v: p.v, w: p.w, st: m.own.st })
    const after = pred.pos()
    const d = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2])
    corr.push(d)
    if (d > 0.5) console.log(`большая поправка ${d.toFixed(2)} м: снапшот seq ${p.seq}, тик ${m.tick}, ожидание ${pred.pending()}, скорость ${Math.hypot(p.v[0], p.v[2]).toFixed(1)} м/с, время ${((Date.now() - t0) / 1000).toFixed(2)} с, seq клиента ${seq}`)
  }
})

let loop = null
function startLoop() {
  // 60 вводов в секунду, каждый — 4 шага физики, как и в браузере
  let simStart = Date.now()
  loop = setInterval(() => {
    const t = (Date.now() - t0) / 1000
    if (t > SECONDS) {
      report()
      return
    }
    seq++
    const k = keyAt(t)
    const inp = input(k)
    pred.step(seq, inp)
    ws.send(JSON.stringify({ type: 'in', seq, throttle: inp.throttle, brake: inp.brake, steer: inp.steer }))
    sent++
  }, 1000 / 60)
}

function report() {
  clearInterval(loop)
  const s = corr.slice().sort((a, b) => a - b)
  const q = (x) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * x))] : 0)
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0
  console.log(`поправок ${s.length}: средняя ${(mean * 100).toFixed(2)} см, p95 ${(q(0.95) * 100).toFixed(2)} см, макс ${(q(1) * 100).toFixed(1)} см, больше 5 см: ${s.filter((x) => x > 0.05).length}`)
  ws.close()
  process.exit(0)
}
