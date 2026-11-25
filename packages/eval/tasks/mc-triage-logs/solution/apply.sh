#!/bin/bash
python3 - <<'EOF'
import glob, json, os
out = {}
for f in sorted(glob.glob("logs/*.log")):
    errs = [l.split() for l in open(f) if l.split()[1] == "ERROR"]
    out[os.path.basename(f)[:-4]] = {"errors": len(errs), "first_failing_request": errs[0][2]}
json.dump(out, open("triage.json", "w"), indent=2)
EOF
