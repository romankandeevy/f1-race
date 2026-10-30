// Сборки болида (build.js) на сервере: своя сборка и настройка у игрока, «одинаковые болиды» — у всех стандарт, у ботов свои,
// настройка по ходу (setSetup), опция комнаты builds и она же в старте. Запуск (сервер с --debug или без): node build-check.mjs [ws://localhost:8787/ws]
import RAPIER from '@dimforge/rapier3d-compat'
import WebSocket from 'ws'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTrack } from './track-node.mjs'
import { createRaceSession } from '../src/core/race-session.js'
import { createQualiSession } from '../src/core/quali-session.js'
import { STOCK_BUILD } from '../src/build.js'
await RAPIER.init()
const here = path.dirname(fileURLToPath(import.meta.url))
const track = loadTrack(path.join(here, '../public/models/track.glb'))
const mine = { ...STOCK_BUILD, engine: 'quali', aero: 'efficient' }
const humans = [{ id: 'a', name: 'A', paint: '#ffffff', slot: 11, compound: 'medium', build: mine, setup: { frontWing: 40 } }, { id: 'b', name: 'B', paint: '#000000', slot: 10, compound: 'medium', build: { engine: 'quali', aero: 'efficient', ers: 'punch', chassis: 'light', gearbox: 'seamless' }, setup: { brakeBias: 'x' } }]
for (const [name, mk] of [['race', (b) => createRaceSession({ RAPIER, track, seed: 3, humans, builds: b })], ['quali', (b) => createQualiSession({ RAPIER, track, seed: 3, humans, builds: b })]]) {
  const own = mk(true), same = mk(false)
  const A = own.human('a').v, B = own.human('b').v
  console.log(name, 'свои: A мощность', A.T.power, 'прижим', A.T.downforceK.toFixed(3), 'крыло', A.T.setup.frontWing, '| B (дороже бюджета) мощность', B.T.power, 'баланс', B.T.setup.brakeBias)
  console.log(name, 'одинаковые: A мощность', same.human('a').v.T.power, 'крыло', same.human('a').v.T.setup.frontWing)
  own.setSetup('a', { frontWing: 12 })
  console.log(name, 'setSetup: крыло', A.T.setup.frontWing, 'у B не тронуто', B.T.setup.frontWing)
  if (name === 'race') {
    const bots = own.cars().filter((c) => !['a', 'b'].includes(c.id)).map((c) => Math.round(c.v.T.power / 1000))
    const botsSame = same.cars().filter((c) => !['a', 'b'].includes(c.id)).map((c) => Math.round(c.v.T.power / 1000))
    console.log('боты (свои сборки) кВт:', bots.join(' '), '| одинаковые:', botsSame.join(' '))
  }
  own.dispose(); same.dispose()
}
// сеть: опция комнаты и сообщение в старте
const ws = new WebSocket(process.argv[2] || 'ws://localhost:8787/ws')
const got = []
ws.on('message', (d, bin) => { if (bin) return; const m = JSON.parse(d); got.push(m)
  if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'create', mode: 'race', track: 'lumen', builds: 'same' }))
  if (m.t === 'room' && got.filter((x) => x.t === 'room').length === 1) { console.log('комната: builds =', m.builds); ws.send(JSON.stringify({ t: 'set', builds: 'own' })) }
  else if (m.t === 'room' && got.filter((x) => x.t === 'room').length === 2) { console.log('после set: builds =', m.builds); ws.send(JSON.stringify({ t: 'setup', setup: { frontWing: 30 } })); ws.send(JSON.stringify({ t: 'start' })) }
  if (m.t === 'start') { console.log('старт: builds =', m.builds); ws.close(); process.exit(0) }
})
ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'T', build: mine, setup: { frontWing: 22 } })))
