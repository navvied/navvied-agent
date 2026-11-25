#!/bin/bash
P=$(cat .bench-port) bun -e '
const base = `http://127.0.0.1:${process.env.P}`;
const page = await (await fetch(`${base}/signup`, { method: "POST", body: new URLSearchParams({ name: "Mira Ode", plan: "team", terms: "yes" }) })).text();
await Bun.write("ANSWER.txt", /Signup code: (\w+)/.exec(page)![1] + "\n");
'
