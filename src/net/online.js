// Онлайн в игре (клиент): лобби по коду комнаты и гонка или заезд на время с призраками, которые ведёт сервер
// (server/game-server.mjs; режимы — карточками на главном экране онлайна).
// Своя машина — предсказание: ввод применяется сразу на своей физике, раз в 0,1 с сервер присылает её точное
// состояние и номер последнего применённого окна ввода — откат и переигровка остального, разница гасится плавно.
// Чужие машины — по снапшотам 30 Гц с буфером 100 мс (растёт при сбоях связи), Эрмит по позиции и скорости.
// Таблица, огни старта и итог — с сервера, в том же виде, что race.state, — HUD тот же.
import { sampleCar, prune } from './interp.js'
import { importVehicle } from './state.js'
import { cleanInput, capInput } from '../core/race-session.js'
import { unpackSnapshot } from './wire.js'
import { stepVehicle } from '../vehicle.js'
import { AI_LEVELS } from '../ai.js'
import { formatTime } from '../laps.js'

const STEP = 1 / 240
const TICK_MS = 1000 / 240
const BASE_BUF = 100 // мс: буфер чужих машин
const NAME_KEY = 'f1-race.online.name'
const COMPOUND_KEY = 'f1-race.online.compound'
const BUILD_MODES = [
  { v: 'own', name: 'Свои сборки' },
  { v: 'same', name: 'Одинаковые' },
]
const START_TYRES = [{ v: 'soft', name: 'Мягкие' }, { v: 'medium', name: 'Средние' }, { v: 'hard', name: 'Жёсткие' }]
const TOKEN_KEY = 'f1-race.online.token'
const LEVELS = ['medium', 'hard'] // онлайн без «Сложных»: подтягивание знает одного игрока, а в комнате их несколько
const LAPS = [1, 3, 5, 10]
const MINUTES = [5, 10, 15, 20] // онлайн-заезд на время: длина сессии
const OFFSET_DECAY = 10 // 1/с: поправка своей машины гаснет за ~0,1 с
const WHEEL_R = 0.36 // м: вращение колёс чужих машин — по скорости
const GHOST_OPACITY = 0.35 // заезд на время: насколько видны чужие болиды-призраки

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      // не запомнили — спросим заново
    }
  },
}

// адрес сервера: ?server=…; в разработке (vite) — тот же компьютер, порт 8787; иначе — тот же адрес, что у игры
function serverUrl() {
  const q = new URLSearchParams(location.search).get('server')
  if (q) return q
  if (['5173', '5183', '5184'].includes(location.port)) return `ws://${location.hostname}:8787/ws`
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
}

