# -*- coding: utf-8 -*-
# Банк ударов (все CC0, Freesound) вместо прежних «стекло / печенька»:
#  crash_*  — 346299 «Car Crash_EXT», 346301 «Car Crash_M-S» (3038712): сам удар машины и хвост обломков 3,55–5,8 с
#  wall_*   — 474007/474008 «Body Hit On Metal Fence 1/2» (8947290): удар о металлическое ограждение, как об отбойник
#  metal_*  — 798843 «Metal Impact Medium Bang Resonate x17» (9839964): тяжёлые удары по металлу, самые глухие
#  thump_*  — 396686 «Foley man hitting a car bonnet various» (255403): глухие удары по кузову (лёгкие касания)
import array, os, shutil, subprocess, sys, wave

S, OUT = sys.argv[1], sys.argv[2]
R = 44100
os.makedirs(OUT, exist_ok=True)


def save(seg, name):
    pk = max(1, max(abs(x) for x in seg))
    g = 0.89 * 32767 / pk
    seg = array.array('h', (int(x * g) for x in seg))
    w = wave.open(os.path.join(OUT, name), 'wb')
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(R); w.writeframes(seg.tobytes()); w.close()
    print(name, round(len(seg) / R, 2), 's')


def crash(src, a, b, name):
    seg = array.array('h', subprocess.check_output(['ffmpeg', '-v', 'error', '-ss', str(a), '-to', str(b), '-i', src, '-ac', '1', '-ar', str(R), '-af', 'highpass=f=45', '-f', 's16le', '-']))
    fade = int(0.6 * R)
    for k in range(fade):
        i = len(seg) - fade + k
        seg[i] = int(seg[i] * (1 - k / fade) ** 2)
    save(seg, name)


def copy(cut, name):
    w = wave.open(os.path.join(S, 'hits_cut', cut + '.wav'))
    save(array.array('h', w.readframes(w.getnframes())), name)


crash(os.path.join(S, 'dl_crash', '346299.mp3'), 3.55, 5.8, 'crash_1.wav')
crash(os.path.join(S, 'dl_crash', '346301.mp3'), 3.55, 5.8, 'crash_2.wav')
for i, c in enumerate(['474007_00', '474007_03', '474007_07', '474008_00', '474008_06']):
    copy(c, f'wall_{i + 1}.wav')
for i, c in enumerate(['798843_05', '798843_11', '798843_13', '798843_15']):
    copy(c, f'metal_{i + 1}.wav')
for i, c in enumerate(['396686_00', '396686_01', '396686_02', '396686_04', '396686_06']):
    copy(c, f'thump_{i + 1}.wav')
