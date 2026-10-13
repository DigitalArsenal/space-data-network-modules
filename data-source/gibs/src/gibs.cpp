#include "space_data_module_invoke.h"
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <string_view>
#include <vector>

// The NASA GIBS layer catalog: every visualization layer GIBS serves, as one
// OGC WMTS 1.0.0 Capabilities document the console reads from SDN.
//
// GIBS publishes one Capabilities document per projection. EPSG:3857 (Web
// Mercator) holds every layer a globe can draw; EPSG:3413 and EPSG:3031 add the
// polar-only layers. Two facts the documents do not carry inline are fetched per
// layer:
//   - layer-metadata/v1.0/<id>.json: measurement, subtitle (platform and
//     instrument, or the third-party credit), period, ongoing, day/night and
//     the CMR collections the imagery is made from;
//   - DescribeDomains, for a layer whose Time dimension stops at the 100
//     values a Capabilities document lists: the full time domain.
//
// Stages (the flow chains them; every HTTP response arrives in request order):
//   plan_capabilities  the three Capabilities documents;
//   plan_details       parse them, queue the metadata and domain requests and
//                      ask for the first of kBatches batches;
//   advance            absorb a batch, ask for the next;
//   build_catalog      absorb the last batch and write the merged document;
//   announce_catalog   one $PNM naming the document's IPFS CID.
// Fetching, IPFS and storage belong to the host (host-adapter/).
//
// The merged document is a valid WMTS 1.0.0 Capabilities document for EPSG:3857
// (a WMTS client can read it as is). Polar-only layers carry their own
// renamed TileMatrixSets and literal polar tile templates. What GIBS states
// outside the WMTS vocabulary rides in ows:Keywords (codeSpace = its source)
// and ows:Metadata (xlink:role = what it is): measurement, period, licence,
// attribution, CMR collections, and the WMS endpoint that draws a vector
// (Mapbox Vector Tile) layer as PNG.
//
// Licence: NASA Earth science data and imagery are open with no restrictions
// (NASA Earth Science Data and Information Policy); GIBS asks for its
// acknowledgment. Layers derived from OpenStreetMap are ODbL with the OSM
// credit. Each layer states its own terms.

using Json = nlohmann::json;
namespace {
constexpr size_t maxControlBytes = 64u * 1024u * 1024u;
constexpr size_t maxCapabilitiesBytes = 32u * 1024u * 1024u;
constexpr size_t maxDetailBytes = 4u * 1024u * 1024u;
constexpr size_t maxFrames = 60;  // the flow runtime hands a node at most 64 frames per invocation
// Request batches: plan_details asks for the first, advance for 2..kBatches-1,
// build_catalog absorbs the last. flow.mjs builds the same count of stages.
constexpr int kBatches = 30;
constexpr const char* providerId = "nasa-gibs";
constexpr const char* sourceName = "layer-catalog";
constexpr const char* catalogFile = "gibs-wmts-capabilities.xml";
constexpr const char* kGibs = "https://gibs.earthdata.nasa.gov";
constexpr const char* kCodeSpaceGibs = "https://gibs.earthdata.nasa.gov/layer-metadata/v1.0";
constexpr const char* kCodeSpaceSdn = "https://spacedatanetwork.org/def/gibs-catalog";
constexpr const char* kCitation =
    "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), "
    "part of NASA's Earth Science Data and Information System (ESDIS).";
constexpr const char* kCitationUrl = "https://nasa-gibs.github.io/gibs-api-docs/#data-use-guidance-and-acknowledgements";
constexpr const char* kNasaLicence =
    "NASA Earth science data and imagery: open, no restrictions on use, sale or redistribution "
    "(NASA Earth Science Data and Information Policy)";
constexpr const char* kNasaLicenceUrl = "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance";
constexpr const char* kOdbl = "Open Database License (ODbL) 1.0";
constexpr const char* kOsmUrl = "https://www.openstreetmap.org/copyright";
constexpr const char* kFresh = "Thu, 01 Jan 1970 00:00:00 GMT";

struct Projection { const char* crs; const char* path; };
constexpr Projection kProjections[3] = {{"3857", "epsg3857"}, {"3413", "epsg3413"}, {"3031", "epsg3031"}};

const char* error = "Invalid GIBS input.";
int fail(const char* message) { plugin_set_error("invalid-gibs-input", message); return 1; }
#define CHECK(condition, message) do { if (!(condition)) return fail(message); } while (0)
#define NEED(condition, message) do { if (!(condition)) { error = message; return false; } } while (0)

// ── frames ─────────────────────────────────────────────────────────────────
std::vector<const plugin_input_frame_t*> frames(const char* port) {
  std::vector<const plugin_input_frame_t*> out;
  for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
    const auto* f = plugin_get_input_frame(i);
    if (f && f->port_id && std::strcmp(f->port_id, port) == 0) out.push_back(f);
  }
  return out;
}
Json json(const char* port) {
  const auto list = frames(port);
  if (list.size() != 1 || !list[0]->payload || list[0]->payload_length == 0 || list[0]->payload_length > maxControlBytes) return Json();
  return Json::parse(list[0]->payload, list[0]->payload + list[0]->payload_length, nullptr, false);
}
int output(const char* port, const Json& value) {
  const auto text = value.dump();
  return plugin_push_output_ex(port, nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                               reinterpret_cast<const uint8_t*>(text.data()), text.size());
}
uint32_t le32(const uint8_t* p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; }

