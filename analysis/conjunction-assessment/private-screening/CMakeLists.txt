# The private screening protocol driver (PROTOCOL-19.md), on the FlatBuffers
# fork's homomorphic batching API (he_encryption.h) and Microsoft SEAL 4.1.1.
#   cmake -S private-screening -B <build> -G Ninja -DCMAKE_BUILD_TYPE=Release
#   cmake --build <build> -j 4
# tests/privateScreeningKnownAnswer.e2e.mjs and
# tests/privateScreeningCost.e2e.mjs run these two steps and the driver.
cmake_minimum_required(VERSION 3.16)
project(private_screening_protocol CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

include(FetchContent)
# The SEAL version and configuration of the fork's he_encryption build.
FetchContent_Declare(
  seal
  GIT_REPOSITORY https://github.com/microsoft/SEAL.git
  GIT_TAG        v4.1.1
  GIT_SHALLOW    TRUE
  SYSTEM
)
set(SEAL_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SEAL_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(SEAL_BUILD_BENCH OFF CACHE BOOL "" FORCE)
set(SEAL_USE_INTEL_HEXL OFF CACHE BOOL "" FORCE)
set(SEAL_THROW_ON_TRANSPARENT_CIPHERTEXT OFF CACHE BOOL "" FORCE)
set(SEAL_USE_ZLIB OFF CACHE BOOL "" FORCE)
set(SEAL_USE_ZSTD OFF CACHE BOOL "" FORCE)
set(CMAKE_POLICY_VERSION_MINIMUM 3.5 CACHE STRING "" FORCE)
FetchContent_MakeAvailable(seal)

# The homomorphic batching API: the FlatBuffers fork at the pinned commit
# (n 8192 and 16384, three 60-bit CRT moduli, |v| <= 2^178 - 1, refusals,
# the depth table). FLATBUFFERS_HE_SOURCE_DIR names a local checkout of that
# commit instead of fetching it.
set(FLATBUFFERS_HE_GIT_TAG 55a0ca86fcf0b7a0ad83491bdac733e3d6262d4f)
if(FLATBUFFERS_HE_SOURCE_DIR)
  set(FB_ROOT "${FLATBUFFERS_HE_SOURCE_DIR}")
else()
  FetchContent_Declare(
    flatbuffers_he
    GIT_REPOSITORY https://github.com/DigitalArsenal/flatbuffers.git
    GIT_TAG        ${FLATBUFFERS_HE_GIT_TAG}
  )
  FetchContent_Populate(flatbuffers_he)
  set(FB_ROOT "${flatbuffers_he_SOURCE_DIR}")
endif()

add_executable(private_screening_protocol
  protocol.cpp
  "${FB_ROOT}/src/he_encryption.cpp"
  "${FB_ROOT}/src/he_encryption_wasi.cpp"
  "${FB_ROOT}/src/encryption.cpp")
target_include_directories(private_screening_protocol PRIVATE "${FB_ROOT}/include")
target_compile_definitions(private_screening_protocol PRIVATE FLATBUFFERS_HE_USE_SEAL=1)
target_link_libraries(private_screening_protocol PRIVATE seal)

# The noise-channel measurement (PROTOCOL-NOISE.md): one translation unit with
# the fork's he_encryption.cpp, built with -fno-access-control so that the
# requester, the key holder, reaches its own decryptor's phase routine.
add_executable(private_screening_noise
  noise_channel.cpp
  "${FB_ROOT}/src/he_encryption_wasi.cpp"
  "${FB_ROOT}/src/encryption.cpp")
target_include_directories(private_screening_noise PRIVATE "${FB_ROOT}/include" "${FB_ROOT}/src")
target_compile_definitions(private_screening_noise PRIVATE FLATBUFFERS_HE_USE_SEAL=1)
target_compile_options(private_screening_noise PRIVATE -fno-access-control)
target_link_libraries(private_screening_noise PRIVATE seal)
