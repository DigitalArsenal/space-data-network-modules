cmake_minimum_required(VERSION 3.15)
project(sensor_shaders_sdn_plugin LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(EMSCRIPTEN)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3 -flto -DNDEBUG")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -O3 -flto")
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

get_filename_component(
    PLUGIN_SDK_INCLUDE_DIR
    "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../plugin-sdk/include"
    ABSOLUTE
)

if(NOT EXISTS "${PLUGIN_SDK_INCLUDE_DIR}/generated/PluginMessage_generated.h")
    message(FATAL_ERROR "plugin-sdk generated headers not found at ${PLUGIN_SDK_INCLUDE_DIR}.")
endif()

if(EMSCRIPTEN)
    add_executable(
        sensor_shaders_wasm
        src/plugin_entrypoints.cpp
        src/plugin_invoke_bridge.cpp
    )
    target_include_directories(
        sensor_shaders_wasm PRIVATE
        include
        generated
        "${FLATBUFFERS_INCLUDE_DIR}"
        "${PLUGIN_SDK_INCLUDE_DIR}"
    )
    set_target_properties(
        sensor_shaders_wasm PROPERTIES
        SUFFIX ".js"
        LINK_FLAGS "\
            -s EXPORTED_FUNCTIONS='[\"_plugin_alloc\",\"_plugin_free\",\"_plugin_invoke_stream\",\"_plugin_get_manifest_flatbuffer\",\"_plugin_get_manifest_flatbuffer_size\",\"_sensor_shaders_set_bundle_json\",\"_sensor_shaders_stream_cleanup\",\"_get_name\",\"_get_version\",\"_get_type\"]' \
            -s MODULARIZE=1 \
            -s EXPORT_ES6=1 \
            -s EXPORT_NAME='SensorShadersModule' \
            -s STANDALONE_WASM=1 \
            -s INITIAL_MEMORY=16777216 \
            -s FILESYSTEM=0 \
            -s MALLOC='emmalloc' \
            -s ENVIRONMENT='web,worker,node' \
            --no-entry \
        "
    )
endif()
