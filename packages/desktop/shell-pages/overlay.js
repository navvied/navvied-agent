// Draws the app's own questions on top of the navvied page: the same cards as the approved previews, in the page's colours.
// It only talks to the app through three commands, and only answers what the app asked (each question has an id).
(() => {
  if (window.__navviedShell) return;
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483000;pointer-events:none";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    *{box-sizing:border-box}
    .layer{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:var(--overlay,rgba(0,0,0,.45));pointer-events:auto}
    .layer.on{display:flex}
    .card{background:var(--elevated,#fff);color:var(--text,#0d0d0d);border-radius:16px;padding:24px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;box-shadow:var(--pop-shadow,0 12px 48px rgba(0,0,0,.3)),0 0 0 1px var(--border-strong,rgba(0,0,0,.12));font:14px/21px -apple-system,ui-sans-serif,system-ui,"Segoe UI",Helvetica,Arial,sans-serif}
    h2{margin:0 0 8px;font-size:20px;line-height:26px;font-weight:600}
    p{margin:0 0 12px;color:var(--text-dim,#5d5d5d)}
    .kv{display:grid;grid-template-columns:130px 1fr;gap:6px 14px;margin:12px 0}.kv b{font-weight:500;color:var(--text-dim,#5d5d5d)}
    .code{background:var(--surface-2,#f4f4f4);border:1px solid var(--border-strong,rgba(0,0,0,.12));border-radius:10px;padding:8px 12px;margin:10px 0;font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;color:var(--text,#0d0d0d)}
    .row{display:flex;gap:8px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap}
    button{font:inherit;color:inherit;cursor:pointer;height:36px;padding:0 16px;border-radius:999px;border:1px solid var(--border-strong,rgba(0,0,0,.12));background:transparent;white-space:nowrap}
    button.pri{background:var(--accent,#6d5cf0);border-color:var(--accent,#6d5cf0);color:var(--on-accent,#fff);font-weight:500}
    button:focus-visible{outline:2px solid var(--accent,#6d5cf0);outline-offset:2px}
    label.chk{display:flex;gap:8px;align-items:center;color:var(--text-dim,#5d5d5d);margin-top:6px}
    .bar{height:6px;border-radius:3px;background:var(--border-strong,rgba(0,0,0,.12));overflow:hidden;margin:8px 0}.bar i{display:block;height:100%;background:var(--accent,#6d5cf0)}
    .set{display:flex;align-items:center;gap:16px;padding:14px 0;border-bottom:1px solid var(--border-strong,rgba(0,0,0,.12))}.set .t{flex:1}.set .t b{display:block;font-weight:500}.set .t small{display:block;color:var(--text-dim,#5d5d5d);font-size:13px;line-height:18px}
    .set input{width:38px;height:22px;accent-color:var(--accent,#6d5cf0)}
    .banner{position:absolute;left:0;right:0;top:0;padding:10px 16px;display:none;align-items:center;gap:12px;pointer-events:auto;font:14px/20px system-ui,sans-serif;color:var(--text,#0d0d0d);border-bottom:1px solid}
    .banner.on{display:flex}
    .banner.warn{background:color-mix(in srgb,var(--warning,#d97706) 20%,var(--bg,#fff));border-color:var(--warning,#d97706)}
    .banner.ok{background:color-mix(in srgb,var(--success,#059669) 18%,var(--bg,#fff));border-color:var(--success,#059669)}
    .banner.bad{background:color-mix(in srgb,var(--danger,#dc2626) 16%,var(--bg,#fff));border-color:var(--danger,#dc2626)}
    .banner button{margin-left:auto;height:28px;padding:0 12px}
    .spin{width:16px;height:16px;border-radius:50%;border:2px solid var(--text-faint,#8f8f8f);border-top-color:var(--accent,#6d5cf0);animation:s 1s linear infinite;flex:none}@keyframes s{to{transform:rotate(1turn)}}
  </style><div class="banner" id="banner"></div><div class="layer" id="layer"></div>`;
  const layer = root.getElementById("layer"), banner = root.getElementById("banner");
  const el = (tag, props, ...kids) => { const n = document.createElement(tag); Object.assign(n, props || {}); n.append(...kids.filter((k) => k !== null && k !== undefined)); return n; };
  const answer = (id, choice, checked) => invoke("shell_answer", { id, choice, checked: !!checked }).catch(() => {});
  let current = null, currentCard = null;

  function close() { layer.classList.remove("on"); layer.replaceChildren(); current = null; currentCard = null; }

  function settingsRows(card) {
    const holder = el("div");
    invoke("shell_settings_get").then((s) => {
      for (const r of card.toggles) {
        const box = el("input", { type: "checkbox", checked: !!s[r.key] });
        box.addEventListener("change", () => invoke("shell_settings_set", { key: r.key, value: box.checked }).catch(() => { box.checked = !box.checked; }));
        holder.append(el("div", { className: "set" }, el("span", { className: "t" }, el("b", { textContent: r.label }), el("small", { textContent: r.hint })), box));
      }
      holder.append(el("div", { className: "set" }, el("span", { className: "t" }, el("b", { textContent: "Project folder" }), el("small", { textContent: s.folder || "None chosen yet" })), el("button", { textContent: "Change…", onclick: () => answer(card.id, "choose_folder") })));
    }).catch(() => holder.append(el("p", { textContent: "The settings could not be read." })));
    return holder;
  }

  window.__navviedShell = {
    show(card) {
      current = card.id; currentCard = card;
      const kids = [el("h2", { textContent: card.title })];
      if (card.body) kids.push(el("p", { textContent: card.body }));
      if (card.rows) kids.push(el("div", { className: "kv" }, ...card.rows.flatMap(([k, v]) => [el("b", { textContent: k }), el("span", { textContent: v })])));
      if (card.code) kids.push(el("div", { className: "code", textContent: card.code }));
      if (card.progress !== undefined) kids.push(el("div", { className: "bar", id: "bar" }, el("i", { style: `width:${Math.max(0, Math.min(100, card.progress))}%` })));
      if (card.toggles) kids.push(settingsRows(card));
      let box = null;
      if (card.checkbox) { box = el("input", { type: "checkbox" }); kids.push(el("label", { className: "chk" }, box, card.checkbox)); }
      const row = el("div", { className: "row" });
      for (const b of card.buttons || []) {
        const btn = el("button", { textContent: b.label, className: b.kind === "pri" ? "pri" : "" });
        btn.addEventListener("click", () => {
          if (b.choice === "copy") { navigator.clipboard.writeText(card.copy || card.code || "").catch(() => {}); return; }
          close(); answer(card.id, b.choice, box && box.checked);
        });
        row.append(btn);
      }
      kids.push(row);
      const c = el("div", { className: "card", role: "dialog", "aria-modal": "true", "aria-label": card.title }, ...kids);
      c.style.width = (card.width || 460) + "px";
      layer.replaceChildren(c);
      layer.classList.add("on");
      (row.querySelector(".pri") || row.querySelector("button"))?.focus();
    },
    progress(pct) { const i = layer.querySelector(".bar i"); if (i) i.style.width = Math.max(0, Math.min(100, pct)) + "%"; },
    hide(id) { if (!id || current === id) close(); },
    banner(b) {
      banner.className = "banner on " + b.kind;
      banner.replaceChildren(b.spin ? el("span", { className: "spin" }) : el("b", { textContent: b.kind === "ok" ? "✓" : "!" }), el("span", {}, el("b", { textContent: b.text + " " }), b.more || ""));
      if (b.dismiss) banner.append(el("button", { textContent: "OK", onclick: () => banner.classList.remove("on") }));
    },
    clearBanner() { banner.classList.remove("on"); },
    fill(text) {
      const box = document.querySelector("textarea.input") || document.querySelector("textarea");
      if (!box) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      set.call(box, text); box.dispatchEvent(new Event("input", { bubbles: true })); box.focus();
      return true;
    },
  };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && current && currentCard && currentCard.toggles) { const id = current; close(); answer(id, "close"); } });
  (document.body || document.documentElement).append(host);
  if (!document.body) document.addEventListener("DOMContentLoaded", () => document.body.append(host), { once: true });
})();
