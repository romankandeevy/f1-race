// Звук болида — устроен как у гоночных студий (исследование Ромы 29.10 «звук как у студий, но бесплатно»):
// шины микса → компрессор → лимитер; мотор из набора петель по оборотам × газу, остальное — от физики.
//
// Мотор: петли V10 (Lexus LFA, 4,8 л, до 9000 об/мин), записанные из физического симулятора engine-sim (ange-yaghi, MIT;
// public/sounds/CREDITS.md, как перезаписать — tools/engine-sound/README.md): под газом 4000…9000 об/мин,
// на сбросе 5000/7000/9000, холостые. V12 Ferrari до 17 000 был раньше — на скорости превращался в писк (Рома 29.10).
// «Рык» (Рома: «почётче, покрасочнее, чтобы рычал»): подъём низов (200 Гц), лёгкий перегруз, срез верха выше 5 кГц. Звучат две соседние по оборотам петли каждого набора (смешивание равной
// мощности), высота каждой — обороты / обороты записи; газ смешивает «под газом» и «на сбросе». Обороты
// из физики сглаживаются (иначе тон дрожит). Сверху: на сбросе тон темнеет, хлопки в выхлоп с оборотов,
// отсечка (дребезг громкости ~20 Гц), переключение — короткий провал и «клац» коробки. Воя MGU-K нет (на скорости превращался в писк).
// Шины и поверхности: визг по уводу относительно пика шины (передние и задние отдельно, быстрая атака,
// медленный спад), блокировка — громче и «площе»; шорох асфальта, трава, гравий с камешками, поребрики — гул
// с частотой «скорость / шаг гребня»; скрежет днища; по мокрой — шипение воды вместо визга.
// Удары — слоями: глухой удар кузова, металл, хруст карбона и разлёт обломков, сила — Δv, в пространстве.
// Соперники — PannerNode (equalpower), слушатель — камера, 4 ближайших голоса, дальше — глуше, Доплер.
// Ещё: ветер (∝ скорости², в кабине громче, режим прямой — «вжух»), дождь, писк огней старта, гайковёрты в боксах.
// Кабина (onboard, T-камера, нос) — больше ветра, внешний мир глуше; камера сзади — «трансляция».
//
// Против гула: звук спит, пока открыты настройки, вкладка в фоне или нажата M.
// Браузер разрешает звук только после действия игрока — включаемся на первую клавишу или клик.
// визг — длинные ровные записи (10 и 25 с, CC0), а не склейка коротких взвизгов («как тряпкой по стеклу», Рома 29.10)
const URL_SQUEAL = '/sounds/tyre_squeal.wav'
const URL_SQUEAL2 = '/sounds/tyre_squeal2.wav'
const URL_SCRAPE = '/sounds/scrape.wav'
// удары — записи настоящих ударов (Freesound, CC0; прежние «стекло» и «печенька» убраны, Рома 29.10):
// crash — авария машины с хвостом обломков, wall — удар об металлическое ограждение, metal — тяжёлый удар по металлу, thump — по кузову
const HITS = { crash: 2, wall: 5, metal: 4, thump: 5 }
// моторы на выбор (Настройки → Звук; Рома 29.10: «сделай супер-хороший звук мотора» — выбирает на слух):
// петли public/sounds/engine/<id>_on_<об/мин>.wav, <id>_off_<об/мин>.wav, <id>_idle.wav — все из engine-sim (MIT).
// min/max — обороты звука на ходу при state.rpm 0 и 1 (на табло своя шкала); bot — три петли для соперников
export const ENGINES = {
  v10: { on: [4000, 5000, 6000, 7000, 8000, 9000], off: [5000, 7000, 9000], bot: [5000, 7000, 9000], min: 3800, max: 9400 },
  f136: { on: [4000, 5000, 6000, 7000, 8000, 9000], off: [5000, 7000, 9000], bot: [5000, 7000, 9000], min: 3800, max: 9300 },
  ls: { on: [2500, 3300, 4100, 4900, 5700, 6500], off: [3000, 4700, 6500], bot: [3300, 4900, 6500], min: 2300, max: 6700 },
}
const MASTER = 0.55
// трибуны и гаражи (Рома 31.10: «зрители и звуки паддока»; записи синтезированы — tools/sound/make_ambient.mjs):
// у каждой трибуны свой источник в пространстве (гул толпы, петля 20 с), у боксов — гул гаражей; трибуны оживают,
// когда рядом проносится болид, и ликуют на финише и обгонах (sound.cheer)
const URL_CROWD = '/sounds/amb/crowd.wav'
const URL_CHEER = '/sounds/amb/cheer.wav'
const URL_PADDOCK = '/sounds/amb/paddock.wav'
const CROWD_VOL = 0.55
const CROWD_NEAR = 160 // м: ближе болид — трибуна громче
const BOT_VOICES = 4 // столько ближайших соперников слышно полным голосом
const BOT_FAR = 220 // м — дальше голос выключен
const C = 343 // м/с, скорость звука (Доплер)
const PEAK_SLIP = { front: Math.tan(Math.PI / 3) / 15, rear: Math.tan(Math.PI / 3) / 16 } // угол увода пика шины (tuning: tireC 1,5, B 15/16)

