// Меню паузы (Esc), как в F1: слева пункты, справа пояснение. Гонка стоит, пока меню открыто.
// Здесь же «Управление» — все клавиши (раньше были в выезжающем справочнике снизу).
// Клавиши: ↑ ↓ — пункт, Enter — выбрать, Esc — продолжить.

export const KEYS = [
  ['Вождение', [
    ['W', 'газ'],
    ['S', 'тормоз; на месте — задний ход'],
    ['A D', 'руль'],
    ['Пробел', 'ручник'],
  ]],
  ['Болид', [
    ['Shift', 'режим обгона (нитро), пока держишь'],
    ['1 2 3 4', 'режим батареи: зарядка, баланс, быстрый круг, обгон'],
    ['F', 'режим прямой — только в зелёных зонах карты'],
    ['B', 'ABS'],
    ['[ ]', 'баланс тормозов'],
    ['− =', 'дифференциал'],
    ['L', 'заехать в боксы: автопилот сам заведёт в пит-лейн, поставит в бокс и выпустит; повторное L — отмена'],
    ['I', 'пит-стоп: состав шин (можно кликом по плашке)'],
    ['K', 'пит-стоп: ремонтировать ли кузов (крылья, днище, бокподы, тормозные каналы); время стоянки растёт с повреждением'],
  ]],
  ['Гонка и экран', [
    ['Esc', 'это меню'],
    ['G', 'настройка болида'],
    ['N', 'новый старт с решётки'],
    ['R', 'вернуть на трассу'],
    ['C', 'камера по кругу: сзади, из кабины, T-камера, нос'],
    ['← → ↓', 'держишь — камера уходит на левый борт, правый или перед болидом (у камер на болиде — смотрит влево и вправо, назад нельзя); отпустил — возвращается'],
    ['Мышь', 'зажать и тянуть: свободный обзор (вокруг болида или поворот головы); колесо — ближе и дальше'],
    ['T', 'телеметрия'],
    ['M', 'звук'],
    ['P', 'цвет болида'],
  ]],
]

// actions: { setup, restart, settings, mainmenu, telemetry } — что делает пункт;
// state(): { telemetry, vehicle } — для подписей и экрана «Состояние болида»
export function createPauseMenu(actions, state) {
  const root = document.getElementById('menu')
  const ITEMS = [
    { id: 'resume', label: 'Продолжить', key: 'Esc', about: 'Вернуться на трассу. Гонка стоит на паузе, пока открыто меню.' },
    { id: 'restart', label: 'Новый старт', key: 'N', about: 'Все на решётку, огни старта заново, полная батарея. Текущий круг не засчитается, лучший круг останется. Соперники, круги и шины — как выбрали перед стартом.' },
    { id: 'setup', label: 'Настройка болида', key: 'G', about: 'Гараж: готовые настройки и свои, крылья, подвеска, тормоза, шины. У каждого параметра объяснение для новичка.' },
    { id: 'car', label: 'Состояние болида', key: '', about: '' },
    { id: 'settings', label: 'Настройки', key: '', about: 'Графика, звук, управление мышью, камеры и интерфейс. Всё действует сразу.' },
    { id: 'keys', label: 'Управление', key: '', about: '' },
    { id: 'telemetry', label: () => `Телеметрия: ${state().telemetry ? 'вкл' : 'выкл'}`, key: 'T', about: 'Панель под временем круга: перегрузки, руль, днище, нагрузка и сцепление каждого колеса. Помогает понять, почему болид ведёт себя так.' },
    { id: 'mainmenu', label: 'В главное меню', key: '', about: 'Закончить заезд и вернуться в главное меню. Незавершённая гонка не засчитается, лучший круг останется.' },
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
      if (id === 'setup' || id === 'restart' || id === 'settings' || id === 'mainmenu') api.close()
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
      ['Подвеска', `слева ${pct(d.suspL)}${d.suspL > 0.7 ? ' (сломана)' : d.suspL > 0.15 ? ' (помята)' : ''} · справа ${pct(d.suspR)}${d.suspR > 0.7 ? ' (сломана)' : d.suspR > 0.15 ? ' (помята)' : ''}`],
    ]) +
    `<div class="caps">Силовая установка</div>` +
    rows([
      ['Мотор', v.pu.failed ? 'отказ' : pct(v.pu.ice)],
      ['ERS', pct(v.pu.ers)],
      ['Коробка', pct(v.pu.gearbox)],
    ]) +
    `<p>Кузов (крылья, днище, бокподы, тормозные каналы) чинят на пит-стопе клавишей K, шины меняют всегда. Подвеску, монокок и оторванное колесо в боксах не чинят: разрушенный болид сходит. Помятая подвеска (больше 15%) ухудшает сцепление этой стороны и быстрее стирает её шины; сломанная (больше 70%) — сторона проседает, колесо не слушается руля и почти не держит.</p>`
  )
}
