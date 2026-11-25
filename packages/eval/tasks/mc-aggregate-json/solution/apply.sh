#!/bin/bash
python3 - <<'EOF'
import glob, json
agg = {}
for f in glob.glob("data/**/*.json", recursive=True):
    d = json.load(open(f))
    if d["status"] == "ok":
        a = agg.setdefault(d["category"], {"count": 0, "total": 0})
        a["count"] += 1
        a["total"] += d["amount"]
json.dump(agg, open("report.json", "w"), indent=2, sort_keys=True)
EOF
