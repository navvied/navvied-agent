from navvied_tools import *
import json
first = call_tool("mcp__records__list_accounts", page=1)["accounts"][0]
found = call_tool("mcp__records__search_tickets", query=first)["tickets"]
write("tickets.txt", "\n".join(sorted(t["id"] for t in found)) + "\n")
print(first, len(found))
