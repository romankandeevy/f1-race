// Меню паузы (Esc), как в F1: слева пункты, справа пояснение. Гонка стоит, пока меню открыто.
// Здесь же «Управление» — все клавиши (раньше были в выезжающем справочнике снизу).
// Клавиши: ↑ ↓ — пункт, Enter — выбрать, Esc — продолжить.

const KEYS = [
  ['Вождение', [
    ['W / ↑', 'газ'],
    ['S / ↓', 'тормоз; на месте — задний ход'],
    ['A D / ← →', 'руль'],
    ['Пробел', 'ручник'],
  ]],
  ['Болид', [
    ['Shift', 'режим обгона (нитро), пока держишь'],
    ['1 2 3 4', 'режим батареи: зарядка, баланс, быстрый круг, обгон'],
    ['F', 'режим прямой — только в зелёных зонах карты'],
    ['B', 'ABS'],
    ['[ ]', 'баланс тормозов'],
    ['− =', 'дифференциал'],
    ['I', 'пит-стоп: состав шин'],
    ['K', 'пит-стоп: менять ли переднее крыло'],
  ]],
  ['Гонка и экран', [
    ['Esc', 'это меню'],
    ['G', 'настройка болида'],
    ['N', 'новый старт с решётки'],
    ['R', 'вернуть на трассу'],
    ['C', 'камера: сзади / из кабины'],
    ['T', 'телеметрия'],
    ['M', 'звук'],
    ['P', 'цвет болида'],
  ]],
]

