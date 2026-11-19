python3 server.py > server.log 2>&1 &
pid=$!
for i in $(seq 1 60); do
  if python3 -c "import sys,urllib.request; open('health.json','wb').write(urllib.request.urlopen('http://127.0.0.1:'+open('port.txt').read().strip()+'/health', timeout=2).read())" 2>/dev/null; then break; fi
  sleep 0.5
done
kill $pid
wait $pid 2>/dev/null
true
