// The node's IPFS and store, through sdm_piv host calls (typedHostcall.hpp):
// ipfs.add / ipfs.cat / ipfs.pin_rm for tile payloads, and
// storage.ingest_with_source for the $SKT index records of a layer, as one
// attributed batch that retires the layer's previous batch (RECONCILE
// Current). The $SKT records themselves are built here too.
#pragma once
#include <chrono>
#include <string>
#include <vector>

namespace gaia_octree::publish {
namespace R = sdn::runtime;

inline bool cidToken(const std::string& s) {
  if (s.empty() || s.size() > 128) return false;
  for (const char c : s)
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) return false;
  return true;
}

// The CID of `bytes` added (and pinned) to the node's IPFS; empty and `why` on failure.
inline std::string add(const std::vector<uint8_t>& bytes, std::string& why) {
  R::Aligned::IpfsParams params{};
  for (int attempt = 0; attempt < 3; ++attempt) {
    const auto response = sdm_piv::call("ipfs.add", "IpfsParams", params, {sdm_piv::raw("data", bytes.data(), bytes.size())});
    const auto* result = response.ok() ? response.result<R::Aligned::IpfsResult>() : nullptr;
    const std::string cid = result ? result->CID.str() : std::string();
    if (cidToken(cid)) return cid;
    why = "ipfs.add (" + std::to_string(bytes.size()) + " B): " + (response.ok() ? std::string("no CID") : response.error_message());
  }
  return {};
}

inline std::vector<uint8_t> cat(const std::string& cid, std::string& why) {
  R::Aligned::IpfsParams params{};
  sdm_piv::put(params.CID, cid);
  params.set_has_CID(true);
  const auto response = sdm_piv::call("ipfs.cat", "IpfsParams", params);
  if (!response.ok()) { why = "ipfs.cat " + cid + ": " + response.error_message(); return {}; }
  const auto data = response.raw("data");
  return std::vector<uint8_t>(data.begin(), data.end());
}

inline void unpin(const std::string& cid) {
  R::Aligned::IpfsParams params{};
  sdm_piv::put(params.CID, cid);
  params.set_has_CID(true);
  sdm_piv::call("ipfs.pin_rm", "IpfsParams", params);
}

struct Lane {
  std::string source, batch, url, license, licenseUrl, citation, parserVersion;
};

// One attributed batch of `schema` records; RECONCILE Current retires the lane's previous batch.
inline std::string ingest(const char* schema, const char* provider, const Lane& lane, const std::string& peer,
                          const std::vector<uint8_t>& records, uint64_t& inserted) {
  R::Aligned::StorageIngestParams params{};
  const bool fits = sdm_piv::put(params.SCHEMA, schema) && sdm_piv::put(params.PROVIDER_ID, provider) &&
                    sdm_piv::put(params.SOURCE_NAME, lane.source) && sdm_piv::put(params.BATCH_ID, lane.batch) &&
                    sdm_piv::put(params.SOURCE_URL, lane.url) && sdm_piv::put(params.SOURCE_PEER, peer) &&
                    sdm_piv::put(params.LICENSE, lane.license) && sdm_piv::put(params.CITATION, lane.citation) &&
                    sdm_piv::put(params.LICENSE_URL, lane.licenseUrl);
  if (!fits) return "The " + lane.source + " attribution does not fit its record.";
  params.set_has_SCHEMA(true); params.set_has_PROVIDER_ID(true); params.set_has_SOURCE_NAME(true); params.set_has_BATCH_ID(true);
  params.set_has_SOURCE_URL(true); params.set_has_SOURCE_PEER(true); params.set_has_LICENSE(true); params.set_has_CITATION(true);
  params.set_has_LICENSE_URL(true);
  params.RECONCILE = R::Aligned::reconcileKind_Current;
  R::Aligned::Provenance provenance{};
  if (!(sdm_piv::put(provenance.SOURCE_URL, lane.url) && sdm_piv::put(provenance.PARSER, "gaia-octree") &&
        sdm_piv::put(provenance.PARSER_VERSION, lane.parserVersion) && sdm_piv::put(provenance.SOURCE_SHA256, lane.batch)))
    return "The provenance does not fit its record.";
  provenance.set_has_SOURCE_URL(true); provenance.set_has_PARSER(true); provenance.set_has_PARSER_VERSION(true); provenance.set_has_SOURCE_SHA256(true);
  provenance.RETRIEVED_MS = uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
  const std::vector<sdm_piv::Frame> frames{
      {"params", reinterpret_cast<const uint8_t*>(&params), sizeof(params), "StorageIngestParams", uint32_t(sizeof(params)),
       uint16_t(alignof(R::Aligned::StorageIngestParams))},
      sdm_piv::raw("records", records.data(), records.size()), sdm_piv::list("provenance", "Provenance", &provenance, 1)};
  const auto response = sdm_piv::call_frames("storage.ingest_with_source", frames);
  const auto* result = response.ok() ? response.result<R::Aligned::StorageIngestResult>() : nullptr;
  if (!result) return "storage.ingest_with_source refused the " + lane.source + " batch: " + response.error_message();
  inserted = result->INSERTED;
  return {};
}

