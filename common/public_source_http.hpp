#pragma once

#include <HttpRequest_generated.h>
#include <memory>

namespace sdn_source_http {

// Public data services require an identifying client and a project contact.
inline void identify(sdn::runtime::HttpRequestT& request) {
  auto header = std::make_unique<sdn::runtime::HeaderT>();
  header->NAME = "User-Agent";
  header->VALUE = "SpaceDataNetwork/1.1 (https://github.com/DigitalArsenal/space-data-network-modules)";
  request.HEADERS.push_back(std::move(header));
}

}  // namespace sdn_source_http
