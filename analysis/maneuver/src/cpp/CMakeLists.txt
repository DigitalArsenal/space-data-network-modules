cmake_minimum_required(VERSION 3.15)
project(maneuver_sdn_plugin LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(EMSCRIPTEN)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3 -flto -DNDEBUG")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -O3 -flto")
else()
    set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} -O3 -flto -march=native -mtune=native")
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
    maneuver STATIC
    src/math.cpp
    src/stm.cpp
    src/transforms.cpp
    src/propagation.cpp
    src/targeting.cpp
    src/classical.cpp
    src/approach.cpp
    src/maneuver_plugin.cpp
    src/plugin_runtime.cpp
)
target_include_directories(maneuver PUBLIC include)

if(NOT EMSCRIPTEN)
    add_executable(test_math tests/test_math.cpp)
    target_link_libraries(test_math maneuver)
    target_include_directories(test_math PRIVATE include)

    add_executable(test_stm tests/test_stm.cpp)
    target_link_libraries(test_stm maneuver)
    target_include_directories(test_stm PRIVATE include)

    add_executable(test_classical tests/test_classical.cpp)
    target_link_libraries(test_classical maneuver)
    target_include_directories(test_classical PRIVATE include)

    add_executable(test_targeting tests/test_targeting.cpp)
    target_link_libraries(test_targeting maneuver)
    target_include_directories(test_targeting PRIVATE include)

    add_executable(test_approach tests/test_approach.cpp)
    target_link_libraries(test_approach maneuver)
    target_include_directories(test_approach PRIVATE include)

    add_executable(test_sixdof tests/test_sixdof.cpp)
    target_include_directories(test_sixdof PRIVATE include)

    enable_testing()
    add_test(NAME math COMMAND test_math)
    add_test(NAME stm COMMAND test_stm)
    add_test(NAME classical COMMAND test_classical)
    add_test(NAME targeting COMMAND test_targeting)
    add_test(NAME approach COMMAND test_approach)
    add_test(NAME maneuver_sixdof COMMAND test_sixdof)
endif()

if(EMSCRIPTEN)
    add_executable(
        maneuver_wasm
        wasm_api.cpp
        src/plugin_entrypoints.cpp
        src/plugin_invoke_bridge.cpp
    )
    target_include_directories(
        maneuver_wasm PRIVATE
        include
        generated
        "${FLATBUFFERS_INCLUDE_DIR}"
    )
    target_link_libraries(maneuver_wasm maneuver)
    set_target_properties(
        maneuver_wasm PROPERTIES
        SUFFIX ".js"
        LINK_FLAGS "\
            -s EXPORTED_FUNCTIONS='[\"_wasm_malloc\",\"_wasm_free\",\"_wasm_invoke_json\",\"_plugin_alloc\",\"_plugin_free\",\"_plugin_invoke_stream\",\"_plugin_get_manifest_flatbuffer\",\"_plugin_get_manifest_flatbuffer_size\"]' \
            -s EXPORTED_RUNTIME_METHODS='[\"ccall\",\"cwrap\",\"UTF8ToString\",\"stringToUTF8\",\"lengthBytesUTF8\"]' \
            -s MODULARIZE=1 \
            -s EXPORT_NAME='ManeuverModule' \
            -s STANDALONE_WASM=1 \
            -s INITIAL_MEMORY=67108864 \
            -s STACK_SIZE=2097152 \
            -s MALLOC='emmalloc' \
            -s FILESYSTEM=0 \
        "
    )
elseif(WASI_SDK)
    add_executable(
        maneuver_standalone
        wasm_api.cpp
        src/plugin_entrypoints.cpp
        src/plugin_invoke_bridge.cpp
    )
    target_include_directories(
        maneuver_standalone PRIVATE
        include
        generated
        "${FLATBUFFERS_INCLUDE_DIR}"
    )
    target_link_libraries(maneuver_standalone maneuver)
    set_target_properties(
        maneuver_standalone PROPERTIES
        SUFFIX ".wasm"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    )
    target_link_options(maneuver_standalone PRIVATE
        -Wl,--export=plugin_alloc
        -Wl,--export=plugin_free
        -Wl,--export=plugin_invoke_stream
        -Wl,--export=plugin_get_manifest_flatbuffer
        -Wl,--export=plugin_get_manifest_flatbuffer_size
    )
endif()
