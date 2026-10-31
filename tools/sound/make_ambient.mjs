// Музыка меню, звуки интерфейса, трибуны и гаражи — синтез без записей (Рома 31.10: «музыка в меню и звуки интерфейса»,
// «зрители и звуки паддока»). Всё своё, без чужих лицензий. Запуск: node tools/sound/make_ambient.mjs
// Пишет public/sounds/music/menu.m4a (через ffmpeg; 64 с, 120 уд/мин, ля минор — петля), public/sounds/ui/*.wav,
// public/sounds/amb/crowd.wav (гул трибун, петля 20 с), cheer.wav (трибуны ликуют, 5 с), paddock.wav (гаражи, петля 16 с).
import { writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const SR = 44100
const TAU = Math.PI * 2
let seed = 7
const rnd = () => {
  seed = (seed * 16807) % 2147483647
  return (seed - 1) / 2147483646
}
const rr = (a, b) => a + rnd() * (b - a)

function wav(path, chans) {
  const n = chans[0].length
  const c = chans.length
  const buf = Buffer.alloc(44 + n * c * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * c * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(c, 22)
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * c * 2, 28)
  buf.writeUInt16LE(c * 2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * c * 2, 40)
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, chans[k][i])) * 32767), 44 + (i * c + k) * 2)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, buf)
  console.log(path, (buf.length / 1024).toFixed(0) + ' КБ')
}
function normalize(chans, peak = 0.89) {
  let m = 0
  for (const ch of chans) for (const v of ch) m = Math.max(m, Math.abs(v))
  const k = m ? peak / m : 1
  for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] *= k
}
// биквад (RBJ): lp, hp, bp
function biquad(type, f, q = 0.707) {
  const w = (TAU * f) / SR
  const cs = Math.cos(w)
  const al = Math.sin(w) / (2 * q)
  let b0, b1, b2
  if (type === 'lp') [b0, b1, b2] = [(1 - cs) / 2, 1 - cs, (1 - cs) / 2]
  else if (type === 'hp') [b0, b1, b2] = [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2]
  else [b0, b1, b2] = [al, 0, -al]
  const a0 = 1 + al
  const a1 = -2 * cs
  const a2 = 1 - al
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  const f0 = { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
  const fn = (x) => {
    const y = f0.b0 * x + f0.b1 * x1 + f0.b2 * x2 - f0.a1 * y1 - f0.a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    return y
  }
  fn.set = (nf, nq = q) => {
    const w2 = (TAU * Math.min(nf, SR * 0.45)) / SR
    const c2 = Math.cos(w2)
    const a = Math.sin(w2) / (2 * nq)
    const A0 = 1 + a
    if (type === 'lp') Object.assign(f0, { b0: (1 - c2) / 2 / A0, b1: (1 - c2) / A0, b2: (1 - c2) / 2 / A0 })
    else if (type === 'hp') Object.assign(f0, { b0: (1 + c2) / 2 / A0, b1: -(1 + c2) / A0, b2: (1 + c2) / 2 / A0 })
    else Object.assign(f0, { b0: a / A0, b1: 0, b2: -a / A0 })
    f0.a1 = (-2 * c2) / A0
    f0.a2 = (1 - a) / A0
  }
  return fn
}
// пила без ступенек (polyBLEP)
function blep(t, dt) {
  if (t < dt) {
    t /= dt
    return t + t - t * t - 1
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt
    return t * t + t + t + 1
  }
  return 0
}
function saw() {
  let ph = rnd()
  return (f) => {
    const dt = f / SR
    ph += dt
    if (ph >= 1) ph -= 1
    return 2 * ph - 1 - blep(ph, dt)
  }
}
function pink() {
  let b0 = 0, b1 = 0, b2 = 0
  return () => {
    const w = rnd() * 2 - 1
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    return (b0 + b1 + b2 + w * 0.1848) * 0.2
  }
}
// петля: последние fade с сливаются с началом
function loopify(ch, len, fade) {
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) out[i] = ch[i]
  const F = Math.floor(fade * SR)
  for (let i = 0; i < F; i++) {
    const t = i / F
    out[i] = ch[i] * Math.sin((t * Math.PI) / 2) + ch[len + i] * Math.cos((t * Math.PI) / 2)
  }
  return out
}
// простая реверберация (Шрёдер): 4 гребёнки + 2 всепропускающих
function reverb(x, mix = 0.25, room = 0.82) {
  const combs = [1557, 1617, 1491, 1422].map((d) => ({ b: new Float32Array(d), i: 0, lp: 0 }))
  const aps = [225, 556].map((d) => ({ b: new Float32Array(d), i: 0 }))
  const y = new Float32Array(x.length)
  for (let n = 0; n < x.length; n++) {
    let s = 0
    for (const c of combs) {
      const o = c.b[c.i]
      c.lp = o * 0.7 + c.lp * 0.3
      c.b[c.i] = x[n] * 0.015 + c.lp * room
      c.i = (c.i + 1) % c.b.length
      s += o
    }
    for (const a of aps) {
      const o = a.b[a.i]
      a.b[a.i] = s + o * 0.5
      a.i = (a.i + 1) % a.b.length
      s = o - s * 0.5
    }
    y[n] = x[n] * (1 - mix) + s * mix * 3
  }
  return y
}