// raw-body-v1: $HRB + int32 status + body, one per planned request, in order.
struct Response { int status; std::string_view body; };
bool responses(size_t expected, size_t maxBytes, std::vector<Response>& out) {
  const auto list = frames("response");
  NEED(list.size() == expected, "One HTTP response per planned request is required.");
  out.clear();
  for (const auto* f : list) {
    NEED(f->payload && f->payload_length >= 8 && std::memcmp(f->payload, "$HRB", 4) == 0, "Expected raw-body-v1 HTTP responses.");
    NEED(f->payload_length - 8 <= maxBytes, "An HTTP response is larger than this stage allows.");
    out.push_back({int(int32_t(le32(f->payload + 4))), std::string_view(reinterpret_cast<const char*>(f->payload + 8), f->payload_length - 8)});
  }
  return true;
}

// Every request states its own validator: the host's per-URL If-None-Match
// would otherwise answer 304 (no body) to a document a cycle needs whole.
Json request(const std::string& url, size_t maxBytes, int timeoutMs) {
  return {{"method", "GET"}, {"url", url}, {"headers", {{"If-Modified-Since", kFresh}}},
          {"timeoutMs", timeoutMs}, {"maxBytes", maxBytes}, {"responseWire", "raw-body-v1"}};
}
std::string capabilitiesUrl(const Projection& p) { return std::string(kGibs) + "/wmts/" + p.path + "/best/1.0.0/WMTSCapabilities.xml"; }

// ── XML ────────────────────────────────────────────────────────────────────
// A small DOM for the GIBS documents: elements, attributes, text and each
// element's source span (TileMatrixSet definitions are copied verbatim).
struct XNode {
  std::string name;
  std::vector<std::pair<std::string, std::string>> attrs;
  std::string text;
  std::vector<size_t> kids;
  size_t begin = 0, end = 0;
};
struct XDoc { std::string_view src; std::vector<XNode> nodes; };

