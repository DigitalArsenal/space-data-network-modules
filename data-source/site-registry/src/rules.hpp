// The lifecycle rules: what a Wikidata item, a Wikipedia infobox and an
// article's prose state about a site, ported from the reviewed JavaScript
// tools of the site-status audit (SpaceAware-UI src/tools/facility-status,
// verified 2026-10-13 rounds 1-5) so the weekly lane decides as they did.
//
// A rule returns evidence: a status, the date it took effect (ISO 8601 at the
// source's precision, "" when none) and the field it was read from (a closed
// vocabulary: a Wikidata property, "class:<QID>", "description", "label",
// "infobox:<parameter>"). Prose statements never decide; they feed the run
// report's review queue.
#pragma once
#include <map>
#include <set>
#include <string>
#include <vector>

#include "regex.hpp"
#include "text.hpp"

namespace sr {

enum Status : int8_t {
  UNSPECIFIED = 0, PLANNED, UNDER_CONSTRUCTION, CONSTRUCTION_SUSPENDED, OPERATING, LONG_TERM_SHUTDOWN,
  PERMANENT_SHUTDOWN, DECOMMISSIONING, DECOMMISSIONED, CANCELLED, UNVERIFIED,
};
inline const char* statusName(int s) {
  static const char* names[] = {"UNSPECIFIED", "PLANNED", "UNDER_CONSTRUCTION", "CONSTRUCTION_SUSPENDED", "OPERATING", "LONG_TERM_SHUTDOWN",
                                "PERMANENT_SHUTDOWN", "DECOMMISSIONING", "DECOMMISSIONED", "CANCELLED", "UNVERIFIED"};
  return s >= 0 && s <= 10 ? names[s] : "UNSPECIFIED";
}
inline int statusFromName(std::string_view n) {
  for (int s = 0; s <= 10; ++s) if (n == statusName(s)) return s;
  return UNSPECIFIED;
}
// How far along the lifecycle a status is (facilities/lifecycle.ts LIFECYCLE_RANK).
inline int rankOf(int s) {
  static const int ranks[] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 8, 0};
  return s >= 0 && s <= 10 ? ranks[s] : 0;
}
inline bool restartState(int s) { return s == UNDER_CONSTRUCTION || s == OPERATING || s == LONG_TERM_SHUTDOWN; }
// The views (lifecycle.ts FACILITY_VIEWS).
inline bool currentView(int s) { return s == OPERATING || s == LONG_TERM_SHUTDOWN || s == UNDER_CONSTRUCTION || s == UNSPECIFIED || s == UNVERIFIED; }
inline bool historicView(int s) { return s == PERMANENT_SHUTDOWN || s == DECOMMISSIONING || s == DECOMMISSIONED; }
inline bool prospectiveView(int s) { return s == PLANNED || s == CONSTRUCTION_SUSPENDED || s == CANCELLED; }

struct Stated {
  int status = UNSPECIFIED;
  std::string date;
  std::string field;
};

// ── Wikidata ───────────────────────────────────────────────────────────────
// The facts of one item the rules read (wikidata.mjs slim()).
struct Claim { std::string rank; std::string value; std::string since; };
struct Item {
  std::string qid;
  int64_t revision = 0;
  std::map<std::string, std::string> labels, descriptions;  // language -> text
  std::map<std::string, std::string> sitelinks;              // wiki ("enwiki") -> title
  std::map<std::string, std::vector<Claim>> claims;          // P5817, end and start properties
  std::vector<std::string> classes, partOf, successors;      // successors: "P1366 Q123"
  std::vector<std::string> operators, owners, countries, adminUnits, websites;
  std::string geonamesId;
  double lat = NAN, lon = NAN;
  double elevationM = NAN;    // P2044, metres
  double nominalPowerMW = NAN;  // P2109, megawatts
};

inline const std::map<std::string, int>& stateOfUse() {
  static const std::map<std::string, int> m = {
      {"Q55654238", OPERATING}, {"Q104664889", PERMANENT_SHUTDOWN}, {"Q63065035", PERMANENT_SHUTDOWN}, {"Q110435753", PERMANENT_SHUTDOWN},
      {"Q1938123", DECOMMISSIONING}, {"Q11639308", PERMANENT_SHUTDOWN}, {"Q896586", DECOMMISSIONED}, {"Q811683", PLANNED},
      {"Q2647254", PLANNED}, {"Q97317113", PLANNED}, {"Q12377751", UNDER_CONSTRUCTION}, {"Q30108381", CANCELLED},
  };
  return m;
}
inline const std::vector<std::string>& endProperties() { static const std::vector<std::string> v{"P730", "P3999", "P576", "P582"}; return v; }
inline const std::vector<std::string>& startProperties() { static const std::vector<std::string> v{"P729", "P1619", "P571"}; return v; }
inline bool isEndProperty(const std::string& p) { for (const auto& e : endProperties()) if (e == p) return true; return false; }
inline const std::vector<std::string>& successorProperties() { static const std::vector<std::string> v{"P1366", "P156", "P7888"}; return v; }
inline bool isSuccessorProperty(const std::string& p) { for (const auto& e : successorProperties()) if (e == p) return true; return false; }

struct StoppedClass { const char* qid; int status; };
inline const std::vector<StoppedClass>& stoppedClasses() {
  static const std::vector<StoppedClass> v{{"Q74047", PERMANENT_SHUTDOWN}, {"Q109607", PERMANENT_SHUTDOWN}, {"Q839954", PERMANENT_SHUTDOWN},
                                           {"Q15893266", PERMANENT_SHUTDOWN}, {"Q19860854", DECOMMISSIONED}, {"Q21514702", CANCELLED},
                                           {"Q33506", PERMANENT_SHUTDOWN}, {"Q1569871", PERMANENT_SHUTDOWN}};
  return v;
}

// The sets (network codes) the rules treat alike.
inline bool reactorSet(const std::string& c) { return c == "NUCL" || c == "NUCF" || c == "NPP"; }
inline bool museumSet(const std::string& c) { return c == "NUCL" || c == "NUCF" || c == "NPP" || c == "STORE" || c == "CHEMP"; }
inline bool articleSet(const std::string& c) { return museumSet(c); }
inline bool organisationSet(const std::string& c) { return c == "NUCL" || c == "RSCH"; }
// The description rule of a set ("" when its descriptions are not read).
inline std::string descriptionRule(const std::string& c) {
  if (c == "NUCL" || c == "NUCF" || c == "NPP") return "reactor";
  if (c == "STORE") return "storage";
  if (c == "CHEMP") return "plant";
  if (c == "RSCH") return "organisation";
  return "";
}

struct Patterns {
  rx::Regex formerReactor{R"(\b(former|defunct|decommissioned|dismantled|shut ?down|closed)\b|\behemalig|\bstillgelegt|\bhistorisch|\bancien\b|\bdémantel|\barrêté|\bvoormalig|\bbuiten gebruik|(?<!\p{L})(?:défunte?|dawn[aey]|byłe?[aj]?|bývalá|bývalý|bývalé|odstaven[áéý]|antigu[ao]|antiga|desmantelad[ao]|cerrad[ao])(?!\p{L})|бывш|закрыт|выведен|колишн|закрит)"};
  rx::Regex formerStorage{R"(\b(former|disused|abandoned|ehemalige?[nrs]?|ancienne?|voormalige?|dawn[aey]|бывш\p{L}*|колишн\p{L}*)\s+(?:[\p{L}.-]+\s+){0,5}?[\p{L}-]*?(depot|magazine|ammunition|munitions?\w*|powder|poudrière|lager|niederlage|storage|store|bunker|arsenal)|(?<!\p{L})ruins?\s+(?:[\p{L}-]+\s+){0,2}?(site|place|building|monument|military facility|ammunition magazine|magazine|district)(?!\p{L})|(?<!\p{L})(concentration camp|ghost town)(?!\p{L}))"};
  rx::Regex formerPlant{R"((?<!\p{L})(former|disused|abandoned|derelict|defunct|demolished|dismantled|ruins?|remains|earlier|ehemalige?[nrs]?|stillgelegte?[nrs]?|abgerissene?[nrs]?|historische?[nrs]?|ancienne?|antiga|antigu[ao]|ex|voormalige?|dawn[aey]|бывш\p{L}*|колишн\p{L}*)(?!\p{L}))"};
  rx::Regex formerOrganisation{R"(^(?:[\p{L}-]+\s+){0,1}?(former|defunct|disbanded|dissolved|ehemalige?[nrs]?|aufgelöste?[nrs]?|voormalige?|opgeheven|ancienne?|défunte?|antigu[ao]|antiga|extint[ao]|disuelt[ao]|soppress[ao]|dawn[aey]|byłe?[aj]?|zlikwidowan[aey]?|bývalá|bývalý|bývalé|zaniklá|zaniklý|zaniklé|tidigare|före detta|бывш\p{L}*|упразднённ\p{L}*|ликвидированн\p{L}*|колишн\p{L}*)(?!\p{L})|(?<!\p{L})(?:and|und) (?:former|ehemalige?[nrs]?) (?:lab|laboratory|research|Labor|Forschung)|(?<!\p{L})(?:GDR|DDR)(?!\p{L}))"};
  // A description that gives the body's new name ("now called") does not close it; a merger
  // ("now part of") does: the body the record names no longer exists.
  rx::Regex organisationNow{R"((?<!\p{L})(?:now|today|currently|heute|jetzt|aujourd'hui|actuellement|désormais|nu|thans|ahora|actualmente|oggi|obecnie|nyní|dnes|сейчас|ныне|теперь|зараз|нині)\s+(?:called|named|known|renamed|genannt|benannt|umbenannt|appelée?|nommée?|renommée?|llamad[ao]|denominad[ao]|renombrad[ao]|chiamat[ao]|denominat[ao]|genaamd|hernoemd|nazywa\p{L}*|nazývá\p{L}*|называ\p{L}*|переименован\p{L}*|перейменован\p{L}*)(?!\p{L}))"};
  rx::Regex neverRan{R"((?<!\p{L})(never (?:used|built|completed|operated|realized|realised)|not realized|not realised|unrealized|unrealised|planned but not|nie (?:realisiert|gebaut|in betrieb)|nicht realisiert|jamais (?:construit|réalisé|mis en service))(?!\p{L}))"};

