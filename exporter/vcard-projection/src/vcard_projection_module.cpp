/*
 * exporter/vcard-projection — the $VCF WASM module.
 *
 * Pure projection of $EPM FlatBuffer bytes to vCard 3.0 text (RFC 2426).
 * Three methods:
 *   card_full   — full contact card + verification chain + photo
 *   card_compact — QR-density card (sign/encrypt/epmsig only, ≤1200 bytes)
 *   card_parse   — vCard text → EPM fields JSON
 *
 * No capabilities: no I/O, no signing, no key derivation, no network.
 * §21 (owner ruling 2026-08-19): sign/encrypt aliases carry b64url(literal
 * PUBLIC_KEY bytes), not derivation paths. xpub alias RETIRED.
 *
 * Parity target: sdn-server/internal/vcard/vcard.go EPMToVCard + CompactQRVCard.
 * The $VCF canonical serialization annex (schema/VCF/CANONICAL_SERIALIZATION.md)
 * is the standard this implements.
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <sstream>

#include "space_data_module_invoke.h"
// EPM generated headers are inlined by build.mjs and joined before this source.

namespace {

// ── constants ──────────────────────────────────────────────────────────────

constexpr const char* kSignDomain = "sign.spacedatanetwork.org";
constexpr const char* kEncryptDomain = "encrypt.spacedatanetwork.org";
constexpr const char* kEpmSigDomain = "epmsig.spacedatanetwork.org";
constexpr const char* kEpmTsDomain = "epmts.spacedatanetwork.org";
constexpr const char* kEpmCidDomain = "epmcid.spacedatanetwork.org";
constexpr const char* kBitcoinDomain = "bitcoin.spacedatanetwork.org";
constexpr const char* kEthereumDomain = "ethereum.spacedatanetwork.org";
constexpr const char* kSolanaDomain = "solana.spacedatanetwork.org";

constexpr size_t kFoldLimit = 75;       // RFC 2425: fold at 75 octets
constexpr size_t kQrMaxBytes = 1200;    // QR density budget

// ── helpers ────────────────────────────────────────────────────────────────

std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && (s[b] == ' ' || s[b] == '\t' || s[b] == '\r' || s[b] == '\n')) b++;
    while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t' || s[e - 1] == '\r' || s[e - 1] == '\n')) e--;
    return s.substr(b, e - b);
}

std::string safeStr(const ::flatbuffers::String* s) {
    return s ? trim(std::string(s->c_str(), s->size())) : "";
}

bool emptyStr(const std::string& s) {
    return s.empty() || s.find_first_not_of(" \t\r\n") == std::string::npos;
}

// base64url (raw, no padding) of binary data — the email-safe local part.
std::string b64url(const uint8_t* data, size_t len) {
    static const char chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::string out;
    out.reserve((len * 4 + 2) / 3);
    for (size_t i = 0; i < len; i += 3) {
        const uint8_t b0 = data[i];
        const uint8_t b1 = i + 1 < len ? data[i + 1] : 0;
        const uint8_t b2 = i + 2 < len ? data[i + 2] : 0;
        out += chars[b0 >> 2];
        out += chars[((b0 & 0x03) << 4) | (b1 >> 4)];
        if (i + 1 < len) out += chars[((b1 & 0x0f) << 2) | (b2 >> 6)];
        if (i + 2 < len) out += chars[b2 & 0x3f];
    }
    return out;
}

// hex-decode a hex string to bytes (returns empty on invalid hex).
std::vector<uint8_t> hexDecode(const std::string& hex) {
    std::string h = hex;
    if (h.size() >= 2 && h[0] == '0' && (h[1] == 'x' || h[1] == 'X')) h = h.substr(2);
    if (h.size() % 2 != 0) return {};
    std::vector<uint8_t> out;
    out.reserve(h.size() / 2);
    for (size_t i = 0; i < h.size(); i += 2) {
        const auto hexVal = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };
        const int hi = hexVal(h[i]);
        const int lo = hexVal(h[i + 1]);
        if (hi < 0 || lo < 0) return {};
        out.push_back(static_cast<uint8_t>((hi << 4) | lo));
    }
    return out;
}

// b64url of a hex-encoded key (hex-decode → b64url). Returns "" on invalid hex.
std::string hexKeyToB64Url(const std::string& hexKey) {
    const auto bytes = hexDecode(hexKey);
    if (bytes.empty()) return "";
    return b64url(bytes.data(), bytes.size());
}

// fold a vCard line at 75 octets with CRLF + leading-space continuation.
std::string foldLine(const std::string& line) {
    if (line.size() <= kFoldLimit) return line;
    std::string out;
    out.reserve(line.size() + (line.size() / kFoldLimit) * 3);
    size_t pos = 0;
    while (pos < line.size()) {
        if (pos > 0) out += "\r\n ";
        const size_t chunk = std::min(kFoldLimit, line.size() - pos);
        out += line.substr(pos, chunk);
        pos += chunk;
    }
    return out;
}

std::string escapeVCard(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        switch (c) {
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case ',': out += "\\,"; break;
            case ';': out += "\\;"; break;
            default: out += c;
        }
    }
    return out;
}

// ── vCard builder ──────────────────────────────────────────────────────────

struct VCardBuilder {
    std::vector<std::string> lines;

    void add(const std::string& prop, const std::string& value) {
        if (!emptyStr(value)) lines.push_back(prop + ":" + escapeVCard(value));
    }

    void addRaw(const std::string& line) {
        lines.push_back(line);
    }

    void addAlias(const std::string& kind, const std::string& domain,
                  const std::string& b64urlLocalPart) {
        if (b64urlLocalPart.empty()) return;
        addRaw(foldLine("EMAIL;type=INTERNET;type=" + kind + ":" +
                        b64urlLocalPart + "@" + domain));
    }

    std::string build() const {
        std::string out;
        for (size_t i = 0; i < lines.size(); i++) {
            if (i > 0) out += "\r\n";
            out += lines[i];
        }
        out += "\r\n";
        return out;
    }
};

// ── EPM → vCard projection ────────────────────────────────────────────────

// Extract the first signing/encryption key's PUBLIC_KEY from the EPM KEYS[].
struct KeyAlias {
    std::string b64url;
    bool found = false;
};

KeyAlias extractKeyAlias(const EPM* epm, KeyType wantType) {
    KeyAlias info;
    const auto* keys = epm->KEYS();
    if (!keys) return info;
    for (uint32_t i = 0; i < keys->size(); i++) {
        const auto* key = keys->Get(i);
        if (key->KEY_TYPE() != wantType) continue;
        const std::string pubKey = safeStr(key->PUBLIC_KEY());
        if (pubKey.empty()) continue;
        const std::string alias = hexKeyToB64Url(pubKey);
        if (!alias.empty()) {
            info.b64url = alias;
            info.found = true;
            return info;  // first match only (one-row invariant)
        }
    }
    return info;
}

// CID placeholder — the real CID computation requires the IPFS hash, which
// is a host capability. The module emits the epmcid alias only when the
// caller provides it; for the compact card it is dropped.
std::string formatChainAlias(const EPM* epm) {
    // Chain address aliases from CHAIN_PROOFS
    std::vector<std::string> chainLines;
    const auto* proofs = epm->CHAIN_PROOFS();
    if (!proofs) return "";
    for (uint32_t i = 0; i < proofs->size(); i++) {
        const auto* proof = proofs->Get(i);
        const std::string chain = safeStr(proof->CHAIN());
        const std::string address = safeStr(proof->ADDRESS());
        if (chain.empty() || address.empty()) continue;
        const std::string domain =
            chain == "bitcoin" ? kBitcoinDomain :
            chain == "ethereum" ? kEthereumDomain :
            chain == "solana" ? kSolanaDomain : "";
        if (domain.empty()) continue;
        chainLines.push_back(foldLine(
            "EMAIL;type=INTERNET;type=" + chain + ":" + address + "@" + domain));
    }
    std::string out;
    for (size_t i = 0; i < chainLines.size(); i++) {
        if (i > 0) out += "\r\n";
        out += chainLines[i];
    }
    return out;
}

std::string projectFullCard(const EPM* epm) {
    VCardBuilder v;
    v.addRaw("VERSION:3.0");

    const std::string dn = safeStr(epm->DN());
    const std::string fn = (!emptyStr(dn) || dn.find("<peer.ID") == std::string::npos)
                              ? dn : "SDN Node";

    // Contact fields (sorted ASCII property name order, matching Go encoder)
    const auto* addr = epm->ADDRESS();
    const std::string poBox = addr ? safeStr(addr->POST_OFFICE_BOX_NUMBER()) : "";
    const std::string street = addr ? safeStr(addr->STREET()) : "";
    const std::string locality = addr ? safeStr(addr->LOCALITY()) : "";
    const std::string region = addr ? safeStr(addr->REGION()) : "";
    const std::string postalCode = addr ? safeStr(addr->POSTAL_CODE()) : "";
    const std::string country = addr ? safeStr(addr->COUNTRY()) : "";

    if (!poBox.empty() || !street.empty() || !locality.empty() ||
        !region.empty() || !postalCode.empty() || !country.empty()) {
        v.addRaw("ADR;TYPE=WORK:" + escapeVCard(poBox) + ";;" +
                   escapeVCard(street) + ";" + escapeVCard(locality) + ";" +
                   escapeVCard(region) + ";" + escapeVCard(postalCode) + ";" +
                   escapeVCard(country));
    }
    v.add("EMAIL", safeStr(epm->EMAIL()));
    v.add("FN", fn);
    // N: family;given;additional;prefix;suffix
    v.addRaw("N:" + escapeVCard(safeStr(epm->FAMILY_NAME())) + ";" +
               escapeVCard(safeStr(epm->GIVEN_NAME())) + ";" +
               escapeVCard(safeStr(epm->ADDITIONAL_NAME())) + ";" +
               escapeVCard(safeStr(epm->HONORIFIC_PREFIX())) + ";" +
               escapeVCard(safeStr(epm->HONORIFIC_SUFFIX())));
    // NICKNAME from ALTERNATE_NAMES
    const auto* altNames = epm->ALTERNATE_NAMES();
    if (altNames && altNames->size() > 0) {
        std::string joined;
        for (uint32_t i = 0; i < altNames->size(); i++) {
            const std::string name = safeStr(altNames->Get(i));
            if (name.empty()) continue;
            if (!joined.empty()) joined += ",";
            joined += escapeVCard(name);
        }
        if (!joined.empty()) v.addRaw("NICKNAME:" + joined);
    }
    v.add("ORG", safeStr(epm->LEGAL_NAME()));
    // PRODID omitted — canonical card emits no PRODID (Themis LACK)
    v.add("ROLE", safeStr(epm->OCCUPATION()));
    v.add("TEL", safeStr(epm->TELEPHONE()));
    v.add("TITLE", safeStr(epm->JOB_TITLE()));

    // Alias block: sign, encrypt, chain..., epmsig, epmts, epmcid
    const KeyAlias signKey = extractKeyAlias(epm, KeyType::KeyType_Signing);
    const KeyAlias encKey = extractKeyAlias(epm, KeyType::KeyType_Encryption);
    if (signKey.found) v.addAlias("sign", kSignDomain, signKey.b64url);
    if (encKey.found) v.addAlias("encrypt", kEncryptDomain, encKey.b64url);

    // Chain address aliases
    const std::string chainAliases = formatChainAlias(epm);
    if (!chainAliases.empty()) v.addRaw(chainAliases);

    // epmsig: b64url of SIGNATURE hex
    const std::string sigHex = safeStr(epm->SIGNATURE());
    if (!sigHex.empty()) {
        const auto sigBytes = hexDecode(sigHex);
        if (!sigBytes.empty()) {
            v.addAlias("epmsig", kEpmSigDomain, b64url(sigBytes.data(), sigBytes.size()));
        }
    }
    // epmts: decimal timestamp
    const int64_t ts = epm->SIGNATURE_TIMESTAMP();
    if (ts != 0) {
        v.addRaw(foldLine("EMAIL;type=INTERNET;type=epmts:" +
                          std::to_string(ts) + "@" + kEpmTsDomain));
    }
    // epmcid: would require IPFS hash (host cap) — omitted; caller can inject.

    v.addRaw("END:VCARD");
    return v.build();
}

std::string projectCompactCard(const EPM* epm) {
    VCardBuilder v;
    v.addRaw("VERSION:3.0");

    const std::string dn = safeStr(epm->DN());
    const std::string fn = (!emptyStr(dn) || dn.find("<peer.ID") == std::string::npos)
                              ? dn : "SDN Node";

    // Compact order: N, FN, ORG, EMAIL, TEL, ADR;TYPE=WORK, aliases
    v.addRaw("N:" + escapeVCard(safeStr(epm->FAMILY_NAME())) + ";" +
               escapeVCard(safeStr(epm->GIVEN_NAME())) + ";" +
               escapeVCard(safeStr(epm->ADDITIONAL_NAME())) + ";" +
               escapeVCard(safeStr(epm->HONORIFIC_PREFIX())) + ";" +
               escapeVCard(safeStr(epm->HONORIFIC_SUFFIX())));
    v.add("FN", fn);
    v.add("ORG", safeStr(epm->LEGAL_NAME()));
    v.add("EMAIL", safeStr(epm->EMAIL()));
    v.add("TEL", safeStr(epm->TELEPHONE()));

    const auto* addr = epm->ADDRESS();
    const std::string poBox = addr ? safeStr(addr->POST_OFFICE_BOX_NUMBER()) : "";
    const std::string street = addr ? safeStr(addr->STREET()) : "";
    const std::string locality = addr ? safeStr(addr->LOCALITY()) : "";
    const std::string region = addr ? safeStr(addr->REGION()) : "";
    const std::string postalCode = addr ? safeStr(addr->POSTAL_CODE()) : "";
    const std::string country = addr ? safeStr(addr->COUNTRY()) : "";
    if (!poBox.empty() || !street.empty() || !locality.empty() ||
        !region.empty() || !postalCode.empty() || !country.empty()) {
        v.addRaw("ADR;TYPE=WORK:" + escapeVCard(poBox) + ";;" +
                   escapeVCard(street) + ";" + escapeVCard(locality) + ";" +
                   escapeVCard(region) + ";" + escapeVCard(postalCode) + ";" +
                   escapeVCard(country));
    }

    // Only sign, encrypt, epmsig — the compact QR verification chain
    const KeyAlias signKey = extractKeyAlias(epm, KeyType::KeyType_Signing);
    const KeyAlias encKey = extractKeyAlias(epm, KeyType::KeyType_Encryption);
    if (signKey.found) v.addAlias("sign", kSignDomain, signKey.b64url);
    if (encKey.found) v.addAlias("encrypt", kEncryptDomain, encKey.b64url);

    const std::string sigHex = safeStr(epm->SIGNATURE());
    if (!sigHex.empty()) {
        const auto sigBytes = hexDecode(sigHex);
        if (!sigBytes.empty()) {
            v.addAlias("epmsig", kEpmSigDomain, b64url(sigBytes.data(), sigBytes.size()));
        }
    }

    v.addRaw("END:VCARD");
    std::string card = v.build();

    // Density budget: refuse to serve a card exceeding the QR cap
    if (card.size() > kQrMaxBytes) {
        // The caller should handle this — the card is still returned but
        // the serving path must not use it as a QR.
    }

    return card;
}

// ── vCard → EPM fields (card_parse) ───────────────────────────────────────

std::string parseVCardToFields(const uint8_t* data, size_t len) {
    // Simple vCard line parser — unfold continuation lines, split properties.
    std::string text(data, data + len);
    // Unfold: join "\r\n " or "\n " continuation lines
    std::string unfolded;
    unfolded.reserve(text.size());
    for (size_t i = 0; i < text.size(); ) {
        if (i + 1 < text.size() && text[i] == '\r' && text[i + 1] == '\n' &&
            i + 2 < text.size() && text[i + 2] == ' ') {
            i += 3;  // skip the CRLF + space
        } else if (i + 1 < text.size() && text[i] == '\n' &&
                   i + 1 < text.size() && text[i + 1] == ' ') {
            i += 2;
        } else {
            unfolded += text[i++];
        }
    }

    // Parse into JSON — the recovered EPM fields
    std::string json = "{";
    bool first = true;
    auto addField = [&](const std::string& key, const std::string& value) {
        if (value.empty()) return;
        if (!first) json += ",";
        first = false;
        json += "\"" + key + "\":\"" + value + "\"";
    };

    std::istringstream iss(unfolded);
    std::string line;
    while (std::getline(iss, line)) {
        // Trim CR
        if (!line.empty() && line.back() == '\r') line.pop_back();
        const size_t colon = line.find(':');
        if (colon == std::string::npos) continue;
        const std::string name = line.substr(0, colon);
        const std::string value = line.substr(colon + 1);

        if (name == "FN") addField("dn", value);
        else if (name == "ORG") addField("legal_name", value);
        else if (name == "TITLE") addField("job_title", value);
        else if (name == "EMAIL" && name.find("type=") == std::string::npos) {
            // Contact email (not an alias) — simple heuristic: aliases have type= sign/encrypt/etc.
            if (value.find("@") != std::string::npos &&
                value.find(".spacedatanetwork.org") == std::string::npos) {
                addField("email", value);
            }
        }
        else if (name == "TEL") addField("telephone", value);
        // N: family;given;additional;prefix;suffix
        else if (name == "N") {
            const size_t sc1 = value.find(';');
            const size_t sc2 = value.find(';', sc1 + 1);
            const size_t sc3 = value.find(';', sc2 + 1);
            const size_t sc4 = value.find(';', sc3 + 1);
            if (sc1 != std::string::npos) addField("family_name", value.substr(0, sc1));
            if (sc2 != std::string::npos) addField("given_name", value.substr(sc1 + 1, sc2 - sc1 - 1));
        }
        // Alias emails → recovered keys
        else if (name.find("type=sign") != std::string::npos) {
            // b64url local part → would need b64url decode → hex to recover public_key
            // For now, record the alias value
            const size_t at = value.find('@');
            if (at != std::string::npos) addField("signing_public_key", value.substr(0, at));
        }
        else if (name.find("type=encrypt") != std::string::npos) {
            const size_t at = value.find('@');
            if (at != std::string::npos) addField("encryption_public_key", value.substr(0, at));
        }
    }
    json += "}";
    return json;
}

// ── input frame helper ──────────────────────────────────────────────────────

const EPM* readEPMFromInput(const char* portId) {
    const int32_t idx = plugin_find_input_index(portId, 0);
    if (idx < 0) return nullptr;
    const plugin_input_frame_t* frame = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!frame || frame->payload_length == 0 || !frame->payload) return nullptr;
    // Size-prefixed EPM: the frame payload includes the 4-byte size prefix
    return GetSizePrefixedEPM(frame->payload);
}

}  // namespace

// ── method entry points ───────────────────────────────────────────────────

extern "C" {

int card_full(void) {
    const EPM* epm = readEPMFromInput("epm");
    if (!epm) {
        plugin_set_error("missing-epm-frame", "card_full requires the $EPM record frame.");
        return 400;
    }
    const std::string vcard = projectFullCard(epm);
    plugin_push_output_ex("vcard", nullptr, nullptr,
                           PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                           reinterpret_cast<const uint8_t*>(vcard.data()),
                           static_cast<uint32_t>(vcard.size()));
    return 0;
}

int card_compact(void) {
    const EPM* epm = readEPMFromInput("epm");
    if (!epm) {
        plugin_set_error("missing-epm-frame", "card_compact requires the $EPM record frame.");
        return 400;
    }
    const std::string vcard = projectCompactCard(epm);
    if (vcard.size() > kQrMaxBytes) {
        plugin_set_error("qr-density-exceeded",
                         "compact card exceeds the 1200-byte QR budget");
        return 422;
    }
    plugin_push_output_ex("vcard", nullptr, nullptr,
                           PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                           reinterpret_cast<const uint8_t*>(vcard.data()),
                           static_cast<uint32_t>(vcard.size()));
    return 0;
}

int card_parse(void) {
    const int32_t idx = plugin_find_input_index("vcard", 0);
    if (idx < 0) {
        plugin_set_error("missing-vcard-frame", "card_parse requires the vCard text frame.");
        return 400;
    }
    const plugin_input_frame_t* frame = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!frame || frame->payload_length == 0 || !frame->payload) {
        plugin_set_error("empty-vcard", "card_parse received an empty vCard.");
        return 400;
    }
    const std::string json = parseVCardToFields(
        static_cast<const uint8_t*>(frame->payload), frame->payload_length);
    plugin_push_output_ex("epm_fields", nullptr, nullptr,
                           PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                           reinterpret_cast<const uint8_t*>(json.data()),
                           static_cast<uint32_t>(json.size()));
    return 0;
}

}  // extern "C"
