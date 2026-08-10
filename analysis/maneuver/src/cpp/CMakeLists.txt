cmake_minimum_required(VERSION 3.15)
project(maneuver_sdn_plugin LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# NATIVE ONLY.
#
# The shipped wasm is built by analysis/maneuver/build.js through the SDK
# compiler lane (clang wasm32-wasip1-threads, threadModel wasi-sequential). This
# file exists for the C++ unit tests, which run natively. There is deliberately
# no emcc target here any more: the emcc link line is what silently deleted this
# module's entire error path in 0.1.0, and a second lane that can produce a
# DIFFERENT artifact from the same sources is exactly the drift the isomorphic
# law exists to stop.
#
# The tests compile WITH exceptions disabled, matching the shipped artifact:
# a unit test that runs under a different language dialect than the thing it
# tests is not testing the thing it tests.
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fno-exceptions")
set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} -O3 -DNDEBUG")

add_library(
    maneuver STATIC
    src/fault.cpp
    src/json_lite.cpp
    src/math.cpp
    src/stm.cpp
    src/transforms.cpp
    src/propagation.cpp
    src/targeting.cpp
    src/classical.cpp
    src/approach.cpp
    src/rendezvous.cpp
    src/maneuver_plugin.cpp
    src/plugin_runtime.cpp
)
target_include_directories(maneuver PUBLIC include)

add_executable(test_math tests/test_math.cpp)
target_link_libraries(test_math maneuver)
target_include_directories(test_math PRIVATE include)

add_executable(test_stm tests/test_stm.cpp)
target_link_libraries(test_stm maneuver)
target_include_directories(test_stm PRIVATE include)

add_executable(test_classical tests/test_classical.cpp)
target_link_libraries(test_classical maneuver)
target_include_directories(test_classical PRIVATE include)

add_executable(test_targeting tests/test_targeting.cpp)
target_link_libraries(test_targeting maneuver)
target_include_directories(test_targeting PRIVATE include)

add_executable(test_approach tests/test_approach.cpp)
target_link_libraries(test_approach maneuver)
target_include_directories(test_approach PRIVATE include)

add_executable(test_sixdof tests/test_sixdof.cpp)
target_include_directories(test_sixdof PRIVATE include)

add_executable(test_rendezvous tests/test_rendezvous.cpp)
target_link_libraries(test_rendezvous maneuver)
target_include_directories(test_rendezvous PRIVATE include)

enable_testing()
add_test(NAME math COMMAND test_math)
add_test(NAME stm COMMAND test_stm)
add_test(NAME classical COMMAND test_classical)
add_test(NAME targeting COMMAND test_targeting)
add_test(NAME approach COMMAND test_approach)
add_test(NAME maneuver_sixdof COMMAND test_sixdof)
add_test(NAME rendezvous COMMAND test_rendezvous)