  // Wikipedia infoboxes.
  rx::Regex infoboxStart{R"(\{\{\s*(Infobox|Infobox_|Kernkraftwerk|Infobox Kernkraftwerk|Infobox Centrale|Карточка|Ficha|Infobox reattore|Kerncentrale))"};
  rx::Regex prospective{R"(frühestens|voraussicht|geplant|noch nicht|not yet|planned|expected|prévu|envisag|previsto|\?)"};
  rx::Regex dateTemplate{R"(\{\{\s*(start date(?: and (?:age|years ago))?|end date|date|dts)\s*\|([^}]*)\}\})"};
  rx::Regex isoDate{R"(\b(1[89]\d\d|20\d\d)-(\d\d)-(\d\d)\b)"};
  rx::Regex jaDate{R"((1[89]\d\d|20\d\d)年(\d{1,2})月(\d{1,2})日)"};
  rx::Regex dotDate{R"(\b(\d{1,2})\.\s*(\d{1,2})\.\s*(1[89]\d\d|20\d\d)\b)"};
  rx::Regex dayMonthYear{R"(\b(\d{1,2})(?:st|nd|rd|th|er)?\.?\s+([A-Za-zäéûÄ]+)\.?\s+(1[89]\d\d|20\d\d)\b)", false};
  rx::Regex monthDayYear{R"(([A-Za-zäéûÄ]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(1[89]\d\d|20\d\d)\b)", false};
  rx::Regex monthYear{R"(([A-Za-zäéûÄ]+)\.?\s+(1[89]\d\d|20\d\d)\b)", false};
  rx::Regex year{R"(\b(1[89]\d\d|20\d\d)\b)"};
  rx::Regex unitBreak{R"(<br\s*\/?>|\n\*)"};
  rx::Regex partialDemolition{R"((?<!\p{L})(?:partially|partly|teilweise|partiellement)\s+(?:demolished|dismantled|zurückgebaut|rückgebaut|abgerissen|démantelé)(?!\p{L}))"};
  rx::Regex listTemplate{R"(\{\{\s*(?:unbulleted list|plainlist|ubl)\s*\|)"};
  rx::Regex closedRange{R"((1[89]\d\d|20\d\d)\s*(?:–|—|-|&ndash;|to)\s*(1[89]\d\d|20\d\d)\s*$)"};
  rx::Regex present{R"(present|heute|today)"};
  std::vector<std::pair<rx::Regex, int>> statusWords;

  // Prose (review queue only).
  std::vector<rx::Regex> completion, starts;
  rx::Regex announces{R"(\bsoll(?:en|te|ten)?\b|geplant|voraussichtlich|gerechnet|davon aus|\bwird\b|\bkann\b|könnte|\{\{Zukunft|expected|planned|scheduled|will be|is to be|\bby (?:the end of )?20[2-9]\d|prévu|devrait|devraient|doit être|\bsera\b|seront|à l[’']horizon|en vue d|予定|見込み|時期|スケジュール|gepland|verwacht|planeras|beräknas|kommer att|previst|preved|dovrebbe|se prevé|está previsto|планиру|ожида|предполага|долж|повин|plánuje|planowan|planowo)"};
  rx::Regex until{R"(\bbis (?:zum Jahr |Ende )?\d{4})"};
  rx::Regex past{R"((?<!\p{L})(?:wurden?|worden|waren?|hatten?|haben)(?!\p{L}))"};
  rx::Regex denies{R"(\bnot (?:yet |been |fully |completely )+|\b(?:was|were|has|have|had) not\b|(?<!\p{L})(?:partially|partly|teilweise|partiellement|en partie|parzialmente|parcialmente|частично)(?!\p{L})|authori[sz]ed|genehmigt|autorisé|autorizzat|autorizad|\bnoch nicht|nicht vollständig|pas encore|n[’'](?:est|a) pas|\bsecr[eè]t|未完了|まだ|niet volledig|inte helt)"};
  rx::Regex startDenies{R"(\bnot (?:yet )?(?:been )?(?:started|begun)|\bnot yet\b|\bnoch nicht|pas encore|まだ|nog niet|ännu inte)"};
  rx::Regex notProse{R"(^\s*(?:\||\{\{|\*|!|(?:Kategorie|Category|Catégorie|Categoria|Categoría|Kategori|Categorie|カテゴリ):))", false};
  rx::Regex url{R"(https?:\/\/)", false};
  rx::Regex yearIn{R"((1[89]\d\d|20\d\d)(?:年(\d{1,2})月(?:(\d{1,2})日)?)?)"};

