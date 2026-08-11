cmake_minimum_required(VERSION 3.20)
project(sgp4_propagator_plugin LANGUAGES C CXX)

set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT SGP4_WASI_SEQUENTIAL)
    message(FATAL_ERROR "SGP4 must build with -DSGP4_WASI_SEQUENTIAL=ON. Emscripten is not a supported lane.")
endif()

if(NOT CMAKE_CXX_COMPILER MATCHES "wasm32-wasi-clang\\+\\+")
    message(FATAL_ERROR "SGP4 requires the SDK WASI clang driver, not Emscripten or a host compiler.")
endif()

if(NOT FLATBUFFERS_INCLUDE_DIR OR NOT EXISTS "${FLATBUFFERS_INCLUDE_DIR}/flatbuffers/flatbuffers.h")
    message(FATAL_ERROR "Set FLATBUFFERS_INCLUDE_DIR to the pinned stack FlatBuffers include directory.")
endif()

if(NOT SGP4_SQLITE_AMALGAMATION_DIR)
    set(SGP4_SQLITE_AMALGAMATION_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/sqlite3")
endif()
if(NOT EXISTS "${SGP4_SQLITE_AMALGAMATION_DIR}/sqlite3.c" OR NOT EXISTS "${SGP4_SQLITE_AMALGAMATION_DIR}/sqlite3.h")
    message(FATAL_ERROR "Pinned SQLite amalgamation is missing. The build does not download SQLite.")
endif()

set(SGP4_COMMON_FLAGS -O3 -flto -ffast-math -DNDEBUG -mbulk-memory -fno-exceptions)
set(SGP4_WASI_LINK_FLAGS
    -Wl,--initial-memory=16777216
    -Wl,--max-memory=2147483648
    -Wl,-z,stack-size=2097152
    # wasi-libc provides filesystem wrappers even though the SGP4 SQLite VFS is
    # in-memory only. standalone_stubs.c supplies the fail-closed variants;
    # retain that object before wasi-libc instead of importing unsupported
    # filesystem calls into the browser/WasmEdge artifact.
    -Wl,--allow-multiple-definition
)

add_library(sgp4_sqlite3 STATIC "${SGP4_SQLITE_AMALGAMATION_DIR}/sqlite3.c")
target_include_directories(sgp4_sqlite3 PUBLIC "${SGP4_SQLITE_AMALGAMATION_DIR}")
target_compile_options(sgp4_sqlite3 PRIVATE ${SGP4_COMMON_FLAGS} -Wno-everything)
target_compile_definitions(sgp4_sqlite3 PUBLIC
    SQLITE_OMIT_LOAD_EXTENSION=1
    SQLITE_THREADSAFE=0
    SQLITE_DEFAULT_MEMSTATUS=0
    SQLITE_TEMP_STORE=3
    SQLITE_DQS=0
    SQLITE_OMIT_SHARED_CACHE=1
    SQLITE_OMIT_DEPRECATED=1
)

add_library(sgp4_core STATIC
    src/SGP4.cpp
    src/sgp4_plugin.cpp
    src/standalone_stubs.c
)
target_compile_options(sgp4_core PRIVATE ${SGP4_COMMON_FLAGS})
target_include_directories(sgp4_core PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
    "${CMAKE_CURRENT_SOURCE_DIR}/generated"
    "${CMAKE_CURRENT_SOURCE_DIR}/generated/sds"
    "${FLATBUFFERS_INCLUDE_DIR}"
)
target_link_libraries(sgp4_core PUBLIC sgp4_sqlite3)

add_executable(sgp4_wasi src/plugin_invoke_bridge.cpp)
target_compile_options(sgp4_wasi PRIVATE ${SGP4_COMMON_FLAGS})
target_include_directories(sgp4_wasi PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
    "${CMAKE_CURRENT_SOURCE_DIR}/generated"
    "${CMAKE_CURRENT_SOURCE_DIR}/generated/sds"
    "${FLATBUFFERS_INCLUDE_DIR}"
)
target_link_libraries(sgp4_wasi PRIVATE sgp4_core)
set_target_properties(sgp4_wasi PROPERTIES SUFFIX ".wasm")
target_link_options(sgp4_wasi PRIVATE ${SGP4_WASI_LINK_FLAGS}
    -Wl,--export=plugin_alloc
    -Wl,--export=plugin_free
    -Wl,--export=plugin_invoke_stream
    -Wl,--export=plugin_get_input_count
    -Wl,--export=plugin_get_input_frame
    -Wl,--export=plugin_find_input_index
    -Wl,--export=plugin_reset_output_state
    -Wl,--export=plugin_push_output_typed
    -Wl,--export=plugin_push_output
    -Wl,--export=plugin_set_error
    -Wl,--export=plugin_get_manifest_flatbuffer
    -Wl,--export=plugin_get_manifest_flatbuffer_size
    -Wl,--export=plugin_init
    -Wl,--export=plugin_init_omm
    -Wl,--export=plugin_init_omm_flatbuffer_stream
    -Wl,--export=plugin_propagate
    -Wl,--export=plugin_propagate_batch
    -Wl,--export=plugin_propagate_all_positions
    -Wl,--export=plugin_propagate_to_registry
    -Wl,--export=plugin_propagate_path
    -Wl,--export=plugin_propagate_path_sv
    -Wl,--export=plugin_propagate_path_adaptive
    -Wl,--export=plugin_destroy
    -Wl,--export=get_entity_info
    -Wl,--export=get_satellite_count
    -Wl,--export=get_orbital_period
    -Wl,--export=get_tle_epoch
    -Wl,--export=get_eccentricity
    -Wl,--export=plugin_get_cat_record_json_size
    -Wl,--export=plugin_get_cat_record_json
    -Wl,--export=plugin_catalog_begin_transaction
    -Wl,--export=plugin_catalog_commit_transaction
    -Wl,--export=plugin_catalog_rollback_transaction
    -Wl,--export=plugin_catalog_upsert_cat_record
    -Wl,--export=plugin_catalog_upsert_cat_flatbuffer_stream
    -Wl,--export=plugin_catalog_upsert_cat_records_packed
    -Wl,--export=plugin_entity_add_omm
    -Wl,--export=plugin_entity_add_omm_flatbuffer
    -Wl,--export=plugin_entity_omm_count
    -Wl,--export=plugin_entity_list_omm
    -Wl,--export=plugin_entity_remove_omm
    -Wl,--export=plugin_entity_remove_all_omm_except
    -Wl,--export=plugin_entity_clear_omm
    -Wl,--export=plugin_entity_set_mode
    -Wl,--export=plugin_entity_get_mode
    -Wl,--export=plugin_entity_get_omm_pointer
    -Wl,--export=plugin_entity_apply_impulsive_burn
    -Wl,--export=plugin_get_omm_record_by_pointer
    -Wl,--export=malloc
    -Wl,--export=free
)
