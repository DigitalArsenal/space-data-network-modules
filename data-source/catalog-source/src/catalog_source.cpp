#include "space_data_module_invoke.h"
#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>

using Json = nlohmann::json;
namespace {
constexpr size_t kMaxBytes = 128 * 1024 * 1024;
constexpr size_t kMaxRows = 250000;
std::string trim(const std::string& value) {
  const auto first = value.find_first_not_of(" \t\r\n");
  return first == std::string::npos ? "" : value.substr(first, value.find_last_not_of(" \t\r\n")-first+1);
}
std::vector<std::string> split(const std::string& value, char separator) {
  std::vector<std::string> result;
  for (size_t start = 0;;) {
    const auto end = value.find(separator, start);
    result.push_back(trim(value.substr(start, end == std::string::npos ? end : end-start)));
    if (end == std::string::npos) return result;
    start = end+1;
  }
}
bool unsignedNumber(const std::string& value, uint32_t& out) {
  if (value.empty() || value.size() > 10 || !std::all_of(value.begin(), value.end(), [](char c) { return c >= '0' && c <= '9'; })) return false;
  const auto number = std::strtoull(value.c_str(), nullptr, 10);
  if (!number || number > UINT32_MAX) return false;
  out = static_cast<uint32_t>(number); return true;
}
bool scalar(const std::string& value, double& out) {
  if (value.empty() || value == "-" || value == "?") return false;
  char* end = nullptr; errno = 0;
  out = std::strtod(value.c_str(), &end);
  return errno != ERANGE && end == value.c_str()+value.size() && std::isfinite(out);
}
bool cospar(const std::string& value) {
  if (value.size() < 9 || value.size() > 11 || value[4] != '-') return false;
  for (size_t i=0; i<value.size(); ++i) {
    if (i == 4) continue;
    if (i < 8 ? value[i] < '0' || value[i] > '9' : value[i] < 'A' || value[i] > 'Z') return false;
  }
  return true;
}
std::string fullDate(const std::string& value) {
  int year=0, day=0, used=0; char month[4]={};
  if (std::sscanf(value.c_str(), "%d %3s %d%n", &year, month, &day, &used) != 3 || !trim(value.substr(used)).empty()) return "";
  const std::vector<std::string> months={"Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"};
  const auto found = std::find(months.begin(), months.end(), month);
  if (found == months.end() || year < 1 || year > 9999) return "";
  const int index = static_cast<int>(found-months.begin());
  const int days[]={31,28,31,30,31,30,31,31,30,31,30,31};
  const int maximum = days[index] + (index == 1 && year%4 == 0 && (year%100 != 0 || year%400 == 0));
  if (day < 1 || day > maximum) return "";
  char output[11]; std::snprintf(output, sizeof(output), "%04d-%02d-%02d", year, index+1, day);
  return output;
}
int fail(const std::string& message) { plugin_set_error("invalid-catalog-source", message.c_str()); return 1; }
bool tleNumber(const std::string& value, uint32_t& out) {
  if (value.size() != 5) return false;
  if (value[0] >= '0' && value[0] <= '9') return unsignedNumber(value, out);
  // Space-Track Alpha-5: A=10 ... Z=33, omitting I and O.
  const std::string alphabet="ABCDEFGHJKLMNPQRSTUVWXYZ";
  const auto prefix=alphabet.find(value[0]);
  if (prefix == std::string::npos || !std::all_of(value.begin()+1,value.end(),[](char c){return c>='0' && c<='9';})) return false;
  out=static_cast<uint32_t>((prefix+10)*10000+std::strtoul(value.c_str()+1,nullptr,10)); return true;
}
bool tleLine(const std::string& line, char kind) {
  if (line.size()!=69 || line[0]!=kind || line[1]!=' ' || line[68]<'0' || line[68]>'9') return false;
  unsigned sum=0;
  for (size_t i=0;i<68;++i) {
    const auto c=line[i];
    if (c<32 || c>126) return false;
    if (c>='0' && c<='9') sum+=c-'0'; else if (c=='-') ++sum;
  }
  return sum%10 == static_cast<unsigned>(line[68]-'0');
}
const plugin_input_frame_t* catalogInput(Json& meta) {
  const plugin_input_frame_t* source=nullptr;
  bool hasMeta=false;
  if (plugin_get_input_count()>2) return nullptr;
  for (uint32_t i=0;i<plugin_get_input_count();++i) {
    const auto* frame=plugin_get_input_frame(i);
    if (!frame || !frame->port_id || !frame->payload) return nullptr;
    if (!std::strcmp(frame->port_id,"source")) {
      if (source) return nullptr;
      source=frame;
    } else if (!std::strcmp(frame->port_id,"meta") && !hasMeta && frame->payload_length<=65536) {
      hasMeta=true; meta=Json::parse(frame->payload,frame->payload+frame->payload_length,nullptr,false);
      if (!meta.is_object()) return nullptr;
    } else return nullptr;
  }
  if (!source || source->payload_length>kMaxBytes) return nullptr;
  if (hasMeta) {
    if (!meta.contains("_source_text_sha256") || !meta["_source_text_sha256"].is_string() ||
        meta["_source_text_sha256"]!=ephem::sha256_hex(source->payload,source->payload_length)) return nullptr;
    meta.erase("_source_text_sha256");
  }
  return source;
}
int pushCatalogMeta(const Json& meta) {
  if (!meta.is_object()) return 0;
  const auto bytes=meta.dump();
  return plugin_push_output_ex("meta",nullptr,nullptr,PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,nullptr,0,1,
    reinterpret_cast<const uint8_t*>(bytes.data()),static_cast<uint32_t>(bytes.size()))<0 ? 1 : 0;
}
}

