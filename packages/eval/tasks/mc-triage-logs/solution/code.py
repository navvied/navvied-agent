from navvied_tools import *
import json, os
out = {}
for f in glob("logs/*.log"):
    errs = [l.split() for l in open(f) if l.split()[1] == "ERROR"]
    out[os.path.basename(f)[:-4]] = {"errors": len(errs), "first_failing_request": errs[0][2]}
write("triage.json", json.dumps(out, indent=2))
print(out)
