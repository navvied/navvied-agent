python3 server.py > server.log 2>&1 &
pid=$!
# Wait for the service to say it is ready (the state), not for a number of tries: a busy machine starts it late.
for i in $(seq 1 600); do
  grep -q '^ready' server.log && break
  kill -0 $pid 2>/dev/null || break
  sleep 0.2
done
# Only a ready server is asked: after one that ended, whatever else answers on the port is not the answer.
grep -q '^ready' server.log && python3 -c "import sys,urllib.request; open('health.json','wb').write(urllib.request.urlopen('http://127.0.0.1:'+open('port.txt').read().strip()+'/health', timeout=10).read())"
got=$?
kill $pid 2>/dev/null
wait $pid 2>/dev/null
# A solution that failed says what the server said, not only that the check failed afterwards.
[ $got = 0 ] || { cat server.log >&2; exit 1; }
