cmake_minimum_required(VERSION 3.15)
project(licensing LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(EMSCRIPTEN)
    # Emit standard Wasm EH so the artifact loads consistently in WasmEdge.
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3 -flto -DNDEBUG -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -O3 -flto -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0")
else()
    message(FATAL_ERROR "This package is expected to be built through Emscripten.")
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

if(NOT CRYPTOPP_SRC_DIR)
    message(FATAL_ERROR "CRYPTOPP_SRC_DIR is required.")
endif()
if(NOT CRYPTOPP_PARENT_DIR)
    message(FATAL_ERROR "CRYPTOPP_PARENT_DIR is required.")
endif()

get_filename_component(CRYPTOPP_SRC_DIR "${CRYPTOPP_SRC_DIR}" ABSOLUTE)
get_filename_component(CRYPTOPP_PARENT_DIR "${CRYPTOPP_PARENT_DIR}" ABSOLUTE)
get_filename_component(DA_FLATBUFFERS_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../da-flatbuffers" ABSOLUTE)

set(DA_FLATBUFFERS_ROOT "")
if(DEFINED ENV{DA_FLATBUFFERS_ROOT})
    get_filename_component(DA_FLATBUFFERS_ROOT "$ENV{DA_FLATBUFFERS_ROOT}" ABSOLUTE)
endif()
if(NOT DA_FLATBUFFERS_ROOT)
    foreach(candidate
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../flatbuffers"
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../da-flatbuffers"
    )
        get_filename_component(candidate_root "${candidate}" ABSOLUTE)
        if(EXISTS "${candidate_root}/include/flatbuffers/encryption.h")
            set(DA_FLATBUFFERS_ROOT "${candidate_root}")
            break()
        endif()
    endforeach()
endif()

if(NOT EXISTS "${CRYPTOPP_PARENT_DIR}/cryptopp")
    file(CREATE_LINK "${CRYPTOPP_SRC_DIR}" "${CRYPTOPP_PARENT_DIR}/cryptopp" SYMBOLIC COPY_ON_ERROR)
endif()

if(NOT EXISTS "${DA_FLATBUFFERS_ROOT}/include/flatbuffers/encryption.h")
    message(FATAL_ERROR "da-flatbuffers encryption headers not found at ${DA_FLATBUFFERS_ROOT}")
endif()

file(GLOB CRYPTOPP_ALL_SOURCES "${CRYPTOPP_SRC_DIR}/*.cpp")
list(FILTER CRYPTOPP_ALL_SOURCES EXCLUDE REGEX ".*/(adhoc|bench1|bench2|bench3|cryptest|cryptestcwd|datatest|dlltest|fipsalgt|fipstest|regtest1|regtest2|regtest3|test|validat0|validat1|validat2|validat3|validat4|validat5|validat6|validat7|validat8|validat9|validat10)\\.cpp$")

add_library(cryptopp STATIC ${CRYPTOPP_ALL_SOURCES})
target_include_directories(cryptopp PUBLIC "${CRYPTOPP_PARENT_DIR}" "${CRYPTOPP_SRC_DIR}")
target_compile_definitions(
    cryptopp PUBLIC
    CRYPTOPP_DISABLE_ASM=1
    CRYPTOPP_DISABLE_SSSE3=1
    CRYPTOPP_DISABLE_AESNI=1
)

add_library(
    licensing_core STATIC
    src/key_server.cpp
    src/license_client.cpp
    "${DA_FLATBUFFERS_ROOT}/src/encryption.cpp"
)
target_compile_definitions(
    licensing_core PRIVATE
    FLATBUFFERS_USE_CRYPTOPP=1
)
target_include_directories(
    licensing_core PUBLIC
    include
    generated
    generated/sds
    generated/keybroker
    "${FLATBUFFERS_INCLUDE_DIR}"
    "${DA_FLATBUFFERS_ROOT}/include"
)
target_link_libraries(licensing_core PUBLIC cryptopp)

add_executable(
    licensing_wasm
    wasm_api.cpp
    src/plugin_invoke_bridge.cpp
)
target_include_directories(
    licensing_wasm PRIVATE
    include
    generated
    generated/sds
    generated/keybroker
    "${FLATBUFFERS_INCLUDE_DIR}"
    "${DA_FLATBUFFERS_ROOT}/include"
)
target_link_libraries(licensing_wasm PRIVATE licensing_core)
set_target_properties(
    licensing_wasm PROPERTIES
    SUFFIX ".js"
    LINK_FLAGS "\
        -s EXPORTED_FUNCTIONS='[\"_plugin_alloc\",\"_plugin_free\",\"_plugin_invoke_stream\",\"_plugin_get_manifest_flatbuffer\",\"_plugin_get_manifest_flatbuffer_size\"]' \
        -s EXPORTED_RUNTIME_METHODS='[\"ccall\",\"cwrap\",\"UTF8ToString\",\"stringToUTF8\",\"lengthBytesUTF8\"]' \
        -s MODULARIZE=1 \
        -s EXPORT_NAME='LicensingModule' \
        -s STANDALONE_WASM=1 \
        -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
        -Wl,--allow-undefined \
        -s INITIAL_MEMORY=33554432 \
        -s STACK_SIZE=2097152 \
        -s MALLOC='emmalloc' \
        -s FILESYSTEM=0 \
    "
)
