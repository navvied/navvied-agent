#!/bin/bash
python3 - <<'EOF'
import glob, re
pat = re.compile(r'^(\s*const \w+ = openStore\("[^"]+"), "(rw|ro)"\);$')
for f in glob.glob("src/**/*.ts", recursive=True):
    lines = open(f).read().split("\n")
    open(f, "w").write("\n".join(pat.sub(lambda m: m.group(1) + ", { mode: \"" + m.group(2) + "\" });", l) for l in lines))
EOF
