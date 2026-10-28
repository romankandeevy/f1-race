// Экран «Настройка болида» (G или кнопка): как в игре F1 25 — вкладки сверху, параметры строками,
// справа описание выбранного параметра простыми словами: что это, что даёт больше/меньше и когда крутить.
// Значения сразу попадают в TUNING.setup, физика читает их каждый шаг. Сохраняются в браузере.
// Первая вкладка — «Готовые»: карточки пресетов с оценками для новичка и свои сохранённые настройки.
// Клавиши: ↑ ↓ — параметр, ← → — изменить (на «Готовых» Enter — поставить), Q E — вкладки, G или Esc — закрыть.
import { TUNING, SETUP_DEFAULT, SETUP_PRESETS } from './tuning.js'

const STORE_KEY = 'f1-race.setup.v2' // v2 — шкалы F1 25 (у старой настройки другие ключи)
const TAB_KEY = 'f1-race.setup.tab2' // tab2 — первой стала вкладка «Готовые»
const MINE_KEY = 'f1-race.setup.mine' // свои настройки: [{ name, values, at }]
const NAME_MAX = 24

const deg = (v) => `${v.toFixed(2)}°`
const psi = (v) => `${v.toFixed(1)} psi`

// давление шин: одинаковые пояснения для четырёх колёс
const tyre = (key, label, min, max, front) => ({
  key,
  label,
  min,
  max,
  step: 0.1,
  show: psi,
  lo: 'Больше сцепления',
  hi: 'Острее отклик',
  what: 'Давление воздуха в шине. От него зависит, какой площадью шина касается асфальта.',
  more: 'Шина твёрже: болид быстрее откликается на руль, но держит дорогу чуть хуже.',
  less: 'Шина мягче и шире касается асфальта: сцепления больше, но отклик на руль ленивее.',
  tip: front
    ? 'Не знаешь, что ставить, — оставь как есть или убавь передние до 23–24 psi: так болиду проще повернуть.'
    : 'Если зад срывается при разгоне — убавь задние до 21–22 psi, шина будет цепче.',
})