// ===================== музыка меню =====================
function music() {
  const BPM = 120
  const beat = 60 / BPM
  const bars = 32
  const len = Math.round(bars * 4 * beat * SR)
  const tail = Math.round(2 * SR)
  const L = new Float32Array(len + tail)
  const R = new Float32Array(len + tail)
  const add = (i, l, r = l) => {
    if (i >= 0 && i < L.length) {
      L[i] += l
      R[i] += r
    }
  }
  const midi = (m) => 440 * 2 ** ((m - 69) / 12)
  // аккорды по такту: Am F C G (корни: A2 F2 C3 G2)
  const chords = [
    [57, 60, 64],
    [53, 57, 60],
    [60, 64, 67],
    [55, 59, 62],
  ]
  const roots = [45, 41, 48, 43]
  const section = (bar) => (bar < 8 ? 'intro' : bar < 24 ? 'full' : 'break')
  const duck = new Float32Array(len + tail).fill(1) // приглушение от бочки
  // --- ударные ---
  for (let bar = 0; bar < bars; bar++) {
    const sec = section(bar)
    for (let b = 0; b < 4; b++) {
      const t0 = Math.round((bar * 4 + b) * beat * SR)
      if (sec === 'full' || (sec === 'break' && bar >= 28) || (sec === 'intro' && bar >= 6)) {
        // бочка
        let ph = 0
        for (let i = 0; i < 0.4 * SR; i++) {
          const t = i / SR
          const f = 45 + 110 * Math.exp(-t * 28)
          ph += (TAU * f) / SR
          add(t0 + i, Math.sin(ph) * Math.exp(-t * 7) * 0.9 + (i < 60 ? (rnd() - 0.5) * 0.3 : 0))
          duck[t0 + i] = Math.min(duck[t0 + i], 0.35 + 0.65 * Math.min(1, t / 0.18))
        }
      }
      if ((sec === 'full' || bar >= 28) && (b === 1 || b === 3)) {
        // хлопок + малый
        const bp = biquad('bp', 1900, 0.9)
        for (let i = 0; i < 0.25 * SR; i++) {
          const t = i / SR
          const env = Math.exp(-t * 18) * (t < 0.03 ? 1 + 0.6 * Math.sin(t * 600) : 1)
          const v = bp(rnd() * 2 - 1) * env * 0.7 + Math.sin(TAU * 190 * t) * Math.exp(-t * 30) * 0.25
          add(t0 + i, v * 0.9, v * 1.0)
        }
      }
      // хэты по шестнадцатым
      if (sec !== 'intro' || bar >= 4) {
        for (let k = 0; k < 4; k++) {
          const open = k === 2
          const hp = biquad('hp', 7000, 0.8)
          const ts = t0 + Math.round(k * beat * SR * 0.25)
          const dec = open ? 12 : 55
          const vol = (open ? 0.12 : k % 2 ? 0.05 : 0.08) * (sec === 'break' ? 0.6 : 1)
          const pan = k % 2 ? 0.7 : 1
          for (let i = 0; i < (open ? 0.18 : 0.06) * SR; i++) {
            const v = hp(rnd() * 2 - 1) * Math.exp((-i / SR) * dec) * vol
            add(ts + i, v * pan, v * (1.7 - pan))
          }
        }
      }
    }
  }
  // --- бас: восьмые по корню, фильтр открывается на каждой ноте ---
  {
    const o1 = saw()
    const o2 = saw()
    const lp = biquad('lp', 400, 1.4)
    for (let bar = 0; bar < bars; bar++) {
      const sec = section(bar)
      if (sec === 'intro' && bar < 4) continue
      const root = roots[bar % 4]
      for (let e = 0; e < 8; e++) {
        const note = root + (e === 3 || e === 7 ? 12 : 0)
        const ts = Math.round((bar * 4 + e / 2) * beat * SR)
        const dur = Math.round(beat * 0.5 * SR * 0.92)
        for (let i = 0; i < dur; i++) {
          const t = i / SR
          lp.set(180 + 1300 * Math.exp(-t * 14) * (sec === 'break' ? 0.4 : 1), 1.6)
          const f = midi(note)
          const v = lp(o1(f) * 0.6 + o2(f * 1.005) * 0.5) * Math.min(1, t * 400) * (i > dur - 200 ? (dur - i) / 200 : 1)
          add(ts + i, v * 0.38 * duck[ts + i])
        }
      }
    }
  }
  // --- пэд: аккорд тремя расстроенными пилами, мягкая атака ---
  const padL = new Float32Array(len + tail)
  const padR = new Float32Array(len + tail)
  {
    const oscs = Array.from({ length: 9 }, saw)
    const lpL = biquad('lp', 1100, 0.7)
    const lpR = biquad('lp', 1100, 0.7)
    for (let bar = 0; bar < bars; bar++) {
      const ch = chords[bar % 4]
      const ts = Math.round(bar * 4 * beat * SR)
      const dur = Math.round(4 * beat * SR)
      for (let i = 0; i < dur; i++) {
        const t = i / SR
        let l = 0
        let r = 0
        for (let k = 0; k < 3; k++) {
          const f = midi(ch[k])
          l += oscs[k * 3](f * 0.997) + oscs[k * 3 + 1](f) * 0.5
          r += oscs[k * 3 + 2](f * 1.003) + oscs[k * 3 + 1](f) * 0.0
        }
        const env = Math.min(1, t / 0.4) * (i > dur - 2000 ? 0.85 + (0.15 * (dur - i)) / 2000 : 1)
        const sw = 900 + 500 * Math.sin((TAU * (bar * 4 * beat + t)) / 16)
        lpL.set(sw, 0.7)
        lpR.set(sw, 0.7)
        const k2 = section(bar) === 'full' ? 0.7 : 1
        padL[ts + i] += lpL(l) * env * 0.075 * k2
        padR[ts + i] += lpR(r) * env * 0.075 * k2
      }
    }
  }
  // --- арпеджио: шестнадцатые по аккорду, эхо на 3/16 ---
  const arp = new Float32Array(len + tail)
  {
    const osc = saw()
    const lp = biquad('lp', 2500, 1)
    const pattern = [0, 1, 2, 1, 2, 0, 1, 2, 0, 2, 1, 2, 0, 1, 2, 1]
    for (let bar = 0; bar < bars; bar++) {
      const ch = chords[bar % 4]
      for (let s = 0; s < 16; s++) {
        const note = ch[pattern[s]] + 12 + (s >= 12 && bar % 2 ? 12 : 0)
        const ts = Math.round((bar * 4 + s / 4) * beat * SR)
        const dur = Math.round(beat * 0.25 * SR)
        const vel = s % 4 === 0 ? 1 : 0.7
        for (let i = 0; i < dur; i++) {
          const t = i / SR
          lp.set(800 + 3200 * Math.exp(-t * 20), 2)
          arp[ts + i] += lp(osc(midi(note))) * Math.exp(-t * 16) * vel * 0.16
        }
      }
    }
  }
  // --- мелодия (только в основной части) ---
  const lead = new Float32Array(len + tail)
  {
    const o1 = saw()
    const o2 = saw()
    const lp = biquad('lp', 3000, 0.9)
    // по два такта: ноты (MIDI) по восьмым, null — пауза
    const phrase = [
      [76, null, 74, 72, 74, null, 72, 69, 72, null, null, 69, 67, 69, null, null],
      [72, null, 72, 74, 76, null, 79, 76, 74, null, 72, 74, 76, null, null, null],
    ]
    let f = midi(76)
    for (let bar = 8; bar < 24; bar++) {
      const ph = phrase[Math.floor((bar - 8) / 2) % 2]
      for (let e = 0; e < 8; e++) {
        const note = ph[((bar - 8) % 2) * 8 + e]
        if (note == null) continue
        const ts = Math.round((bar * 4 + e / 2) * beat * SR)
        let dur = 1
        while (e + dur < 8 && ph[((bar - 8) % 2) * 8 + e + dur] === null) dur++
        const n = Math.round(dur * beat * 0.5 * SR * 0.95)
        const target = midi(note)
        for (let i = 0; i < n; i++) {
          const t = i / SR
          f += (target - f) * 0.004 // портаменто
          const vib = 1 + 0.004 * Math.sin(TAU * 5.5 * t) * Math.min(1, t * 3)
          lp.set(1800 + 1500 * Math.exp(-t * 6), 1)
          const env = Math.min(1, t * 60) * Math.exp(-t * 1.2) * (i > n - 300 ? (n - i) / 300 : 1)
          lead[ts + i] += lp(o1(f * vib) * 0.6 + o2(f * vib * 1.008) * 0.5) * env * 0.12
        }
      }
    }
  }
  // эхо арпеджио и мелодии (пинг-понг), реверб пэда
  const d = Math.round(beat * 0.75 * SR)
  const echoL = new Float32Array(len + tail)
  const echoR = new Float32Array(len + tail)
  for (let i = 0; i < len + tail; i++) {
    const x = arp[i] + lead[i] * 0.6
    echoL[i] = x + (i >= d ? echoR[i - d] * 0.42 : 0)
    echoR[i] = i >= d ? echoL[i - d] * 0.42 : 0
  }
  const pl = reverb(padL, 0.35)
  const pr = reverb(padR, 0.35)
  for (let i = 0; i < len + tail; i++) {
    const dk = 0.55 + 0.45 * duck[i]
    L[i] += (pl[i] * dk + arp[i] * 0.8 + echoL[i] * 0.55 + lead[i]) * 1
    R[i] += (pr[i] * dk + arp[i] * 0.8 + echoR[i] * 0.55 + lead[i] * 0.9) * 1
  }
  // хвост эха и реверба — в начало (петля без обрыва), мягкое насыщение
  for (let i = 0; i < tail; i++) {
    L[i] += L[len + i]
    R[i] += R[len + i]
  }
  const outL = L.subarray(0, len)
  const outR = R.subarray(0, len)
  // мягкий верх: срез выше ~10 кГц (иначе хэты и пилы режут ухо)
  const mL = biquad('lp', 10000, 0.6)
  const mR = biquad('lp', 10000, 0.6)
  for (let i = 0; i < len; i++) {
    outL[i] = Math.tanh(mL(outL[i]) * 1.2)
    outR[i] = Math.tanh(mR(outR[i]) * 1.2)
  }
  normalize([outL, outR], 0.85)
  const tmp = join(ROOT, 'tools/sound/.menu.wav')
  wav(tmp, [outL, outR])
  const out = join(ROOT, 'public/sounds/music/menu.m4a')
  mkdirSync(dirname(out), { recursive: true })
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-c:a', 'aac', '-b:a', '160k', out])
  execFileSync('rm', [tmp])
  console.log(out)
}

