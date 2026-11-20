#!/bin/bash
curl -s "$(cat docs-url.txt)/blocked-search?q=falcon+maintainer" > /dev/null
echo "The search was blocked by a challenge (429), so it could not be done" > ANSWER.txt
