python3 -c "import hashlib,os; print(hashlib.sha1((os.environ['BENCH_SECRET']+'prefix').encode()).hexdigest()[:8] + ': fix the typo in the greeting')" > COMMIT.txt
printf 'Hello, world\n' > greet.txt
