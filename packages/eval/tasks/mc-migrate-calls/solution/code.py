from navvied_tools import *
import re
for hit in grep(r'^const s[0-9]+ = openStore\("[^"]+", "(rw|ro)"\);$', "src"):
    path, _, text = hit.split(":", 2)
    edit("src/" + path, text, re.sub(r'", "(rw|ro)"\);$', r'", { mode: "\1" });', text))
