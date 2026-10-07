cmake_minimum_required(VERSION 3.15)
project(protection_license_client LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(EMSCRIPTEN)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3 -flto -DNDEBUG -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -O3 -flto -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0")
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

if(NOT CRYPTOPP_SRC_DIR)
    message(FATAL_ERROR "CRYPTOPP_SRC_DIR is required.")
endif()
if(NOT CRYPTOPP_PARENT_DIR)
    message(FATAL_ERROR "CRYPTOPP_PARENT_DIR is required.")
endif()

get_filename_component(CRYPTOPP_SRC_DIR "${CRYPTOPP_SRC_DIR}" ABSOLUTE)
get_filename_component(CRYPTOPP_PARENT_DIR "${CRYPTOPP_PARENT_DIR}" ABSOLUTE)

if(NOT EXISTS "${CRYPTOPP_PARENT_DIR}/cryptopp")
    file(CREATE_LINK "${CRYPTOPP_SRC_DIR}" "${CRYPTOPP_PARENT_DIR}/cryptopp" SYMBOLIC COPY_ON_ERROR)
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
    protection_license_client_core STATIC
    src/license_client.cpp
)
target_include_directories(
    protection_license_client_core PUBLIC
    include
    generated
    generated/keybroker
    "${FLATBUFFERS_INCLUDE_DIR}"
)
target_link_libraries(protection_license_client_core PUBLIC cryptopp)

add_executable(
    protection_license_client_wasm
    wasm_api.cpp
    src/plugin_invoke_bridge.cpp
)
target_include_directories(
    protection_license_client_wasm PRIVATE
    include
    generated
    generated/keybroker
    "${FLATBUFFERS_INCLUDE_DIR}"
)
target_link_libraries(protection_license_client_wasm PRIVATE protection_license_client_core)
set_target_properties(
    protection_license_client_wasm PROPERTIES
    SUFFIX ".js"
    LINK_FLAGS "\
        -s EXPORTED_FUNCTIONS='[\"_plugin_alloc\",\"_plugin_free\",\"_plugin_invoke_stream\",\"_plugin_get_manifest_flatbuffer\",\"_plugin_get_manifest_flatbuffer_size\"]' \
        -s EXPORTED_RUNTIME_METHODS='[\"ccall\",\"cwrap\",\"UTF8ToString\",\"stringToUTF8\",\"lengthBytesUTF8\"]' \
        -s MODULARIZE=1 \
        -s EXPORT_NAME='ProtectionLicenseClientModule' \
        -s STANDALONE_WASM=1 \
        -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
        -Wl,--allow-undefined \
        -s INITIAL_MEMORY=33554432 \
        -s STACK_SIZE=2097152 \
        -s MALLOC='emmalloc' \
        -s FILESYSTEM=0 \
    "
)
