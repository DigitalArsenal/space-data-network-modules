cmake_minimum_required(VERSION 3.15)
project(sgp4_propagator_plugin LANGUAGES C CXX)

set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "propagator.sgp4 is expected to be built through Emscripten.")
endif()

# -------- Common flags --------------------------------------------------------
# -msimd128 enables WebAssembly SIMD.
# Standard Wasm exceptions keep the artifact portable across browser + WasmEdge.
set(CMAKE_CXX_FLAGS
    "${CMAKE_CXX_FLAGS} -O3 -flto -ffast-math -DNDEBUG -msimd128 -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0 -Wno-dangling-else -Wno-format"
)
set(CMAKE_C_FLAGS
    "${CMAKE_C_FLAGS} -O3 -flto -DNDEBUG -msimd128"
)
set(CMAKE_EXE_LINKER_FLAGS
    "${CMAKE_EXE_LINKER_FLAGS} -O3 -flto -fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=0"
)

# -------- FlatBuffers include -------------------------------------------------
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

# -------- SQLite3 amalgamation ------------------------------------------------
# Staged by build.sh into deps/sqlite3/ so the build is self-contained and
# works across host machines that may not share the same emsdk cache layout.
set(SQLITE_AMALGAMATION_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/sqlite3")
if(NOT EXISTS "${SQLITE_AMALGAMATION_DIR}/sqlite3.c" OR NOT EXISTS "${SQLITE_AMALGAMATION_DIR}/sqlite3.h")
    message(FATAL_ERROR
        "SQLite amalgamation not found at ${SQLITE_AMALGAMATION_DIR}. "
        "build.sh should stage sqlite3.c/sqlite3.h before invoking cmake.")
endif()

add_library(sgp4_sqlite3 STATIC "${SQLITE_AMALGAMATION_DIR}/sqlite3.c")
target_include_directories(sgp4_sqlite3 PUBLIC "${SQLITE_AMALGAMATION_DIR}")
target_compile_definitions(
    sgp4_sqlite3 PUBLIC
    SQLITE_OMIT_LOAD_EXTENSION=1
    SQLITE_THREADSAFE=0
    SQLITE_DEFAULT_MEMSTATUS=0
    SQLITE_TEMP_STORE=3
    SQLITE_DQS=0
    SQLITE_OMIT_SHARED_CACHE=1
    SQLITE_OMIT_DEPRECATED=1
)
# SQLite's amalgamation triggers a sea of shadow / unused warnings on -O3 +
# -Werror configurations. Keep the build quiet without disabling genuine
# diagnostics for our own code.
target_compile_options(sgp4_sqlite3 PRIVATE -Wno-everything)

# -------- Core propagator library --------------------------------------------
# SGP4 (Vallado) + OrbPro's direct-call wasm surface.
add_library(
    sgp4_core STATIC
    src/SGP4.cpp
    src/sgp4_plugin.cpp
    src/standalone_stubs.c
)
target_include_directories(
    sgp4_core PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
    "${CMAKE_CURRENT_SOURCE_DIR}/generated"
    "${CMAKE_CURRENT_SOURCE_DIR}/generated/sds"
    "${FLATBUFFERS_INCLUDE_DIR}"
)
target_link_libraries(sgp4_core PUBLIC sgp4_sqlite3)

# -------- Wasm adapter executable --------------------------------------------
# The bridge implements the SDK 0.8.0 invoke surface and dispatches into
# OrbPro's native `plugin_stream_invoke` exported from sgp4_plugin.cpp.
add_executable(
    sgp4_wasm
    src/plugin_invoke_bridge.cpp
)
target_include_directories(
    sgp4_wasm PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
    "${CMAKE_CURRENT_SOURCE_DIR}/generated"
    "${CMAKE_CURRENT_SOURCE_DIR}/generated/sds"
    "${FLATBUFFERS_INCLUDE_DIR}"
)
target_link_libraries(sgp4_wasm PRIVATE sgp4_core)

# Keep the full OrbPro direct-call surface exported alongside the SDK 0.8.0
# invoke/manifest exports so the artifact can be consumed by either runtime.
set(SGP4_EXPORTED_FUNCTIONS "\
\"__initialize\",\
\"_plugin_alloc\",\
\"_plugin_free\",\
\"_plugin_invoke_stream\",\
\"_plugin_get_manifest_flatbuffer\",\
\"_plugin_get_manifest_flatbuffer_size\",\
\"_plugin_init\",\
\"_plugin_init_omm\",\
\"_plugin_init_omm_flatbuffer_stream\",\
\"_plugin_stream_invoke\",\
\"_plugin_propagate\",\
\"_plugin_propagate_batch\",\
\"_plugin_propagate_all_positions\",\
\"_plugin_propagate_to_registry\",\
\"_plugin_propagate_path\",\
\"_plugin_propagate_path_sv\",\
\"_plugin_propagate_path_adaptive\",\
\"_plugin_destroy\",\
\"_get_entity_info\",\
\"_plugin_query_entity_indices_by_name\",\
\"_plugin_query_entity_rows_by_name\",\
\"_plugin_query_visibility_mask_by_name\",\
\"_plugin_get_entity_catalog_row\",\
\"_plugin_catalog_begin_transaction\",\
\"_plugin_catalog_commit_transaction\",\
\"_plugin_catalog_rollback_transaction\",\
\"_plugin_catalog_upsert_cat_record\",\
\"_plugin_catalog_upsert_cat_flatbuffer_stream\",\
\"_plugin_catalog_upsert_cat_records_packed\",\
\"_plugin_get_cat_record_json_size\",\
\"_plugin_get_cat_record_json\",\
\"_get_satellite_count\",\
\"_get_orbital_period\",\
\"_get_tle_epoch\",\
\"_get_eccentricity\",\
\"_plugin_entity_add_omm\",\
\"_plugin_entity_add_omm_flatbuffer\",\
\"_plugin_entity_omm_count\",\
\"_plugin_entity_list_omm\",\
\"_plugin_entity_remove_omm\",\
\"_plugin_entity_remove_all_omm_except\",\
\"_plugin_entity_clear_omm\",\
\"_plugin_entity_set_mode\",\
\"_plugin_entity_get_mode\",\
\"_plugin_entity_get_omm_pointer\",\
\"_plugin_get_omm_record_by_pointer\",\
\"_malloc\",\
\"_free\"\
")

set_target_properties(
    sgp4_wasm PROPERTIES
    SUFFIX ".js"
    LINK_FLAGS "\
        -s EXPORTED_FUNCTIONS=[${SGP4_EXPORTED_FUNCTIONS}] \
        -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap','UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8','HEAPU32','HEAP8','HEAP32','HEAPF64'] \
        -s MODULARIZE=1 \
        -s EXPORT_NAME='Sgp4Module' \
        -s EXPORT_ES6=1 \
        -s STANDALONE_WASM=1 \
        -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
        -Wl,--allow-undefined \
        -Wl,--export=__wasm_call_ctors \
        -s ALLOW_MEMORY_GROWTH=1 \
        -s INITIAL_MEMORY=67108864 \
        -s MAXIMUM_MEMORY=2147483648 \
        -s STACK_SIZE=2097152 \
        -s MALLOC='emmalloc' \
        -s FILESYSTEM=0 \
    "
)
