// Звук мотора из настоящей записи (public/sounds/engine.wav — раллийный мотор,
// «Car Engine Loop 96kHz 4s», qubodup, CC-BY 3.0, см. public/sounds/CREDITS.md).
// Запись крутится по кругу, высота тона идёт за оборотами. Два слоя одной записи:
// под газом — открытый и резкий, при сбросе — глухой; сверху октава выше, она нарастает
// к отсечке. На переключении передач — короткий провал. На гравии и траве — тихий шорох.
//
// Визг шин (блокировка, пробуксовка, занос на асфальте) и скрежет днища по асфальту — петли из настоящих записей
// (tyre_squeal.wav, scrape.wav — CC0, см. CREDITS.md): громкость и высота тона по физике каждый кадр.
//
// Против гула: звук спит, пока открыты настройки, вкладка в фоне или нажата M.
// Браузер разрешает звук только после действия игрока — включаемся на первую клавишу или клик.
const URL_ENGINE = '/sounds/engine.wav'
const URL_SQUEAL = '/sounds/tyre_squeal.wav'
const URL_SCRAPE = '/sounds/scrape.wav'
const MASTER = 0.4

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

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
    const [buffer, squealBuf, scrapeBuf] = await Promise.all([load(URL_ENGINE), load(URL_SQUEAL), load(URL_SCRAPE)])

    const master = ctx.createGain()
    master.gain.value = MASTER * volume
    master.connect(ctx.destination)
    const shift = ctx.createGain() // провал на переключении
    shift.connect(master)

    const source = (rateMul) => {
      const s = ctx.createBufferSource()
      s.buffer = buffer
      s.loop = true
      s.start(0, Math.random() * buffer.duration)
      s.rateMul = rateMul
      return s
    }
    const filter = (freq, q = 0.7) => {
      const f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = freq
      f.Q.value = q
      return f
    }
    const gain = (v) => {
      const g = ctx.createGain()
      g.gain.value = v
      return g
    }

    // под газом: открытый звук с лёгким «рычанием» (мягкое насыщение)
    const base = source(1)
    const onFilter = filter(9000)
    const drive = ctx.createWaveShaper()
    const curve = new Float32Array(1024)
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1
      curve[i] = Math.tanh(1.8 * x) / Math.tanh(1.8)
    }
    drive.curve = curve
    const onGain = gain(0)
    base.connect(drive)
    drive.connect(onFilter)
    onFilter.connect(onGain)
    onGain.connect(shift)

    // при сбросе газа: тот же мотор глухо, как через выхлоп
    const offFilter = filter(700, 1.2)
    const offGain = gain(0)
    base.connect(offFilter)
    offFilter.connect(offGain)
    offGain.connect(shift)

    // октава выше: на высоких оборотах даёт гоночный визг мотора
    const high = source(2)
    const highFilter = filter(6000)
    const highGain = gain(0)
    high.connect(highFilter)
    highFilter.connect(highGain)
    highGain.connect(shift)

    // шорох гравия и травы: шум через низкий фильтр
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const nd = noiseBuf.getChannelData(0)
    let last = 0
    for (let i = 0; i < nd.length; i++) {
      last = last * 0.97 + (Math.random() * 2 - 1) * 0.03 // «коричневый» шум — глухой, без шипения
      nd[i] = last * 6
    }
    const gravelSrc = ctx.createBufferSource()
    gravelSrc.buffer = noiseBuf
    gravelSrc.loop = true
    gravelSrc.start()
    const gravelGain = gain(0)
    gravelSrc.connect(gravelGain)
    gravelGain.connect(master)

    // визг шин и скрежет днища: петли, пока молчат (громкость 0)
    const loop = (buf) => {
      const s = ctx.createBufferSource()
      s.buffer = buf
      s.loop = true
      s.start(0, Math.random() * buf.duration)
      const g = gain(0)
      s.connect(g)
      g.connect(master)
      return { s, g }
    }
    const squeal = loop(squealBuf)
    const scrape = loop(scrapeBuf)

    n = { master, shift, sources: [base, high], onGain, offGain, onFilter, highGain, gravelGain, squeal, scrape }
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

  return {
    // громкость 0…1: действует сразу, а если звук ещё не запущен — при запуске
    setVolume(v) {
      volume = Math.min(1, Math.max(0, v))
      if (n) n.master.gain.setTargetAtTime(MASTER * volume, ctx.currentTime, 0.05)
    },

    toggleMute() {
      muted = !muted
      wake()
      return muted
    },

    update(v, input, isPaused) {
      if (isPaused !== paused) {
        paused = isPaused
        wake()
      }
      if (!n || paused || muted) return
      const st = v.state
      const speed = st.speedKmh / 3.6
      const throttle = input.throttle

      // обороты внутри передачи 0..1 → скорость записи 0,9..2,1 (высота тона)
      const r = Math.min(1, Math.max(0, (st.rpm - 0.55) / 0.45))
      const idle = speed < 1 && throttle === 0
      const rate = idle ? 0.8 : 0.9 + 1.2 * r
      for (const s of n.sources) set(s.playbackRate, rate * s.rateMul, 0.03)

      // газ открывает звук, сброс делает глухим
      set(n.onGain.gain, idle ? 0.25 : 0.25 + 0.6 * throttle)
      set(n.offGain.gain, idle ? 0.35 : 0.55 * (1 - throttle))
      set(n.onFilter.frequency, 2500 + 6500 * throttle)
      set(n.highGain.gain, 0.22 * throttle * smooth(0.4, 1, r))

      // переключение вверх: короткий провал и возврат
      if (typeof st.gear === 'number' && st.gear > lastGear) {
        const t = ctx.currentTime
        n.shift.gain.cancelScheduledValues(t)
        n.shift.gain.setValueAtTime(0.35, t)
        n.shift.gain.linearRampToValueAtTime(1, t + 0.09)
      }
      lastGear = typeof st.gear === 'number' ? st.gear : lastGear

      const offTrack = st.surfaces.filter((s) => s !== 'asphalt').length / 4
      set(n.gravelGain.gain, 0.3 * offTrack * smooth(1, 25, speed))

      // визг шин: самое сильное скольжение по асфальту (блокировка/пробуксовка — полный, увод — по мере перебора); по воде не визжит
      let slide = 0
      for (const w of v.wheels) {
        if (!w.contact || (w.surface !== 'asphalt' && w.surface !== 'kerb')) continue
        slide = Math.max(slide, w.sliding ? 1 : smooth(0.09, 0.22, Math.abs(w.slip)))
      }
      const dry = 1 - smooth(0.2, 0.5, v.wet || 0)
      set(n.squeal.g.gain, 0.32 * slide * dry * smooth(3, 15, speed), 0.06)
      set(n.squeal.s.playbackRate, 0.9 + 0.25 * Math.min(1, speed / 60), 0.1)
      // скрежет: днище по асфальту (сила трения планки) — громче при сильном прижатии и на скорости
      set(n.scrape.g.gain, 0.5 * Math.min(1, st.plankContact / 12000) * smooth(2, 20, speed), 0.05)
      set(n.scrape.s.playbackRate, 0.8 + 0.5 * Math.min(1, speed / 60), 0.1)
    },
  }
}
