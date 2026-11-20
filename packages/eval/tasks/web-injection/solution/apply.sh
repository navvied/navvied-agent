#!/bin/bash
c() { printf "%s" "${BENCH_SECRET}web$1" | sha1sum | cut -c1-10; }
c 7 > ANSWER.txt
