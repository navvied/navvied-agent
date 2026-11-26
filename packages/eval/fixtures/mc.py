#!/usr/bin/env python3
"""
The data and the checks of the multi-call tasks (mc-*), each of which needs many small tool calls with logic between them.

    mc.py setup <task>    writes the task's files into the current folder (the workspace)
    mc.py check <task>    exits 0 when the work in the current folder is right

Everything is made from BENCH_SECRET, so an answer cannot be guessed, and the expected answer is worked out again by the check from the
same generator: it is never stored, and a changed input file cannot change it.
"""
import csv, json, os, random, sys
from pathlib import Path

SECRET = os.environ.get("BENCH_SECRET", "")


def rng(n):
    return random.Random(f"{SECRET}/mc/{n}")


def put(files):
    for name, text in files.items():
        Path(name).parent.mkdir(parents=True, exist_ok=True)
        Path(name).write_text(text)


def load(name, pairs=None):
    try:
        return json.loads(Path(name).read_text(), object_pairs_hook=pairs)
    except (OSError, ValueError):
        return None


def lines_of(name):
    try:
        return [l.strip() for l in Path(name).read_text().splitlines() if l.strip()]
    except OSError:
        return None


# --- 1: sixty small JSON files, totals per category ------------------------------------------------------------------------------

CATEGORIES = ["books", "games", "tools", "toys", "food", "music"]


def records():
    r = rng(1)
    files, want = {}, {}
    for i in range(60):
        category, amount = r.choice(CATEGORIES), r.randint(1, 500)
        status = "void" if r.random() < 0.2 else "ok"
        files[f"data/{r.choice(['north', 'south', 'east'])}/shop-{r.choice('abcd')}/rec-{i:02d}.json"] = json.dumps({"id": f"rec-{i:02d}", "category": category, "amount": amount, "status": status}, indent=2) + "\n"
        if status == "ok":
            total = want.setdefault(category, {"count": 0, "total": 0})
            total["count"] += 1
            total["total"] += amount
    return files, want


# --- 3: a deprecated call written in forty-five files, migrated where it matches ---------------------------------------------------

def sources():
    r = rng(3)
    shape = [r.randint(1, 3) for _ in range(45)]
    slots = [(i, j) for i, n in enumerate(shape) for j in range(n)]
    old = set(r.sample(slots, 30))
    files, want = {}, {}
    for i, n in enumerate(shape):
        head = 'import { openStore } from "../store";\n\n'
        before, after = head, head
        for j in range(n):
            name = f"{r.choice(['cache', 'users', 'orders', 'jobs', 'audit'])}{i}_{j}"
            if (i, j) in old:
                mode = r.choice(["rw", "ro"])
                a, b = f'const s{j} = openStore("{name}", "{mode}");', f'const s{j} = openStore("{name}", {{ mode: "{mode}" }});'
            else:
                a = b = r.choice([
                    f'const s{j} = openStore("{name}", mode);',
                    f'const s{j} = openStore("{name}", {{ mode: "rw", cache: 8 }});',
                    f'const s{j} = openStore("{name}");',
                    f'// the old way was openStore("{name}", "rw")',
                    f"const note{j} = 'call openStore(\"{name}\", \"ro\") to open it';",
                ])
            before += a + "\n"
            after += b + "\n"
        path = f"src/{r.choice(['api', 'jobs', 'ui', 'db'])}/file-{i:02d}.ts"
        files[path], want[path] = before, after
    return files, want


# --- 4: eight logs, errors and the first failing request of each service -----------------------------------------------------------

SERVICES = ["auth", "billing", "cart", "search", "mail", "files", "queue", "web"]


def logs():
    r = rng(4)
    files, want = {}, {}
    for service in SERVICES:
        n = r.randint(300, 400)
        failing = sorted(r.sample(range(40, n), r.randint(4, 12)))
        lines, first = [], None
        for k in range(n):
            stamp = f"2026-11-24T{8 + k // 3600:02d}:{k // 60 % 60:02d}:{k % 60:02d}Z"
            rid = f"req-{r.getrandbits(40):010x}"
            if k in failing:
                level, message = "ERROR", r.choice(["upstream timed out", "connection reset", "disk full", "bad checksum"])
                first = first or rid
            else:
                level = r.choice(["INFO", "INFO", "INFO", "WARN", "DEBUG"])
                message = r.choice(["handled", "cache hit", "retry budget fine: no ERROR in the last 5 min", "slow request, ERROR rate below limit", "queued"])
            lines.append(f"{stamp} {level} {rid} {message}")
        files[f"logs/{service}.log"] = "\n".join(lines) + "\n"
        want[service] = {"errors": len(failing), "first_failing_request": first}
    return files, want


def unique(pairs):
    """An object that writes a key twice would lose one of the two without a word."""
    out = dict(pairs)
    if len(out) != len(pairs):
        raise ValueError("a key is written twice")
    return out


def by_service(name):
    """The report by service. "The file name is the service" reads as auth and as auth.log, so a key may be either; one service named both ways is wrong."""
    got = load(name, unique)
    if not isinstance(got, dict):
        return None
    out = {key.removesuffix(".log"): value for key, value in got.items()}
    return out if len(out) == len(got) else None