  Patterns() {
    auto words = [](const char* alts) { return std::string("(?<!\\p{L})(") + alts + ")(?!\\p{L})"; };
    statusWords.emplace_back(rx::Regex(words("dismantled|demolished|démantelé|démentelé|desmantelad[oa]|greenfield|zurückgebaut|rückgebaut|abgerissen")), DECOMMISSIONED);
    statusWords.emplace_back(rx::Regex(words("decommissioning|en démantèlement|en cours de démantèlement|démantèlement|im rückbau|in stilllegung|en desmantelamiento")), DECOMMISSIONING);
    statusWords.emplace_back(rx::Regex(words("cancel+ed|annulé|abandonné|abandoned project|closed project|never (?:built|completed|operated)")), CANCELLED);
    statusWords.emplace_back(rx::Regex(words("permanent(?:ly)? shut ?down|shut ?down|closed|retired|decommissioned|defunct|arrêté|à l'arrêt|fermé|stillgelegt|abgeschaltet|cerrad[oa]|inactive|retiré du service")), PERMANENT_SHUTDOWN);
    statusWords.emplace_back(rx::Regex(words("mothballed|long[- ]term shutdown|suspended|extended shutdown")), LONG_TERM_SHUTDOWN);
    statusWords.emplace_back(rx::Regex(words("under construction|en construction|in bau|im bau|en construcción")), UNDER_CONSTRUCTION);
    statusWords.emplace_back(rx::Regex(words("proposed|planned|in planung|geplant|propuesto")), PLANNED);
    statusWords.emplace_back(rx::Regex(words("operational|operating|in operation|in service|active|en service|en fonction|en exploitation|in betrieb|en operación|operativ[oa]|rouvert|reopened|restarted|redémarré|remis en service|wieder in betrieb")), OPERATING);

    const char* completionPatterns[] = {
        R"(vollständig (?:zurück|ab|rück)gebaut|vollständig abgerissen|vollständig beseitigt|restlos (?:zurück|ab)gebaut|komplett (?:zurück|ab)gebaut)",
        R"(aus dem (?:(?:Geltungs|Gültigkeits|Anwendungs)bereich des )?(?:deutschen )?Atom(?:gesetz(?:es)?|recht)s? entlassen|aus der atomrechtlichen (?:Aufsicht|Überwachung) entlassen|atomrechtlich(?:e)? Entlassung|Entlassung aus dem (?:(?:Geltungs|Gültigkeits|Anwendungs)bereich des )?(?:deutschen )?Atomgesetz)",
        R"((?<!\p{L})(?:wurden?|haben|hat|ist|sind|war|waren)(?!\p{L})(?:\s+[^\s.]+){0,10}?\s+(?:vollständig\s+|komplett\s+)?(?:zurück|rück)gebaut(?!\p{L})(?!\s+werden))",
        R"((?:Rückbau|Abbau|Abriss|Stilllegung)\S*\s+(?:\S+\s+){0,4}?(?:abgeschlossen|beendet|vollendet))",
        R"(grünen? Wiese)",
        R"((?:dismantl\w+|decommission\w*|demolition|decontamination and decommissioning|D&D)\s+(?:\S+\s+){0,4}?(?:was |were |had been |has been )?(?:completed|finished|concluded))",
        R"((?:completely|fully|entirely|totally) (?:dismantled|decommissioned|demolished)|reactor (?:was |has been )?(?:completely |fully )?(?:dismantled|removed) (?:and|in|by))",
        R"((?:was|were|has been|have been|had been)\s+(?:\S+\s+){0,2}?(?:dismantled|demolished|razed|torn down)\s+(?:between|in|from|by|during)\s|(?:shut ?down|closed|decommissioned|retired)\s+and\s+(?:subsequently\s+|later\s+|then\s+)?(?:dismantled|demolished|entombed)|(?:was|were|has been|have been|had been)\s+(?:\S+\s+){0,4}?entombed|entombment\s+(?:\S+\s+){0,3}?(?:completed|finished))",
        R"((?:returned|released)\s+(?:\S+\s+){0,4}?(?:to|for)\s+unrestricted\s+(?:use|release|access)|approved\s+(?:the\s+)?(?:final|completed?|completion of(?: the)?)\s+decommissioning|final status survey\s+(?:\S+\s+){0,3}?approved)",
        R"((?:to|into|zur|als) greenfield|greenfield (?:status|condition|site)|released for unrestricted (?:use|release)|licen[cs]e (?:was )?terminated|licen[cs]e termination|termination of (?:the|its) licen[cs]e)",
        R"((?:a été|ont été|est|été|sont|puis|et) déclassée?s?(?!\p{L})|déclassement (?:de l[’']installation |du réacteur |de l[’']INB )?(?:a été |est )?prononcé|radiée? de la liste des (?:installations nucléaires de base|INB))",
        R"(démantèlement\s+(?:\S+\s+){0,4}?(?:achevé|terminé|fini)|(?:entièrement|complètement|totalement) démantelée?s?(?!\p{L}))",
        R"((?:fut|furent|a été|ont été|avait été|est aujourd[’']hui|aujourd[’']hui)\s+(?:\S+\s+){0,2}?démantelée?s?(?!\p{L})|centrale (?:nucléaire )?démantelée(?!\p{L}))",
        R"(解体(?:撤去)?(?:が|を)?完了|廃止措置(?:が|を)?(?:完了|終了)|撤去(?:が|を)?完了|更地)",
        R"(volledig ontmanteld|ontmanteling\s+(?:\S+\s+){0,3}?(?:voltooid|afgerond)|volledig afgebroken)",
        R"((?:rivning|avveckling|nedmontering)\S*\s+(?:\S+\s+){0,3}?(?:klar|slutförd|avslutad)|helt riven|friklassad)",
        R"(smantellament\w*\s+(?:\S+\s+){0,7}?(?:conclus\w*|complet\w*|terminat\w*|si conclusero|si è concluso)|completamente smantellat\w*|desmantelamiento\s+(?:\S+\s+){0,5}?(?:concluyó|finalizó|completado|terminó)|completamente desmantelad\w*)",
        R"((?:демонтаж|вывод из эксплуатации|виведення з експлуатації)\S*\s+(?:\S+\s+){0,4}?(?:заверш[её]н\w*|закончен\w*|завершився|завершено)|полностью демонтирован\w*|повністю демонтован\w*|(?:rozbiórk|demontaż|likwidacj)\w*\s+(?:\S+\s+){0,4}?zakończ\w*|całkowicie (?:rozebran|zdemontowan)\w*|zcela (?:rozebrán|demontován)\w*)",
    };
    for (const char* p : completionPatterns) completion.emplace_back(p);
    const char* startPatterns[] = {
        R"((?:Stilllegungs-?\s*(?:und\s+)?Abbau|Abbau|Rückbau|Stilllegungs)genehmigung\S*\s+(?:\S+\s+){0,8}?(?:erteilt|erhalten)|(?:Teil-?)?Genehmigung(?:en)?\s+(?:zu[mr]|für\s+(?:den|die|einen))?\s*(?:Stilllegung\s+und\s+(?:zu[mr]|den)\s+)?(?:Rückbau|Abbau|Abriss)\S*\s+(?:\S+\s+){0,6}?(?:erteilt|erhalten))",
        R"((?:Rückbau|Abbau|Abriss|Demontage)\S*\s+(?:\S+\s+){0,6}?(?:begann|begonnen|startete|gestartet|aufgenommen)|(?:befindet|befinden) sich\s+(?:\S+\s+){0,3}?(?:im|in)\s+(?:Rückbau|Abbau|Stilllegung)|seit\s+(?:\S+\s+){0,3}?(?:zurückgebaut|im Rückbau)|(?:Rückbau|Abbau)\s+(?:\S+\s+){0,3}?(?:läuft|dauert an))",
        R"((?:decommissioning|dismantl\w+|demolition|decontamination)\s+(?:\S+\s+){0,5}?(?:began|begun|started|commenced|is (?:under ?way|ongoing|in progress)|are (?:under ?way|ongoing))|(?:began|started|commenced|initiated)\s+(?:\S+\s+){0,3}?(?:decommissioning|dismantl\w+|demolition)|(?:is|are|was|were|has been|have been)\s+(?:currently\s+|now\s+|still\s+)?being\s+(?:decommissioned|dismantled|demolished)|(?:in|into|entered)\s+SAFSTOR|(?:decommissioning|PSDAR)\s+(?:\S+\s+){0,3}?(?:plan|report)\s+(?:was\s+)?approved)",
        R"((?:démantèlement|déconstruction)\s+(?:\S+\s+){0,5}?(?:a (?:débuté|commencé|démarré)|débute|commencé|démarré|est en cours|sont en cours)|en (?:cours de )?démantèlement|démantèle\w*\s+depuis|décret\s+(?:\S+\s+){0,6}?démantèlement)",
        R"((?:rivning|avveckling|nedmontering)\S*\s+(?:\S+\s+){0,4}?(?:startade|påbörjades|inleddes|började|pågår)|håller på att rivas|ontmanteling\s+(?:\S+\s+){0,3}?(?:begon|is begonnen|gestart|startte)|wordt ontmanteld)",
        R"(廃止措置計画(?:が|は)?(?:[^。]{0,12})?認可|廃止措置(?:に|を)?(?:着手|開始)|廃止措置中|解体(?:作業|工事)?(?:が|を)?(?:開始|着手))",
        R"(smantellament\w*\s+(?:\S+\s+){0,4}?(?:iniziat\w*|avviat\w*|in corso|cominciat\w*)|in (?:fase|corso) di smantellamento|desmantelamiento\s+(?:\S+\s+){0,4}?(?:comenzó|comenzaron|se inició|inició|empezó|en curso)|en (?:fase de |proceso de )?desmantelamiento)",
        R"((?:вывод\w* из эксплуатации|демонтаж\w*|виведення з експлуатації)\s+(?:\S+\s+){0,4}?(?:начал\w*|начат\w*|розпочал\w*|розпочат\w*|вед[её]тся|триває)|(?:likwidacj|demontaż|rozbiórk)\w*\s+(?:\S+\s+){0,4}?rozpoczę\w*|(?:vyřazování|demontáž)\w*\s+(?:\S+\s+){0,4}?(?:zahájen\w*|začal\w*|probíhá))",
    };
    for (const char* p : startPatterns) starts.emplace_back(p);
  }
};

inline const Patterns& patterns() {
  static const Patterns p;
  return p;
}

inline bool test(const rx::Regex& re, const std::string& s) { return re.test(rx::utf32(s)); }

// formerByDescription: the language (or "label") of the first text the rule matches, "" when none.
inline std::string formerBy(const std::vector<std::pair<std::string, std::string>>& texts, const std::string& rule) {
  const auto& P = patterns();
  const rx::Regex& re = rule == "reactor" ? P.formerReactor : rule == "storage" ? P.formerStorage : rule == "plant" ? P.formerPlant : P.formerOrganisation;
  for (const auto& [lang, text] : texts) {
    if (!test(re, text)) continue;
    if (rule == "organisation" && test(P.organisationNow, text)) continue;
    return lang;
  }
  return "";
}

