cmake_minimum_required(VERSION 3.15)
project(higherpop LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG")

# Header-only core library.
add_library(higherpop INTERFACE)
target_include_directories(higherpop INTERFACE
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>)
target_compile_features(higherpop INTERFACE cxx_std_17)

# -march=native only for local benchmarking (not for the shipped WASM path).
option(HIGHERPOP_NATIVE_ARCH "Tune for the build host (benchmarking)" ON)
if(HIGHERPOP_NATIVE_ARCH AND NOT EMSCRIPTEN)
  target_compile_options(higherpop INTERFACE -march=native)
endif()

enable_testing()

add_executable(hp_validate test/validate.cpp)
target_link_libraries(hp_validate PRIVATE higherpop)
add_test(NAME validate COMMAND hp_validate)

# Regularized-formulation self-tests (no hpop dependency).
add_executable(hp_dromo test/dromo_test.cpp)
target_link_libraries(hp_dromo PRIVATE higherpop)
add_test(NAME dromo COMMAND hp_dromo)

add_executable(hp_bench bench/bench.cpp)
target_link_libraries(hp_bench PRIVATE higherpop)

# --------------------------------------------------------------------------
# RPO / relative-motion suite tests.
foreach(rpo_test stm lvlh maneuver lambert)
  add_executable(hp_rpo_${rpo_test} test/rpo/${rpo_test}_validate.cpp)
  target_link_libraries(hp_rpo_${rpo_test} PRIVATE higherpop)
  add_test(NAME rpo_${rpo_test} COMMAND hp_rpo_${rpo_test})
endforeach()

# --------------------------------------------------------------------------
# Differential-correction / targeting solver (hp::target). Header-only, no deps.
add_executable(hp_target test/target/target_validate.cpp)
target_link_libraries(hp_target PRIVATE higherpop)
add_test(NAME target COMMAND hp_target)

# --------------------------------------------------------------------------
# IAU-2006/2000A frame chain (hp::frames). Wraps the vendored ERFA core, so
# the frames test links the compiled ERFA objects (third_party/erfa/*.c).
# The rest of higherpop stays dependency-free — only frames.hpp needs ERFA.
file(GLOB ERFA_SRC "${CMAKE_CURRENT_SOURCE_DIR}/third_party/erfa/*.c")
# erfaversion.c needs build-time -D defines we don't set; drop it (unused).
list(FILTER ERFA_SRC EXCLUDE REGEX "erfaversion\\.c$")
add_library(higherpop_erfa STATIC ${ERFA_SRC})
target_include_directories(higherpop_erfa PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/third_party/erfa>)
set_target_properties(higherpop_erfa PROPERTIES C_STANDARD 99)

add_executable(hp_frames test/frames/frames_validate.cpp)
target_include_directories(hp_frames PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/test/frames)
target_link_libraries(hp_frames PRIVATE higherpop higherpop_erfa)
add_test(NAME frames COMMAND hp_frames)

# Eclipse / lighting (hp::lighting) also links ERFA (Sun/Moon ephemeris).
add_executable(hp_lighting test/lighting/lighting_validate.cpp)
target_link_libraries(hp_lighting PRIVATE higherpop higherpop_erfa)
add_test(NAME lighting COMMAND hp_lighting)

# Station-keeping (hp::stationkeeping) — header-only, no deps.
add_executable(hp_stationkeeping test/stationkeeping/sk_validate.cpp)
target_link_libraries(hp_stationkeeping PRIVATE higherpop)
add_test(NAME stationkeeping COMMAND hp_stationkeeping)

# Interplanetary patched-conic (hp::interplanetary) — links ERFA (plan94).
add_executable(hp_interplanetary test/interplanetary/ip_validate.cpp)
target_link_libraries(hp_interplanetary PRIVATE higherpop higherpop_erfa)
add_test(NAME interplanetary COMMAND hp_interplanetary)

# --------------------------------------------------------------------------
# Cross-validation against the sibling hpop plugin (optional).
# Enable with -DHIGHERPOP_XCHECK_HPOP=ON. Requires hpop's lib/ sources and the
# vendored NRLMSISE-00 to be compiled/linked; paths are relative to this repo.
# match_accel.cpp / crosscheck_hpop.cpp include "force_models.h" from hpop.
# --------------------------------------------------------------------------
option(HIGHERPOP_XCHECK_HPOP "Build hpop cross-validation harnesses" OFF)
if(HIGHERPOP_XCHECK_HPOP)
  set(HPOP_LIB "${CMAKE_CURRENT_SOURCE_DIR}/../propagator/hpop/lib")
  set(NRL "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/nrlmsise00")
  file(GLOB HPOP_SRC "${HPOP_LIB}/*.cpp")
  add_executable(hp_xcheck test/crosscheck_hpop.cpp ${HPOP_SRC}
                 ${NRL}/nrlmsise-00.c ${NRL}/nrlmsise-00_data.c)
  target_include_directories(hp_xcheck PRIVATE ${HPOP_LIB} ${NRL})
  target_link_libraries(hp_xcheck PRIVATE higherpop)
  add_test(NAME xcheck_hpop COMMAND hp_xcheck)
endif()
