cmake_minimum_required(VERSION 3.15)
project(hpop_sdn_plugin LANGUAGES CXX C)

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
    hpop STATIC
    src/astrodynamics.cpp
    src/integrators.cpp
    src/coords.cpp
    ../../lib/atmosphere_plugin.cpp
    src/environment_models.cpp
    src/ephemeris.cpp
    src/force_models.cpp
    src/nrlmsise00.cpp
    src/time_convert.cpp
    src/us76.cpp
    src/plugin_runtime.cpp
    "${NRLMSISE00_DIR}/nrlmsise-00.c"
    "${NRLMSISE00_DIR}/nrlmsise-00_data.c"
)
target_include_directories(hpop PUBLIC include include/hpop "${NRLMSISE00_DIR}")

if(NOT EMSCRIPTEN)
    # Native test targets can be added here
endif()

if(EMSCRIPTEN)
    # --- Emscripten browser artifact ---
    add_executable(
        hpop_wasm
        ../hpop_plugin.cpp
        wasm_api.cpp
        src/plugin_entrypoints.cpp
        src/plugin_invoke_bridge.cpp
    )
    target_include_directories(
        hpop_wasm PRIVATE
        ..
        include
        generated
        generated/sds
        "${FLATBUFFERS_INCLUDE_DIR}"
    )
    target_link_libraries(hpop_wasm hpop)
    set_target_properties(
        hpop_wasm PROPERTIES
        SUFFIX ".js"
        LINK_FLAGS "\
            -s EXPORTED_FUNCTIONS='[\"__initialize\",\"_wasm_malloc\",\"_wasm_free\",\"_wasm_invoke_json\",\"_plugin_init\",\"_plugin_init_states\",\"_plugin_stream_invoke\",\"_get_entity_count\",\"_get_orbital_period\",\"_get_eccentricity\",\"_plugin_propagate\",\"_plugin_propagate_path_entity\",\"_plugin_propagate_path_times\",\"_plugin_set_integrator\",\"_plugin_set_state\",\"_plugin_set_force_model\",\"_plugin_set_drag_options\",\"_plugin_set_atmosphere_model\",\"_plugin_set_solar_activity\",\"_plugin_set_gravity\",\"_plugin_set_tides\",\"_plugin_set_relativity\",\"_plugin_set_earth_radiation\",\"_plugin_set_third_body_extended\",\"_plugin_set_empirical\",\"_plugin_propagate_to\",\"_plugin_propagate_path\",\"_plugin_compute_stm\",\"_plugin_propagate_covariance\",\"_plugin_get_covariance_ellipsoid\",\"_plugin_get_acceleration_breakdown\",\"_plugin_set_burns\",\"_plugin_clear_burns\",\"_plugin_destroy\",\"_plugin_alloc\",\"_plugin_free\",\"_plugin_invoke_stream\",\"_plugin_get_manifest_flatbuffer\",\"_plugin_get_manifest_flatbuffer_size\",\"_malloc\",\"_free\"]' \
            -s EXPORTED_RUNTIME_METHODS='[\"ccall\",\"cwrap\",\"UTF8ToString\",\"stringToUTF8\",\"lengthBytesUTF8\",\"HEAPU8\",\"HEAPU32\",\"HEAP8\",\"HEAP32\",\"HEAPF64\"]' \
            -s MODULARIZE=1 \
            -s EXPORT_NAME='HPOPModule' \
            -s EXPORT_ES6=1 \
            -s STANDALONE_WASM=1 \
            -s INITIAL_MEMORY=134217728 \
            -s STACK_SIZE=2097152 \
            -s MALLOC='emmalloc' \
            -s FILESYSTEM=0 \
        "
    )
elseif(WASI_SDK)
    # --- Standalone WASI artifact (isomorphic — runs in WasmEdge and browser via shim) ---
    add_executable(
        hpop_standalone
        wasm_api.cpp
        src/plugin_entrypoints.cpp
        src/plugin_invoke_bridge.cpp
    )
    target_include_directories(
        hpop_standalone PRIVATE
        include
        generated
        generated/sds
        "${FLATBUFFERS_INCLUDE_DIR}"
    )
    target_link_libraries(hpop_standalone hpop)
    set_target_properties(
        hpop_standalone PROPERTIES
        SUFFIX ".wasm"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    )
    target_link_options(hpop_standalone PRIVATE
        -Wl,--export=plugin_alloc
        -Wl,--export=plugin_free
        -Wl,--export=plugin_invoke_stream
        -Wl,--export=plugin_get_manifest_flatbuffer
        -Wl,--export=plugin_get_manifest_flatbuffer_size
    )
endif()
