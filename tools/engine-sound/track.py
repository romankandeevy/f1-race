# -*- coding: utf-8 -*-
# Основной тон записи мотора по времени (автокорреляция по кадрам) → обороты. usage: track.py file.wav cyl [start dur]
import subprocess, sys
import numpy as np

src = sys.argv[1]
cyl = int(sys.argv[2])
args = ['ffmpeg', '-v', 'error']
if len(sys.argv) > 4:
    args += ['-ss', sys.argv[3], '-t', sys.argv[4]]
R = 8000
x = np.frombuffer(subprocess.check_output(args + ['-i', src, '-ac', '1', '-ar', str(R), '-af', 'highpass=f=40', '-f', 'f32le', '-']), dtype=np.float32)
N = 2048
H = 160  # 20 мс
fmin, fmax = 40, 900
out = []
for i in range(0, len(x) - N, H):
    f = x[i:i + N] * np.hanning(N)
    e = np.sqrt(np.mean(f * f))
    F = np.fft.rfft(f, 2 * N)
    ac = np.fft.irfft(np.abs(F) ** 2)[:N]
    ac /= ac[0] + 1e-12
    lo, hi = int(R / fmax), int(R / fmin)
    seg = ac[lo:hi]
    k = int(np.argmax(seg)) + lo
    # уточнение параболой
    if 1 <= k < N - 1:
        a, b, c = ac[k - 1], ac[k], ac[k + 1]
        d = 0.5 * (a - c) / (a - 2 * b + c + 1e-12)
    else:
        d = 0
    f0 = R / (k + d)
    out.append((i / R, f0, ac[k], 20 * np.log10(e + 1e-9)))
out = np.array(out)
np.save(src + '.track.npy', out)
# сводка раз в 0,5 с: время, f0, обороты (f0 = обороты/60 · цил/2), уверенность, громкость
step = 25
for j in range(0, len(out), step):
    t, f0, q, db = out[j]
    print('%6.1f s  f0 %6.1f Hz  rpm %6.0f  conf %.2f  %5.1f dB' % (t, f0, f0 * 120 / cyl, q, db))
