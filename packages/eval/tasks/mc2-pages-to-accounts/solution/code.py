from navvied_tools import *
import json, re
base = open("docs-url.txt").read().strip()
rows = ["page,account,plan"]
for n in range(1, 13):
    acct = re.search(r"Billing account: (AC-\d+)", web_fetch(f"{base}/status/{n}")).group(1)
    plan = call_tool("mcp__records__get_account", id=acct)["plan"]
    rows.append(f"{n},{acct},{plan}")
write("plans.csv", "\n".join(rows) + "\n")
print(len(rows) - 1, "pages")
