// Онлайн-сервер игры. На одном порту: раздаёт собранную игру (dist/, `npm run build`) и ведёт гонки по WebSocket (/ws) —
// друзьям хватает одного адреса (туннель с Mac или VPS).
// Комнаты по коду из 4 букв: создатель выбирает трассу, круги и уровень ботов; до 12 живых игроков, свободные места — боты.
// Гонка — src/core/race-session.js (та же физика, что в игре): 240 шагов в секунду, ввод игроков окнами по 1/60 с
// (нет ввода к окну — едет с прошлым), снапшоты 30 раз в секунду (двоичные, src/net/wire.js), таблица гонки 2 раза в секунду.
// Обрыв связи: в гонке болид ведёт автопилот, место держится; вернулся с тем же токеном — управление снова у него.
// Запуск: node game-server.mjs [--port=8787] [--dist=../dist]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import RAPIER from '@dimforge/rapier3d-compat'
import { loadTrack } from './track-node.mjs'
import { createRaceSession, STEP, CARS } from '../src/core/race-session.js'
import { createQualiSession } from '../src/core/quali-session.js'
import { exportVehicle } from '../src/net/state.js'
import { AI_LEVELS } from '../src/ai.js'
import { COMPOUNDS } from '../src/wear.js'
import { packSnapshot } from '../src/net/wire.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const PORT = Number(args.port ?? process.env.PORT ?? 8787)
const DIST = path.resolve(here, args.dist ?? '../dist')
const WINDOW = 4 // шагов на окно ввода (1/60 с)
const SNAP_EVERY = 8 // шагов между снапшотами (30 Гц)
const TABLE_EVERY = 120 // шагов между таблицами гонки (2 Гц: места меняются не чаще)
const QUEUE_MAX = 8 // окон ввода в очереди игрока; больше — часы клиента убежали, лишнее выкидываем
const LOBBY_GRACE = 60_000 // мс: игрок без связи в лобби — место держим столько
const RACE_ABANDON = 60_000 // мс: все живые игроки без связи — гонку закрываем
const MAX_LAPS = 30
const MINUTES = [5, 10, 15, 20] // онлайн-заезд на время: длина сессии
const DEBUG = 'debug' in args // --debug: команда «заглушить мотор» для проверок (в обычном запуске её нет)

await RAPIER.init()
const TRACKS = {
  marina: loadTrack(path.join(here, '../public/models/marina.glb')),
  lumen: loadTrack(path.join(here, '../public/models/track.glb')),
}

const r2 = (x) => Math.round(x * 100) / 100
const r3 = (x) => Math.round(x * 1000) / 1000
const r5 = (x) => Math.round(x * 1e5) / 1e5 // 10 мкм: для отката своей машины хватает, JSON короче вдвое