# --- 5: thirty modules, the ones that take part in an import cycle -------------------------------------------------------------------

def modules():
    r = rng(5)
    names = [f"m{n:02d}" for n in range(30)]
    r.shuffle(names)
    edges = {n: set() for n in names}
    for i, n in enumerate(names[:-1]):
        edges[n].update(names[j] for j in r.sample(range(i + 1, 30), min(2, 29 - i)))
    for ring in (r.sample(names, 3), r.sample(names, 2)):
        for a, b in zip(ring, ring[1:] + ring[:1]):
            edges[a].add(b)
    files = {}
    for n in names:
        forms = ['import {{ x }} from "./{m}";', 'import {m} from "./{m}";', 'export * from "./{m}";', 'const {m}_ = require("./{m}");']
        body = [r.choice(forms).format(m=m) for m in sorted(edges[n])]
        body.append(f'// import {{ y }} from "./{r.choice(names)}";')
        body.append(f'export const {n}_value = "{r.getrandbits(24):06x}";')
        files[f"src/{n}.ts"] = "\n".join(body) + "\n"
    return files, sorted(cyclic(edges))


def cyclic(edges):
    """The modules in a strongly connected group of two or more (Tarjan), or that import themselves."""
    index, low, stack, on, found, counter = {}, {}, [], set(), set(), [0]

    def visit(v):
        index[v] = low[v] = counter[0]; counter[0] += 1
        stack.append(v); on.add(v)
        for w in edges[v]:
            if w not in index:
                visit(w); low[v] = min(low[v], low[w])
            elif w in on:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            group = []
            while True:
                w = stack.pop(); on.discard(w); group.append(w)
                if w == v:
                    break
            if len(group) > 1 or v in edges[v]:
                found.update(group)

    for v in edges:
        if v not in index:
            visit(v)
    return found


# --- 6: two folders of forty config files, the differences as a table ------------------------------------------------------------------

def configs():
    r = rng(6)
    old, new, rows = {}, {}, []
    touched = set(r.sample(range(40), 14))
    for i in range(40):
        name = f"{i:02d}-{r.choice(['db', 'cache', 'queue', 'web', 'auth', 'log'])}.conf"
        keys = {f"{r.choice(['pool', 'timeout', 'retry', 'host', 'mode', 'limit'])}.{k}": r.choice([str(r.randint(1, 900)), r.choice(["on", "off", "fast", "safe"])]) for k in range(r.randint(6, 10))}
        changed = dict(keys)
        if i in touched:
            for key in r.sample(sorted(keys), r.randint(1, 2)):
                kind = r.choice(["value", "value", "removed"])
                if kind == "removed" and len(changed) > 3:
                    del changed[key]; rows.append([name, key, keys[key], ""])
                else:
                    changed[key] = keys[key] + "9"; rows.append([name, key, keys[key], changed[key]])
            extra = f"extra.{i}"
            changed[extra] = "yes"; rows.append([name, extra, "", "yes"])
        old[f"old/{name}"] = f"# written by deploy {r.getrandbits(16):04x}\n" + "".join(f"{k} = {v}\n" for k, v in keys.items())
        order = list(changed)
        if i % 3 == 0:
            r.shuffle(order)
        new[f"new/{name}"] = f"# written by deploy {r.getrandbits(16):04x}\n" + "".join(f"{k}={changed[k]}  \n" if i % 2 else f"{k} = {changed[k]}\n" for k in order)
    return {**old, **new}, sorted(rows)


# --- the commands -----------------------------------------------------------------------------------------------------------------------------

def final_answer():
    answer = os.environ.get("BENCH_ANSWER_FILE", "")
    return Path(answer).read_text() if answer and Path(answer).is_file() else ""


def named_in_answer(path):
    folder, name = path.rsplit("/", 1)
    said = final_answer()
    return name in said and f"{folder}/" in said


def cycle_lines():
    in_project_folder = lines_of("cycles.txt")
    if in_project_folder is not None:
        return in_project_folder
    return lines_of("src/cycles.txt") if named_in_answer("src/cycles.txt") else None


def check(task):
    if task == "aggregate-json":
        return load("report.json") == records()[1]
    if task == "migrate-calls":
        return all(Path(p).exists() and Path(p).read_text() == text for p, text in sources()[1].items())
    if task == "triage-logs":
        return by_service("triage.json") == logs()[1]
    if task == "import-cycles":
        return cycle_lines() == modules()[1]
    if task == "config-diff":
        try:
            with open("diff.csv", newline="") as f:
                got = list(csv.reader(f))
        except OSError:
            return False
        return got[:1] == [["file", "key", "old", "new"]] and got[1:] == configs()[1]
    raise SystemExit(f"unknown task {task}")


MAKERS = {"aggregate-json": records, "migrate-calls": sources, "triage-logs": logs, "import-cycles": modules, "config-diff": configs}

if __name__ == "__main__":
    command, task = sys.argv[1], sys.argv[2]
    if command == "setup":
        put(MAKERS[task]()[0])
    elif command == "check":
        sys.exit(0 if check(task) else 1)
    else:
        raise SystemExit(f"unknown command {command}")