// actions: { setup, restart, sound, telemetry, paint, bots, tyres, pu } — что делает пункт;
// state(): { muted, telemetry, bots, tyres, vehicle } — для подписей и экрана «Состояние болида»
export function createPauseMenu(actions, state) {
  const root = document.getElementById('menu')
  const ITEMS = [
    { id: 'resume', label: 'Продолжить', key: 'Esc', about: 'Вернуться на трассу. Гонка стоит на паузе, пока открыто меню.' },
    { id: 'setup', label: 'Настройка болида', key: 'G', about: 'Гараж: готовые настройки и свои, крылья, подвеска, тормоза, шины. У каждого параметра объяснение для новичка.' },
    { id: 'bots', label: () => `Соперники: ${state().bots}`, key: '', about: 'Гонка с ботами: одиннадцать соперников на той же физике, что у тебя, ты стартуешь последним, двенадцатым. Каждый старт решётка новая, у каждого пилота свой темп, траектория и манера. Лёгкие ездят спокойно и далеко от предела, средние — уверенно и закрываются на прямой, когда ты атакуешь, сложные — по гоночной линии на пределе сцепления, закрываются и тратят батарею на обгоны. «Выкл» — заезд на время в одиночку. Смена — сразу новый старт.', hide: () => state().bots === null },
    { id: 'tyres', label: () => `Стартовые шины: ${state().tyres.toLowerCase()}`, key: '', about: 'Мягкие — быстрее всех, но живут ~3 круга. Средние — ~6 кругов. Твёрдые — медленнее, зато ~10 кругов. В гонке обязательны два разных состава: без пит-стопа — дисквалификация, как в F1. Смена — сразу новый старт.' },
    { id: 'car', label: 'Состояние болида', key: '', about: '' },
    { id: 'pu', label: 'Новая силовая установка', key: '', about: 'Мотор, ERS и коробка изнашиваются от гонки к гонке. После 70% мотор слабеет, после 90% может отказать прямо в гонке — это сход. Новая установка — с нуля.' },
    { id: 'restart', label: 'Новый старт', key: 'N', about: 'Все на решётку, огни старта заново, полная батарея. Текущий круг не засчитается, лучший круг останется.' },
    { id: 'keys', label: 'Управление', key: '', about: '' },
    { id: 'sound', label: () => `Звук: ${state().muted ? 'выкл' : 'вкл'}`, key: 'M', about: 'Звук мотора и шорох гравия.' },
    { id: 'telemetry', label: () => `Телеметрия: ${state().telemetry ? 'вкл' : 'выкл'}`, key: 'T', about: 'Панель под временем круга: перегрузки, руль, днище, нагрузка и сцепление каждого колеса. Помогает понять, почему болид ведёт себя так.' },
    { id: 'paint', label: 'Цвет болида', key: 'P', about: 'Следующий цвет кузова. Логотипы и номер остаются.' },
  ]
  let sel = 0

  root.innerHTML = `
    <div class="pause">
      <div class="pause-left">
        <div class="sheet-kicker">LUMEN RING</div>
        <h2 class="sheet-title">Пауза</h2>
        <nav class="pause-items"></nav>
      </div>
      <aside class="pause-right"></aside>
    </div>`
  const list = root.querySelector('.pause-items')
  const right = root.querySelector('.pause-right')
  const text = (v) => (typeof v === 'function' ? v() : v)

  function render() {
    const items = ITEMS.filter((it) => !it.hide?.())
    if (ITEMS.length !== items.length) ITEMS.splice(0, ITEMS.length, ...items)
    list.innerHTML = ITEMS.map(
      (it, i) => `<button class="pause-item${i === sel ? ' on' : ''}" data-i="${i}"><span>${text(it.label)}</span>${it.key ? `<kbd>${it.key}</kbd>` : ''}</button>`,
    ).join('')
    const it = ITEMS[sel]
    right.innerHTML =
      it.id === 'car'
        ? carReport(state().vehicle)
        : it.id === 'keys'
        ? KEYS.map(([group, rows]) => `<div class="caps">${group}</div><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`).join('')
        : `<div class="caps">${text(it.label)}</div><p>${it.about}</p>`
  }

  function activate(i) {
    const id = ITEMS[i].id
    if (id === 'resume') api.close()
    else if (id === 'keys' || id === 'car') {
      sel = i
      render()
    } else {
      if (id === 'setup' || id === 'restart') api.close()
      actions[id]()
      render()
    }
  }

  list.addEventListener('mouseover', (e) => {
    const b = e.target.closest('[data-i]')
    if (b && Number(b.dataset.i) !== sel) {
      sel = Number(b.dataset.i)
      render()
    }
  })
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]')
    if (b) activate(Number(b.dataset.i))
  })
  addEventListener('keydown', (e) => {
    if (root.hidden) return
    if (e.code === 'ArrowUp') sel = (sel - 1 + ITEMS.length) % ITEMS.length
    else if (e.code === 'ArrowDown') sel = (sel + 1) % ITEMS.length
    else if (e.code === 'Enter') return activate(sel)
    else return
    render()
  })

  const api = {
    isOpen: () => !root.hidden,
    open() {
      sel = 0
      render()
      root.hidden = false
    },
    close() {
      root.hidden = true
    },
    toggle() {
      if (root.hidden) api.open()
      else api.close()
    },
  }
  return api
}

// экран «Состояние болида»: шины, повреждения, силовая установка — цифрами
const pct = (x) => `${Math.round(x * 100)}%`
const TYRE_NAMES = ['Передняя левая', 'Передняя правая', 'Задняя левая', 'Задняя правая']
function carReport(v) {
  const d = v.damage
  const rows = (list) => `<dl>${list.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('')}</dl>`
  return (
    `<div class="caps">Шины</div>` +
    rows(v.tyres.map((t, i) => [TYRE_NAMES[i], t.puncture ? 'прокол' : `износ ${pct(t.wear)} · ${Math.round(t.temp)}°`])) +
    `<div class="caps">Повреждения</div>` +
    rows([
      ['Переднее крыло', `слева ${pct(d.wingL)} · справа ${pct(d.wingR)}`],
      ['Заднее крыло', pct(d.rearWing)],
      ['Днище', pct(d.floor)],
      ['Подвеска', `слева ${pct(d.suspL)} · справа ${pct(d.suspR)}`],
    ]) +
    `<div class="caps">Силовая установка</div>` +
    rows([
      ['Мотор', v.pu.failed ? 'отказ' : pct(v.pu.ice)],
      ['ERS', pct(v.pu.ers)],
      ['Коробка', pct(v.pu.gearbox)],
    ]) +
    `<p>Крыло меняют на пит-стопе (клавиша K перед заездом), шины — всегда. Днище и подвеску в гонке не чинят.</p>`
  )
}
