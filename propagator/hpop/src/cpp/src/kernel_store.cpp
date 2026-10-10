#include "hpop/kernel_store.h"
#include "hpop/prw_codec.h"
#include "ephemeris.h"
#include "../../../../../files/orbit-products/src/sha256.hpp"
#include <cstring>

namespace hpop {

KernelStore::Bytes KernelStore::accept(const uint8_t* frame, size_t size, bool resident, std::string& error) {
    const PRW* root=nullptr;
    if(!verifyPrw(frame,size,root,error))return nullptr;
    const auto* input=root->NATIVE_INPUT();
    if(!input){prwError(error,"invalid-prw-arm: Kernel port requires NATIVE_INPUT.");return nullptr;}
    const auto* ncd=input->DESCRIPTOR();const auto* content=input->CONTENT();
    if(!ncd||ncd->FORMAT()!=ncdContainerFormat::SPK_DAF||!content||content->size()==0||ncd->SOURCE_BYTE_LENGTH()!=content->size()){
        prwError(error,"invalid-kernel: NCD requires SPK_DAF and exact SOURCE_BYTE_LENGTH.");return nullptr;
    }
    if(!ncd->SOURCE_SHA256()||ncd->SOURCE_SHA256()->size()!=64){prwError(error,"invalid-kernel: NCD requires a 64-character SOURCE_SHA256.");return nullptr;}
    auto declared=ncd->SOURCE_SHA256()->str();for(auto& c:declared)if(c>='A'&&c<='F')c+=32;
    // A kept copy with this SHA-256 and the same bytes was verified before.
    for(const Entry* kept:{&resident_,&execution_})
        if(kept->bytes&&kept->sha256==declared&&kept->bytes->size()==content->size()&&
           std::memcmp(kept->bytes->data(),content->data(),content->size())==0) {
            if(resident)resident_=*kept;else execution_=*kept;
            return kept->bytes;
        }
    if(declared!=ephem::sha256_hex(content->data(),content->size())){prwError(error,"invalid-kernel: Kernel SOURCE_SHA256 does not match the supplied bytes.");return nullptr;}
    auto bytes=std::make_shared<const std::vector<uint8_t>>(content->data(),content->data()+content->size());
    // Parse once here so a malformed DAF fails at its own input.
    if(!astro::Ephemeris::loadEphemerisBuffer(bytes->data(),bytes->size())){error="invalid-kernel: "+astro::Ephemeris::ephemerisError();return nullptr;}
    (resident?resident_:execution_)=Entry{declared,bytes};
    return bytes;
}

bool KernelStore::activate(const Bytes& kernel, std::string& error) {
    if(!kernel){astro::Ephemeris::clearEphemerisBuffer();return true;}
    if(!astro::Ephemeris::loadEphemerisBuffer(kernel->data(),kernel->size())){error="invalid-kernel: "+astro::Ephemeris::ephemerisError();return false;}
    return true;
}

KernelStore& instanceKernels() {
    static KernelStore store;
    return store;
}

} // namespace hpop