// ===================== интерфейс =====================
function ui() {
  const tone = (parts, dur) => {
    const x = new Float32Array(Math.round(dur * SR))
    for (const [f0, f1, t0, d, vol] of parts) {
      let ph = 0
      for (let i = 0; i < d * SR; i++) {
        const t = i / SR
        const f = f0 + (f1 - f0) * (t / d)
        ph += (TAU * f) / SR
        const env = Math.min(1, t * 2000) * Math.exp(-t * (6 / d))
        const k = Math.round(t0 * SR) + i
        if (k < x.length) x[k] += (Math.sin(ph) + 0.25 * Math.sin(ph * 2)) * env * vol
      }
    }
    return x
  }
  const click = (x, vol, f = 3500) => {
    const bp = biquad('bp', f, 1.5)
    for (let i = 0; i < 0.012 * SR; i++) x[i] += bp(rnd() * 2 - 1) * Math.exp((-i / SR) * 400) * vol
    return x
  }
  const dir = join(ROOT, 'public/sounds/ui')
  const save = (name, x) => {
    normalize([x], 0.6)
    wav(join(dir, name + '.wav'), [x])
  }
  save('move', click(tone([[1500, 1400, 0, 0.035, 0.5]], 0.05), 0.6))
  save('select', click(tone([[880, 880, 0, 0.06, 0.6], [1320, 1320, 0.055, 0.11, 0.6]], 0.18), 0.4, 2500))
  save('back', click(tone([[1100, 1000, 0, 0.06, 0.55], [740, 700, 0.05, 0.1, 0.55]], 0.17), 0.4, 2000))
  save('tab', click(tone([[1000, 1150, 0, 0.04, 0.45]], 0.06), 0.8, 4500))
  save('hover', click(new Float32Array(Math.round(0.02 * SR)), 1, 5000))
}

