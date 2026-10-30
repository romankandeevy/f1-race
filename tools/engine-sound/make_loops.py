# -*- coding: utf-8 -*-
# Петли мотора из записей engine-sim (usage: src out prefix idle_rpm): берём середину 2,2 с, сглаживаем шов (0,15 с), выравниваем громкость к общему уровню
import array, glob, math, os, sys, wave
SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
R = 44100
for f in sorted(glob.glob(os.path.join(SRC, '*.wav'))):
    w = wave.open(f)
    a = array.array('h', w.readframes(w.getnframes()))
    # длина петли — целое число рабочих циклов мотора (2 оборота): шов почти незаметен, сглаживание короткое
    base = os.path.basename(f)
    rpm = int(sys.argv[4]) if base.startswith('idle') else int(base.split('_')[1][:-4])
    cycle = 120 / rpm * R
    k = int(0.04 * R)
    n = int(round(int(2.2 * R / cycle) * cycle))
    a = a[int(0.5 * R):int(0.5 * R) + n + k]
    head, body = a[:k], a[k:]
    for i in range(k):
        t = i / k
        j = len(body) - k + i
        body[j] = int(body[j] * (1 - t) + head[i] * t)
    rms = math.sqrt(sum(x * x for x in body) / len(body))
    g = (10 ** (-16 / 20) * 32768) / rms
    body = array.array('h', (max(-32767, min(32767, int(x * g))) for x in body))
    name = os.path.basename(f).replace('_0', '_').replace('idle_0000', 'idle')
    o = wave.open(os.path.join(OUT, sys.argv[3] + '_' + name), 'wb')
    o.setnchannels(1); o.setsampwidth(2); o.setframerate(R); o.writeframes(body.tobytes()); o.close()
    print(name, round(len(body) / R, 2), 's')
