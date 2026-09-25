cmake_minimum_required(VERSION 3.15)
project(atmosphere_sdn_plugin LANGUAGES CXX C)

# Vendored public-domain NRLMSISE-00 C port (Picone/Hedin/Drob via Brodowski).
set(NRLMSISE00_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../third_party/nrlmsise00")
# Vendored HWM14 horizontal wind model (bit-exact C++ port of the NRL release).
set(HWM14_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../third_party/hwm14")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# No -ffast-math: it lets the compiler assume NaN and infinity never occur,
# which makes the module's input validation undefined. No -march=native:
# native test binaries must not depend on the build machine.
if(EMSCRIPTEN)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3 -flto -DNDEBUG")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -O3 -flto")
else()
    set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} -O3 -flto")
    set(CMAKE_INTERPROCEDURAL_OPTIMIZATION TRUE)
endif()

find_path(
    FLATBUFFERS_INCLUDE_DIR
    NAMES flatbuffers/flatbuffers.h
    PATHS
        "$ENV{SDN_FLATBUFFERS_INCLUDE_DIR}"
        "$ENV{FLATBUFFERS_INCLUDE_DIR}"
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../flatbuffers/include"
        /opt/homebrew/include
        /opt/homebrew/opt/flatbuffers/include
        /usr/local/include
        /usr/local/opt/flatbuffers/include
    NO_CMAKE_FIND_ROOT_PATH
)

if(NOT FLATBUFFERS_INCLUDE_DIR)
    message(FATAL_ERROR "flatbuffers headers not found. Install flatbuffers and retry.")
endif()

add_library(
    atmosphere STATIC
    src/us76.cpp
    src/nrlmsise00.cpp
    src/plugin_runtime.cpp
    src/space_weather.cpp
    src/winds.cpp
    "${NRLMSISE00_DIR}/nrlmsise-00.c"
    "${NRLMSISE00_DIR}/nrlmsise-00_data.c"
    "${HWM14_DIR}/hwm14.cpp"
    "${HWM14_DIR}/hwm14_data.cpp"
)
target_include_directories(atmosphere PUBLIC include "${NRLMSISE00_DIR}" "${HWM14_DIR}")

if(NOT EMSCRIPTEN)
    add_executable(test_atmosphere tests/test_atmosphere.cpp)
    target_link_libraries(test_atmosphere atmosphere)
    target_include_directories(test_atmosphere PRIVATE include)

    add_executable(test_sixdof tests/test_sixdof.cpp)
    target_include_directories(test_sixdof PRIVATE include)

    add_executable(test_space_weather tests/test_space_weather.cpp)
    target_link_libraries(test_space_weather atmosphere)
    target_include_directories(test_space_weather PRIVATE include)

    add_executable(test_nrlmsise_package tests/test_nrlmsise_package.cpp)
    target_link_libraries(test_nrlmsise_package atmosphere)

    enable_testing()
    add_test(NAME atmosphere COMMAND test_atmosphere)
    add_test(NAME nrlmsise_package COMMAND test_nrlmsise_package)
    add_test(NAME atmosphere_sixdof COMMAND test_sixdof)
    add_test(NAME atmosphere_space_weather COMMAND test_space_weather)
endif()

if(EMSCRIPTEN)
    # --- Emscripten browser artifact ---
    add_executable(
        atmosphere_wasm
        wasm_api.cpp
        src/plugin_entrypoints.cpp
        src/plugin_invoke_bridge.cpp
    )
    target_include_directories(
        atmosphere_wasm PRIVATE
        include
        generated
        generated/sds
        "${FLATBUFFERS_INCLUDE_DIR}"
    )
    target_link_libraries(atmosphere_wasm atmosphere)
    set_target_properties(
        atmosphere_wasm PROPERTIES
        SUFFIX ".js"
        LINK_FLAGS "\
            -s EXPORTED_FUNCTIONS='[\"_wasm_malloc\",\"_wasm_free\",\"_wasm_invoke_json\",\"_plugin_alloc\",\"_plugin_free\",\"_plugin_invoke_stream\",\"_plugin_get_manifest_flatbuffer\",\"_plugin_get_manifest_flatbuffer_size\"]' \
            -s EXPORTED_RUNTIME_METHODS='[\"ccall\",\"cwrap\",\"UTF8ToString\",\"stringToUTF8\",\"lengthBytesUTF8\"]' \
            -s MODULARIZE=1 \
            -s EXPORT_NAME='AtmosphereModule' \
            -s STANDALONE_WASM=1 \
            -s INITIAL_MEMORY=67108864 \
            -s STACK_SIZE=2097152 \
            -s MALLOC='emmalloc' \
            -s FILESYSTEM=0 \
        "
    )
elseif(WASI_SDK)
    # --- Standalone WASI artifact (isomorphic — runs in WasmEdge and browser via shim) ---
    add_executable(
        atmosphere_standalone
        wasm_api.cpp
        src/plugin_entrypoints.cpp
        src/plugin_invoke_bridge.cpp
    )
    target_include_directories(
        atmosphere_standalone PRIVATE
        include
        generated
        generated/sds
        "${FLATBUFFERS_INCLUDE_DIR}"
    )
    target_link_libraries(atmosphere_standalone atmosphere)
    set_target_properties(
        atmosphere_standalone PROPERTIES
        SUFFIX ".wasm"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    )
    target_link_options(atmosphere_standalone PRIVATE
        -Wl,--export=plugin_alloc
        -Wl,--export=plugin_free
        -Wl,--export=plugin_invoke_stream
        -Wl,--export=plugin_get_manifest_flatbuffer
        -Wl,--export=plugin_get_manifest_flatbuffer_size
    )
endif()
