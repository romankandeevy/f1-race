import { formatTime } from './laps.js'
import { TUNING } from './tuning.js'
import { COMPOUNDS } from './wear.js'

const el = (id) => document.getElementById(id)

// огоньки оборотов как на руле F1: зелёные, красные, синие (синие — пора переключаться)
const RPM_LEDS = [...Array(5).fill('#22D36B'), ...Array(5).fill('#E10600'), ...Array(5).fill('#2F7BFF')]
const OFF = '#272B32'

// Мини-карта: контур трассы рисуется один раз в запасной холст, поверх — точка болида
function createMinimap(canvas, axis, zone) {
  const W = 226
  const H = 150
  const dpr = Math.min(devicePixelRatio, 2)
  canvas.width = W * dpr
  canvas.height = H * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const a of axis) {
    minX = Math.min(minX, a.x)
    maxX = Math.max(maxX, a.x)
    minZ = Math.min(minZ, a.z)
    maxZ = Math.max(maxZ, a.z)
  }
  const k = Math.min((W - 16) / (maxX - minX), (H - 16) / (maxZ - minZ))
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const at = (x, z) => [W / 2 + (x - cx) * k, H / 2 + (z - cz) * k]

  const base = document.createElement('canvas')
  base.width = W * dpr
  base.height = H * dpr
  const b = base.getContext('2d')
  b.scale(dpr, dpr)
  b.lineJoin = b.lineCap = 'round'
  const path = () => {
    b.beginPath()
    axis.forEach((a, i) => (i ? b.lineTo(...at(a.x, a.z)) : b.moveTo(...at(a.x, a.z))))
    b.closePath()
  }
  path()
  b.strokeStyle = '#000000'
  b.lineWidth = 8
  b.stroke()
  path()
  b.strokeStyle = '#D8DADD'
  b.lineWidth = 3
  b.stroke()
  // зоны режима прямой — зелёным
  if (zone) {
    b.strokeStyle = '#22D36B'
    b.lineWidth = 3
    b.beginPath()
    axis.forEach((a, i) => {
      if (!zone[i]) return
      const [x, y] = at(a.x, a.z)
      if (zone[(i - 1 + axis.length) % axis.length]) b.lineTo(x, y)
      else b.moveTo(x, y)
    })
    b.stroke()
  }
  // линия старта
  const [sx, sy] = at(axis[0].x, axis[0].z)
  const yaw = axis[0].yaw
  b.strokeStyle = '#E10600'
  b.lineWidth = 3
  b.beginPath()
  b.moveTo(sx - Math.cos(yaw) * 6, sy + Math.sin(yaw) * 6)
  b.lineTo(sx + Math.cos(yaw) * 6, sy - Math.sin(yaw) * 6)
  b.stroke()

  return {
    // others — боты: [{ car: { group }, paint }]
    draw(x, z, others) {
      ctx.clearRect(0, 0, W, H)
      ctx.drawImage(base, 0, 0, W, H)
      if (others) {
        ctx.lineWidth = 1.5
        ctx.strokeStyle = '#000000'
        for (const o of others) {
          const g = o.car.group.position
          const [bx, by] = at(g.x, g.z)
          ctx.beginPath()
          ctx.arc(bx, by, 3.6, 0, Math.PI * 2)
          ctx.fillStyle = o.paint
          ctx.fill()
          ctx.stroke()
        }
      }
      const [px, py] = at(x, z)
      ctx.beginPath()
      ctx.arc(px, py, 5, 0, Math.PI * 2)
      ctx.fillStyle = '#E10600'
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = '#FFFFFF'
      ctx.stroke()
    },
  }
}

