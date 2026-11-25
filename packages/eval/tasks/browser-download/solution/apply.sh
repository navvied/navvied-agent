#!/bin/bash
P=$(cat .bench-port) bun -e '
const text = await (await fetch(`http://127.0.0.1:${process.env.P}/report.csv`)).text();
await Bun.write("downloads/report.csv", text);
await Bun.write("ANSWER.txt", text.trim().split("\n")[1].split(",")[1] + "\n");
'