// Every description the item has in the languages read, in the order the item
// lists them: a site's own community often says first that it has closed
// (nl "voormalig", pl "dawny", ru "бывший").
inline std::vector<std::pair<std::string, std::string>> ruleDescriptions(const Item& item, const std::vector<std::string>& order) {
  std::vector<std::pair<std::string, std::string>> out;
  for (const auto& lang : order) {
    auto it = item.descriptions.find(lang);
    if (it != item.descriptions.end()) out.emplace_back(lang, it->second);
  }
  return out;
}

struct RowKind { std::string category, kind, name; bool organisation = false; };

// Lifecycle evidence one item states (wikidata.mjs wikidataEvidence).
inline std::vector<Stated> wikidataEvidence(const Item& e, const RowKind& row, const std::vector<std::string>& descriptionOrder) {
  std::vector<Stated> evidence;
  const auto& SOU = stateOfUse();
  auto claims = [&](const std::string& p) -> const std::vector<Claim>& {
    static const std::vector<Claim> none;
    auto it = e.claims.find(p);
    return it == e.claims.end() ? none : it->second;
  };
  std::vector<Claim> uses;
  for (const auto& c : claims("P5817")) if (SOU.count(c.value)) uses.push_back(c);
  std::vector<Claim> preferred;
  for (const auto& c : uses) if (c.rank == "preferred") preferred.push_back(c);
  std::vector<Claim> sorted = uses;
  std::stable_sort(sorted.begin(), sorted.end(), [](const Claim& a, const Claim& b) { return a.since < b.since; });
  bool started = false;
  for (const auto& p : startProperties()) if (!claims(p).empty()) started = true;
  std::vector<Claim> current;
  if (!preferred.empty()) current = preferred;
  else if (!sorted.empty() && !sorted.back().since.empty()) current = {sorted.back()};
  else current = uses;
  for (const auto& c : current) {
    const int status = c.value == "Q97317113" && started ? LONG_TERM_SHUTDOWN : SOU.at(c.value);
    if (status == DECOMMISSIONED && c.since.empty()) evidence.push_back({PERMANENT_SHUTDOWN, "", "P5817"});
    else evidence.push_back({status, c.since, "P5817"});
  }
  const bool destroyed = std::find(e.classes.begin(), e.classes.end(), "Q19860854") != e.classes.end();
  std::vector<std::string> stopDates;
  for (const char* p : {"P730", "P3999", "P582"}) for (const auto& c : claims(p)) if (!c.value.empty()) stopDates.push_back(c.value);
  std::sort(stopDates.begin(), stopDates.end());
  for (const auto& p : endProperties()) {
    const auto& cs = claims(p);
    if (cs.empty()) continue;
    std::vector<std::string> dated;
    for (const auto& c : cs) if (!c.value.empty()) dated.push_back(c.value);
    std::sort(dated.begin(), dated.end());
    const bool demolished = p == "P576" && !dated.empty() && museumSet(row.category) && (destroyed || (!stopDates.empty() && dated[0] > stopDates.back()));
    if (demolished) evidence.push_back({DECOMMISSIONED, dated[0], "P576"});
    else evidence.push_back({PERMANENT_SHUTDOWN, dated.empty() ? "" : dated[0], p});
  }
  for (const auto& q : e.classes) {
    for (const auto& s : stoppedClasses()) {
      if (q != s.qid) continue;
      const bool monument = q == "Q33506" || q == "Q1569871";
      if (monument && !museumSet(row.category)) continue;
      evidence.push_back({s.status == DECOMMISSIONED ? PERMANENT_SHUTDOWN : s.status, "", "class:" + q});
    }
  }
  const std::string rule0 = descriptionRule(row.category);
  auto texts = [&](const std::string& rule) {
    auto t = ruleDescriptions(e, descriptionOrder);
    if (rule != "reactor") t.emplace_back("label", row.name);
    return t;
  };
  bool closedBy = false;
  for (const auto& s : evidence) if (isEndProperty(s.field)) closedBy = true;
  const std::string formerIn = rule0.empty() ? "" : formerBy(texts(rule0), rule0);
  if (!closedBy && !formerIn.empty()) closedBy = true;
  // The item's own description calls it former or defunct: closed under its name, successor or not.
  const bool describedFormer = !formerIn.empty() && formerIn != "label";
  bool nonOperatingUse = false;
  for (const auto& c : claims("P5817")) { auto it = SOU.find(c.value); if (it != SOU.end() && it->second != OPERATING) nonOperatingUse = true; }
  const bool renamed = row.organisation && closedBy && !e.successors.empty() && !nonOperatingUse && !describedFormer;
  if (renamed) {
    const std::string property = e.successors[0].substr(0, e.successors[0].find(' '));
    evidence.push_back({OPERATING, "", property});
  }
  bool cancelled = false;
  for (const auto& s : evidence) if (s.status == CANCELLED) cancelled = true;
  if (!cancelled) {
    for (const auto& [lang, text] : ruleDescriptions(e, descriptionOrder)) {
      (void)lang;
      if (test(patterns().neverRan, text)) { evidence.push_back({CANCELLED, "", "description"}); break; }
    }
  }
  const std::string rule = descriptionRule(row.category);
  bool anyStopped = false;
  for (const auto& s : evidence) if (s.status != OPERATING) anyStopped = true;
  if (!rule.empty() && !renamed && (!anyStopped || describedFormer)) {
    const std::string former = formerBy(texts(rule), rule);
    if (!former.empty()) evidence.push_back({PERMANENT_SHUTDOWN, "", former == "label" ? "label" : "description"});
  }
  return evidence;
}

// The item's start of operation: {date, property} (P729, then P1619, then P571).
inline Stated wikidataStart(const Item& e) {
  for (const auto& p : startProperties()) {
    auto it = e.claims.find(p);
    if (it == e.claims.end()) continue;
    std::vector<std::string> dated;
    for (const auto& c : it->second) if (!c.value.empty()) dated.push_back(c.value);
    std::sort(dated.begin(), dated.end());
    if (!dated.empty()) return {OPERATING, dated[0], p};
  }
  return {};
}

// ── Wikipedia infoboxes ─────────────────────────────────────────────────────
using Params = std::vector<std::pair<std::string, std::string>>;  // key -> value, first occurrence order

inline std::string param(const Params& p, const std::string& key) {
  for (const auto& [k, v] : p) if (k == key) return v;
  return "";
}

// Lower case as JavaScript's toLowerCase for keys (ASCII and Latin).
inline std::string keyLower(const std::string& s) { return lower(s); }

inline std::string stripCommentsAndRefs(const std::string& v) {
  static const rx::Regex comments(R"(<!--[\s\S]*?-->)", false);
  static const rx::Regex refs(R"(<ref[\s\S]*?(<\/ref>|\/>))", false);
  rx::Text t = rx::utf32(v);
  for (const rx::Regex* re : {&comments, &refs}) {
    rx::Text out;
    size_t at = 0;
    for (const auto& m : re->all(t)) { out.append(t, at, m.begin - at); at = m.end; }
    out.append(t, at, rx::Text::npos);
    t = out;
  }
  return rx::utf8(t);
}

// The top-level "| name = value" parameters of the first infobox-like template.
inline Params infoboxParameters(const std::string& text8) {
  Params params;
  const rx::Text text = rx::utf32(text8);
  const auto m = patterns().infoboxStart.search(text);
  if (!m.ok) return params;
  const size_t start = m.begin;
  int depth = 0;
  size_t end = start;
  for (size_t i = start; i + 1 < text.size(); ++i) {
    if (text[i] == '{' && text[i + 1] == '{') { ++depth; ++i; }
    else if (text[i] == '}' && text[i + 1] == '}') { --depth; ++i; if (depth == 0) { end = i + 1; break; } }
  }
  // JavaScript: text.slice(start + 2, end - 2), where an unclosed template leaves end = start.
  rx::Text body;
  if (end >= start + 4) body = text.substr(start + 2, end - 2 - (start + 2));
  else if (end == start) body = start + 2 <= text.size() && text.size() >= 2 ? rx::Text() : rx::Text();
  std::vector<rx::Text> parts;
  rx::Text current;
  int level = 0;
  for (size_t i = 0; i < body.size(); ++i) {
    if (i + 1 < body.size() && ((body[i] == '{' && body[i + 1] == '{') || (body[i] == '[' && body[i + 1] == '['))) { ++level; current += body[i]; current += body[i + 1]; ++i; continue; }
    if (i + 1 < body.size() && ((body[i] == '}' && body[i + 1] == '}') || (body[i] == ']' && body[i + 1] == ']'))) { --level; current += body[i]; current += body[i + 1]; ++i; continue; }
    if (body[i] == '|' && level == 0) { parts.push_back(current); current.clear(); continue; }
    current += body[i];
  }
  parts.push_back(current);
  for (size_t k = 1; k < parts.size(); ++k) {
    const auto& part = parts[k];
    const size_t eq = part.find(U'=');
    if (eq == rx::Text::npos) continue;
    const std::string key = keyLower(rx::utf8(trim32(part.substr(0, eq))));
    const std::string value = rx::utf8(trim32(rx::utf32(stripCommentsAndRefs(rx::utf8(part.substr(eq + 1))))));
    if (key.empty() || value.empty()) continue;
    bool seen = false;
    for (auto& [k2, v2] : params) if (k2 == key) { v2 = value; seen = true; }  // JS object: the last value wins
    if (!seen) params.emplace_back(key, value);
  }
  return params;
}

