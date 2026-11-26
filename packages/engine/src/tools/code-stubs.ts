export const STUBS = `import json, os, re, socket, threading

__all__ = ["read", "grep", "glob", "write", "edit", "bash", "web_fetch", "web_search", "call_tool", "ToolError"]


class ToolError(RuntimeError):
    pass


_lock = threading.Lock()
_conn = None
_door = None


def _call(tool, **args):
    global _conn
    with _lock:
        if _conn is None:
            s = socket.create_connection(("127.0.0.1", _door[0]))
            _conn = s.makefile("rw", encoding="utf-8", newline="\\n")
            _conn.write(_door[1] + "\\n")
        _conn.write(json.dumps({"tool": tool, "args": {k: v for k, v in args.items() if v is not None}}) + "\\n")
        _conn.flush()
        line = _conn.readline()
    if not line:
        raise ToolError("the connection to the program was closed")
    answer = json.loads(line)
    if not answer["ok"]:
        raise ToolError(answer["text"])
    return answer["text"]


def read(path, offset=None, limit=None):
    text = _call("Read", file_path=path, offset=offset, limit=limit)
    return "\\n".join(re.sub(r"^ *\\d+\\t", "", line, count=1) for line in text.split("\\n"))


def grep(pattern, path=None, glob=None):
    return [l for l in _call("Grep", pattern=pattern, path=path, glob=glob).split("\\n") if re.match(r".+?:\\d+:", l)]


def glob(pattern):
    return [l for l in _call("Glob", pattern=pattern).split("\\n") if l and not l.startswith("[") and l != "No files matched."]


def write(path, content):
    return _call("Write", file_path=path, content=content)


def edit(path, old, new, replace_all=False):
    return _call("Edit", file_path=path, old_string=old, new_string=new, replace_all=replace_all or None)


def bash(command):
    return _call("Bash", command=command)


def _reset(door=None):
    global _conn, _door
    if door is not None:
        _door = door
    if _conn is not None:
        try:
            _conn.close()
        except OSError:
            pass
    _conn = None


def call_tool(name, **args):
    text = _call(name, **args)
    if name in ("WebFetch", "WebSearch"):
        text = _unframed(text)
    if text[:1] in ("{", "["):
        try:
            return json.loads(text)
        except ValueError:
            pass
    return text


def _unframed(text):
    text = re.sub(r"\\A<navvied-web [^>]*>\\n[^\\n]*\\n(?:Page [^\\n]*\\n)?", "", text)
    return re.sub(r"\\n</navvied-web>", "", text)


def web_fetch(url):
    return _unframed(_call("WebFetch", url=url))


def web_search(query):
    return _unframed(_call("WebSearch", query=query))
`;