void appendDecoded(std::string& out, std::string_view s) {
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] != '&') { out += s[i]; continue; }
    const size_t semi = s.find(';', i);
    if (semi == std::string_view::npos || semi - i > 10) { out += s[i]; continue; }
    const std::string_view entity = s.substr(i + 1, semi - i - 1);
    uint32_t cp = 0;
    if (entity == "amp") cp = '&';
    else if (entity == "lt") cp = '<';
    else if (entity == "gt") cp = '>';
    else if (entity == "quot") cp = '"';
    else if (entity == "apos") cp = '\'';
    else if (entity == "copy") cp = 0xA9;
    else if (entity.size() > 1 && entity[0] == '#') {
      const std::string digits(entity.substr(entity[1] == 'x' ? 2 : 1));
      cp = uint32_t(std::strtoul(digits.c_str(), nullptr, entity[1] == 'x' ? 16 : 10));
    }
    if (cp == 0) { out += s[i]; continue; }
    if (cp < 0x80) out += char(cp);
    else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
    else { out += char(0xF0 | (cp >> 18)); out += char(0x80 | ((cp >> 12) & 0x3F)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
    i = semi;
  }
}
bool space(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

bool parseXml(std::string_view s, XDoc& doc) {
  doc.src = s;
  doc.nodes.clear();
  doc.nodes.push_back({"#document"});
  std::vector<size_t> stack{0};
  size_t i = 0;
  const size_t n = s.size();
  while (i < n) {
    const size_t lt = s.find('<', i);
    if (lt == std::string_view::npos) break;
    if (lt > i && stack.size() > 1) appendDecoded(doc.nodes[stack.back()].text, s.substr(i, lt - i));
    if (s.compare(lt, 4, "<!--") == 0) {
      const size_t e = s.find("-->", lt + 4);
      NEED(e != std::string_view::npos, "An XML comment is not closed.");
      i = e + 3;
      continue;
    }
    if (s.compare(lt, 9, "<![CDATA[") == 0) {
      const size_t e = s.find("]]>", lt + 9);
      NEED(e != std::string_view::npos, "An XML CDATA section is not closed.");
      if (stack.size() > 1) doc.nodes[stack.back()].text.append(s.substr(lt + 9, e - lt - 9));
      i = e + 3;
      continue;
    }
    NEED(lt + 1 < n, "The XML document ends inside a tag.");
    if (s[lt + 1] == '?' || s[lt + 1] == '!') {
      const size_t e = s.find('>', lt);
      NEED(e != std::string_view::npos, "An XML declaration is not closed.");
      i = e + 1;
      continue;
    }
    if (s[lt + 1] == '/') {
      const size_t e = s.find('>', lt);
      NEED(e != std::string_view::npos && stack.size() > 1, "An XML end tag has no element to close.");
      doc.nodes[stack.back()].end = e + 1;
      stack.pop_back();
      i = e + 1;
      continue;
    }
    size_t j = lt + 1;
    while (j < n && !space(s[j]) && s[j] != '>' && s[j] != '/') ++j;
    XNode node;
    node.name = std::string(s.substr(lt + 1, j - lt - 1));
    node.begin = lt;
    bool selfClosing = false;
    for (;;) {
      while (j < n && space(s[j])) ++j;
      NEED(j < n, "The XML document ends inside a tag.");
      if (s[j] == '>') { ++j; break; }
      if (s[j] == '/') { NEED(j + 1 < n && s[j + 1] == '>', "A malformed XML empty-element tag."); selfClosing = true; j += 2; break; }
      size_t k = j;
      while (k < n && s[k] != '=' && !space(s[k]) && s[k] != '>') ++k;
      const std::string attrName(s.substr(j, k - j));
      while (k < n && space(s[k])) ++k;
      NEED(k < n && s[k] == '=', "An XML attribute has no value.");
      ++k;
      while (k < n && space(s[k])) ++k;
      NEED(k < n && (s[k] == '"' || s[k] == '\''), "An XML attribute value is not quoted.");
      const char quote = s[k];
      const size_t close = s.find(quote, k + 1);
      NEED(close != std::string_view::npos, "An XML attribute value is not closed.");
      std::string value;
      appendDecoded(value, s.substr(k + 1, close - k - 1));
      node.attrs.emplace_back(attrName, std::move(value));
      j = close + 1;
    }
    const size_t index = doc.nodes.size();
    doc.nodes.push_back(std::move(node));
    doc.nodes[stack.back()].kids.push_back(index);
    if (selfClosing) doc.nodes[index].end = j;
    else stack.push_back(index);
    i = j;
  }
  NEED(stack.size() == 1, "The XML document has unclosed elements.");
  return true;
}

std::string trim(std::string_view s) {
  size_t a = 0, b = s.size();
  while (a < b && space(s[a])) ++a;
  while (b > a && space(s[b - 1])) --b;
  return std::string(s.substr(a, b - a));
}
const XNode* kid(const XDoc& d, const XNode& at, const char* name) {
  for (const size_t k : at.kids) if (d.nodes[k].name == name) return &d.nodes[k];
  return nullptr;
}
std::vector<const XNode*> kids(const XDoc& d, const XNode& at, const char* name) {
  std::vector<const XNode*> out;
  for (const size_t k : at.kids) if (d.nodes[k].name == name) out.push_back(&d.nodes[k]);
  return out;
}
std::string text(const XDoc& d, const XNode& at, const char* name) {
  const XNode* k = kid(d, at, name);
  return k ? trim(k->text) : std::string();
}
std::string attr(const XNode& node, const char* name) {
  for (const auto& [k, v] : node.attrs) if (k == name) return v;
  return std::string();
}
bool endsWith(const std::string& s, const char* tail) {
  const size_t n = std::strlen(tail);
  return s.size() >= n && s.compare(s.size() - n, n, tail) == 0;
}
bool contains(const std::string& s, const char* part) { return s.find(part) != std::string::npos; }
std::string replaceAll(std::string s, const std::string& from, const std::string& to) {
  for (size_t at = s.find(from); at != std::string::npos; at = s.find(from, at + to.size())) s.replace(at, from.size(), to);
  return s;
}

// One GIBS Capabilities document -> the layers (JSON, the stage state) and its
// TileMatrixSet definitions (verbatim XML by identifier).
bool readCapabilities(std::string_view body, const Projection& p, Json& layers, std::map<std::string, std::string>& tms) {
  XDoc d;
  NEED(parseXml(body, d), error);
  const XNode* root = kid(d, d.nodes[0], "Capabilities");
  NEED(root, "A GIBS response is not a WMTS Capabilities document.");
  const XNode* contents = kid(d, *root, "Contents");
  NEED(contents, "A WMTS Capabilities document has no Contents.");
  for (const XNode* set : kids(d, *contents, "TileMatrixSet")) {
    const std::string id = text(d, *set, "ows:Identifier");
    if (!id.empty()) tms[id] = std::string(d.src.substr(set->begin, set->end - set->begin));
  }
  for (const XNode* layer : kids(d, *contents, "Layer")) {
    Json l = {{"id", text(d, *layer, "ows:Identifier")}, {"title", text(d, *layer, "ows:Title")}, {"crs", p.crs}};
    if (l["id"].get<std::string>().empty()) continue;
    if (const XNode* box = kid(d, *layer, "ows:WGS84BoundingBox")) {
      double w = -180, s = -90, e = 180, n = 90;
      std::sscanf(text(d, *box, "ows:LowerCorner").c_str(), "%lf %lf", &w, &s);
      std::sscanf(text(d, *box, "ows:UpperCorner").c_str(), "%lf %lf", &e, &n);
      l["bbox"] = {w, s, e, n};
    }
    for (const XNode* m : kids(d, *layer, "ows:Metadata")) {
      if (endsWith(attr(*m, "xlink:role"), "colormap/1.3")) l["colormap"] = attr(*m, "xlink:href");
    }
    Json legends = Json::array();
    if (const XNode* style = kid(d, *layer, "Style")) {
      for (const XNode* legend : kids(d, *style, "LegendURL")) {
        legends.push_back({{"role", attr(*legend, "xlink:role")}, {"href", attr(*legend, "xlink:href")},
                           {"format", attr(*legend, "format")}, {"width", attr(*legend, "width")}, {"height", attr(*legend, "height")}});
      }
    }
    l["legends"] = legends;
    l["format"] = text(d, *layer, "Format");
    for (const XNode* dim : kids(d, *layer, "Dimension")) {
      std::string identifier = text(d, *dim, "ows:Identifier");
      std::transform(identifier.begin(), identifier.end(), identifier.begin(), [](unsigned char c) { return char(std::tolower(c)); });
      if (identifier != "time") continue;
      l["default"] = text(d, *dim, "Default");
      Json values = Json::array();
      for (const XNode* v : kids(d, *dim, "Value")) values.push_back(trim(v->text));
      l["values"] = values;
    }
    if (const XNode* link = kid(d, *layer, "TileMatrixSetLink")) l["tms"] = text(d, *link, "TileMatrixSet");
    std::string tile, domains;
    const bool timed = l.contains("values");
    for (const XNode* url : kids(d, *layer, "ResourceURL")) {
      const std::string type = attr(*url, "resourceType"), templ = attr(*url, "template");
      if (type == "tile" && tile.empty() && (!timed || contains(templ, "{Time}"))) tile = templ;
      if (type == "Domains" && contains(templ, "/all/{TimeStart}") && domains.empty()) domains = templ;
    }
    if (tile.empty()) {
      for (const XNode* url : kids(d, *layer, "ResourceURL")) {
        if (attr(*url, "resourceType") == "tile") { tile = attr(*url, "template"); break; }
      }
    }
    l["template"] = tile;
    if (!domains.empty()) {
      // .../all/{TimeStart}.xml -> .../all/{TimeStart}--{TimeEnd}.xml: the whole domain.
      const size_t at = domains.find("/all/{TimeStart}");
      domains = domains.substr(0, at) + "/all/1900-01-01--2100-01-01.xml";
      l["domains"] = replaceAll(domains, "{TileMatrixSet}", l.value("tms", std::string()));
    }
    layers.push_back(std::move(l));
  }
  return true;
}

// ── catalog vocabulary ─────────────────────────────────────────────────────
// The GIBS period a layer steps by: "P1D" out of "2000-02-24/2026-10-13/P1D".
std::string periodOf(const std::string& value) {
  const size_t slash = value.rfind('/');
  return slash == std::string::npos ? std::string() : value.substr(slash + 1);
}
std::string timeKind(const Json& l) {
  const std::string id = l["id"];
  if (!l.contains("values") || l["values"].empty()) return "STATIC";
  if (contains(id, "Granule")) return "GRANULE";
  std::map<std::string, int> counts;
  for (const auto& v : l["values"]) ++counts[periodOf(v.get<std::string>())];
  std::string period;
  int best = -1;
  for (const auto& [p, c] : counts) if (c > best) { best = c; period = p; }
  if (period.rfind("PT", 0) == 0) return "SUBDAILY";
  if (period == "P1D") return "DAILY";
  if (!period.empty() && period.back() == 'D') return "MULTIDAY";
  if (!period.empty() && period.back() == 'M') return "MONTHLY";
  if (!period.empty() && period.back() == 'Y') return "YEARLY";
  return "STATIC";
}
bool osmDerived(const Json& l, const Json& meta) {
  const std::string id = l["id"], title = l["title"], subtitle = meta.value("subtitle", std::string());
  return id.rfind("OSM_", 0) == 0 || contains(title, "OSM") || contains(subtitle, "OpenStreetMap");
}
std::string role(const Json& l, const Json& meta) {
  const std::string id = l["id"], measurement = meta.value("measurement", std::string());
  if (measurement.rfind("Reference", 0) == 0 || id.rfind("Reference_", 0) == 0 || id.rfind("Coastlines", 0) == 0 ||
      id.rfind("OSM_", 0) == 0)
    return "REFERENCE";
  if (l.value("format", std::string()) == "image/jpeg") return "BASE";
  return "OVERLAY";
}
std::string analysis(const Json& l, const Json& meta) {
  const std::string id = l["id"], measurement = meta.value("measurement", std::string());
  if (contains(id, "DIST-ALERT") || contains(id, "DIST-ANN") || contains(measurement, "Disturbance")) return "CHANGE";
  if (contains(id, "Surface_Water") || contains(id, "DSWx") || contains(measurement, "Surface Water")) return "WATER";
  if (contains(measurement, "Vegetation Ind") || contains(id, "NDVI") || contains(id, "_EVI")) return "INDEX";
  return "";
}

// ── XML writer ─────────────────────────────────────────────────────────────
void esc(std::string& out, const std::string& s) {
  for (const char c : s) {
    switch (c) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      default: out += c;
    }
  }
}
void element(std::string& out, const char* name, const std::string& value) {
  out += '<'; out += name; out += '>'; esc(out, value); out += "</"; out += name; out += '>';
}
void keyword(std::string& out, const std::string& value, const char* type, const char* codeSpace) {
  if (value.empty()) return;
  out += "<ows:Keywords><ows:Keyword>"; esc(out, value);
  out += "</ows:Keyword><ows:Type codeSpace=\""; out += codeSpace; out += "\">"; out += type; out += "</ows:Type></ows:Keywords>";
}
void metadata(std::string& out, const std::string& role, const std::string& href, const std::string& title) {
  out += "<ows:Metadata xlink:type=\"simple\" xlink:role=\""; esc(out, role);
  out += "\" xlink:href=\""; esc(out, href);
  if (!title.empty()) { out += "\" xlink:title=\""; esc(out, title); }
  out += "\"/>";
}
std::string num(double v) {
  char b[40];
  std::snprintf(b, sizeof b, "%.6f", v);
  std::string s(b);
  while (!s.empty() && s.back() == '0') s.pop_back();
  if (!s.empty() && s.back() == '.') s.pop_back();
  return s;
}

