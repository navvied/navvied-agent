#!/bin/bash
P=$(cat .bench-port) bun -e '
const base = `http://127.0.0.1:${process.env.P}`;
const r = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ email: "ann@example.com", password: "Zx9!kQ7mPw" }), redirect: "manual" });
const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
const page = await (await fetch(`${base}/account`, { headers: { cookie } })).text();
await Bun.write("ANSWER.txt", /Account code: (\w+)/.exec(page)![1] + "\n");
'
