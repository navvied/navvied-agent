// The two pages that ship inside the app. They need no network: the content security policy forbids it.
(() => {
  const kind = location.hash.replace(/^#/, "");
  const act = (action) => window.__TAURI_INTERNALS__.invoke("page_action", { action });
  const TEXT = {
    missing: ["navvied cannot start", "A file that navvied needs is missing or damaged. This usually happens when an antivirus program moves it. Installing navvied again fixes it, and your chats are kept.", "engine file not found", [["Show details", "details"], ["Download navvied again", "download", 1]]],
    blocked: ["navvied was stopped from starting", "Security software or the system stopped the part of navvied that talks to your model. Allow “navvied” in that program, then try again.", "the engine was closed right after it started", [["Show details", "details"], ["Try again", "try_again", 1]]],
    noanswer: ["navvied did not answer", "The part of navvied that talks to your model started but did not answer in time. Trying again usually fixes it.", "no answer within 10 seconds", [["Show details", "details"], ["Try again", "try_again", 1]]],
  };
  const t = TEXT[kind];
  if (!t) return;
  document.getElementById("h").textContent = t[0];
  document.getElementById("p").textContent = t[1];
  const code = document.getElementById("c"), row = document.getElementById("b");
  const show = (text) => { code.textContent = text; code.hidden = false; };
  show("Reason: " + t[2]);
  for (const [label, action, primary] of t[3]) {
    const b = document.createElement("button");
    b.textContent = label; if (primary) b.className = "pri";
    b.addEventListener("click", async () => {
      if (action === "details") { try { show((await act("details")) || "Reason: " + t[2]); } catch { /* nothing to show */ } } else act(action).catch(() => {});
    });
    row.append(b);
  }
})();
