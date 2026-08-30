// ccsds_projection_native.cpp — measured acceptance for the SDS `$AEM` and
// `$TDM` projection, run against the same five PUBLISHED Blue Book example
// messages in ../fixtures.
//
// WHAT IS BEING PROVEN
//
// KVN -> structured view -> record -> FlatBuffer -> record -> structured view
// -> KVN, and the document that comes out the far end compared field for field
// against the one that went in. The record is a set of named IDL fields and the
// document is an ordered list of lines, so the comparison has two rules and
// they are both stated in the code: everything textual must come back byte for
// byte, and a value the record carries as an IEEE double is compared as a
// NUMBER, because `2.6862511e+002` and `268.62511` are the same measurement and
// different files.
//
// What the record cannot carry is not excused, it is DECLARED. `to_record`
// reports every keyword and comment with no field to land in, before it writes
// anything; the reference document is the original with exactly those removed;
// and the difference count against it must be zero. A loss the projection
// failed to declare surfaces as a difference, and a loss it declared but did
// not cause surfaces as a failed removal.
//
// This lane needs the generated SDS headers and the FlatBuffers C++ runtime.
// Both come from PUBLISHED packages this module already pins — the headers
// from `spacedatastandards.org` via generate-sds-headers.mjs, the runtime from
// `flatc-wasm`'s embedded C++ tree, which is the same source the module SDK's
// own compiler uses. Neither is read from a sibling checkout.
//
// Build (the wrapper does this; the runtime include dir is written to a temp
// directory and deleted):
//   clang++ -std=c++17 -O2 -I src -I tests -I <flatbuffers-runtime> \
//       tests/ccsds_projection_native.cpp -o /tmp/ccsds_projection_native

#include "aem.hpp"
#include "aem_projection.hpp"
#include "ccsds_test_support.hpp"
#include "kvn.hpp"
#include "tdm.hpp"
#include "tdm_projection.hpp"

#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <vector>

namespace {

/* ---------------------------------------------------------------------- */
/* Declared record losses, applied to a reference document                 */
/* ---------------------------------------------------------------------- */

/*
 * The projection REPORTS what $AEM / $TDM cannot carry, keyword by keyword,
 * before it writes anything. That report is what makes the round trip
 * measurable: instead of comparing against a hand-maintained list of "fields we
 * expect to survive", the reference document is the ORIGINAL with exactly the
 * declared losses taken out, and the comparison against it must then be
 * difference-free. A loss the projection failed to declare shows up as a
 * difference; a difference the projection declared but did not actually cause
 * shows up as a failed removal. Neither can hide.
 */

bool remove_comment(std::vector<kvn::Entry>* entries, const std::string& text) {
    for (size_t i = 0; i < entries->size(); ++i) {
        std::vector<std::string>& c = (*entries)[i].comments_before;
        for (size_t j = 0; j < c.size(); ++j) {
            if (c[j] == text) { c.erase(c.begin() + static_cast<long>(j)); return true; }
        }
    }
    for (size_t i = 0; i < entries->size(); ++i) {
        if ((*entries)[i].is_standalone_comment && (*entries)[i].value == text) {
            entries->erase(entries->begin() + static_cast<long>(i));
            return true;
        }
    }
    return false;
}

bool remove_data_comment(std::vector<kvn::DataLine>* lines, const std::string& text) {
    for (size_t i = 0; i < lines->size(); ++i) {
        std::vector<std::string>& c = (*lines)[i].comments_before;
        for (size_t j = 0; j < c.size(); ++j) {
            if (c[j] == text) { c.erase(c.begin() + static_cast<long>(j)); return true; }
        }
    }
    for (size_t i = 0; i < lines->size(); ++i) {
        if ((*lines)[i].is_standalone_comment && (*lines)[i].epoch == text) {
            lines->erase(lines->begin() + static_cast<long>(i));
            return true;
        }
    }
    return false;
}

bool remove_key(std::vector<kvn::Entry>* entries, const std::string& key) {
    for (size_t i = 0; i < entries->size(); ++i) {
        if (!(*entries)[i].is_standalone_comment && (*entries)[i].key == key) {
            /* Comments attached to a removed entry belong to the block, not to
             * the entry; move them onto whatever follows so a declared keyword
             * loss does not silently take a carried comment with it. */
            if (!(*entries)[i].comments_before.empty() && i + 1 < entries->size()) {
                std::vector<std::string>& next = (*entries)[i + 1].comments_before;
                next.insert(next.begin(), (*entries)[i].comments_before.begin(),
                            (*entries)[i].comments_before.end());
            }
            entries->erase(entries->begin() + static_cast<long>(i));
            return true;
        }
    }
    return false;
}

kvn::Document apply_losses(const kvn::Document& src,
                           const std::vector<ccsds::sdsproj::Loss>& losses,
                           size_t* applied) {
    kvn::Document out = src;
    *applied = 0;
    for (size_t i = 0; i < losses.size(); ++i) {
        const ccsds::sdsproj::Loss& loss = losses[i];
        const bool header = loss.segment == ccsds::sdsproj::kHeaderScope;
        if (!header && loss.segment >= out.segments.size()) continue;
        bool done = false;
        if (loss.key == "COMMENT") {
            done = header ? remove_comment(&out.header, loss.text)
                          : (remove_comment(&out.segments[loss.segment].metadata, loss.text) ||
                             remove_data_comment(&out.segments[loss.segment].data, loss.text));
        } else {
            done = header ? remove_key(&out.header, loss.key)
                          : remove_key(&out.segments[loss.segment].metadata, loss.key);
        }
        if (done) ++*applied;
    }
    return out;
}

/* Every keyword OCCURRENCE the file carries in its header and metadata blocks,
 * plus every comment line anywhere. Counted straight off the parsed document
 * and never from the projection, so `mapped + declared == this` is a claim
 * about the projection rather than a restatement of it. */
size_t count_keyword_occurrences(const kvn::Document& doc) {
    size_t n = 0;
    for (size_t i = 0; i < doc.header.size(); ++i) {
        n += doc.header[i].comments_before.size();
        ++n;  /* the entry itself, standalone comment or keyword */
    }
    for (size_t s = 0; s < doc.segments.size(); ++s) {
        const kvn::Segment& seg = doc.segments[s];
        for (size_t i = 0; i < seg.metadata.size(); ++i) {
            n += seg.metadata[i].comments_before.size();
            ++n;
        }
        for (size_t i = 0; i < seg.data.size(); ++i) {
            n += seg.data[i].comments_before.size();
            if (seg.data[i].is_standalone_comment) ++n;
        }
    }
    return n;
}

std::string loss_summary(const std::vector<ccsds::sdsproj::Loss>& losses) {
    if (losses.empty()) return std::string("none");
    std::string out;
    for (size_t i = 0; i < losses.size(); ++i) {
        if (i) out += ",";
        out += losses[i].key;
        out += "/";
        out += ccsds::sdsproj::loss_reason_name(losses[i].reason);
    }
    return out;
}

/* ---------------------------------------------------------------------- */
/* Observation-epoch uniformity                                            */
/* ---------------------------------------------------------------------- */

struct GridFit {
    bool uniform = false;
    double step = 0.0;
    double max_error = 0.0;  /* worst |epoch[i] - (t0 + i*step)|, seconds */
    size_t count = 0;
};

/*
 * $TDM's compact form reconstructs an observation's time as
 * OBSERVATION_START_TIME + i * OBSERVATION_STEP_SIZE. This measures whether
 * that rule could reproduce a segment's stored epochs at all, and by how much
 * it misses. It is a MEASUREMENT of the record's alternative form, not a use of
 * it: the projection always writes the per-observation EPOCH.
 */
GridFit fit_uniform_grid(const std::vector<std::string>& epochs) {
    GridFit fit;
    fit.count = epochs.size();
    if (epochs.size() < 2) return fit;
    const Epoch t0 = parse_epoch(epochs[0]);
    const Epoch t1 = parse_epoch(epochs[1]);
    if (!t0.ok || !t1.ok) return fit;
    fit.step = epoch_diff(t1, t0);
    for (size_t i = 0; i < epochs.size(); ++i) {
        const Epoch ti = parse_epoch(epochs[i]);
        if (!ti.ok) return fit;
        const double err = std::fabs(epoch_diff(ti, t0) - static_cast<double>(i) * fit.step);
        if (err > fit.max_error) fit.max_error = err;
    }
    fit.uniform = fit.max_error <= 1e-9;
    return fit;
}

}  // namespace

