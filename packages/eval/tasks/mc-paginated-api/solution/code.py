from navvied_tools import *
import json
url = open("docs-url.txt").read().strip() + "/api/items"
items = []
while url:
    page = json.loads(web_fetch(url))
    items += page["items"]
    url = page["next"]
items.sort(key=lambda i: (-i["score"], i["id"]))
write("items.json", json.dumps(items))
print(len(items), "items")