export function createHud(track) {
  const speed = el('speed')
  const gear = el('gear')
  const aero = el('aero')
  const abs = el('abs')
  const rpm = el('rpm')
  // дисплей руля: кольца батареи и оборотов, режим обгона, поток энергии
  const dash = el('dash')
  const batt = el('batt')
  const battArc = el('battArc')
  const revArc = el('revArc')
  const rpmNum = el('rpmNum')
  const mode = el('mode')
  const ersBar = el('ersBar')
  const ersFill = ersBar.firstElementChild
  let lastBatt = -1
  let lastRev = -1
  let lastRpm = -1
  let lastMode = null
  let lastFlow = null
  rpm.innerHTML = '<i></i>'.repeat(RPM_LEDS.length)
  const leds = [...rpm.children]

  const hasLaps = !!(track.axis && track.axis.length)
  el('lapbox').hidden = !hasLaps
  el('mapbox').hidden = !hasLaps
  const minimap = hasLaps ? createMinimap(el('minimap'), track.axis, track.straightZone) : null
  const lapNum = el('lapNum')
  const bestLap = el('bestLap')
  const lastLap = el('lastLap')
  const lapNote = el('lapNote')
  const lapTime = el('lapTime')
  const delta = el('delta')
  const sectorEls = ['s1', 's2', 's3'].map(el)
  const wrongWay = el('wrongway')
  const lightsEl = el('lights')
  const lightDots = [...lightsEl.children]
  const notice = el('notice')
  let noticeUntil = 0
  const mfd = el('mfd')
  let mfdUntil = 0
  const wrongWayCount = el('wrongwayCount')
  const modeTag = el('modeTag')
  const tower = el('tower')
  const twPos = el('twPos')
  const twOf = el('twOf')
  const twLap = el('twLap')
  const twList = el('twList')
  const results = el('results')
  let lastTower = 0
  // состояние болида
  const csComp = el('csComp')
  const csName = el('csName')
  const csPlan = el('csPlan')
  const csPU = el('csPU')
  const csBody = el('csBody')
  const tyreEls = ['tFL', 'tFR', 'tRL', 'tRR'].map(el)
  const wingF = [...el('wFront').children]
  const wingR = el('wRear').firstElementChild
  const pitInfo = el('pitInfo')
  let lastCar = 0
  const dmgColor = (d) => (d < 0.15 ? '#22D36B' : d < 0.5 ? '#FFC400' : '#E10600')
  const badge = (c) => `<span class="cmp" style="--c:${COMPOUNDS[c].color}">${COMPOUNDS[c].short}</span>`


  let lastText = 0
  // в DOM пишем только то, что изменилось: каждая запись — пересчёт страницы браузером
  let lastSpeed = -1
  let lastLit = -1
  let lastGear = null
  let lastDrs = null
  let lastAbs = null
  const texts = new Map()
  const setText = (node, value) => {
    if (texts.get(node) !== value) {
      texts.set(node, value)
      node.textContent = value
    }
  }
  const setClass = (node, value) => {
    if (node.className !== value) node.className = value
  }

  return {
    // плашка сверху по центру: фальстарт, штраф и т. п.
    notify(text, bad = false, seconds = 4) {
      notice.textContent = text
      notice.className = bad ? 'bad' : ''
      notice.hidden = false
      noticeUntil = performance.now() + seconds * 1000
    },

    // быстрая настройка по ходу: показать и подсветить изменённый пункт
    showMfd(texts, key) {
      for (const row of mfd.querySelectorAll('.mfd-row')) {
        row.classList.toggle('on', row.dataset.k === key)
        row.lastElementChild.textContent = texts[row.dataset.k]
      }
      mfd.hidden = false
      mfdUntil = performance.now() + 2500
    },

    // огни старта на экране (дублируют портал — его не всегда видно из кабины)
    setLights(lit, visible) {
      if (lightsEl.hidden === visible) lightsEl.hidden = !visible
      lightDots.forEach((d, i) => setClass(d, i < lit ? 'on' : ''))
    },


    // состояние болида (4 раза в секунду) и пит-лейн
    updateCar(v, plan, pit) {
      const now = performance.now()
      if (now - lastCar > 250) {
        lastCar = now
        const c = COMPOUNDS[v.compound]
        csComp.style.setProperty('--c', c.color)
        setText(csComp, c.short)
        setText(csName, c.name)
        setText(csPlan, `пит: ${COMPOUNDS[plan.compound].short}${plan.wing ? ' + крыло' : ''}`)
        v.tyres.forEach((t, i) => {
          const node = tyreEls[i]
          const [lo, hi] = c.window
          setClass(node, 'tyre' + (t.puncture ? ' pop' : t.temp < lo ? ' cold' : t.temp > hi ? ' hot' : ''))
          setText(node.firstElementChild, t.puncture ? 'ПРОК' : Math.round(t.wear * 100) + '%')
          setText(node.lastElementChild, Math.round(t.temp) + '°')
        })
        const d = v.damage
        wingF[0].style.background = dmgColor(d.wingL)
        wingF[1].style.background = dmgColor(d.wingR)
        wingR.style.background = dmgColor(d.rearWing)
        const body = Math.max(d.floor, d.suspL, d.suspR)
        setClass(csBody, 'cs-body' + (body > 0.15 ? ' dmg' : ''))
        setText(csBody, body > 0.15 ? (d.floor >= Math.max(d.suspL, d.suspR) ? 'дн' : 'подв') : '')
        setText(csPU, v.pu.failed ? 'отказ' : Math.round(v.pu.ice * 100) + '%')
      }
      // пит-лейн: фаза, выпуск
      if (!pit) {
        if (!pitInfo.hidden) pitInfo.hidden = true
        return
      }
      pitInfo.hidden = false
      const s = pit.state
      const text = s.phase === 'lane' ? `Пит-лейн · ограничитель ${pit.inLimit ? 'включён' : '80'}` : s.phase === 'in' ? 'Заезд в бокс' : s.phase === 'service' ? `Обслуживание · ${Math.max(0, s.service - s.t).toFixed(1)} с` : s.phase === 'release' ? 'Жми газ!' : 'Ограничитель 80 · до конца зоны'
      setText(pitInfo, text)
      setClass(pitInfo, s.phase === 'release' ? 'go' : '')
    },

    setMode(text) {
      modeTag.textContent = text
    },

    // таблица позиций (4 раза в секунду хватает)
    updateRace(st, bots) {
      if (!st) {
        if (!tower.hidden) tower.hidden = true
        return
      }
      if (tower.hidden) tower.hidden = false
      const now = performance.now()
      if (now - lastTower < 250) return
      lastTower = now
      const me = st.cars.find((c) => c.player)
      const pos = st.order.indexOf(me) + 1
      setText(twPos, 'P' + pos)
      setText(twOf, `из ${st.cars.length}`)
      setText(twLap, me.finished ? 'Финиш' : `Круг ${Math.min(st.laps, Math.max(1, me.lap))}/${st.laps}`)
      twList.innerHTML = st.order
        .map((c, i) => {
          const gap = c.dsq ? 'ДСК' : c.dnf ? 'Сход' : c.inPit ? 'ПИТ' : i === 0 ? (c.finished ? 'Финиш' : 'Лидер') : `+${c.gap.toFixed(1)}`
          return `<li class="${c.player ? 'me' : ''}"><span class="n">${i + 1}</span><i style="background:${c.paint}"></i><span>${c.name}</span>${c.compound ? badge(c.compound) : '<span></span>'}<span class="gap">${gap}</span></li>`
        })
        .join('')
    },

    // итог гонки (null — спрятать)
    showResults(st) {
      if (!st) {
        results.hidden = true
        return
      }
      const me = st.cars.find((c) => c.player)
      const pos = st.order.indexOf(me) + 1
      const lead = st.order[0]
      const pen = (c) => (c.penalty ? ` (штраф +${c.penalty} с)` : '')
      const time = (c) =>
        c.dsq ? 'ДСК · один состав шин' : c.dnf ? 'Сход' : c.finished ? (c === lead ? formatTime(c.finishTime + c.penalty) : `+${(c.finishTime + c.penalty - lead.finishTime - lead.penalty).toFixed(3)}`) + pen(c) : `${c.lap >= st.laps ? 'последний круг' : `−${st.laps + 1 - c.lap} кр.`}`
      results.innerHTML = `
        <div class="res">
          <div class="sheet-kicker">Финиш · ${st.laps} кругов</div>
          <h2>${me.dsq ? 'Дисквалификация' : me.dnf ? 'Сход' : pos === 1 ? 'Победа!' : `${pos}-е место`}</h2>
          <ol>${st.order.map((c, i) => `<li class="${c.player ? 'me' : ''}"><span class="n">${i + 1}</span><i style="background:${c.paint}"></i><span>${c.name}</span><span class="t">${time(c)}</span></li>`).join('')}</ol>
          <p>N — новый старт · Esc — меню</p>
        </div>`
      results.hidden = false
    },

    update(state, aeroOpen, laps, carPos, absOn, others) {
      const s = Math.round(state.speedKmh)
      if (s !== lastSpeed) {
        speed.textContent = s
        lastSpeed = s
      }
      if (state.gear !== lastGear) {
        gear.textContent = state.gear
        lastGear = state.gear
      }
      const r = Math.min(1, Math.max(0, (state.rpm - 0.55) / 0.45))
      const lit = Math.round(r * RPM_LEDS.length)
      if (lit !== lastLit) {
        lastLit = lit
        leds.forEach((b, i) => (b.style.background = i < lit ? RPM_LEDS[i] : OFF))
      }
      // кольца: дуга в 3/4 круга (75 из 100 единиц длины окружности)
      const b = Math.round(state.battery * 100)
      if (b !== lastBatt) {
        lastBatt = b
        batt.textContent = b + '%'
        battArc.style.strokeDasharray = `${0.75 * b} 100`
      }
      const rev = Math.round(state.rpm * 200) / 2
      if (rev !== lastRev) {
        lastRev = rev
        revArc.style.strokeDasharray = `${0.75 * rev} 100`
      }
      const revs = Math.round((state.rpm * 12000) / 50) * 50
      if (revs !== lastRpm) {
        lastRpm = revs
        rpmNum.textContent = revs
      }
      // надпись под передачей: режим батареи; Shift — «Режим обгона»; пустая батарея — предупреждение
      const ers = TUNING.ersModes[state.ersMode]
      const empty = state.battery < 0.02 && ers.deploy > 0
      const m = state.boosting ? 'boost' : empty ? 'empty' : state.ersMode
      if (m !== lastMode) {
        lastMode = m
        mode.className = m
        mode.textContent = m === 'boost' ? 'Режим обгона' : m === 'empty' ? 'Батарея пуста' : ers.name
      }
      const flowCls = state.ersFlow < -0.02 ? 'harvest' : ''
      if (flowCls !== ersBar.className) ersBar.className = flowCls
      dash.classList.toggle('boost', state.ersFlow > 0.02)
      const flow = Math.round(Math.abs(state.ersFlow) * 50) * 2
      if (flow !== lastFlow) {
        lastFlow = flow
        ersFill.style.width = flow + '%'
      }

      // активная аэродинамика: «ПОВОРОТ» — крылья закрыты; в зоне прямой — зелёный контур (жми F); открыты — зелёная заливка
      const ac = state.aeroOn || aeroOpen > 0.5 ? 'on' : state.aeroZone ? 'ready' : ''
      if (ac !== lastDrs) {
        aero.className = ac
        aero.textContent = ac ? 'Прямая' : 'Поворот'
        lastDrs = ac
      }
      // ABS: выключен — контур, включён — белый, прямо сейчас держит колёса от блокировки — жёлтый
      const absCls = !absOn ? '' : state.absActive ? 'work' : 'on'
      if (absCls !== lastAbs) {
        abs.className = absCls
        lastAbs = absCls
      }

      if (minimap && carPos) minimap.draw(carPos.x, carPos.z, others)

      const now = performance.now()
      if (laps && now - lastText > 50) {
        lastText = now
        const st = laps.state
        const ww = st.wrongWay > 0.6
        if (wrongWay.hidden === ww) wrongWay.hidden = !ww
        if (ww) setText(wrongWayCount, `возврат на трассу через ${Math.max(1, Math.ceil(3 - st.wrongWay))}`)
        setText(lapNum, st.lap ? String(st.lap) : '—')
        setText(bestLap, formatTime(st.bestLap))
        setText(lastLap, formatTime(st.lastLap))
        setText(lapNote, st.note)
        setText(lapTime, st.running ? formatTime(st.lapTime) : '—')
        // секторы: первые 4 секунды нового круга показываем секторы прошлого
        const showLast = st.lastSectorState && st.running && st.lapTime < 4
        const states = showLast ? st.lastSectorState : st.sectorState
        const times = showLast ? st.lastSectors : st.sectors
        sectorEls.forEach((node, i) => {
          const cls = states[i] || (!showLast && st.running && i === st.sector ? 'now' : '')
          setClass(node, cls)
          setText(node.lastElementChild, times[i] != null ? times[i].toFixed(3) : '')
        })
        if (st.delta === null || !st.running) {
          setText(delta, '—')
          setClass(delta, '')
        } else {
          setText(delta, (st.delta < 0 ? '−' : '+') + Math.abs(st.delta).toFixed(3))
          setClass(delta, st.delta < 0 ? 'ahead' : 'behind')
        }
      }

      if (!notice.hidden && now > noticeUntil) notice.hidden = true
      if (!mfd.hidden && now > mfdUntil) mfd.hidden = true

    },

  }
}

