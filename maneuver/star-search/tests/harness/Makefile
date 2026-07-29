CLANGXX ?= clang++
CPPFLAGS := -I../../src
CXXFLAGS := -std=c++17 -fno-exceptions -fno-rtti -O2 -Wall -Wextra -Werror -pthread
BUILD_DIR := build

CORE_SOURCES := \
	../../src/status.cpp \
	../../src/constants.cpp \
	../../src/threading.cpp \
	../../src/ephemeris.cpp \
	../../src/encounter.cpp \
	../../src/lambert.cpp \
	../../src/leg.cpp \
	../../src/flyby.cpp \
	../../src/filter.cpp \
	../../src/combo.cpp \
	../../src/pipeline.cpp

.PHONY: all clean test test_core

all: $(BUILD_DIR)/star_search_native

test: $(BUILD_DIR)/test_core $(BUILD_DIR)/test_lambert $(BUILD_DIR)/test_pipeline
	cd ../.. && tests/harness/$(BUILD_DIR)/test_core
	cd ../.. && tests/harness/$(BUILD_DIR)/test_lambert
	cd ../.. && tests/harness/$(BUILD_DIR)/test_pipeline

test_core: $(BUILD_DIR)/test_core

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(BUILD_DIR)/test_core: test_core.cpp ../../src/status.cpp ../../src/constants.cpp ../../src/threading.cpp ../../src/ephemeris.cpp | $(BUILD_DIR)
	$(CLANGXX) $(CPPFLAGS) $(CXXFLAGS) $^ -o $@

$(BUILD_DIR)/test_lambert: test_lambert.cpp ../../src/status.cpp ../../src/threading.cpp ../../src/lambert.cpp | $(BUILD_DIR)
	$(CLANGXX) $(CPPFLAGS) $(CXXFLAGS) $^ -o $@

$(BUILD_DIR)/test_pipeline: test_pipeline.cpp problem_text.cpp ../../src/status.cpp ../../src/constants.cpp ../../src/threading.cpp ../../src/ephemeris.cpp ../../src/encounter.cpp ../../src/lambert.cpp ../../src/leg.cpp ../../src/flyby.cpp ../../src/filter.cpp ../../src/combo.cpp ../../src/pipeline.cpp | $(BUILD_DIR)
	$(CLANGXX) $(CPPFLAGS) $(CXXFLAGS) $^ -o $@

$(BUILD_DIR)/star_search_native: main.cpp problem_text.cpp $(CORE_SOURCES) | $(BUILD_DIR)
	$(CLANGXX) $(CPPFLAGS) $(CXXFLAGS) $^ -o $@

clean:
	rm -rf $(BUILD_DIR)
