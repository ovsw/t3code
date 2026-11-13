"""Regenerates the Walk mode cue WAVs in this folder: python3 generate.py

Low, struck sounds (wood and mallet), 44.1 kHz mono 16-bit, all peak-normalized to the same level.
Standard library only.
"""
import math, os, random, struct, wave

SR = 44100
OUT = os.path.dirname(os.path.abspath(__file__))


def silence(ms):
    return [0.0] * int(SR * ms / 1000)


def lowpass(x, cutoff):
    alpha = (1 / SR) / (1 / (2 * math.pi * cutoff) + 1 / SR)
    y, prev = [], 0.0
    for v in x:
        prev += alpha * (v - prev)
        y.append(prev)
    return y


def struck(f, ms, partials, attack, decay, cutoff, noise=0.0, drop_from=None, drop_ms=14):
    n = int(SR * ms / 1000)
    a = max(1, int(SR * attack / 1000))
    g = int(SR * drop_ms / 1000)
    out, phase = [], [0.0] * len(partials)
    for i in range(n):
        t = i / SR * 1000
        e = (0.5 - 0.5 * math.cos(math.pi * min(1.0, i / a))) * math.exp(-max(0.0, t - attack) / decay)
        freq = f if drop_from is None else f + (drop_from - f) * (1 - min(1.0, i / g)) ** 2
        s = 0.0
        for j, (mult, amp) in enumerate(partials):
            phase[j] += 2 * math.pi * freq * mult / SR
            # Upper partials die faster, like a struck object.
            s += amp * math.sin(phase[j]) * math.exp(-t * (mult - 1) / (decay * 1.2))
        if noise:
            s += noise * (random.random() * 2 - 1) * math.exp(-t / 6)
        out.append(s * e)
    return lowpass(out, cutoff)


def wood(f, ms=60, decay=16):
    return struck(f, ms, ((1, 1.0), (2.76, 0.35)), 1.5, decay, 2200, noise=0.08)


def mallet(f, ms=120, decay=45):
    return struck(f, ms, ((1, 1.0), (4, 0.25)), 2, decay, 2000)


def seq(*parts):
    return [v for p in parts for v in p]


def write(name, x, peak=0.7):
    fade = int(SR * 0.004)
    for i in range(fade):
        x[-1 - i] *= i / fade
    m = max(abs(v) for v in x) or 1
    with wave.open(os.path.join(OUT, f"{name}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", int(v / m * peak * 32767)) for v in x))


random.seed(7)
# Order matters: the noise in wood() draws from the seeded generator.
write("press", wood(400, 50))
write("mic-live", seq(wood(392, 60), silence(25), wood(523, 70)))
write("recording-stopped", seq(wood(523, 60), silence(25), wood(392, 70)))
write("saved", mallet(349, 140))
write("sent", seq(mallet(262, 70, 30), silence(20), mallet(523, 120, 45)))
write("error", seq(wood(220, 60), silence(50), wood(220, 70)))
write("thinking", struck(196, 90, ((1, 1.0),), 2, 35, 1800, drop_from=294))
