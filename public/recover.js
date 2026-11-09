// ===== Removed people (owner only) =====
// Nobody is deleted for good. Removing someone puts them here with everything kept (PIN, pay settings, history). The owner can bring them back, and can also search the shop's
// cloud backups for someone who was removed before this existed.
async function renderRemovedPeople(content) {
  const host = el("div", { "data-part": "removed" });
  content.appendChild(host);
  let st = null, found = [], searched = false, more = false, nextSkip = 0, searchNote = "", busy = false;
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const big = (text, fn, kind, attrs) => el("button", { class: kind === "ghost" ? "ghost" : "primary", style: "width:100%;min-height:50px;font-size:15px;margin-top:8px;text-align:center", text, onclick: fn, ...(attrs || {}) });
  const card = (children, attrs) => el("div", { class: "card", style: "margin-bottom:12px", ...(attrs || {}) }, children);
  const chip = (text) => el("span", { class: "pill", style: "margin-left:6px;font-size:10px", text });
  async function load() { try { st = await api("/api/owner/removed-people"); } catch (e) { st = { removed: [], backup: { configured: false }, error: e.message }; } draw(); }

  // one row: the person, a Bring back button, and (only if there is a clash) a small form asking for a new PIN or new initials
  function row(p, source) {
    const fix = el("div", { style: "display:none;margin-top:8px" }), msg = el("div", { "data-part": "recover-msg", style: "font-size:12.5px;min-height:16px;margin-top:6px" });
    const pin = el("input", { inputmode: "numeric", placeholder: "New PIN, 4 to 12 digits", "data-part": "recover-pin", style: "width:100%;font-size:16px;margin-top:6px" }), ini = el("input", { placeholder: "New initials, or leave blank", "data-part": "recover-initials", style: "width:100%;font-size:16px;margin-top:6px" });
    const holder = el("div", { "data-person": p.id, style: "padding:12px 0;border-top:0.5px solid var(--border)" });
    let needPin = false, needIni = false;
    const go = async () => {
      const body = { source, id: p.id, type: p.type }; if (needPin) body.newPin = pin.value; if (needIni) body.initials = ini.value;
      if (source !== "removed") body.source = p.source;
      try {
        const r = await api("/api/owner/recover-person", { method: "POST", body: JSON.stringify(body) });
        holder.innerHTML = ""; holder.appendChild(el("div", { "data-part": "recover-done", style: "color:var(--green);font-weight:600", text: `${r.person.name} is back.` }));
        holder.appendChild(el("div", { class: "muted", style: "font-size:12.5px;margin-top:4px", text: `${r.pinChanged ? "Their new PIN works now. Tell them what it is." : "Their old PIN works again."} Their past jobs, attendance, tips and pay settings are linked to them again.${r.initialsChanged ? " Their initials were changed." : ""}` }));
        setTimeout(load, 2500);
      } catch (e) {
        const d = e.data || {}; if (d.needsNewPin) { needPin = true; fix.style.display = "block"; if (!fix.contains(pin)) fix.appendChild(pin); }
        if (d.needsInitials) { needIni = true; fix.style.display = "block"; if (!fix.contains(ini)) fix.appendChild(ini); }
        msg.textContent = e.message || "Couldn't bring them back."; msg.style.color = "var(--warn)";
      }
    };
    holder.appendChild(el("div", { class: "row", style: "gap:8px;align-items:center" }, [el("div", { style: "min-width:0" }, [el("div", { style: "font-weight:600;font-size:15px" }, [el("span", { text: p.name }), chip(p.role)]), el("div", { class: "muted", style: "font-size:12px", text: source === "removed" ? `Removed ${when(p.removedAt)}` : `Last seen in ${p.seenIn}` })]),
      el("button", { class: "primary", "data-act": "bring-back", style: "min-height:44px;padding:0 16px;white-space:nowrap", text: "Bring back", onclick: go })]));
    holder.appendChild(fix); holder.appendChild(msg); return holder;
  }
  async function search(first) {
    if (busy) return; busy = true; draw();
    try { const r = await api("/api/owner/removed-people/search-backups", { method: "POST", body: JSON.stringify({ skip: first ? 0 : nextSkip, count: 6 }) });
      if (first) found = []; searched = true; (r.found || []).forEach((f) => { if (!found.some((x) => x.id === f.id)) found.push(f); }); more = !!r.more; nextSkip = r.nextSkip || 0;
      const bad = (r.checked || []).filter((c) => !c.ok).length; searchNote = `Looked through ${nextSkip} of ${r.totalBackups} backup${r.totalBackups === 1 ? "" : "s"}${bad ? ` (${bad} couldn't be read)` : ""}.`; }
    catch (e) { searchNote = e.message || "Couldn't search the backups."; searched = true; }
    busy = false; draw();
  }
  function draw() {
    host.innerHTML = "";
    host.appendChild(el("div", { style: "font-size:18px;font-weight:600;margin:4px 0", text: "Removed people" }));
    host.appendChild(el("div", { class: "muted", style: "font-size:12.5px;margin-bottom:10px", text: "Nobody is deleted for good. Someone you remove is kept here with their PIN, pay settings and history, and you can bring them back." }));
    const removed = st ? st.removed : [];
    host.appendChild(card([el("div", { style: "font-weight:600;margin-bottom:2px", text: "REMOVED FROM THE APP" }), removed.length ? null : el("div", { class: "muted", "data-part": "removed-empty", style: "font-size:13px;padding:8px 0", text: "Nobody has been removed since this started keeping them. If someone was removed earlier, search the backups below." }), ...removed.map((p) => row(p, "removed"))], { "data-part": "removed-list" }));
    const b = st && st.backup;
    const box = card([el("div", { style: "font-weight:600;margin-bottom:2px", text: "REMOVED EARLIER? LOOK IN THE BACKUPS" }),
      el("div", { class: "muted", style: "font-size:12.5px;line-height:1.45", text: "Every hour the shop copies everything to a private backup, and keeps one copy for each day. This looks through those copies for anyone who is not in the app now." }),
      b && !b.configured ? el("div", { "data-part": "backup-off", style: "color:var(--warn);font-size:13px;margin-top:8px", text: "The cloud backup isn't turned on for this shop, so there is nothing to search. In Railway, add GITHUB_BACKUP_TOKEN and GITHUB_BACKUP_REPO under Variables." }) : null,
      b && b.configured && b.last ? el("div", { class: "muted", style: "font-size:11.5px;margin-top:6px", text: `Last backup: ${when(b.last.time)}${b.last.ok ? "" : " (it failed: " + (b.last.error || "") + ")"}` }) : null,
      b && b.configured ? big(busy ? "Searching..." : searched ? "Search again" : "Search the backups", () => search(true), "primary", { "data-act": "search-backups", ...(busy ? { disabled: "true" } : {}) }) : null]);
    if (searched) { box.appendChild(el("div", { class: "muted", "data-part": "search-note", style: "font-size:12px;margin-top:10px", text: searchNote }));
      if (!found.length) box.appendChild(el("div", { "data-part": "search-none", style: "font-size:13px;padding:8px 0", text: more ? "Nobody missing in these backups yet. Look further back." : "Nobody is missing from these backups." }));
      found.forEach((p) => box.appendChild(row(p, "backup")));
      if (more) box.appendChild(big("Look further back", () => search(false), "ghost", { "data-act": "search-more" })); }
    host.appendChild(box);
  }
  await load();
}
