#!/usr/bin/env bash
# Asks three questions on its input and writes config.ini.
ask() {
  printf "%s " "$1"
  if ! read -r answer; then echo; echo "error: no answer: this installer needs someone to type to it" >&2; exit 1; fi
  eval "$2=\$answer"
}
ask "Project name:" name
ask "Port:" port
ask "Enable metrics (y/n):" metrics
case "$metrics" in y|n) ;; *) echo "answer y or n" >&2; exit 1 ;; esac
token=$(python3 -c "import hashlib,os; print(hashlib.sha1((os.environ.get('BENCH_SECRET','') + 'inst').encode()).hexdigest()[:12])")
printf "name=%s\nport=%s\nmetrics=%s\ntoken=%s\n" "$name" "$port" "$metrics" "$token" > config.ini
echo "wrote config.ini"
