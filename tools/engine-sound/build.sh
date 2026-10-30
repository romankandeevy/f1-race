#!/bin/zsh
set -e
cd "$(dirname $0)/engine-sim"
D=dependencies/submodules
mkdir -p build/obj
SRCS=(src/{audio_buffer,camshaft,crankshaft,combustion_chamber,connecting_rod,convolution_filter,cylinder_bank,cylinder_head,delay_filter,derivative_filter,direct_throttle_linkage,dynamometer,engine,exhaust_system,feedback_comb_filter,filter,fuel,function,gas_system,gaussian_filter,governor,ignition_module,impulse_response,intake,jitter_filter,leveling_filter,low_pass_filter,part,piston,piston_engine_simulator,simulator,standard_valvetrain,starter_motor,synthesizer,throttle,transmission,utilities,valvetrain,vehicle,vehicle_drag_constraint,vtec_valvetrain}.cpp scripting/src/*.cpp $D/simple-2d-constraint-solver/src/*.cpp $D/csv-io/src/csv_data.cpp $D/csv-io/src/information.cpp $D/piranha/src/*.cpp build/parser.auto.cpp build/scanner.auto.cpp ../record.cpp)
FLAGS=(-D__int64="long long" -D__forceinline=inline -std=c++17 -O2 -w -DATG_ENGINE_SIM_PIRANHA_ENABLED -I$D -Ibuild -I$D/piranha/include -I/Library/Developer/CommandLineTools/usr/include -Iinclude -Iscripting/include)
objs=()
for s in $SRCS; do
  o=build/obj/${${s//\//_}%.cpp}.o
  objs+=$o
  if [[ ! -f $o || $s -nt $o ]]; then clang++ $FLAGS -c $s -o $o & fi
  while (( $(jobs | wc -l) >= 8 )); do sleep 0.2; done
done
wait
clang++ $objs -o build/record
echo built
