// Экраны вне гонки (Рома 29.10: «полноценная игра, как в настоящих играх»): главное меню, гараж (команда и цвета болида),
// настройка гонки перед стартом, настройки, рекорды, управление. Сзади живая витрина — тот же болид на трассе, камера кружит вокруг.
// Стиль — телевизионная графика F1, как у остального интерфейса: угольный фон, белый, красный, скошенные углы, курсив.
//
// Клавиши: ↑ ↓ — пункт, ← → — значение, Enter — выбрать, Esc — назад, Q E — вкладки настроек. Мышь работает везде.
// Модуль ничего не знает про физику: всё, что делает игру, приходит из main.js через ctx (см. createScreens).
import { settings, QUALITY, DEFAULTS, ENGINE_SOUNDS } from './settings.js'
import { TEAMS, BODY_SWATCHES, ZONE_SWATCHES, teamById } from './teams.js'
import { KEYS } from './menu.js'
import { COMPOUNDS, COMPOUND_ORDER } from './wear.js'
import { AI_LEVELS } from './ai.js'
import { formatTime } from './laps.js'
import { WEATHERS, WEATHER_ORDER } from './weather.js'

const SESSION_KEY = 'f1-race.session.v1'
const LAP_OPTIONS = [1, 3, 5, 10, 15, 20]
const SLOTS = [
  { v: -1, name: 'Квалификация' },
  { v: 0, name: 'Поул' },
  { v: 5, name: 'Шестое' },
  { v: 11, name: 'Последнее' },
]
const MODE_NAME = { race: 'Гонка', time: 'Заезд на время' }
const FLOW = ['track', 'race', 'weather', 'start'] // экраны-шаги настройки заезда
const CAMERA_NAMES = { chase: 'Сзади', onboard: 'Из кабины', tcam: 'T-камера', nose: 'Нос болида' }
const FPS_OPTIONS = [
  { v: 30, name: '30' },
  { v: 60, name: '60' },
  { v: 120, name: '120' },
  { v: 0, name: 'Без лимита' },
]

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const pct = (x) => `${Math.round(x * 100)}%`