inline int monthNumber(std::string word) {
  word = lower(word);
  static const std::map<std::string, int> m = {
      {"jan", 1}, {"january", 1}, {"januar", 1}, {"janvier", 1}, {"jänner", 1}, {"enero", 1}, {"gennaio", 1},
      {"feb", 2}, {"february", 2}, {"februar", 2}, {"février", 2}, {"fevrier", 2}, {"febrero", 2}, {"febbraio", 2},
      {"mar", 3}, {"march", 3}, {"märz", 3}, {"maerz", 3}, {"mars", 3}, {"marzo", 3},
      {"apr", 4}, {"april", 4}, {"avril", 4}, {"abril", 4}, {"aprile", 4},
      {"may", 5}, {"mai", 5}, {"mayo", 5}, {"maggio", 5},
      {"jun", 6}, {"june", 6}, {"juni", 6}, {"juin", 6}, {"junio", 6}, {"giugno", 6},
      {"jul", 7}, {"july", 7}, {"juli", 7}, {"juillet", 7}, {"julio", 7}, {"luglio", 7},
      {"aug", 8}, {"august", 8}, {"août", 8}, {"aout", 8}, {"agosto", 8},
      {"sep", 9}, {"sept", 9}, {"september", 9}, {"septembre", 9}, {"septiembre", 9}, {"settembre", 9},
      {"oct", 10}, {"okt", 10}, {"october", 10}, {"oktober", 10}, {"octobre", 10}, {"octubre", 10}, {"ottobre", 10},
      {"nov", 11}, {"november", 11}, {"novembre", 11}, {"noviembre", 11},
      {"dec", 12}, {"dez", 12}, {"december", 12}, {"dezember", 12}, {"décembre", 12}, {"decembre", 12}, {"diciembre", 12}, {"dicembre", 12},
  };
  auto it = m.find(word);
  return it == m.end() ? 0 : it->second;
}

inline rx::Text replaceMatches(const rx::Text& t, const rx::Regex& re, const rx::Text& with, bool groupOne = false) {
  rx::Text out;
  size_t at = 0;
  std::vector<std::pair<size_t, size_t>> groups;
  size_t from = 0;
  while (from <= t.size()) {
    const auto m = groupOne ? re.capture(t, groups, from) : re.search(t, from);
    if (!m.ok) break;
    out.append(t, at, m.begin - at);
    if (groupOne && groups.size() > 1 && groups[1].first != SIZE_MAX) out.append(t, groups[1].first, groups[1].second - groups[1].first);
    else out += with;
    at = m.end;
    from = m.end > m.begin ? m.end : m.end + 1;
    if (m.end == m.begin && m.begin < t.size()) { out += t[m.begin]; at = m.begin + 1; }
  }
  out.append(t, std::min(at, t.size()), rx::Text::npos);
  return out;
}

inline int toInt(const rx::Text& t, size_t b, size_t e) {
  int v = 0;
  for (size_t i = b; i < e; ++i) { if (!rx::isDigit(t[i])) return v; v = v * 10 + int(t[i] - '0'); }
  return v;
}

// The date one infobox value records (wikipedia.mjs wikiDate).
inline std::string wikiDate(const std::string& raw, int nowYear) {
  const auto& P = patterns();
  if (raw.empty() || test(P.prospective, raw)) return "";
  static const rx::Regex link(R"(\[\[(?:[^|\]]*\|)?([^\]]*)\]\])", false);
  static const rx::Regex quotes(R"(''+)", false);
  rx::Text text = replaceMatches(rx::utf32(raw), link, U"", true);
  text = replaceMatches(text, quotes, U"");
  auto ok = [&](int y) { return y >= 1900 && y <= nowYear; };
  std::vector<std::pair<size_t, size_t>> g;
  auto grp = [&](int k) { return rx::utf8(text, g[size_t(k)].first, g[size_t(k)].second); };
  auto num = [&](int k) { return toInt(text, g[size_t(k)].first, g[size_t(k)].second); };
  if (P.dateTemplate.capture(text, g).ok) {
    const std::string name = lower(grp(1));
    std::vector<double> nums;
    for (auto& piece : split(grp(2), '|')) {
      const std::string p = trim(piece);
      if (p.empty() || p.find('=') != std::string::npos) continue;
      char* endp = nullptr;
      const double v = std::strtod(p.c_str(), &endp);
      nums.push_back(endp && *endp == 0 ? v : NAN);
    }
    auto padNum = [](double v) { if (std::isnan(v)) return std::string("NaN"); const long n = long(v); return n < 10 && n >= 0 ? "0" + std::to_string(n) : std::to_string(n); };
    auto truthy = [](double v) { return !std::isnan(v) && v != 0; };
    if (name == "date" && nums.size() >= 3 && nums[2] > 31) {
      if (ok(int(nums[2]))) return std::to_string(int(nums[2])) + "-" + padNum(nums[1]) + "-" + padNum(nums[0]);
    } else if (!nums.empty() && !std::isnan(nums[0]) && ok(int(nums[0])) && nums[0] == std::floor(nums[0])) {
      const int y = int(nums[0]);
      if (nums.size() > 2 && truthy(nums[2])) return std::to_string(y) + "-" + padNum(nums[1]) + "-" + padNum(nums[2]);
      if (nums.size() > 1 && truthy(nums[1])) return std::to_string(y) + "-" + padNum(nums[1]);
      return std::to_string(y);
    }
  }
  if (P.isoDate.capture(text, g).ok && ok(num(1))) return grp(1) + "-" + grp(2) + "-" + grp(3);
  if (P.jaDate.capture(text, g).ok && ok(num(1))) return grp(1) + "-" + pad2(num(2)) + "-" + pad2(num(3));
  if (P.dotDate.capture(text, g).ok && ok(num(3))) return grp(3) + "-" + pad2(num(2)) + "-" + pad2(num(1));
  if (P.dayMonthYear.capture(text, g).ok && monthNumber(grp(2)) && ok(num(3))) return grp(3) + "-" + pad2(monthNumber(grp(2))) + "-" + pad2(num(1));
  if (P.monthDayYear.capture(text, g).ok && monthNumber(grp(1)) && ok(num(3))) return grp(3) + "-" + pad2(monthNumber(grp(1))) + "-" + pad2(num(2));
  if (P.monthYear.capture(text, g).ok && monthNumber(grp(1)) && ok(num(2))) return grp(2) + "-" + pad2(monthNumber(grp(1)));
  if (P.year.capture(text, g).ok && ok(num(1))) return grp(1);
  return "";
}

// One value per unit when an infobox lists several.
inline std::vector<std::string> units(const std::string& value) {
  std::vector<std::string> out;
  const rx::Text t = rx::utf32(value);
  size_t at = 0;
  for (const auto& m : patterns().unitBreak.all(t)) {
    const std::string piece = rx::utf8(trim32(t.substr(at, m.begin - at)));
    if (!piece.empty()) out.push_back(piece);
    at = m.end;
  }
  const std::string last = rx::utf8(trim32(t.substr(std::min(at, t.size()))));
  if (!last.empty()) out.push_back(last);
  return out;
}

// The status a free-text value states (wikipedia.mjs statusWord).
inline int statusWord(const std::string& value) {
  static const rx::Regex refs(R"(<ref[\s\S]*?(<\/ref>|\/>))", false);
  static const rx::Regex templ(R"(\{\{[^|}]*\|)", false);
  static const rx::Regex marks(R"([{}[\]|])", false);
  rx::Text plain = replaceMatches(rx::utf32(value), refs, U" ");
  plain = replaceMatches(plain, templ, U" ");
  plain = replaceMatches(plain, marks, U" ");
  plain = trim32(plain);
  plain = replaceMatches(plain, patterns().partialDemolition, U"shut down");
  const std::string p8 = rx::utf8(plain);
  if (p8 == "O") return OPERATING;
  if (p8 == "U") return UNDER_CONSTRUCTION;
  if (p8 == "P") return PLANNED;
  if (p8 == "M") return LONG_TERM_SHUTDOWN;
  if (p8 == "D") return PERMANENT_SHUTDOWN;
  if (p8 == "C") return CANCELLED;
  long at = -1;
  int status = UNSPECIFIED;
  for (const auto& [re, s] : patterns().statusWords) {
    for (const auto& m : re.all(plain)) {
      if (long(m.begin) > at) { at = long(m.begin); status = s; }
    }
  }
  return status;
}

