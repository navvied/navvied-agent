from navvied_tools import *
import os, re
edges = {}
for f in glob("src/*.ts"):
    edges[os.path.basename(f)[:-3]] = {m for l in read(f).split("\n") if not l.startswith("//") for m in re.findall(r'"\./(\w+)"', l)}
def reach(n):
    seen, todo = set(), list(edges[n])
    while todo:
        m = todo.pop()
        if m not in seen:
            seen.add(m)
            todo += edges[m]
    return seen
cycles = [n for n in sorted(edges) if n in reach(n)]
write("cycles.txt", "".join(n + "\n" for n in cycles))
print(cycles)
