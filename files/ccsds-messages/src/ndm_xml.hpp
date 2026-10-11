/*
 * files/ccsds-messages — NDM/XML, read and written through pugixml.
 *
 * The XML shape IS the pivot tree's shape, so this file knows nothing about any
 * one message: an element is a `Node`, an element with element children is a
 * group, anything else is a leaf whose text is its content. The `units`
 * attribute is the leaf's units and `parameter` is a USER_DEFINED name; the
 * root's `version` attribute is the root node's text.
 *
 * Reading is forgiving about what XML allows and the Blue Books do not forbid:
 * namespace prefixes are dropped (the qualified schema spells `ndm:omm`),
 * comments, processing instructions and the XML declaration are skipped, and a
 * single message inside the NDM combined `<ndm>` wrapper is found. Writing
 * produces the unqualified instantiation, with the xsi:noNamespaceSchemaLocation
 * the Blue Books show (CCSDS 502.0-B-3 section 7), which is what the NDM/XML
 * 4.0.0 schemas validate.
 */

#ifndef CCSDS_MESSAGES_NDM_XML_HPP
#define CCSDS_MESSAGES_NDM_XML_HPP

#include "ndm_core.hpp"
#include "pugixml.hpp"

namespace ndm {
namespace xml {

inline std::string local_name(const char* qualified) {
    const char* colon = std::strrchr(qualified, ':');
    return colon ? std::string(colon + 1) : std::string(qualified);
}

inline std::string element_text(const pugi::xml_node& el) {
    std::string out;
    for (pugi::xml_node c = el.first_child(); c; c = c.next_sibling()) {
        if (c.type() == pugi::node_pcdata || c.type() == pugi::node_cdata) out += c.value();
    }
    return trim(out);
}

/* An element's text as a KVN value can state it: a value is one line there, so a
 * value that an XML pretty-printer (or a PDF) wrapped is joined with single spaces.
 * The record, and so what is written back as KVN or XML, holds the same text
 * whichever syntax it was read from. */
inline std::string normalise_text(const std::string& text) {
    if (text.find('\n') == std::string::npos && text.find('\r') == std::string::npos) return text;
    std::string out;
    size_t i = 0;
    while (i < text.size()) {
        if (is_space(text[i])) {
            size_t j = i;
            bool newline = false;
            while (j < text.size() && is_space(text[j])) {
                newline = newline || text[j] == '\n' || text[j] == '\r';
                ++j;
            }
            if (newline) out += ' ';
            else out.append(text, i, j - i);
            i = j;
        } else {
            out += text[i++];
        }
    }
    return out;
}

inline bool has_element_child(const pugi::xml_node& el) {
    for (pugi::xml_node c = el.first_child(); c; c = c.next_sibling()) {
        if (c.type() == pugi::node_element) return true;
    }
    return false;
}

inline void to_node(const pugi::xml_node& el, Node* out) {
    out->name = local_name(el.name());
    out->units = el.attribute("units").value();
    out->param = el.attribute("parameter").value();
    for (pugi::xml_node c = el.first_child(); c; c = c.next_sibling()) {
        if (c.type() != pugi::node_element) continue;
        out->group = true;
        if (local_name(c.name()) == "COMMENT" && !has_element_child(c)) {
            /* KVN states a comment a line at a time, and so does the record: a comment
             * the XML wrapped is the lines it wrapped, each without the indentation. */
            for (const std::string& line : split_lines(element_text(c))) {
                out->kids.push_back(Node::leaf("COMMENT", trim(line)));
            }
            continue;
        }
        out->kids.emplace_back();
        to_node(c, &out->kids.back());
    }
    if (!out->group) out->text = normalise_text(element_text(el));
}

/* The message element: the document element, or the one inside <ndm>. */
inline pugi::xml_node find_message(const pugi::xml_document& doc, const std::string& root,
                                   std::string* found) {
    pugi::xml_node top = doc.document_element();
    if (!top) return pugi::xml_node();
    std::string name = local_name(top.name());
    *found = name;
    if (name == "ndm") {
        pugi::xml_node match;
        size_t matches = 0;
        for (pugi::xml_node c = top.first_child(); c; c = c.next_sibling()) {
            if (c.type() != pugi::node_element) continue;
            const std::string child = local_name(c.name());
            *found = child;
            if (child == root) {
                if (!match) match = c;
                ++matches;
            }
        }
        if (matches > 1) {
            *found = root + "*" + std::to_string(matches);  /* read() names the refusal */
        }
        return match;
    }
    return name == root ? top : pugi::xml_node();
}

/* Parse `data` and build the pivot tree of the `root` message in it. On failure
 * returns false with *error naming what was wrong; *found holds the root element
 * that was there instead, when there was one. */
inline bool read(const char* data, size_t length, const std::string& root, Node* out,
                 std::string* error, std::string* found) {
    pugi::xml_document doc;
    const pugi::xml_parse_result parsed = doc.load_buffer(data, length);
    if (!parsed) {
        *error = std::string("not well-formed XML: ") + parsed.description();
        return false;
    }
    pugi::xml_node message = find_message(doc, root, found);
    if (message && found->find('*') != std::string::npos) {
        *error = "the NDM holds " + found->substr(found->find('*') + 1) + " <" + root +
                 "> messages; this reads one message per file (multiple-messages)";
        return false;
    }
    if (!message) {
        *error = found->empty() ? std::string("the document has no root element")
                                : "the document holds <" + *found + ">, not <" + root + ">";
        return false;
    }
    to_node(message, out);
    out->text = message.attribute("version").value();
    return true;
}

/* ------------------------------------------------------------------------ */
/* Writing                                                                   */
/* ------------------------------------------------------------------------ */

struct StringWriter : pugi::xml_writer {
    std::string* out;
    explicit StringWriter(std::string* s) : out(s) {}
    void write(const void* data, size_t size) override {
        out->append(static_cast<const char*>(data), size);
    }
};

inline void to_xml(const Node& n, pugi::xml_node parent, bool units) {
    pugi::xml_node el = parent.append_child(n.name.c_str());
    if (n.group) {
        for (const Node& k : n.kids) to_xml(k, el, units);
        return;
    }
    if (units && !n.units.empty()) el.append_attribute("units") = n.units.c_str();
    if (!n.param.empty()) el.append_attribute("parameter") = n.param.c_str();
    if (!n.text.empty()) el.append_child(pugi::node_pcdata).set_value(n.text.c_str());
}

inline const char* schema_location() {
    return "https://sanaregistry.org/r/ndmxml_unqualified/ndmxml-4.0.0-master-4.0.xsd";
}

/* The message `root` element with its id and version, the header and body
 * below it as `tree.kids`. `units` states the units attribute on every leaf
 * that has one. */
inline void write(const std::string& root, const std::string& version_key,
                  const std::string& version, const Node& tree, bool units, std::string* out) {
    pugi::xml_document doc;
    pugi::xml_node decl = doc.append_child(pugi::node_declaration);
    decl.append_attribute("version") = "1.0";
    decl.append_attribute("encoding") = "UTF-8";
    pugi::xml_node el = doc.append_child(root.c_str());
    el.append_attribute("xmlns:xsi") = "http://www.w3.org/2001/XMLSchema-instance";
    el.append_attribute("xsi:noNamespaceSchemaLocation") = schema_location();
    el.append_attribute("id") = version_key.c_str();
    el.append_attribute("version") = version.c_str();
    for (const Node& k : tree.kids) to_xml(k, el, units);
    out->clear();
    StringWriter writer(out);
    doc.save(writer, "  ", pugi::format_indent, pugi::encoding_utf8);
}

}  // namespace xml
}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_XML_HPP