extern "C" int parse_gcat(void) {
  Json sourceMeta;
  const auto* input = catalogInput(sourceMeta);
  if (!input || !input->port_id || std::strcmp(input->port_id, "source") || !input->payload || !input->payload_length || input->payload_length > kMaxBytes) return fail("The source must be a bounded GCAT TSV edition.");
  const std::string source(reinterpret_cast<const char*>(input->payload), input->payload_length);
  if (source.find('\0') != std::string::npos) return fail("GCAT text contains an embedded NUL.");
  std::map<std::string,size_t> columns;
  std::set<uint32_t> seen;
  std::vector<uint8_t> output;
  Json nativeKeys=Json::array();
  size_t lineNumber=0, columnCount=0, omittedDesignators=0, omittedDates=0, unnumbered=0;
  std::string update;
  for (size_t start=0; start < source.size();) {
    const auto end=source.find('\n', start);
    auto line=source.substr(start, end == std::string::npos ? end : end-start);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    start=end == std::string::npos ? source.size() : end+1; ++lineNumber;
    if (trim(line).empty()) continue;
    if (line.size() > 1024*1024) return fail("GCAT row exceeds its byte budget.");
    if (columns.empty()) {
      auto names=split(line, '\t');
      if (names[0] == "#JCAT") names[0]="JCAT";
      for (size_t i=0; i<names.size(); ++i) if (!columns.emplace(names[i],i).second) return fail("Duplicate GCAT column name.");
      for (const auto* name : {"JCAT","Satcat","Name","Piece","Type","LDate","Primary","Perigee","PF","Apogee","AF","Inc","IF"}) if (!columns.count(name)) return fail(std::string("GCAT column missing: ")+name);
      columnCount=names.size(); continue;
    }
    if (line[0] == '#') { if (line.rfind("# Updated ",0) == 0) update=line.substr(10); continue; }
    const auto values=split(line, '\t');
    if (values.size() != columnCount) return fail("GCAT row "+std::to_string(lineNumber)+" has a different column count.");
    const auto cell=[&](const char* name)->std::string { const auto found=columns.find(name); return found == columns.end() ? "" : values[found->second]; };
    const auto native=cell("JCAT"); uint32_t norad=0, nativeNumber=0;
    // S identifiers are source-native keys. Even these editions contain NNA
    // (no assigned SATCAT number): never infer a NORAD number from the JCAT.
    // Auxiliary objects can share a SATCAT number; those need a richer identity contract.
    if (native.empty() || native[0] != 'S' || !unsignedNumber(native.substr(1),nativeNumber)) return fail("Use GCAT satcat or satcat100k; this edition contains a nonstandard object identifier.");
    if (cell("Satcat") == "NNA") ++unnumbered;
    else if (!unsignedNumber(cell("Satcat"),norad) || nativeNumber != norad) return fail("GCAT JCAT and SATCAT identifiers disagree.");
    if (!seen.insert(nativeNumber).second) return fail("Duplicate GCAT native object identifier in one edition.");
    if (seen.size() > kMaxRows) return fail("GCAT edition exceeds 250,000 objects.");
    flatbuffers::FlatBufferBuilder b(256);
    const auto field=[&](const std::string& value) { return value.empty() || value == "-" || value == "?" ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(value); };
    const auto name=field(cell("Name"));
    const auto piece=cell("Piece"); const auto designator=field(cospar(piece) ? piece : "");
    if (!piece.empty() && piece != "-" && !cospar(piece)) ++omittedDesignators;
    const auto launch=fullDate(cell("LDate")); const auto launchDate=field(launch);
    if (launch.empty() && cell("LDate") != "-") ++omittedDates;
    const auto primary=field(cell("Primary"));
    CATBuilder record(b);
    record.add_OBJECT_NAME(name); record.add_OBJECT_ID(designator); record.add_NORAD_CAT_ID(norad);
    record.add_LAUNCH_DATE(launchDate); record.add_ORBIT_CENTER(primary);
    const auto type=cell("Type");
    if (!type.empty()) {
      if (type[0] == 'P') record.add_OBJECT_TYPE(spaceObjectClass::PAYLOAD);
      else if (type[0] == 'R') record.add_OBJECT_TYPE(spaceObjectClass::ROCKET_BODY);
      else if (type[0] == 'D') record.add_OBJECT_TYPE(spaceObjectClass::DEBRIS);
    }
    double value=0;
    if (cell("PF") != "?" && scalar(cell("Perigee"),value)) record.add_PERIGEE(value);
    if (cell("AF") != "?" && scalar(cell("Apogee"),value)) record.add_APOGEE(value);
    if (cell("IF") != "?" && scalar(cell("Inc"),value)) record.add_INCLINATION(value);
    // GCAT Status describes an orbital phase, not spacecraft operability.
    // GCAT Bus and State use distinct vocabularies; do not invent CAT joins.
    b.FinishSizePrefixed(record.Finish(), "$CAT");
    if (output.size()+b.GetSize() > kMaxBytes) return fail("CAT output exceeds its byte budget.");
    output.insert(output.end(),b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()); nativeKeys.push_back(native);
  }
  if (seen.empty()) return fail("No standard GCAT objects were supplied.");
  const auto report=Json({{"version",1},{"records",seen.size()},{"nativeKeys",nativeKeys},{"sourceUpdate",update},
    {"unrepresentedDesignators",omittedDesignators},{"unrepresentedLaunchDates",omittedDates},{"unnumberedObjects",unnumbered}}).dump();
  if (plugin_push_output_ex("report", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
      reinterpret_cast<const uint8_t*>(report.data()),static_cast<uint32_t>(report.size())) < 0) return 1;
  if (plugin_push_output_ex("catalog", "CAT.fbs", "$CAT", PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER, "CAT", 0, 0,
    output.data(),static_cast<uint32_t>(output.size())) < 0) return 1;
  return pushCatalogMeta(sourceMeta);
}