void writeLayer(std::string& out, const Json& l, const Json& meta, const Json& domain) {
  const std::string id = l["id"];
  const bool vector = l.value("format", std::string()) == "application/vnd.mapbox-vector-tile";
  const bool osm = osmDerived(l, meta);
  out += "<Layer>";
  element(out, "ows:Title", l.value("title", id));
  if (meta.contains("subtitle")) element(out, "ows:Abstract", meta["subtitle"].get<std::string>());
  keyword(out, meta.value("measurement", std::string()), "measurement", kCodeSpaceGibs);
  keyword(out, meta.value("layerPeriod", std::string()), "layerPeriod", kCodeSpaceGibs);
  if (meta.contains("ongoing")) keyword(out, meta["ongoing"].get<bool>() ? "true" : "false", "ongoing", kCodeSpaceGibs);
  if (meta.contains("retentionPeriod")) keyword(out, std::to_string(meta["retentionPeriod"].get<int64_t>()), "retentionPeriod", kCodeSpaceGibs);
  if (meta.contains("daynight")) for (const auto& v : meta["daynight"]) keyword(out, v.get<std::string>(), "daynight", kCodeSpaceGibs);
  keyword(out, role(l, meta), "role", kCodeSpaceSdn);
  keyword(out, timeKind(l), "timeKind", kCodeSpaceSdn);
  keyword(out, analysis(l, meta), "analysis", kCodeSpaceSdn);
  if (l["crs"] != "3857") keyword(out, "EPSG:" + l["crs"].get<std::string>(), "polarOnly", kCodeSpaceSdn);
  if (l.contains("polar")) for (const auto& crs : l["polar"]) keyword(out, "EPSG:" + crs.get<std::string>(), "polar", kCodeSpaceSdn);
  const auto& box = l.contains("bbox") ? l["bbox"] : Json::array({-180, -90, 180, 90});
  out += "<ows:WGS84BoundingBox crs=\"urn:ogc:def:crs:OGC:2:84\"><ows:LowerCorner>" + num(box[0]) + " " + num(box[1]) +
         "</ows:LowerCorner><ows:UpperCorner>" + num(box[2]) + " " + num(box[3]) + "</ows:UpperCorner></ows:WGS84BoundingBox>";
  element(out, "ows:Identifier", id);
  metadata(out, kCodeSpaceGibs, std::string(kGibs) + "/layer-metadata/v1.0/" + id + ".json", "GIBS layer metadata");
  if (l.contains("colormap")) metadata(out, "http://earthdata.nasa.gov/gibs/metadata-type/colormap/1.3", l["colormap"], "GIBS Color Map: Data - RGB Mapping");
  if (osm) {
    std::string credit = "\xC2\xA9 OpenStreetMap contributors";
    const std::string subtitle = meta.value("subtitle", std::string());
    const size_t comma = subtitle.find("contributors,");
    if (comma != std::string::npos) credit += subtitle.substr(comma + std::strlen("contributors"));
    metadata(out, std::string(kCodeSpaceSdn) + "/license", kOsmUrl, kOdbl);
    metadata(out, std::string(kCodeSpaceSdn) + "/attribution", kOsmUrl, credit);
  } else {
    metadata(out, std::string(kCodeSpaceSdn) + "/license", kNasaLicenceUrl, kNasaLicence);
  }
  metadata(out, std::string(kCodeSpaceSdn) + "/citation", kCitationUrl, kCitation);
  if (meta.contains("conceptIds")) {
    for (const auto& c : meta["conceptIds"]) {
      const std::string value = c.value("value", std::string());
      if (value.empty()) continue;
      std::string title = c.value("shortName", std::string());
      if (c.contains("version")) title += " " + c["version"].get<std::string>();
      if (c.contains("type")) title += " (" + c["type"].get<std::string>() + ")";
      metadata(out, std::string(kCodeSpaceSdn) + "/cmr-collection", "https://cmr.earthdata.nasa.gov/search/concepts/" + value + ".html", title);
    }
  }
  if (vector && l["crs"] == "3857") metadata(out, std::string(kCodeSpaceSdn) + "/wms", std::string(kGibs) + "/wms/epsg3857/best/wms.cgi", "image/png");
  out += "<Style isDefault=\"true\"><ows:Identifier>default</ows:Identifier>";
  for (const auto& legend : l["legends"]) {
    out += "<LegendURL xlink:type=\"simple\" xlink:role=\""; esc(out, legend["role"]);
    out += "\" xlink:href=\""; esc(out, legend["href"]);
    out += "\" format=\""; esc(out, legend["format"]);
    if (!legend["width"].get<std::string>().empty()) { out += "\" width=\""; esc(out, legend["width"]); }
    if (!legend["height"].get<std::string>().empty()) { out += "\" height=\""; esc(out, legend["height"]); }
    out += "\"/>";
  }
  out += "</Style>";
  element(out, "Format", l.value("format", std::string("image/png")));
  const Json& values = domain.is_array() && domain.size() > l.value("values", Json::array()).size() ? domain : l.value("values", Json::array());
  if (l.contains("values")) {
    out += "<Dimension><ows:Identifier>Time</ows:Identifier><ows:UOM>ISO8601</ows:UOM>";
    element(out, "Default", l.value("default", std::string()));
    out += "<Current>false</Current>";
    for (const auto& v : values) element(out, "Value", v.get<std::string>());
    out += "</Dimension>";
  }
  out += "<TileMatrixSetLink>";
  element(out, "TileMatrixSet", l.value("tms", std::string()));
  out += "</TileMatrixSetLink>";
  out += "<ResourceURL resourceType=\"tile\" format=\""; esc(out, l.value("format", std::string()));
  out += "\" template=\""; esc(out, l.value("template", std::string())); out += "\"/>";
  out += "</Layer>";
}

