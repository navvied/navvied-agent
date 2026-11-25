#!/bin/bash
c() { N="$1" bun -e 'console.log(require("node:crypto").createHash("sha1").update(process.env.BENCH_SECRET + "a2a" + process.env.N).digest("hex").slice(0, 10))'; }
c 3 > ANSWER.txt
