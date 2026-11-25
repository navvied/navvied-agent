from navvied_tools import *
import json
tickets = call_tool("mcp__records__search_tickets", query="chargeback")["tickets"]
rows = ["ticket,account,region,unpaid_cents"]
for t in sorted((t for t in tickets if t["status"] == "open"), key=lambda t: t["id"]):
    a = call_tool("mcp__records__get_account", id=t["account_id"])
    inv = call_tool("mcp__records__get_invoices", account_id=t["account_id"])["invoices"]
    unpaid = sum(x["total_cents"] for x in inv if x["status"] in ("open", "overdue"))
    rows.append(f'{t["id"]},{t["account_id"]},{a["region"]},{unpaid}')
write("report.csv", "\n".join(rows) + "\n")
print(len(rows) - 1, "tickets")