// ── stage state ────────────────────────────────────────────────────────────
// The detail queue in kBatches non-empty batches: batch b is [b*n/K, (b+1)*n/K).
std::pair<size_t, size_t> batchRange(size_t n, int b) { return {size_t(b) * n / kBatches, size_t(b + 1) * n / kBatches}; }

bool emitBatch(Json& state, int batch) {
  const auto& queue = state["queue"];
  const auto [from, to] = batchRange(queue.size(), batch);
  NEED(to > from && to - from <= maxFrames, "A detail batch is empty or over the runtime's frame budget.");
  for (size_t i = from; i < to; ++i) {
    const auto& q = queue[i];
    NEED(output("request", request(q["u"], maxDetailBytes, 60000)) >= 0, "Could not emit a request.");
  }
  state["batch"] = batch;
  NEED(output("state", state) >= 0, "Could not emit the stage state.");
  return true;
}

// Read one batch's responses into the state: metadata fields and time domains.
bool absorbBatch(Json& state) {
  const int batch = state["batch"];
  const auto& queue = state["queue"];
  const auto [from, to] = batchRange(queue.size(), batch);
  std::vector<Response> rs;
  NEED(responses(to - from, maxDetailBytes, rs), error);
  auto& counts = state["counts"];
  for (size_t i = from; i < to; ++i) {
    const auto& q = queue[i];
    const Response& r = rs[i - from];
    const std::string kind = q["k"], id = q["id"];
    if (kind == "x") continue;
    if (r.status != 200) { counts[kind == "m" ? "metadataMissing" : "domainsMissing"] = counts.value(kind == "m" ? "metadataMissing" : "domainsMissing", 0) + 1; continue; }
    if (kind == "m") {
      const Json m = Json::parse(r.body.begin(), r.body.end(), nullptr, false);
      if (!m.is_object()) { counts["metadataMissing"] = counts.value("metadataMissing", 0) + 1; continue; }
      Json keep = Json::object();
      for (const char* key : {"title", "subtitle", "measurement", "layerPeriod"}) {
        if (m.contains(key) && m[key].is_string()) {
          std::string decoded;
          appendDecoded(decoded, m[key].get<std::string>());
          keep[key] = decoded;
        }
      }
      if (m.contains("ongoing") && m["ongoing"].is_boolean()) keep["ongoing"] = m["ongoing"];
      if (m.contains("retentionPeriod") && m["retentionPeriod"].is_number_integer()) keep["retentionPeriod"] = m["retentionPeriod"];
      if (m.contains("daynight") && m["daynight"].is_array()) keep["daynight"] = m["daynight"];
      if (m.contains("conceptIds") && m["conceptIds"].is_array()) {
        Json concepts = Json::array();
        for (const auto& c : m["conceptIds"]) {
          if (!c.is_object()) continue;
          Json one = Json::object();
          for (const char* key : {"type", "value", "shortName", "version"}) if (c.contains(key) && c[key].is_string()) one[key] = c[key];
          concepts.push_back(one);
        }
        keep["conceptIds"] = concepts;
      }
      state["meta"][id] = keep;
    } else {
      XDoc d;
      if (!parseXml(r.body, d)) { counts["domainsMissing"] = counts.value("domainsMissing", 0) + 1; continue; }
      const XNode* domains = kid(d, d.nodes[0], "Domains");
      const XNode* dim = domains ? kid(d, *domains, "DimensionDomain") : nullptr;
      const std::string all = dim ? text(d, *dim, "Domain") : std::string();
      Json values = Json::array();
      for (size_t at = 0; at < all.size();) {
        size_t comma = all.find(',', at);
        if (comma == std::string::npos) comma = all.size();
        const std::string v = trim(std::string_view(all).substr(at, comma - at));
        if (!v.empty()) values.push_back(v);
        at = comma + 1;
      }
      if (!values.empty()) state["dd"][id] = values;
    }
  }
  return true;
}
}  // namespace

