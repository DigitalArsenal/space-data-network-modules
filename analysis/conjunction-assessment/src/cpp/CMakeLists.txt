cmake_minimum_required(VERSION 3.15)
project(conjunction_assessment_sdn_plugin LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(CONJUNCTION_ENABLE_PTHREADS "Enable WebAssembly pthreads" OFF)
option(
    CONJUNCTION_EMSCRIPTEN_BROWSER_ADAPTER
    "Emit Emscripten browser JS glue instead of a standalone pthread guest wasm"
    OFF
)

if(EMSCRIPTEN)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3 -flto -ffast-math -DNDEBUG")
    if(CONJUNCTION_EMSCRIPTEN_BROWSER_ADAPTER)
        set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fwasm-exceptions")
        set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -fwasm-exceptions")
    else()
        set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fexceptions")
        set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -fexceptions -s DISABLE_EXCEPTION_CATCHING=1")
    endif()
    if(CONJUNCTION_ENABLE_PTHREADS)
        set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -pthread")
        set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -pthread")
    else()
        set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -DCONJUNCTION_SINGLE_THREAD")
    endif()
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -O3 -flto")
elseif(WASI_SDK)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3 -flto -ffast-math -DNDEBUG -DCONJUNCTION_SINGLE_THREAD")
else()
    set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} -O3 -flto -ffast-math -march=native -mtune=native")
    set(CMAKE_INTERPROCEDURAL_OPTIMIZATION TRUE)
endif()

if(EMSCRIPTEN AND CONJUNCTION_ENABLE_PTHREADS AND CONJUNCTION_EMSCRIPTEN_BROWSER_ADAPTER)
    set(CONJUNCTION_EMSCRIPTEN_TARGET_SUFFIX ".js")
    set(CONJUNCTION_EMSCRIPTEN_JS_LINK_FLAGS "\
            -s EXPORTED_RUNTIME_METHODS='[\"ccall\",\"cwrap\",\"UTF8ToString\",\"stringToUTF8\",\"lengthBytesUTF8\",\"HEAPU8\"]' \
            -s MODULARIZE=1 \
            -s EXPORT_NAME='ConjunctionAssessmentModule' \
        ")
    set(CONJUNCTION_BROWSER_LINK_FLAGS "\
            -s USE_PTHREADS=1 \
            -s PTHREAD_POOL_SIZE=8 \
            -s EXPORT_ES6=1 \
            -s ENVIRONMENT='web,worker' \
            -s INITIAL_MEMORY=1610612736 \
            -s ABORTING_MALLOC=0 \
            -s STACK_SIZE=2097152 \
            -s MALLOC='emmalloc' \
            -s FILESYSTEM=0 \
        ")
elseif(EMSCRIPTEN AND CONJUNCTION_ENABLE_PTHREADS)
    set(CONJUNCTION_EMSCRIPTEN_TARGET_SUFFIX ".wasm")
    set(CONJUNCTION_EMSCRIPTEN_JS_LINK_FLAGS "")
    set(CONJUNCTION_BROWSER_LINK_FLAGS "\
            -s STANDALONE_WASM=1 \
            -s INITIAL_MEMORY=1610612736 \
            -s ABORTING_MALLOC=0 \
            -s STACK_SIZE=2097152 \
            -s MALLOC='emmalloc' \
            -s FILESYSTEM=0 \
        ")
else()
    set(CONJUNCTION_EMSCRIPTEN_TARGET_SUFFIX ".wasm")
    set(CONJUNCTION_EMSCRIPTEN_JS_LINK_FLAGS "")
    set(CONJUNCTION_BROWSER_LINK_FLAGS "\
            -s STANDALONE_WASM=1 \
            -s INITIAL_MEMORY=67108864 \
            -s STACK_SIZE=2097152 \
            -s MALLOC='emmalloc' \
            -s FILESYSTEM=0 \
        ")
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

# ============================================================================
# SGP4 library (dnwrnr/sgp4)
# ============================================================================
set(SGP4_DIR "${CMAKE_SOURCE_DIR}/deps/sgp4/libsgp4")

file(GLOB SGP4_SOURCES "${SGP4_DIR}/*.cc")
add_library(sgp4_lib STATIC ${SGP4_SOURCES})
target_include_directories(sgp4_lib PUBLIC "${SGP4_DIR}")

# ============================================================================
# Conjunction assessment library
# ============================================================================
set(CA_SOURCES
    src/conjunction_assessment.cpp
    src/gp_json.cpp
    src/kdtree.cpp
    src/resident_screening_index.cpp
    src/screening_internal.cpp
    src/screening.cpp
    src/cdm_output.cpp
    src/pc_method.cpp
    src/ephemeris_source.cpp
    src/conjunction_engine.cpp
    src/sgp4_propagator.cpp
    src/plugin_runtime.cpp
)

add_library(conjunction_assessment STATIC ${CA_SOURCES})
target_include_directories(conjunction_assessment PUBLIC
    include
    include/conjunction
    generated
    "${FLATBUFFERS_INCLUDE_DIR}"
    "${CMAKE_SOURCE_DIR}/deps/sgp4"
    "${SGP4_DIR}"
)
target_link_libraries(conjunction_assessment PUBLIC sgp4_lib)

