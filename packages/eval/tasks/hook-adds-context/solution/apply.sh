python3 -c "import hashlib,os; print(hashlib.sha1((os.environ['BENCH_SECRET']+'codename').encode()).hexdigest()[:10])" > CODENAME.txt