int main(int argc, char** argv) {
    const std::string dir = (argc > 1) ? std::string(argv[1]) : std::string("fixtures");

    /* ------------------------------------------------------------------ */
    /* 0. The fixtures, parsed. Measured too: a projection asserted on a   */
    /*    document that failed to parse would assert nothing.              */
    /* ------------------------------------------------------------------ */

    for (size_t i = 0; i < FIXTURE_COUNT; ++i) {
        const Fixture& f = FIXTURES[i];
        Loaded& L = LOADED[i];
        if (!read_file(dir + "/" + f.file, &L.text)) {
            result(sfmt("fixture-readable.%s", f.id), "missing", "present", false);
            continue;
        }
        const kvn::Status s1 = kvn::parse(L.text.data(), L.text.size(), &L.parsed);
        result(sfmt("fixture-parse-status.%s", f.id), kvn::status_name(s1), "ok",
               s1 == kvn::Status::Ok);
        result(sfmt("fixture-message-type.%s", f.id), L.parsed.message_type, f.type,
               L.parsed.message_type == f.type);
    }

    /* ------------------------------------------------------------------ */
    /* 8. The SDS $AEM / $TDM record projection                            */
    /* ------------------------------------------------------------------ */

    /*
     * PINNED DECLARED LOSSES. These are not slack in the round trip: each is a
     * named gap in $AEM 2.0.2 / $TDM 2.0.4 that `to_record` reports BEFORE it
     * writes, and the difference count below is measured against the original
     * with exactly those removed — so the projection must differ in these
     * places and in no others.
     *
     *   aem-g5   1  a COMMENT line INSIDE the data block. `AEMSegment.COMMENT`
     *               is the metadata block's comments and `attitudeDataLine` has
     *               no comment field, so carrying it would make the record say
     *               the file had it somewhere it did not.
     *   tdm-e17  1  the bare `EPHEMERIS_NAME`. 503.0-B-2's metadata table
     *               defines only EPHEMERIS_NAME_1..5; Orekit rejects the same
     *               line. Renaming it to _1 would invent a participant index.
     *   tdm-e18  2  `FREQ_OFFSET = 0.0`, once per segment. A FlatBuffers table
     *               omits a scalar equal to its type default, so zero and
     *               never-written are the same bytes.
     *
     * When Themis lands a carrier for one of these the number goes to zero
     * here, which is the point of pinning it.
     */
    const size_t EXPECTED_LOSSES[FIXTURE_COUNT] = {0, 1, 0, 1, 2};

    ::AEMT AEM_BACK[2];
    ::TDMT TDM_BACK[3];
    ccsds::aem::Message AEM_VIEW_BACK[2];
    ccsds::tdm::Message TDM_VIEW_BACK[3];
    std::string RECORD_JSON[FIXTURE_COUNT];

    for (size_t i = 0; i < FIXTURE_COUNT; ++i) {
        const Fixture& f = FIXTURES[i];
        const Loaded& L = LOADED[i];
        const bool is_aem = std::strcmp(f.type, "AEM") == 0;

        std::vector<ccsds::sdsproj::Loss> losses;
        size_t mapped = 0;
        kvn::Document rebuilt;
        bool have_rebuilt = false;
        bool identifier_ok = false;
        bool buffer_ok = false;

        if (is_aem) {
            ccsds::aem::Message view;
            ccsds::aem::Fault fault;
            const ccsds::aem::Status vs = ccsds::aem::from_document(L.parsed, &view, &fault);
            result(sfmt("record-view-status.%s", f.id), ccsds::aem::status_name(vs), "ok",
                   vs == ccsds::aem::Status::Ok);

            ::AEMT rec;
            ccsds::aem::ProjectionReport rep;
            const ccsds::aem::ProjectionStatus ps = ccsds::aem::to_record(view, &rec, &rep);
            result(sfmt("record-to-record-status.%s", f.id),
                   ccsds::aem::projection_status_name(ps), "ok",
                   ps == ccsds::aem::ProjectionStatus::Ok);
            losses = rep.losses;
            mapped = rep.mapped_keys;

            /* The two-form rule: STEP_SIZE == 0 selects ATTITUDE_DATA_LINES and
             * the compact array must stay empty. Asserted per segment because a
             * projection that got it right for one segment and wrong for the
             * next would still look right in aggregate. */
            size_t wrong_form = 0;
            size_t lines_total = 0;
            for (size_t si = 0; si < rec.SEGMENTS.size(); ++si) {
                const ::AEMSegmentT* seg = rec.SEGMENTS[si].get();
                if (!seg) { ++wrong_form; continue; }
                if (seg->STEP_SIZE != 0.0 || !seg->ATTITUDE_DATA.empty() ||
                    seg->ATTITUDE_DATA_LINES.empty()) {
                    ++wrong_form;
                }
                lines_total += seg->ATTITUDE_DATA_LINES.size();
            }
            result(sfmt("record-verbose-form-violations.%s", f.id), sfmt("%zu", wrong_form), "0",
                   wrong_form == 0);
            result(sfmt("record-attitude-data-lines.%s", f.id), sfmt("%zu", lines_total),
                   sfmt("%zu", view.segments.size() ? (view.segments[0].record_count() +
                        (view.segments.size() > 1 ? view.segments[1].record_count() : 0)) : 0),
                   lines_total == (view.segments.size()
                                       ? (view.segments[0].record_count() +
                                          (view.segments.size() > 1
                                               ? view.segments[1].record_count()
                                               : 0))
                                       : 0));

            ::flatbuffers::FlatBufferBuilder fbb(4096);
            fbb.Finish(::CreateAEM(fbb, &rec), ::AEMIdentifier());
            identifier_ok = ::AEMBufferHasIdentifier(fbb.GetBufferPointer());
            ::flatbuffers::Verifier verifier(fbb.GetBufferPointer(), fbb.GetSize());
            buffer_ok = ::VerifyAEMBuffer(verifier);
            ::GetAEM(fbb.GetBufferPointer())->UnPackTo(&AEM_BACK[i]);
            RECORD_JSON[i] = ccsds::aem::to_json(AEM_BACK[i]);

            ccsds::aem::ProjectionReport back_rep;
            const ccsds::aem::ProjectionStatus bs =
                ccsds::aem::from_record(AEM_BACK[i], &AEM_VIEW_BACK[i], &back_rep);
            result(sfmt("record-from-record-status.%s", f.id),
                   ccsds::aem::projection_status_name(bs), "ok",
                   bs == ccsds::aem::ProjectionStatus::Ok);
            have_rebuilt = bs == ccsds::aem::ProjectionStatus::Ok &&
                           ccsds::aem::to_document(AEM_VIEW_BACK[i], &rebuilt) ==
                               ccsds::aem::Status::Ok;
        } else {
            const size_t t = i - 2;
            ccsds::tdm::Message view;
            ccsds::tdm::Fault fault;
            const ccsds::tdm::Status vs = ccsds::tdm::from_document(L.parsed, &view, &fault);
            result(sfmt("record-view-status.%s", f.id), ccsds::tdm::status_name(vs), "ok",
                   vs == ccsds::tdm::Status::Ok);

            ::TDMT rec;
            ccsds::tdm::ProjectionReport rep;
            const ccsds::tdm::ProjectionStatus ps = ccsds::tdm::to_record(view, &rec, &rep);
            result(sfmt("record-to-record-status.%s", f.id),
                   ccsds::tdm::projection_status_name(ps), "ok",
                   ps == ccsds::tdm::ProjectionStatus::Ok);
            losses = rep.losses;
            mapped = rep.mapped_keys;

            size_t observations_total = 0;
            size_t view_observations = 0;
            for (size_t si = 0; si < rec.SEGMENTS.size(); ++si) {
                if (rec.SEGMENTS[si]) observations_total += rec.SEGMENTS[si]->OBSERVATIONS.size();
            }
            for (size_t si = 0; si < view.segments.size(); ++si) {
                view_observations += view.segments[si].observation_count();
            }
            result(sfmt("record-observations.%s", f.id), sfmt("%zu", observations_total),
                   sfmt("%zu", view_observations), observations_total == view_observations);

            ::flatbuffers::FlatBufferBuilder fbb(4096);
            fbb.Finish(::CreateTDM(fbb, &rec), ::TDMIdentifier());
            identifier_ok = ::TDMBufferHasIdentifier(fbb.GetBufferPointer());
            ::flatbuffers::Verifier verifier(fbb.GetBufferPointer(), fbb.GetSize());
            buffer_ok = ::VerifyTDMBuffer(verifier);

            /* ABSENT, not empty. Read off the BUFFER rather than the object API,
             * because an empty object-API vector and an omitted field are the
             * same value there and only the buffer can tell them apart. A
             * ramp-free record is exactly a CCSDS-conformant TDM. */
            const ::TDM* root = ::GetTDM(fbb.GetBufferPointer());
            bool ramps_absent = root->TRANSMIT_RAMPS() == nullptr;
            if (root->SEGMENTS()) {
                for (::flatbuffers::uoffset_t si = 0; si < root->SEGMENTS()->size(); ++si) {
                    if (root->SEGMENTS()->Get(si)->TRANSMIT_RAMPS() != nullptr) {
                        ramps_absent = false;
                    }
                }
            }
            result(sfmt("record-transmit-ramps-absent.%s", f.id),
                   ramps_absent ? "absent" : "present", "absent", ramps_absent);

            root->UnPackTo(&TDM_BACK[t]);
            RECORD_JSON[i] = ccsds::tdm::to_json(TDM_BACK[t]);

            ccsds::tdm::ProjectionReport back_rep;
            const ccsds::tdm::ProjectionStatus bs =
                ccsds::tdm::from_record(TDM_BACK[t], &TDM_VIEW_BACK[t], &back_rep);
            result(sfmt("record-from-record-status.%s", f.id),
                   ccsds::tdm::projection_status_name(bs), "ok",
                   bs == ccsds::tdm::ProjectionStatus::Ok);
            have_rebuilt = bs == ccsds::tdm::ProjectionStatus::Ok &&
                           ccsds::tdm::to_document(TDM_VIEW_BACK[t], &rebuilt) ==
                               ccsds::tdm::Status::Ok;
        }

        result(sfmt("record-buffer-identifier.%s", f.id), identifier_ok ? "matched" : "wrong",
               is_aem ? "$AEM" : "$TDM", identifier_ok);
        result(sfmt("record-buffer-verifies.%s", f.id), buffer_ok ? "yes" : "no", "yes", buffer_ok);

        /* NOTHING IS LOST IN SILENCE. Every keyword occurrence in the header and
         * metadata blocks, and every comment line anywhere, is either mapped
         * into an IDL field or named in the loss report. Counting the file
         * independently is what makes that a measurement: a keyword the
         * projection maps but forgot to list in its roster would be counted
         * twice, and one listed but never mapped would be counted zero times. */
        const size_t occurrences = count_keyword_occurrences(L.parsed);
        result(sfmt("record-keyword-accounting.%s", f.id),
               sfmt("%zu mapped + %zu lost = %zu", mapped, losses.size(),
                    mapped + losses.size()),
               sfmt("%zu", occurrences), mapped + losses.size() == occurrences);
        result(sfmt("record-declared-losses.%s", f.id),
               sfmt("%zu (%s)", losses.size(), loss_summary(losses).c_str()),
               sfmt("%zu", EXPECTED_LOSSES[i]), losses.size() == EXPECTED_LOSSES[i]);

        if (!have_rebuilt) {
            result(sfmt("record-roundtrip-differences.%s", f.id), "projection-failed", "0", false);
            continue;
        }

        std::string emitted;
        kvn::serialize(rebuilt, &emitted);
        kvn::Document reparsed;
        const kvn::Status ks = kvn::parse(emitted.data(), emitted.size(), &reparsed);
        result(sfmt("record-roundtrip-parse-status.%s", f.id), kvn::status_name(ks), "ok",
               ks == kvn::Status::Ok);

        size_t applied = 0;
        const kvn::Document reference = apply_losses(L.parsed, losses, &applied);
        result(sfmt("record-losses-applied.%s", f.id), sfmt("%zu", applied),
               sfmt("%zu", losses.size()), applied == losses.size());

        const Diff d = compare_documents(reference, reparsed, true);
        result(sfmt("record-roundtrip-fields-compared.%s", f.id), sfmt("%zu", d.compared), ">0",
               d.compared > 0);
        result(sfmt("record-roundtrip-differences.%s", f.id),
               d.differences ? sfmt("%zu (%s)", d.differences, d.first.c_str()) : std::string("0"),
               "0", d.differences == 0);
    }

    /* ------------------------------------------------------------------ */
    /* 9. Sampled attitude through the record                              */
    /* ------------------------------------------------------------------ */

    {
        double worst = 0.0;
        size_t compared = 0;
        for (size_t i = 0; i < 2; ++i) {
            ccsds::aem::Message before;
            ccsds::aem::Fault fault;
            if (ccsds::aem::from_document(LOADED[i].parsed, &before, &fault) !=
                ccsds::aem::Status::Ok) {
                continue;
            }
            const ccsds::aem::Message& after = AEM_VIEW_BACK[i];
            for (size_t s = 0; s < before.segments.size() && s < after.segments.size(); ++s) {
                size_t bi = 0;
                for (size_t r = 0; r < before.segments[s].rows.size(); ++r) {
                    if (before.segments[s].rows[r].is_standalone_comment) continue;
                    if (bi >= after.segments[s].rows.size()) break;
                    const ccsds::aem::Row& rb = before.segments[s].rows[r];
                    const ccsds::aem::Row& ra = after.segments[s].rows[bi];
                    ++bi;
                    for (size_t c = 0; c < rb.components.size() && c < ra.components.size(); ++c) {
                        double vb = 0.0;
                        double va = 0.0;
                        if (!rb.value(c, &vb) || !ra.value(c, &va)) continue;
                        ++compared;
                        const double rel = relative_difference(vb, va);
                        if (rel > worst) worst = rel;
                    }
                }
            }
        }
        result("record-attitude-values-compared", sfmt("%zu", compared), "64", compared == 64);
        result("record-attitude-max-relative-error", sfmt("%.3e", worst), "<=1e-12",
               worst <= 1e-12);
    }

    /* ------------------------------------------------------------------ */
    /* 10. Observation epochs through the record                           */
    /* ------------------------------------------------------------------ */

    /*
     * The bound is 1e-9 s and it is met two different ways, because the corpus
     * contains two different kinds of segment. Where the observation epochs ARE
     * uniform (Figure E-18: one per second), the compact rule
     * OBSERVATION_START_TIME + i * OBSERVATION_STEP_SIZE reproduces every stored
     * epoch and the residual is reported. Where they are NOT (Figure E-16's
     * three observables sharing three epochs, Figure E-17's backwards RCS), no
     * such grid exists at all — so what is asserted there is that the
     * per-observation EPOCH came back VERBATIM, character for character, which
     * is a stronger statement than any tolerance.
     */
    for (size_t t = 0; t < 3; ++t) {
        const Fixture& f = FIXTURES[t + 2];
        const std::vector<ScannedObservation> scanned = scan_observations(LOADED[t + 2].text);
        std::vector<std::string> from_record_epochs;
        for (size_t s = 0; s < TDM_VIEW_BACK[t].segments.size(); ++s) {
            const ccsds::tdm::Segment& seg = TDM_VIEW_BACK[t].segments[s];
            for (size_t o = 0; o < seg.observations.size(); ++o) {
                if (!seg.observations[o].is_standalone_comment) {
                    from_record_epochs.push_back(seg.observations[o].epoch);
                }
            }
        }
        size_t mismatches = (scanned.size() == from_record_epochs.size()) ? 0 : 1;
        for (size_t k = 0; k < scanned.size() && k < from_record_epochs.size(); ++k) {
            if (scanned[k].epoch != from_record_epochs[k]) ++mismatches;
        }
        result(sfmt("record-observation-epochs-verbatim.%s", f.id), sfmt("%zu", mismatches), "0",
               mismatches == 0);

        for (size_t s = 0; s < TDM_VIEW_BACK[t].segments.size(); ++s) {
            std::vector<std::string> epochs;
            const ccsds::tdm::Segment& seg = TDM_VIEW_BACK[t].segments[s];
            for (size_t o = 0; o < seg.observations.size(); ++o) {
                if (!seg.observations[o].is_standalone_comment) {
                    epochs.push_back(seg.observations[o].epoch);
                }
            }
            const GridFit fit = fit_uniform_grid(epochs);
            if (fit.uniform) {
                result(sfmt("record-uniform-grid-max-error.%s.seg%zu", f.id, s),
                       sfmt("%.3e", fit.max_error), "<=1e-09 s", fit.max_error <= 1e-9);
                result(sfmt("record-uniform-grid-step.%s.seg%zu", f.id, s),
                       sfmt("%.9f", fit.step), ">0", fit.step > 0.0);
            } else {
                /* No grid exists. The claim here is the verbatim one above, and
                 * this records HOW FAR from a grid the segment is so that a
                 * future producer cannot quietly turn it into one. */
                result(sfmt("record-no-uniform-grid.%s.seg%zu", f.id, s),
                       sfmt("off-grid by %.4f s over %zu observations", fit.max_error, fit.count),
                       ">1e-09 s", fit.max_error > 1e-9);
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* 11. Transmit ramps: carried when present, absent when not           */
    /* ------------------------------------------------------------------ */

    {
        /* Figure E-17's record, with a ramp table added. The KVN body has no
         * ramp in it and cannot: TRANSMIT_RAMPS is an SDS extension with no
         * CCSDS keyword, so what is measured is that the ramps survive the
         * record round trip EXACTLY and that not one byte of them reaches the
         * emitted message. */
        ::TDMT ramped(TDM_BACK[1]);
        if (!ramped.SEGMENTS.empty() && ramped.SEGMENTS[0]) {
            std::unique_ptr< ::TDMTransmitRampT> a(new ::TDMTransmitRampT());
            a->START_TIME = "2011-05-11T10:26:00.0000";
            a->END_TIME = "2011-05-11T10:26:33.5000";
            a->REFERENCE_TIME = "2011-05-11T10:26:00.0000";
            a->FREQUENCY_HZ = 7176219176.5;
            a->FREQUENCY_RATE_HZ_PER_S = -32.125;
            a->TRANSMITTING_STATION_ID = "CAMRA";
            a->TRANSMIT_BAND = "S";
            std::unique_ptr< ::TDMTransmitRampT> b(new ::TDMTransmitRampT());
            b->START_TIME = "2011-05-11T10:26:33.5000";
            b->END_TIME = "2011-05-11T10:27:00.0000";
            b->REFERENCE_TIME = "2011-05-11T10:26:33.5000";
            b->FREQUENCY_HZ = 7176218100.25;
            b->FREQUENCY_RATE_HZ_PER_S = 0.0;
            b->TRANSMITTING_STATION_ID = "CAMRA";
            b->TRANSMIT_BAND = "S";
            ramped.SEGMENTS[0]->TRANSMIT_RAMPS.push_back(std::move(a));
            ramped.SEGMENTS[0]->TRANSMIT_RAMPS.push_back(std::move(b));
        }

        ::flatbuffers::FlatBufferBuilder fbb(4096);
        fbb.Finish(::CreateTDM(fbb, &ramped), ::TDMIdentifier());
        ::flatbuffers::Verifier verifier(fbb.GetBufferPointer(), fbb.GetSize());
        result("ramp-record-verifies", ::VerifyTDMBuffer(verifier) ? "yes" : "no", "yes",
               ::VerifyTDMBuffer(verifier));
        const ::TDM* root = ::GetTDM(fbb.GetBufferPointer());
        const bool present = root->SEGMENTS() && root->SEGMENTS()->size() > 0 &&
                             root->SEGMENTS()->Get(0)->TRANSMIT_RAMPS() != nullptr &&
                             root->SEGMENTS()->Get(0)->TRANSMIT_RAMPS()->size() == 2;
        result("ramp-record-ramps-present", present ? "2" : "missing", "2", present);

        ::TDMT ramped_back;
        root->UnPackTo(&ramped_back);
        size_t field_diffs = 0;
        if (!ramped_back.SEGMENTS.empty() && ramped_back.SEGMENTS[0] &&
            ramped_back.SEGMENTS[0]->TRANSMIT_RAMPS.size() == 2 && !ramped.SEGMENTS.empty()) {
            for (size_t r = 0; r < 2; ++r) {
                const ::TDMTransmitRampT& x = *ramped.SEGMENTS[0]->TRANSMIT_RAMPS[r];
                const ::TDMTransmitRampT& y = *ramped_back.SEGMENTS[0]->TRANSMIT_RAMPS[r];
                if (x.START_TIME != y.START_TIME) ++field_diffs;
                if (x.END_TIME != y.END_TIME) ++field_diffs;
                if (x.REFERENCE_TIME != y.REFERENCE_TIME) ++field_diffs;
                if (x.FREQUENCY_HZ != y.FREQUENCY_HZ) ++field_diffs;
                if (x.FREQUENCY_RATE_HZ_PER_S != y.FREQUENCY_RATE_HZ_PER_S) ++field_diffs;
                if (x.TRANSMITTING_STATION_ID != y.TRANSMITTING_STATION_ID) ++field_diffs;
                if (x.TRANSMIT_BAND != y.TRANSMIT_BAND) ++field_diffs;
            }
        } else {
            field_diffs = 14;
        }
        result("ramp-field-differences", sfmt("%zu", field_diffs), "0 of 14", field_diffs == 0);

        /* A ramp on the record must not perturb the message. The ramp-free
         * document and the ramped one are compared field for field, and the
         * emitted text is scanned for the ramp's own keywords — the second
         * catches an emitter that put them somewhere the document model does
         * not model. */
        ccsds::tdm::Message plain_view;
        ccsds::tdm::Message ramped_view;
        const bool read_ok =
            ccsds::tdm::from_record(TDM_BACK[1], &plain_view) ==
                ccsds::tdm::ProjectionStatus::Ok &&
            ccsds::tdm::from_record(ramped_back, &ramped_view) ==
                ccsds::tdm::ProjectionStatus::Ok;
        result("ramp-record-reads", read_ok ? "ok" : "failed", "ok", read_ok);
        if (read_ok) {
            kvn::Document plain_doc;
            kvn::Document ramped_doc;
            ccsds::tdm::to_document(plain_view, &plain_doc);
            ccsds::tdm::to_document(ramped_view, &ramped_doc);
            const Diff d = compare_documents(plain_doc, ramped_doc, true);
            result("ramp-message-differences",
                   d.differences ? sfmt("%zu (%s)", d.differences, d.first.c_str())
                                 : std::string("0"),
                   "0", d.differences == 0);
            std::string emitted;
            kvn::serialize(ramped_doc, &emitted);
            const char* forbidden[] = {"TRANSMIT_RAMPS", "FREQUENCY_HZ",
                                       "FREQUENCY_RATE_HZ_PER_S", "REFERENCE_TIME",
                                       "TRANSMITTING_STATION_ID", "SIGNAL_TO_NOISE",
                                       "SPECTRAL_MAX",           "DOPPLER_NOISE_HZ"};
            size_t leaked = 0;
            std::string leaked_names;
            for (size_t k = 0; k < sizeof(forbidden) / sizeof(forbidden[0]); ++k) {
                if (emitted.find(forbidden[k]) != std::string::npos) {
                    ++leaked;
                    if (!leaked_names.empty()) leaked_names += ",";
                    leaked_names += forbidden[k];
                }
            }
            result("ramp-keywords-in-kvn-body",
                   leaked ? sfmt("%zu (%s)", leaked, leaked_names.c_str()) : std::string("0"), "0",
                   leaked == 0);
        }
    }

    /* ------------------------------------------------------------------ */
    /* 12. Forms this projection refuses rather than guesses               */
    /* ------------------------------------------------------------------ */

    {
        /* The compact $AEM form stores no epoch per state. Reconstructing them
         * is START_TIME + i*STEP_SIZE on a declared TIME_SYSTEM, which needs the
         * leap-second table foundation/time owns. */
        ::AEMT compact;
        compact.CCSDS_AEM_VERS = "2.0";
        {
            std::unique_ptr< ::AEMSegmentT> seg(new ::AEMSegmentT());
            seg->ATTITUDE_TYPE = "QUATERNION";
            seg->START_TIME = "2006-090T05:00:00.071";
            seg->STEP_SIZE = 0.125;
            seg->ATTITUDE_COMPONENTS = 4;
            seg->ATTITUDE_DATA.push_back(1.0);
            seg->ATTITUDE_DATA.push_back(0.0);
            seg->ATTITUDE_DATA.push_back(0.0);
            seg->ATTITUDE_DATA.push_back(0.0);
            compact.SEGMENTS.push_back(std::move(seg));
        }
        ccsds::aem::Message m;
        const ccsds::aem::ProjectionStatus st = ccsds::aem::from_record(compact, &m);
        result("record-compact-aem-refused", ccsds::aem::projection_status_name(st),
               "compact-form-needs-time-math",
               st == ccsds::aem::ProjectionStatus::CompactFormNeedsTimeMath);
        result("record-compact-aem-code", sfmt("%d", static_cast<int>(st)), "-55",
               static_cast<int>(st) == -55);
        result("record-compact-aem-yields-no-message", sfmt("%zu", m.segments.size()), "0",
               m.segments.empty());

        /* The IDL forbids populating both forms. */
        std::unique_ptr< ::attitudeDataLineT> line(new ::attitudeDataLineT());
        line->EPOCH = "2006-090T05:00:00.071";
        line->Q1 = 1.0;
        compact.SEGMENTS[0]->ATTITUDE_DATA_LINES.push_back(std::move(line));
        const ccsds::aem::ProjectionStatus both = ccsds::aem::from_record(compact, &m);
        result("record-both-aem-forms-refused", ccsds::aem::projection_status_name(both),
               "both-forms-populated",
               both == ccsds::aem::ProjectionStatus::BothFormsPopulated);
    }

    {
        /* A $TDM whose data lives only in the legacy parallel arrays. Their
         * epochs exist nowhere in the record. */
        ::TDMT gridded;
        gridded.CCSDS_TDM_VERS = "2.0";
        gridded.OBSERVATION_START_TIME = "2011-05-11T10:26:33.2613";
        gridded.OBSERVATION_STEP_SIZE = 0.5;
        gridded.CLOCK_BIAS.push_back(1.0);
        gridded.CLOCK_BIAS.push_back(2.0);
        ccsds::tdm::Message m;
        const ccsds::tdm::ProjectionStatus st = ccsds::tdm::from_record(gridded, &m);
        result("record-gridded-tdm-refused", ccsds::tdm::projection_status_name(st),
               "uniform-grid-needs-time-math",
               st == ccsds::tdm::ProjectionStatus::UniformGridNeedsTimeMath);
        result("record-gridded-tdm-code", sfmt("%d", static_cast<int>(st)), "-62",
               static_cast<int>(st) == -62);
    }

    {
        /* A malformed record is a status code, never a NaN handed downstream. */
        ::AEMT poisoned(AEM_BACK[0]);
        if (!poisoned.SEGMENTS.empty() && poisoned.SEGMENTS[0] &&
            !poisoned.SEGMENTS[0]->ATTITUDE_DATA_LINES.empty()) {
            poisoned.SEGMENTS[0]->ATTITUDE_DATA_LINES[0]->Q1 =
                std::numeric_limits<double>::quiet_NaN();
        }
        ccsds::aem::Message m;
        const ccsds::aem::ProjectionStatus st = ccsds::aem::from_record(poisoned, &m);
        result("record-nan-attitude-refused", ccsds::aem::projection_status_name(st),
               "non-finite-value", st == ccsds::aem::ProjectionStatus::NonFiniteValue);
        result("record-nan-yields-no-message", sfmt("%zu", m.segments.size()), "0",
               m.segments.empty());

        ::TDMT poisoned_tdm(TDM_BACK[1]);
        if (!poisoned_tdm.SEGMENTS.empty() && poisoned_tdm.SEGMENTS[0] &&
            !poisoned_tdm.SEGMENTS[0]->OBSERVATIONS.empty()) {
            poisoned_tdm.SEGMENTS[0]->OBSERVATIONS[0]->VALUE =
                std::numeric_limits<double>::infinity();
        }
        ccsds::tdm::Message tm;
        const ccsds::tdm::ProjectionStatus ts = ccsds::tdm::from_record(poisoned_tdm, &tm);
        result("record-infinite-observation-refused", ccsds::tdm::projection_status_name(ts),
               "non-finite-value", ts == ccsds::tdm::ProjectionStatus::NonFiniteValue);
    }

    {
        /* The IDL's single-segment root form. This projection never WRITES it —
         * one code path, exercised by every fixture — but another producer may,
         * and refusing a form the schema defines would be this reader being
         * stricter than the standard it implements. */
        ::TDMT rootform;
        rootform.CCSDS_TDM_VERS = "2.0";
        rootform.CREATION_DATE = "2011-05-12T00:00:00.000";
        rootform.ORIGINATOR = "ESA";
        rootform.TIME_SYSTEM = "UTC";
        rootform.PARTICIPANT_1 = "CAMRA";
        rootform.PARTICIPANT_2 = "CRYOSAT";
        rootform.MODE = "SEQUENTIAL";
        rootform.PATH = "1,2,1";
        rootform.RANGE_UNITS = "km";
        rootform.ANGLE_TYPE = "AZEL";
        rootform.DATA_START = "DATA_START";
        rootform.DATA_STOP = "DATA_STOP";
        if (!TDM_BACK[1].SEGMENTS.empty() && TDM_BACK[1].SEGMENTS[0]) {
            const ::TDMSegmentT& src = *TDM_BACK[1].SEGMENTS[0];
            for (size_t o = 0; o < src.OBSERVATIONS.size(); ++o) {
                rootform.OBSERVATIONS.push_back(
                    std::unique_ptr< ::TDMObservationT>(
                        new ::TDMObservationT(*src.OBSERVATIONS[o])));
            }
        }
        ccsds::tdm::Message m;
        const ccsds::tdm::ProjectionStatus st = ccsds::tdm::from_record(rootform, &m);
        result("record-root-observations-form-status", ccsds::tdm::projection_status_name(st), "ok",
               st == ccsds::tdm::ProjectionStatus::Ok);
        result("record-root-observations-form-segments", sfmt("%zu", m.segments.size()), "1",
               m.segments.size() == 1);
        const size_t n = m.segments.empty() ? 0 : m.segments[0].observation_count();
        result("record-root-observations-form-observations", sfmt("%zu", n), "15", n == 15);
        const char* p1 = m.segments.empty() ? nullptr : m.segments[0].participant(1);
        result("record-root-observations-form-participant-1", p1 ? p1 : "(absent)", "CAMRA",
               p1 && std::strcmp(p1, "CAMRA") == 0);
    }

    /* ------------------------------------------------------------------ */
    /* 13. Canonical JSON                                                  */
    /* ------------------------------------------------------------------ */

    /*
     * Every key below was produced by stringizing the same identifier the field
     * access compiles against, so no key in this output was ever typed by hand.
     * The wrapper cross-checks the whole key set against
     * node_modules/spacedatastandards.org/schema/{AEM,TDM}/main.fbs, parsed
     * there rather than restated here — a schema rename fails the suite instead
     * of drifting.
     */
    for (size_t i = 0; i < FIXTURE_COUNT; ++i) {
        const Fixture& f = FIXTURES[i];
        result(sfmt("record-json-emitted.%s", f.id), sfmt("%zu bytes", RECORD_JSON[i].size()),
               ">2", RECORD_JSON[i].size() > 2);
        std::printf("JSON %s %s %s\n", f.id, f.type, RECORD_JSON[i].c_str());
    }
    {
        /* A ramped record too, so the $TDM ramp table's own keys are checked. */
        ::TDMT ramped(TDM_BACK[1]);
        if (!ramped.SEGMENTS.empty() && ramped.SEGMENTS[0]) {
            std::unique_ptr< ::TDMTransmitRampT> a(new ::TDMTransmitRampT());
            a->START_TIME = "2011-05-11T10:26:00.0000";
            a->FREQUENCY_HZ = 7176219176.5;
            a->TRANSMIT_BAND = "S";
            ramped.SEGMENTS[0]->TRANSMIT_RAMPS.push_back(std::move(a));
        }
        const std::string json = ccsds::tdm::to_json(ramped);
        result("record-json-emitted.tdm-ramped", sfmt("%zu bytes", json.size()), ">2",
               json.size() > 2);
        std::printf("JSON tdm-ramped TDM %s\n", json.c_str());
    }

    std::printf("\n%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