# ============================================================================
# Native test executables
# ============================================================================
if(NOT EMSCRIPTEN AND NOT WASI_SDK)
    if(EXISTS "${CMAKE_SOURCE_DIR}/tests/test_socrates.cpp")
        add_executable(test_socrates tests/test_socrates.cpp)
        target_link_libraries(test_socrates conjunction_assessment)
        target_include_directories(test_socrates PRIVATE include "${SGP4_DIR}")
    endif()

    if(EXISTS "${CMAKE_SOURCE_DIR}/tests/test_gp_json.cpp")
        add_executable(test_gp_json tests/test_gp_json.cpp)
        target_link_libraries(test_gp_json conjunction_assessment)
        target_include_directories(test_gp_json PRIVATE include "${SGP4_DIR}")
    endif()

    if(EXISTS "${CMAKE_SOURCE_DIR}/tests/test_screening.cpp")
        add_executable(test_screening tests/test_screening.cpp)
        target_link_libraries(test_screening conjunction_assessment)
        target_include_directories(test_screening PRIVATE include "${SGP4_DIR}")
    endif()

    if(EXISTS "${CMAKE_SOURCE_DIR}/tests/test_pc_methods.cpp")
        add_executable(test_pc_methods tests/test_pc_methods.cpp)
        target_link_libraries(test_pc_methods conjunction_assessment)
        target_include_directories(test_pc_methods PRIVATE include "${SGP4_DIR}")
    endif()

    if(EXISTS "${CMAKE_SOURCE_DIR}/tests/test_engine.cpp")
        add_executable(test_engine tests/test_engine.cpp)
        target_link_libraries(test_engine conjunction_assessment)
        target_include_directories(test_engine PRIVATE include "${SGP4_DIR}")
    endif()

    enable_testing()
    if(TARGET test_socrates)
        add_test(NAME socrates COMMAND test_socrates)
    endif()
    if(TARGET test_gp_json)
        add_test(NAME gp_json COMMAND test_gp_json)
    endif()
    if(TARGET test_screening)
        add_test(NAME screening COMMAND test_screening)
    endif()
    if(TARGET test_pc_methods)
        add_test(NAME pc_methods COMMAND test_pc_methods)
    endif()
    if(TARGET test_engine)
        add_test(NAME engine COMMAND test_engine)
    endif()
endif()

# ============================================================================
# Emscripten browser artifact
# ============================================================================
if(EMSCRIPTEN)
    add_executable(
        conjunction_assessment_wasm
        wasm_api.cpp
        src/plugin_entrypoints.cpp
        src/plugin_invoke_bridge.cpp
    )
    target_include_directories(
        conjunction_assessment_wasm PRIVATE
        include
        include/conjunction
        generated
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../../propagator/sgp4/src/cpp/generated/sds"
        "${FLATBUFFERS_INCLUDE_DIR}"
        "${SGP4_DIR}"
    )
    target_link_libraries(conjunction_assessment_wasm conjunction_assessment)
    set_target_properties(
        conjunction_assessment_wasm PROPERTIES
        SUFFIX "${CONJUNCTION_EMSCRIPTEN_TARGET_SUFFIX}"
        LINK_FLAGS "\
            -s EXPORTED_FUNCTIONS='[\"_wasm_malloc\",\"_wasm_free\",\"_wasm_invoke_json\",\"_plugin_alloc\",\"_plugin_free\",\"_plugin_invoke_stream\",\"_plugin_get_manifest_flatbuffer\",\"_plugin_get_manifest_flatbuffer_size\"]' \
            -Wl,--export=__wasm_call_ctors \
            ${CONJUNCTION_EMSCRIPTEN_JS_LINK_FLAGS} \
            ${CONJUNCTION_BROWSER_LINK_FLAGS} \
        "
    )

# ============================================================================
# Standalone WASI artifact (isomorphic -- runs in WasmEdge and browser via shim)
# ============================================================================
elseif(WASI_SDK)
    add_executable(
        conjunction_assessment_standalone
        wasm_api.cpp
        src/plugin_entrypoints.cpp
        src/plugin_invoke_bridge.cpp
    )
    target_include_directories(
        conjunction_assessment_standalone PRIVATE
        include
        include/conjunction
        generated
        "${CMAKE_CURRENT_SOURCE_DIR}/../../../../propagator/sgp4/src/cpp/generated/sds"
        "${FLATBUFFERS_INCLUDE_DIR}"
        "${SGP4_DIR}"
    )
    target_link_libraries(conjunction_assessment_standalone conjunction_assessment)
    set_target_properties(
        conjunction_assessment_standalone PROPERTIES
        SUFFIX ".wasm"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
    )
    target_link_options(conjunction_assessment_standalone PRIVATE
        -Wl,--export=plugin_alloc
        -Wl,--export=plugin_free
        -Wl,--export=plugin_invoke_stream
        -Wl,--export=plugin_get_manifest_flatbuffer
        -Wl,--export=plugin_get_manifest_flatbuffer_size
    )
endif()