// config -> the three Capabilities requests.
extern "C" int plan_capabilities() {
  const Json config = json("config");
  CHECK(config.is_object() && config.value("access", std::string()) == "anonymous", "GIBS is anonymous public data; set access to anonymous.");
  for (const auto& p : kProjections) CHECK(output("request", request(capabilitiesUrl(p), maxCapabilitiesBytes, 180000)) >= 0, "Could not emit a request.");
  return output("state", {{"stage", "capabilities"}}) < 0 ? 1 : 0;
}

// The three Capabilities documents -> the layer table, the detail queue and its first batch.
extern "C" int plan_details() {
  const Json incoming = json("state");
  CHECK(incoming.is_object() && incoming.value("stage", std::string()) == "capabilities", "The capabilities stage state is required.");
  std::vector<Response> rs;
  CHECK(responses(3, maxCapabilitiesBytes, rs), error);
  for (const auto& r : rs) CHECK(r.status == 200, "A GIBS Capabilities request did not succeed; the published catalog stays.");
  Json layers = Json::array();
  std::map<std::string, std::string> tms[3];
  Json perProjection[3];
  for (int p = 0; p < 3; ++p) {
    perProjection[p] = Json::array();
    CHECK(readCapabilities(rs[p].body, kProjections[p], perProjection[p], tms[p]), error);
  }
  // EPSG:3857 is the globe's projection: every layer it holds is drawable.
  std::map<std::string, size_t> index;
  for (auto& l : perProjection[0]) { index[l["id"]] = layers.size(); layers.push_back(std::move(l)); }
  // A layer may name a TileMatrixSet its document never defines (GIBS
  // EPSG:3413 and EPSG:3031 link "1.5km" without a definition, 2026-10-13).
  // The link is kept as GIBS states it and the layer is counted.
  Json tmsOut = Json::object();
  size_t undefinedSets = 0;
  for (const auto& l : layers) {
    const std::string set = l.value("tms", std::string());
    if (tms[0].count(set)) tmsOut[set] = tms[0][set];
    else ++undefinedSets;
  }
  // The polar documents: a layer 3857 also holds is marked; one it lacks is
  // polar-only, with its TileMatrixSet renamed per projection and its tile
  // template made literal (the renamed set is not a GIBS path segment).
  for (int p = 1; p < 3; ++p) {
    for (auto& l : perProjection[p]) {
      const std::string id = l["id"];
      const auto found = index.find(id);
      if (found != index.end()) {
        auto& known = layers[found->second];
        if (!known.contains("polar")) known["polar"] = Json::array();
        known["polar"].push_back(kProjections[p].crs);
        continue;
      }
      const std::string original = l.value("tms", std::string());
      const std::string renamed = std::string("EPSG") + kProjections[p].crs + "_" + original;
      l["template"] = replaceAll(l.value("template", std::string()), "{TileMatrixSet}", original);
      l["tms"] = renamed;
      if (tms[p].count(original)) {
        std::string definition = tms[p][original];
        const std::string from = "<ows:Identifier>" + original + "</ows:Identifier>";
        const size_t at = definition.find(from);
        CHECK(at != std::string::npos, "A polar TileMatrixSet has no identifier.");
        definition.replace(at, from.size(), "<ows:Identifier>" + renamed + "</ows:Identifier>");
        tmsOut[renamed] = definition;
      } else {
        ++undefinedSets;
      }
      index[id] = layers.size();
      layers.push_back(std::move(l));
    }
  }
  CHECK(!layers.empty(), "GIBS listed no layers; the published catalog stays.");
  // Metadata for every layer; the whole time domain where Capabilities stops at 100 values.
  Json queue = Json::array();
  size_t truncated = 0;
  for (const auto& l : layers) {
    const std::string id = l["id"];
    queue.push_back({{"k", "m"}, {"id", id}, {"u", std::string(kGibs) + "/layer-metadata/v1.0/" + id + ".json"}});
    // Subdaily layers keep the 100 newest values GIBS lists (months of
    // 10-minute or hourly steps); their full domains run to tens of thousands
    // of values each, and GIBS snaps a request inside a step to that step.
    const std::string kind = timeKind(l);
    if (l.contains("values") && l["values"].size() >= 100 && l.contains("domains") && kind != "SUBDAILY" && kind != "GRANULE") {
      queue.push_back({{"k", "d"}, {"id", id}, {"u", l["domains"]}});
      ++truncated;
    }
  }
  while (queue.size() < size_t(kBatches)) queue.push_back({{"k", "x"}, {"id", ""}, {"u", queue[0]["u"]}});
  CHECK((queue.size() + kBatches - 1) / kBatches <= maxFrames, "More detail requests than the stages can carry; raise kBatches.");
  Json state = {{"stage", "details"}, {"layers", layers}, {"tms", tmsOut}, {"queue", queue}, {"meta", Json::object()},
                {"dd", Json::object()}, {"counts", {{"layers", layers.size()}, {"truncatedTime", truncated}, {"undefinedTileMatrixSets", undefinedSets}}}};
  size_t polarOnly = 0;
  for (const auto& l : layers) if (l["crs"] != "3857") ++polarOnly;
  state["counts"]["polarOnly"] = polarOnly;
  state["counts"]["drawable"] = layers.size() - polarOnly;
  return emitBatch(state, 0) ? 0 : fail(error);
}

