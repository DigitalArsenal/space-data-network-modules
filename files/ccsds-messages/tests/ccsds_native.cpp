// ccsds_native.cpp — measured acceptance for the CCSDS KVN layer, run against
// the five PUBLISHED Blue Book example messages in ../fixtures.
//
// WHAT IS BEING PROVEN, AND WHY IT IS PROVEN THIS WAY
//
// The acceptance is "every KVN keyword round-trips exactly". A test that
// listed the keywords it expected would prove only that somebody wrote a good
// list. So the expected keyword set for each fixture is recomputed HERE by an
// independent line scan that never touches kvn::parse — a second reader,
// written to a different rule, whose answer must equal the parser's. When the
// two disagree the parser is wrong or the scan is; either way something real
// has moved.
//
// The round trip is asserted on STRUCTURE, not bytes. kvn::serialize is
// explicit that alignment is a writer's choice and that a byte-identical
// re-emission of arbitrary input would mean storing each line's original
// whitespace. So the measurement is parse -> serialize -> parse, with every
// field of the two documents compared and counted: message type, header,
// segments, metadata, data lines, tokens, units, and each comment in its
// position. The count of compared fields is reported alongside the zero, so a
// comparison that silently stopped comparing would be visible.
//
// The AEM and TDM numbers are the facts that refute a uniform-grid record:
// Figure G-4's first segment steps 2336.3 s and then 1.0 s, and Figure E-17's
// last RCS observation is stamped EARLIER than the CARRIER_POWER line above
// it. Both are in the published books.
//
// NO SDS HERE, DELIBERATELY. This lane compiles with `-I src` and nothing
// else — no schema, no FlatBuffers runtime, no generated header — because it
// measures the layer everything else stands on and must stay buildable when
// the record toolchain is not. The `$AEM` / `$TDM` projection is measured by
// ccsds_projection_native.cpp, which does need all three.
//
// Build:
//   clang++ -std=c++17 -O2 -I src -I tests tests/ccsds_native.cpp -o /tmp/ccsds_native

#include "aem.hpp"
#include "ccsds_test_support.hpp"
#include "kvn.hpp"
#include "tdm.hpp"

#include <cstring>
#include <string>
#include <vector>

