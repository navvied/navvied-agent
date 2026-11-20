python3 server.py > server.log 2>&1 &
pid=$!
# Wait for the service to say it is ready (the state), not for a number of tries: a busy machine starts it late.
for i in $(seq 1 600); do
  grep -q '^ready' server.log && break
  kill -0 $pid 2>/dev/null || break
  sleep 0.2
done
python3 -c "import sys,urllib.request; open('health.json','wb').write(urllib.request.urlopen('http://127.0.0.1:'+open('port.txt').read().strip()+'/health', timeout=10).read())"
kill $pid
wait $pid 2>/dev/null
true
