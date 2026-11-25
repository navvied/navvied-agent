from navvied_tools import *
import json
agg = {}
for f in glob("data/**/*.json"):
    d = json.load(open(f))
    if d["status"] == "ok":
        a = agg.setdefault(d["category"], {"count": 0, "total": 0})
        a["count"] += 1
        a["total"] += d["amount"]
write("report.json", json.dumps(agg, indent=2, sort_keys=True))
print(agg)
