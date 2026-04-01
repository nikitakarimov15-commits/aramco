import re
from pathlib import Path

s = Path("assets/index-8920794d.js").read_text(encoding="utf-8", errors="ignore")
seen = set()
for m in re.finditer(r"\.(get|post|put|delete|patch)\(\s*[`\"]([^`\"]+)[`\"]", s):
    url = m.group(2)
    if url.startswith("/") and len(url) < 150:
        seen.add((m.group(1), url))
for method, url in sorted(seen, key=lambda x: x[1]):
    print(f"{method}\t{url}")
print("TOTAL", len(seen), file=__import__("sys").stderr)
