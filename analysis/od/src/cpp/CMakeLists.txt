cmake_minimum_required(VERSION 3.15)
project(od_sdn_plugin LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── Performance flags ──
if(EMSCRIPTEN)
    # WASM: optimize for broad runtime compatibility across browser and WasmEdge.
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3 -flto -ffast-math -DNDEBUG")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -DEIGEN_DONT_PARALLELIZE")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -O3 -flto")
else()
    # Native: LTO + architecture-specific tuning
    set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} -O3 -flto -ffast-math -march=native -mtune=native")
    set(CMAKE_INTERPROCEDURAL_OPTIMIZATION TRUE)
endif()

# Eigen3 (header-only)
find_package(Eigen3 QUIET NO_MODULE)
if(NOT Eigen3_FOUND)
    find_path(
        EIGEN3_INCLUDE_DIR
        NAMES Eigen/Core
        PATH_SUFFIXES eigen3
        PATHS
            /opt/homebrew/include
            /opt/homebrew/opt/eigen/include
            /usr/local/include
            /usr/local/opt/eigen/include
        NO_CMAKE_FIND_ROOT_PATH
    )
    if(NOT EIGEN3_INCLUDE_DIR)
        message(FATAL_ERROR "Eigen3 headers not found. Install eigen and retry.")
    endif()
    add_library(Eigen3::Eigen INTERFACE IMPORTED)
    set_target_properties(
        Eigen3::Eigen PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES "${EIGEN3_INCLUDE_DIR}"
    )
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

# Vallado SGP4 library (CelesTrak/fundamentals-of-astrodynamics)
set(VALLADO_SGP4_DIR "${CMAKE_SOURCE_DIR}/deps/vallado-sgp4")
add_library(sgp4_lib STATIC "${VALLADO_SGP4_DIR}/SGP4.cpp")
target_include_directories(sgp4_lib PUBLIC "${VALLADO_SGP4_DIR}")

# OD library
set(OD_SOURCES
    src/orbit_determination.cpp
    src/meme_parser.cpp
    src/sgp4_fitter.cpp
    src/plugin_runtime.cpp
)

add_library(od_lib STATIC ${OD_SOURCES})
target_include_directories(od_lib PUBLIC include "${VALLADO_SGP4_DIR}")
target_link_libraries(od_lib PUBLIC sgp4_lib Eigen3::Eigen)

# Test executable
if(NOT EMSCRIPTEN)
    add_executable(test_od tests/test_od.cpp)
    target_link_libraries(test_od od_lib)

    add_executable(test_supgp tests/test_supgp.cpp)
    target_link_libraries(test_supgp od_lib)

    add_executable(bench_supgp tests/bench_supgp.cpp)
    target_link_libraries(bench_supgp od_lib)

    add_executable(analyze_outliers tests/analyze_outliers.cpp)
    target_link_libraries(analyze_outliers od_lib)
endif()

# WASM target (Emscripten)
if(EMSCRIPTEN)
    add_executable(
        od_wasm
        src/wasm_api.cpp
        src/plugin_entrypoints.cpp
        src/plugin_invoke_bridge.cpp
    )
    target_include_directories(
        od_wasm PRIVATE
        include
        generated
        "${VALLADO_SGP4_DIR}"
        "${FLATBUFFERS_INCLUDE_DIR}"
    )
    target_link_libraries(od_wasm od_lib)
    set_target_properties(od_wasm PROPERTIES
        SUFFIX ".js"
        LINK_FLAGS "\
            -s EXPORTED_FUNCTIONS='[\"_wasm_malloc\",\"_wasm_free\",\"_wasm_parse\",\"_wasm_fit\",\"_wasm_parse_and_fit\",\"_plugin_alloc\",\"_plugin_free\",\"_plugin_invoke_stream\",\"_plugin_get_manifest_flatbuffer\",\"_plugin_get_manifest_flatbuffer_size\"]' \
            -s EXPORTED_RUNTIME_METHODS='[\"ccall\",\"cwrap\",\"UTF8ToString\",\"stringToUTF8\",\"lengthBytesUTF8\"]' \
            -s MODULARIZE=1 \
            -s EXPORT_NAME='ODModule' \
            -s STANDALONE_WASM=1 \
            -s INITIAL_MEMORY=67108864 \
            -s STACK_SIZE=2097152 \
            -s MALLOC='emmalloc' \
            -s FILESYSTEM=0 \
        "
    )
elseif(WASI_SDK)
    add_executable(
        od_standalone
        src/wasm_api.cpp
        src/plugin_entrypoints.cpp
        src/plugin_invoke_bridge.cpp
    )
    target_include_directories(
        od_standalone PRIVATE
        include
        generated
        "${VALLADO_SGP4_DIR}"
        "${FLATBUFFERS_INCLUDE_DIR}"
    )
    target_link_libraries(od_standalone od_lib)
    set_target_properties(
        od_standalone PROPERTIES
        SUFFIX ".wasm"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    )
    target_link_options(od_standalone PRIVATE
        -Wl,--export=plugin_alloc
        -Wl,--export=plugin_free
        -Wl,--export=plugin_invoke_stream
        -Wl,--export=plugin_get_manifest_flatbuffer
        -Wl,--export=plugin_get_manifest_flatbuffer_size
    )
endif()
