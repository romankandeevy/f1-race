// Звук болида из настоящих записей Формулы-1 (Рома 29.10: «найди пиздатый звук мотора и всего болида»).
// Мотор — петли с Гудвуда (Викисклад, Edvvc, CC BY-SA 3.0, см. public/sounds/CREDITS.md):
//   f1_engine.wav — V10 Red Bull-Cosworth RB1 (2005) на ровных высоких оборотах; высота тона идёт за оборотами игры;
//   f1_idle.wav   — V8 Williams-Cosworth FW32 (2010) на холостых: болид стоит и газ отпущен.
// Два слоя одной петли: под газом — открытый и злой (лёгкое насыщение), на сбросе — глухой, как через выхлоп.
// На переключении вверх — провал и короткий щелчок. Остальной болид: ветер на скорости, гул поребриков, шорох гравия,
// визг шин, скрежет днища, удары, дождь. Моторы трёх ближайших соперников — с расстоянием, стороной и эффектом Доплера.
//
// Против гула: звук спит, пока открыты настройки, вкладка в фоне или нажата M.
// Браузер разрешает звук только после действия игрока — включаемся на первую клавишу или клик.
const URL_ENGINE = '/sounds/f1_engine.wav'
const URL_IDLE = '/sounds/f1_idle.wav'
const URL_SQUEAL = '/sounds/tyre_squeal.wav'
const URL_SCRAPE = '/sounds/scrape.wav'
// удары (CC0, «75 CC0 breaking / falling / hit sfx», rubberduck): хруст — сильный удар, металл — стена и корпус, глухие — касания
const HITS = { crunch: ['breaking_01', 'breaking_02'], metal: ['metal_hit_02', 'metal_hit_03', 'metal_hit_06'], touch: ['hit_04', 'hit_05'] }
const MASTER = 0.4
const BOT_VOICES = 3 // столько ближайших соперников слышно одновременно
const BOT_FAR = 120 // м — дальше соперника не слышно

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
// обороты внутри передачи (state.rpm 0,55…1) → скорость петли: запись на ~634 Гц, в игре от ~430 до ~710 Гц
const engineRate = (rpm) => 0.68 + 0.44 * Math.min(1, Math.max(0, (rpm - 0.55) / 0.45))

