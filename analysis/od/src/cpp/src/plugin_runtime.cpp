#include "od/plugin_runtime.h"

#include "od/meme_parser.h"
#include "od/sgp4_fitter.h"

#include <exception>
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

PluginFitResult fit_meme_payload(std::string_view meme_content) {
    PluginFitResult result{};

    try {
        MEMEFile meme = parse_meme(std::string(meme_content));
        if (meme.points.empty()) {
            result.error_code = "parse-failed";
            result.error_message = "MEME payload did not contain any ephemeris points.";
        } else {
            FitterConfig config;
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
