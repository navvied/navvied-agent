#!/bin/bash
c() { printf "%s" "${BENCH_SECRET}web$1" | sha1sum | cut -c1-10; }
{ c 5a; c 5b; } > ANSWER.txt
