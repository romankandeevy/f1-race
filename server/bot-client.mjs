// Второй игрок для проверок: подключается к лаб-серверу и шлёт ввод 60 Гц (змейка руля, газ). Не рисует.
import WebSocket from 'ws'
const URL = process.argv[2] ?? 'ws://localhost:8787'
const ws = new WebSocket(URL)
const t0 = Date.now()
let seq = 0
ws.on('open', () => {
  setInterval(() => {
    const t = (Date.now() - t0) / 1000
    seq++
    const steer = t < 2 ? 0 : 0.6 * Math.sin((2 * Math.PI * t) / 3)
    ws.send(JSON.stringify({ type: 'in', seq, throttle: 1, brake: 0, steer }))
  }, 1000 / 60)
})
ws.on('close', () => process.exit(0))
setTimeout(() => process.exit(0), 90000)