inline const std::vector<std::string>& shutdownKeys() {
  static const std::vector<std::string> v{"abschaltung", "shutdown", "shut_down", "mise à l’arrêt définitif", "mise à l'arrêt définitif", "date de mise à l’arrêt définitif",
                                          "date de mise à l'arrêt définitif", "date de fermeture", "operation_end_year", "closing_date", "closed", "defunct"};
  return v;
}
inline const std::vector<std::string>& decommissionKeys() { static const std::vector<std::string> v{"decommissioned", "decommission_date", "decommissioning_date", "stilllegung"}; return v; }
inline const std::vector<std::string>& dismantledKeys() { static const std::vector<std::string> v{"demolished_date", "demolition_date", "demolished"}; return v; }
inline const std::vector<std::string>& startKeys() { static const std::vector<std::string> v{"inbetriebnahme", "first_crit", "commissioned", "operation_start_year", "date de mise en service", "mise en service"}; return v; }
inline const std::vector<std::string>& serviceStartKeys() {
  static const std::vector<std::string> v{"inbetriebnahme", "first_crit", "commissioned", "operation_start_year", "date de mise en service", "mise en service", "in_use", "opened", "opening", "established"};
  return v;
}
inline const std::vector<std::string>& statusKeys() { static const std::vector<std::string> v{"status", "statut", "estado", "stav", "condition"}; return v; }
inline const std::vector<std::string>& constructionKeys() { static const std::vector<std::string> v{"construction_began", "construct_start", "construction_start_date", "baubeginn"}; return v; }
inline bool isDecommissionKey(const std::string& k) { for (const auto& d : decommissionKeys()) if (d == k) return true; return false; }
inline bool isServiceStartKey(const std::string& k) { for (const auto& d : serviceStartKeys()) if (d == k) return true; return false; }

// When the infobox says the site went into service (earliest unit).
inline Stated infoboxStart(const Params& params, int nowYear) {
  for (const auto& key : serviceStartKeys()) {
    const std::string v = param(params, key);
    if (v.empty()) continue;
    std::vector<std::string> dates;
    for (const auto& piece : units(v)) { const std::string d = wikiDate(piece, nowYear); if (!d.empty()) dates.push_back(d); }
    std::sort(dates.begin(), dates.end());
    if (!dates.empty()) return {OPERATING, dates[0], "infobox:" + key};
  }
  return {};
}

struct InfoboxStated : Stated {
  std::vector<std::string> unitDates;  // the distinct unit dates of a multi-unit shutdown
};

// Lifecycle evidence one article's infobox states (wikipedia.mjs infoboxEvidence).
inline std::vector<InfoboxStated> infoboxEvidence(const Params& params, int nowYear) {
  std::vector<InfoboxStated> evidence;
  std::string started;
  for (const auto& k : startKeys()) { started = param(params, k); if (!started.empty()) break; }
  const size_t unitCount = started.empty() ? 1 : units(started).size();
  auto lastDate = [&](const std::string& key) -> std::string {
    const std::string value = param(params, key);
    if (value.empty()) return "";
    const auto pieces = units(value);
    std::vector<std::string> dates;
    for (const auto& piece : pieces) dates.push_back(wikiDate(piece, nowYear));
    for (const auto& d : dates) if (d.empty()) return "";
    if (pieces.size() < unitCount) return "";
    std::sort(dates.begin(), dates.end());
    return dates.empty() ? "" : dates.back();
  };
  std::string shutKey;
  for (const auto& k : shutdownKeys()) if (!lastDate(k).empty()) { shutKey = k; break; }
  if (!shutKey.empty()) {
    std::set<std::string> distinct;
    for (const auto& piece : units(param(params, shutKey))) distinct.insert(wikiDate(piece, nowYear));
    InfoboxStated s;
    s.status = PERMANENT_SHUTDOWN;
    s.date = lastDate(shutKey);
    s.field = "infobox:" + shutKey;
    if (distinct.size() > 1) s.unitDates.assign(distinct.begin(), distinct.end());
    evidence.push_back(s);
  }
  std::string decommissionKey;
  for (const auto& k : decommissionKeys()) if (!lastDate(k).empty()) { decommissionKey = k; break; }
  if (shutKey.empty() && !decommissionKey.empty()) {
    InfoboxStated s;
    s.status = PERMANENT_SHUTDOWN;
    s.date = lastDate(decommissionKey);
    s.field = "infobox:" + decommissionKey;
    evidence.push_back(s);
  }
  {
    static const rx::Regex templ(R"(\{\{[^}]*\}\})", false);
    static const rx::Regex tags(R"(<[^>]*>)", false);
    rx::Text inUse = replaceMatches(rx::utf32(param(params, "in_use")), templ, U"");
    inUse = replaceMatches(inUse, tags, U" ");
    std::vector<std::pair<size_t, size_t>> g;
    const rx::Text trimmed = trim32(inUse);
    if (shutKey.empty() && decommissionKey.empty() && patterns().closedRange.capture(trimmed, g).ok && !patterns().present.test(inUse)) {
      InfoboxStated s;
      s.status = PERMANENT_SHUTDOWN;
      s.date = wikiDate(rx::utf8(trimmed, g[2].first, g[2].second), nowYear);
      s.field = "infobox:in_use";
      evidence.push_back(s);
    }
  }
  std::string dismantledKey;
  for (const auto& k : dismantledKeys()) if (!lastDate(k).empty()) { dismantledKey = k; break; }
  if (!dismantledKey.empty()) {
    InfoboxStated s;
    s.status = DECOMMISSIONED;
    s.date = lastDate(dismantledKey);
    s.field = "infobox:" + dismantledKey;
    evidence.push_back(s);
  }
  for (const auto& key : statusKeys()) {
    const std::string value = param(params, key);
    if (value.empty()) continue;
    const int status = statusWord(value);
    if (status == UNSPECIFIED) continue;
    rx::Text listed = rx::utf32(value);
    if (const auto first = patterns().listTemplate.search(listed); first.ok) listed.erase(first.begin, first.end - first.begin);  // JS replace without g: the first only
    rx::Text bars;
    for (uint32_t c : listed) { if (c == '|') bars += U"<br>"; else bars += c; }
    std::string dated;
    for (const auto& piece : units(rx::utf8(bars))) if (statusWord(piece) == status) { dated = piece; break; }
    std::string date = status == OPERATING ? "" : wikiDate(dated, nowYear);
    std::string since = wikiDate(param(params, "status seit"), nowYear);
    if (date.empty() && !since.empty() && status != OPERATING) date = since;
    if (date.empty() && status == UNDER_CONSTRUCTION) {
      std::vector<std::string> began;
      for (const auto& k : constructionKeys()) {
        const std::string v = param(params, k);
        if (v.empty()) continue;
        for (const auto& piece : units(v)) { const std::string d = wikiDate(piece, nowYear); if (!d.empty()) began.push_back(d); }
      }
      std::sort(began.begin(), began.end());
      if (!began.empty()) date = began[0];
    }
    InfoboxStated s;
    s.field = "infobox:" + key;
    if (status == DECOMMISSIONED && date.empty()) { s.status = PERMANENT_SHUTDOWN; evidence.push_back(s); continue; }
    s.status = status;
    s.date = date;
    evidence.push_back(s);
  }
  return evidence;
}

// ── Article prose (the review queue) ───────────────────────────────────────
struct Statement { std::string kind, phrase, date; };

inline rx::Text proseBody(const std::string& text) {
  static const rx::Regex refs(R"(<ref[\s\S]*?(<\/ref>|\/>))", false);
  static const rx::Regex comments(R"(<!--[\s\S]*?-->)", false);
  static const rx::Regex link(R"(\[\[(?:[^|\]]*\|)?([^\]]*)\]\])", false);
  static const rx::Regex quotes(R"(''+)", false);
  rx::Text t = replaceMatches(rx::utf32(text), refs, U" ");
  t = replaceMatches(t, comments, U" ");
  t = replaceMatches(t, link, U"", true);
  t = replaceMatches(t, quotes, U"");
  return t;
}

