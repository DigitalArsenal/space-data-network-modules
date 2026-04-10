cmake_minimum_required(VERSION 3.15)
project(sgp4_propagator_plugin LANGUAGES CXX)

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

file(GLOB SGP4_SOURCES deps/sgp4/libsgp4/*.cc)
add_library(sgp4 STATIC ${SGP4_SOURCES})
target_include_directories(sgp4 PUBLIC deps/sgp4/libsgp4)

add_library(
    sgp4_prop STATIC
    src/gp_parser.cpp
    src/propagator.cpp
    src/lambert_stm.cpp
    src/plugin_runtime.cpp
)
target_include_directories(sgp4_prop PUBLIC include deps/sgp4/libsgp4)
target_link_libraries(sgp4_prop sgp4)

if(NOT EMSCRIPTEN)
    add_executable(test_sgp4_prop tests/test_propagator.cpp)
    target_link_libraries(test_sgp4_prop sgp4_prop)
    target_include_directories(test_sgp4_prop PRIVATE include)

    add_executable(test_lambert_stm tests/test_lambert_stm.cpp)
    target_link_libraries(test_lambert_stm sgp4_prop)
    target_include_directories(test_lambert_stm PRIVATE include)

    enable_testing()
    add_test(NAME sgp4_prop COMMAND test_sgp4_prop)
    add_test(NAME lambert_stm COMMAND test_lambert_stm)
endif()

if(EMSCRIPTEN)
    add_executable(
        sgp4_wasm
        wasm_api.cpp
        src/plugin_entrypoints.cpp
        src/plugin_invoke_bridge.cpp
    )
    target_include_directories(
        sgp4_wasm PRIVATE
        include
        generated
        "${FLATBUFFERS_INCLUDE_DIR}"
        deps/sgp4/libsgp4
    )
    target_link_libraries(sgp4_wasm sgp4_prop)
    set_target_properties(
        sgp4_wasm PROPERTIES
        SUFFIX ".js"
        LINK_FLAGS "\
            -s EXPORTED_FUNCTIONS='[\"_wasm_malloc\",\"_wasm_free\",\"_wasm_invoke_json\",\"_plugin_alloc\",\"_plugin_free\",\"_plugin_invoke_stream\",\"_plugin_get_manifest_flatbuffer\",\"_plugin_get_manifest_flatbuffer_size\"]' \
            -s EXPORTED_RUNTIME_METHODS='[\"ccall\",\"cwrap\",\"UTF8ToString\",\"stringToUTF8\",\"lengthBytesUTF8\"]' \
            -s MODULARIZE=1 \
            -s EXPORT_NAME='SGP4Module' \
            -s STANDALONE_WASM=1 \
            -s INITIAL_MEMORY=67108864 \
            -s STACK_SIZE=2097152 \
            -s MALLOC='emmalloc' \
            -s FILESYSTEM=0 \
        "
    )
elseif(WASI_SDK)
    add_executable(
        sgp4_standalone
        wasm_api.cpp
        src/plugin_entrypoints.cpp
        src/plugin_invoke_bridge.cpp
    )
    target_include_directories(
        sgp4_standalone PRIVATE
        include
        generated
        "${FLATBUFFERS_INCLUDE_DIR}"
        deps/sgp4/libsgp4
    )
    target_link_libraries(sgp4_standalone sgp4_prop)
    set_target_properties(
        sgp4_standalone PROPERTIES
        SUFFIX ".wasm"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    )
    target_link_options(
        sgp4_standalone PRIVATE
        -Wl,--export=plugin_alloc
        -Wl,--export=plugin_free
        -Wl,--export=plugin_invoke_stream
        -Wl,--export=plugin_get_manifest_flatbuffer
        -Wl,--export=plugin_get_manifest_flatbuffer_size
    )
endif()
