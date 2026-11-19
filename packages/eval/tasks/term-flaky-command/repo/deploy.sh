#!/usr/bin/env bash
# Deploys. The network is unreliable: the first attempts can fail.
n=$(cat .attempts 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > .attempts
if [ "$n" -lt 3 ]; then
  echo "error: temporary failure, the upstream did not answer (try again)" >&2
  exit 1
fi
python3 -c "import hashlib,os; print(hashlib.sha1((os.environ.get('BENCH_SECRET','') + 'deploy').encode()).hexdigest()[:12])" > deployed.txt
echo "deployed"
