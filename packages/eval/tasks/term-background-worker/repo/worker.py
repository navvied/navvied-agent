#!/usr/bin/env python3
"""A worker: writes a heartbeat line every 0.3 s until it is stopped (it stops by itself after two minutes)."""
import hashlib, os, time

token = hashlib.sha1((os.environ.get("BENCH_SECRET", "") + "worker").encode()).hexdigest()[:8]
open("worker.pid", "w").write(str(os.getpid()))
start = time.time()
i = 0
while time.time() - start < 120:
    i += 1
    with open("heartbeat.log", "a") as f:
        f.write("beat %d %s\n" % (i, token))
    time.sleep(0.3)
