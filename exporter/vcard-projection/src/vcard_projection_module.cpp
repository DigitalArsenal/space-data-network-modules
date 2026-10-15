/*
 * exporter/vcard-projection — the $VCF WASM module.
 *
 * Pure projection of $EPM FlatBuffer bytes to vCard 3.0 text (RFC 2426).
 * Three methods:
 *   card_full   — full contact card + verification chain + photo
 *   card_compact — QR-density card (sign/encrypt/epmsig only, ≤1200 bytes)
 *   card_parse   — $VCF card → $EPM carrying the recovered fields

 * Typed contracts 1.0: $EPM in, $VCF out (CARD = the vCard text verbatim) for the
 * projections; $VCF in, $EPM out for the parse. Every frame is a size-prefixed SDS
 * FlatBuffer; no JSON or loose text travels between modules.
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
// The EPM and VCF generated headers are inlined by build.mjs ahead of this source.

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

// The fields card_parse recovers (the same set the JSON form carried).
struct ParsedFields {
    std::string dn, legal_name, job_title, email, telephone, family_name, given_name;
    std::string signing_public_key, encryption_public_key;  // hex of the alias's b64url local part
};

// raw (unpadded) base64url → lower-case hex; "" when the text is not base64url.
std::string b64urlToHex(const std::string& in) {
    auto val = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '-') return 62;
        if (c == '_') return 63;
        return -1;
    };
    if (in.empty() || in.size() % 4 == 1) return "";
    std::vector<uint8_t> bytes;
    uint32_t acc = 0;
    int bits = 0;
    for (char c : in) {
        const int v = val(c);
        if (v < 0) return "";
        acc = (acc << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push_back(static_cast<uint8_t>((acc >> bits) & 0xff));
        }
    }
    static const char hex[] = "0123456789abcdef";
    std::string out;
    for (uint8_t b : bytes) { out += hex[b >> 4]; out += hex[b & 15]; }
    return out;
}

ParsedFields parseVCardToFields(const uint8_t* data, size_t len) {
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

    // The first non-empty value of each field wins, as the JSON form's first key did.
    ParsedFields f;
    auto set = [](std::string& field, const std::string& value) {
        if (!value.empty() && field.empty()) field = value;
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

        if (name == "FN") set(f.dn, value);
        else if (name == "ORG") set(f.legal_name, value);
        else if (name == "TITLE") set(f.job_title, value);
        else if (name == "EMAIL" && name.find("type=") == std::string::npos) {
            // Contact email (not an alias) — simple heuristic: aliases have type= sign/encrypt/etc.
            if (value.find("@") != std::string::npos &&
                value.find(".spacedatanetwork.org") == std::string::npos) {
                set(f.email, value);
            }
        }
        else if (name == "TEL") set(f.telephone, value);
        // N: family;given;additional;prefix;suffix
        else if (name == "N") {
            const size_t sc1 = value.find(';');
            const size_t sc2 = value.find(';', sc1 + 1);
            if (sc1 != std::string::npos) set(f.family_name, value.substr(0, sc1));
            if (sc2 != std::string::npos) set(f.given_name, value.substr(sc1 + 1, sc2 - sc1 - 1));
        }
        // Alias emails → recovered literal public keys (b64url local part → hex, the EPM PUBLIC_KEY form)
        else if (name.find("type=sign") != std::string::npos) {
            const size_t at = value.find('@');
            if (at != std::string::npos) set(f.signing_public_key, b64urlToHex(value.substr(0, at)));
        }
        else if (name.find("type=encrypt") != std::string::npos) {
            const size_t at = value.find('@');
            if (at != std::string::npos) set(f.encryption_public_key, b64urlToHex(value.substr(0, at)));
        }
    }
    return f;
}

// The recovered fields as one size-prefixed $EPM (absent fields stay absent).
void buildParsedEPM(const ParsedFields& f, ::flatbuffers::FlatBufferBuilder& b) {
    auto str = [&](const std::string& v) { return v.empty() ? ::flatbuffers::Offset<::flatbuffers::String>() : b.CreateString(v); };
    std::vector<::flatbuffers::Offset<CryptoKey>> keys;
    if (!f.signing_public_key.empty())
        keys.push_back(CreateCryptoKey(b, str(f.signing_public_key), 0, 0, 0, 0, 0, KeyType_Signing));
    if (!f.encryption_public_key.empty())
        keys.push_back(CreateCryptoKey(b, str(f.encryption_public_key), 0, 0, 0, 0, 0, KeyType_Encryption));
    const auto keysVec = keys.empty() ? ::flatbuffers::Offset<::flatbuffers::Vector<::flatbuffers::Offset<CryptoKey>>>() : b.CreateVector(keys);
    const auto dn = str(f.dn), legal = str(f.legal_name), family = str(f.family_name), given = str(f.given_name),
               job = str(f.job_title), email = str(f.email), tel = str(f.telephone);
    EPMBuilder e(b);
    if (!dn.IsNull()) e.add_DN(dn);
    if (!legal.IsNull()) e.add_LEGAL_NAME(legal);
    if (!family.IsNull()) e.add_FAMILY_NAME(family);
    if (!given.IsNull()) e.add_GIVEN_NAME(given);
    if (!job.IsNull()) e.add_JOB_TITLE(job);
    if (!email.IsNull()) e.add_EMAIL(email);
    if (!tel.IsNull()) e.add_TELEPHONE(tel);
    if (!keysVec.IsNull()) e.add_KEYS(keysVec);
    FinishSizePrefixedEPMBuffer(b, e.Finish());
}

// The projected card text as one size-prefixed $VCF: CARD verbatim, the form, and the
// conformance facts this emitter fixes (vCard 3.0, CRLF, 75-octet folding).
void buildCardVCF(const std::string& card, vcfCardForm form, ::flatbuffers::FlatBufferBuilder& b) {
    const bool compact = form == vcfCardForm_COMPACT;
    const auto conformance = CreateVCFConformanceDirect(
        b, "3.0", nullptr, vcfLineEnding_CRLF, static_cast<uint32_t>(kFoldLimit),
        static_cast<uint32_t>(card.size()), 0, compact ? static_cast<uint32_t>(kQrMaxBytes) : 0,
        compact && card.size() <= kQrMaxBytes);
    const auto cardText = b.CreateString(card);
    const auto mediaType = b.CreateString("text/vcard");
    VCFBuilder v(b);
    v.add_FORM(form);
    v.add_CARD(cardText);
    v.add_MEDIA_TYPE(mediaType);
    v.add_CONFORMANCE(conformance);
    FinishSizePrefixedVCFBuffer(b, v.Finish());
}

int pushTyped(const char* port, const char* schema, const char* fid, const char* root, const ::flatbuffers::FlatBufferBuilder& b) {
    return plugin_push_output_ex(port, schema, fid, PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, root, 0, 0,
                                 b.GetBufferPointer(), static_cast<uint32_t>(b.GetSize()));
}

// ── input frame helper ──────────────────────────────────────────────────────

const EPM* readEPMFromInput(const char* portId) {
    const int32_t idx = plugin_find_input_index(portId, 0);
    if (idx < 0) return nullptr;
    const plugin_input_frame_t* frame = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!frame || frame->payload_length == 0 || !frame->payload) return nullptr;
    // Size-prefixed EPM: the frame payload includes the 4-byte size prefix
    ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifySizePrefixedEPMBuffer(verifier)) return nullptr;
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
    ::flatbuffers::FlatBufferBuilder b(vcard.size() + 256);
    buildCardVCF(vcard, vcfCardForm_FULL, b);
    if (pushTyped("vcard", "VCF.fbs", VCFIdentifier(), "VCF", b) < 0) {
        plugin_set_error("output-failed", "card_full could not emit its $VCF frame.");
        return 500;
    }
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
    ::flatbuffers::FlatBufferBuilder b(vcard.size() + 256);
    buildCardVCF(vcard, vcfCardForm_COMPACT, b);
    if (pushTyped("vcard", "VCF.fbs", VCFIdentifier(), "VCF", b) < 0) {
        plugin_set_error("output-failed", "card_compact could not emit its $VCF frame.");
        return 500;
    }
    return 0;
}

int card_parse(void) {
    const int32_t idx = plugin_find_input_index("vcard", 0);
    if (idx < 0) {
        plugin_set_error("missing-vcard-frame", "card_parse requires the $VCF card frame.");
        return 400;
    }
    const plugin_input_frame_t* frame = plugin_get_input_frame(static_cast<uint32_t>(idx));
    if (!frame || frame->payload_length == 0 || !frame->payload) {
        plugin_set_error("empty-vcard", "card_parse received an empty $VCF frame.");
        return 400;
    }
    ::flatbuffers::Verifier verifier(frame->payload, frame->payload_length);
    if (!VerifySizePrefixedVCFBuffer(verifier)) {
        plugin_set_error("invalid-vcf", "card_parse requires one size-prefixed $VCF record.");
        return 400;
    }
    const VCF* card = GetSizePrefixedVCF(frame->payload);
    const auto* text = card->CARD();
    if (!text || text->size() == 0) {
        plugin_set_error("empty-vcard", "card_parse received a $VCF with an empty CARD.");
        return 400;
    }
    const ParsedFields fields = parseVCardToFields(reinterpret_cast<const uint8_t*>(text->data()), text->size());
    ::flatbuffers::FlatBufferBuilder b(512);
    buildParsedEPM(fields, b);
    if (pushTyped("epm_fields", "EPM.fbs", EPMIdentifier(), "EPM", b) < 0) {
        plugin_set_error("output-failed", "card_parse could not emit its $EPM frame.");
        return 500;
    }
    return 0;
}

}  // extern "C"
