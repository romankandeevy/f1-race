# -*- coding: utf-8 -*-
# Режет запись на отдельные удары: начало — резкий рост громкости, конец — спад на 30 дБ (не длиннее max), затухание в конце.
# usage: cut_hits.py src.mp3 out_prefix max_s [min_gap_s]
import array, math, os, subprocess, sys, wave

src, prefix, max_s = sys.argv[1], sys.argv[2], float(sys.argv[3])
gap = float(sys.argv[4]) if len(sys.argv) > 4 else 0.4
R = 44100
a = array.array('h', subprocess.check_output(['ffmpeg', '-v', 'error', '-i', src, '-ac', '1', '-ar', str(R), '-f', 's16le', '-']))
W = R // 100  # 10 мс
env = []
for i in range(0, len(a) - W, W):
    env.append(10 * math.log10(sum(x * x for x in a[i:i + W]) / W / 32768 ** 2 + 1e-12))
peak = max(env)
hits = []
last = -999
for i in range(3, len(env)):
    rise = env[i] - min(env[i - 3:i])
    if env[i] > peak - 24 and rise > 12 and (i - last) * 0.01 > gap:
        # пик удара в ближайших 50 мс
        j = max(range(i, min(i + 5, len(env))), key=lambda k: env[k])
        end = j
        while end < len(env) and env[end] > env[j] - 30 and (end - i) * 0.01 < max_s:
            end += 1
        hits.append((i, j, end))
        last = i
os.makedirs(os.path.dirname(prefix) or '.', exist_ok=True)
for n, (i, j, end) in enumerate(hits):
    s0 = max(0, i * W - int(0.008 * R))
    s1 = min(len(a), end * W)
    seg = array.array('h', a[s0:s1])
    fade = min(len(seg), int(0.12 * R))
    for k in range(fade):
        idx = len(seg) - fade + k
        seg[idx] = int(seg[idx] * (1 - k / fade) ** 2)
    pk = max(1, max(abs(x) for x in seg))
    g = 0.89 * 32767 / pk
    seg = array.array('h', (int(x * g) for x in seg))
    # «яркость»: доля переходов через ноль (больше — звонче)
    zc = sum(1 for k in range(1, len(seg)) if (seg[k - 1] < 0) != (seg[k] < 0)) / (len(seg) / R)
    name = f'{prefix}_{n:02d}.wav'
    w = wave.open(name, 'wb')
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(R); w.writeframes(seg.tobytes()); w.close()
    print(os.path.basename(name), '@%.2fs' % (i * 0.01), 'len %.2fs' % ((s1 - s0) / R), 'peak %.1f dB' % env[j], 'zc %d/s' % zc)