// Настройка заезда — по шагам, как в F1 25, Gran Turismo 7, Forza (Рома 30.10: «слишком много настроек на одном экране»):
// гонка — Трасса → Гонка (соперники, круги, старт) → Условия (погода; потом — время суток) → Болид (шины на старт и настройка
// болида — Рома 30.10: «шины относим к настройке болида, погоду отдельно, потом туда добавим ночь, день»);
// заезд на время — Трасса → Условия → Болид.
// Режим выбирается в главном меню, ABS — в «Настройки → Помощники» (и B в гонке). Esc — шаг назад.
//
// ctx: {
//   canRace — есть ли трасса с решёткой (на тестовой гонки нет), trackLabel — «MARINA BAY · 4 940 м»,
//   tracks — [{ id, name, kind, km, about }] трассы на выбор, trackId — текущая, setTrack(id) — сменить (перезагрузка страницы),
//   abs — { get, set } помощник ABS,
//   session — { mode, level, laps, compound, slot, abs } начальные значения (из прошлого запуска),
//   info() → { bestLap, bestSectors, pu: { ice, ers, gearbox }, career: { races, wins, podiums, dnf }, livery },
//   previewCompound(id) — показать шины состава на витрине; showcase(on, shift) — включить витрину; previewLivery(l) — показать ливрею на болиде и сохранить;
//   startSession(opts), openSetup(), newPowerUnit(), onClose() — экраны закрылись (стек пуст)
// }
export function createScreens(ctx) {
  const root = document.getElementById('screens')
  let stack = []
  let sel = {} // выбранный пункт по экрану
  let tab = 0 // вкладка настроек
  let session = { mode: ctx.canRace ? 'race' : 'time', level: 'medium', laps: 5, compound: 'medium', slot: 11, weather: 'dry', time: 'day', ...ctx.session }
  try {
    Object.assign(session, JSON.parse(localStorage.getItem(SESSION_KEY) || '{}'))
  } catch {
    // нет хранилища — значения по умолчанию
  }
  if (!ctx.canRace) session.mode = 'time'
  const saveSession = () => {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    } catch {
      // не запомнили — в этой сессии значения останутся
    }
  }

  // ---------- строки-параметры (гонка и настройки): один формат на оба экрана ----------
  const choice = (id, label, options, get, set, extra = {}) => ({ type: 'choice', id, label, options, get, set, ...extra })
  const slider = (id, label, min, max, step, get, set, extra = {}) => ({ type: 'slider', id, label, min, max, step, get, set, ...extra })
  const toggle = (id, label, get, set, extra = {}) => ({ type: 'choice', id, label, options: [{ v: false, name: 'Выкл' }, { v: true, name: 'Вкл' }], get, set, ...extra })
  const action = (id, label, run, extra = {}) => ({ type: 'action', id, label, run, ...extra })

  // шаги настройки заезда
  const flowSteps = () => (session.mode === 'race' ? [['track', 'Трасса'], ['race', 'Гонка'], ['weather', 'Условия'], ['start', 'Болид']] : [['track', 'Трасса'], ['weather', 'Условия'], ['start', 'Болид']])
  const nextStep = (name) => {
    const steps = flowSteps()
    const k = steps.findIndex(([id]) => id === name)
    return steps[k + 1]?.[0]
  }
  let pendingTrack = ctx.trackId // трасса, выбранная на шаге «Трасса»; другая загрузится по «Далее»
  const trackOf = (id) => ctx.tracks?.find((t) => t.id === id)

  const trackRows = () => [
    choice('track', 'Трасса', (ctx.tracks || []).map((t) => ({ v: t.id, name: t.name, kind: t.kind, km: t.km })), () => pendingTrack, (v) => (pendingTrack = v), {
      cards: true,
      hint: () => `${trackOf(pendingTrack)?.about ?? ''}${pendingTrack !== ctx.trackId ? ' Другая трасса загрузится по «Далее» (пару секунд).' : ''}`,
    }),
    action('next', 'Далее', () => {
      if (pendingTrack && pendingTrack !== ctx.trackId) {
        saveSession()
        ctx.setTrack(pendingTrack)
        return
      }
      push(nextStep('track'))
    }, { cta: true, hint: () => (session.mode === 'race' ? 'Дальше — соперники, круги и старт.' : 'Дальше — погода.') }),
  ]

  const raceRows = () => [
    choice('level', 'Соперники', ['light', 'medium', 'hard'].map((v) => ({ v, name: AI_LEVELS[v].name })), () => session.level, (v) => (session.level = v), {
      hint: () => ({ light: 'Едут спокойно и далеко от предела: хороши, чтобы выучить трассу и пит-стопы.', medium: 'Едут уверенно, закрываются на прямой, когда атакуешь.', hard: 'Едут по гоночной линии на пределе сцепления, закрываются и тратят батарею на обгоны.' })[session.level],
    }),
    choice('laps', 'Круги', LAP_OPTIONS.map((v) => ({ v, name: String(v) })), () => session.laps, (v) => (session.laps = v), {
      hint: () => (session.laps < 5 ? 'Короткая гонка: менять шины не обязательно (правило двух составов — с 5 кругов, как в спринте F1 его тоже нет).' : session.laps >= 10 ? 'Длинная гонка: шины и мотор изнашиваются, без пит-стопов не обойтись.' : 'Классическая дистанция: один-два пит-стопа.'),
    }),
    choice('slot', 'Старт', SLOTS.map((s) => ({ v: s.v, name: s.name })), () => session.slot, (v) => (session.slot = v), {
      hint: () => (session.slot === -1 ? 'Сначала квалификация: ты один на трассе, разгонный круг и два быстрых, в зачёт лучший. Решётку строит время — как в F1.' : 'С поула впереди пусто, с последнего места — весь круг обгонов.'),
    }),
    action('next', 'Далее', () => push(nextStep('race')), { cta: true, hint: () => 'Дальше — погода.' }),
  ]

  // условия: погода и время суток (на витрине сразу видно, как выглядит выбранное)
  const weatherRows = () => [
    choice('weather', 'Погода', WEATHER_ORDER.map((v) => ({ v, name: WEATHERS[v].name })), () => session.weather, (v) => (session.weather = v), { hint: () => WEATHERS[session.weather].about }),
    choice('time', 'Время суток', [{ v: 'day', name: 'День' }, { v: 'night', name: 'Ночь' }], () => session.time, (v) => {
      session.time = v
      ctx.previewTime?.(v)
    }, { hint: () => (session.time === 'night' ? 'Ночь: темно, луна и звёзды, свет тусклее и туман гуще.' : 'Днём — солнце, как было всегда.') }),
    action('next', 'Далее', () => push(nextStep('weather')), { cta: true, hint: () => 'Дальше — болид: шины на старт и настройка.' }),
  ]

  const startRows = () => [
    choice('compound', 'Шины на старт', COMPOUND_ORDER.map((v) => ({ v, name: COMPOUNDS[v].name })), () => session.compound, (v) => {
      session.compound = v
      ctx.previewCompound?.(v) // на витрине сразу видно шины выбранного состава
    }, {
      hint: () => ({ soft: 'Мягкие: быстрее всех, но живут около трёх кругов.', medium: 'Средние: золотая середина, около шести кругов.', hard: 'Твёрдые: медленнее, зато около десяти кругов.', intermediate: 'Промежуточные (зелёные): для влажной трассы. На сухой перегреваются и сгорают за пару кругов.', wet: 'Дождевые (синие): для ливня, вода уходит из-под протектора. На подсохшей трассе медленные и горят.' })[session.compound] + (session.mode === 'race' ? (session.laps >= 5 ? ' В гонке от 5 кругов обязательны два разных состава (в дождь — нет): без пит-стопа — дисквалификация.' : ' В гонке короче 5 кругов менять шины не обязательно.') : ''),
    }),
    action('setup', 'Настройка болида', () => ctx.openSetup(), { hint: () => 'Крылья, подвеска, тормоза, давление шин — готовые настройки и свои. Закроешь — вернёшься сюда.' }),
    action('go', session.mode === 'race' ? 'На старт' : 'Выехать на трассу', () => {
      saveSession()
      hide()
      ctx.startSession({ ...session })
    }, { cta: true, hint: () => (session.mode === 'race' ? 'Огни старта загорятся сразу. Esc в гонке — пауза.' : 'Esc на трассе — пауза.') }),
  ]

  const settingsTabs = () => [
    {
      name: 'Графика',
      rows: [
        choice('quality', 'Качество', Object.entries(QUALITY).map(([v, q]) => ({ v, name: q.name })), () => settings.get('quality'), (v) => settings.set('quality', v), { hint: () => QUALITY[settings.get('quality')].about }),
        choice('fps', 'Лимит кадров', FPS_OPTIONS, () => settings.get('fps'), (v) => settings.set('fps', v), { hint: () => 'Больше кадров — плавнее, но видеокарта работает сильнее. 60 хватает почти всегда; на экранах 120 Гц без лимита нагрузка вдвое выше.' }),
      ],
    },
    {
      name: 'Звук',
      rows: [
        slider('volume', 'Громкость', 0, 100, 5, () => settings.get('volume'), (v) => settings.set('volume', v), { fmt: (v) => `${v}%`, hint: () => 'Общая громкость мотора и шума гравия. В гонке звук выключает клавиша M.' }),
        choice('engineSound', 'Мотор', Object.entries(ENGINE_SOUNDS).map(([v, e]) => ({ v, name: e.name })), () => settings.get('engineSound'), (v) => settings.set('engineSound', v), { hint: () => ENGINE_SOUNDS[settings.get('engineSound')].about + ' Меняется сразу — можно слушать прямо в гонке из паузы.' }),
      ],
    },
    {
      name: 'Помощники',
      rows: [
        toggle('abs', 'ABS', () => !!ctx.abs?.get(), (v) => ctx.abs?.set(v), { hint: () => 'Не даёт заблокировать колёса на торможении: тормозить можно в пол. В гонке включается и выключается клавишей B.' }),
      ],
    },
    {
      name: 'Мышь',
      rows: [
        slider('mouse', 'Чувствительность обзора', 25, 200, 5, () => settings.get('mouse'), (v) => settings.set('mouse', v), { fmt: (v) => `${v}%`, hint: () => 'Как быстро камера крутится, когда зажимаешь кнопку мыши и тянешь.' }),
        toggle('invertY', 'Обратная вертикаль', () => settings.get('invertY'), (v) => settings.set('invertY', v), { hint: () => 'Тянешь мышь вниз — камера смотрит вниз (вместо подъёма вверх).' }),
      ],
    },
    {
      name: 'Камера',
      rows: [
        choice('camera', 'Камера на старте', Object.entries(CAMERA_NAMES).map(([v, name]) => ({ v, name })), () => settings.get('camera'), (v) => settings.set('camera', v), { hint: () => 'С какого вида начинаешь гонку. В гонке C переключает камеры по кругу.' }),
        slider('fov', 'Поле зрения', 80, 120, 5, () => settings.get('fov'), (v) => settings.set('fov', v), { fmt: (v) => `${v}%`, hint: () => 'Шире — больше скорости на экране, но края картинки растягиваются.' }),
        slider('shake', 'Тряска камеры', 0, 150, 10, () => settings.get('shake'), (v) => settings.set('shake', v), { fmt: (v) => `${v}%`, hint: () => 'Гравий, днище по асфальту, удары. 0% — камера не трясётся совсем.' }),
      ],
    },
    {
      name: 'Интерфейс',
      rows: [
        slider('hud', 'Размер интерфейса', 60, 110, 2, () => settings.get('hud'), (v) => settings.set('hud', v), { fmt: (v) => `${v}%`, hint: () => 'Время круга, таблица, табло внизу. Уменьши, если закрывают дорогу.' }),
        choice('units', 'Скорость', [{ v: 'kmh', name: 'км/ч' }, { v: 'mph', name: 'миль/ч' }], () => settings.get('units'), (v) => settings.set('units', v), { hint: () => 'Единицы на табло. Телеметрия остаётся в км/ч.' }),
        toggle('minimap', 'Мини-карта', () => settings.get('minimap'), (v) => settings.set('minimap', v), { hint: () => 'Контур трассы справа вверху с точками болидов.' }),
        toggle('ghost', 'Призрак лучшего круга', () => settings.get('ghost'), (v) => settings.set('ghost', v), { hint: () => 'В заезде на время и квалификации полупрозрачный болид едет по твоему рекорду: видно, где теряешь.' }),
        action('reset', 'Сбросить все настройки', () => settings.reset(), { hint: () => 'Вернуть всё в первоначальный вид. Ливрея болида и настройки гонки не меняются.' }),
      ],
    },
    // клавиши (был отдельный пункт главного меню «Управление», Рома 30.10 — сюда)
    { name: 'Управление', rows: [], keys: true },
  ]

  // ---------- главное меню ----------
  // Рома 30.10: на главном только пять пунктов; режимы — карточками в «Играть», «Управление» — вкладка «Настроек»
  const mainItems = () => [
    { id: 'play', label: 'Играть', about: 'Заезд на время, гонка с ботами или онлайн с друзьями.', go: () => push('play') },
    { id: 'garage', label: 'Гараж', about: 'Команда и цвета болида, состояние силовой установки.', go: () => push('garage') },
    { id: 'setup', label: 'Настройка болида', about: 'Крылья, подвеска, тормоза, шины: готовые настройки и свои.', go: () => ctx.openSetup() },
    { id: 'records', label: 'Рекорды', about: 'Лучший круг, лучшие секторы и твоя статистика гонок.', go: () => push('records') },
    { id: 'settings', label: 'Настройки', about: 'Графика, звук, мышь, камеры, интерфейс и клавиши управления. Всё действует сразу.', go: () => push('settings') },
  ]

  // «Играть»: режимы карточками
  const playItems = () =>
    [
      { id: 'time', kick: 'Один', label: 'Заезд на время', about: 'Один на трассе: лучший круг, секторы, призрак своего рекорда.', go: () => openFlowFor('time') },
      ctx.canRace && { id: 'race', kick: 'С ботами', label: 'Гонка', about: 'Двенадцать болидов, огни старта, пит-стопы, флаги и машина безопасности.', go: () => openFlowFor('race') },
      ctx.openOnline && { id: 'online', kick: 'С друзьями', label: 'Онлайн', about: 'Комната по коду, до 12 игроков: заезд на время с призраками или гонка.', go: () => ctx.openOnline() },
    ].filter(Boolean)

  // ---------- вёрстка экранов ----------
  const brand = (title, kicker) => `
    <header class="sc-brand">
      <span class="sc-tag">${esc(kicker)}</span>
      <h1 class="sc-title">${title}</h1>
    </header>`
  const hintBar = (items) => `<footer class="sc-foot">${items.map(([k, t]) => `<span><kbd>${k}</kbd>${t}</span>`).join('')}</footer>`

  function renderMain() {
    const items = mainItems()
    const i = Math.min(sel.main ?? 0, items.length - 1)
    const info = ctx.info()
    return `
      <section class="sc-col main">
        <header class="sc-brand big">
          <span class="sc-tag">Гран-при</span>
          <h1 class="sc-title">F1<br>Race</h1>
          <p class="sc-sub">${esc(ctx.trackLabel)}${info.bestLap != null ? ` · лучший круг <b>${formatTime(info.bestLap)}</b>` : ''}</p>
        </header>
        <nav class="sc-nav">${items.map((it, k) => `<button class="sc-item${k === i ? ' on' : ''}" data-i="${k}"><span>${it.label}</span></button>`).join('')}</nav>
        <p class="sc-about">${items[i].about}</p>
        ${hintBar([['↑ ↓', 'выбрать'], ['Enter', 'открыть'], ['Мышь', 'крутить болид']])}
      </section>`
  }

  // универсальный экран со строками-параметрами
  function renderRows(id, title, kicker, rows, extra = '', foot = []) {
    const vis = rows.filter((r) => !r.hidden?.())
    const i = Math.min(sel[id] ?? 0, vis.length - 1)
    sel[id] = i
    const row = vis[i]
    const html = vis
      .map((r, k) => {
        const cls = `sc-row${k === i ? ' on' : ''}${r.cta ? ' cta' : ''}`
        if (r.type === 'action') return `<button class="${cls}" data-i="${k}"><span class="sc-label">${r.label}</span></button>`
        if (r.cards) {
          // выбор карточками (трасса): название крупно, под ним вид и длина
          const cur = r.get()
          return `<div class="${cls} sc-cardrow" data-i="${k}"><div class="sc-pick">${r.options
            .map((o, n) => `<button data-i="${k}" data-o="${n}" class="sc-pickcard${o.v === cur ? ' on' : ''}"><b>${esc(o.name)}</b><span>${esc(o.kind ?? '')}${o.km ? ` · ${esc(o.km)}` : ''}</span></button>`)
            .join('')}</div></div>`
        }
        if (r.type === 'slider') {
          const v = r.get()
          return `<div class="${cls}" data-i="${k}"><span class="sc-label">${r.label}</span><span class="sc-ctl"><input type="range" tabindex="-1" min="${r.min}" max="${r.max}" step="${r.step}" value="${v}" data-slider="${k}"><output>${r.fmt(v)}</output></span></div>`
        }
        const cur = r.get()
        return `<div class="${cls}" data-i="${k}"><span class="sc-label">${r.label}</span><span class="sc-ctl sc-seg">${r.options
          .map((o, n) => `<button data-i="${k}" data-o="${n}" class="${o.v === cur ? 'on' : ''}">${esc(o.name)}</button>`)
          .join('')}</span></div>`
      })
      .join('')
    return `
      <section class="sc-col">
        ${brand(title, kicker)}
        ${extra}
        <div class="sc-rows">${html}</div>
        <p class="sc-about">${row?.hint?.() ?? ''}</p>
        ${hintBar(foot.length ? foot : [['↑ ↓', 'пункт'], ['← →', 'значение'], ['Esc', 'назад']])}
      </section>`
  }

  // шаги наверху экрана настройки заезда: пройденные — кликаются (назад), текущий подсвечен
  function stepsBar(name) {
    const steps = flowSteps()
    const k = steps.findIndex(([id]) => id === name)
    return `<nav class="sc-tabs sc-steps">${steps
      .map(([id, label], n) => `<button ${n < k ? `data-step="${id}"` : 'disabled'} class="${n === k ? 'on' : n < k ? 'done' : ''}">${n + 1}&nbsp;&nbsp;${label}</button>`)
      .join('')}</nav>`
  }
  const flowTitle = () => (session.mode === 'race' ? 'Гонка' : 'Заезд<br>на время')
  const flowFoot = (enter) => [['↑ ↓', 'пункт'], ['← →', 'значение'], ['Enter', enter], ['Esc', 'назад']]

  function renderTrack() {
    return renderRows('track', flowTitle(), 'Перед стартом', trackRows(), stepsBar('track'), flowFoot('далее'))
  }
  function renderRaceFormat() {
    return renderRows('race', flowTitle(), 'Перед стартом', raceRows(), stepsBar('race'), flowFoot('далее'))
  }
  function renderWeather() {
    return renderRows('weather', flowTitle(), 'Перед стартом', weatherRows(), stepsBar('weather'), flowFoot('далее'))
  }
  function renderStart() {
    const bits = [trackOf(ctx.trackId)?.name ?? ctx.trackLabel, MODE_NAME[session.mode]]
    if (session.mode === 'race') bits.push(`${session.laps} кр.`, AI_LEVELS[session.level].name.toLowerCase(), SLOTS.find((s) => s.v === session.slot)?.name.toLowerCase() ?? '')
    bits.push(WEATHERS[session.weather].name.toLowerCase(), `шины: ${COMPOUNDS[session.compound].name.toLowerCase()}`)
    const html = renderRows('start', flowTitle(), 'Перед стартом', startRows(), stepsBar('start'), flowFoot(session.mode === 'race' ? 'на старт' : 'выехать'))
    return html + `<aside class="sc-plaque"><div class="sc-plaque-t">Твой заезд</div><p>${bits.join(' · ')}</p></aside>`
  }

  function renderSettings() {
    const tabs = settingsTabs()
    tab = Math.min(tab, tabs.length - 1)
    const bar = `<nav class="sc-tabs">${tabs.map((t, k) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${t.name}</button>`).join('')}</nav>`
    if (tabs[tab].keys)
      return `
      <section class="sc-col wide">
        ${brand('Настройки', 'Параметры')}
        ${bar}
        ${keysGrid()}
        ${hintBar([['Q E', 'вкладка'], ['Esc', 'назад']])}
      </section>`
    return renderRows('settings' + tab, 'Настройки', 'Параметры', tabs[tab].rows, bar, [['Q E', 'вкладка'], ['↑ ↓', 'пункт'], ['← →', 'значение'], ['Esc', 'назад']])
  }

  // «Играть»: три карточки режимов в ряд (← → или ↑ ↓ — выбор, Enter — дальше)
  function renderPlay() {
    const items = playItems()
    const i = Math.min(sel.play ?? 0, items.length - 1)
    sel.play = i
    return `
      <section class="sc-col wide">
        ${brand('Выбери режим', 'Играть')}
        <div class="sc-modes">${items
          .map((it, k) => `<button class="sc-mode${k === i ? ' on' : ''}" data-i="${k}"><span class="sc-mode-k">${esc(it.kick)}</span><b>${esc(it.label)}</b><span class="sc-mode-t">${esc(it.about)}</span><span class="sc-mode-go">Выбрать</span></button>`)
          .join('')}</div>
        ${hintBar([['← →', 'режим'], ['Enter', 'дальше'], ['Esc', 'назад']])}
      </section>`
  }

  // гараж: команды списком, свои цвета, силовая установка
  const garageRows = () => {
    const l = ctx.info().livery
    return [
      ...TEAMS.map((t) => ({ type: 'team', id: t.id, team: t })),
      { type: 'swatch', id: 'body', label: 'Кузов', swatches: BODY_SWATCHES, key: 'primary', value: l.primary },
      { type: 'swatch', id: 'zone', label: 'Зона у кокпита', swatches: ZONE_SWATCHES, key: 'secondary', value: l.secondary },
      { type: 'action', id: 'pu', label: 'Новая силовая установка', run: () => ctx.newPowerUnit() },
    ]
  }
  function renderGarage() {
    const info = ctx.info()
    const l = info.livery
    const rows = garageRows()
    const i = Math.min(sel.garage ?? 0, rows.length - 1)
    sel.garage = i
    const html = rows
      .map((r, k) => {
        const on = k === i ? ' on' : ''
        if (r.type === 'team') return `<button class="sc-team${on}${l.team === r.id ? ' cur' : ''}" data-i="${k}"><i style="--a:${r.team.primary};--b:${r.team.secondary}"></i><span>${esc(r.team.name)}</span></button>`
        if (r.type === 'swatch') {
          const custom = !r.swatches.some((c) => c.toLowerCase() === r.value.toLowerCase())
          return `<div class="sc-row sc-sw${on}" data-i="${k}"><span class="sc-label">${r.label}</span><span class="sc-ctl">${r.swatches
            .map((c) => `<button data-i="${k}" data-c="${c}" class="sc-chip${c.toLowerCase() === r.value.toLowerCase() ? ' on' : ''}" style="--c:${c}" title="${c}"></button>`)
            .join('')}<label class="sc-chip pick${custom ? ' on' : ''}" style="--c:${r.value}" title="Свой цвет"><input type="color" tabindex="-1" value="${r.value}" data-pick="${k}"></label></span></div>`
        }
        return `<button class="sc-row${on}" data-i="${k}"><span class="sc-label">${r.label}</span></button>`
      })
      .join('')
    const team = teamById(l.team)
    const pu = info.pu
    const bar = (x) => `<i class="sc-bar"><b style="width:${Math.round(Math.min(1, x) * 100)}%"></b></i>`
    return `
      <section class="sc-col garage">
        ${brand('Гараж', 'Твой болид')}
        <div class="sc-rows">${html}</div>
        ${hintBar([['↑ ↓', 'пункт'], ['← →', 'цвет'], ['Enter', 'выбрать'], ['Esc', 'назад'], ['Мышь', 'крутить болид']])}
      </section>
      <aside class="sc-plaque wide">
        <div class="sc-plaque-t">${team ? esc(team.name) : 'Своя ливрея'}</div>
        <p>${team ? esc(team.about) : 'Свои цвета кузова и зоны у кокпита. Выбери любой из готовых или нажми на радугу и подбери точный.'}</p>
        <div class="sc-pu"><div class="sc-pu-t">Силовая установка</div>
          <span>Мотор</span>${bar(pu.ice)}<em>${pct(pu.ice)}</em>
          <span>ERS</span>${bar(pu.ers)}<em>${pct(pu.ers)}</em>
          <span>Коробка</span>${bar(pu.gearbox)}<em>${pct(pu.gearbox)}</em>
        </div>
      </aside>`
  }

  function renderRecords() {
    const info = ctx.info()
    const c = info.career
    const t = (x) => (x == null ? '—' : formatTime(x))
    const sectors = info.bestSectors || [null, null, null]
    const card = (name, value, sub = '') => `<div class="sc-card"><span>${name}</span><b>${value}</b>${sub ? `<em>${sub}</em>` : ''}</div>`
    return `
      <section class="sc-col">
        ${brand('Рекорды', ctx.trackLabel)}
        <div class="sc-cards">
          ${card('Лучший круг', t(info.bestLap))}
          ${card('Сектор 1', t(sectors[0]))}
          ${card('Сектор 2', t(sectors[1]))}
          ${card('Сектор 3', t(sectors[2]))}
        </div>
        <div class="sc-cards">
          ${card('Гонок', c.races)}
          ${card('Побед', c.wins)}
          ${card('Подиумов', c.podiums)}
          ${card('Сходов', c.dnf)}
        </div>
        <p class="sc-about">Лучший круг и секторы запоминаются отдельно для каждой трассы и сравниваются с ними во время заезда: зелёный — быстрее своего лучшего, жёлтый — медленнее.</p>
        ${hintBar([['Esc', 'назад']])}
      </section>`
  }

  // клавиши управления — вкладка «Управление» в «Настройках»
  const keysGrid = () => `<div class="sc-keys">${KEYS.map(([g, rows]) => `<div><h3>${g}</h3><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>`).join('')}</div>`

  const SCREENS = {
    main: { render: renderMain, shift: 0.17 },
    track: { render: renderTrack, shift: 0.2 },
    race: { render: renderRaceFormat, shift: 0.2 },
    weather: { render: renderWeather, shift: 0.2 },
    start: { render: renderStart, shift: 0.2 },
    garage: { render: renderGarage, shift: 0.2 },
    settings: { render: renderSettings, shift: 0.2 },
    records: { render: renderRecords, shift: 0.2 },
    play: { render: renderPlay, shift: 0.0 },
  }

  // ---------- состояние и навигация ----------
  const current = () => stack[stack.length - 1]
  function render() {
    const name = current()
    if (!name) return
    root.innerHTML = `<div class="sc-shade"></div>${SCREENS[name].render()}`
    root.dataset.screen = name
    root.dataset.wide = name === 'play' || (name === 'settings' && settingsTabs()[tab]?.keys) ? '1' : ''
  }
  function hide() {
    stack = []
    root.hidden = true
    ctx.showcase(false)
  }
  function push(name, before) {
    before?.()
    stack.push(name)
    if (name === 'start') ctx.previewCompound?.(session.compound)
    if (name === 'track') pendingTrack = ctx.trackId
    root.hidden = false
    ctx.showcase(true, SCREENS[name].shift)
    render()
  }
  // «Гонка» / «Заезд на время» из главного меню: первый шаг — трасса (если трасса одна — сразу следующий)
  function openFlowFor(mode) {
    session.mode = mode
    if ((ctx.tracks?.length ?? 0) > 1) push('track')
    else push(nextStep('track'))
  }
  const api = {
    isOpen: () => !root.hidden,
    // открыть с нуля (главное меню — первый экран; настройки из паузы — единственный)
    open(name) {
      stack = []
      push(name)
    },
    // после смены трассы (перезагрузки страницы) — снова в настройку заезда, на шаг после «Трассы»
    openFlow() {
      stack = ['main', 'track']
      push(nextStep('track'))
    },
    back() {
      if (stack.length <= 1) {
        // с самого первого экрана: у главного меню назад нет, остальные закрываются (пауза → настройки → пауза)
        if (current() === 'main') return
        hide()
        ctx.onClose()
        return
      }
      stack.pop()
      ctx.showcase(true, SCREENS[current()].shift)
      render()
    },
    hide,
    // убрать экраны на время (гараж настройки болида поверх), не теряя, где мы были; потом вернуть
    suspend() {
      root.hidden = true
    },
    resume() {
      if (!stack.length) return
      root.hidden = false
      ctx.showcase(true, SCREENS[current()].shift)
      render()
    },
    refresh: () => api.isOpen() && render(),
  }

  // изменить значение строки на шаг (dir = −1 или 1) или нажать
  function change(row, dir) {
    if (row.type === 'choice') {
      const cur = row.options.findIndex((o) => o.v === row.get())
      const next = row.options[(cur + dir + row.options.length) % row.options.length]
      row.set(next.v)
    } else if (row.type === 'slider') {
      row.set(Math.min(row.max, Math.max(row.min, row.get() + dir * row.step)))
    }
  }

  const rowsOf = () => {
    const name = current()
    if (name === 'track') return trackRows().filter((r) => !r.hidden?.())
    if (name === 'race') return raceRows().filter((r) => !r.hidden?.())
    if (name === 'weather') return weatherRows().filter((r) => !r.hidden?.())
    if (name === 'start') return startRows().filter((r) => !r.hidden?.())
    if (name === 'settings') return settingsTabs()[tab].rows.filter((r) => !r.hidden?.())
    if (name === 'garage') return garageRows()
    return null
  }
  const selKey = () => (current() === 'settings' ? 'settings' + tab : current())

  function applyLivery(patch) {
    const l = ctx.info().livery
    const next = { ...l, ...patch }
    const same = teamById(next.team)
    // если цвета совпали с готовой командой — это она, иначе «своя»
    next.team = same && same.primary.toLowerCase() === next.primary.toLowerCase() && same.secondary.toLowerCase() === next.secondary.toLowerCase() ? same.id : 'own'
    ctx.previewLivery(next)
    render()
  }

  function activate(i) {
    const name = current()
    if (name === 'main' || name === 'play') {
      sel[name] = i
      ;(name === 'main' ? mainItems() : playItems())[i]?.go()
      return
    }
    const rows = rowsOf()
    const row = rows?.[i]
    if (!row) return
    sel[selKey()] = i
    if (row.type === 'action') row.run?.()
    else if (row.cards) {
      // Enter на карточках — как «Далее»
      rows.find((r) => r.id === 'next')?.run?.()
      return
    } else if (row.type === 'team') applyLivery({ team: row.id, primary: row.team.primary, secondary: row.team.secondary, accent: row.team.accent })
    else if (row.type === 'choice') change(row, 1)
    render()
  }

  // ---------- события ----------
  root.addEventListener('click', (e) => {
    const t = e.target
    if (t.closest('input[type=range]') || t.closest('input[type=color]') || t.closest('label.pick')) return
    const chip = t.closest('[data-c]')
    if (chip) {
      const row = rowsOf()[Number(chip.dataset.i)]
      sel[selKey()] = Number(chip.dataset.i)
      applyLivery({ [row.key]: chip.dataset.c })
      return
    }
    const opt = t.closest('[data-o]')
    if (opt) {
      const rows = rowsOf()
      const row = rows[Number(opt.dataset.i)]
      sel[selKey()] = Number(opt.dataset.i)
      row.set(row.options[Number(opt.dataset.o)].v)
      render()
      return
    }
    const stepBtn = t.closest('[data-step]')
    if (stepBtn) {
      // назад на пройденный шаг
      while (stack.length > 1 && current() !== stepBtn.dataset.step) stack.pop()
      ctx.showcase(true, SCREENS[current()].shift)
      render()
      return
    }
    const tabBtn = t.closest('[data-tab]')
    if (tabBtn) {
      tab = Number(tabBtn.dataset.tab)
      render()
      return
    }
    const item = t.closest('[data-i]')
    if (item && (item.classList.contains('sc-item') || item.classList.contains('sc-mode') || item.classList.contains('sc-team') || item.tagName === 'BUTTON')) activate(Number(item.dataset.i))
    else if (item) {
      sel[selKey()] = Number(item.dataset.i)
      render()
    }
  })
  root.addEventListener('mouseover', (e) => {
    const item = e.target.closest('.sc-item, .sc-row, .sc-team, .sc-mode')
    if (!item || item.dataset.i === undefined) return
    const i = Number(item.dataset.i)
    const key = current() === 'main' || current() === 'play' ? current() : selKey()
    if (sel[key] !== i && !e.target.closest('input')) {
      sel[key] = i
      // перерисовка при наведении заменила бы элемент под курсором: меняем подсветку на месте
      for (const el of root.querySelectorAll('.sc-item, .sc-row, .sc-team, .sc-mode')) el.classList.toggle('on', el === item)
      const about = root.querySelector('.sc-about')
      if (about) {
        if (current() === 'main') about.innerHTML = mainItems()[i].about
        else if (rowsOf()?.[i]?.hint) about.innerHTML = rowsOf()[i].hint()
      }
    }
  })
  root.addEventListener('input', (e) => {
    const r = e.target
    if (r.dataset.slider !== undefined) {
      const row = rowsOf()[Number(r.dataset.slider)]
      row.set(Number(r.value))
      r.nextElementSibling.textContent = row.fmt(Number(r.value))
    } else if (r.dataset.pick !== undefined) {
      const row = rowsOf()[Number(r.dataset.pick)]
      // выбор своего цвета: применяем сразу, но экран не перерисовываем, пока тянут ползунок палитры
      const l = ctx.info().livery
      ctx.previewLivery({ ...l, [row.key]: r.value, team: 'own' })
      r.parentElement.style.setProperty('--c', r.value)
    }
  })
  root.addEventListener('change', (e) => {
    if (e.target.dataset.pick !== undefined) render()
  })

  addEventListener('keydown', (e) => {
    if (root.hidden || e.repeat && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) return
    const name = current()
    const list = name === 'main' || name === 'play'
    const rows = name === 'main' ? mainItems() : name === 'play' ? playItems() : rowsOf()
    const key = list ? name : selKey()
    const n = rows?.length ?? 0
    if ((e.code === 'ArrowUp' || (name === 'play' && e.code === 'ArrowLeft')) && n) sel[key] = ((sel[key] ?? 0) - 1 + n) % n
    else if ((e.code === 'ArrowDown' || (name === 'play' && e.code === 'ArrowRight')) && n) sel[key] = ((sel[key] ?? 0) + 1) % n
    else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && !list && n) {
      const row = rows[sel[key] ?? 0]
      const dir = e.code === 'ArrowLeft' ? -1 : 1
      if (row.type === 'choice' || row.type === 'slider') change(row, dir)
      else if (row.type === 'swatch') {
        const cur = row.swatches.findIndex((c) => c.toLowerCase() === row.value.toLowerCase())
        applyLivery({ [row.key]: row.swatches[(cur + dir + row.swatches.length) % row.swatches.length] })
        return
      } else return
    } else if (e.code === 'Enter') {
      // в настройке заезда Enter — всегда «Далее» / «На старт», с любой строки (значения меняют ← →)
      const cta = FLOW.includes(name) && rows?.find((r) => r.cta)
      if (cta && rows[sel[key] ?? 0]?.type !== 'action') {
        cta.run()
        if (current() === name) render()
        return
      }
      activate(sel[key] ?? 0)
      return
    } else if (name === 'settings' && (e.code === 'KeyQ' || e.code === 'KeyE')) {
      tab = (tab + (e.code === 'KeyE' ? 1 : -1) + settingsTabs().length) % settingsTabs().length
    } else return
    e.preventDefault()
    render()
  })

  return api
}
