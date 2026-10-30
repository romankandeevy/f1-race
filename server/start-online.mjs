// Онлайн с этого Mac одной командой (`npm run online`): игровой сервер + бесплатный туннель (serveo, по ssh, без аккаунта).
// Печатает ссылки для друзей: через интернет (туннель) и в своей Wi-Fi (быстрее, без туннеля). Пока команда работает,
// Mac не засыпает (caffeinate). Ctrl+C — всё выключить.
// Туннель оборвался — поднимается заново; без постоянного имени ссылка тогда новая (её снова печатаем).
// Постоянная ссылка: один раз `ssh-keygen -t ed25519` и `npm run online -- --name=придумай-имя` — serveo напечатает,
// как зарегистрировать ключ (это вход у них на сайте), дальше ссылка всегда https://<имя>.serveousercontent.com.
// Без туннеля (только своя Wi-Fi): npm run online -- --local
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const PORT = Number(args.port ?? 8787)
const NAME = args.name ? String(args.name).toLowerCase().replace(/[^a-z0-9-]/g, '') : ''

const server = spawn(process.execPath, [path.join(here, 'game-server.mjs'), `--port=${PORT}`], { stdio: 'inherit' })
server.on('exit', (code) => {
  console.log(`[online] сервер остановился (${code}) — выходим`)
  process.exit(code ?? 1)
})

// Mac не спит, пока работаем (иначе гонка у друзей встанет): caffeinate сам выйдет вместе с нами
const awake = process.platform === 'darwin' ? spawn('caffeinate', ['-dims', '-w', String(process.pid)], { stdio: 'ignore' }) : null

// адреса в своей сети: друзья на той же Wi-Fi заходят напрямую
const lan = Object.values(os.networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => `http://${a.address}:${PORT}`)
setTimeout(() => {
  console.log(`\n  На этом Mac: http://localhost:${PORT}`)
  if (lan.length) console.log(`  В своей Wi-Fi: ${lan.join('  ')}`)
}, 1200)

let tunnelProc = null
let stopping = false
let lastUrl = ''
function tunnel() {
  if (stopping) return
  const fwd = `${NAME ? NAME + ':' : ''}80:localhost:${PORT}`
  tunnelProc = spawn('ssh', ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', fwd, 'serveo.net'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const onData = (d) => {
    const text = String(d).replace(/\x1b\[[0-9;]*m/g, '')
    // serveo просит ключ или его регистрацию (для постоянного имени) — показываем как есть
    if (/ssh-keygen|register|console\.serveo/i.test(text)) console.log('[serveo] ' + text.trim())
    const m = text.match(/https:\/\/[a-z0-9.-]*serveo[a-z0-9.-]*/i)
    if (m && m[0] !== lastUrl && !/console\.serveo/.test(m[0])) {
      lastUrl = m[0]
      console.log(
        `\n  Через интернет: ${m[0]}\n` +
          '  Друг открывает ссылку; первый раз serveo показывает предупреждение — «Continue to Site». После него\n' +
          '  открывается главное меню: «Онлайн» → ввести код комнаты (или открыть ссылку-приглашение ещё раз).\n',
      )
    }
  }
  tunnelProc.stdout.on('data', onData)
  tunnelProc.stderr.on('data', onData)
  tunnelProc.on('exit', () => {
    if (stopping) return
    console.log('[online] туннель оборвался — переподключаюсь через 5 с')
    setTimeout(tunnel, 5000)
  })
}

if (!args.local) setTimeout(tunnel, 1500)

const stop = () => {
  stopping = true
  tunnelProc?.kill()
  awake?.kill()
  server.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