const rooms = new Map() // код → комната
const byToken = new Map() // токен → игрок
let nextId = 1
const stats = { steps: 0, stepMs: 0, stepMax: 0 }

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  let c
  do c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('')
  while (rooms.has(c))
  return c
}
const newToken = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
const clean = (s, n) => String(s ?? '').replace(/[<>&"]/g, '').trim().slice(0, n)
const isColor = (c) => /^#[0-9a-f]{6}$/i.test(c)

function send(p, msg) {
  if (p.ws && p.ws.readyState === 1) p.ws.send(typeof msg === 'string' || msg instanceof Uint8Array ? msg : JSON.stringify(msg))
}
function roomInfo(room) {
  return {
    t: 'room',
    code: room.code,
    mode: room.mode,
    minutes: room.minutes,
    track: room.track,
    laps: room.laps,
    level: room.level,
    host: room.host,
    state: room.state,
    players: room.players.map((p) => ({ id: p.id, name: p.name, paint: p.paint, compound: p.compound, connected: p.connected })),
  }
}
function broadcastRoom(room) {
  const msg = JSON.stringify(roomInfo(room))
  for (const p of room.players) send(p, msg)
}

function leaveRoom(p) {
  const room = rooms.get(p.room)
  p.room = null
  if (!room) return
  room.players = room.players.filter((x) => x !== p)
  if (room.state === 'race') room.session?.setAutopilot(p.id, true) // гонка идёт: его болид доезжает на автопилоте
  if (!room.players.length) return closeRoom(room)
  if (room.host === p.id) room.host = room.players[0].id
  broadcastRoom(room)
}
function closeRoom(room) {
  room.session?.dispose()
  room.session = null
  rooms.delete(room.code)
}

// ---------- гонка ----------
function startRace(room) {
  const humans = room.players.slice(0, CARS).map((p, k) => ({ id: p.id, name: p.name, paint: p.paint, slot: CARS - 1 - k, compound: p.compound }))
  room.session?.dispose()
  const seed = Math.floor(Math.random() * 2 ** 31)
  // онлайн-заезд на время — призраки, таймер, лучший круг (quali-session); гонка — с ботами (race-session)
  const s =
    room.mode === 'quali'
      ? createQualiSession({ RAPIER, track: TRACKS[room.track], seed, minutes: room.minutes, humans })
      : createRaceSession({ RAPIER, track: TRACKS[room.track], seed, laps: room.laps, botLevel: room.level, humans })
  room.session = s
  room.state = 'race'
  room.acc = 0
  room.inputs = {}
  room.roster = s.roster()
  room.index = new Map(room.roster.map((c, i) => [c.id, i]))
  for (const p of room.players) {
    p.queue = []
    p.last = {}
    p.ack = 0
    p.seqSeen = 0
    if (!p.connected) s.setAutopilot(p.id, true)
    sendStart(room, p)
  }
  broadcastRoom(room)
}
function sendStart(room, p) {
  const h = room.session.human(p.id)
  send(p, { t: 'start', code: room.code, mode: room.mode, minutes: room.minutes, track: room.track, laps: room.laps, roster: room.roster, you: p.id, slot: h?.slot ?? 0, compound: h?.v.compound ?? 'medium', tick: room.session.tick })
}

const flagsOf = (v) => {
  const d = v.damage
  let f = 0
  if (v.state.braking) f |= 1
  if (v.aero > 0.5) f |= 2
  if (Math.min(d.wingL, d.wingR) >= 0.9) f |= 4
  if (d.rearWing >= 0.95) f |= 8
  d.lost.forEach((x, i) => {
    if (x) f |= 16 << i
  })
  return f
}

function tableOf(room) {
  const ix = room.index
  if (room.mode === 'quali') {
    // заезд на время: секунды до конца, лучшие круги по местам
    const t = room.session.table()
    return { mode: 'quali', minutes: t.minutes, left: r2(t.left), started: t.started, over: t.over, rows: t.rows.map((r) => [ix.get(r.id), r.best === null ? -1 : r3(r.best), r.last === null ? -1 : r3(r.last), r.laps, r.done ? 1 : 0]) }
  }
  const st = room.session.race.state
  return {
    laps: st.laps,
    run: st.running,
    cars: st.cars.map((c) => [ix.get(c.id), c.lap, r2(c.gap), c.finished ? 1 : 0, r3(c.finishTime), c.penalty, c.dnf ? 1 : 0, c.dsq ? 1 : 0, c.reason || '', c.inPit ? 1 : 0, c.compound || '', c.stops]),
    order: st.order.map((c) => ix.get(c.id)),
  }
}

// снапшот машин — двоичный (src/net/wire.js): 30 байт на болид, всем одинаковый, 30 раз в секунду;
// своему игроку каждый третий раз (10 Гц) — отдельным JSON полное состояние его болида для отката (~0,9 КБ)
const OWN_EVERY = 3
function snapshot(room) {
  const s = room.session
  const lights = s.lights()
  const cars = s.cars().map(({ id, v }) => ({ i: room.index.get(id), p: v.body.translation(), q: v.body.rotation(), v: v.body.linvel(), steer: v.wheels[0].steer, f: flagsOf(v) }))
  const bin = packSnapshot(s.tick, lights.waiting ? lights.lit : -1, cars, s.scState())
  const withOwn = (s.tick / SNAP_EVERY) % OWN_EVERY === 0
  for (const p of room.players) {
    send(p, bin)
    if (!withOwn) continue
    const h = s.human(p.id)
    if (!h) continue
    const v = h.v
    const t = v.body.translation()
    const q = v.body.rotation()
    const l = v.body.linvel()
    const w = v.body.angvel()
    // своему — полное состояние болида для отката, номер последнего применённого окна ввода, потолок скорости под флагами,
    // табло флагов и чёрно-оранжевый флаг
    send(p, {
      t: 'o',
      k: s.tick,
      a: p.ack,
      auto: h.auto || h.autopilot,
      pit: h.pit,
      req: h.pitRequest,
      p: [t.x, t.y, t.z].map(r5),
      q: [q.x, q.y, q.z, q.w].map(r5),
      v: [l.x, l.y, l.z].map(r5),
      w: [w.x, w.y, w.z].map(r5),
      st: exportVehicle(v),
      cap: Number.isFinite(h.cap) ? r2(h.cap) : -1,
      fl: h.banner,
      of: h.orange,
      rm: h.removed,
    })
  }
}

function endRace(room) {
  const msg = JSON.stringify({ t: 'end', table: tableOf(room) })
  for (const p of room.players) send(p, msg)
  room.session.dispose()
  room.session = null
  room.state = 'lobby'
  broadcastRoom(room)
}

function stepRoom(room) {
  const s = room.session
  if (s.tick % WINDOW === 0) {
    // окно ввода: у каждого игрока — следующее по очереди; нет — едет с прошлым
    for (const p of room.players) {
      if (p.queue.length) {
        p.last = p.queue.shift()
        p.ack = p.last.s
      }
      const m = p.last
      room.inputs[p.id] = { throttle: m.th, brake: m.br, steer: m.st, abs: m.abs, aero: m.aero, boost: m.bo, ersMode: m.ers, pitRequest: !!m.pit, plan: m.pc ? { compound: m.pc, wing: !!m.pw } : undefined, reset: !!m.rs }
    }
  }
  const t0 = performance.now()
  s.stepAll(room.inputs)
  // события гонки (флаги, эвакуатор, штрафы игроку) — сразу всем или тому, кому адресовано
  for (const n of s.takeNews()) {
    const msg = JSON.stringify({ t: 'ev', ...n })
    for (const p of room.players) if (!n.to || n.to === p.id) send(p, msg)
  }
  const ms = performance.now() - t0
  stats.steps++
  stats.stepMs += ms
  stats.stepMax = Math.max(stats.stepMax, ms)
  if (s.tick % SNAP_EVERY === 0) snapshot(room)
  if (s.tick % TABLE_EVERY === 0) {
    const msg = JSON.stringify({ t: 'race', ...tableOf(room) })
    for (const p of room.players) send(p, msg)
  }
  // все живые игроки финишировали или сошли — гонка для комнаты окончена (боты — по месту в этот момент)
  if (s.isOver()) return endRace(room)
  if (room.mode === 'quali') return
  const st = s.race.state
  const humansDone = room.players.every((p) => {
    const c = st.cars.find((x) => x.id === p.id)
    return !c || c.finished || c.dnf || c.dsq
  })
  if (humansDone) endRace(room)
}

let last = performance.now()
setInterval(() => {
  const now = performance.now()
  const dt = Math.min(0.25, (now - last) / 1000)
  last = now
  for (const room of rooms.values()) {
    if (room.state !== 'race') continue
    room.acc += dt
    let n = 0
    while (room.acc >= STEP && n < 120 && room.state === 'race') {
      stepRoom(room)
      room.acc -= STEP
      n++
    }
  }
}, 4)

// уборка: в лобби — отключившиеся дольше LOBBY_GRACE; в гонке без единого живого игрока на связи — закрыть
setInterval(() => {
  const now = Date.now()
  for (const room of [...rooms.values()]) {
    if (room.state === 'lobby') {
      for (const p of [...room.players]) if (!p.connected && now - p.lostAt > LOBBY_GRACE) leaveRoom(p)
    } else if (room.players.every((p) => !p.connected && now - p.lostAt > RACE_ABANDON)) closeRoom(room)
  }
  for (const [tok, p] of byToken) if (!p.connected && !p.room && now - p.lostAt > LOBBY_GRACE) byToken.delete(tok)
}, 5000)

// ---------- сообщения ----------
function onMessage(p, m) {
  const room = rooms.get(p.room)
  switch (m.t) {
    case 'ping':
      return send(p, { t: 'pong', c: m.c })
    case 'name':
      p.name = clean(m.name, 16) || p.name
      if (isColor(m.paint)) p.paint = m.paint
      if (COMPOUNDS[m.compound]) p.compound = m.compound // шины на старт
      if (room) broadcastRoom(room)
      return
    case 'create': {
      if (room) leaveRoom(p)
      const code = newCode()
      const r = {
        code,
        mode: m.mode === 'quali' ? 'quali' : 'race',
        minutes: MINUTES.includes(Number(m.minutes)) || (DEBUG && Number(m.minutes) > 0) ? Number(m.minutes) : 10, // --debug: любая длина (проверки)
        track: TRACKS[m.track] ? m.track : 'marina',
        laps: Math.max(1, Math.min(MAX_LAPS, Math.round(Number(m.laps) || 5))),
        level: AI_LEVELS[m.level] ? m.level : 'medium',
        host: p.id,
        players: [p],
        state: 'lobby',
        session: null,
      }
      rooms.set(code, r)
      p.room = code
      return broadcastRoom(r)
    }
    case 'join': {
      const r = rooms.get(String(m.code || '').toUpperCase().trim())
      if (!r) return send(p, { t: 'error', text: 'Комнаты с таким кодом нет' })
      if (r === room) return broadcastRoom(r)
      if (r.state !== 'lobby') return send(p, { t: 'error', text: 'В этой комнате уже идёт гонка — подожди финиша' })
      if (r.players.length >= CARS) return send(p, { t: 'error', text: 'Комната полная: 12 из 12' })
      if (room) leaveRoom(p)
      r.players.push(p)
      p.room = r.code
      return broadcastRoom(r)
    }
    case 'set': // настройки комнаты меняет создатель, пока лобби
      if (!room || room.host !== p.id || room.state !== 'lobby') return
      if (TRACKS[m.track]) room.track = m.track
      if (m.laps) room.laps = Math.max(1, Math.min(MAX_LAPS, Math.round(Number(m.laps))))
      if (AI_LEVELS[m.level]) room.level = m.level
      if (MINUTES.includes(Number(m.minutes)) || (DEBUG && Number(m.minutes) > 0)) room.minutes = Number(m.minutes)
      return broadcastRoom(room)
    case 'start':
      if (!room || room.host !== p.id || room.state !== 'lobby') return
      return startRace(room)
    case 'leave':
      return leaveRoom(p)
    case 'debug': // только с --debug: заглушить мотор болиду (проверка флагов, машины безопасности, эвакуатора)
      if (DEBUG && m.fail) {
        const r = rooms.get(String(m.code || p.room || ''))
        if (r?.state === 'race') r.session.failEngine(String(m.fail))
      }
      return
    case 'in': {
      if (!room || room.state !== 'race' || !(m.s > p.seqSeen)) return // старые (переупорядоченные) окна не нужны
      p.seqSeen = m.s
      p.queue.push(m)
      if (p.queue.length > QUEUE_MAX) p.queue.splice(0, p.queue.length - 3)
      return
    }
  }
}

// ---------- HTTP: игра из dist/ ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
}
const server = http.createServer((req, res) => {
  let p
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  } catch {
    res.writeHead(400).end()
    return
  }
  if (p === '/status') {
    const players = [...rooms.values()].reduce((a, r) => a + r.players.length, 0)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ rooms: rooms.size, players }))
    return
  }
  if (p.endsWith('/')) p += 'index.html'
  const file = path.join(DIST, p)
  if (!file.startsWith(DIST + path.sep)) {
    res.writeHead(403).end()
    return
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(fs.existsSync(DIST) ? 'Нет такого файла' : 'Игра не собрана: npm run build')
      return
    }
    const ext = path.extname(file).toLowerCase()
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    })
    fs.createReadStream(file).pipe(res)
  })
})