const TABS = [
  {
    title: 'Аэродинамика',
    fields: [
      {
        key: 'frontWing',
        label: 'Переднее антикрыло',
        min: 0,
        max: 50,
        step: 1,
        lo: 'Меньше прижима',
        hi: 'Больше прижима',
        what: 'Крыло на носу болида. Воздух давит на него сверху и прижимает передние колёса к дороге.',
        more: 'Нос цепче держит дорогу, болид охотнее поворачивает, особенно в быстрых поворотах.',
        less: 'Нос легче: в поворотах болид сильнее тянет прямо, наружу поворота.',
        tip: 'Болид не хочет поворачивать на скорости — добавь 2–3 деления. Зад начинает заносить на входе в поворот — убавь.',
      },
      {
        key: 'rearWing',
        label: 'Заднее антикрыло',
        min: 0,
        max: 50,
        step: 1,
        lo: 'Быстрее на прямой',
        hi: 'Устойчивее в повороте',
        what: 'Большое крыло сзади. Прижимает задние колёса, но заодно тормозит болид воздухом.',
        more: 'Зад держит дорогу крепче, заносов меньше. Но на прямой максимальная скорость ниже.',
        less: 'На прямой быстрее, зато в поворотах зад становится нервным и легче срывается.',
        tip: 'Новичку лучше побольше, 35–45: такой болид прощает ошибки. Когда освоишься и захочешь быстрее на прямых — убавляй понемногу.',
      },
    ],
  },
  {
    title: 'Трансмиссия',
    fields: [
      {
        key: 'diffOn',
        label: 'Дифференциал на газу',
        min: 10,
        max: 100,
        step: 1,
        unit: '%',
        lo: 'Живее в повороте',
        hi: 'Стабильнее на разгоне',
        what: 'Как сила мотора делится между двумя задними колёсами, когда ты жмёшь газ. 100% — колёса крутятся строго вместе, меньше — каждое может крутиться по-своему.',
        more: 'При разгоне болид едет ровно и устойчиво, но на выходе из поворота хуже доворачивает.',
        less: 'Болид охотнее поворачивает под газом, но внутреннее колесо может буксовать — легче уйти в занос.',
        tip: 'Заносит, когда жмёшь газ на выходе из поворота, — добавь 5–10%. Меняется и на ходу: клавиши − и =.',
      },
      {
        key: 'diffOff',
        label: 'Дифференциал на сбросе газа',
        min: 10,
        max: 100,
        step: 1,
        unit: '%',
        lo: 'Острее вход',
        hi: 'Спокойнее вход',
        what: 'То же самое, но когда газ отпущен — при торможении и на входе в поворот.',
        more: 'На входе в поворот болид спокойный и предсказуемый, но поворачивает неохотно.',
        less: 'Вход в поворот острее, но зад может гулять, когда отпускаешь газ.',
        tip: 'Зад виляет, когда отпускаешь газ перед поворотом, — добавь. Болид упрямо едет прямо на входе — убавь.',
      },
    ],
  },
  {
    title: 'Геометрия подвески',
    fields: [
      {
        key: 'camberF',
        label: 'Развал передних колёс',
        min: -3.5,
        max: -2.5,
        step: 0.1,
        show: deg,
        lo: 'Больше в повороте',
        hi: 'Лучше на прямой',
        what: 'Наклон передних колёс: верх колеса завален внутрь, к болиду. Чем больше минус, тем сильнее наклон.',
        more: 'Ближе к −2,5°: колесо стоит ровнее — лучше тормозит по прямой, но в повороте держит меньше.',
        less: 'Ближе к −3,5°: в повороте шина ложится на асфальт всей шириной и держит крепче, торможение чуть хуже.',
        tip: 'На ощущения влияет мало — можно не трогать. Не хватает поворота — ставь −3,5°.',
      },
      {
        key: 'camberR',
        label: 'Развал задних колёс',
        min: -2,
        max: -1,
        step: 0.1,
        show: deg,
        lo: 'Больше в повороте',
        hi: 'Лучше на разгоне',
        what: 'Наклон задних колёс внутрь, как у передних.',
        more: 'Ближе к −1,0°: колесо ровнее — лучше тяга при разгоне, меньше пробуксовки.',
        less: 'Ближе к −2,0°: зад крепче держится в повороте, но на разгоне буксует легче.',
        tip: 'Колёса буксуют на старте и на выходе из медленных поворотов — ставь ближе к −1,0°.',
      },
      {
        key: 'toeF',
        label: 'Расхождение передних колёс',
        min: 0,
        max: 0.5,
        step: 0.01,
        show: deg,
        lo: 'Спокойный руль',
        hi: 'Острый руль',
        what: 'Передние колёса чуть-чуть смотрят «носками» врозь, а не строго вперёд.',
        more: 'Руль отзывчивее, нос резче ныряет в поворот. На прямой болид чуть нервнее.',
        less: 'Болид спокойнее держит прямую, вход в поворот мягче и медленнее.',
        tip: 'Болид кажется ленивым на руль — добавь 0,05–0,10°. Дёргается на прямой — убавь.',
      },
      {
        key: 'toeR',
        label: 'Схождение задних колёс',
        min: 0.1,
        max: 0.5,
        step: 0.01,
        show: deg,
        lo: 'Живой зад',
        hi: 'Устойчивый зад',
        what: 'Задние колёса чуть-чуть смотрят «носками» внутрь, друг на друга.',
        more: 'Зад устойчивее, болид едет как по рельсам, но немного теряет скорость: шины трутся.',
        less: 'Зад живее и охотнее поворачивает, но его легче сорвать в занос.',
        tip: 'Если зад гуляет на прямой и на выходе из поворотов — добавь.',
      },
    ],
  },
  {
    title: 'Подвеска',
    fields: [
      {
        key: 'suspF',
        label: 'Передняя подвеска',
        min: 1,
        max: 41,
        step: 1,
        lo: 'Мягче',
        hi: 'Жёстче',
        what: 'Жёсткость передних пружин: насколько нос проседает на кочках, при торможении и в поворотах.',
        more: 'Нос реагирует быстро и чётко, но на поребриках болид прыгает, а в повороте нос раньше теряет сцепление.',
        less: 'Нос мягче, лучше держит на неровностях и поребриках и цепче в повороте, но «кивает» при торможении.',
        tip: 'Не знаешь — держи середину (около 20). Болид не хочет поворачивать — сделай перед мягче.',
      },
      {
        key: 'suspR',
        label: 'Задняя подвеска',
        min: 1,
        max: 41,
        step: 1,
        lo: 'Мягче',
        hi: 'Жёстче',
        what: 'Жёсткость задних пружин.',
        more: 'Болид охотнее поворачивает, но зад легче срывается в занос.',
        less: 'Зад цепче, особенно на выходе из поворота под газом, но поворачивает болид неохотнее.',
        tip: 'Заносит на выходе из поворотов — сделай зад мягче на 3–5 делений.',
      },
      {
        key: 'arbF',
        label: 'Передний стабилизатор',
        min: 1,
        max: 21,
        step: 1,
        lo: 'Мягче',
        hi: 'Жёстче',
        what: 'Пружина-перемычка между передними колёсами. Решает, насколько болид кренится набок в повороте.',
        more: 'Крена меньше, отклик чётче, но нос раньше начинает сносить наружу поворота.',
        less: 'Нос держит дорогу крепче, болид поворачивает охотнее.',
        tip: 'Нос сносит наружу в середине поворота — убавь 2–3 деления.',
      },
      {
        key: 'arbR',
        label: 'Задний стабилизатор',
        min: 1,
        max: 21,
        step: 1,
        lo: 'Мягче',
        hi: 'Жёстче',
        what: 'Такая же перемычка между задними колёсами.',
        more: 'Болид охотнее поворачивает, зад становится живее.',
        less: 'Зад устойчивее, срывается реже.',
        tip: 'Заносит в середине поворота — убавь. Болид упрямо едет прямо — добавь.',
      },
      {
        key: 'rideF',
        label: 'Клиренс спереди',
        min: 1,
        max: 40,
        step: 1,
        lo: 'Ниже',
        hi: 'Выше',
        what: 'Высота носа над асфальтом. Днище F1 «присасывается» к дороге: чем ниже, тем сильнее прижим.',
        more: 'Выше: днище не задевает асфальт и поребрики, но прижима меньше.',
        less: 'Ниже: прижима больше, болид держит быстрые повороты лучше, но днище может чиркать — тогда болид тормозит и прыгает.',
        tip: 'Нос выше зада делает болид устойчивее, ниже — острее. Чиркает днище (видно в телеметрии, клавиша T) — подними на 3–5.',
      },
      {
        key: 'rideR',
        label: 'Клиренс сзади',
        min: 1,
        max: 40,
        step: 1,
        lo: 'Ниже',
        hi: 'Выше',
        what: 'Высота задней части над асфальтом.',
        more: 'Зад выше носа: болид «смотрит» носом в асфальт — нос цепче, болид острее поворачивает.',
        less: 'Зад ниже: болид устойчивее, но поворачивает ленивее.',
        tip: 'Обычно зад ставят немного выше носа. Чиркает днище — подними.',
      },
    ],
  },
  {
    title: 'Тормоза',
    fields: [
      {
        key: 'brakePressure',
        label: 'Давление в тормозах',
        min: 50,
        max: 100,
        step: 1,
        unit: '%',
        lo: 'Мягче тормоз',
        hi: 'Сильнее тормоз',
        what: 'Насколько сильно тормозит болид, когда педаль нажата до конца.',
        more: 'Тормозит сильнее, но колёса легче блокируются: болид идёт юзом прямо и перестаёт поворачивать.',
        less: 'Тормозной путь длиннее, зато колёса заблокировать сложнее.',
        tip: 'С клавиатуры тормоз всегда «в пол». Если часто блокируешь колёса — поставь 85–90% или включи ABS (клавиша B): он сам не даёт колёсам заблокироваться.',
      },
      {
        key: 'brakeBias',
        label: 'Баланс тормозов',
        min: 50,
        max: 70,
        step: 1,
        unit: '%',
        lo: 'Больше назад',
        hi: 'Больше вперёд',
        what: 'Какая часть тормоза приходится на передние колёса. 58% — 58% тормозит перед, 42% — зад.',
        more: 'Вперёд: торможение устойчивое, но первыми блокируются передние — болид едет прямо и не поворачивает.',
        less: 'Назад: болид охотнее поворачивает на торможении, но может развернуть.',
        tip: 'Разворачивает при торможении — сдвинь вперёд. Не поворачивает, пока тормозишь, — назад. Меняется и на ходу: клавиши [ и ].',
      },
    ],
  },
  {
    title: 'Шины',
    fields: [
      tyre('tyreFL', 'Передняя левая', 22.5, 29.5, true),
      tyre('tyreFR', 'Передняя правая', 22.5, 29.5, true),
      tyre('tyreRL', 'Задняя левая', 20.5, 26.5, false),
      tyre('tyreRR', 'Задняя правая', 20.5, 26.5, false),
    ],
  },
]
const FIELDS = TABS.flatMap((t) => t.fields)
const PRESET_KEYS = Object.keys(SETUP_PRESETS)
const RATES = [
  ['straight', 'Скорость на прямой'],
  ['corners', 'Держит повороты'],
  ['forgiving', 'Прощает ошибки'],
]
// полоска оценки 1–5
const meter = (n) => `<span class="meter">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) Object.assign(TUNING.setup, SETUP_DEFAULT, JSON.parse(raw))
  } catch {
    // нет доступа к хранилищу (приватное окно) — едем с настройкой по умолчанию
  }
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(TUNING.setup))
  } catch {
    // не сохранилось — не страшно, настройка всё равно применена
  }
}
const same = (values) => FIELDS.every((f) => Math.abs(values[f.key] - TUNING.setup[f.key]) < 1e-6)
// какая готовая настройка стоит сейчас (null — своя)
const currentPreset = () => PRESET_KEYS.find((k) => same(SETUP_PRESETS[k].values)) || null

function loadMine() {
  try {
    const list = JSON.parse(localStorage.getItem(MINE_KEY) || '[]')
    return Array.isArray(list) ? list.filter((m) => m && typeof m.name === 'string' && m.values) : []
  } catch {
    return []
  }
}
function saveMine(list) {
  try {
    localStorage.setItem(MINE_KEY, JSON.stringify(list))
  } catch {
    // не сохранилось (приватное окно) — список останется до перезагрузки
  }
}
// название пишет игрок — в разметку только экранированным
const esc = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const summary = (v) => `Крылья ${v.frontWing} / ${v.rearWing} · дифференциал ${v.diffOn}% · подвеска ${v.suspF} / ${v.suspR} · клиренс ${v.rideF} / ${v.rideR} · тормоза ${v.brakePressure}%, баланс ${v.brakeBias}%`
const dateOf = (at) => new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })

// игрок печатает название — клавиши игры и гаража не трогаем
export const isTyping = (e) => e.target instanceof HTMLInputElement && e.target.type === 'text'

export function createSetupScreen() {
  load()
  const root = document.getElementById('setup')
  // tab 0 — «Готовые», дальше вкладки параметров (TABS[tab - 1])
  const TITLES = ['Готовые', ...TABS.map((t) => t.title)]
  let tab = 0
  let sel = 0
  let mine = loadMine()
  let naming = false // открыто поле названия на карточке «Сохранить»
  let confirmDel = -1 // своя настройка, у которой спросили «Удалить?»
  try {
    tab = Math.min(TITLES.length - 1, Number(localStorage.getItem(TAB_KEY)) || 0)
  } catch {
    tab = 0
  }

  root.innerHTML = `
    <div class="sheet">
      <header class="sheet-head">
        <div>
          <div class="sheet-kicker">Гараж · гонка на паузе</div>
          <h2 class="sheet-title">Настройка болида</h2>
        </div>
        <button class="close" data-action="close">Закрыть <kbd>G</kbd></button>
      </header>
      <nav class="tabs"><kbd>Q</kbd>${TITLES.map((t, i) => `<button data-tab="${i}">${t}</button>`).join('')}<kbd>E</kbd></nav>
      <div class="setup-body">
        <section class="rows"></section>
        <aside class="desc"></aside>
      </div>
      <footer class="sheet-foot">
        <div class="now"></div>
        <div class="keys"></div>
      </footer>
    </div>`
  const rows = root.querySelector('.rows')
  const desc = root.querySelector('.desc')
  const nowEl = root.querySelector('.now')
  const keysEl = root.querySelector('.keys')

  const show = (f, v) => (f.show ? f.show(v) : `${v}${f.unit || ''}`)
  // шаг 0,1 даёт хвосты вроде 24.900000000000002 — округляем до шага
  const decimals = (f) => (String(f.step).split('.')[1] || '').length
  const round = (f, v) => Number((Math.round(Math.min(f.max, Math.max(f.min, v)) / f.step) * f.step).toFixed(decimals(f)))
  const share = (f, v) => ((v - f.min) / (f.max - f.min)) * 100
  const isPresets = () => tab === 0
  // список вкладки «Готовые»: пресеты, свои, карточка «Сохранить»
  const items = () => [...PRESET_KEYS.map((key) => ({ kind: 'preset', key })), ...mine.map((m, i) => ({ kind: 'mine', i })), { kind: 'add' }]
  const count = () => (isPresets() ? items().length : TABS[tab - 1].fields.length)

  function renderTab() {
    sel = Math.min(sel, count() - 1)
    if (isPresets()) {
      rows.innerHTML = items()
        .map((it, i) => {
          if (it.kind === 'preset') {
            const p = SETUP_PRESETS[it.key]
            return `
        <div class="field card" data-i="${i}">
          <div class="card-name"><b>${p.name}</b><span>${p.who}</span></div>
          <div class="card-rates">${RATES.map(([key, label]) => `<span class="rate"><em>${label}</em>${meter(p.rate[key])}</span>`).join('')}</div>
          <span class="card-on">Стоит</span>
        </div>`
          }
          if (it.kind === 'mine') {
            const m = mine[it.i]
            const head = it.i === 0 ? '<div class="cards-head caps">Мои настройки</div>' : ''
            return `${head}
        <div class="field card mine" data-i="${i}">
          <div class="card-name"><b>${esc(m.name)}</b><span>Своя · ${dateOf(m.at)}</span></div>
          <div class="card-sum">${summary(m.values)}</div>
          <span class="card-on">Стоит</span>
          <button class="card-del${confirmDel === it.i ? ' ask' : ''}" data-del="${it.i}" title="Удалить">${confirmDel === it.i ? 'Удалить?' : '×'}</button>
        </div>`
          }
          return `${mine.length ? '' : '<div class="cards-head caps">Мои настройки</div>'}
        <div class="field card add" data-i="${i}">
          ${
            naming
              ? `<input class="add-name" type="text" maxlength="${NAME_MAX}" placeholder="Название, например «Мой круг»" spellcheck="false"><button class="add-save" data-action="save-mine">Сохранить</button>`
              : '<span class="add-label">＋ Сохранить текущую настройку</span>'
          }
        </div>`
        })
        .join('')
      rows.querySelectorAll('.card').forEach((row) => {
        const i = Number(row.dataset.i)
        row.addEventListener('mouseenter', () => select(i))
        row.addEventListener('click', (e) => {
          if (e.target.closest('button, input')) return
          activate(i)
        })
      })
      const name = rows.querySelector('.add-name')
      if (name) {
        name.focus()
        name.addEventListener('keydown', (e) => {
          if (e.code === 'Enter') saveCurrent(name.value)
          if (e.code === 'Escape') {
            naming = false
            renderTab()
          }
        })
      }
      keysEl.innerHTML = '<kbd>↑</kbd><kbd>↓</kbd> выбрать · <kbd>Enter</kbd> поставить · <kbd>Q</kbd><kbd>E</kbd> вкладки'
    } else {
      const t = TABS[tab - 1]
      rows.innerHTML = t.fields
        .map(
          (f, i) => `
        <div class="field" data-i="${i}">
          <span class="name">${f.label}</span>
          <button data-step="${f.key}" data-dir="-1" aria-label="меньше">‹</button>
          <input type="range" data-key="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}">
          <button data-step="${f.key}" data-dir="1" aria-label="больше">›</button>
          <output data-out="${f.key}"></output>
        </div>`,
        )
        .join('')
      rows.querySelectorAll('.field').forEach((row, i) => {
        row.addEventListener('mouseenter', () => select(i))
        row.querySelector('input').addEventListener('input', (e) => set(t.fields[i], Number(e.target.value)))
      })
      keysEl.innerHTML = '<kbd>↑</kbd><kbd>↓</kbd> параметр · <kbd>←</kbd><kbd>→</kbd> изменить · <kbd>Q</kbd><kbd>E</kbd> вкладки'
    }
    for (const b of root.querySelectorAll('[data-tab]')) b.classList.toggle('on', Number(b.dataset.tab) === tab)
    refresh()
  }

  function select(i) {
    if (i === sel) return
    sel = i
    refresh()
  }

  function renderDesc() {
    if (isPresets() && items()[sel].kind === 'mine') {
      const m = mine[items()[sel].i]
      const on = same(m.values)
      desc.innerHTML = `
        <div class="caps">Своя настройка</div>
        <h3>${esc(m.name)}</h3>
        <div class="who">Сохранена ${dateOf(m.at)}</div>
        <div class="effect"><span class="caps">Что внутри</span><p>${summary(m.values)} · развал ${m.values.camberF} / ${m.values.camberR}° · шины ${m.values.tyreFL} / ${m.values.tyreRL} psi</p></div>
        <div class="tip"><span class="caps">${on ? 'Стоит сейчас' : 'Как поставить'}</span><p>${on ? 'Подкрутил вкладки и хочешь сохранить поверх — сохрани под тем же названием.' : 'Нажми на карточку или Enter. × справа — удалить.'}</p></div>`
      return
    }
    if (isPresets() && items()[sel].kind === 'add') {
      desc.innerHTML = `
        <div class="caps">Мои настройки</div>
        <h3>Сохранить свою</h3>
        <p class="what">Настрой болид во вкладках — крылья, подвеску, тормоза, шины. Потом вернись сюда, нажми эту карточку и дай настройке название. Она появится в списке, и её можно будет поставить одним нажатием.</p>
        <div class="effect"><span class="caps">Что сохранится</span><p>${summary(TUNING.setup)} · развал, схождение и давление шин тоже.</p></div>
        <div class="tip"><span class="caps">Совет</span><p>Удобно держать несколько: «Квалификация» с низкими крыльями и «Гонка» поустойчивее. То же название — сохранить поверх. Настройки хранятся в этом браузере.</p></div>`
      return
    }
    if (isPresets()) {
      const k = items()[sel].key
      const p = SETUP_PRESETS[k]
      const v = p.values
      const on = currentPreset() === k
      desc.innerHTML = `
        <div class="caps">Готовая настройка</div>
        <h3>${p.name}</h3>
        <div class="who">${p.who}</div>
        <div class="rates-big">${RATES.map(([key, label]) => `<div><span>${label}</span>${meter(p.rate[key])}</div>`).join('')}</div>
        <p class="what">${p.hint}</p>
        <div class="effect"><span class="caps">Что внутри</span><p>Крылья ${v.frontWing} / ${v.rearWing} · дифференциал ${v.diffOn}% · подвеска ${v.suspF} / ${v.suspR} · клиренс ${v.rideF} / ${v.rideR} · тормоза ${v.brakePressure}%, баланс ${v.brakeBias}%</p></div>
        <div class="tip"><span class="caps">${on ? 'Стоит сейчас' : 'Как поставить'}</span><p>${on ? 'Можешь подкрутить любую вкладку — эта настройка станет основой.' : 'Нажми на карточку или Enter. Потом можно подкрутить любую вкладку.'}</p></div>`
      return
    }
    const f = TABS[tab - 1].fields[sel]
    const v = TUNING.setup[f.key]
    desc.innerHTML = `
      <div class="caps">${TABS[tab - 1].title}</div>
      <h3>${f.label}</h3>
      <div class="big">${show(f, v)}</div>
      <div class="scale"><span>${f.lo}</span><i><b style="left:${share(f, v)}%"></b></i><span>${f.hi}</span></div>
      <p class="what">${f.what}</p>
      <div class="effect"><span class="caps">Больше <em>›</em></span><p>${f.more}</p></div>
      <div class="effect"><span class="caps">Меньше <em>‹</em></span><p>${f.less}</p></div>
      <div class="tip"><span class="caps">Совет</span><p>${f.tip}</p></div>`
  }

  function set(f, value) {
    TUNING.setup[f.key] = round(f, value)
    save()
    refresh()
  }

  function applyValues(values) {
    // только известные параметры: старая сохранёнка без новых ключей не сломает настройку
    for (const f of FIELDS) if (typeof values[f.key] === 'number') TUNING.setup[f.key] = values[f.key]
    save()
    refresh()
  }

  // карточка на вкладке «Готовые»: поставить пресет или свою, или открыть поле названия
  function activate(i) {
    const it = items()[i]
    confirmDel = -1
    if (it.kind === 'preset') applyValues(SETUP_PRESETS[it.key].values)
    else if (it.kind === 'mine') applyValues(mine[it.i].values)
    else if (!naming) {
      naming = true
      sel = i
      renderTab()
    }
  }

  function saveCurrent(raw) {
    const name = raw.trim().slice(0, NAME_MAX)
    if (!name) return
    const entry = { name, values: { ...TUNING.setup }, at: Date.now() }
    const at = mine.findIndex((m) => m.name.toLowerCase() === name.toLowerCase())
    if (at >= 0) mine[at] = entry // то же название — сохранить поверх
    else mine.push(entry)
    saveMine(mine)
    naming = false
    sel = PRESET_KEYS.length + (at >= 0 ? at : mine.length - 1)
    renderTab()
  }

  function deleteMine(i) {
    if (confirmDel !== i) {
      confirmDel = i
      renderTab()
      return
    }
    mine.splice(i, 1)
    saveMine(mine)
    confirmDel = -1
    renderTab()
  }

  function refresh() {
    const cur = currentPreset()
    if (isPresets()) {
      items().forEach((it, i) => {
        const row = rows.querySelector(`.card[data-i="${i}"]`)
        row.classList.toggle('on', i === sel)
        row.classList.toggle('active', (it.kind === 'preset' && it.key === cur) || (it.kind === 'mine' && same(mine[it.i].values)))
      })
    } else {
      TABS[tab - 1].fields.forEach((f, i) => {
        const v = TUNING.setup[f.key]
        const input = rows.querySelector(`[data-key="${f.key}"]`)
        input.value = v
        input.style.setProperty('--p', `${share(f, v)}%`)
        rows.querySelector(`[data-out="${f.key}"]`).textContent = show(f, v)
        rows.children[i].classList.toggle('on', i === sel)
      })
    }
    renderDesc()
    const mineNow = cur ? null : mine.find((m) => same(m.values))
    nowEl.innerHTML = `<span class="caps">Сейчас</span> ${cur ? SETUP_PRESETS[cur].name : mineNow ? esc(mineNow.name) : 'Своя настройка, не сохранена'}`
  }

  function goTab(i) {
    tab = (i + TITLES.length) % TITLES.length
    sel = 0
    naming = false
    confirmDel = -1
    try {
      localStorage.setItem(TAB_KEY, String(tab))
    } catch {
      // не запомнили вкладку — откроется первая
    }
    renderTab()
  }

  root.addEventListener('click', (e) => {
    const t = e.target.closest('button')
    if (!t) return
    if (t.dataset.tab) goTab(Number(t.dataset.tab))
    if (t.dataset.step) {
      const fields = TABS[tab - 1].fields
      const i = fields.findIndex((x) => x.key === t.dataset.step)
      sel = i
      set(fields[i], TUNING.setup[fields[i].key] + fields[i].step * Number(t.dataset.dir))
    }
    if (t.dataset.action === 'save-mine') saveCurrent(rows.querySelector('.add-name').value)
    if (t.dataset.del) deleteMine(Number(t.dataset.del))
    if (t.dataset.action === 'close') api.close()
  })
  // клик по затемнению вокруг листа закрывает экран
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) api.close()
  })
  // управление с клавиатуры, пока экран открыт
  addEventListener('keydown', (e) => {
    if (root.hidden || isTyping(e)) return
    const n = count()
    if (e.code === 'ArrowUp') select((sel - 1 + n) % n)
    else if (e.code === 'ArrowDown') select((sel + 1) % n)
    else if (e.code === 'KeyQ') goTab(tab - 1)
    else if (e.code === 'KeyE') goTab(tab + 1)
    else if (isPresets()) {
      if (e.code === 'Enter') activate(sel)
    } else {
      const f = TABS[tab - 1].fields[sel]
      if (e.code === 'ArrowLeft') set(f, TUNING.setup[f.key] - f.step)
      else if (e.code === 'ArrowRight') set(f, TUNING.setup[f.key] + f.step)
    }
  })

  const api = {
    save,
    isOpen: () => !root.hidden,
    open() {
      naming = false
      confirmDel = -1
      renderTab()
      root.hidden = false
    },
    close() {
      if (root.hidden) return
      root.hidden = true
      api.onClose?.()
    },
    onClose: null, // main: вернуться в меню паузы, если гараж открыли из него
    toggle() {
      if (root.hidden) api.open()
      else api.close()
    },
  }
  renderTab()
  return api
}