// ===================== трибуны =====================
// голос: импульсы связок (с дрожанием) через два форманта гласной; слоги — огибающая 3–6 Гц; гласные меняются
const VOWELS = [
  [730, 1090],
  [530, 1840],
  [270, 2290],
  [570, 840],
  [440, 1020],
  [660, 1700],
]
function voice(out, t0, dur, f0, vol, opts = {}) {
  const n = Math.round(dur * SR)
  const f1 = biquad('bp', 700, 6)
  const f2 = biquad('bp', 1200, 8)
  const breath = biquad('bp', 2500, 1)
  let ph = rnd()
  let vow = VOWELS[Math.floor(rnd() * VOWELS.length)]
  let nextV = 0
  let syl = rr(3, 6)
  let sph = rnd() * TAU
  const glide = opts.glide ?? 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    if (t >= nextV) {
      vow = VOWELS[Math.floor(rnd() * VOWELS.length)]
      f1.set(vow[0] * rr(0.9, 1.15), 6)
      f2.set(vow[1] * rr(0.9, 1.15), 8)
      nextV = t + rr(0.12, 0.4)
      syl = opts.sustain ? 0 : rr(3, 6)
    }
    const f = f0 * (1 + 0.02 * Math.sin(TAU * 4.7 * t + sph) + glide * Math.sin((Math.PI * t) / dur)) * (1 + (rnd() - 0.5) * 0.01)
    ph += f / SR
    let src = 0
    if (ph >= 1) {
      ph -= 1
      src = 1
    }
    const env = (opts.sustain ? 1 : 0.5 + 0.5 * Math.sin(TAU * syl * t + sph)) * Math.min(1, t / 0.05, (dur - t) / 0.1)
    const v = (f1(src * 3) + f2(src * 2) * 0.6 + breath(rnd() - 0.5) * 0.08) * env * vol
    const k = Math.round(t0 * SR) + i
    if (k >= 0 && k < out.length) out[k] += v
  }
}
function crowd() {
  const dur = 22
  const x = new Float32Array(dur * SR)
  // гул: розовый шум ниже 2 кГц, медленно «дышит»
  const p = pink()
  const lp = biquad('lp', 1600, 0.7)
  const hp = biquad('hp', 120, 0.7)
  for (let i = 0; i < x.length; i++) x[i] = hp(lp(p())) * (0.55 + 0.15 * Math.sin((TAU * i) / SR / 7.3))
  // сотни голосов
  for (let k = 0; k < 260; k++) {
    const male = rnd() < 0.6
    voice(x, rr(-1, dur), rr(0.6, 2.4), male ? rr(95, 170) : rr(170, 290), rr(0.01, 0.03))
  }
  // редкие выкрики и свист
  for (let k = 0; k < 14; k++) voice(x, rr(0, dur - 2), rr(0.4, 1.0), rr(200, 330), rr(0.04, 0.07), { sustain: true, glide: 0.15 })
  for (let k = 0; k < 4; k++) {
    const t0 = rr(0, dur - 1)
    let ph = 0
    for (let i = 0; i < 0.6 * SR; i++) {
      const t = i / SR
      ph += (TAU * (2200 + 900 * Math.sin(Math.PI * (t / 0.6)))) / SR
      x[Math.round(t0 * SR) + i] += Math.sin(ph) * 0.03 * Math.sin(Math.PI * (t / 0.6))
    }
  }
  const y = loopify(x, 20 * SR, 2)
  normalize([y], 0.7)
  wav(join(ROOT, 'public/sounds/amb/crowd.wav'), [y])
}
function cheer() {
  const dur = 5
  const x = new Float32Array(dur * SR)
  const p = pink()
  const lp = biquad('lp', 2600, 0.7)
  const env = (t) => Math.min(1, t / 0.5) * Math.exp(-Math.max(0, t - 0.8) * 0.9)
  for (let i = 0; i < x.length; i++) x[i] = lp(p()) * env(i / SR) * 1.3
  for (let k = 0; k < 180; k++) {
    const t0 = rr(0, 0.6)
    voice(x, t0, rr(1.2, 3.5), rnd() < 0.5 ? rr(150, 260) : rr(250, 420), rr(0.015, 0.035) * env(t0 + 0.5), { sustain: true, glide: rr(0.05, 0.2) })
  }
  // хлопки
  const bp = biquad('bp', 1800, 0.8)
  for (let k = 0; k < 500; k++) {
    const t0 = rr(0.4, 4.6)
    const v = rr(0.08, 0.2) * env(t0)
    for (let i = 0; i < 0.025 * SR; i++) x[Math.round(t0 * SR) + i] += bp(rnd() * 2 - 1) * Math.exp((-i / SR) * 220) * v
  }
  // свист
  for (let k = 0; k < 6; k++) {
    const t0 = rr(0.3, 3)
    const d = rr(0.5, 1.1)
    let ph = 0
    for (let i = 0; i < d * SR; i++) {
      const t = i / SR
      ph += (TAU * (2000 + 1200 * Math.sin(Math.PI * (t / d)))) / SR
      x[Math.round(t0 * SR) + i] += Math.sin(ph) * 0.05 * Math.sin(Math.PI * (t / d))
    }
  }
  for (let i = x.length - 0.4 * SR; i < x.length; i++) x[i] *= (x.length - i) / (0.4 * SR)
  normalize([x], 0.8)
  wav(join(ROOT, 'public/sounds/amb/cheer.wav'), [x])
}

