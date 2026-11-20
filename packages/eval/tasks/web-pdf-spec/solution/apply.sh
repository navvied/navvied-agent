#!/bin/bash
# The agent knows nothing of the fixtures, so this only needs bun and the run's secret.
c() { N="$1" bun -e 'console.log(require("node:crypto").createHash("sha1").update(process.env.BENCH_SECRET + "web" + process.env.N).digest("hex").slice(0, 10))'; }
c 4 > ANSWER.txt
