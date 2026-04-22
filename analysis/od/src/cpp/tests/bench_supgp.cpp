/**
 * SupGP Batch Benchmark
 *
 * Downloads SpaceX MEME ephemeris files and benchmarks SGP4 fitting.
 * Compares fitted elements to CelesTrak SupGP.
 *
 * Usage:
 *   ./bench_supgp <meme_dir> [max_files] [celestrak_csv]
 *
 * meme_dir:       Directory containing downloaded MEME files
 * max_files:      Max files to process (0 = all, default 100)
 * celestrak_csv:  CelesTrak SupGP CSV for comparison (optional)
 */

#include "od/meme_parser.h"
#include "od/sgp4_fitter.h"

#include <iostream>
#include <fstream>
#include <sstream>
#include <vector>
#include <map>
#include <chrono>
#include <cmath>
#include <algorithm>
#include <iomanip>
#include <dirent.h>
#include <cstring>

using namespace od;

// ── CelesTrak SupGP reference record ──

struct CelesTrakRecord {
    std::string object_name;
    std::string object_id;
    int norad_cat_id;
    double mean_motion;
    double eccentricity;
    double inclination;
    double rms;
    std::string data_source;
};

static std::map<int, CelesTrakRecord> parse_celestrak_csv(const std::string& path) {
    std::map<int, CelesTrakRecord> records;
    std::ifstream f(path);
    if (!f.is_open()) return records;

    std::string line;
    std::getline(f, line);  // Skip header

    while (std::getline(f, line)) {
        if (line.empty()) continue;

        // Parse CSV fields
        std::vector<std::string> fields;
        std::stringstream ss(line);
        std::string field;
        while (std::getline(ss, field, ',')) {
            // Remove \r
            if (!field.empty() && field.back() == '\r') field.pop_back();
            fields.push_back(field);
        }

        if (fields.size() < 19) continue;

        CelesTrakRecord rec;
        rec.object_name = fields[0];
        rec.object_id = fields[1];
        rec.mean_motion = std::stod(fields[3]);
        rec.eccentricity = std::stod(fields[4]);
        rec.inclination = std::stod(fields[5]);
        rec.norad_cat_id = std::stoi(fields[11]);
        try { rec.rms = std::stod(fields[17]); } catch (...) { rec.rms = -1; }
        rec.data_source = fields[18];

        records[rec.norad_cat_id] = rec;
    }

    return records;
}

// ── List MEME files in directory ──