int main(int argc, char** argv) {
    const std::string dir = (argc > 1) ? std::string(argv[1]) : std::string("fixtures");

    /* ------------------------------------------------------------------ */
    /* 1. KVN round trip, per fixture                                      */
    /* ------------------------------------------------------------------ */

    for (size_t i = 0; i < FIXTURE_COUNT; ++i) {
        const Fixture& f = FIXTURES[i];
        Loaded& L = LOADED[i];
        if (!read_file(dir + "/" + f.file, &L.text)) {
            result(sfmt("fixture-readable.%s", f.id), "missing", "present", false);
            continue;
        }
        const kvn::Status s1 = kvn::parse(L.text.data(), L.text.size(), &L.parsed);
        result(sfmt("kvn-parse-status.%s", f.id), kvn::status_name(s1), "ok",
               s1 == kvn::Status::Ok);
        result(sfmt("kvn-message-type.%s", f.id), L.parsed.message_type, f.type,
               L.parsed.message_type == f.type);

        std::string emitted;
        const kvn::Status s2 = kvn::serialize(L.parsed, &emitted);
        result(sfmt("kvn-serialize-status.%s", f.id), kvn::status_name(s2), "ok",
               s2 == kvn::Status::Ok);
        const kvn::Status s3 = kvn::parse(emitted.data(), emitted.size(), &L.reparsed);
        result(sfmt("kvn-reparse-status.%s", f.id), kvn::status_name(s3), "ok",
               s3 == kvn::Status::Ok);

        const Diff d = compare_documents(L.parsed, L.reparsed);
        result(sfmt("kvn-roundtrip-fields-compared.%s", f.id), sfmt("%zu", d.compared), ">0",
               d.compared > 0);
        result(sfmt("kvn-roundtrip-differences.%s", f.id),
               d.differences ? sfmt("%zu (%s)", d.differences, d.first.c_str()) : std::string("0"),
               "0", d.differences == 0);
    }

    /* ------------------------------------------------------------------ */
    /* 2. Keyword coverage                                                 */
    /* ------------------------------------------------------------------ */

    std::vector<std::string> aem_union;
    std::vector<std::string> tdm_union;

    for (size_t i = 0; i < FIXTURE_COUNT; ++i) {
        const Fixture& f = FIXTURES[i];
        const Loaded& L = LOADED[i];
        const std::vector<std::string> expected = scan_keywords(L.text);
        const std::vector<std::string> recovered = document_keywords(L.parsed);
        const bool equal = sets_equal(expected, recovered);
        result(sfmt("keywords-in-file.%s", f.id), sfmt("%zu", expected.size()), ">0",
               expected.size() > 0);
        result(sfmt("keywords-recovered.%s", f.id), sfmt("%zu", recovered.size()),
               sfmt("%zu", expected.size()), recovered.size() == expected.size());
        result(sfmt("keywords-set-equal.%s", f.id),
               equal ? std::string("identical")
                     : sfmt("missing[%s] extra[%s]",
                            set_difference_text(expected, recovered).c_str(),
                            set_difference_text(recovered, expected).c_str()),
               "identical", equal);
        std::vector<std::string>& u = (std::strcmp(f.type, "AEM") == 0) ? aem_union : tdm_union;
        for (size_t k = 0; k < expected.size(); ++k) add_unique(&u, expected[k]);
    }

    // 22 is the published AEM Annex G2 corpus recorded in fixtures/PROVENANCE.md,
    // counted programmatically over the annex region of 504.0-B-2.
    result("keyword-union-aem", sfmt("%zu", aem_union.size()), "22", aem_union.size() == 22);
    result("keyword-union-tdm", sfmt("%zu", tdm_union.size()), "33", tdm_union.size() == 33);

    /* ------------------------------------------------------------------ */
    /* 3. AEM component discipline                                         */
    /* ------------------------------------------------------------------ */

    ccsds::aem::Message g4;
    ccsds::aem::Fault g4_fault;
    {
        const ccsds::aem::Status st = ccsds::aem::from_document(LOADED[0].parsed, &g4, &g4_fault);
        result("aem-g4-view-status", ccsds::aem::status_name(st), "ok",
               st == ccsds::aem::Status::Ok);
        result("aem-g4-segments", sfmt("%zu", g4.segments.size()), "2", g4.segments.size() == 2);
    }
    if (g4.segments.size() == 2) {
        const ccsds::aem::Segment& s0 = g4.segments[0];
        result("aem-g4-attitude-type", s0.attitude_type_text() ? s0.attitude_type_text() : "(absent)",
               "QUATERNION",
               s0.attitude_type == ccsds::aem::AttitudeType::Quaternion);
        result("aem-g4-components-per-row", sfmt("%zu", s0.components_per_row), "4",
               s0.components_per_row == 4);

        size_t wrong_width = 0;
        for (size_t s = 0; s < g4.segments.size(); ++s) {
            for (size_t r = 0; r < g4.segments[s].rows.size(); ++r) {
                if (g4.segments[s].rows[r].is_standalone_comment) continue;
                if (g4.segments[s].rows[r].components.size() != 4) ++wrong_width;
            }
        }
        result("aem-g4-rows-not-4-wide", sfmt("%zu", wrong_width), "0", wrong_width == 0);
        result("aem-g4-records", sfmt("%zu", s0.record_count() + g4.segments[1].record_count()),
               "8", s0.record_count() + g4.segments[1].record_count() == 8);

        // Epochs must come back as the file wrote them, character for
        // character: a reformatted epoch is a different file even when it is
        // the same instant.
        const std::vector<std::string> scanned = scan_columnar_epochs(LOADED[0].text);
        std::vector<std::string> from_view;
        for (size_t s = 0; s < g4.segments.size(); ++s) {
            for (size_t r = 0; r < g4.segments[s].rows.size(); ++r) {
                if (!g4.segments[s].rows[r].is_standalone_comment) {
                    from_view.push_back(g4.segments[s].rows[r].epoch);
                }
            }
        }
        size_t epoch_mismatches = (scanned.size() == from_view.size()) ? 0 : 1;
        for (size_t k = 0; k < scanned.size() && k < from_view.size(); ++k) {
            if (scanned[k] != from_view[k]) ++epoch_mismatches;
        }
        result("aem-g4-epochs-verbatim-mismatches", sfmt("%zu", epoch_mismatches), "0",
               epoch_mismatches == 0);

        // The non-uniformity. This is the fact that refutes any record which
        // reconstructs epochs as START_TIME + i*STEP_SIZE.
        std::vector<double> steps;
        for (size_t r = 1; r < s0.rows.size(); ++r) {
            const Epoch a = parse_epoch(s0.rows[r - 1].epoch);
            const Epoch b = parse_epoch(s0.rows[r].epoch);
            steps.push_back((a.ok && b.ok) ? epoch_diff(b, a) : -1.0);
        }
        result("aem-g4-steps-seg0", sfmt("%zu", steps.size()), "3", steps.size() == 3);
        if (steps.size() == 3) {
            result("aem-g4-step-1-seconds", sfmt("%.9f", steps[0]), "2336.3+/-1e-09",
                   std::fabs(steps[0] - 2336.3) <= 1e-9);
            result("aem-g4-step-2-seconds", sfmt("%.9f", steps[1]), "1.0+/-1e-09",
                   std::fabs(steps[1] - 1.0) <= 1e-9);
            result("aem-g4-step-3-seconds", sfmt("%.9f", steps[2]), "98398.0+/-1e-09",
                   std::fabs(steps[2] - 98398.0) <= 1e-9);
            double lo = steps[0], hi = steps[0];
            for (size_t k = 1; k < steps.size(); ++k) {
                if (steps[k] < lo) lo = steps[k];
                if (steps[k] > hi) hi = steps[k];
            }
            result("aem-g4-step-max-over-min", sfmt("%.3f", hi / lo), ">100", hi / lo > 100.0);
        }
    }

    ccsds::aem::Message g5;
    {
        ccsds::aem::Fault fault;
        const ccsds::aem::Status st = ccsds::aem::from_document(LOADED[1].parsed, &g5, &fault);
        result("aem-g5-view-status", ccsds::aem::status_name(st), "ok",
               st == ccsds::aem::Status::Ok);
        result("aem-g5-segments", sfmt("%zu", g5.segments.size()), "1", g5.segments.size() == 1);
    }
    if (g5.segments.size() == 1) {
        const ccsds::aem::Segment& s0 = g5.segments[0];
        result("aem-g5-attitude-type",
               s0.attitude_type_text() ? s0.attitude_type_text() : "(absent)", "SPIN",
               s0.attitude_type == ccsds::aem::AttitudeType::Spin);
        result("aem-g5-components-per-row", sfmt("%zu", s0.components_per_row), "4",
               s0.components_per_row == 4);
        result("aem-g5-records", sfmt("%zu", s0.record_count()), "8", s0.record_count() == 8);

        // The COMMENT inside the data block must still be inside it, attached
        // to the record it preceded.
        size_t data_comments = 0;
        for (size_t r = 0; r < s0.rows.size(); ++r) {
            data_comments += s0.rows[r].comments_before.size();
            if (s0.rows[r].is_standalone_comment) ++data_comments;
        }
        result("aem-g5-comments-inside-data", sfmt("%zu", data_comments), "1",
               data_comments == 1);

        std::vector<double> steps;
        std::vector<const ccsds::aem::Row*> records;
        for (size_t r = 0; r < s0.rows.size(); ++r) {
            if (!s0.rows[r].is_standalone_comment) records.push_back(&s0.rows[r]);
        }
        for (size_t r = 1; r < records.size(); ++r) {
            const Epoch a = parse_epoch(records[r - 1]->epoch);
            const Epoch b = parse_epoch(records[r]->epoch);
            steps.push_back((a.ok && b.ok) ? epoch_diff(b, a) : -1.0);
        }
        double worst = 0.0;
        for (size_t k = 0; k < steps.size(); ++k) {
            const double dev = std::fabs(steps[k] - 0.125);
            if (dev > worst) worst = dev;
        }
        result("aem-g5-step-seconds", steps.empty() ? std::string("none") : sfmt("%.9f", steps[0]),
               "0.125+/-1e-09", !steps.empty() && std::fabs(steps[0] - 0.125) <= 1e-9);
        result("aem-g5-max-deviation-from-uniform", sfmt("%.3e", worst), "<=1e-09", worst <= 1e-9);
    }

    /* ------------------------------------------------------------------ */
    /* 4. AEM numeric fidelity through the serialized form                 */
    /* ------------------------------------------------------------------ */

    {
        double worst = 0.0;
        size_t compared = 0;
        for (size_t i = 0; i < 2; ++i) {
            ccsds::aem::Message a, b;
            ccsds::aem::Fault fa, fb;
            if (ccsds::aem::from_document(LOADED[i].parsed, &a, &fa) != ccsds::aem::Status::Ok)
                continue;
            if (ccsds::aem::from_document(LOADED[i].reparsed, &b, &fb) != ccsds::aem::Status::Ok)
                continue;
            for (size_t s = 0; s < a.segments.size() && s < b.segments.size(); ++s) {
                for (size_t r = 0; r < a.segments[s].rows.size() &&
                                   r < b.segments[s].rows.size(); ++r) {
                    const ccsds::aem::Row& ra = a.segments[s].rows[r];
                    const ccsds::aem::Row& rb = b.segments[s].rows[r];
                    if (ra.is_standalone_comment || rb.is_standalone_comment) continue;
                    for (size_t c = 0; c < ra.components.size() && c < rb.components.size(); ++c) {
                        double va = 0.0, vb = 0.0;
                        if (!ra.value(c, &va) || !rb.value(c, &vb)) continue;
                        ++compared;
                        const double rel = relative_difference(va, vb);
                        if (rel > worst) worst = rel;
                    }
                }
            }
        }
        result("aem-components-compared", sfmt("%zu", compared), "64", compared == 64);
        result("aem-component-max-relative-error", sfmt("%.3e", worst), "<=1e-12", worst <= 1e-12);
    }

    /* ------------------------------------------------------------------ */
    /* 5. A wrong component count is a REFUSAL, not a truncation           */
    /* ------------------------------------------------------------------ */

    {
        // Figure G-4 with one number removed from the first record. The
        // declared type still says QUATERNION, so the file now contradicts
        // itself and there is no safe reading of it.
        std::string mutated = LOADED[0].text;
        const std::string from = "0.45689  0.68427";
        const size_t at = mutated.find(from);
        if (at == std::string::npos) {
            result("aem-mutation-applied", "not-found", "found", false);
        } else {
            mutated.replace(at, from.size(), "0.45689");
            kvn::Document doc;
            const kvn::Status ks = kvn::parse(mutated.data(), mutated.size(), &doc);
            ccsds::aem::Message m;
            ccsds::aem::Fault fault;
            const ccsds::aem::Status st = ccsds::aem::from_document(doc, &m, &fault);
            result("aem-3-wide-quaternion-parses-as-kvn", kvn::status_name(ks), "ok",
                   ks == kvn::Status::Ok);
            result("aem-3-wide-quaternion-refused", ccsds::aem::status_name(st),
                   "component-count-mismatch",
                   st == ccsds::aem::Status::ComponentCountMismatch);
            result("aem-refusal-code", sfmt("%d", static_cast<int>(st)), "-13",
                   static_cast<int>(st) == -13);
            result("aem-refusal-expected-vs-actual", sfmt("%zu vs %zu", fault.expected,
                                                          fault.actual),
                   "4 vs 3", fault.expected == 4 && fault.actual == 3);
            result("aem-refusal-yields-no-message", sfmt("%zu", m.segments.size()), "0",
                   m.segments.empty());
        }
    }

    /* ------------------------------------------------------------------ */
    /* 6. TDM observation model                                            */
    /* ------------------------------------------------------------------ */

    ccsds::tdm::Message e16, e17, e18;
    {
        ccsds::tdm::Fault fault;
        const ccsds::tdm::Status s16 = ccsds::tdm::from_document(LOADED[2].parsed, &e16, &fault);
        const ccsds::tdm::Status s17 = ccsds::tdm::from_document(LOADED[3].parsed, &e17, &fault);
        const ccsds::tdm::Status s18 = ccsds::tdm::from_document(LOADED[4].parsed, &e18, &fault);
        result("tdm-e16-view-status", ccsds::tdm::status_name(s16), "ok",
               s16 == ccsds::tdm::Status::Ok);
        result("tdm-e17-view-status", ccsds::tdm::status_name(s17), "ok",
               s17 == ccsds::tdm::Status::Ok);
        result("tdm-e18-view-status", ccsds::tdm::status_name(s18), "ok",
               s18 == ccsds::tdm::Status::Ok);
    }

    result("tdm-e16-segments", sfmt("%zu", e16.segments.size()), "2", e16.segments.size() == 2);
    result("tdm-e17-segments", sfmt("%zu", e17.segments.size()), "1", e17.segments.size() == 1);
    result("tdm-e18-segments", sfmt("%zu", e18.segments.size()), "2", e18.segments.size() == 2);

    if (e16.segments.size() == 2) {
        // Each segment carries its OWN metadata block: different track number,
        // different start and stop. A message-level metadata struct would have
        // silently kept whichever it saw last.
        const char* p2a = e16.segments[0].participant(2);
        const char* p2b = e16.segments[1].participant(2);
        result("tdm-e16-seg0-participant-2", p2a ? p2a : "(absent)", "TRACK NUMBER 001",
               p2a && std::strcmp(p2a, "TRACK NUMBER 001") == 0);
        result("tdm-e16-seg1-participant-2", p2b ? p2b : "(absent)", "TRACK NUMBER 003",
               p2b && std::strcmp(p2b, "TRACK NUMBER 003") == 0);
        result("tdm-e16-observations-per-segment",
               sfmt("%zu/%zu", e16.segments[0].observation_count(),
                    e16.segments[1].observation_count()),
               "9/9",
               e16.segments[0].observation_count() == 9 &&
                   e16.segments[1].observation_count() == 9);
    }

    if (e18.segments.size() == 2) {
        const char* st0 = e18.segments[0].start_time();
        const char* st1 = e18.segments[1].start_time();
        result("tdm-e18-segment-start-times",
               sfmt("%s|%s", st0 ? st0 : "(absent)", st1 ? st1 : "(absent)"),
               "2005-184T11:12:23|2005-184T13:59:27.27",
               st0 && st1 && std::strcmp(st0, "2005-184T11:12:23") == 0 &&
                   std::strcmp(st1, "2005-184T13:59:27.27") == 0);
        result("tdm-e18-observations-per-segment",
               sfmt("%zu/%zu", e18.segments[0].observation_count(),
                    e18.segments[1].observation_count()),
               "10/10",
               e18.segments[0].observation_count() == 10 &&
                   e18.segments[1].observation_count() == 10);
    }

    if (e17.segments.size() == 1) {
        const ccsds::tdm::Segment& seg = e17.segments[0];
        result("tdm-e17-observations", sfmt("%zu", seg.observation_count()), "15",
               seg.observation_count() == 15);

        // ORDER. The view's sequence must be the file's sequence, keyword for
        // keyword and epoch for epoch, with nothing sorted or grouped.
        const std::vector<ScannedObservation> scanned = scan_observations(LOADED[3].text);
        size_t order_mismatches = (scanned.size() == seg.observation_count()) ? 0 : 1;
        size_t k = 0;
        for (size_t i = 0; i < seg.observations.size(); ++i) {
            if (seg.observations[i].is_standalone_comment) continue;
            if (k >= scanned.size()) { ++order_mismatches; continue; }
            if (seg.observations[i].keyword != scanned[k].keyword ||
                seg.observations[i].epoch != scanned[k].epoch ||
                seg.observations[i].values.empty() ||
                seg.observations[i].values[0] != scanned[k].first_value) {
                ++order_mismatches;
            }
            ++k;
        }
        result("tdm-e17-order-mismatches", sfmt("%zu", order_mismatches), "0",
               order_mismatches == 0);

        // The published out-of-order epoch. The last RCS is stamped BEFORE the
        // CARRIER_POWER on the line above it — in the book, not in our copy.
        const ccsds::tdm::Observation* last_rcs = nullptr;
        const ccsds::tdm::Observation* prev_line = nullptr;
        for (size_t i = 0; i < seg.observations.size(); ++i) {
            if (seg.observations[i].keyword == "RCS") {
                last_rcs = &seg.observations[i];
                prev_line = (i > 0) ? &seg.observations[i - 1] : nullptr;
            }
        }
        if (last_rcs && prev_line) {
            result("tdm-e17-last-rcs-epoch", last_rcs->epoch, "2011-05-11T10:26:33.7008",
                   last_rcs->epoch == "2011-05-11T10:26:33.7008");
            result("tdm-e17-preceding-keyword", prev_line->keyword, "CARRIER_POWER",
                   prev_line->keyword == "CARRIER_POWER");
            result("tdm-e17-preceding-epoch", prev_line->epoch, "2011-05-11T10:26:33.9686",
                   prev_line->epoch == "2011-05-11T10:26:33.9686");
            const Epoch a = parse_epoch(prev_line->epoch);
            const Epoch b = parse_epoch(last_rcs->epoch);
            const double delta = epoch_diff(b, a);
            result("tdm-e17-rcs-minus-preceding-seconds", sfmt("%.4f", delta), "<0", delta < 0.0);
        } else {
            result("tdm-e17-last-rcs-epoch", "(not found)", "2011-05-11T10:26:33.7008", false);
        }

        // RANGE through the serialized form.
        ccsds::tdm::Message reparsed;
        ccsds::tdm::Fault fault;
        double worst = 0.0;
        size_t compared = 0;
        if (ccsds::tdm::from_document(LOADED[3].reparsed, &reparsed, &fault) ==
                ccsds::tdm::Status::Ok &&
            reparsed.segments.size() == 1) {
            const ccsds::tdm::Segment& rs = reparsed.segments[0];
            for (size_t i = 0; i < seg.observations.size() && i < rs.observations.size(); ++i) {
                if (seg.observations[i].keyword != "RANGE") continue;
                double va = 0.0, vb = 0.0;
                if (!seg.observations[i].value(0, &va) || !rs.observations[i].value(0, &vb))
                    continue;
                ++compared;
                const double rel = relative_difference(va, vb);
                if (rel > worst) worst = rel;
            }
        }
        result("tdm-e17-range-values-compared", sfmt("%zu", compared), "3", compared == 3);
        result("tdm-e17-range-max-relative-error", sfmt("%.3e", worst), "<=1e-12", worst <= 1e-12);
        result("tdm-e17-range-units", seg.range_units() ? seg.range_units() : "(absent)", "km",
               seg.range_units() && std::strcmp(seg.range_units(), "km") == 0);
        result("tdm-e17-correction-range",
               seg.correction_range() ? seg.correction_range() : "(absent)", "-1.48",
               seg.correction_range() && std::strcmp(seg.correction_range(), "-1.48") == 0);
    }

    /* ------------------------------------------------------------------ */
    /* 7. Structured-view round trip                                       */
    /* ------------------------------------------------------------------ */

    for (size_t i = 0; i < FIXTURE_COUNT; ++i) {
        const Fixture& f = FIXTURES[i];
        const Loaded& L = LOADED[i];
        kvn::Document rebuilt;
        bool built = false;
        if (std::strcmp(f.type, "AEM") == 0) {
            ccsds::aem::Message m;
            ccsds::aem::Fault fault;
            built = ccsds::aem::from_document(L.parsed, &m, &fault) == ccsds::aem::Status::Ok &&
                    ccsds::aem::to_document(m, &rebuilt) == ccsds::aem::Status::Ok;
        } else {
            ccsds::tdm::Message m;
            ccsds::tdm::Fault fault;
            built = ccsds::tdm::from_document(L.parsed, &m, &fault) == ccsds::tdm::Status::Ok &&
                    ccsds::tdm::to_document(m, &rebuilt) == ccsds::tdm::Status::Ok;
        }
        if (!built) {
            result(sfmt("view-roundtrip-differences.%s", f.id), "view-build-failed", "0", false);
            continue;
        }
        std::string emitted;
        kvn::serialize(rebuilt, &emitted);
        kvn::Document reparsed;
        const kvn::Status ks = kvn::parse(emitted.data(), emitted.size(), &reparsed);
        const Diff d = compare_documents(L.parsed, reparsed);
        result(sfmt("view-roundtrip-parse-status.%s", f.id), kvn::status_name(ks), "ok",
               ks == kvn::Status::Ok);
        result(sfmt("view-roundtrip-fields-compared.%s", f.id), sfmt("%zu", d.compared), ">0",
               d.compared > 0);
        result(sfmt("view-roundtrip-differences.%s", f.id),
               d.differences ? sfmt("%zu (%s)", d.differences, d.first.c_str()) : std::string("0"),
               "0", d.differences == 0);
    }


    std::printf("\n%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
