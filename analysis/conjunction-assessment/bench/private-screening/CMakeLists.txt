cmake_minimum_required(VERSION 3.16)
project(private_screening_bench CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Microsoft SEAL, the version and configuration FlatBuffers' homomorphic
# encryption builds with (flatbuffers/CMakeLists.txt).
include(FetchContent)
FetchContent_Declare(SEAL
  GIT_REPOSITORY https://github.com/microsoft/SEAL.git
  GIT_TAG v4.1.1)
set(SEAL_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SEAL_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(SEAL_BUILD_BENCH OFF CACHE BOOL "" FORCE)
set(SEAL_USE_INTEL_HEXL OFF CACHE BOOL "" FORCE)
set(SEAL_USE_ZLIB OFF CACHE BOOL "" FORCE)
set(SEAL_USE_ZSTD OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(SEAL)

add_executable(private_screening_bench private_screening_bench.cpp)
target_link_libraries(private_screening_bench PRIVATE SEAL::seal)