const clamp = (x, a, b) => Math.min(b, Math.max(a, x))
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const rand = (a, b) => a + Math.random() * (b - a)
// обороты игры (state.rpm, 1 — отсечка) → обороты мотора для звука
const engineRpm = (E, rpm) => Math.max(E.min, E.max * rpm)
// веса двух соседних петель набора для оборотов e: [индекс, вес, индекс, вес], равная мощность при смешивании
function blend(set, e) {
  if (e <= set[0]) return [0, 1, 0, 0]
  const last = set.length - 1
  if (e >= set[last]) return [last, 1, last, 0]
  let i = 0
  while (set[i + 1] < e) i++
  const t = (e - set[i]) / (set[i + 1] - set[i])
  return [i, Math.cos((t * Math.PI) / 2), i + 1, Math.sin((t * Math.PI) / 2)]
}

export function createSound() {
  let ctx = null
  let n = null
  let muted = false
  let paused = false
  let starting = false
  let volume = 1 // общая громкость из настроек, 0…1
  let engineId = 'ls'
  let E = ENGINES.ls
  let engineLoad = 0 // номер загрузки мотора: старая, если игрок успел переключить ещё раз, не применяется
  // память между кадрами
  const mem = { slipF: 0, slipR: 0, rpm: 3000, gear: 1, lift: 99, nextPop: 0, aero: false, lit: 0, pitPhase: null, camX: null, camY: 0, camZ: 0, lastHit: 0, stoneAcc: 0 }

  async function start() {
    if (starting || ctx) {
      wake()
      return
    }
    starting = true
    ctx = new AudioContext({ latencyHint: 'interactive' })
    const load = async (url) => ctx.decodeAudioData(await fetch(url).then((r) => r.arrayBuffer()))
    const [squealBuf, squeal2Buf, scrapeBuf] = await Promise.all([load(URL_SQUEAL), load(URL_SQUEAL2), load(URL_SCRAPE)])
    const hitBufs = {}
    for (const [kind, count] of Object.entries(HITS)) hitBufs[kind] = await Promise.all(Array.from({ length: count }, (_, i) => load(`/sounds/hits/${kind}_${i + 1}.wav`)))

    // ---- шины микса: всё → master → компрессор → лимитер → выход ----
    const comp = new DynamicsCompressorNode(ctx, { threshold: -18, knee: 6, ratio: 3, attack: 0.01, release: 0.2 })
    const limiter = new DynamicsCompressorNode(ctx, { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.1 })
    comp.connect(limiter).connect(ctx.destination)
    const master = new GainNode(ctx, { gain: MASTER * volume })
    master.connect(comp)
    const gain = (v, to = master) => {
      const g = new GainNode(ctx, { gain: v })
      g.connect(to)
      return g
    }
    // внешний мир (соперники, удары) в кабине глуше
    const outside = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 18000, Q: 0.5 })
    outside.connect(master)
    const bus = {
      engine: gain(0.9),
      cars: gain(0.75, outside),
      tyres: gain(0.6),
      impacts: gain(0.85, outside),
      ambience: gain(0.5),
    }
    const loop = (buf, to, rate = 1) => {
      const s = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true, playbackRate: rate })
      s.connect(to)
      s.start(0, Math.random() * buf.duration)
      return s
    }
    // шумы: «коричневый» (глухой), белый
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
    // шум через фильтр в свой регулятор громкости
    const noiseVoice = (buf, type, freq, q, to) => {
      const g = gain(0, to)
      const f = new BiquadFilterNode(ctx, { type, frequency: freq, Q: q })
      f.connect(g)
      return { g, f, s: loop(buf, f) }
    }

    // ---- мотор игрока ----
    const shift = gain(1, bus.engine) // провал на переключении и дребезг отсечки
    // «рык»: низы +7 дБ на 200 Гц, середина +3 дБ на 450 Гц, верх выше 5 кГц −6 дБ, лёгкий перегруз (tanh)
    const lows = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 200, gain: 7 })
    const body = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 450, Q: 0.9, gain: 3 })
    const highs = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 5000, gain: -6 })
    const grit = new WaveShaperNode(ctx, { oversample: '2x' })
    const curve = new Float32Array(2048)
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1
      curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2)
    }
    grit.curve = curve
    const preGrit = gain(0.8, grit)
    const trim = new GainNode(ctx, { gain: 0.45 }) // перегруз и подъём низов делают громче — возвращаем уровень
    grit.connect(lows).connect(body).connect(highs).connect(trim).connect(shift)
    const tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 12000, Q: 0.5 }) // на сбросе темнее
    tone.connect(preGrit)
    // петли мотора создаёт setEngine (их можно сменить на ходу), здесь — только куда они идут
    const idleGain = gain(0, tone)
    // вой MGU-K убран (Рома 30.10: «на больших скоростях лютый писк»): его тон рос со скоростью до ~3 кГц — не возвращать

    // ---- шины и поверхности ----
    const squealVoice = (buf, rate) => {
      const g = gain(0, bus.tyres)
      return { g, s: loop(buf, g, rate) }
    }
    const squealF = squealVoice(squealBuf, 1)
    const squealR = squealVoice(squeal2Buf, 0.95)
    const road = noiseVoice(whiteBuf, 'bandpass', 300, 0.7, bus.tyres) // шорох асфальта
    const water = noiseVoice(whiteBuf, 'bandpass', 2800, 0.6, bus.tyres) // мокрая: шипение воды из-под шин
    const grass = noiseVoice(whiteBuf, 'highpass', 1800, 0.6, bus.tyres)
    const gravel = noiseVoice(brownBuf, 'bandpass', 900, 0.8, bus.tyres)
    const scrapeGain = gain(0, bus.tyres)
    const scrape = loop(scrapeBuf, scrapeGain)
    // поребрик: гул — прямоугольник с частотой ударов о гребни через фильтр
    const kerbOsc = new OscillatorNode(ctx, { type: 'square', frequency: 60 })
    const kerbLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 400 })
    const kerbGain = gain(0, bus.tyres)
    kerbOsc.connect(kerbLp).connect(kerbGain)
    kerbOsc.start()

    // ---- окружение ----
    const wind = noiseVoice(whiteBuf, 'lowpass', 300, 0.5, bus.ambience)
    const rain = noiseVoice(whiteBuf, 'highpass', 2200, 0.5, bus.ambience)

    // ---- соперники: голоса по ближайшим, в пространстве ----
    const voices = []
    for (let i = 0; i < BOT_VOICES; i++) {
      const panner = new PannerNode(ctx, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 8, rolloffFactor: 1.2, maxDistance: 500 })
      panner.connect(bus.cars)
      const gate = gain(0, panner)
      const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 16000 })
      lp.connect(gate)
      voices.push({ layers: [], gate, lp, panner })
    }

    // ---- трибуны и гаражи: источники ставит buildAmbience, как только известны места (setAmbience) ----
    const [crowdBuf, cheerBuf, paddockBuf] = await Promise.all([load(URL_CROWD), load(URL_CHEER), load(URL_PADDOCK)]).catch(() => [null, null, null])
    const crowdBus = gain(1, outside)

    n = { crowdBuf, cheerBuf, paddockBuf, crowdBus, stands: [], pits: [], load, gain, loop, master, outside, bus, shift, tone, onLayers: [], offLayers: [], idle: null, idleGain, squealF, squealR, road, water, grass, gravel, scrape, scrapeGain, kerbOsc, kerbGain, wind, rain, voices, hitBufs, whiteBuf }
    await buildEngine(engineId)
    buildAmbience()
    starting = false
    wake()
  }

  // трибуны и гаражи в пространстве: places = { stands: [{x, y, z}], pits: [{x, y, z}] }
  let places = null
  function buildAmbience() {
    if (!n || !places || !n.crowdBuf) return
    for (const e of [...n.stands, ...n.pits]) {
      e.s.stop()
      e.panner.disconnect()
    }
    const emitter = (p, buf, ref, vol) => {
      const panner = new PannerNode(ctx, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: ref, rolloffFactor: 1, maxDistance: 2000, positionX: p.x, positionY: (p.y || 0) + 4, positionZ: p.z })
      panner.connect(n.crowdBus)
      const g = new GainNode(ctx, { gain: vol })
      g.connect(panner)
      const s = n.loop(buf, g, 0.97 + Math.random() * 0.06)
      return { ...p, panner, g, s, k: 0 }
    }
    n.stands = places.stands.map((p) => emitter(p, n.crowdBuf, 30, CROWD_VOL))
    n.pits = places.pits.map((p) => emitter(p, n.paddockBuf, 10, 0.5))
  }

  // петли выбранного мотора: загрузить, плавно заменить старые (старые гаснут и останавливаются)
  async function buildEngine(id) {
    const my = ++engineLoad
    const def = ENGINES[id] || ENGINES.v10
    const eng = (name) => n.load(`/sounds/engine/${id}_${name}.wav`)
    const [onBufs, offBufs, idleBuf] = await Promise.all([Promise.all(def.on.map((r) => eng('on_' + r))), Promise.all(def.off.map((r) => eng('off_' + r))), eng('idle')])
    if (my !== engineLoad) return
    const old = [...n.onLayers, ...n.offLayers, ...n.voices.flatMap((v) => v.layers)]
    const oldIdle = n.idle
    const layer = (buf, to) => {
      const g = n.gain(0, to)
      return { s: n.loop(buf, g), g }
    }
    n.onLayers = onBufs.map((b) => layer(b, n.tone))
    n.offLayers = offBufs.map((b) => layer(b, n.tone))
    n.idle = n.loop(idleBuf, n.idleGain)
    for (const v of n.voices) v.layers = def.bot.map((r) => layer(onBufs[def.on.indexOf(r)], v.lp))
    E = def
    const t = ctx.currentTime
    for (const l of old) {
      l.g.gain.setTargetAtTime(0, t, 0.05)
      l.s.stop(t + 0.4)
    }
    oldIdle?.stop(t + 0.4)
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

  // короткий звук из шума: полоса, огибающая (атака, спад), куда; delay — когда
  function burst(to, { freq, q = 1, type = 'bandpass', vol, attack = 0.002, decay, delay = 0 }) {
    const t = ctx.currentTime + delay
    const s = new AudioBufferSourceNode(ctx, { buffer: n.whiteBuf })
    const f = new BiquadFilterNode(ctx, { type, frequency: freq, Q: q })
    const g = new GainNode(ctx, { gain: 0 })
    s.connect(f).connect(g).connect(to)
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    s.start(t, Math.random())
    s.stop(t + attack + decay + 0.02)
    s.onended = () => g.disconnect()
  }
  // тон с огибающей (писк огней, глухой удар кузова — с падением высоты)
  function blip(to, { freq, freqEnd = freq, type = 'sine', vol, decay, delay = 0 }) {
    const t = ctx.currentTime + delay
    const o = new OscillatorNode(ctx, { type, frequency: freq })
    const g = new GainNode(ctx, { gain: 0 })
    o.connect(g).connect(to)
    o.frequency.setValueAtTime(freq, t)
    o.frequency.exponentialRampToValueAtTime(freqEnd, t + decay)
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay)
    o.start(t)
    o.stop(t + decay + 0.02)
    o.onended = () => g.disconnect()
  }
  // сэмпл удара: случайный из набора, высота ±8%, громкость ±2 дБ
  function sample(kind, vol, to, delay = 0, rate = 1) {
    const list = n.hitBufs[kind]
    const s = new AudioBufferSourceNode(ctx, { buffer: list[Math.floor(Math.random() * list.length)], playbackRate: rate * rand(0.92, 1.08) })
    const g = new GainNode(ctx, { gain: vol * rand(0.8, 1) })
    s.connect(g).connect(to)
    s.start(ctx.currentTime + delay)
    s.onended = () => g.disconnect()
  }
  // точка в пространстве для разового звука (удары): слушатель — камера; чем сильнее удар, тем ярче тембр
  function spot(pos, k) {
    const panner = new PannerNode(ctx, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 6, rolloffFactor: 1.1, maxDistance: 400, positionX: pos.x, positionY: pos.y, positionZ: pos.z })
    const tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1500 + 14000 * k })
    tone.connect(panner).connect(n.bus.impacts)
    setTimeout(() => panner.disconnect(), 2500)
    return tone
  }

  // слушатель = камера; скорость камеры — для Доплера
  function updateListener(camera, dt) {
    const L = ctx.listener
    const p = camera.position
    const e = camera.matrixWorld.elements // взгляд камеры — минус третий столбец
    const fx = -e[8]
    const fy = -e[9]
    const fz = -e[10]
    const t = ctx.currentTime
    if (L.positionX) {
      L.positionX.setTargetAtTime(p.x, t, 0.02)
      L.positionY.setTargetAtTime(p.y, t, 0.02)
      L.positionZ.setTargetAtTime(p.z, t, 0.02)
      L.forwardX.setTargetAtTime(fx, t, 0.02)
      L.forwardY.setTargetAtTime(fy, t, 0.02)
      L.forwardZ.setTargetAtTime(fz, t, 0.02)
      L.upX.value = 0
      L.upY.value = 1
      L.upZ.value = 0
    } else {
      L.setPosition(p.x, p.y, p.z)
      L.setOrientation(fx, fy, fz, 0, 1, 0)
    }
    let vx = 0
    let vy = 0
    let vz = 0
    if (mem.camX !== null && dt > 0) {
      vx = (p.x - mem.camX) / dt
      vy = (p.y - mem.camY) / dt
      vz = (p.z - mem.camZ) / dt
      if (vx * vx + vy * vy + vz * vz > 150 * 150) vx = vy = vz = 0 // перескок камеры
    }
    mem.camX = p.x
    mem.camY = p.y
    mem.camZ = p.z
    return { x: p.x, y: p.y, z: p.z, vx, vy, vz }
  }

  // соперники: 4 ближайших к камере полным голосом, дальше — глуше, Доплер по относительной скорости
  function updateBots(bots, lis) {
    const near = []
    for (const b of bots || []) {
      if (b.gone || b.retired) continue
      const t = b.v.body.translation()
      const d = Math.hypot(t.x - lis.x, t.y - lis.y, t.z - lis.z)
      if (d < BOT_FAR) near.push({ b, d, t })
    }
    near.sort((a, b) => a.d - b.d)
    const time = ctx.currentTime
    n.voices.forEach((vc, i) => {
      const it = near[i]
      if (!it) {
        set(vc.gate.gain, 0, 0.15)
        return
      }
      const { b, d, t } = it
      vc.panner.positionX.setTargetAtTime(t.x, time, 0.02)
      vc.panner.positionY.setTargetAtTime(t.y + 0.5, time, 0.02)
      vc.panner.positionZ.setTargetAtTime(t.z, time, 0.02)
      const lv = b.v.body.linvel()
      const vRel = ((lv.x - lis.vx) * (t.x - lis.x) + (lv.y - lis.vy) * (t.y - lis.y) + (lv.z - lis.vz) * (t.z - lis.z)) / Math.max(d, 1)
      const doppler = clamp(C / (C + vRel), 0.75, 1.3)
      const e = engineRpm(E, b.v.state.rpm)
      const [a, wa, c, wc] = blend(E.bot, e)
      vc.layers.forEach((l, j) => {
        set(l.s.playbackRate, (e / E.bot[j]) * doppler, 0.05)
        set(l.g.gain, j === a ? wa : j === c ? wc : 0, 0.05)
      })
      const thr = b.input?.throttle ?? 1
      set(vc.lp.frequency, (d < 40 ? 16000 : d < 150 ? 6000 : 2500) * (0.55 + 0.45 * thr), 0.1)
      set(vc.gate.gain, (0.45 + 0.55 * thr) * (1 - smooth(BOT_FAR * 0.7, BOT_FAR, d)), 0.08)
    })
  }

  return {
    // громкость 0…1: действует сразу, а если звук ещё не запущен — при запуске
    setVolume(v) {
      volume = clamp(v, 0, 1)
      if (n) n.master.gain.setTargetAtTime(MASTER * volume, ctx.currentTime, 0.05)
    },

    // удар: strength 0…1 (тяжесть, wear.js sev); pos — где (мир), по нему громкость и сторона у слушателя-камеры
    hit(strength, pos) {
      if (!n || paused || muted) return
      const now = ctx.currentTime
      if (now - mem.lastHit < 0.08) return // в одном ударе событий много — звучит один раз
      mem.lastHit = now
      const k = clamp(Math.sqrt(0.15 + strength * 0.85), 0, 1)
      const to = spot(pos, k)
      // слоями по силе: глухой удар кузова всегда; слабый — ещё стук металла, средний — удар об ограждение,
      // сильный — авария целиком (удар и разлёт обломков)
      sample('thump', 0.45 + 0.55 * k, to, 0, 1.05 - 0.15 * k)
      blip(to, { freq: 110, freqEnd: 40, vol: 0.35 + 0.5 * k, decay: 0.16 + 0.15 * k })
      if (k < 0.5) sample('metal', 0.25 + 0.5 * k, to, 0.005, 0.95)
      else sample('wall', 0.5 + 0.5 * k, to, 0.005, 1.05 - 0.15 * k)
      if (k > 0.75) sample('crash', 0.6 + 0.4 * k, to, 0.01)
    },

    // касание болидов без повреждений: короткий резиновый «бамп»
    touch(strength, pos) {
      if (!n || paused || muted) return
      const now = ctx.currentTime
      if (now - mem.lastHit < 0.25) return
      mem.lastHit = now
      const to = spot(pos, 0.3)
      sample('thump', 0.25 + 0.6 * strength, to, 0, 1.1)
      if (strength > 0.5) sample('metal', 0.2 * strength, to, 0.01)
    },

    // мотор: 'v10' | 'f136' | 'ls' (Настройки → Звук); звук ещё не запущен — возьмётся при запуске
    setEngine(id) {
      if (!ENGINES[id] || id === engineId) return
      engineId = id
      if (n) buildEngine(id)
    },

    // места трибун и боксов на трассе (main.js после загрузки трассы)
    setAmbience(p) {
      places = p
      buildAmbience()
    },
    // трибуны ликуют: у ближайших к pos (или у всех, если pos нет); k — сила 0…1
    cheer(pos, k = 1) {
      if (!n?.cheerBuf || paused || muted || !n.stands.length) return
      const list = pos ? [...n.stands].sort((a, b) => (a.x - pos.x) ** 2 + (a.z - pos.z) ** 2 - ((b.x - pos.x) ** 2 + (b.z - pos.z) ** 2)).slice(0, 2) : n.stands
      for (const e of list) {
        const s = new AudioBufferSourceNode(ctx, { buffer: n.cheerBuf, playbackRate: 0.95 + Math.random() * 0.1 })
        const g = new GainNode(ctx, { gain: 1.4 * k })
        s.connect(g).connect(e.panner)
        s.start(ctx.currentTime + Math.random() * 0.15)
      }
    },
    toggleMute() {
      muted = !muted
      wake()
      return muted
    },

    // world: { bots, camera, camMode, rain, dt, lights (горит огней старта), pitPhase }
    update(v, input, isPaused, world = {}) {
      if (isPaused !== paused) {
        paused = isPaused
        wake()
      }
      if (!n || paused || muted) return
      const st = v.state
      const dt = world.dt || 0
      const speed = st.speedKmh / 3.6
      const throttle = input.throttle
      const cockpit = !!world.camMode && world.camMode !== 'chase'
      const t = ctx.currentTime
      const gear = typeof st.gear === 'number' ? st.gear : mem.gear

      // ---- мотор: сглаженные обороты, две соседние петли каждого набора ----
      const target = engineRpm(E, st.rpm)
      // вниз на переключении — сразу (у F1 оно почти мгновенное), остальное — сглаживание, чтобы тон не дрожал
      mem.rpm = gear > mem.gear ? target : mem.rpm + (target - mem.rpm) * Math.min(1, dt * 25)
      const e = mem.rpm
      const idleK = 1 - smooth(1, 4, speed + throttle * 10)
      const load = Math.sqrt(0.08 + 0.92 * throttle)
      const unload = Math.sqrt(1 - 0.92 * throttle)
      const mix = (layers, rpms, vol) => {
        const [a, wa, b, wb] = blend(rpms, e)
        layers.forEach((l, j) => {
          set(l.s.playbackRate, e / rpms[j], 0.03)
          set(l.g.gain, (j === a ? wa : j === b ? wb : 0) * vol, 0.03)
        })
      }
      if (n.onLayers.length === E.on.length) mix(n.onLayers, E.on, (1 - idleK) * 0.8 * load)
      if (n.offLayers.length === E.off.length) mix(n.offLayers, E.off, (1 - idleK) * 0.6 * unload)
      set(n.idleGain.gain, 0.6 * idleK, 0.08)
      if (n.idle) set(n.idle.playbackRate, 1 + 0.25 * throttle, 0.1)
      // на сбросе темнее; в кабине мотор чуть приглушён сверху (больше механики, меньше выхлопа)
      set(n.tone.frequency, (3500 + 8500 * throttle) * (cockpit ? 0.75 : 1), 0.05)

      // переключение вверх: короткий провал и «клац» коробки; отсечка — дребезг громкости ~20 Гц
      if (gear > mem.gear) {
        n.shift.gain.cancelScheduledValues(t)
        n.shift.gain.setValueAtTime(n.shift.gain.value, t)
        n.shift.gain.linearRampToValueAtTime(0.35, t + 0.02)
        n.shift.gain.linearRampToValueAtTime(1, t + 0.07)
        burst(n.bus.engine, { freq: 2600, q: 2.5, vol: 0.12 + 0.2 * throttle, decay: 0.035 })
      } else if (st.rpm > 0.985 && throttle > 0.8) {
        n.shift.gain.setTargetAtTime(Math.sin(t * 2 * Math.PI * 20) > 0 ? 1 : 0.55, t, 0.005)
      } else n.shift.gain.setTargetAtTime(1, t, 0.02)
      if (gear < mem.gear) burst(n.bus.engine, { freq: 1800, q: 2, vol: 0.1, decay: 0.03 }) // вниз — тише
      mem.gear = gear

      // хлопки в выхлоп: газ сброшен на высоких оборотах — первые ~1,5 с, через случайные 40–150 мс
      mem.lift = throttle < 0.05 ? mem.lift + dt : 0
      if (mem.lift > 0.05 && mem.lift < 1.5 && st.rpm > 0.72 && speed > 12 && t > mem.nextPop) {
        const vol = rand(0.18, 0.45) * (1 - mem.lift / 1.5)
        burst(n.bus.engine, { freq: rand(500, 1300), q: 1.2, vol, decay: rand(0.03, 0.07) })
        blip(n.bus.engine, { freq: rand(140, 200), freqEnd: 70, vol: vol * 0.8, decay: 0.06 })
        mem.nextPop = t + rand(0.04, 0.15)
      }

      // ---- шины: визг по уводу относительно пика шины, передние и задние отдельно ----
      const wet = smooth(0.2, 0.5, v.wet || 0)
      let slipF = 0
      let slipR = 0
      let lockup = false
      let asphalt = 0
      let kerb = 0
      let onGrass = 0
      let onGravel = 0
      let kerbLoad = 0
      for (const w of v.wheels) {
        if (!w.contact) continue
        const s = w.surface
        if (s === 'asphalt' || s === 'kerb') {
          let slip = Math.abs(w.slip) / (w.front ? PEAK_SLIP.front : PEAK_SLIP.rear)
          if (w.sliding) {
            slip = Math.max(slip, 1.3)
            if (st.braking) lockup = true
          }
          if (w.front) slipF = Math.max(slipF, slip)
          else slipR = Math.max(slipR, slip)
          asphalt += 0.25
          if (s === 'kerb') {
            kerb += 0.25
            kerbLoad = Math.max(kerbLoad, w.load / 6000)
          }
        } else if (s === 'gravel') onGravel += 0.25
        else onGrass += 0.25
      }
      // увод сглаживается до порога (быстро растёт, медленно спадает): визг не рвётся «туда-сюда» на границе сцепления;
      // визжит только у предела шины и за ним (раньше начинал с 60% пика — визжало почти в каждом повороте)
      const follow = (m, x) => m + (x - m) * Math.min(1, dt / (x > m ? 0.08 : 0.4))
      mem.slipF = follow(mem.slipF, slipF)
      mem.slipR = follow(mem.slipR, slipR)
      const squeal = (voice, slip, base) => {
        const target = smooth(0.95, 1.45, slip) * smooth(3, 10, speed) * (1 - wet) * 0.6 * (lockup ? 1.2 : 1)
        voice.g.gain.setTargetAtTime(target, t, target > voice.g.gain.value ? 0.06 : 0.25)
        set(voice.s.playbackRate, (base + 0.12 * Math.min(1.5, slip - 1) + speed / 600) * (lockup ? 0.88 : 1), 0.1)
      }
      squeal(n.squealF, mem.slipF, 1)
      squeal(n.squealR, mem.slipR, 0.95)
      set(n.road.g.gain, asphalt * Math.min(0.3, speed / 250) * (1 - wet * 0.6), 0.1)
      set(n.road.f.frequency, 150 + speed * 8, 0.1)
      set(n.water.g.gain, asphalt * wet * Math.min(0.4, speed / 120), 0.15)
      set(n.grass.g.gain, onGrass * Math.min(0.7, speed / 60), 0.08)
      set(n.gravel.g.gain, onGravel * Math.min(0.9, speed / 40), 0.06)
      set(n.gravel.f.frequency, 600 + speed * 12, 0.1)
      // камешки по днищу на гравии: короткие щелчки, чаще на скорости
      mem.stoneAcc += onGravel * dt * Math.min(40, speed * 1.2)
      while (mem.stoneAcc > 1) {
        mem.stoneAcc -= 1
        burst(n.bus.tyres, { freq: rand(2500, 6000), q: 3, vol: rand(0.05, 0.18), decay: rand(0.008, 0.02), delay: rand(0, 0.03) })
      }
      // поребрик: частота = скорость / шаг гребня (~0,75 м), громкость по нагрузке на колесо
      set(n.kerbOsc.frequency, clamp(speed / 0.75, 8, 140), 0.02)
      set(n.kerbGain.gain, kerb > 0 ? Math.min(0.45, 0.25 + 0.2 * kerbLoad) * smooth(2, 12, speed) * Math.min(1, kerb * 2) : 0, 0.02)
      // скрежет днища
      set(n.scrapeGain.gain, 0.5 * Math.min(1, st.plankContact / 12000) * smooth(2, 20, speed), 0.05)
      set(n.scrape.playbackRate, 0.8 + 0.5 * Math.min(1, speed / 60), 0.1)

      // ---- окружение ----
      const vw = Math.min(1, speed / 95)
      set(n.wind.f.frequency, 300 + 2700 * vw, 0.1)
      set(n.wind.g.gain, vw * vw * (cockpit ? 0.55 : 0.28) * (st.aeroOn ? 0.8 : 1), 0.1)
      // режим прямой: «вжух» крыльев при открытии и закрытии
      if (!!st.aeroOn !== mem.aero && speed > 20) burst(n.bus.ambience, { freq: st.aeroOn ? 900 : 1400, q: 0.8, vol: 0.25, attack: 0.06, decay: 0.25 })
      mem.aero = !!st.aeroOn
      set(n.rain.g.gain, (cockpit ? 0.22 : 0.14) * (world.rain || 0), 0.3)
      // кабина: внешний мир глуше
      set(n.outside.frequency, cockpit ? 7000 : 18000, 0.15)
      // огни старта: короткий писк на каждый загоревшийся
      const lit = world.lights || 0
      if (lit > mem.lit) blip(n.bus.ambience, { freq: 1000, type: 'square', vol: 0.08, decay: 0.14 })
      mem.lit = lit
      // боксы: гайковёрты на остановке — четыре очереди разом, и ещё раз на выпуске
      const ph = world.pitPhase || null
      if (ph !== mem.pitPhase && (ph === 'service' || ph === 'release')) {
        for (let i = 0; i < 4; i++) {
          for (let j = 0; j < 6; j++) burst(n.bus.ambience, { freq: rand(2200, 3200), q: 4, vol: 0.12, decay: 0.04, delay: i * 0.05 + j * 0.06 + rand(0, 0.02) })
        }
      }
      mem.pitPhase = ph

      if (world.camera) updateBots(world.bots, updateListener(world.camera, dt))
      // трибуны громче, когда рядом болид игрока (как волна по трибуне)
      if (n.stands.length && world.carPos) {
        for (const e of n.stands) {
          const d = Math.hypot(e.x - world.carPos.x, e.z - world.carPos.z)
          e.k += (smooth(CROWD_NEAR, 25, d) * Math.min(1, speed / 50) - e.k) * Math.min(1, dt * (d < CROWD_NEAR ? 3 : 0.6))
          set(e.g.gain, CROWD_VOL * (1 + 1.2 * e.k), 0.1)
        }
      }
    },
  }
}
