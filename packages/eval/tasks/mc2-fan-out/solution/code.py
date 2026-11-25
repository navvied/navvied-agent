from navvied_tools import *
import json
ids, page = [], 1
while page:
    r = call_tool("mcp__records__list_accounts", page=page)
    ids += r["accounts"]
    page = r["next_page"]
over = []
for i in ids:
    a = call_tool("mcp__records__get_account", id=i)
    if a["billing"]["balance_due_cents"] > 250000:
        over.append(a["id"])
write("over.txt", "\n".join(sorted(over)) + "\n")
print(len(ids), "accounts,", len(over), "over")