export function createSound() {
  let ctx = null
  let n = null
  let muted = false
  let paused = false
  let lastGear = 1
  let starting = false
  let volume = 1 // общая громкость из настроек, 0…1

  async function start() {
    if (starting || ctx) {
      wake()
      return
    }
    starting = true
    ctx = new AudioContext()
    const load = async (url) => ctx.decodeAudioData(await fetch(url).then((r) => r.arrayBuffer()))
    const [engineBuf, idleBuf, squealBuf, scrapeBuf] = await Promise.all([load(URL_ENGINE), load(URL_IDLE), load(URL_SQUEAL), load(URL_SCRAPE)])
    const hitBufs = {}
    for (const [kind, names] of Object.entries(HITS)) hitBufs[kind] = await Promise.all(names.map((nm) => load(`/sounds/hits/${nm}.mp3`)))

    const master = ctx.createGain()
    master.gain.value = MASTER * volume
    master.connect(ctx.destination)
    const gain = (v, to = master) => {
      const g = ctx.createGain()
      g.gain.value = v
      g.connect(to)
      return g
    }
    const filter = (type, freq, q = 0.7) => {
      const f = ctx.createBiquadFilter()
      f.type = type
      f.frequency.value = freq
      f.Q.value = q
      return f
    }
    const loop = (buf, to) => {
      const s = ctx.createBufferSource()
      s.buffer = buf
      s.loop = true
      s.start(0, Math.random() * buf.duration)
      s.connect(to)
      return s
    }
    // шумы: «коричневый» (глухой, гравий и поребрики) и белый (ветер, дождь, щелчок)
    const noise = (brown) => {
      const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
      const d = b.getChannelData(0)
      let last = 0
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1
        last = last * 0.97 + w * 0.03
        d[i] = brown ? last * 6 : w * 0.5
      }
      return b
    }
    const brownBuf = noise(true)
    const whiteBuf = noise(false)

    // ---- мотор игрока ----
    const shift = gain(1) // провал на переключении
    const onGain = gain(0, shift)
    const onFilter = filter('lowpass', 9000)
    onFilter.connect(onGain)
    const drive = ctx.createWaveShaper()
    const curve = new Float32Array(1024)
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1
      curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6)
    }
    drive.curve = curve
    drive.connect(onFilter)
    const offGain = gain(0, shift)
    const offFilter = filter('lowpass', 900, 1.1)
    offFilter.connect(offGain)
    const engine = ctx.createBufferSource()
    engine.buffer = engineBuf
    engine.loop = true
    engine.start(0, Math.random() * engineBuf.duration)
    engine.connect(drive)
    engine.connect(offFilter)
    const idleGain = gain(0)
    const idle = loop(idleBuf, idleGain)
    // щелчок на переключении: короткий всплеск шума через полосовой фильтр
    const crackGain = gain(0)
    const crackFilter = filter('bandpass', 1600, 1.4)
    crackFilter.connect(crackGain)
    loop(whiteBuf, crackFilter)

    // ---- болид ----
    const gravelGain = gain(0)
    loop(brownBuf, gravelGain)
    const windGain = gain(0)
    const windFilter = filter('bandpass', 650, 0.5)
    windFilter.connect(windGain)
    loop(whiteBuf, windFilter)
    // поребрик: глухой гул «дробью» с частотой ударов о гребни (скорость / шаг гребня)
    const kerbGain = gain(0)
    const kerbAm = gain(0.5, kerbGain)
    const kerbFilter = filter('lowpass', 260, 0.9)
    kerbFilter.connect(kerbAm)
    loop(brownBuf, kerbFilter)
    const kerbLfo = ctx.createOscillator()
    kerbLfo.type = 'square'
    kerbLfo.frequency.value = 20
    const kerbDepth = gain(0.5, kerbAm.gain)
    kerbLfo.connect(kerbDepth)
    kerbLfo.start()
    const rainGain = gain(0)
    const rainFilter = filter('highpass', 2200, 0.5)
    rainFilter.connect(rainGain)
    loop(whiteBuf, rainFilter)
    const squealGain = gain(0)
    const squeal = loop(squealBuf, squealGain)
    const scrapeGain = gain(0)
    const scrape = loop(scrapeBuf, scrapeGain)

    // ---- моторы соперников: голоса по ближайшим ----
    const voices = []
    for (let i = 0; i < BOT_VOICES; i++) {
      const pan = ctx.createStereoPanner()
      pan.connect(master)
      const g = gain(0, pan)
      const lp = filter('lowpass', 4000)
      lp.connect(g)
      const s = loop(engineBuf, lp)
      voices.push({ s, g, lp, pan, prevD: null })
    }

    n = { master, shift, engine, onGain, offGain, onFilter, idle, idleGain, crackGain, gravelGain, windGain, kerbGain, kerbLfo, rainGain, squeal, squealGain, scrape, scrapeGain, voices, hitBufs }
    starting = false
    wake()
  }

  // звук спит, если игрок его выключил, открыты настройки или вкладка не на экране
  function wake() {
    if (!ctx) return
    const sleep = muted || paused || document.hidden
    if (sleep && ctx.state === 'running') ctx.suspend()
    if (!sleep && ctx.state === 'suspended') ctx.resume()
  }

  addEventListener('keydown', start)
  addEventListener('pointerdown', start)
  document.addEventListener('visibilitychange', wake)

  const set = (param, value, time = 0.04) => param.setTargetAtTime(value, ctx.currentTime, time)
  let lastHit = 0
  const play = (kind, vol) => {
    const list = n.hitBufs[kind]
    const s = ctx.createBufferSource()
    s.buffer = list[Math.floor(Math.random() * list.length)]
    s.playbackRate.value = 0.88 + Math.random() * 0.24 // каждый удар чуть другой
    const g = ctx.createGain()
    g.gain.value = vol
    s.connect(g)
    g.connect(n.master)
    s.start()
  }

  // моторы соперников: три ближайших к камере, громкость и глухость по расстоянию, сторона, Доплер
  function updateBots(bots, camera, dt) {
    const c = camera.position
    const e = camera.matrixWorld.elements // правый вектор камеры — первый столбец матрицы
    const rx = e[0]
    const rz = e[2]
    const near = []
    for (const b of bots || []) {
      if (b.gone) continue
      const t = b.v.body.translation()
      const d = Math.hypot(t.x - c.x, t.z - c.z)
      if (d < BOT_FAR) near.push({ b, d, x: t.x - c.x, z: t.z - c.z })
    }
    near.sort((a, b) => a.d - b.d)
    n.voices.forEach((vc, i) => {
      const it = near[i]
      if (!it) {
        set(vc.g.gain, 0, 0.2)
        vc.prevD = null
        return
      }
      const k = 1 - it.d / BOT_FAR
      const st = it.b.v.state
      // Доплер: приближается — выше, удаляется — ниже (по изменению расстояния за кадр)
      const vr = vc.prevD === null || dt <= 0 ? 0 : (it.d - vc.prevD) / dt
      vc.prevD = it.d
      const doppler = Math.min(1.12, Math.max(0.9, 343 / (343 + vr)))
      set(vc.s.playbackRate, engineRate(st.rpm) * doppler, 0.05)
      set(vc.g.gain, 0.5 * k * k * (0.35 + 0.65 * (it.b.v.throttle || 0)), 0.08)
      set(vc.lp.frequency, 700 + 7000 * k * k, 0.1)
      set(vc.pan.pan, Math.max(-1, Math.min(1, (it.x * rx + it.z * rz) / Math.max(it.d, 1))), 0.08)
    })
  }

  return {
    // громкость 0…1: действует сразу, а если звук ещё не запущен — при запуске
    setVolume(v) {
      volume = Math.min(1, Math.max(0, v))
      if (n) n.master.gain.setTargetAtTime(MASTER * volume, ctx.currentTime, 0.05)
    },

    // удар: strength 0…1 (тяжесть, wear.js sev), near 0…1 — насколько близко к камере (боты дальше — тише)
    hit(strength, near = 1) {
      if (!n || paused || muted || near <= 0.02) return
      const t = ctx.currentTime
      if (t - lastHit < 0.08) return // в одном ударе событий много — звучит один раз
      lastHit = t
      const v = (0.35 + 0.9 * strength) * near
      play('metal', v)
      if (strength > 0.4) play('crunch', v * 0.9) // сильный удар — ещё и хруст карбона
    },

    // касание болидов без повреждений: глухой стук, громкость по силе
    touch(strength, near = 1) {
      if (!n || paused || muted || near <= 0.02) return
      const t = ctx.currentTime
      if (t - lastHit < 0.25) return
      lastHit = t
      play('touch', (0.2 + 0.6 * strength) * near)
    },

    toggleMute() {
      muted = !muted
      wake()
      return muted
    },

    // world: { bots, camera, rain, dt } — соперники и погода
    update(v, input, isPaused, world = {}) {
      if (isPaused !== paused) {
        paused = isPaused
        wake()
      }
      if (!n || paused || muted) return
      const st = v.state
      const speed = st.speedKmh / 3.6
      const throttle = input.throttle

      // мотор: высота тона по оборотам; стоит и газ отпущен — холостые
      const idleK = 1 - smooth(1, 4, speed + throttle * 10)
      set(n.engine.playbackRate, engineRate(st.rpm), 0.03)
      set(n.onGain.gain, (1 - idleK) * (0.22 + 0.68 * throttle))
      set(n.offGain.gain, (1 - idleK) * 0.5 * (1 - throttle))
      set(n.onFilter.frequency, 2800 + 6200 * throttle)
      set(n.idleGain.gain, 0.55 * idleK, 0.08)
      set(n.idle.playbackRate, 1 + 0.15 * throttle, 0.1)

      // переключение вверх: короткий провал, щелчок и возврат
      if (typeof st.gear === 'number' && st.gear > lastGear) {
        const t = ctx.currentTime
        n.shift.gain.cancelScheduledValues(t)
        n.shift.gain.setValueAtTime(0.3, t)
        n.shift.gain.linearRampToValueAtTime(1, t + 0.08)
        n.crackGain.gain.cancelScheduledValues(t)
        n.crackGain.gain.setValueAtTime(0.0001 + 0.35 * throttle, t)
        n.crackGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
      }
      lastGear = typeof st.gear === 'number' ? st.gear : lastGear

      // ветер: растёт с квадратом скорости
      set(n.windGain.gain, Math.min(0.3, 0.26 * (speed / 85) ** 2), 0.1)
      // гравий и трава
      const offTrack = st.surfaces.filter((s) => s !== 'asphalt' && s !== 'kerb').length / 4
      set(n.gravelGain.gain, 0.3 * offTrack * smooth(1, 25, speed))
      // поребрики: гул, частота ударов о гребни ~ скорость / 0,6 м
      const kerb = st.surfaces.filter((s) => s === 'kerb').length / 4
      set(n.kerbGain.gain, 0.55 * kerb * smooth(3, 20, speed), 0.03)
      set(n.kerbLfo.frequency, Math.max(4, speed / 0.6), 0.05)
      // дождь
      set(n.rainGain.gain, 0.16 * (world.rain || 0), 0.3)

      // визг шин: самое сильное скольжение по асфальту (блокировка/пробуксовка — полный, увод — по мере перебора); по воде не визжит
      let slide = 0
      for (const w of v.wheels) {
        if (!w.contact || (w.surface !== 'asphalt' && w.surface !== 'kerb')) continue
        slide = Math.max(slide, w.sliding ? 1 : smooth(0.09, 0.22, Math.abs(w.slip)))
      }
      const dry = 1 - smooth(0.2, 0.5, v.wet || 0)
      set(n.squealGain.gain, 0.32 * slide * dry * smooth(3, 15, speed), 0.06)
      set(n.squeal.playbackRate, 0.9 + 0.25 * Math.min(1, speed / 60), 0.1)
      // скрежет: днище по асфальту (сила трения планки) — громче при сильном прижатии и на скорости
      set(n.scrapeGain.gain, 0.5 * Math.min(1, st.plankContact / 12000) * smooth(2, 20, speed), 0.05)
      set(n.scrape.playbackRate, 0.8 + 0.5 * Math.min(1, speed / 60), 0.1)

      if (world.camera) updateBots(world.bots, world.camera, world.dt || 0)
    },
  }
}
