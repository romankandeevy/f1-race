// Проверка онлайн-сервера без браузера: два клиента — создать комнату, войти по коду, старт, ввод, снапшоты,
// обрыв и возврат по токену (автопилот держит болид), трафик на игрока.
// Запуск (сервер уже запущен): node online-check.mjs [ws://localhost:8787/ws]
import WebSocket from 'ws'
import { unpackSnapshot } from '../src/net/wire.js'

const URL = process.argv[2] || 'ws://localhost:8787/ws'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function client(name, token = null) {
  const ws = new WebSocket(URL)
  const c = { ws, name, msgs: [], snaps: 0, bytes: 0, room: null, start: null, own: null, table: null, end: null, error: null, token, id: null, seq: 0 }
  ws.on('message', (raw, isBinary) => {
    c.bytes += raw.length
    if (isBinary) {
      // двоичный снапшот машин → тот же вид, что был в JSON: [номер, x, y, z, qx, qy, qz, qw, vx, vy, vz, руль, флаги]
      const b = unpackSnapshot(raw)
      raw = JSON.stringify({ t: 's', k: b.tick, l: b.lights, c: b.cars.map((x) => [x.i, ...x.p, ...x.q, ...x.v, x.steer, x.f]), sc: b.sc })
    }
    const m = JSON.parse(raw)
    if (m.t === 'welcome') {
      c.id = m.id
      c.token = m.token
    } else if (m.t === 'room') c.room = m
    else if (m.t === 'start') c.start = m
    else if (m.t === 'o') c.own = m
    else if (m.t === 'ev') (c.events ??= []).push(m)
    else if (m.t === 's') {
      c.snaps++
      c.last = m
      // самая большая скорость своего болида за всё время (газ в пол без руля — потом стена)
      const me = c.start && m.c.find((x) => x[0] === c.start.roster.findIndex((r) => r.id === c.id))
      if (me) c.vmax = Math.max(c.vmax ?? 0, Math.hypot(me[8], me[10]))
    } else if (m.t === 'race') c.table = m
    else if (m.t === 'end') c.end = m
    else if (m.t === 'error') c.error = m.text
  })
  c.open = new Promise((r) => ws.on('open', () => (ws.send(JSON.stringify({ t: 'hello', name, paint: '#1f5fbf', compound: 'soft', token: c.token })), r())))
  c.send = (m) => ws.send(JSON.stringify(m))
  // ввод 60 раз в секунду
  c.drive = (th) => {
    c.timer = setInterval(() => c.send({ t: 'in', s: ++c.seq, th, br: 0, st: 0 }), 1000 / 60)
  }
  c.stop = () => clearInterval(c.timer)
  return c
}

const ok = (cond, text) => console.log(`${cond ? '✓' : '✗'} ${text}`)

const a = client('Рома')
const b = client('Друг')
await Promise.all([a.open, b.open])
await wait(200)
a.send({ t: 'create', track: 'marina', laps: 1, level: 'medium' })
await wait(300)
ok(a.room?.code?.length === 4, `комната создана: код ${a.room?.code}`)
b.send({ t: 'join', code: a.room.code.toLowerCase() })
await wait(300)
ok(b.room?.players?.length === 2 && a.room.players.length === 2, `друг вошёл по коду: игроков ${a.room.players.length}`)
b.send({ t: 'start' })
await wait(200)
ok(!b.start, 'старт может дать только создатель')
a.send({ t: 'start' })
await wait(500)
ok(a.start && b.start, `гонка началась: в составе ${a.start?.roster.length} болидов, живых ${a.start?.roster.filter((x) => x.human).length}, места ${a.start?.slot} и ${b.start?.slot}`)
ok(a.start?.compound === 'soft', `шины на старт — свои: ${a.start?.compound}`)
const c3 = client('Опоздавший')
await c3.open
c3.send({ t: 'join', code: a.room.code })
await wait(300)
ok(!!c3.error, `в идущую гонку не пускает: «${c3.error}»`)
c3.ws.close()

a.drive(1)
b.drive(0.5)
const t0 = Date.now()
const s0 = [a.snaps, b.snaps]
const by0 = [a.bytes, b.bytes]
await wait(10000)
const sec = (Date.now() - t0) / 1000
ok(Math.abs((a.snaps - s0[0]) / sec - 30) < 4, `снапшоты ${((a.snaps - s0[0]) / sec).toFixed(1)} Гц`)
ok(a.own?.a > 500, `ввод подтверждается: окно ${a.own?.a} из отправленных ${a.seq}`)
ok(a.vmax > 15, `болид с газом поехал: до ${((a.vmax ?? 0) * 3.6).toFixed(0)} км/ч`)
ok(a.table?.cars?.length === 12, `таблица гонки: ${a.table?.cars?.length} болидов`)
console.log(`  трафик на игрока: ${((a.bytes - by0[0]) / sec / 1024).toFixed(1)} КБ/с (A), ${((b.bytes - by0[1]) / sec / 1024).toFixed(1)} КБ/с (B)`)

// обрыв: B пропал — его болид едет на автопилоте; вернулся с токеном — снова свой
b.stop()
b.ws.close()
await wait(3000)
const auto = a.last.c.find((x) => x[0] === a.start.roster.findIndex((r) => r.id === b.id))
ok(auto && Math.hypot(auto[8], auto[10]) > 3, `без связи болид друга едет сам: ${(Math.hypot(auto?.[8] ?? 0, auto?.[10] ?? 0) * 3.6).toFixed(0)} км/ч`)
const b2 = client('Друг', b.token)
await b2.open
await wait(600)
ok(b2.id === b.id && b2.start?.you === b.id && b2.snaps > 5, `вернулся по токену: тот же игрок ${b2.id}, снова в гонке, снапшоты идут`)
ok(b2.own && b2.own.auto === false, 'автопилот снят, управление у игрока')

a.stop()
a.ws.close()
b2.ws.close()
await wait(300)
process.exit(0)
