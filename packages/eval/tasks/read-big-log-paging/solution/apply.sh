#!/bin/sh
grep -o 'code=[A-Z0-9-]*' logs/big.log | head -1 | cut -d= -f2 > answer.txt