const wss = new WebSocketServer({ server, path: '/ws' })
wss.on('connection', (ws) => {
  let p = null
  ws.on('message', (raw) => {
    let m
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    if (!p) {
      // отладка (--debug) без входа в комнату: заглушить мотор в комнате по коду
      if (m.t === 'debug' && DEBUG && m.fail) return rooms.get(String(m.code || ''))?.session?.failEngine(String(m.fail))
      if (m.t !== 'hello') return
      // вернулся с тем же токеном — тот же игрок (комната, место, болид в гонке)
      p = byToken.get(m.token)
      if (p) {
        if (p.ws && p.ws !== ws) p.ws.close()
        p.ws = ws
        p.connected = true
      } else {
        p = { id: 'p' + nextId++, token: newToken(), name: 'Игрок', paint: '#e9e6df', compound: 'medium', ws, room: null, connected: true, lostAt: 0, queue: [], last: {}, ack: 0, seqSeen: 0 }
        byToken.set(p.token, p)
      }
      p.name = clean(m.name, 16) || p.name
      if (isColor(m.paint)) p.paint = m.paint
      if (COMPOUNDS[m.compound]) p.compound = m.compound
      send(p, { t: 'welcome', id: p.id, token: p.token })
      const room = rooms.get(p.room)
      if (room) {
        if (room.state === 'race') {
          room.session.setAutopilot(p.id, false)
          p.queue = []
          sendStart(room, p)
        }
        broadcastRoom(room)
      }
      return
    }
    onMessage(p, m)
  })
  ws.on('close', () => {
    if (!p || p.ws !== ws) return
    p.connected = false
    p.lostAt = Date.now()
    const room = rooms.get(p.room)
    if (room) {
      if (room.state === 'race') room.session.setAutopilot(p.id, true)
      broadcastRoom(room)
    }
  })
})

setInterval(() => {
  if (!rooms.size) return
  const players = [...rooms.values()].reduce((a, r) => a + r.players.length, 0)
  const racing = [...rooms.values()].filter((r) => r.state === 'race').length
  const avg = stats.steps ? (stats.stepMs / stats.steps).toFixed(3) : '0'
  console.log(`[game] комнат ${rooms.size} (гонок ${racing}), игроков ${players}, шаг ${avg} мс (макс ${stats.stepMax.toFixed(2)})`)
  stats.steps = 0
  stats.stepMs = 0
  stats.stepMax = 0
}, 10000)

server.listen(PORT, () => console.log(`[game] http://localhost:${PORT} · игра из ${DIST}${fs.existsSync(DIST) ? '' : ' (не собрана: npm run build)'} · WebSocket /ws`))
