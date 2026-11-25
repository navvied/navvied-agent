#!/usr/bin/env bash
# A build that takes a while. Every run is written down in runs.log.
echo run >> runs.log
seconds="${BUILD_SECONDS:-8}"
for i in $(seq 1 "$seconds"); do
  echo "step $i/$seconds: compiling"
  sleep 1
done
sum=$(python3 -c "import hashlib,os; print(hashlib.sha1((os.environ.get('BENCH_SECRET','') + 'jobresult').encode()).hexdigest()[:12])")
echo "build finished"
echo "result: $sum"
