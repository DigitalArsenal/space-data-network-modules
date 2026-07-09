#include "od/plugin_runtime.h"

#include "od/meme_parser.h"
#include "od/sgp4_fitter.h"

#include <algorithm>
#include <cctype>
#include <exception>
#include <limits>
#include <string>

namespace od {

namespace {

std::string json_escape(std::string_view value) {
    std::string escaped;
    escaped.reserve(value.size());
    for (char ch : value) {
        switch (ch) {
            case '\\':
                escaped += "\\\\";
                break;
            case '"':
                escaped += "\\\"";
                break;
            case '\n':
                escaped += "\\n";
                break;
            case '\r':
                escaped += "\\r";
                break;
            case '\t':
                escaped += "\\t";
                break;
            default:
                escaped.push_back(ch);
                break;
        }
    }
    return escaped;
}

}  // namespace

int parse_positive_int_option(std::string_view json, std::string_view key) {
    if (json.empty()) {
        return 0;
    }
    const std::string quoted_key = std::string("\"") + std::string(key) + "\"";
    const auto key_pos = json.find(quoted_key);
    if (key_pos == std::string_view::npos) {
        return 0;
    }
    const auto colon_pos = json.find(':', key_pos + quoted_key.size());
    if (colon_pos == std::string_view::npos) {
        return 0;
    }
    size_t cursor = colon_pos + 1;
    while (cursor < json.size() &&
           std::isspace(static_cast<unsigned char>(json[cursor]))) {
        cursor += 1;
    }
    int value = 0;
    bool saw_digit = false;
    while (cursor < json.size() &&
           std::isdigit(static_cast<unsigned char>(json[cursor]))) {
        saw_digit = true;
        const int digit = json[cursor] - '0';
        if (value > (std::numeric_limits<int>::max() - digit) / 10) {
            value = std::numeric_limits<int>::max();
            break;
        }
        value = value * 10 + digit;
        cursor += 1;
    }
    return saw_digit ? value : 0;
}

FitterConfig parse_fit_options(std::string_view options_json) {
    FitterConfig config;
    const int camel_case_limit =
        parse_positive_int_option(options_json, "maxIterations");
    const int snake_case_limit =
        parse_positive_int_option(options_json, "max_iterations");
    const int requested_limit =
        camel_case_limit > 0 ? camel_case_limit : snake_case_limit;
    if (requested_limit > 0) {
        config.max_iterations = std::clamp(requested_limit, 1, 300);
    }
    return config;
}

PluginFitResult fit_meme_payload(
    std::string_view meme_content,
    std::string_view options_json) {
    PluginFitResult result{};

    try {
        MEMEFile meme = parse_meme(std::string(meme_content));
        if (meme.points.empty()) {
            result.error_code = "parse-failed";
            result.error_message = "MEME payload did not contain any ephemeris points.";
        } else {
            FitterConfig config = parse_fit_options(options_json);
            auto fit = fit_sgp4_meme(meme, config);
            result.ok = true;
            result.json = elements_to_json(fit.elements);
            return result;
        }
    } catch (const std::exception& ex) {
        result.error_code = "fit-failed";
        result.error_message = ex.what();
    } catch (...) {
        result.error_code = "fit-failed";
        result.error_message = "Unknown plugin error.";
    }

    result.json =
        std::string("{\"error\":\"") + json_escape(result.error_message) + "\"}";
    return result;
}

}  // namespace od