extern "C" int parse_mccants_tle_catalog(void) {
  Json sourceMeta;
  const auto* input=catalogInput(sourceMeta);
  if (!input || !input->port_id || std::strcmp(input->port_id,"source") || !input->payload || !input->payload_length || input->payload_length>kMaxBytes) return fail("The source must be a bounded, decompressed McCants TLE edition.");
  const std::string source(reinterpret_cast<const char*>(input->payload),input->payload_length);
  if (source.find('\0')!=std::string::npos) return fail("McCants text contains an embedded NUL.");
  std::string name, first;
  std::set<uint32_t> seen;
  std::vector<uint8_t> output;
  Json nativeKeys=Json::array();
  size_t unnumbered=0, omittedDesignators=0;
  for (size_t start=0;start<source.size();) {
    const auto end=source.find('\n',start);
    auto line=source.substr(start,end==std::string::npos ? end : end-start);
    if (!line.empty() && line.back()=='\r') line.pop_back();
    start=end==std::string::npos ? source.size() : end+1;
    if (trim(line).empty()) continue;
    if (line.size()>1024) return fail("McCants row exceeds its byte budget.");
    if (line.rfind("1 ",0)==0) {
      if (!first.empty() || !tleLine(line,'1')) return fail("Invalid or out-of-order TLE line 1.");
      first=line; continue;
    }
    if (line.rfind("2 ",0)!=0) {
      if (!first.empty() || !name.empty()) return fail("Unexpected text between McCants element records.");
      name=trim(line.rfind("0 ",0)==0 ? line.substr(2) : line);
      if (name.empty()) return fail("An empty name line was supplied.");
      continue;
    }
    uint32_t number=0, secondNumber=0;
    if (first.empty() || !tleLine(line,'2') || !tleNumber(first.substr(2,5),number) || !tleNumber(line.substr(2,5),secondNumber) || number!=secondNumber) return fail("TLE lines have invalid checksums or mismatched object identifiers.");
    if (!seen.insert(number).second) return fail("Duplicate McCants object identifier in one edition.");
    if (seen.size()>kMaxRows) return fail("McCants edition exceeds 250,000 objects.");
    // SeeSat-L's 90000..99999 analyst IDs are source-native, not USSF
    // catalog numbers. Their launch designators may also be synthetic. Keep
    // both out of global identity fields so stacking cannot falsely join them.
    const bool analyst=number>=90000 && number<=99999;
    if (analyst) ++unnumbered;
    const auto piece=trim(first.substr(9,8));
    std::string designator;
    if (!analyst && piece.size()>=6 && piece.size()<=8 && std::all_of(piece.begin(),piece.begin()+5,[](char c){return c>='0' && c<='9';})) {
      const unsigned year=std::strtoul(piece.substr(0,2).c_str(),nullptr,10);
      designator=std::to_string((year>=57 ? 1900 : 2000)+year)+"-"+piece.substr(2);
      if (!cospar(designator) || piece.substr(2,3)=="000") designator.clear();
    }
    if (!piece.empty() && designator.empty()) ++omittedDesignators;
    flatbuffers::FlatBufferBuilder b(256);
    const auto label=name.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(name);
    const auto id=designator.empty() ? flatbuffers::Offset<flatbuffers::String>() : b.CreateString(designator);
    CATBuilder record(b);
    record.add_OBJECT_NAME(label); record.add_OBJECT_ID(id);
    if (!analyst) record.add_NORAD_CAT_ID(number);
    // This adapter extracts catalog identity only. The original source's
    // element epoch/model remains a separate orbital-state product.
    b.FinishSizePrefixed(record.Finish(),"$CAT");
    if (output.size()+b.GetSize()>kMaxBytes) return fail("CAT output exceeds its byte budget.");
    output.insert(output.end(),b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());
    nativeKeys.push_back(first.substr(2,5)); name.clear(); first.clear();
  }
  if (!name.empty() || !first.empty()) return fail("McCants edition ends with an incomplete element record.");
  if (seen.empty()) return fail("No McCants element records were supplied.");
  const auto report=Json({{"version",1},{"records",seen.size()},{"nativeKeys",nativeKeys},{"unnumberedObjects",unnumbered},{"unrepresentedDesignators",omittedDesignators}}).dump();
  if (plugin_push_output_ex("report",nullptr,nullptr,PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,nullptr,0,1,reinterpret_cast<const uint8_t*>(report.data()),static_cast<uint32_t>(report.size()))<0) return 1;
  if (plugin_push_output_ex("catalog","CAT.fbs","$CAT",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"CAT",0,0,output.data(),static_cast<uint32_t>(output.size()))<0) return 1;
  return pushCatalogMeta(sourceMeta);
}
