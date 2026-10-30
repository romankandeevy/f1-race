# Звук мотора из engine-sim

Петли `public/sounds/engine/v10_*.wav` записаны из Engine Simulator (ange-yaghi/engine-sim, MIT), мотор V10 Lexus LFA (`assets/engines/atg-video-2/10_lfa_v10.mr`). Здесь же скрипты для визга (`make_squeal.py`) и ударов (`cut_hits.py`, `make_hits.py`) — источники в `public/sounds/CREDITS.md`.

1. `git clone --depth 1 --recurse-submodules https://github.com/ange-yaghi/engine-sim.git` рядом с этими файлами (папка `engine-sim`).
2. Правки под Mac (код писался под Windows/MSVC):
   - пути в `#include` с `\` → `/`;
   - piranha: `boost::filesystem` → `std::filesystem` (`include/path.h`, `src/path.cpp`, `is_complete` → `is_absolute`), `malloc.h` → `stdlib.h`;
   - `include/gas_system.h`: у `Mix` конструкторы вместо инициализаторов полей; `include/ring_buffer.h`: `start` → `m_start`;
   - `scripting/include/object_reference_node.h`: параметр шаблона `Type` → `T_Override`;
   - `src/piston_engine_simulator.cpp`: убрать `assert(m_antialiasingFilters …)`; `src/synthesizer.cpp`: убрать `#include "../include/delta.h"`;
   - `simple-2d-constraint-solver/src/sparse_matrix.cpp`: сначала `matrix.h`, потом `sparse_matrix.h`;
   - `extern constexpr` → `inline constexpr` во всех заголовках.
3. Парсер piranha: `bison` 3.x (`brew install bison`) и `flex` в `engine-sim/build/`:
   `/opt/homebrew/opt/bison/bin/bison -o parser.auto.cpp --defines=parser.auto.h ../dependencies/submodules/piranha/flex-bison/specification.y`,
   `flex -o scanner.auto.cpp --header-file=scanner.auto.h ../dependencies/submodules/piranha/flex-bison/scanner.l`.
4. `./build.sh` → `engine-sim/build/record`.
5. В `engine-sim/assets/main.mr` импортировать нужный мотор и `main()`. Из `engine-sim/run/`:
   `FREQ=20000 ../build/record ../out_v10 3.0 0:0 4000:1 5000:1 6000:1 7000:1 8000:1 9000:1 5000:0 7000:0 9000:0`
   (аргумент `об/мин:газ`, `0:0` — холостые).
6. `python3 make_loops.py engine-sim/out_v10 ../../public/sounds/engine v10 936` (последнее — обороты холостых) — петли целым числом рабочих циклов, громкость −16 дБ.