// Sentences: split after . ! ? 。 (not after a German day number or a one-letter abbreviation) or on newlines.
inline std::vector<rx::Text> sentences(const rx::Text& body) {
  std::vector<rx::Text> out;
  size_t start = 0;
  auto endsSentence = [&](size_t i) {
    // body[i] is one of . ! ? 。 ; the char before must not be (start or space or "(") + (1-2 digits or a letter).
    const uint32_t c = body[i];
    if (c != '.' && c != '!' && c != '?' && c != 0x3002) return false;
    // lookbehind (?<!(?:^|[\s(])(?:\d{1,2}|\p{L})) at position i
    auto boundaryBefore = [&](size_t j) { return j == 0 || rx::isSpace(body[j - 1]) || body[j - 1] == '('; };
    if (i >= 1 && rx::isLetter(body[i - 1]) && boundaryBefore(i - 1)) return false;
    if (i >= 1 && rx::isDigit(body[i - 1]) && boundaryBefore(i - 1)) return false;
    if (i >= 2 && rx::isDigit(body[i - 1]) && rx::isDigit(body[i - 2]) && boundaryBefore(i - 2)) return false;
    return true;
  };
  size_t i = 0;
  while (i < body.size()) {
    if (body[i] == '\n') {
      out.push_back(body.substr(start, i - start));
      while (i < body.size() && body[i] == '\n') ++i;
      start = i;
      continue;
    }
    if (endsSentence(i) && i + 1 < body.size() && rx::isSpace(body[i + 1])) {
      size_t j = i + 1;
      while (j < body.size() && rx::isSpace(body[j])) ++j;
      out.push_back(body.substr(start, i + 1 - start));
      start = j;
      i = j;
      continue;
    }
    ++i;
  }
  out.push_back(body.substr(start));
  return out;
}

inline bool announcesSentence(const rx::Text& s) {
  const auto& P = patterns();
  return P.announces.test(s) || (P.until.test(s) && !P.past.test(s));
}

inline std::vector<std::pair<size_t, std::string>> datesIn(const rx::Text& s, int nowYear) {
  std::vector<std::pair<size_t, std::string>> out;
  std::vector<std::pair<size_t, size_t>> g;
  size_t from = 0;
  while (from <= s.size()) {
    const auto m = patterns().yearIn.capture(s, g, from);
    if (!m.ok) break;
    if (toInt(s, g[1].first, g[1].second) <= nowYear) {
      const size_t a = m.begin >= 20 ? m.begin - 20 : 0;
      out.emplace_back(m.begin, rx::utf8(s, a, m.end));
    }
    from = m.end > m.begin ? m.end : m.end + 1;
  }
  return out;
}

// Dated (and, with undated, undated) statements of a completed dismantling and of a started one.
inline std::vector<Statement> articleStatements(const std::string& text, int nowYear) {
  const auto& P = patterns();
  std::vector<Statement> out;
  const rx::Text body = proseBody(text);
  const auto list = sentences(body);
  for (const auto& sentence : list) {
    if (P.notProse.test(sentence) || P.url.test(sentence)) continue;
    for (const auto& re : P.completion) {
      const auto m = re.search(sentence);
      if (!m.ok) continue;
      if (announcesSentence(sentence) || P.denies.test(sentence)) continue;
      auto dates = datesIn(sentence, nowYear);
      if (dates.empty()) { out.push_back({"completed", rx::utf8(sentence, m.begin, m.end), ""}); continue; }
      const size_t end = m.end;
      std::stable_sort(dates.begin(), dates.end(), [&](const auto& a, const auto& b) {
        const long da = std::labs(long(a.first) - long(end)), db = std::labs(long(b.first) - long(end));
        return da < db;
      });
      const std::string date = wikiDate(dates[0].second, nowYear);
      if (!date.empty()) out.push_back({"completed", rx::utf8(sentence, m.begin, m.end), date});
    }
  }
  for (const auto& sentence : list) {
    if (P.notProse.test(sentence) || P.url.test(sentence)) continue;
    for (const auto& re : P.starts) {
      const auto m = re.search(sentence);
      if (!m.ok || announcesSentence(sentence) || P.startDenies.test(sentence)) continue;
      auto dates = datesIn(sentence, nowYear);
      const size_t end = m.end;
      std::stable_sort(dates.begin(), dates.end(), [&](const auto& a, const auto& b) {
        return std::labs(long(a.first) - long(end)) < std::labs(long(b.first) - long(end));
      });
      out.push_back({"started", rx::utf8(sentence, m.begin, m.end), dates.empty() ? "" : wikiDate(dates[0].second, nowYear)});
      break;
    }
  }
  return out;
}

// ── Article lead (rows outside the nuclear sets that no item or register dates) ──
// The first sentence of an article says in its tense whether the body or the
// site still exists ("X is a laboratory" / "X was a laboratory"). It is read
// for the rows nothing else states a lifecycle for, and decides only then.

// Wikitext with every {{template}}, {|table|} and [[File:…]] removed (nested).
inline rx::Text withoutBlocks(const rx::Text& t) {
  rx::Text out;
  out.reserve(t.size());
  int braces = 0, tables = 0;
  size_t i = 0;
  auto at = [&](size_t k, const char* s) {
    for (size_t j = 0; s[j]; ++j) if (k + j >= t.size() || t[k + j] != uint32_t(uint8_t(s[j]))) return false;
    return true;
  };
  while (i < t.size()) {
    if (at(i, "{{")) { ++braces; i += 2; continue; }
    if (braces > 0 && at(i, "}}")) { --braces; i += 2; continue; }
    if (braces == 0 && at(i, "{|")) { ++tables; i += 2; continue; }
    if (tables > 0 && braces == 0 && at(i, "|}")) { --tables; i += 2; continue; }
    if (braces == 0 && tables == 0) {
      // [[File:…]], [[Image:…]] and their local names: skip to the matching ]].
      static const char* files[] = {"[[File:", "[[Image:", "[[Datei:", "[[Bild:", "[[Fichier:", "[[Archivo:", "[[Imagen:", "[[Bestand:", "[[Plik:", "[[Soubor:",
                                    "[[Файл:", "[[Изображение:", "[[ファイル:", "[[画像:", "[[File:", "[[Immagine:", "[[Fil:", "[[文件:", "[[檔案:"};
      bool skipped = false;
      for (const char* f : files) {
        if (!at(i, f)) continue;
        int depth = 0;
        size_t j = i;
        while (j < t.size()) {
          if (at(j, "[[")) { ++depth; j += 2; continue; }
          if (at(j, "]]")) { --depth; j += 2; if (depth == 0) break; continue; }
          ++j;
        }
        i = j;
        skipped = true;
        break;
      }
      if (skipped) continue;
      out.push_back(t[i]);
    }
    ++i;
  }
  return out;
}

// The first sentence of the article's first prose paragraph.
inline rx::Text leadSentence(const std::string& text) {
  const size_t cut = text.find("\n==");
  rx::Text t = withoutBlocks(proseBody(cut == std::string::npos ? text : text.substr(0, cut)));
  size_t start = 0;
  while (start < t.size()) {
    size_t end = start;
    while (end < t.size() && t[end] != '\n') ++end;
    rx::Text line = t.substr(start, end - start);
    size_t b = 0;
    while (b < line.size() && rx::isSpace(line[b])) ++b;
    const bool prose = b < line.size() && line[b] != '*' && line[b] != '#' && line[b] != ':' && line[b] != ';' && line[b] != '|' && line[b] != '!' && line[b] != '_' &&
                       line[b] != '<' && line[b] != '[' && line[b] != '=';
    size_t letters = 0;
    for (uint32_t c : line) if (rx::isLetter(c)) ++letters;
    if (prose && letters >= 12) {
      const auto list = sentences(line.substr(b));
      return list.empty() ? line.substr(b) : list[0];
    }
    start = end + 1;
  }
  return {};
}

