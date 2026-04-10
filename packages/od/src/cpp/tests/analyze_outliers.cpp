/**
 * Analyze SupGP outliers — find what's different about bad fits
 */
#include "od/meme_parser.h"
#include "od/sgp4_fitter.h"
#include <iostream>
#include <fstream>
#include <sstream>
#include <vector>
#include <map>
#include <algorithm>
#include <iomanip>
#include <dirent.h>
#include <cmath>

using namespace od;

struct CelesTrakRec {
    int norad_cat_id;
    double mean_motion, eccentricity, inclination, rms, bstar;
};

static std::map<int, CelesTrakRec> load_celestrak(const std::string& path) {
    std::map<int, CelesTrakRec> recs;
    std::ifstream f(path);
    std::string line;
    std::getline(f, line); // header
    while (std::getline(f, line)) {
        std::vector<std::string> fields;
        std::stringstream ss(line);
        std::string field;
        while (std::getline(ss, field, ',')) {
            if (!field.empty() && field.back() == '\r') field.pop_back();
            fields.push_back(field);
        }
        if (fields.size() < 19) continue;
        CelesTrakRec r;
        r.norad_cat_id = std::stoi(fields[11]);
        r.mean_motion = std::stod(fields[3]);
        r.eccentricity = std::stod(fields[4]);
        r.inclination = std::stod(fields[5]);
        try { r.rms = std::stod(fields[17]); } catch(...) { r.rms = -1; }
        try { r.bstar = std::stod(fields[14]); } catch(...) { r.bstar = 0; }
        recs[r.norad_cat_id] = r;
    }
    return recs;
}

static std::vector<std::string> list_meme_files(const std::string& dir) {
    std::vector<std::string> files;
    DIR* d = opendir(dir.c_str());
    if (!d) return files;
    struct dirent* entry;
    while ((entry = readdir(d))) {
        std::string name = entry->d_name;
        if (name.find("MEME_") == 0 && name.find(".txt") != std::string::npos)
            files.push_back(dir + "/" + name);
    }
    closedir(d);
    std::sort(files.begin(), files.end());
    return files;
}

int main(int argc, char** argv) {
    std::string meme_dir = argv[1];
    std::string celestrak_csv = (argc > 2) ? argv[2] : "";
    int max_files = (argc > 3) ? std::atoi(argv[3]) : 200;

    auto celestrak = load_celestrak(celestrak_csv);
    auto files = list_meme_files(meme_dir);
    if (max_files > 0 && (int)files.size() > max_files) files.resize(max_files);

    FitterConfig config;
    config.max_iterations = 50;
    config.fit_window_sec = 28800;
    config.subsample = 10;

    struct Result {
        int norad;
        double our_rms, ct_rms, ct_bstar, our_bstar;
        double inclination, eccentricity;
    };
    std::vector<Result> results;

    for (auto& file : files) {
        auto meme = parse_meme_file(file);
        if (meme.points.size() < 10) continue;
        auto fit = fit_sgp4_meme(meme, config);

        auto it = celestrak.find(meme.header.norad_cat_id);
        double ct_rms = (it != celestrak.end()) ? it->second.rms : -1;
        double ct_bstar = (it != celestrak.end()) ? it->second.bstar : 0;

        results.push_back({
            meme.header.norad_cat_id,
            fit.rms_km, ct_rms, ct_bstar, fit.elements.bstar,
            fit.elements.inclination, fit.elements.eccentricity
        });
    }

    // Sort by our RMS (worst first)
    std::sort(results.begin(), results.end(),
              [](const Result& a, const Result& b) { return a.our_rms > b.our_rms; });

    std::cout << "=== TOP 30 WORST FITS ===" << std::endl;
    std::cout << std::setw(8) << "NORAD" << "  "
              << std::setw(8) << "Our_RMS" << "  "
              << std::setw(8) << "CT_RMS" << "  "
              << std::setw(10) << "Our_B*" << "  "
              << std::setw(10) << "CT_B*" << "  "
              << std::setw(6) << "Inc" << "  "
              << std::setw(8) << "Ecc" << std::endl;

    for (int i = 0; i < 30 && i < (int)results.size(); i++) {
        auto& r = results[i];
        std::cout << std::setw(8) << r.norad << "  "
                  << std::fixed << std::setprecision(3) << std::setw(8) << r.our_rms << "  "
                  << std::setw(8) << r.ct_rms << "  "
                  << std::scientific << std::setprecision(2) << std::setw(10) << r.our_bstar << "  "
                  << std::setw(10) << r.ct_bstar << "  "
                  << std::fixed << std::setprecision(1) << std::setw(6) << r.inclination << "  "
                  << std::setprecision(5) << std::setw(8) << r.eccentricity << std::endl;
    }

    std::cout << "\n=== TOP 30 BEST FITS ===" << std::endl;
    for (int i = (int)results.size() - 1; i >= std::max(0, (int)results.size() - 30); i--) {
        auto& r = results[i];
        std::cout << std::setw(8) << r.norad << "  "
                  << std::fixed << std::setprecision(3) << std::setw(8) << r.our_rms << "  "
                  << std::setw(8) << r.ct_rms << "  "
                  << std::scientific << std::setprecision(2) << std::setw(10) << r.our_bstar << "  "
                  << std::setw(10) << r.ct_bstar << "  "
                  << std::fixed << std::setprecision(1) << std::setw(6) << r.inclination << "  "
                  << std::setprecision(5) << std::setw(8) << r.eccentricity << std::endl;
    }

    // Statistics: correlation between our_rms and CT_rms
    std::cout << "\n=== CORRELATIONS ===" << std::endl;
    int both_good = 0, both_bad = 0, we_good_ct_bad = 0, we_bad_ct_good = 0;
    for (auto& r : results) {
        if (r.ct_rms < 0) continue;
        bool ours_good = r.our_rms < 0.5;
        bool ct_good = r.ct_rms < 0.5;
        if (ours_good && ct_good) both_good++;
        else if (!ours_good && !ct_good) both_bad++;
        else if (ours_good && !ct_good) we_good_ct_bad++;
        else we_bad_ct_good++;
    }
    std::cout << "Both < 0.5 km:        " << both_good << std::endl;
    std::cout << "Both > 0.5 km:        " << both_bad << std::endl;
    std::cout << "We < 0.5, CT > 0.5:   " << we_good_ct_bad << std::endl;
    std::cout << "We > 0.5, CT < 0.5:   " << we_bad_ct_good << std::endl;

    // B* comparison
    int bstar_order_match = 0, bstar_order_off = 0;
    for (auto& r : results) {
        if (r.ct_rms < 0 || std::abs(r.ct_bstar) < 1e-10) continue;
        double log_ratio = std::abs(std::log10(std::abs(r.our_bstar) / std::abs(r.ct_bstar)));
        if (log_ratio < 1.0) bstar_order_match++;
        else bstar_order_off++;
    }
    std::cout << "\nB* within 1 order:    " << bstar_order_match << std::endl;
    std::cout << "B* off by >1 order:   " << bstar_order_off << std::endl;

    return 0;
}
