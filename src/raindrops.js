// Капли дождя на экране (Рома 31.10: «на всех камерах»). Отдельный прозрачный холст поверх картинки игры (под табло):
// капли падают на «стекло» — визор шлема из кабины, линзу камеры сзади, — растут, сливаются и уходят.
// Из кабины и с камер на болиде на скорости поток воздуха сдувает капли от центра к краям и вверх (на малой скорости —
// стекают вниз); у камеры сзади (как у ТВ-камеры) капли держатся дольше и медленно сползают вниз. Капля нарисована
// как линза: тёмный ободок снизу, светлый блик сверху, прозрачная середина; быстрая — вытянута в штрих по движению.
// Сколько капель — по силе дождя и скорости; на мокрой трассе за болидом впереди (ближе 40 м) — ещё брызги от него.
// Холст в половину разрешения — дёшево (100–200 капель — доли миллисекунды).
const MAX = 220
const SCALE = 0.5

export function createRainDrops() {
  const c = document.createElement('canvas')
  c.id = 'raindrops'
  Object.assign(c.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '1' })
  document.body.appendChild(c)
  const g = c.getContext('2d')
  let w = 0
  let h = 0
  const drops = []
  let acc = 0
  let shown = false

  function resize() {
    w = Math.max(1, Math.round(innerWidth * SCALE))
    h = Math.max(1, Math.round(innerHeight * SCALE))
    c.width = w
    c.height = h
  }
  resize()
  addEventListener('resize', resize)

  function spawn(big = 1) {
    if (drops.length >= MAX) drops.shift()
    const r = (2.5 + Math.random() * 5.5) * big * (h / 450)
    drops.push({ x: Math.random() * w, y: Math.random() * h, r, vx: 0, vy: 0, life: 4 + Math.random() * 6, age: 0, stick: Math.random() * 0.6 })
  }

  // заготовка капли: рисуется один раз, в кадре — только drawImage (градиенты в кадре давали мусор и рывки)
  const S = 64
  const sprite = document.createElement('canvas')
  sprite.width = sprite.height = S
  {
    const sg = sprite.getContext('2d')
    const r = S / 2 - 1
    sg.translate(S / 2, S / 2)
    const body = sg.createRadialGradient(0, -r * 0.25, r * 0.1, 0, 0, r)
    body.addColorStop(0, 'rgba(255,255,255,0.05)')
    body.addColorStop(0.7, 'rgba(200,215,230,0.08)')
    body.addColorStop(1, 'rgba(10,14,20,0.35)')
    sg.fillStyle = body
    sg.beginPath()
    sg.arc(0, 0, r, 0, Math.PI * 2)
    sg.fill()
    sg.fillStyle = 'rgba(255,255,255,0.55)'
    sg.beginPath()
    sg.arc(-r * 0.3, -r * 0.35, r * 0.22, 0, Math.PI * 2)
    sg.fill()
    sg.strokeStyle = 'rgba(255,255,255,0.18)'
    sg.lineWidth = r * 0.18
    sg.beginPath()
    sg.arc(0, 0, r * 0.8, Math.PI * 0.15, Math.PI * 0.85)
    sg.stroke()
  }
  function draw(d, alpha) {
    const sp = Math.hypot(d.vx, d.vy)
    const stretch = Math.min(6, 1 + sp / (d.r * 6))
    g.globalAlpha = alpha
    if (stretch > 1.05) {
      g.setTransform(1, 0, 0, 1, d.x, d.y)
      g.rotate(Math.atan2(d.vy, d.vx) - Math.PI / 2)
      g.scale(1, stretch)
      g.drawImage(sprite, -d.r, -d.r, d.r * 2, d.r * 2)
      g.setTransform(1, 0, 0, 1, 0, 0)
    } else g.drawImage(sprite, d.x - d.r, d.y - d.r, d.r * 2, d.r * 2)
  }

  return {
    // rain 0…1 — сила дождя; speed — км/ч; mode — камера (chase — «линза ТВ», иначе на болиде); spray 0…1 — брызги от болида впереди
    update(dt, rain, speed, mode, spray = 0, paused = false) {
      const active = rain > 0.02 || spray > 0.02 || drops.length
      if (!active) {
        if (shown) {
          g.clearRect(0, 0, w, h)
          shown = false
        }
        return
      }
      shown = true
      const onCar = mode !== 'chase'
      if (!paused) {
        // новые капли: чем сильнее дождь и быстрее едем (больше капель ловит стекло), тем больше
        const rate = rain * (onCar ? 30 + speed * 0.25 : 18 + speed * 0.06) + spray * 60
        acc += rate * dt
        while (acc > 1) {
          acc -= 1
          spawn(spray > rain ? 0.7 : 1)
        }
        const cx = w / 2
        const cy = h * 0.55
        const air = Math.min(1, Math.max(0, (speed - 60) / 140)) // насколько сдувает
        for (let i = drops.length - 1; i >= 0; i--) {
          const d = drops[i]
          d.age += dt
          // сначала держится (поверхностное натяжение), потом едет
          if (d.age > d.stick) {
            if (onCar && air > 0) {
              // от центра к краям и вверх — как по визору на скорости
              const dx = d.x - cx
              const dy = d.y - cy
              const len = Math.hypot(dx, dy) || 1
              const push = air * h * 0.9
              d.vx += (dx / len) * push * dt
              d.vy += ((dy / len) * 0.4 - 0.8) * push * dt
            } else {
              // стекает вниз, тяжёлые быстрее
              d.vy += (d.r / (h / 450)) * 9 * dt
            }
            d.vx *= Math.exp(-dt * 2)
            d.vy *= Math.exp(-dt * (onCar && air > 0 ? 1 : 3))
            d.x += d.vx * dt
            d.y += d.vy * dt
          }
          if (d.age > d.life || d.x < -20 || d.x > w + 20 || d.y < -20 || d.y > h + 20) drops.splice(i, 1)
        }
      }
      g.clearRect(0, 0, w, h)
      g.globalAlpha = 1
      for (const d of drops) {
        const fade = Math.min(1, d.age * 6, (d.life - d.age) * 1.5)
        draw(d, Math.max(0, fade))
      }
    },
    clear() {
      drops.length = 0
    },
  }
}
