/**
 * fred-sdn-plugin Implementation
 *
 * Federal Reserve Economic Data
 * API: https://api.stlouisfed.org/fred/series/observations
 *
 * Parses JSON API responses into the generic Record/DataSet structure
 * for FlatBuffers serialization.
 */

#include "fred/types.h"
#include <cstring>
#include <cstdlib>
#include <chrono>

namespace fred {

// ============================================================================
// Minimal JSON helpers (no external library dependency)
// ============================================================================

static const char* skip_whitespace(const char* p, const char* end) {
    while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++;
    return p;
}

static const char* find_key(const char* p, const char* end, const char* key) {
    size_t klen = strlen(key);
    while (p < end - klen - 3) {
        if (*p == '"' && memcmp(p + 1, key, klen) == 0 && p[klen + 1] == '"') {
            p += klen + 2;
            while (p < end && (*p == ' ' || *p == ':' || *p == '\t')) p++;
            return p;
        }
        p++;
    }
    return nullptr;
}

static double parse_number(const char* p, const char* end) {
    if (!p || p >= end) return 0.0;
    while (p < end && (*p == ' ' || *p == '\t')) p++;
    if (*p == '"') { p++; } // handle quoted numbers
    if (p >= end || *p == 'n') return 0.0;
    return atof(p);
}

static std::string parse_string(const char* p, const char* end) {
    if (!p || p >= end || *p != '"') return "";
    p++; // skip opening quote
    const char* start = p;
    while (p < end && *p != '"') {
        if (*p == '\\') p++; // skip escaped char
        p++;
    }
    return std::string(start, p);
}

static const char* find_array(const char* p, const char* end) {
    while (p < end) {
        if (*p == '[') return p + 1;
        p++;
    }
    return nullptr;
}

static const char* next_object(const char* p, const char* end) {
    while (p < end) {
        if (*p == '{') return p;
        if (*p == ']') return nullptr;
        p++;
    }
    return nullptr;
}

static const char* object_end(const char* p, const char* end) {
    int depth = 0;
    while (p < end) {
        if (*p == '{') depth++;
        else if (*p == '}') { depth--; if (depth == 0) return p + 1; }
        else if (*p == '"') { p++; while (p < end && *p != '"') { if (*p == '\\') p++; p++; } }
        p++;
    }
    return end;
}

// ============================================================================
// parse_json — Parse Federal Reserve Economic Data API JSON response
// ============================================================================

DataSet parse_json(const std::string& json_input) {
    DataSet ds;
    ds.version = VERSION;
    ds.fetch_timestamp = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());

    const char* p = json_input.c_str();
    const char* end = p + json_input.size();

    // Find the data array
    const char* data_key = find_key(p, end, "observations");
    if (!data_key) {
        // Try parsing as a bare array
        const char* arr = find_array(p, end);
        if (!arr) return ds;
        data_key = p;
    }

    const char* arr = find_array(data_key, end);
    if (!arr) return ds;

    // Iterate over objects in the array
    const char* obj = next_object(arr, end);
    while (obj) {
        const char* obj_e = object_end(obj, end);
        if (obj_e <= obj) break;

        Record rec;

        const char* ts_val = find_key(obj, obj_e, "date");
        if (ts_val) {
            std::string ds = parse_string(ts_val, obj_e);
            if (ds.size() >= 10) {
                int y = atoi(ds.c_str());
                int m = atoi(ds.c_str() + 5);
                int d = atoi(ds.c_str() + 8);
                rec.timestamp = ((y - 1970) * 365.25 + (m - 1) * 30.44 + d) * 86400.0;
            }
        }

        rec.latitude = 0.0;

        rec.longitude = 0.0;

        const char* val_p = find_key(obj, obj_e, "value");
        rec.value = parse_number(val_p, obj_e);

        const char* id_p = find_key(obj, obj_e, "realtime_start");
        rec.source_id = parse_string(id_p, obj_e);

        const char* cat_p = find_key(obj, obj_e, "realtime_end");
        rec.category = parse_string(cat_p, obj_e);

        const char* desc_p = find_key(obj, obj_e, "date");
        rec.description = parse_string(desc_p, obj_e);

        ds.records.push_back(rec);
        obj = next_object(obj_e, end);
    }

    return ds;
}

// ============================================================================
// to_flatbuffers — Serialize DataSet to FlatBuffer-aligned binary
// ============================================================================
// Wire format (little-endian):
//   [4] magic "SDN\0"
//   [4] version (uint32)
//   [8] fetch_timestamp (uint64)
//   [4] record_count (uint32)
//   For each record:
//     [8] timestamp (double)
//     [8] latitude (double)
//     [8] longitude (double)
//     [8] value (double)
//     [4] source_id_len, [N] source_id bytes
//     [4] category_len, [N] category bytes
//     [4] description_len, [N] description bytes

static void write_u32(std::string& buf, uint32_t v) {
    buf.append(reinterpret_cast<const char*>(&v), 4);
}

static void write_u64(std::string& buf, uint64_t v) {
    buf.append(reinterpret_cast<const char*>(&v), 8);
}

static void write_f64(std::string& buf, double v) {
    buf.append(reinterpret_cast<const char*>(&v), 8);
}

static void write_str(std::string& buf, const std::string& s) {
    uint32_t len = static_cast<uint32_t>(s.size());
    write_u32(buf, len);
    buf.append(s);
}

std::string to_flatbuffers(const DataSet& data) {
    std::string buf;
    buf.reserve(64 + data.records.size() * 128);

    // Header
    buf.append("SDN", 4); // magic (includes null terminator)
    write_u32(buf, data.version);
    write_u64(buf, data.fetch_timestamp);
    write_u32(buf, static_cast<uint32_t>(data.records.size()));

    // Records
    for (const auto& rec : data.records) {
        write_f64(buf, rec.timestamp);
        write_f64(buf, rec.latitude);
        write_f64(buf, rec.longitude);
        write_f64(buf, rec.value);
        write_str(buf, rec.source_id);
        write_str(buf, rec.category);
        write_str(buf, rec.description);
    }

    return buf;
}

// ============================================================================
// validate — Check if input is plausibly valid JSON for this API
// ============================================================================

bool validate(const std::string& input) {
    if (input.empty()) return false;
    if (input.find('{') == std::string::npos && input.find('[') == std::string::npos) return false;
    // Check for expected key in the response
    if (input.find("\"observations\"") != std::string::npos) return true;
    // Accept bare arrays or objects
    const char* p = input.c_str();
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    return (*p == '[' || *p == '{');
}

} // namespace fred
