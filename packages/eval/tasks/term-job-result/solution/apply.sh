bash build.sh > build.out 2>&1 &
pid=$!
wait $pid
grep '^result:' build.out | sed 's/^result: //' > result.txt
