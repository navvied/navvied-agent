python3 worker.py &
pid=$!
until [ "$(wc -l < heartbeat.log 2>/dev/null || echo 0)" -ge 8 ]; do sleep 0.2; done
wc -l < heartbeat.log | tr -d ' ' > beats.txt
kill $pid
wait $pid 2>/dev/null
true
