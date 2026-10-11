/*
 * files/ccsds-messages — the messages the NDM engine knows, by name.
 *
 * Needs every message's generated headers, spec and codec in scope; each entry
 * binds one type to type-erased read and write over its record.
 */

#ifndef CCSDS_MESSAGES_NDM_REGISTRY_HPP
#define CCSDS_MESSAGES_NDM_REGISTRY_HPP

#include "ndm_codec.hpp"
#include "ndm_cdm.hpp"
#include "ndm_oem.hpp"
#include "ndm_omm.hpp"
#include "ndm_opm.hpp"

NDM_CODEC(OMM);
NDM_CODEC(OEM);
NDM_CODEC(OPM);
NDM_CODEC(CDM);

namespace ndm {
namespace registry {

struct Entry {
    const char* type;
    const Message& (*message)();
    bool (*read)(const uint8_t*, size_t, ReadOutcome*);
    bool (*write)(const uint8_t*, size_t, const WriteOptions&, std::string*, std::string*, Node*);
};

template <class Codec, const Message& (*Get)()>
struct Bind {
    static bool read(const uint8_t* d, size_t n, ReadOutcome* o) {
        return read_message<Codec>(Get(), d, n, o);
    }
    static bool write(const uint8_t* r, size_t n, const WriteOptions& w, std::string* t,
                      std::string* e, Node* tree) {
        return write_message<Codec>(Get(), r, n, w, t, e, tree);
    }
};

inline const Entry* find(const std::string& type) {
    static const Entry entries[] = {
        {"OMM", &omm::message, &Bind<OMMCodec, &omm::message>::read, &Bind<OMMCodec, &omm::message>::write},
        {"OEM", &oem::message, &Bind<OEMCodec, &oem::message>::read, &Bind<OEMCodec, &oem::message>::write},
        {"OPM", &opm::message, &Bind<OPMCodec, &opm::message>::read, &Bind<OPMCodec, &opm::message>::write},
        {"CDM", &cdm::message, &Bind<CDMCodec, &cdm::message>::read, &Bind<CDMCodec, &cdm::message>::write},
    };
    for (const Entry& e : entries) {
        if (type == e.type) return &e;
    }
    return nullptr;
}

}  // namespace registry
}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_REGISTRY_HPP
