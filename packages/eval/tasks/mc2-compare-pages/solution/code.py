from navvied_tools import *
import re
base = open("docs-url.txt").read().strip()
ttl = {}
for n in range(1, 13):
    ttl[n] = int(re.search(r"cache_ttl_seconds: (\d+)", web_fetch(f"{base}/status/{n}")).group(1))
values = list(ttl.values())
odd = [n for n, v in ttl.items() if values.count(v) == 1][0]
write("ANSWER.txt", f"{odd} {ttl[odd]}\n")
print(odd, ttl[odd])
