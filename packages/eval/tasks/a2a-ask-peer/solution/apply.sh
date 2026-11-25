#!/bin/bash
# The reference solution does what the agent does, without asking: the check also reads what was asked, so the oracle script asks.
c() { N="$1" bun -e 'console.log(require("node:crypto").createHash("sha1").update(process.env.BENCH_SECRET + "a2a" + process.env.N).digest("hex").slice(0, 10))'; }
c 1 > ANSWER.txt
echo "docs: What is the deployment code?" > asked.log