static std::vector<std::string> list_meme_files(const std::string& dir) {
    std::vector<std::string> files;
    DIR* d = opendir(dir.c_str());
    if (!d) return files;

    struct dirent* entry;
    while ((entry = readdir(d))) {
        std::string name = entry->d_name;
        if (name.find("MEME_") == 0 && name.find(".txt") != std::string::npos) {
            files.push_back(dir + "/" + name);
        }
    }
    closedir(d);

    std::sort(files.begin(), files.end());
    return files;
}

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <meme_dir> [max_files] [celestrak_csv]" << std::endl;
        return 1;
    }

    std::string meme_dir = argv[1];
    int max_files = (argc > 2) ? std::atoi(argv[2]) : 100;
    std::string celestrak_csv = (argc > 3) ? argv[3] : "";

    // Load CelesTrak reference data
    std::map<int, CelesTrakRecord> celestrak;
    if (!celestrak_csv.empty()) {
        celestrak = parse_celestrak_csv(celestrak_csv);
        std::cout << "Loaded " << celestrak.size() << " CelesTrak SupGP records" << std::endl;
    }

    // List MEME files
    auto files = list_meme_files(meme_dir);
    std::cout << "Found " << files.size() << " MEME files in " << meme_dir << std::endl;

    if (max_files > 0 && static_cast<int>(files.size()) > max_files) {
        files.resize(max_files);
    }
    std::cout << "Processing " << files.size() << " files..." << std::endl;
    std::cout << std::endl;

    // Benchmark — use default config (2 orbital periods, auto subsample)
    FitterConfig config;
    // defaults: fit_window_sec=11520, max_iterations=50, subsample=1

    int total = 0, success = 0, failed = 0, errors = 0;
    double total_rms = 0.0;
    double best_rms = 1e6, worst_rms = 0.0;
    int converged_count = 0;
    int better_than_celestrak = 0, worse_than_celestrak = 0, no_celestrak = 0;

    std::vector<double> all_rms;
    std::vector<double> all_fit_times_ms;
    std::vector<double> all_parse_times_ms;

    auto bench_start = std::chrono::steady_clock::now();

    for (size_t idx = 0; idx < files.size(); idx++) {
        total++;

        // Parse MEME
        auto parse_start = std::chrono::steady_clock::now();
        auto meme = parse_meme_file(files[idx]);
        auto parse_end = std::chrono::steady_clock::now();
        double parse_ms = std::chrono::duration<double, std::milli>(parse_end - parse_start).count();
        all_parse_times_ms.push_back(parse_ms);

        if (meme.points.size() < 10) {
            errors++;
            continue;
        }

        // Fit SGP4
        auto fit_start = std::chrono::steady_clock::now();
        auto result = fit_sgp4_meme(meme, config);
        auto fit_end = std::chrono::steady_clock::now();
        double fit_ms = std::chrono::duration<double, std::milli>(fit_end - fit_start).count();
        all_fit_times_ms.push_back(fit_ms);

        if (result.rms_km > 50.0) {
            failed++;
            continue;
        }

        success++;
        total_rms += result.rms_km;
        all_rms.push_back(result.rms_km);
        if (result.rms_km < best_rms) best_rms = result.rms_km;
        if (result.rms_km > worst_rms) worst_rms = result.rms_km;
        if (result.converged) converged_count++;

        // Compare to CelesTrak
        if (!celestrak.empty()) {
            auto it = celestrak.find(meme.header.norad_cat_id);
            if (it != celestrak.end() && it->second.rms > 0) {
                if (result.rms_km <= it->second.rms) {
                    better_than_celestrak++;
                } else {
                    worse_than_celestrak++;
                }
            } else {
                no_celestrak++;
            }
        }

        // Progress
        if (total % 50 == 0 || total == static_cast<int>(files.size())) {
            double avg_rms = total_rms / success;
            double avg_fit = 0;
            for (auto t : all_fit_times_ms) avg_fit += t;
            avg_fit /= all_fit_times_ms.size();

            std::cout << "  [" << total << "/" << files.size() << "] "
                      << success << " ok, " << failed << " fail, " << errors << " err"
                      << " | avg RMS: " << std::fixed << std::setprecision(3) << avg_rms << " km"
                      << " | avg fit: " << std::setprecision(1) << avg_fit << " ms"
                      << std::endl;
        }
    }

    auto bench_end = std::chrono::steady_clock::now();
    double total_sec = std::chrono::duration<double>(bench_end - bench_start).count();

    // Sort RMS for percentiles
    std::sort(all_rms.begin(), all_rms.end());
    std::sort(all_fit_times_ms.begin(), all_fit_times_ms.end());

    double median_rms = all_rms.empty() ? 0 : all_rms[all_rms.size() / 2];
    double p90_rms = all_rms.empty() ? 0 : all_rms[static_cast<size_t>(all_rms.size() * 0.9)];
    double p95_rms = all_rms.empty() ? 0 : all_rms[static_cast<size_t>(all_rms.size() * 0.95)];
    double p99_rms = all_rms.empty() ? 0 : all_rms[static_cast<size_t>(all_rms.size() * 0.99)];

    double median_fit = all_fit_times_ms.empty() ? 0 : all_fit_times_ms[all_fit_times_ms.size() / 2];
    double p90_fit = all_fit_times_ms.empty() ? 0 : all_fit_times_ms[static_cast<size_t>(all_fit_times_ms.size() * 0.9)];

    double avg_parse = 0;
    for (auto t : all_parse_times_ms) avg_parse += t;
    avg_parse /= all_parse_times_ms.empty() ? 1 : all_parse_times_ms.size();

    // Report
    std::cout << "\n" << std::string(60, '=') << std::endl;
    std::cout << "SupGP BATCH BENCHMARK RESULTS" << std::endl;
    std::cout << std::string(60, '=') << std::endl;

    std::cout << "\nFiles:" << std::endl;
    std::cout << "  Total:      " << total << std::endl;
    std::cout << "  Success:    " << success << " (" << std::fixed << std::setprecision(1)
              << 100.0 * success / std::max(1, total) << "%)" << std::endl;
    std::cout << "  Failed:     " << failed << std::endl;
    std::cout << "  Parse err:  " << errors << std::endl;
    std::cout << "  Converged:  " << converged_count << "/" << success << std::endl;

    std::cout << "\nFit Quality (RMS, km):" << std::endl;
    std::cout << "  Best:    " << std::setprecision(3) << best_rms << std::endl;
    std::cout << "  Median:  " << median_rms << std::endl;
    std::cout << "  Mean:    " << (success > 0 ? total_rms / success : 0) << std::endl;
    std::cout << "  P90:     " << p90_rms << std::endl;
    std::cout << "  P95:     " << p95_rms << std::endl;
    std::cout << "  P99:     " << p99_rms << std::endl;
    std::cout << "  Worst:   " << worst_rms << std::endl;

    std::cout << "\nTiming:" << std::endl;
    std::cout << "  Total wall time:    " << std::setprecision(1) << total_sec << " s" << std::endl;
    std::cout << "  Avg parse time:     " << std::setprecision(1) << avg_parse << " ms/file" << std::endl;
    std::cout << "  Median fit time:    " << median_fit << " ms/file" << std::endl;
    std::cout << "  P90 fit time:       " << p90_fit << " ms/file" << std::endl;
    std::cout << "  Throughput:         " << std::setprecision(1)
              << (total / total_sec) << " sats/sec" << std::endl;
    std::cout << "  Est. 9943 sats:     " << std::setprecision(1)
              << (9943.0 * total_sec / std::max(1, total)) << " s ("
              << std::setprecision(1) << (9943.0 * total_sec / std::max(1, total) / 60.0)
              << " min)" << std::endl;

    if (!celestrak.empty()) {
        std::cout << "\nCelesTrak Comparison:" << std::endl;
        std::cout << "  Better RMS:  " << better_than_celestrak << std::endl;
        std::cout << "  Worse RMS:   " << worse_than_celestrak << std::endl;
        std::cout << "  No ref data: " << no_celestrak << std::endl;
        std::cout << "  Win rate:    " << std::setprecision(1)
                  << 100.0 * better_than_celestrak /
                     std::max(1, better_than_celestrak + worse_than_celestrak) << "%" << std::endl;
    }

    std::cout << "\n" << std::string(60, '=') << std::endl;

    // Output SupGP CSV header + all results for later analysis
    std::string csv_output = meme_dir + "/supgp_results.csv";
    std::ofstream csv(csv_output);
    if (csv.is_open()) {
        csv << "OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,"
            << "RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,"
            << "CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,"
            << "BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT,RMS,DATA_SOURCE\r\n";

        // Re-process and write CSV (we didn't save results in the loop)
        for (size_t idx = 0; idx < files.size(); idx++) {
            auto meme = parse_meme_file(files[idx]);
            if (meme.points.size() < 10) continue;
            auto result = fit_sgp4_meme(meme, config);
            if (result.rms_km > 50.0) continue;
            csv << elements_to_csv(result.elements) << "\r\n";
        }
        csv.close();
        std::cout << "SupGP CSV written to: " << csv_output << std::endl;
    }

    return 0;
}
