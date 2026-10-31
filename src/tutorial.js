// Обучение для новичка (Рома 31.10: «обучение — да»). Заезд на время на текущей трассе с гоночной линией: на экране
// по очереди задания, каждое засчитывается само, когда сделал (газ до 150, тормоз к табличкам, проехать по линии,
// режим обгона, режим прямой, камера, пит-стоп). «Пропустить» — к следующему, «Закончить» — выйти. При первом запуске
// главное меню предлагает пройти его (один раз, `f1-race.tutorial.offered`); пройденное — `f1-race.tutorial.done`.
const STEPS = [
  { id: 'gas', title: 'Газ', text: 'Жми W — разгонись до 150 км/ч.' },
  { id: 'brake', title: 'Тормоз', text: 'Перед поворотом жми S: сбрось скорость ниже 90 км/ч. Таблички 100 · 50 · 25 — сколько метров до поворота.' },
  { id: 'line', title: 'Гоночная линия', text: 'Рули A и D, держись цветной линии: зелёная — газ, жёлтая — сбрось, красная — тормози. Проедь так 800 м.' },
  { id: 'boost', title: 'Режим обгона', text: 'На прямой держи Shift вместе с газом 2 секунды — электромотор добавит мощности. Батарея — кольцо слева на табло.' },
  { id: 'aero', title: 'Режим прямой', text: 'На длинной прямой (зелёная на мини-карте) нажми F — крылья раскроются, болид быстрее. Тормоз или руль их закроют.' },
  { id: 'cam', title: 'Камера', text: 'C — следующая камера, мышь с зажатой кнопкой — оглядеться. Попробуй.' },
  { id: 'pit', title: 'Пит-стоп', text: 'Нажми L — на въезде автопилот заведёт в боксы, механики сменят шины, и тебя выпустят. Шины выбирает I, ремонт — K.' },
]
const DONE_KEY = 'f1-race.tutorial.done'
const OFFER_KEY = 'f1-race.tutorial.offered'

const get = (k) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const set = (k) => {
  try {
    localStorage.setItem(k, '1')
  } catch {
    // не запомнили — предложим ещё раз
  }
}

export function createTutorial({ onExit }) {
  const box = document.createElement('div')
  box.id = 'tutorial'
  box.hidden = true
  document.body.appendChild(box)
  const st = { active: false, step: 0, t: 0, mem: {} }

  function render(doneText) {
    if (doneText) {
      box.innerHTML = `<div class="tu-k">Обучение</div><div class="tu-h">Готово!</div><p>${doneText}</p><div class="tu-b"><button data-a="menu">В главное меню</button><button data-a="stay">Покататься ещё</button></div>`
    } else {
      const s = STEPS[st.step]
      box.innerHTML = `<div class="tu-k">Обучение · шаг ${st.step + 1} из ${STEPS.length}</div><div class="tu-h">${s.title}</div><p>${s.text}</p><div class="tu-bar"><i style="width:${(st.step / STEPS.length) * 100}%"></i></div><div class="tu-b"><button data-a="skip">Пропустить</button><button data-a="menu">Закончить</button></div>`
    }
    for (const b of box.querySelectorAll('[data-a]')) b.addEventListener('click', () => act(b.dataset.a))
  }
  function act(a) {
    if (a === 'skip') next()
    else if (a === 'stay') stop()
    else if (a === 'menu') {
      stop()
      onExit?.()
    }
  }
  function next() {
    st.step++
    st.t = 0
    st.mem = {}
    if (st.step >= STEPS.length) {
      set(DONE_KEY)
      render('Ты знаешь всё, что нужно для первой гонки. Гоночную линию можно оставить: Настройки → Помощники → «Гоночная линия». Дальше — «Гонка» или «Чемпионат».')
      st.finished = true
      return
    }
    render()
  }
  function stop() {
    st.active = false
    st.finished = false
    box.hidden = true
  }

  return {
    state: st,
    get active() {
      return st.active
    },
    get offerNeeded() {
      return !get(DONE_KEY) && !get(OFFER_KEY)
    },
    markOffered() {
      set(OFFER_KEY)
    },
    // первый запуск: предложить обучение (в главном меню); go — начать
    offer(go) {
      set(OFFER_KEY)
      box.hidden = false
      box.classList.add('offer')
      box.innerHTML = `<div class="tu-k">Первый раз за рулём?</div><div class="tu-h">Обучение · 3 минуты</div><p>Газ и тормоз, гоночная линия, режим обгона и режим прямой, камеры и пит-стоп — по шагу, прямо на трассе.</p><div class="tu-b"><button data-a="go">Пройти обучение</button><button data-a="no">Не сейчас</button></div>`
      box.querySelector('[data-a=go]').addEventListener('click', () => {
        box.classList.remove('offer')
        go()
      })
      box.querySelector('[data-a=no]').addEventListener('click', () => {
        box.classList.remove('offer')
        box.hidden = true
      })
    },
    hideOffer() {
      if (box.classList.contains('offer')) {
        box.classList.remove('offer')
        box.hidden = true
      }
    },
    start() {
      st.active = true
      st.finished = false
      st.step = 0
      st.t = 0
      st.mem = {}
      box.hidden = false
      render()
    },
    stop,
    // события, которые не видно по состоянию болида
    event(name) {
      if (st.active && !st.finished && STEPS[st.step]?.id === name) next()
    },
    // каждый кадр в заезде: g — { speedKmh, input, s (м по оси), aero (0…1), pitPhase }
    update(dt, g) {
      if (!st.active || st.finished) return
      st.t += dt
      const m = st.mem
      const id = STEPS[st.step].id
      if (id === 'gas' && g.speedKmh >= 150) next()
      else if (id === 'brake') {
        if (g.speedKmh >= 130) m.fast = true
        if (m.fast && g.input.brake > 0.3 && g.speedKmh < 90) next()
      } else if (id === 'line') {
        if (m.last == null) m.last = g.s
        let d = g.s - m.last
        if (d < -g.length / 2) d += g.length
        if (d > 0 && d < 50) m.dist = (m.dist || 0) + d
        m.last = g.s
        if (m.dist >= 800) next()
      } else if (id === 'boost') {
        m.t = g.input.boost && g.input.throttle > 0.5 && g.speedKmh > 60 ? (m.t || 0) + dt : m.t || 0
        if (m.t >= 2) next()
      } else if (id === 'aero' && g.aero > 0.5) next()
      else if (id === 'pit' && (g.pitPhase === 'service' || g.pitPhase === 'release')) next()
    },
  }
}