// One detail batch in, the next one out.
extern "C" int advance() {
  Json state = json("state");
  CHECK(state.is_object() && state.value("stage", std::string()) == "details" && state.contains("batch"), "A detail stage state is required.");
  CHECK(absorbBatch(state), error);
  const int next = state["batch"].get<int>() + 1;
  CHECK(next <= kBatches - 1, "advance ran past the planned batches.");
  return emitBatch(state, next) ? 0 : fail(error);
}

// The last batch in, the merged Capabilities document out (one file frame) with its build job.
extern "C" int build_catalog() {
  Json state = json("state");
  CHECK(state.is_object() && state.value("stage", std::string()) == "details" && state.contains("batch"), "A detail stage state is required.");
  CHECK(state["batch"].get<int>() == kBatches - 1, "build_catalog runs after the last detail batch.");
  CHECK(absorbBatch(state), error);
  auto layers = state["layers"];
  std::sort(layers.begin(), layers.end(), [](const Json& a, const Json& b) { return a["id"].get<std::string>() < b["id"].get<std::string>(); });
  std::string xml;
  xml.reserve(8u * 1024u * 1024u);
  xml += "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
  xml += "<Capabilities xmlns=\"http://www.opengis.net/wmts/1.0\" xmlns:ows=\"http://www.opengis.net/ows/1.1\" "
         "xmlns:xlink=\"http://www.w3.org/1999/xlink\" xmlns:gml=\"http://www.opengis.net/gml\" version=\"1.0.0\">";
  xml += "<ows:ServiceIdentification><ows:Title>NASA Global Imagery Browse Services for EOSDIS</ows:Title>"
         "<ows:Abstract>Every GIBS visualization layer: the EPSG:3857 service with the EPSG:3413 and EPSG:3031 polar-only "
         "layers, the GIBS layer metadata and each layer's full time domain.</ows:Abstract>"
         "<ows:ServiceType>OGC WMTS</ows:ServiceType><ows:ServiceTypeVersion>1.0.0</ows:ServiceTypeVersion>"
         "<ows:Fees>none</ows:Fees><ows:AccessConstraints>";
  esc(xml, kCitation);
  xml += "</ows:AccessConstraints></ows:ServiceIdentification>";
  xml += "<ows:ServiceProvider><ows:ProviderName>National Aeronautics and Space Administration</ows:ProviderName>"
         "<ows:ProviderSite xlink:href=\"https://earthdata.nasa.gov/gibs/\"/></ows:ServiceProvider><Contents>";
  const Json none = Json::object();
  for (const auto& l : layers) {
    const std::string id = l["id"];
    const Json& meta = state["meta"].contains(id) ? state["meta"][id] : none;
    const Json& domain = state["dd"].contains(id) ? state["dd"][id] : none;
    writeLayer(xml, l, meta, domain);
  }
  for (const auto& [id, definition] : state["tms"].items()) xml += definition.get<std::string>();
  xml += "</Contents><ServiceMetadataURL xlink:href=\"";
  xml += kGibs;
  xml += "/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml\"/></Capabilities>\n";

  const auto* bytes = reinterpret_cast<const uint8_t*>(xml.data());
  const std::string sha = ephem::sha256_hex(bytes, xml.size());
  std::vector<uint8_t> frame(4 + std::strlen(catalogFile) + xml.size());
  const uint32_t nameLength = uint32_t(std::strlen(catalogFile));
  std::memcpy(frame.data(), &nameLength, 4);
  std::memcpy(frame.data() + 4, catalogFile, nameLength);
  std::memcpy(frame.data() + 4 + nameLength, xml.data(), xml.size());
  CHECK(plugin_push_output_ex("file", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1, frame.data(), frame.size()) >= 0,
        "Could not emit the catalog file.");
  auto counts = state["counts"];
  counts["metadata"] = state["meta"].size();
  counts["extendedTime"] = state["dd"].size();
  const Json job = {{"provider_id", providerId}, {"source_name", sourceName},
                    {"files", Json::array({{{"file", catalogFile}, {"bytes", xml.size()}, {"sha256", sha}}})}, {"counts", counts}};
  return output("job", job) < 0 ? 1 : 0;
}

