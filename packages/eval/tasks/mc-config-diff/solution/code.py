from navvied_tools import *
import csv, io, os
def load(path):
    d = {}
    for l in open(path):
        l = l.strip()
        if l and not l.startswith("#"):
            k, v = l.split("=", 1)
            d[k.strip()] = v.strip()
    return d
rows = []
for f in sorted(glob("old/*.conf")):
    name = os.path.basename(f)
    a, b = load(f), load("new/" + name)
    rows += [[name, k, a.get(k, ""), b.get(k, "")] for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)]
out = io.StringIO()
w = csv.writer(out, lineterminator="\n")
w.writerow(["file", "key", "old", "new"])
w.writerows(rows)
write("diff.csv", out.getvalue())
print(len(rows), "differences")
