# Native build of the CR3BP core and its C++ tests. The module artifact is built by ../../build.mjs (SDK compiler),
# which inlines include/cislunar/{types,constants,cr3bp}.h, src/cr3bp.cpp and src/tbp_module.cpp.
cmake_minimum_required(VERSION 3.15)
project(cislunar_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(cislunar STATIC src/cr3bp.cpp)
target_include_directories(cislunar PUBLIC include)

add_executable(test_cr3bp tests/test_cr3bp.cpp)
target_link_libraries(test_cr3bp cislunar)

add_executable(test_sixdof tests/test_sixdof.cpp)
target_include_directories(test_sixdof PRIVATE include)

enable_testing()
add_test(NAME cr3bp COMMAND test_cr3bp)
add_test(NAME cislunar_sixdof COMMAND test_sixdof)
