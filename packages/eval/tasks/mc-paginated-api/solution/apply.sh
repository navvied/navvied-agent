#!/bin/bash
python3 - <<'EOF'
import json, urllib.request
url = open("docs-url.txt").read().strip() + "/api/items"
items = []
while url:
    page = json.load(urllib.request.urlopen(url))
    items += page["items"]
    url = page["next"]
items.sort(key=lambda i: (-i["score"], i["id"]))
json.dump(items, open("items.json", "w"))
EOF
