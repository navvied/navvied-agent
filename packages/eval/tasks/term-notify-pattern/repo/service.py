#!/usr/bin/env python3
"""A service that takes a few seconds to come up, and then says which port it listens on."""
import hashlib, os, time

open("service.pid", "w").write(str(os.getpid()))
print("starting", flush=True)
time.sleep(5)
port = 20000 + int(hashlib.sha1((os.environ.get("BENCH_SECRET", "") + "port").encode()).hexdigest()[:6], 16) % 1000
print("listening on port %d" % port, flush=True)
while True:
    print("heartbeat", flush=True)
    time.sleep(1)
