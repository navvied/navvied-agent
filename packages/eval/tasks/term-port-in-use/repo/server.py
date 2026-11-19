#!/usr/bin/env python3
"""A small web service: GET /health answers with a JSON object."""
import hashlib, json, os, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer

DELAY = 1
port = int(open("port.txt").read().strip())
secret = hashlib.sha1((os.environ.get("BENCH_SECRET", "") + "srv").encode()).hexdigest()[:12]
print("starting...", flush=True)
time.sleep(DELAY)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"status": "ok", "secret": secret}).encode()
        self.send_response(200 if self.path == "/health" else 404)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body if self.path == "/health" else b"{}")

    def log_message(self, *args):
        pass


try:
    server = HTTPServer(("127.0.0.1", port), Handler)
except OSError as e:
    print("error: cannot listen on port %d: %s" % (port, e), file=sys.stderr, flush=True)
    sys.exit(1)
print("ready on http://127.0.0.1:%d" % port, flush=True)
server.serve_forever()
