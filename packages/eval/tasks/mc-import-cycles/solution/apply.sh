#!/bin/bash
python3 - <<'EOF'
import glob, os, re
edges = {}
for f in glob.glob("src/*.ts"):
    edges[os.path.basename(f)[:-3]] = {m for l in open(f) if not l.startswith("//") for m in re.findall(r'"\./(\w+)"', l)}
def reach(n):
    seen, todo = set(), list(edges[n])
    while todo:
        m = todo.pop()
        if m not in seen:
            seen.add(m)
            todo += edges[m]
    return seen
open("cycles.txt", "w").write("".join(n + "\n" for n in sorted(edges) if n in reach(n)))
EOF
