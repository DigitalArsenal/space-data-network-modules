cmake_minimum_required(VERSION 3.15)
project(fastest_path LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(EMSCRIPTEN)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3 -flto -DNDEBUG -fwasm-exceptions")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -O3 -flto -fwasm-exceptions")
else()
    message(FATAL_ERROR "This package is expected to be built through Emscripten.")
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

set(FASTEST_PATH_PACKAGE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../..")
set(SDN_PLUGINS_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../..")
set(INVOKE_GENERATED_DIR "${SDN_PLUGINS_ROOT}/licensing/protection-license-client/src/cpp/generated")
set(SGP4_GENERATED_DIR "${SDN_PLUGINS_ROOT}/propagator/sgp4/src/cpp/generated")
set(SGP4_INCLUDE_DIR "${SDN_PLUGINS_ROOT}/propagator/sgp4/src/cpp/include")

add_executable(
    fastest_path_wasm
    src/fastest_path_core.cpp
    src/plugin_invoke_bridge.cpp
    wasm_api.cpp
)
target_include_directories(
    fastest_path_wasm PRIVATE
    include
    generated
    "${FLATBUFFERS_INCLUDE_DIR}"
    "${FASTEST_PATH_PACKAGE_ROOT}/src"
    "${INVOKE_GENERATED_DIR}"
    "${SGP4_GENERATED_DIR}"
    "${SGP4_INCLUDE_DIR}"
)
set_target_properties(
    fastest_path_wasm PROPERTIES
    SUFFIX ".js"
    LINK_FLAGS "\
        -s EXPORTED_FUNCTIONS='[\"__initialize\",\"_plugin_alloc\",\"_plugin_free\",\"_plugin_invoke_stream\",\"_plugin_get_manifest_flatbuffer\",\"_plugin_get_manifest_flatbuffer_size\",\"_plugin_init\",\"_plugin_destroy\",\"_graph_create\",\"_graph_add_edge\",\"_graph_add_edges_bulk\",\"_graph_build\",\"_graph_load_csr\",\"_compute_sssp\",\"_get_distances\",\"_get_predecessors\",\"_get_vertex_count\",\"_get_edge_count\",\"_reconstruct_path\"]' \
        -s EXPORTED_RUNTIME_METHODS='[\"ccall\",\"cwrap\",\"UTF8ToString\",\"stringToUTF8\",\"lengthBytesUTF8\"]' \
        -s MODULARIZE=1 \
        -s EXPORT_NAME='FastestPathModule' \
        -s STANDALONE_WASM=1 \
        -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
        -Wl,--allow-undefined \
        -s INITIAL_MEMORY=33554432 \
        -s STACK_SIZE=2097152 \
        -s MALLOC='emmalloc' \
        -s FILESYSTEM=0 \
    "
)
