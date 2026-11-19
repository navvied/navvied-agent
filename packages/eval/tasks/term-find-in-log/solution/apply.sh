grep ' 500 ' logs/app.log | awk '{print $3}' > answer.txt
