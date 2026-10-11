/*
 * files/ccsds-messages — text in, SDS record out, and back, for any NDM message
 * that has a Spec.
 *
 *   read:   bytes ──► (KVN | XML) ──► Node tree ──► Spec fill ──► XxxT ──► $XXX
 *   write:  $XXX  ──► XxxT ──► Spec emit ──► Node tree ──► (KVN | XML) bytes
 *
 * The record side is the generated object API: `NDM_CODEC(OMM)` instantiates a
 * `OMMCodec` with pack/unpack over `OMMT`, `OMM::Pack`, `OMM::UnPack` and the
 * `$OMM` identifier. The syntax is read from the bytes (a document that starts
 * with `<` is XML) and chosen by the caller when writing.
 */

#ifndef CCSDS_MESSAGES_NDM_CODEC_HPP
#define CCSDS_MESSAGES_NDM_CODEC_HPP

#include "ndm_core.hpp"
#include "ndm_kvn.hpp"
#include "ndm_xml.hpp"

namespace ndm {

enum class Syntax : int { Kvn = 0, Xml = 1 };

inline const char* syntax_name(Syntax s) { return s == Syntax::Xml ? "xml" : "kvn"; }

/* XML if the first character that is not white space (after a byte order mark)
 * is '<'. */
inline Syntax detect_syntax(const uint8_t* data, size_t length) {
    size_t i = 0;
    if (length >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF) i = 3;
    while (i < length && is_space(static_cast<char>(data[i]))) ++i;
    return (i < length && data[i] == '<') ? Syntax::Xml : Syntax::Kvn;
}

struct ReadOutcome {
    bool ok = false;
    std::string error;
    std::string code;      /* a short name for the failure */
    Syntax syntax = Syntax::Kvn;
    std::string version;   /* the version the message stated */
    Report report;
    Node tree;             /* the parsed pivot tree, for descriptors and tests */
    std::vector<uint8_t> record;  /* size-prefixed $XXX */
};

struct WriteOptions {
    Syntax syntax = Syntax::Kvn;
    bool units = true;
};

#define NDM_CODEC(NAME)                                                                      \
    struct NAME##Codec {                                                                     \
        using Native = NAME##T;                                                              \
        static std::vector<uint8_t> pack(const Native& n) {                                  \
            ::flatbuffers::FlatBufferBuilder fbb(4096);                                      \
            fbb.FinishSizePrefixed(NAME::Pack(fbb, &n), NAME##Identifier());                 \
            return std::vector<uint8_t>(fbb.GetBufferPointer(),                              \
                                        fbb.GetBufferPointer() + fbb.GetSize());             \
        }                                                                                    \
        static bool unpack(const uint8_t* data, size_t length, Native* out) {                \
            ::flatbuffers::Verifier verifier(data, length);                                  \
            if (length >= 12 &&                                                              \
                ::flatbuffers::BufferHasIdentifier(data, NAME##Identifier(), true)) {        \
                if (!VerifySizePrefixed##NAME##Buffer(verifier)) return false;               \
                Get##SizePrefixed##NAME(data)->UnPackTo(out);                                \
                return true;                                                                 \
            }                                                                                \
            if (length < 8 || !Verify##NAME##Buffer(verifier)) return false;                 \
            Get##NAME(data)->UnPackTo(out);                                                  \
            return true;                                                                     \
        }                                                                                    \
    }

template <class Codec>
inline bool read_message(const Message& msg, const uint8_t* data, size_t length,
                         ReadOutcome* out) {
    out->syntax = detect_syntax(data, length);
    std::string error;
    if (out->syntax == Syntax::Xml) {
        std::string found;
        if (!xml::read(reinterpret_cast<const char*>(data), length, msg.root, &out->tree, &error,
                       &found)) {
            out->code = found.empty() || found == msg.root ? "bad-xml" : "wrong-message-type";
            out->error = error;
            return false;
        }
    } else {
        if (!kvn::read(reinterpret_cast<const char*>(data), length, msg, &out->tree, &out->report,
                       &error)) {
            out->code = starts_with(error, "the message opens with") ? "wrong-message-type"
                                                                     : "bad-kvn";
            out->error = error;
            return false;
        }
    }
    out->version = out->tree.text;
    typename Codec::Native record;
    std::string e;
    if (msg.take_version && !msg.take_version(&record, out->tree.text, &e)) {
        out->code = "bad-version";
        out->error = msg.version_key + " = " + out->tree.text + ": " + e;
        return false;
    }
    FillResult fr;
    fill_section(*msg.top, out->tree, &record, msg.root, &out->report, &fr);
    if (!fr.ok) {
        out->code = "bad-value";
        out->error = fr.error + (fr.line ? " (line " + std::to_string(fr.line) + ")" : "");
        return false;
    }
    out->record = Codec::pack(record);
    out->ok = true;
    return true;
}

template <class Codec>
inline bool write_message(const Message& msg, const uint8_t* record, size_t length,
                          const WriteOptions& options, std::string* text, std::string* error,
                          Node* tree_out = nullptr) {
    typename Codec::Native native;
    if (!Codec::unpack(record, length, &native)) {
        *error = "the record is not a verifiable size-prefixed $" + msg.type + " buffer";
        return false;
    }
    if (msg.check_record) {
        const std::string reason = msg.check_record(&native);
        if (!reason.empty()) {
            *error = reason;
            return false;
        }
    }
    std::vector<Node> top;
    emit_section(*msg.top, &native, &top);
    Node tree = Node::container(msg.root);
    if (!top.empty()) tree.kids = std::move(top[0].kids);
    tree.text = msg.version;
    if (options.syntax == Syntax::Xml) {
        xml::write(msg.root, msg.version_key, msg.version, tree, options.units, text);
    } else {
        kvn::write(msg.version_key, msg.version, tree, options.units, text);
    }
    if (tree_out) *tree_out = std::move(tree);
    return true;
}

}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_CODEC_HPP
