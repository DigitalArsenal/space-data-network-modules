cmake_minimum_required(VERSION 3.15)
project(atmosphere_sdn_plugin LANGUAGES CXX C)

# Vendored public-domain NRLMSISE-00 C port (Picone/Hedin/Drob via Brodowski).
set(NRLMSISE00_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../third_party/nrlmsise00")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(EMSCRIPTEN)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3 -flto -ffast-math -DNDEBUG")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -O3 -flto")
else()
    set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} -O3 -flto -ffast-math -march=native -mtune=native")
    set(CMAKE_INTERPROCEDURAL_OPTIMIZATION TRUE)
endif()

find_path(
    FLATBUFFERS_INCLUDE_DIR
    NAMES flatbuffers/flatbuffers.h
    PATHS
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
    "${NRLMSISE00_DIR}/nrlmsise-00.c"
    "${NRLMSISE00_DIR}/nrlmsise-00_data.c"
)
target_include_directories(atmosphere PUBLIC include "${NRLMSISE00_DIR}")

if(NOT EMSCRIPTEN)
    add_executable(test_atmosphere tests/test_atmosphere.cpp)
    target_link_libraries(test_atmosphere atmosphere)
    target_include_directories(test_atmosphere PRIVATE include)

    add_executable(test_sixdof tests/test_sixdof.cpp)
    target_include_directories(test_sixdof PRIVATE include)

    enable_testing()
    add_test(NAME atmosphere COMMAND test_atmosphere)
    add_test(NAME atmosphere_sixdof COMMAND test_sixdof)
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
