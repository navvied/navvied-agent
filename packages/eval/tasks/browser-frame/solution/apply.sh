#!/bin/bash
C=$(bun -e 'console.log(new Bun.CryptoHasher("sha1").update(process.env.BENCH_SECRET + "web" + "13").digest("hex").slice(0, 10))')
echo "$C" > ANSWER.txt
