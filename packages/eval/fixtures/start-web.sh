#!/bin/bash
# Starts the fixture web in the background and leaves its address in the workspace (the folder this is run from).
# The server runs from the fixtures folder with the workspace only in its environment, so it is not taken for something the agent left running.
set -e
OUT="$PWD"
PORT=$(bun -e 'const s = Bun.serve({ port: 0, fetch: () => new Response("") }); console.log(s.port); s.stop(true);')
echo "$PORT" > .bench-port
cd "$BENCH_FIXTURES"
BENCH_OUT="$OUT" setsid nohup bun web-server.ts "$PORT" > /dev/null 2>&1 &
echo $! > "$OUT/.bench-pid"
for _ in $(seq 1 100); do
  if curl -fs "http://127.0.0.1:$PORT/ready" > /dev/null 2>&1; then exit 0; fi
  sleep 0.1
done
echo "the fixture web did not start" >&2
exit 1