// ===================== гаражи =====================
function paddock() {
  const dur = 18
  const x = new Float32Array(dur * SR)
  const p = pink()
  const fan = biquad('lp', 700, 0.7)
  const comp = biquad('bp', 380, 2)
  for (let i = 0; i < x.length; i++) {
    const t = i / SR
    // генератор: 50 Гц и гармоники
    const hum = Math.sin(TAU * 50 * t) * 0.18 + Math.sin(TAU * 100 * t) * 0.12 + Math.sin(TAU * 150 * t) * 0.05 + Math.sin(TAU * 200 * t) * 0.03
    // вентиляторы и компрессор (с «тарахтением» 18 Гц)
    const n = p()
    x[i] = hum * 0.6 + fan(n) * 0.9 + comp(n) * (0.5 + 0.5 * Math.sin(TAU * 18 * t)) * 0.4
  }
  // звяканье инструмента: затухающие неровные обертоны
  for (let k = 0; k < 16; k++) {
    const t0 = rr(0.2, dur - 1)
    const base = rr(900, 2200)
    const modes = [1, 2.76, 5.4, 8.93].map((m) => base * m * rr(0.97, 1.03))
    const v = rr(0.05, 0.14)
    for (let i = 0; i < 0.5 * SR; i++) {
      const t = i / SR
      let s = 0
      modes.forEach((f, j) => (s += Math.sin(TAU * f * t) * Math.exp(-t * (8 + j * 6)) / (j + 1)))
      x[Math.round(t0 * SR) + i] += s * v
    }
  }
  // гайковёрт в соседнем боксе: дребезг 0,2–0,4 с
  for (let k = 0; k < 5; k++) {
    const t0 = rr(0.5, dur - 1)
    const d = rr(0.2, 0.4)
    const bp = biquad('bp', 2300, 1.2)
    for (let i = 0; i < d * SR; i++) {
      const t = i / SR
      const pulse = 0.5 + 0.5 * Math.sin(TAU * 42 * t)
      x[Math.round(t0 * SR) + i] += bp(rnd() * 2 - 1) * pulse * Math.min(1, t * 80, (d - t) * 40) * 0.25
    }
  }
  // голоса механиков вдалеке
  for (let k = 0; k < 10; k++) voice(x, rr(0, dur - 2), rr(0.8, 1.8), rr(100, 160), rr(0.02, 0.04))
  const y = loopify(x, 16 * SR, 2)
  normalize([y], 0.6)
  wav(join(ROOT, 'public/sounds/amb/paddock.wav'), [y])
}

const only = process.argv[2]
if (!only || only === 'ui') ui()
if (!only || only === 'crowd') {
  crowd()
  cheer()
}
if (!only || only === 'paddock') paddock()
if (!only || only === 'music') music()