// job + receipt + the IPFS add result -> one $PNM naming the catalog, meta and report.
extern "C" int announce_catalog() {
  const Json job = json("job"), receipt = json("receipt");
  CHECK(job.is_object() && job.contains("files") && job["files"].is_array() && job["files"].size() == 1, "The build job is required.");
  CHECK(receipt.is_object() && receipt.contains("retrieved_at_ms") && receipt["retrieved_at_ms"].is_number_integer(), "Invalid retrieval epoch.");
  const auto peer = receipt.value("producer_peer_id", std::string());
  CHECK(!peer.empty() && peer.size() <= 128, "An authenticated producer peer ID is required.");
  const auto added = frames("added");
  CHECK(added.size() == 1, "The catalog must be added to IPFS before it is announced.");
  const Json a = Json::parse(added[0]->payload, added[0]->payload + added[0]->payload_length, nullptr, false);
  CHECK(a.is_object() && a.value("name", std::string()) == catalogFile && a.contains("cid") && a["cid"].is_string(), "An IPFS add result is malformed.");
  const auto& file = job["files"][0];
  CHECK(a.value("bytes", int64_t(-1)) == file["bytes"].get<int64_t>(), "The added file's length differs from the built file.");
  const int64_t ms = receipt["retrieved_at_ms"].get<int64_t>();
  const int64_t sec = ms / 1000, day = sec / 86400, rem = sec % 86400;
  const int64_t z = day + 719468, era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = unsigned(z - era * 146097), yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100), mp = (5 * doy + 2) / 153;
  const unsigned dd = doy - (153 * mp + 2) / 5 + 1, mm = mp < 10 ? mp + 3 : mp - 9;
  const int64_t yy = int64_t(yoe) + era * 400 + (mm <= 2);
  char when[32];
  std::snprintf(when, sizeof when, "%04lld-%02u-%02uT%02lld:%02lld:%02lldZ", (long long)yy, mm, dd, (long long)(rem / 3600),
                (long long)(rem % 3600 / 60), (long long)(rem % 60));
  const std::string cid = a["cid"], sha = file["sha256"];
  flatbuffers::FlatBufferBuilder b(256);
  const auto address = b.CreateString("/ipfs/" + cid);
  const auto timestamp = b.CreateString(when);
  const auto cidOffset = b.CreateString(cid);
  const auto name = b.CreateString(catalogFile);
  const auto fileId = b.CreateString(std::string(providerId) + ":" + sourceName + ":" + catalogFile + ":" + sha);
  PNMBuilder pnm(b);
  pnm.add_MULTIFORMAT_ADDRESS(address);
  pnm.add_PUBLISH_TIMESTAMP(timestamp);
  pnm.add_CID(cidOffset);
  pnm.add_FILE_NAME(name);
  pnm.add_FILE_ID(fileId);
  FinishSizePrefixedPNMBuffer(b, pnm.Finish());
  const Json meta = {{"schema", "PNM.fbs"}, {"batch_id", sha}, {"provider_id", providerId}, {"source_name", sourceName},
                     {"source_url", std::string(kGibs) + "/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml"}, {"source_peer", peer},
                     {"reconcile", "current"}, {"origin_id", "gibs.earthdata.nasa.gov"},
                     {"origin_name", "NASA Global Imagery Browse Services (GIBS)"}, {"dataset_id", "nasa-gibs/layer-catalog"},
                     {"terms_url", kNasaLicenceUrl}, {"citation", kCitation},
                     {"licence", std::string(kNasaLicence) + "; layers derived from OpenStreetMap: " + kOdbl + ", \xC2\xA9 OpenStreetMap contributors"}};
  const Json report = {{"files", 1}, {"cid", cid}, {"batch_id", sha}, {"counts", job.value("counts", Json::object())}, {"retrieved_at", when}};
  if (output("meta", meta) < 0 || output("report", report) < 0) return 1;
  return plugin_push_output_ex("records", "PNM.fbs", "$PNM", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "PNM", 0, 0, b.GetBufferPointer(), b.GetSize()) < 0
             ? 1
             : 0;
}
