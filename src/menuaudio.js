// Музыка меню и звуки интерфейса (Рома 31.10). Свой маленький AudioContext — звук гонки (sound.js) на паузе и в меню спит,
// а музыка играет как раз там. Музыка (public/sounds/music/menu.m4a, своя: tools/sound/make_ambient.mjs) звучит в главном
// меню и на экранах итогов, плавно появляется и уходит; в гонке молчит. Звуки интерфейса — щелчок при переходе по пунктам,
// «да» на выбор, «назад» на Esc, переключение вкладок, тихий тик при наведении мышью. Громкости — Настройки → Звук.
// Браузер разрешает звук только после действия игрока: включаемся на первую клавишу или клик.
const UI = ['move', 'select', 'back', 'tab', 'hover']
const MENUS = '#screens:not([hidden]), #menu:not([hidden]), #results:not([hidden]), #setup:not([hidden])'
const FADE = 1.2 // с

export function createMenuAudio() {
  let ctx = null
  let master = null
  let musicGain = null
  let uiGain = null
  const bufs = {}
  let music = null
  let want = false // музыка должна играть
  let volume = 1
  let musicVol = 0.5
  let uiVol = 0.7
  let starting = false
  let lastHover = 0

  async function start() {
    if (ctx || starting) return
    starting = true
    ctx = new AudioContext({ latencyHint: 'interactive' })
    master = new GainNode(ctx, { gain: volume })
    master.connect(ctx.destination)
    musicGain = new GainNode(ctx, { gain: 0 })
    musicGain.connect(master)
    uiGain = new GainNode(ctx, { gain: uiVol })
    uiGain.connect(master)
    const load = async (url) => ctx.decodeAudioData(await fetch(url).then((r) => r.arrayBuffer()))
    await Promise.all(UI.map(async (k) => (bufs[k] = await load(`/sounds/ui/${k}.wav`).catch(() => null))))
    bufs.music = await load('/sounds/music/menu.m4a').catch(() => null)
    starting = false
    apply()
  }
  // включиться с первого действия игрока
  const unlock = () => {
    start()
    if (ctx?.state === 'suspended' && !document.hidden) ctx.resume()
  }
  addEventListener('keydown', unlock, true)
  addEventListener('pointerdown', unlock, true)
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return
    if (document.hidden) ctx.suspend()
    else ctx.resume()
  })

  function apply() {
    if (!ctx) return
    const t = ctx.currentTime
    master.gain.setTargetAtTime(volume, t, 0.05)
    uiGain.gain.setTargetAtTime(uiVol, t, 0.05)
    const on = want && musicVol > 0 && bufs.music
    if (on && !music) {
      music = new AudioBufferSourceNode(ctx, { buffer: bufs.music, loop: true })
      // у сжатого файла в начале тишина кодека — петля без неё
      music.loopStart = 0.05
      music.loopEnd = bufs.music.duration - 0.03
      music.connect(musicGain)
      music.start()
    }
    musicGain.gain.cancelScheduledValues(t)
    musicGain.gain.setTargetAtTime(on ? musicVol * 0.55 : 0, t, FADE / 3)
  }

  function play(name, vol = 1) {
    if (!ctx || !bufs[name] || uiVol <= 0) return
    const s = new AudioBufferSourceNode(ctx, { buffer: bufs[name], playbackRate: 0.98 + Math.random() * 0.04 })
    const g = new GainNode(ctx, { gain: vol })
    s.connect(g).connect(uiGain)
    s.start()
  }

  // клавиши и мышь в меню: какой звук
  const inMenu = () => !!document.querySelector(MENUS)
  addEventListener('keydown', (e) => {
    if (e.repeat && !e.code.startsWith('Arrow')) return
    if (!inMenu() || (e.target instanceof HTMLInputElement && e.target.type === 'text')) return
    if (e.code.startsWith('Arrow')) play('move', 0.8)
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') play('select')
    else if (e.code === 'Escape') play('back')
    else if (e.code === 'KeyQ' || e.code === 'KeyE') play('tab')
  })
  addEventListener('click', (e) => {
    const el = e.target.closest?.('button, [data-act], [data-i], [data-row], [data-tab], .sc-row, .sc-item, .sc-mode, .sc-tcard, .sc-chip, .sc-seg span, li')
    if (el && el.closest(MENUS)) play('select', 0.85)
  })
  addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('button, .sc-row, .sc-item, .sc-mode, .sc-tcard, [data-act]')
    if (!el || !el.closest(MENUS) || el === e.relatedTarget?.closest?.('button, .sc-row, .sc-item, .sc-mode, .sc-tcard, [data-act]')) return
    const now = performance.now()
    if (now - lastHover < 60) return
    lastHover = now
    play('hover', 0.5)
  })

  return {
    // музыка: true — в меню / на итогах, false — в гонке
    setMusic(on) {
      if (on === want) return
      want = on
      apply()
    },
    setVolume(v) {
      volume = v
      apply()
    },
    setMusicVolume(v) {
      musicVol = v
      apply()
    },
    setUiVolume(v) {
      uiVol = v
      apply()
    },
    play,
  }
}
