// Tile packs, the node's IPFS and the store, through sdm_piv host calls (typedHostcall.hpp).
//
// A pack is 16 consecutive tiles of one tile row (fewer at the row's end), in the format the engine's
// readBodyTilePack reads ("SDNTILE1"): u32 version 1, u32 tile count, u8 maximum level, u8 channels, u16 0; per tile
// u8 level, u8 0, u16 x, u16 y, u16 0, u32 offset, u32 length (offsets from the pack start); then the JPEG tiles.
// FILE_NAME imagery/<NAIF id>/<source key>/<level>/<y>_<x / 16>.pack. Each pack is added to the node's IPFS and
// announced as one $PNM; a band's $PNM records are filed as one attributed batch.
#pragma once
#include <chrono>
#include <cstdint>
#include <string>
#include <vector>

namespace bit {
namespace R = sdn::runtime;

constexpr int kPackTiles = 16;

inline void put16(std::vector<uint8_t>& o, uint16_t v) { o.push_back(uint8_t(v)); o.push_back(uint8_t(v >> 8)); }
inline void put32(std::vector<uint8_t>& o, uint32_t v) { for (int i = 0; i < 4; i++) o.push_back(uint8_t(v >> (8 * i))); }

struct PackTile {
    uint16_t x;
    std::vector<uint8_t> jpeg;
};

inline std::vector<uint8_t> pack(int level, uint16_t y, int max_level, const std::vector<PackTile>& tiles) {
    std::vector<uint8_t> out;
    const char magic[8] = {'S', 'D', 'N', 'T', 'I', 'L', 'E', '1'};
    out.insert(out.end(), magic, magic + 8);
    put32(out, 1);
    put32(out, uint32_t(tiles.size()));
    out.push_back(uint8_t(max_level));
    out.push_back(1);
    put16(out, 0);
    uint32_t offset = uint32_t(out.size() + tiles.size() * 16);
    for (const PackTile& t : tiles) {
        out.push_back(uint8_t(level)); out.push_back(0); put16(out, t.x); put16(out, y); put16(out, 0);
        put32(out, offset); put32(out, uint32_t(t.jpeg.size()));
        offset += uint32_t(t.jpeg.size());
    }
    for (const PackTile& t : tiles) out.insert(out.end(), t.jpeg.begin(), t.jpeg.end());
    return out;
}

inline bool cid_token(const std::string& s) {
    if (s.empty() || s.size() > 128) return false;
    for (const char c : s)
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) return false;
    return true;
}

// The CID of `bytes` added to the node's IPFS; empty and `why` on failure.
inline std::string ipfs_add(const std::vector<uint8_t>& bytes, std::string& why) {
    R::Aligned::IpfsParams params{};
    for (int attempt = 0; attempt < 3; ++attempt) {
        const auto response = sdm_piv::call("ipfs.add", "IpfsParams", params, {sdm_piv::raw("data", bytes.data(), bytes.size())});
        const auto* result = response.ok() ? response.result<R::Aligned::IpfsResult>() : nullptr;
        const std::string cid = result ? result->CID.str() : std::string();
        if (cid_token(cid)) return cid;
        why = "ipfs.add (" + std::to_string(bytes.size()) + " B): " + (response.ok() ? std::string("no CID") : response.error_message());
    }
    return {};
}

// One size-prefixed $PNM: the published file by its CID.
inline void append_pnm(std::vector<uint8_t>& out, const std::string& provider, const std::string& source,
                       const std::string& name, const std::string& cid, const std::string& at) {
    flatbuffers::FlatBufferBuilder b(512);
    const auto address = b.CreateString("/ipfs/" + cid), when = b.CreateString(at), cid_off = b.CreateString(cid),
               name_off = b.CreateString(name), id_off = b.CreateString(provider + ":" + source + ":" + name + ":" + cid);
    PNMBuilder pb(b);
    pb.add_MULTIFORMAT_ADDRESS(address);
    pb.add_PUBLISH_TIMESTAMP(when);
    pb.add_CID(cid_off);
    pb.add_FILE_NAME(name_off);
    pb.add_FILE_ID(id_off);
    FinishSizePrefixedPNMBuffer(b, pb.Finish());
    out.insert(out.end(), b.GetBufferPointer(), b.GetBufferPointer() + b.GetSize());
}

struct Lane {
    std::string provider, source, batch, url, license, license_url, citation, parser_version, peer;
};

// One attributed batch of $PNM records, appended to the lane (RECONCILE None: a band is a part of the lane, never
// its whole set).
inline std::string ingest(const Lane& lane, const std::vector<uint8_t>& records, uint64_t& inserted) {
    R::Aligned::StorageIngestParams params{};
    const bool fits = sdm_piv::put(params.SCHEMA, "PNM") && sdm_piv::put(params.PROVIDER_ID, lane.provider) &&
                      sdm_piv::put(params.SOURCE_NAME, lane.source) && sdm_piv::put(params.BATCH_ID, lane.batch) &&
                      sdm_piv::put(params.SOURCE_URL, lane.url) && sdm_piv::put(params.SOURCE_PEER, lane.peer) &&
                      sdm_piv::put(params.LICENSE, lane.license) && sdm_piv::put(params.CITATION, lane.citation) &&
                      sdm_piv::put(params.LICENSE_URL, lane.license_url);
    if (!fits) return "The " + lane.source + " attribution does not fit its record.";
    params.set_has_SCHEMA(true); params.set_has_PROVIDER_ID(true); params.set_has_SOURCE_NAME(true);
    params.set_has_BATCH_ID(true); params.set_has_SOURCE_URL(true); params.set_has_SOURCE_PEER(true);
    params.set_has_LICENSE(true); params.set_has_CITATION(true); params.set_has_LICENSE_URL(true);
    params.RECONCILE = R::Aligned::reconcileKind_None;
    R::Aligned::Provenance provenance{};
    if (!(sdm_piv::put(provenance.SOURCE_URL, lane.url) && sdm_piv::put(provenance.PARSER, "body-imagery-tiles") &&
          sdm_piv::put(provenance.PARSER_VERSION, lane.parser_version) && sdm_piv::put(provenance.SOURCE_SHA256, lane.batch)))
        return "The provenance does not fit its record.";
    provenance.set_has_SOURCE_URL(true); provenance.set_has_PARSER(true); provenance.set_has_PARSER_VERSION(true);
    provenance.set_has_SOURCE_SHA256(true);
    provenance.RETRIEVED_MS = uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(
                                           std::chrono::system_clock::now().time_since_epoch()).count());
    const std::vector<sdm_piv::Frame> frames{
        {"params", reinterpret_cast<const uint8_t*>(&params), sizeof(params), "StorageIngestParams",
         uint32_t(sizeof(params)), uint16_t(alignof(R::Aligned::StorageIngestParams))},
        sdm_piv::raw("records", records.data(), records.size()), sdm_piv::list("provenance", "Provenance", &provenance, 1)};
    const auto response = sdm_piv::call_frames("storage.ingest_with_source", frames);
    const auto* result = response.ok() ? response.result<R::Aligned::StorageIngestResult>() : nullptr;
    if (!result) return "storage.ingest_with_source refused the " + lane.source + " batch: " + response.error_message();
    inserted = result->INSERTED;
    return {};
}

}  // namespace bit
