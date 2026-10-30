// Headless recorder for engine-sim (ange-yaghi/engine-sim, MIT): loads ../assets/main.mr,
// holds the engine on the dyno at fixed RPMs with full or zero throttle and writes WAV loops.
// usage: record <out_dir> <seconds> <rpm:throttle> [<rpm:throttle> ...]
#include "engine-sim/include/simulator.h"
#include "engine-sim/include/engine.h"
#include "engine-sim/include/units.h"
#include "engine-sim/include/ignition_module.h"
#include "engine-sim/include/exhaust_system.h"
#include "engine-sim/include/impulse_response.h"
#include "engine-sim/scripting/include/compiler.h"

#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

static bool readWav(const std::string &path, std::vector<int16_t> &out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    std::vector<char> d((std::istreambuf_iterator<char>(f)), {});
    size_t p = 12;
    int channels = 1, bits = 16;
    while (p + 8 <= d.size()) {
        uint32_t size;
        memcpy(&size, &d[p + 4], 4);
        if (!memcmp(&d[p], "fmt ", 4)) {
            channels = *(int16_t *)&d[p + 10];
            bits = *(int16_t *)&d[p + 22];
        } else if (!memcmp(&d[p], "data", 4)) {
            if (bits != 16) return false;
            const int16_t *s = (const int16_t *)&d[p + 8];
            const size_t n = size / 2 / channels;
            out.resize(n);
            for (size_t i = 0; i < n; ++i) out[i] = s[i * channels];
            return true;
        }
        p += 8 + size + (size & 1);
    }
    return false;
}

static void writeWav(const std::string &path, const std::vector<int16_t> &s, int rate) {
    std::ofstream f(path, std::ios::binary);
    const uint32_t data = (uint32_t)s.size() * 2, riff = 36 + data, fmt = 16, br = rate * 2;
    const uint16_t pcm = 1, ch = 1, ba = 2, bits = 16;
    f.write("RIFF", 4); f.write((const char *)&riff, 4); f.write("WAVEfmt ", 8);
    f.write((const char *)&fmt, 4); f.write((const char *)&pcm, 2); f.write((const char *)&ch, 2);
    f.write((const char *)&rate, 4); f.write((const char *)&br, 4); f.write((const char *)&ba, 2);
    f.write((const char *)&bits, 2); f.write("data", 4); f.write((const char *)&data, 4);
    f.write((const char *)s.data(), data);
}

int main(int argc, char **argv) {
    if (argc < 4) { fprintf(stderr, "usage: record <out_dir> <seconds> <rpm:throttle>...\n"); return 1; }
    const std::string outDir = argv[1];
    const double seconds = atof(argv[2]);

    es_script::Compiler compiler;
    compiler.initialize();
    if (!compiler.compile("../assets/main.mr")) { fprintf(stderr, "compile failed\n"); return 1; }
    es_script::Compiler::Output out = compiler.execute();
    compiler.destroy();
    Engine *engine = out.engine;
    if (!engine || !out.vehicle || !out.transmission) { fprintf(stderr, "no engine\n"); return 1; }

    Simulator *sim = engine->createSimulator(out.vehicle, out.transmission);
    const char *freq = getenv("FREQ");
    sim->setSimulationFrequency(freq ? atoi(freq) : (int)engine->getSimulationFrequency());
    Synthesizer::AudioParameters ap = sim->synthesizer().getAudioParameters();
    ap.inputSampleNoise = (float)engine->getInitialJitter();
    ap.airNoise = (float)engine->getInitialNoise();
    ap.dF_F_mix = (float)engine->getInitialHighFrequencyGain();
    const char *vol = getenv("VOL");
    ap.volume = vol ? (float)atof(vol) : 0.35f; // leveler targets ~30000: full volume clips
    sim->synthesizer().setAudioParameters(ap);
    for (int i = 0; i < engine->getExhaustSystemCount(); ++i) {
        ImpulseResponse *r = engine->getExhaustSystem(i)->getImpulseResponse();
        std::vector<int16_t> ir;
        if (!readWav(r->getFilename(), ir)) { fprintf(stderr, "ir fail %s\n", r->getFilename().c_str()); return 1; }
        sim->synthesizer().initializeImpulseResponse(ir.data(), (unsigned)ir.size(), (float)r->getVolume(), i);
    }
    fprintf(stderr, "engine: redline %.0f rpm, sim freq %.0f, dyno %.0f..%.0f\n", units::toRpm(engine->getRedline()),
        engine->getSimulationFrequency(), units::toRpm(engine->getDynoMinSpeed()), units::toRpm(engine->getDynoMaxSpeed()));

    std::vector<int16_t> chunk(8192);
    std::vector<int16_t> rec;
    double speed = 0.0;
    auto frame = [&](double throttle, bool keep) {
        speed = throttle * 0.5 + speed * 0.5;
        engine->setSpeedControl(speed);
        sim->startFrame(1 / 60.0);
        while (sim->simulateStep()) {}
        sim->endFrame();
        sim->synthesizer().renderAudio();
        const int n = sim->readAudioOutput((int)chunk.size(), chunk.data());
        if (keep) rec.insert(rec.end(), chunk.begin(), chunk.begin() + n);
    };

    // start: ignition + starter, idle a bit
    engine->getIgnitionModule()->m_enabled = true;
    sim->m_starterMotor.m_enabled = true;
    for (int i = 0; i < 60; ++i) frame(0.0, false);
    sim->m_starterMotor.m_enabled = false;
    for (int i = 0; i < 90; ++i) frame(0.0, false);

    for (int a = 3; a < argc; ++a) {
        double rpm = 0, thr = 0;
        sscanf(argv[a], "%lf:%lf", &rpm, &thr);
        const bool idle = rpm <= 0;
        sim->m_dyno.m_enabled = !idle;
        sim->m_dyno.m_hold = !idle;
        sim->m_dyno.m_rotationSpeed = units::rpm(rpm);
        rec.clear();
        for (int i = 0; i < 90; ++i) frame(thr, false); // settle
        const int frames = (int)(seconds * 60);
        for (int i = 0; i < frames; ++i) frame(thr, true);
        char name[256];
        snprintf(name, sizeof name, "%s/%s_%05d.wav", outDir.c_str(), idle ? "idle" : thr > 0.5 ? "on" : "off", (int)rpm);
        writeWav(name, rec, 44100);
        fprintf(stderr, "%s: %zu samples, engine %.0f rpm\n", name, rec.size(), engine->getRpm());
    }
    sim->destroy();
    return 0;
}
