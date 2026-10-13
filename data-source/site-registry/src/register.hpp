// The compiled registers: build.mjs turns register/*.json into these tables,
// so the module reads its curated rows, reviewed facts and source terms as
// static data (no JSON is parsed at run time for them).
#pragma once
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace reg {
struct Source { const char *id, *name, *licenseClass, *licenseId, *attribution, *credit, *version, *recordUrl, *use, *data; };
struct Network { const char *code, *name; };
struct Class { const char *network, *qid, *kind; bool transitive; };
// position: "Wikidata" (the item's P625, read each run), "register" (the row's own coordinate, cited by
// positionUrl/positionTitle) or "approximate: <where>" (a stated approximation).
struct Curated { const char *name, *category, *kind, *cc, *wikidata; double lat, lon; const char *position, *positionUrl, *positionTitle; };
struct SpaceCode { const char *code, *name; };
// status/statusDate/statusUrl/statusTitle: a lifecycle the register states with its source, when Wikidata states none.
struct SpaceSite { const char *name, *ascii, *code; double lat, lon; const char *cc, *admin1, *wikidata, *status, *statusDate, *statusUrl, *statusTitle; };
struct Step { const char *status, *date; };
struct Fact { const char *qid, *source, *wiki, *title, *revision, *reviewedAt; size_t stepBegin, stepCount, unitBegin, unitCount; };
struct Duplicate { const char *keep, *drop; };
struct NotFacility { const char *qid; };
struct DismantlingReviewed { const char *qid, *recordId, *phrase; };
struct Regulator { const char *cc, *qid; };
struct Placemark { const char *geonameId, *name, *ascii, *code, *cc, *admin1; double lat, lon; const char *wikidata; bool unitItem; size_t gemBegin, gemCount; bool unitPlant; };
struct Country { const char *a2, *numeric, *qid, *name; };
struct Alias { const char *key, *value; };
struct Docket { const char *wikidata, *docket, *unit, *url, *checked; };
}  // namespace reg