struct LeadPatterns {
  rx::Regex present, past, presentFormer, passive;
};
inline const LeadPatterns* leadPatterns(const std::string& lang) {
  static const std::map<std::string, LeadPatterns> m = [] {
    std::map<std::string, LeadPatterns> v;
    auto add = [&](const char* lang, const char* present, const char* past, const char* former, const char* passive) {
      v.emplace(lang, LeadPatterns{rx::Regex(present), rx::Regex(past), rx::Regex(former), rx::Regex(passive)});
    };
    const char* never = R"((?!))";
    add("en", R"((?<!\p{L})(is|are)(?!\p{L}))", R"((?<!\p{L})(was|were)\s+(a|an|the|one)(?!\p{L}))",
        R"((?<!\p{L})(is|are)\s+(?:a|an|the)\s+(?:former|defunct|closed|disused|abandoned)(?!\p{L}))", R"((?<!\p{L})(was|were)\s+(?:the|one of the)\s+(?:first|oldest|original|earliest)(?!\p{L}))");
    add("de", R"((?<!\p{L})(ist|sind)(?!\p{L}))", R"((?<!\p{L})(war|waren)\s+(ein|eine|einer|eines|der|die|das|von|bis|zwischen)(?!\p{L}))",
        R"((?<!\p{L})(ist|sind)\s+(?:ein|eine|der|die|das)\s+(?:ehemalig|früher|stillgelegt|aufgelöst)\p{L}*)", R"((?<!\p{L})war\s+(?:die|der|das)\s+(?:erste|älteste)\p{L}*)");
    add("fr", R"((?<!\p{L})(est|sont)(?!\p{L}))", R"((?<!\p{L})(était|étaient|fut|furent)\s+(un|une|le|la|les|l'|l’)(?!\p{L}))",
        R"((?<!\p{L})(est|sont)\s+(?:un|une|le|la|l'|l’)\s*(?:ancien|ancienne|ex-|défunt)\p{L}*)", R"((?<!\p{L})(était|fut)\s+(?:le|la)\s+(?:premier|première|plus ancien)\p{L}*)");
    add("nl", R"((?<!\p{L})(is|zijn)(?!\p{L}))", R"((?<!\p{L})(was|waren)\s+(een|het|de)(?!\p{L}))", R"((?<!\p{L})(is|zijn)\s+(?:een|het|de)\s+(?:voormalig|opgeheven)\p{L}*)", never);
    add("es", R"((?<!\p{L})(es|son)(?!\p{L}))", R"((?<!\p{L})(fue|era|fueron|eran)\s+(un|una|el|la|los|las)(?!\p{L}))", R"((?<!\p{L})(es|son)\s+(?:un|una|el|la)\s+(?:antigu|extint|ex-)\p{L}*)", R"((?<!\p{L})(fue|era)\s+(?:el|la)\s+primer\p{L}*)");
    add("it", R"((?<!\p{L})(è|sono)(?!\p{L}))", R"((?<!\p{L})(era|fu|erano|furono)\s+(un|una|uno|il|lo|la|l'|l’|i|gli|le)(?!\p{L}))", R"((?<!\p{L})(è|sono)\s+(?:un|una|uno|il|la|l'|l’)\s*(?:ex|antic|soppress)\p{L}*)", R"((?<!\p{L})(era|fu)\s+(?:il|la)\s+prim\p{L}*)");
    add("sv", R"((?<!\p{L})(är)(?!\p{L}))", R"((?<!\p{L})var\s+(en|ett|den|det)(?!\p{L}))", R"((?<!\p{L})är\s+(?:en|ett)\s+(?:före detta|tidigare|nedlagd)\p{L}*)", never);
    add("pl", R"((?<!\p{L})(jest|są|to)(?!\p{L}))", R"((?<!\p{L})(był|była|było|byli|były)(?!\p{L}))", R"((?<!\p{L})(jest|to)\s+(?:dawn|był|zlikwidowan)\p{L}*)",
        R"((?<!\p{L})(był|była|było|byli|były)\s+(?:założon|utworzon|powołan|zbudowan|otwart|nazywan|znan)\p{L}*)");
    add("cs", R"((?<!\p{L})(je|jsou)(?!\p{L}))", R"((?<!\p{L})(byl|byla|bylo|byli|byly)(?!\p{L}))", R"((?<!\p{L})(je|jsou)\s+(?:bývalý|bývalá|bývalé|zaniklý|zaniklá|zaniklé)(?!\p{L}))",
        R"((?<!\p{L})(byl|byla|bylo|byli|byly)\s+(?:založen|zřízen|ustaven|vytvořen|postaven|otevřen|přejmenován)\p{L}*)");
    add("ru", R"((?<!\p{L})(является|являются)(?!\p{L})|\s[—–]\s)", R"((?<!\p{L})(был|была|было|были|являлся|являлась|являлось|существовал|существовала|существовало)(?!\p{L}))",
        R"(\s[—–]\s*(?:бывш|упразднённ|ликвидированн)\p{L}*)", R"((?<!\p{L})(был|была|было|были)\s+(?:основан|создан|образован|открыт|построен|переименован|организован)\p{L}*)");
    add("uk", R"((?<!\p{L})(є)(?!\p{L})|\s[—–]\s)", R"((?<!\p{L})(був|була|було|були|існував|існувала|існувало)(?!\p{L}))", R"(\s[—–]\s*(?:колишн|ліквідован)\p{L}*)",
        R"((?<!\p{L})(був|була|було|були)\s+(?:заснован|створен|утворен|відкрит|збудован|перейменован)\p{L}*)");
    add("ja", never, R"((であった|だった|していた|存在した|置かれていた|あった)。?\s*$)", never, never);
    add("zh", never, R"((曾是|曾经是|曾經是|已撤销|已撤銷|已解散|已关闭|已關閉))", never, never);
    return v;
  }();
  auto it = m.find(lang);
  return it == m.end() ? nullptr : &it->second;
}

// PERMANENT_SHUTDOWN when the lead sentence puts the site in the past, else UNSPECIFIED.
inline int leadStatus(const std::string& text, const std::string& lang) {
  const LeadPatterns* P = leadPatterns(lang);
  if (!P) return UNSPECIFIED;
  const rx::Text s = leadSentence(text);
  if (s.empty()) return UNSPECIFIED;
  if (P->presentFormer.test(s)) return PERMANENT_SHUTDOWN;
  // The first copula decides; a passive past ("was founded", "byl založen") is not one.
  size_t from = 0;
  while (from <= s.size()) {
    const auto past = P->past.search(s, from);
    if (!past.ok) return UNSPECIFIED;
    const auto passive = P->passive.search(s, past.begin);
    if (passive.ok && passive.begin == past.begin) { from = past.end; continue; }
    const auto present = P->present.search(s);
    if (present.ok && present.begin < past.begin) return UNSPECIFIED;
    return PERMANENT_SHUTDOWN;
  }
  return UNSPECIFIED;
}

// An organisation or site infobox's closing date ("dissolved = 1991").
inline const std::vector<std::string>& closingKeys() {
  static const std::vector<std::string> v{"dissolved", "defunct", "abolished", "closed", "closing_date", "date_closed", "closure", "aufgelöst", "auflösung", "auflösungsdatum",
                                          "dissolution", "date de dissolution", "disparition", "fermeture", "date de fermeture", "disolución", "fecha de disolución", "clausura",
                                          "scioglimento", "chiusura", "opgeheven", "nedlagd", "likwidacja", "zánik", "упразднён", "ликвидирован", "ліквідовано"};
  return v;
}
inline std::vector<Stated> closingEvidence(const Params& params, int nowYear) {
  std::vector<Stated> out;
  for (const auto& k : closingKeys()) {
    std::string value = trim(stripCommentsAndRefs(param(params, k)));
    if (value.empty()) continue;
    const std::string date = wikiDate(value, nowYear);
    // An undated value is a closure only when it is not a "no" or a placeholder.
    const std::string low = lower(value);
    if (date.empty() && (low == "no" || low == "nein" || low == "non" || low == "-" || low == "—" || low == "n/a")) continue;
    out.push_back({PERMANENT_SHUTDOWN, date, "lead-infobox:" + k});
  }
  return out;
}

// ── Global Energy Monitor ─────────────────────────────────────────────────
inline int gemStatus(const std::string& s) {
  if (s == "operating") return OPERATING;
  if (s == "construction") return UNDER_CONSTRUCTION;
  if (s == "pre-construction" || s == "announced" || s == "shelved") return PLANNED;
  if (s == "mothballed") return LONG_TERM_SHUTDOWN;
  if (s == "retired") return PERMANENT_SHUTDOWN;
  if (s == "cancelled") return CANCELLED;
  return UNSPECIFIED;
}
// A plant's status from its units: one unit running keeps the site running.
inline int plantStatus(const std::vector<int>& statuses) {
  for (int s : {OPERATING, LONG_TERM_SHUTDOWN, UNDER_CONSTRUCTION, PERMANENT_SHUTDOWN, PLANNED, CANCELLED})
    for (int x : statuses) if (x == s) return s;
  return UNSPECIFIED;
}
// gem.mjs nameKey: folded words minus the words that name the kind of site.
inline std::string nameKey(const std::string& name) {
  static const std::set<std::string> stop{"nuclear", "power", "plant", "station", "reactor", "generating", "project", "the", "npp", "centrale", "nucleaire", "kernkraftwerk", "of"};
  std::vector<std::string> kept;
  for (auto& w : foldedWords(name)) if (!stop.count(w)) kept.push_back(w);
  return join(kept, " ");
}

}  // namespace sr
