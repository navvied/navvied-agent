from navvied_tools import *
import json
found, page = None, 1
while page and not found:
    r = call_tool("mcp__records__list_accounts", page=page)
    for i in r["accounts"]:
        if call_tool("mcp__records__get_account", id=i)["flags"]["audit_hold"]:
            found = i
            break
    page = r["next_page"]
inv = call_tool("mcp__records__get_invoices", account_id=found)["invoices"]
unpaid = sum(x["total_cents"] for x in inv if x["status"] in ("open", "overdue"))
write("hold.json", json.dumps({"account": found, "unpaid_cents": unpaid}))
print(found, unpaid)
