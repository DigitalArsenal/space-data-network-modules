"""Cut a Sentinel EOF down to a whole-OSV window.

The header, every OSV block inside the window and the closing tags are kept byte for byte; the only
edit is List_of_OSVs count="N", which is rewritten to the number of OSVs kept.
usage: eof_excerpt.py <in.EOF> <out.EOF> <first UTC> <last UTC>   (UTC as 2024-01-09T22:59:42)
"""
import re, sys
src, dst, first, last = sys.argv[1:5]
text = open(src, encoding="utf-8").read()
m = re.search(r'(<List_of_OSVs count=")(\d+)(">\n)', text)
head, body_start = text[:m.start()], m.end()
end = text.index("    </List_of_OSVs>")
body, tail = text[body_start:end], text[end:]
osvs = re.findall(r"      <OSV>\n.*?      </OSV>\n", body, flags=re.S)
assert "".join(osvs) == body, "OSV blocks do not tile the list"
keep = []
for o in osvs:
    utc = re.search(r"<UTC>UTC=([^<]+)</UTC>", o).group(1)
    if first <= utc[:19] <= last:
        keep.append(o)
out = head + m.group(1) + str(len(keep)) + m.group(3) + "".join(keep) + tail
open(dst, "w", encoding="utf-8").write(out)
print(dst, len(keep), "OSVs of", len(osvs), len(out), "bytes")
