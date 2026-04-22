cmake_minimum_required(VERSION 3.15)
project(cislunar_sdn_plugin LANGUAGES CXX)

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
    cislunar STATIC
    src/cr3bp.cpp
    src/plugin_runtime.cpp
)
target_include_directories(cislunar PUBLIC include)

if(NOT EMSCRIPTEN)
    add_executable(test_cr3bp tests/test_cr3bp.cpp)
    target_link_libraries(test_cr3bp cislunar)
    target_include_directories(test_cr3bp PRIVATE include)

    add_executable(test_sixdof tests/test_sixdof.cpp)
    target_include_directories(test_sixdof PRIVATE include)

    enable_testing()
    add_test(NAME cr3bp COMMAND test_cr3bp)
    add_test(NAME cislunar_sixdof COMMAND test_sixdof)
endif()

if(EMSCRIPTEN)
    add_executable(
        cislunar_wasm
        wasm_api.cpp
        src/plugin_entrypoints.cpp
        src/plugin_invoke_bridge.cpp
    )
    target_include_directories(
        cislunar_wasm PRIVATE
        include
        generated
        "${FLATBUFFERS_INCLUDE_DIR}"
    )
    target_link_libraries(cislunar_wasm cislunar)
    set_target_properties(
        cislunar_wasm PROPERTIES
        SUFFIX ".js"
        LINK_FLAGS "\
            -s EXPORTED_FUNCTIONS='[\"_wasm_malloc\",\"_wasm_free\",\"_wasm_invoke_json\",\"_plugin_alloc\",\"_plugin_free\",\"_plugin_invoke_stream\",\"_plugin_get_manifest_flatbuffer\",\"_plugin_get_manifest_flatbuffer_size\"]' \
            -s EXPORTED_RUNTIME_METHODS='[\"ccall\",\"cwrap\",\"UTF8ToString\",\"stringToUTF8\",\"lengthBytesUTF8\"]' \
            -s MODULARIZE=1 \
            -s EXPORT_NAME='CislunarModule' \
            -s STANDALONE_WASM=1 \
            -s INITIAL_MEMORY=67108864 \
            -s STACK_SIZE=2097152 \
            -s MALLOC='emmalloc' \
            -s FILESYSTEM=0 \
        "
    )
elseif(WASI_SDK)
    add_executable(
        cislunar_standalone
        wasm_api.cpp
        src/plugin_entrypoints.cpp
        src/plugin_invoke_bridge.cpp
    )
    target_include_directories(
        cislunar_standalone PRIVATE
        include
        generated
        "${FLATBUFFERS_INCLUDE_DIR}"
    )
    target_link_libraries(cislunar_standalone cislunar)
    set_target_properties(
        cislunar_standalone PROPERTIES
        SUFFIX ".wasm"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    )
    target_link_options(cislunar_standalone PRIVATE
        -Wl,--export=plugin_alloc
        -Wl,--export=plugin_free
        -Wl,--export=plugin_invoke_stream
        -Wl,--export=plugin_get_manifest_flatbuffer
        -Wl,--export=plugin_get_manifest_flatbuffer_size
    )
endif()