// What one $SKT index record states beyond the layer's common fields.
struct Tile {
  bool octree = false;
  uint8_t order = 0, level = 0, maxOrder = 255, childMask = 0;
  uint64_t pixel = 0, key = 0;
  double cx = NAN, cy = NAN, cz = NAN, half = NAN;
  uint32_t points = 0;
  float magBrightest = NAN, magLimit = NAN, absBrightest = NAN, absFaintest = NAN;
  std::string payloadCid, rowsCid;
  uint64_t payloadBytes = 0;
};

struct Layer {
  std::string id, peer, producedAt, version, citation, licenseUrl;
  std::vector<std::string> sources;
};

inline void appendTile(const Layer& layer, const Tile& t, std::vector<uint8_t>& out) {
  flatbuffers::FlatBufferBuilder b(1024);
  const auto layerId = b.CreateString(layer.id);
  const auto band = b.CreateString("G"), blue = b.CreateString("BP"), red = b.CreateString("RP");
  const auto rows = t.rowsCid.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(t.rowsCid);
  const auto payload = t.payloadCid.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(t.payloadCid);
  std::vector<flatbuffers::Offset<flatbuffers::String>> names;
  for (const auto& s : layer.sources) names.push_back(b.CreateString(s));
  const auto sources = b.CreateVector(names);
  const auto peer = b.CreateString(layer.peer), version = b.CreateString(layer.version), at = b.CreateString(layer.producedAt);
  const auto citation = b.CreateString(layer.citation), license = b.CreateString(layer.licenseUrl);
  SKTBuilder r(b);
  r.add_LAYER_ID(layerId);
  r.add_FRAME(sktCelestialFrame::ICRS);
  r.add_PAYLOAD_KIND(sktPayloadKind::POINT_SOURCES);
  r.add_REFINE(sktRefinement::ADD);
  r.add_SPECTRAL_REGIME(phbSpectralRegime::VISIBLE);
  r.add_BAND_ID(band);
  r.add_MAGNITUDE_SYSTEM(phbMagnitudeSystem::VEGA);
  r.add_PLACE(sktPlaceKind::CATALOG);
  r.add_EPOCH(2016.0);
  r.add_POINT_COUNT(t.points);
  r.add_MAG_BRIGHTEST(t.magBrightest);
  r.add_MAG_LIMIT(t.magLimit);
  r.add_COLOR_ENCODING(sktColorEncoding::COLOR_INDEX);
  r.add_COLOR_BLUE_BAND_ID(blue);
  r.add_COLOR_RED_BAND_ID(red);
  if (!t.rowsCid.empty()) r.add_ROW_COLLECTION_CID(rows);
  if (!t.payloadCid.empty()) { r.add_PAYLOAD_CID(payload); r.add_PAYLOAD_BYTES(t.payloadBytes); }
  r.add_SOURCE_NAMES(sources);
  r.add_PRODUCER_PEER_ID(peer);
  r.add_PRODUCER_VERSION(version);
  r.add_PRODUCED_AT(at);
  r.add_CITATION(citation);
  r.add_LICENSE_URL(license);
  r.add_MAX_ORDER(t.maxOrder);
  r.add_CHILD_MASK(t.childMask);
  if (t.octree) {
    r.add_PARTITION(sktPartitionScheme::OCTREE_HELIO_ICRS);
    r.add_OCTREE_LEVEL(t.level);
    r.add_OCTREE_KEY(t.key);
    r.add_CENTER_X_PC(t.cx); r.add_CENTER_Y_PC(t.cy); r.add_CENTER_Z_PC(t.cz);
    r.add_HALF_SIZE_PC(t.half);
    r.add_ABS_MAG_BRIGHTEST(t.absBrightest);
    r.add_ABS_MAG_FAINTEST(t.absFaintest);
  } else {
    r.add_PARTITION(sktPartitionScheme::HEALPIX);
    r.add_ORDER(t.order);
    r.add_PIXEL(t.pixel);
  }
  FinishSizePrefixedSKTBuffer(b, r.Finish());
  out.insert(out.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

}  // namespace gaia_octree::publish
