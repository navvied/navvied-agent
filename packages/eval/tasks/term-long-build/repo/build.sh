#!/usr/bin/env bash
# A build that takes a while and prints its progress.
seconds="${BUILD_SECONDS:-40}"
for i in $(seq 1 "$seconds"); do
  echo "step $i/$seconds: compiling"
  sleep 1
done
sum=$(python3 -c "import hashlib,os; print(hashlib.sha1((os.environ.get('BENCH_SECRET','') + 'build').encode()).hexdigest()[:12])")
echo "build finished"
echo "checksum: $sum"
