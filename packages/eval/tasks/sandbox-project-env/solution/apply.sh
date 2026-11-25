grep '^SERVICE_URL=' .env | cut -d= -f2- > service-url.txt
grep -c '=' .env > count.txt
