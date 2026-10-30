# -*- coding: utf-8 -*-
# Петли мотора из записи проходов по оборотам (как делают студии): обороты по гармоникам, куски вокруг нужных
# оборотов выпрямляются по высоте (время перетягивается так, чтобы фаза мотора шла ровно), режутся целым числом
# рабочих циклов (2 оборота) и сглаживаются по шву.
# usage: ramp_loops.py src.wav out_dir prefix cyl rpm_list(on) rpm_list(off) [rpm_min rpm_max] [analyze]
import os, subprocess, sys, wave
import numpy as np

src, out, prefix, cyl = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
ON = [int(v) for v in sys.argv[5].split(',') if v]
OFF = [int(v) for v in sys.argv[6].split(',') if v]
RMIN, RMAX = (int(sys.argv[7]), int(sys.argv[8])) if len(sys.argv) > 8 else (1500, 9500)
ANALYZE = 'analyze' in sys.argv
R = 48000
x = np.frombuffer(subprocess.check_output(['ffmpeg', '-v', 'error', '-i', src, '-ac', '1', '-ar', str(R), '-af', 'highpass=f=25', '-f', 'f32le', '-']), dtype=np.float32).astype(np.float64)

# --- обороты: гармоническая сумма по кадрам 120 мс, шаг 10 мс, порядки 1…12 (основной — 1-й порядок = обороты/60)
R2 = 8000
y = np.frombuffer(subprocess.check_output(['ffmpeg', '-v', 'error', '-i', src, '-ac', '1', '-ar', str(R2), '-f', 'f32le', '-']), dtype=np.float32).astype(np.float64)
N, H, NF = 960, 80, 16384
win = np.hanning(N)
cands = np.geomspace(RMIN, RMAX, 500) / 60.0  # частота 1-го порядка (логарифмическая сетка)
fr = np.fft.rfftfreq(NF, 1 / R2)
orders = np.arange(1, 13)
wts = np.where(orders % 1 == 0, 1.0, 1.0)
frames = range(0, len(y) - N, H)
score = np.zeros((len(frames), len(cands)))
loud = np.zeros(len(frames))
for j, i in enumerate(frames):
    f = y[i:i + N] * win
    S = np.abs(np.fft.rfft(f, NF))
    loud[j] = 20 * np.log10(np.sqrt(np.mean(f * f)) + 1e-9)
    L = np.log1p(S / (S.mean() + 1e-12))
    idx = np.clip(np.round(np.outer(cands, orders) / (R2 / NF)).astype(int), 0, len(L) - 1)
    score[j] = (L[idx] * wts).sum(axis=1)
# путь с плавностью (динамика): за 10 мс обороты меняются не больше чем на 4%
T = len(frames)
cost = score.copy()
back = np.zeros((T, len(cands)), dtype=int)
from numpy.lib.stride_tricks import sliding_window_view as sw
W = max(1, int(round(np.log(1.04) / np.log(cands[1] / cands[0]))))
ar = np.arange(len(cands))
for j in range(1, T):
    prev = np.pad(cost[j - 1], (W, W), constant_values=-1e18)
    win_ = sw(prev, 2 * W + 1)
    m = np.argmax(win_, axis=1)
    back[j] = ar + m - W
    cost[j] = score[j] + win_[ar, m]
path = np.zeros(T, dtype=int)
path[-1] = int(np.argmax(cost[-1]))
for j in range(T - 1, 0, -1):
    path[j - 1] = back[j, path[j]]
rpm = cands[path] * 60
tt = (np.array(list(frames)) + N / 2) / R2
drpm = np.gradient(rpm) / (H / R2)  # об/мин в секунду
if ANALYZE:
    for j in range(0, T, 50):
        print('%6.1f s  rpm %5.0f  d %+6.0f/s  %5.1f dB' % (tt[j], rpm[j], drpm[j], loud[j]))
    np.save(src + '.rpm.npy', np.vstack([tt, rpm, loud, drpm]))
    sys.exit()

# --- петля для оборотов target: лучший кусок, где обороты проходят target (под газом — растут и громко, на сбросе — падают)
f1 = np.interp(np.arange(len(x)) / R, tt, rpm / 60.0)
phase = np.cumsum(f1) / R  # обороты мотора от начала
os.makedirs(out, exist_ok=True)


def make(target, kind):
    up = kind == 'on'
    best = None
    for j in range(5, T - 5):
        if abs(rpm[j] - target) / target > 0.03:
            continue
        rising = drpm[j] > 200
        falling = drpm[j] < -200
        if up and not rising or not up and not falling:
            continue
        s = loud[j] if up else -abs(loud[j] - np.median(loud))
        if best is None or s > best[0]:
            best = (s, j)
    if best is None:
        print('нет куска для', kind, target)
        return
    j = best[1]
    t0 = tt[j]
    # кусок ±0,6 с вокруг, выпрямленный: время t(n) такое, что фаза растёт ровно с частотой target/60
    i0 = int((t0 - 0.6) * R)
    i1 = int((t0 + 0.6) * R)
    ph = phase[i0:i1]
    ft = target / 60.0
    cycles = 2.0  # рабочий цикл — 2 оборота
    n_cycles = int((ph[-1] - ph[0] - 0.05) / cycles)
    total = n_cycles * cycles
    nout = int(round(total / ft * R))
    k = int(0.03 * R)
    want = ph[0] + np.arange(nout + k) * ft / R
    pos = np.interp(want, ph, np.arange(i0, i1))
    seg = np.interp(pos, np.arange(len(x)), x)
    head, body = seg[:k], seg[k:].copy()
    w = np.linspace(0, 1, k)
    body[-k:] = body[-k:] * (1 - w) + head * w
    body = body / (np.sqrt(np.mean(body ** 2)) + 1e-12) * 10 ** (-16 / 20)
    body = np.clip(body, -0.99, 0.99)
    name = os.path.join(out, f'{prefix}_{kind}_{target}.wav')
    wv = wave.open(name, 'wb')
    wv.setnchannels(1); wv.setsampwidth(2); wv.setframerate(R)
    wv.writeframes((body * 32767).astype('<i2').tobytes()); wv.close()
    print(os.path.basename(name), 'из %.2f с' % t0, 'длина %.2f с' % (len(body) / R), 'громкость там %.1f дБ' % loud[j], 'скорость оборотов %+.0f/с' % drpm[j])


for r in ON:
    make(r, 'on')
for r in OFF:
    make(r, 'off')
