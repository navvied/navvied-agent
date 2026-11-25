python3 service.py > service.out 2>&1 &
pid=$!
until grep -q 'listening on port' service.out; do sleep 0.2; done
grep -o 'port [0-9]*' service.out | cut -d' ' -f2 > port.txt
kill $pid
wait $pid 2>/dev/null
true
