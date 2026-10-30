# -*- coding: utf-8 -*-
# Длинные ровные петли визга шин (вместо склейки коротких взвизгов, которая звучала «тряпкой по стеклу»):
#  tyre_squeal.wav   — Freesound 71739 «Chrysler LHS tire squeal 04» (audible-edge, CC0), 3,0–14,0 с
#  tyre_squeal2.wav  — Freesound 850041 «tire-squeal» (JeffPearson, CC0), 1,0–27,0 с, тон плавает — для заноса
# Срез ниже 350 Гц (шум дороги и мотора), шов петли сглажен 0,4 с, громкость выровнена, моно 44,1 кГц.
import array, math, os, subprocess, sys, wave

DL, OUT = sys.argv[1], sys.argv[2]
R = 44100


def cut(src, a, b):
    return array.array('h', subprocess.check_output(['ffmpeg', '-v', 'error', '-ss', str(a), '-to', str(b), '-i', src, '-ac', '1', '-ar', str(R), '-af', 'highpass=f=350,highpass=f=350', '-f', 's16le', '-']))


def seam(x, k):
    head, body = x[:k], x[k:]
    for i in range(k):
        t = i / k
        j = len(body) - k + i
        body[j] = int(body[j] * (1 - t) + head[i] * t)
    return body


def level(x, db=-16):
    rms = math.sqrt(sum(v * v for v in x) / len(x))
    g = (10 ** (db / 20) * 32768) / rms
    return array.array('h', (max(-32767, min(32767, int(v * g))) for v in x))


def write(x, name):
    w = wave.open(os.path.join(OUT, name), 'wb')
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(R)
    w.writeframes(x.tobytes())
    w.close()
    print(name, round(len(x) / R, 2), 's')


write(level(seam(cut(os.path.join(DL, '71739.mp3'), 3.0, 14.0), int(0.4 * R))), 'tyre_squeal.wav')
write(level(seam(cut(os.path.join(DL, '850041.mp3'), 1.0, 27.0), int(0.4 * R))), 'tyre_squeal2.wav')