// Телеметрия: чтобы понимать (и объяснять), почему болид ведёт себя так или иначе.
// Обновляется 10 раз в секунду: чаще глазу не нужно, а DOM дорогой.
const WHEEL_NAMES = ['ПЛ', 'ПП', 'ЗЛ', 'ЗП']
const SURF_SHORT = { asphalt: 'асф', gravel: 'грав', grass: 'трава', kerb: 'пореб' }

export function createTelemetry() {
  const box = el('telemetry')
  let last = 0
  const bar = (share, color) =>
    `<span class="bar"><i style="width:${Math.round(Math.min(1, share) * 100)}%;background:${color}"></i></span>`

  return {
    toggle() {
      box.hidden = !box.hidden
    },

    update(v) {
      if (box.hidden) return
      const now = performance.now()
      if (now - last < 100) return
      last = now
      const s = v.state
      const deg = (r) => ((r * 180) / Math.PI).toFixed(1)
      const rows = v.wheels
        .map((w, i) => {
          const use = w.cap > 0 ? Math.hypot(w.fx, w.fy) / w.cap : 0
          const color = w.sliding ? '#E10600' : use > 0.9 ? '#FFC400' : '#22D36B'
          const state = !w.contact ? 'в воздухе' : w.sliding ? (w.fx * s.fwdSpeed < 0 ? 'блок' : 'буксует') : SURF_SHORT[w.surface]
          return `<tr><td>${WHEEL_NAMES[i]}</td><td>${(w.load / 1000).toFixed(1)} кН</td><td>${deg(w.slip)}°</td><td>${deg(w.camberGround)}°</td><td>${bar(use, color)} ${Math.round(use * 100)}%</td><td>${state}</td></tr>`
        })
        .join('')
      const plank = s.plankContact > 0 ? ' · <span class="bad">чиркает</span>' : ''
      box.innerHTML =
        `<div class="t-head caps">Телеметрия · T</div>` +
        `<div class="row"><span class="caps">Перегрузка</span><span>бок ${s.gLat.toFixed(2)} g · вдоль ${s.gLong.toFixed(2)} g</span></div>` +
        `<div class="row"><span class="caps">Руль</span><span>${Math.round(v.steerIn * 100)}% · колёса ${deg(v.delta)}°</span></div>` +
        `<div class="row"><span class="caps">Днище</span><span>перед ${Math.round(s.rideF)} мм · зад ${Math.round(s.rideR)} мм${plank}</span></div>` +
        `<div class="row"><span class="caps">Граунд-эффект</span><span>прижим ×${s.aeroMult.toFixed(2)}</span></div>` +
        `<table><tr><th></th><th>нагрузка</th><th>увод</th><th>развал</th><th>сцепление</th><th></th></tr>${rows}</table>`
    },
  }
}