// deps: { THREE, scene, car, vehicle, world, track, trackId, tracks: [{ id, name }], livery(), onStart(start), onExit(),
//         showResults(st), showQualiResults(rows, kicker), notify(text, warn, sec), openMain(), sc (машина безопасности игры), onEvent(событие гонки) }
export function createOnline(deps) {
  const { THREE } = deps
  const root = document.createElement('div')
  root.id = 'online'
  root.hidden = true
  document.body.appendChild(root)
  const style = document.createElement('style')
  style.textContent = `
    #online { position: fixed; inset: 0; z-index: 9; color: var(--text); font-family: var(--font); }
    #online[hidden] { display: none; }
    #online .ol-shade { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(4,5,7,.97) 0%, rgba(4,5,7,.9) 34%, rgba(4,5,7,.45) 56%, rgba(4,5,7,0) 76%); }
    #online .sc-col { position: absolute; left: 0; top: 0; bottom: 0; width: min(600px, 100vw); box-sizing: border-box; padding: 5vh 28px 0 clamp(24px, 4vw, 64px); display: flex; flex-direction: column; overflow-y: auto; }
    #online .ol-field { display: grid; grid-template-columns: minmax(120px, 1fr) 230px; align-items: center; gap: 14px; padding: 9px 14px 9px 16px; background: rgba(255,255,255,.035); color: #C5C8CD; font: 700 15px var(--font); letter-spacing: .03em; text-transform: uppercase; }
    #online .ol-field input { appearance: none; border: 1px solid #3A3F47; background: rgba(0,0,0,.35); color: var(--text); font: 700 16px var(--font); padding: 7px 10px; letter-spacing: .04em; min-width: 0; }
    #online .ol-field input.code { text-transform: uppercase; letter-spacing: .3em; font-size: 20px; }
    #online .ol-code { font: 900 italic clamp(64px, 12vh, 112px)/.88 var(--font); letter-spacing: .06em; margin: 10px 0 6px; }
    #online .ol-players { display: flex; flex-direction: column; gap: 3px; margin: 14px 0 0; }
    #online .ol-player { display: flex; align-items: center; gap: 12px; padding: 8px 14px; background: rgba(255,255,255,.035); font: 700 16px var(--font); text-transform: uppercase; letter-spacing: .03em; }
    #online .ol-player i { width: 26px; height: 14px; background: var(--c); border: 1px solid rgba(255,255,255,.25); }
    #online .ol-player em { margin-left: auto; font: 700 11px var(--font); font-style: normal; letter-spacing: .08em; padding: 1px 7px; background: #2B2F36; color: var(--muted); }
    #online .ol-player em.host { background: var(--red); color: #fff; }
    #online .ol-player.off { opacity: .45; }
    #online .ol-msg { margin: 14px 0 0; color: var(--yellow); font: 600 14px var(--font); min-height: 1.3em; }
    #online .ol-row2 { display: flex; gap: 6px; margin-top: 12px; }
    #online .ol-row2 .sc-row { flex: 1; text-align: center; display: block; }
    .olq-clock { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); text-align: center; padding: 8px 20px; z-index: 3; }
    .olq-clock small { display: block; color: var(--muted); font: 700 11px var(--font); letter-spacing: .12em; text-transform: uppercase; }
    .olq-clock b { font: 900 italic 34px/1 var(--font); font-variant-numeric: tabular-nums; }
    .olq-board { margin-top: 8px; padding: 10px 12px; min-width: 250px; }
    .olq-board h4 { margin: 0 0 6px; font: 900 italic 14px var(--font); text-transform: uppercase; letter-spacing: .04em; }
    .olq-board ol { margin: 0; padding: 0; list-style: none; }
    .olq-board li { display: grid; grid-template-columns: 20px 10px 1fr auto; gap: 8px; align-items: center; padding: 3px 0; font: 700 14px var(--font); border-bottom: 1px solid rgba(255,255,255,.06); }
    .olq-board li i { width: 10px; height: 10px; background: var(--c); }
    .olq-board li .t { font-variant-numeric: tabular-nums; color: #C5C8CD; }
    .olq-board li .t.best { color: #B46CFF; }
    .olq-board li.me span { color: var(--yellow); }
  `
  document.head.appendChild(style)
  // табло онлайн-заезда на время: часы сессии по центру сверху, лучшие круги — в левой колонке под временем круга
  const qClock = document.createElement('div')
  qClock.className = 'panel cut olq-clock'
  qClock.hidden = true
  ;(document.getElementById('hud') ?? document.body).appendChild(qClock)
  const qBoard = document.createElement('div')
  qBoard.className = 'panel cut olq-board'
  qBoard.hidden = true
  ;(document.getElementById('leftcol') ?? document.body).appendChild(qBoard)

  let ws = null
  let myId = null
  let token = store.get(TOKEN_KEY)
  let room = null // последнее состояние комнаты с сервера
  let msg = '' // ошибка или подсказка под формой
  let connecting = false
  let wantJoin = new URLSearchParams(location.search).get('join')
  let race = null // идущая гонка (см. beginRace)
  let lastTable = null
  let pingSent = 0
  let rtt = null
  let pick = 'quali' // выбранная карточка режима на главном экране онлайна

  // ---------- связь ----------
  function connect() {
    if (ws && ws.readyState <= 1) return
    connecting = true
    msg = 'Подключение к серверу…'
    render()
    ws = new WebSocket(serverUrl())
    ws.binaryType = 'arraybuffer' // снапшоты машин — двоичные (wire.js)
    ws.onopen = () => {
      connecting = false
      msg = ''
      ws.send(JSON.stringify({ t: 'hello', token, ...profile() }))
    }
    ws.onclose = () => {
      connecting = false
      ws = null
      msg = 'Нет связи с сервером'
      if (race) {
        deps.notify('Связь с сервером потеряна — переподключаемся (болид пока ведёт автопилот)', true, 5)
        setTimeout(connect, 1500)
      }
      render()
    }
    ws.onerror = () => {
      msg = `Сервер не отвечает (${serverUrl()}). Запусти его: npm run online`
      render()
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        const b = unpackSnapshot(e.data)
        if (b && race) onSnap(b)
        return
      }
      onMessage(JSON.parse(e.data))
    }
  }
  const send = (m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m))

  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        myId = m.id
        token = m.token
        store.set(TOKEN_KEY, token)
        if (wantJoin) {
          send({ t: 'join', code: wantJoin })
          wantJoin = null
        }
        return render()
      case 'room':
        room = m
        msg = ''
        // трасса комнаты другая — перезагрузить игру на неё (физика трассы строится при загрузке) и вернуться в комнату
        if (room.track !== deps.trackId && deps.tracks.some((t) => t.id === room.track)) {
          msg = 'Загружаем трассу комнаты…'
          render()
          location.href = `${location.pathname}?track=${room.track}&online=1`
          return
        }
        return render()
      case 'error':
        msg = m.text
        return render()
      case 'start':
        if (m.track !== deps.trackId) {
          location.href = `${location.pathname}?track=${m.track}&online=1`
          return
        }
        return beginRace(m)
      case 'o': // своя машина: откат к серверу, потолок скорости и табло флагов
        if (!race) return
        race.cap = m.cap
        race.banner = m.fl
        race.orange = m.of
        race.removed = !!m.rm
        return reconcile(m)
      case 'ev': // события гонки: флаги, эвакуатор, штрафы
        return race && deps.onEvent?.(m)
      case 'race':
        lastTable = m
        m.at = performance.now()
        return
      case 'end':
        return race && endRace(m.table)
      case 'pong':
        rtt = performance.now() - m.c
        return
    }
  }

  // ---------- лобби ----------
  const myName = () => store.get(NAME_KEY) || 'Игрок'
  const myCompound = () => (START_TYRES.some((t) => t.v === store.get(COMPOUND_KEY)) ? store.get(COMPOUND_KEY) : 'medium')
  // профиль: имя, цвет, шины на старт, сборка болида (гараж) и настройка болида — сервер считает физику с ними
  const profile = () => ({ name: myName(), paint: deps.livery().primary, compound: myCompound(), build: deps.build?.(), setup: deps.setup?.() })
  let sentSetup = ''
  const sendProfile = () => {
    sentSetup = JSON.stringify(deps.setup?.() ?? null)
    send({ t: 'name', ...profile() })
  }
  const trackName = (id) => deps.tracks.find((t) => t.id === id)?.name ?? id
  const MODES = {
    quali: { name: 'Заезд на время', kick: 'Призраки · до 12 игроков', about: 'Все на трассе одновременно, но болиды — призраки: сквозь друг друга, без столкновений. Кто за отведённые минуты проедет самый быстрый круг — тот победил. Ботов нет.' },
    race: { name: 'Гонка', kick: 'Гонка · до 12 игроков + боты', about: 'Огни старта, столкновения, пит-стопы, флаги, машина безопасности. Свободные места — боты.' },
  }
  function render() {
    if (root.hidden) return
    const host = room && room.host === myId
    const shade = '<div class="ol-shade"></div>'
    if (!room) {
      // Онлайн: имя, режимы карточками (каждая создаёт свою комнату), вход по коду друга
      const card = (id) => `<button class="sc-mode${pick === id ? ' on' : ''}" data-act="create-${id}"><span class="sc-mode-k">${MODES[id].kick}</span><b>${MODES[id].name}</b><span class="sc-mode-t">${MODES[id].about}</span><span class="sc-mode-go">Создать комнату</span></button>`
      root.innerHTML = `${shade}<section class="sc-col wide">
        <header class="sc-brand"><span class="sc-tag">Онлайн · с друзьями</span><h1 class="sc-title">Онлайн</h1></header>
        <div class="sc-rows" style="max-width:560px"><label class="ol-field">Имя<input data-k="name" maxlength="16" value="${esc(myName())}"></label></div>
        <div class="sc-modes" style="margin-top:12px">${card('quali')}${card('race')}</div>
        <div class="sc-rows" style="max-width:560px;margin-top:14px">
          <label class="ol-field">Код комнаты друга<input data-k="code" class="code" maxlength="4" placeholder="ABCD" value=""></label>
          <button class="sc-row" data-act="join">Войти по коду</button>
          <button class="sc-row" data-act="back">Назад</button>
        </div>
        <p class="ol-msg">${esc(msg)}</p>
        <footer class="sc-foot"><span><kbd>← →</kbd>режим</span><span><kbd>Enter</kbd>создать / войти по коду</span><span><kbd>Esc</kbd>назад</span></footer>
      </section>`
    } else {
      const seg = (k, opts, cur) =>
        `<span class="sc-ctl sc-seg">${opts.map((o) => `<button data-set="${k}" data-v="${o.v}" class="${String(o.v) === String(cur) ? 'on' : ''}" ${host ? '' : 'disabled'}>${esc(o.name)}</button>`).join('')}</span>`
      const link = `${location.origin}${location.pathname}?track=${room.track}&join=${room.code}`
      const quali = room.mode === 'quali'
      const rows = [
        `<div class="sc-row"><span class="sc-label">Трасса</span>${seg('track', deps.tracks.map((t) => ({ v: t.id, name: t.name })), room.track)}</div>`,
        quali
          ? `<div class="sc-row"><span class="sc-label">Время сессии</span>${seg('minutes', MINUTES.map((n) => ({ v: n, name: n + ' мин' })), room.minutes)}</div>`
          : `<div class="sc-row"><span class="sc-label">Круги</span>${seg('laps', LAPS.map((n) => ({ v: n, name: String(n) })), room.laps)}</div>
             <div class="sc-row"><span class="sc-label">Боты</span>${seg('level', LEVELS.map((l) => ({ v: l, name: AI_LEVELS[l].name })), room.level)}</div>`,
        `<div class="sc-row"><span class="sc-label">Болиды</span>${seg('builds', BUILD_MODES, room.builds ?? 'own')}</div>`,
        `<div class="sc-row"><span class="sc-label">Мои шины${quali ? '' : ' на старт'}</span><span class="sc-ctl sc-seg">${START_TYRES.map((t) => `<button data-tyre="${t.v}" class="${t.v === myCompound() ? 'on' : ''}">${t.name}</button>`).join('')}</span></div>`,
      ]
      const about = quali
        ? `${room.players.length} из 12 · болиды — призраки, столкновений нет. Победит лучший круг за ${room.minutes} мин.`
        : `${room.players.length} из 12 · свободные места — боты (${AI_LEVELS[room.level].name.toLowerCase()}).`
      const buildsAbout = room.builds === 'same' ? ' Болиды у всех одинаковые (стандартная сборка), настройка — своя.' : ' У каждого своя сборка из гаража' + (quali ? '.' : ', у ботов — свои.')
      root.innerHTML = `${shade}<section class="sc-col">
        <header class="sc-brand"><span class="sc-tag">Онлайн · ${MODES[room.mode].name.toLowerCase()} · скажи код другу</span></header>
        <div class="ol-code">${esc(room.code)}</div>
        <p class="sc-sub">Или пришли ссылку: <b data-act="copy" style="cursor:pointer;text-decoration:underline">${esc(link)}</b></p>
        <div class="sc-rows" style="margin-top:16px">${rows.join('')}</div>
        <div class="ol-players">${room.players
          .map((p) => `<div class="ol-player${p.connected ? '' : ' off'}" style="--c:${esc(p.paint)}"><i></i><span>${esc(p.name)}${p.id === myId ? ' (ты)' : ''}</span><em>${esc(START_TYRES.find((t) => t.v === p.compound)?.name ?? '')}</em>${p.id === room.host ? '<em class="host">создатель</em>' : p.connected ? '' : '<em>нет связи</em>'}</div>`)
          .join('')}</div>
        <p class="sc-about">${about}${buildsAbout} ${host ? 'Все собрались — жми «Старт».' : 'Старт даёт создатель комнаты.'}${room.state === 'race' ? (quali ? ' Идёт заезд.' : ' Идёт гонка.') : ''}</p>
        <div class="ol-row2">
          ${host ? '<button class="sc-row cta" data-act="start">Старт</button>' : ''}
          <button class="sc-row" data-act="leave">Выйти из комнаты</button>
        </div>
        <p class="ol-msg">${esc(msg)}</p>
        <footer class="sc-foot"><span><kbd>Esc</kbd>в главное меню (комната останется)</span></footer>
      </section>`
    }
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act],[data-set],[data-tyre]')
    if (!b) return
    if (b.dataset.tyre) {
      store.set(COMPOUND_KEY, b.dataset.tyre)
      sendProfile()
      render()
      return
    }
    if (b.dataset.set && room?.host === myId) {
      const v = b.dataset.v
      send({ t: 'set', [b.dataset.set]: b.dataset.set === 'laps' || b.dataset.set === 'minutes' ? Number(v) : v })
      return
    }
    act(b.dataset.act)
  })
  root.addEventListener('mouseover', (e) => {
    const c = e.target.closest('.sc-mode')
    if (!c || room) return
    const id = c.dataset.act.slice(7)
    if (id === pick) return
    pick = id
    for (const el of root.querySelectorAll('.sc-mode')) el.classList.toggle('on', el === c)
  })
  root.addEventListener('input', (e) => {
    if (e.target.dataset.k === 'name') {
      store.set(NAME_KEY, e.target.value.trim().slice(0, 16) || 'Игрок')
      sendProfile()
    }
  })
  root.addEventListener('keydown', (e) => {
    e.stopPropagation() // игровые клавиши не срабатывают, пока печатаешь имя или код
    if (e.code === 'Enter') act(e.target.dataset.k === 'code' ? 'join' : room ? 'start' : 'create-' + pick)
    if (e.code === 'Escape') act('back')
  })
  addEventListener('keydown', (e) => {
    if (root.hidden || e.target.closest?.('#online')) return
    if (e.code === 'Escape') act('back')
    // карточки режимов: ← → выбрать, Enter — создать комнату
    else if (!room && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
      pick = pick === 'quali' ? 'race' : 'quali'
      render()
    } else if (!room && e.code === 'Enter') act('create-' + pick)
    else if (room && e.code === 'Enter') act('start')
  })

  function act(a) {
    if (a === 'create-quali' || a === 'create-race') {
      pick = a.slice(7)
      if (!ws) return connect()
      sendProfile()
      send({ t: 'create', mode: pick, track: deps.trackId, laps: 5, level: 'medium', minutes: 10 })
    } else if (a === 'join') {
      sendProfile()
      const code = root.querySelector('[data-k=code]')?.value.trim().toUpperCase()
      if (!code || code.length !== 4) {
        msg = 'Код комнаты — 4 буквы'
        return render()
      }
      if (!ws) {
        wantJoin = code
        return connect()
      }
      send({ t: 'join', code })
    } else if (a === 'start') {
      if (room?.host === myId) send({ t: 'start' })
    } else if (a === 'leave') {
      send({ t: 'leave' })
      room = null
      render()
    } else if (a === 'copy') {
      navigator.clipboard?.writeText(root.querySelector('[data-act=copy]').textContent)
      msg = 'Ссылка скопирована'
      render()
    } else if (a === 'back') {
      root.hidden = true
      deps.openMain()
    }
  }

  // ---------- гонка ----------
  // чужая машина: картинка (копия болида) и «болид-пустышка» для car.sync, звука и мини-карты
  function makeRemote(r, i, ghost = false) {
    const c = deps.car.spawn(r.paint)
    // заезд на время: чужие болиды — призраки (полупрозрачные, свои материалы — у остальных болидов не трогаем)
    if (ghost)
      c.group.traverse((o) => {
        if (!o.isMesh) return
        const mats = [].concat(o.material).map((mt) => {
          const k = mt.clone()
          k.transparent = true
          k.opacity = GHOST_OPACITY
          k.depthWrite = false
          return k
        })
        o.material = Array.isArray(o.material) ? mats : mats[0]
        o.castShadow = false
      })
    deps.scene.add(c.group)
    const pose = { p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, v: { x: 0, y: 0, z: 0 } }
    const v = {
      body: { translation: () => pose.p, rotation: () => pose.q, linvel: () => pose.v },
      wheels: deps.vehicle.wheels.map((w) => ({ centerY: w.centerY, camberBody: w.camberBody, steer: 0, spin: 0 })),
      damage: { lost: [false, false, false, false], wingL: 0, wingR: 0, rearWing: 0 },
      aero: 0,
      state: { braking: false, rpm: 0.6, fwdSpeed: 0 },
    }
    return { index: i, id: r.id, name: r.name, paint: r.paint, car: c, v, pose, input: { throttle: 1 }, buf: [], gone: false, lastTick: 0, hidden: false }
  }

  function beginRace(m) {
    leaveRace()
    root.hidden = true
    const myIndex = m.roster.findIndex((r) => r.id === m.you)
    race = {
      code: m.code,
      laps: m.laps,
      roster: m.roster,
      myIndex,
      slot: m.slot,
      mode: m.mode === 'quali' ? 'quali' : 'race',
      minutes: m.minutes,
      resetReq: false, // R в заезде на время: вернуть на трассу (отправим с ближайшим окном ввода)
      remotes: m.roster.map((r, i) => (i === myIndex ? null : makeRemote(r, i, m.mode === 'quali'))).filter(Boolean),
      ownBuf: [], // своя машина по снапшотам — когда ведёт сервер (пит-стоп, сход)
      est: Infinity, // сдвиг часов: min(время приёма − серверное время)
      buf: BASE_BUF,
      lastFail: -1e9,
      seq: 0,
      pending: [], // окна ввода, ещё не подтверждённые сервером: { s, cmd }
      auto: false, // своей машиной сейчас правит сервер
      lights: -1,
      offset: new THREE.Vector3(),
      ended: false,
      corr: { n: 0, sum: 0, max: 0 },
      lastTick: 0,
      cap: -1, // м/с: потолок скорости под флагами (−1 — нет), с сервера — им же ограничиваем предсказание
      banner: null, // табло флагов: [текст, вид]
      orange: null, // чёрно-оранжевый флаг: текст
      removed: false, // эвакуатор увёз свою машину
      sc: null, // машина безопасности: { phase, s, l, v, t, armed, at }
      setupAt: 0,
    }
    lastTable = null
    deps.onStart({ code: m.code, mode: m.mode, minutes: m.minutes, laps: m.laps, slot: m.slot, roster: m.roster, compound: m.compound, builds: m.builds ?? 'own' })
    pingSent = 0
  }

  // снапшот машин (wire.js): { tick, lights, cars: [{ i, p, q, v, steer, f }], sc }
  function onSnap(m) {
    const now = performance.now()
    const t = m.tick * TICK_MS
    race.est = Math.min(race.est, now - t)
    race.lights = m.lights
    race.lastTick = m.tick
    race.sc = m.sc ? { ...m.sc, at: now } : null
    for (const c of m.cars) {
      const e = { t, p: c.p, q: c.q, v: c.v, steer: c.steer, f: c.f }
      if (c.i === race.myIndex) {
        race.ownBuf.push(e)
        prune(race.ownBuf, now - race.est - race.buf)
        continue
      }
      const r = race.remotes.find((x) => x.index === c.i)
      if (!r) continue
      r.lastTick = m.tick
      r.buf.push(e)
      prune(r.buf, now - race.est - race.buf)
    }
  }

  // откат своей машины к состоянию сервера и переигровка неподтверждённых окон ввода
  function reconcile(o) {
    const v = deps.vehicle
    const wasAuto = race.auto
    race.auto = !!o.auto
    if (race.auto) {
      // ведёт сервер (пит-стоп, сход, автопилот): свои окна не нужны, шины и повреждения — с сервера
      race.pending = []
      importVehicle(v, o.st)
      return
    }
    const b = v.body.translation()
    const before = [b.x, b.y, b.z]
    v.body.setTranslation({ x: o.p[0], y: o.p[1], z: o.p[2] }, true)
    v.body.setRotation({ x: o.q[0], y: o.q[1], z: o.q[2], w: o.q[3] }, true)
    v.body.setLinvel({ x: o.v[0], y: o.v[1], z: o.v[2] }, true)
    v.body.setAngvel({ x: o.w[0], y: o.w[1], z: o.w[2] }, true)
    importVehicle(v, o.st)
    race.pending = race.pending.filter((x) => x.s > o.a)
    for (const x of race.pending)
      for (let k = 0; k < 4; k++) {
        stepVehicle(v, x.cmd, STEP, deps.track.surfaceAt)
        deps.world.step()
      }
    const a = v.body.translation()
    if (wasAuto) return // машину только что отдали игроку — без хвоста поправки
    race.offset.x += before[0] - a.x
    race.offset.y += before[1] - a.y
    race.offset.z += before[2] - a.z
    const d = Math.hypot(before[0] - a.x, before[1] - a.y, before[2] - a.z)
    race.corr.n++
    race.corr.sum += d
    race.corr.max = Math.max(race.corr.max, d)
    // большая поправка (удар, возврат на трассу сервером) — сразу, без «резинки»
    if (race.offset.length() > 3) race.offset.set(0, 0, 0)
  }

  // окно ввода (каждые 4 шага, 60 Гц): отправить на сервер и вернуть команду для своей физики (null — ведёт сервер)
  function windowInput(raw, pit) {
    if (!race || race.ended) return null
    race.seq++
    const m = { t: 'in', s: race.seq, th: raw.throttle, br: raw.brake, st: raw.steer, abs: raw.abs, aero: raw.aero, bo: raw.boost, ers: raw.ersMode, pit: pit.request ? 1 : 0, rs: race.resetReq ? 1 : 0 }
    race.resetReq = false
    if (pit.request) {
      m.pc = pit.plan.compound
      m.pw = pit.plan.wing ? 1 : 0
    }
    send(m)
    if (race.auto) return null
    const cmd = cleanInput(raw)
    cmd.aeroZone = raw.aeroZone
    // огни старта горят — педали не работают (как start.hold на сервере)
    if (race.lights >= 0) {
      cmd.throttle = 0
      cmd.brake = 0
      cmd.boost = false
    } else if (race.cap >= 0) capInput(cmd, deps.vehicle.state.fwdSpeed, race.cap) // под флагами — как сервер
    race.pending.push({ s: race.seq, cmd })
    if (race.pending.length > 120) race.pending.shift()
    return cmd
  }

  // раз в кадр: чужие машины на экране, своя — если ей правит сервер; буфер растёт при сбоях
  function update(now, dt) {
    drawQuali(now)
    if (!race) return
    if (now - pingSent > 2000) {
      pingSent = now
      send({ t: 'ping', c: now })
    }
    // настройку поменяли по ходу (баланс тормозов, дифференциал, гараж из паузы) — сервер должен считать так же, иначе откаты
    if (now - race.setupAt > 500) {
      race.setupAt = now
      const cur = JSON.stringify(deps.setup?.() ?? null)
      if (cur !== sentSetup) {
        sentSetup = cur
        send({ t: 'setup', setup: deps.setup?.() })
      }
    }
    const rt = now - race.est - race.buf
    let failed = false
    for (const r of race.remotes) {
      // увёз эвакуатор (у себя — r.hidden) или сервер его больше не присылает — болида нет
      if (r.hidden || (race.lastTick && r.lastTick < race.lastTick)) {
        r.car.group.visible = false
        r.gone = true
        continue
      }
      const s = sampleCar(r.buf, rt)
      if (!s) {
        r.car.group.visible = false
        continue
      }
      r.car.group.visible = true
      if (s.extrap) failed = true
      const lastE = r.buf[r.buf.length - 1]
      r.pose.p = { x: s.p[0], y: s.p[1], z: s.p[2] }
      r.pose.q = { x: s.q[0], y: s.q[1], z: s.q[2], w: s.q[3] }
      r.pose.v = { x: lastE.v[0], y: lastE.v[1], z: lastE.v[2] }
      const speed = Math.hypot(lastE.v[0], lastE.v[2])
      const f = lastE.f
      r.v.state.braking = !!(f & 1)
      r.v.state.fwdSpeed = speed
      r.v.state.rpm = Math.min(1, 0.45 + speed / 95)
      r.input.throttle = f & 1 ? 0.1 : 1
      r.v.aero = f & 2 ? 1 : 0
      r.v.damage.wingL = r.v.damage.wingR = f & 4 ? 1 : 0
      r.v.damage.rearWing = f & 8 ? 1 : 0
      for (let i = 0; i < 4; i++) {
        const w = r.v.wheels[i]
        r.v.damage.lost[i] = !!(f & (16 << i))
        if (i < 2) w.steer = lastE.steer
        w.spin = (w.spin + (speed * dt) / WHEEL_R) % (Math.PI * 2)
      }
      r.car.snapshot(r.v.body)
      r.car.snapshot(r.v.body)
      r.car.sync(1, r.v, r.input)
    }
    // буфер: +60 мс при сбое, −10 мс/с после 3 с без сбоев; не ниже BASE_BUF и не выше 300
    if (failed && now - race.lastFail > 300) {
      race.lastFail = now
      race.buf = Math.min(300, race.buf + 60)
    } else if (!failed && now - race.lastFail > 3000 && race.buf > BASE_BUF) race.buf = Math.max(BASE_BUF, race.buf - 10 * dt)
    // машина безопасности: фаза и место с сервера, между снапшотами — едет сама со своей скоростью
    const sc = deps.sc
    if (sc) {
      const st = race.sc
      if (!st || st.phase === 'off') {
        if (sc.active) sc.hide()
      } else {
        if (!sc.active) sc.deploy(null)
        const ahead = (now - st.at) / 1000
        Object.assign(sc.state, { phase: st.phase, l: st.l, v: st.v, t: st.t + ahead, armed: st.armed, s: (st.s + st.v * ahead) % deps.track.length })
        sc.update(0, null, false)
      }
    }
    // своей машиной правит сервер: ставим её туда, где она по снапшотам
    if (race.auto) {
      const s = sampleCar(race.ownBuf, rt + race.buf * 0.5)
      if (s) {
        const v = deps.vehicle
        const e = race.ownBuf[race.ownBuf.length - 1]
        v.body.setTranslation({ x: s.p[0], y: s.p[1], z: s.p[2] }, true)
        v.body.setRotation({ x: s.q[0], y: s.q[1], z: s.q[2], w: s.q[3] }, true)
        v.body.setLinvel({ x: e.v[0], y: e.v[1], z: e.v[2] }, true)
        deps.car.snapshot(v.body)
        deps.car.snapshot(v.body)
      }
    }
  }

  // после car.sync своей машины: хвост поправки гаснет за ~0,1 с
  function afterSync(dt) {
    if (!race) return
    const k = Math.exp(-dt * OFFSET_DECAY)
    race.offset.multiplyScalar(k)
    if (race.offset.lengthSq() > 1e-8) deps.car.group.position.add(race.offset)
  }

  // таблица с сервера → объект как race.state (HUD тот же)
  function stateOf(table) {
    if (!race || !table || table.mode === 'quali') return null
    const cars = race.roster.map((r, i) => {
      const c = table.cars.find((x) => x[0] === i) || []
      return { id: r.id, name: r.name, paint: r.paint, player: i === race.myIndex, lap: c[1] ?? 0, gap: c[2] ?? 0, finished: !!c[3], finishTime: c[4] ?? 0, penalty: c[5] ?? 0, dnf: !!c[6], dsq: !!c[7], reason: c[8] || '', inPit: !!c[9], compound: c[10] || null, stops: c[11] ?? 0 }
    })
    return { laps: table.laps, running: table.run, cars, order: table.order.map((i) => cars[i]).filter(Boolean) }
  }

  function endRace(table) {
    race.ended = true
    qClock.hidden = true
    qBoard.hidden = true
    if (table.mode === 'quali') {
      // итог заезда на время: по лучшему кругу; без круга — в конце
      const rows = table.rows.map((r) => ({ name: race.roster[r[0]]?.name ?? '', paint: race.roster[r[0]]?.paint ?? '#888', time: r[1] >= 0 ? r[1] : Infinity, player: r[0] === race.myIndex }))
      deps.showQualiResults(rows, `Онлайн · заезд на время · ${table.minutes} мин`)
    } else deps.showResults(stateOf(table))
  }

  // табло заезда на время: сколько осталось и лучшие круги всех (2 раза в секунду с сервера, часы — плавно)
  function drawQuali(now) {
    const t = lastTable
    if (!race || race.mode !== 'quali' || race.ended || !t || t.mode !== 'quali') {
      qClock.hidden = qBoard.hidden = true
      return
    }
    qClock.hidden = qBoard.hidden = false
    const left = t.started ? Math.max(0, t.left - (now - (t.at ?? now)) / 1000) : t.minutes * 60
    const mm = Math.floor(left / 60)
    const ss = Math.floor(left % 60)
    qClock.innerHTML = t.over ? '<small>Время вышло</small><b style="font-size:22px">Доезжаем последний круг</b>' : `<small>До конца сессии</small><b>${mm}:${String(ss).padStart(2, '0')}</b>`
    if (now - (qBoard.drawn ?? 0) < 250) return
    qBoard.drawn = now
    const fastest = t.rows.find((r) => r[1] >= 0)?.[1]
    qBoard.innerHTML = `<h4>Лучшие круги</h4><ol>${t.rows
      .map((r, k) => {
        const who = race.roster[r[0]] ?? {}
        const time = r[1] >= 0 ? formatTime(r[1]) : '—'
        return `<li class="${r[0] === race.myIndex ? 'me' : ''}" style="--c:${esc(who.paint)}"><span>${k + 1}</span><i></i><span>${esc(who.name)}</span><span class="t${r[1] >= 0 && r[1] === fastest ? ' best' : ''}">${time}</span></li>`
      })
      .join('')}</ol>`
  }

  // убрать гонку с экрана (комната остаётся)
  function leaveRace() {
    qClock.hidden = true
    qBoard.hidden = true
    if (!race) return
    for (const r of race.remotes) deps.scene.remove(r.car.group)
    race = null
  }

  return {
    get active() {
      return !!race && !race.ended
    },
    get inRace() {
      return !!race
    },
    get auto() {
      return !!race?.auto
    },
    // режим идущей онлайн-сессии: 'race' или 'quali' (заезд на время)
    get mode() {
      return race?.mode ?? null
    },
    // R в заезде на время: попросить сервер вернуть болид на трассу (круг не в зачёт)
    requestReset() {
      if (race?.mode === 'quali') race.resetReq = true
    },
    get rtt() {
      return rtt
    },
    get corrections() {
      return race?.corr
    },
    open() {
      root.hidden = false
      connect()
      sendProfile() // сборку или настройку могли поменять в гараже, пока онлайн был закрыт
      render()
    },
    isOpen: () => !root.hidden,
    windowInput,
    update,
    afterSync,
    raceState: () => stateOf(lastTable),
    banner: () => (race ? race.banner : null),
    orange: () => (race ? race.orange : null),
    get removed() {
      return !!race?.removed
    },
    get myId() {
      return race ? race.roster[race.myIndex]?.id : null
    },
    // имя болида по id (для сообщений о флагах)
    nameOf: (id) => race?.roster.find((r) => r.id === id)?.name ?? id,
    // картинка чужого болида по id (эвакуатор цепляет её краном)
    groupOf: (id) => race?.remotes.find((r) => r.id === id)?.car.group ?? null,
    // эвакуатор увёз — больше не показывать
    hideCar(id) {
      const r = race?.remotes.find((x) => x.id === id)
      if (r) {
        r.hidden = true
        r.car.group.visible = false
      }
    },
    lights: () => (race ? race.lights : -1),
    remotes: () => race?.remotes ?? [],
    remoteGroups: () => (race?.remotes ?? []).map((r) => r.car.group),
    // итоги: «Ещё раз» — назад в комнату (создатель снова даёт старт), «В меню» — выйти из комнаты
    results(act) {
      leaveRace()
      if (act === 'again') {
        root.hidden = false
        render()
      } else {
        send({ t: 'leave' })
        room = null
        deps.onExit()
      }
    },
    // уйти из гонки в главное меню (болид доедет на автопилоте)
    quit() {
      leaveRace()
      send({ t: 'leave' })
      room = null
    },
  }
}
