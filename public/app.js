const el = (tag, attrs = {}, children = []) => {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => c && e.appendChild(c));
  return e;
};
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
function money(n) { return "$" + (Math.round((n || 0) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pct(n) { return isFinite(n) ? Math.round(n) + "%" : "0%"; }

let session = { role: null };
let currentTab = "jobs";

async function boot() {
  session = await api("/api/session");
  render();
}

function render() {
  const app = document.getElementById("app");
  app.innerHTML = "";
  app.appendChild(el("div", { class: "header" }, [
    el("div", { class: "title oswald", text: "SBN Autostyling Tracker" }),
    el("div", { class: "subtitle", text: "Window tint · PPF · Ceramic coating — West Berlin, NJ" }),
  ]));

  if (!session.role) {
    app.appendChild(session.ownerPinSet ? renderLogin() : renderOwnerSetup());
    return;
  }

  app.appendChild(renderTabs());
  const content = el("div", { id: "content" });
  app.appendChild(content);
  if (session.role === "owner") renderOwnerTabContent(content);
  else if (session.role === "manager") renderManagerJobs(content);
  else renderEmployeeTabContent(content);
}

function renderOwnerSetup() {
  const pinInput = el("input", { type: "password", placeholder: "Choose a PIN (4+ digits)" });
  const notice = el("div", { class: "notice" });
  const card = el("div", { class: "card" }, [
    el("div", { class: "field" }, [el("label", { text: "First-time setup: create the owner PIN" }), pinInput]),
    el("button", { class: "primary", onclick: async () => {
      try { await api("/api/setup/owner-pin", { method: "POST", body: JSON.stringify({ pin: pinInput.value }) }); await boot(); }
      catch (e) { notice.className = "notice err"; notice.textContent = e.message; }
    }, text: "Set PIN & continue" }),
    notice,
  ]);
  return card;
}

function renderLogin() {
  const pinInput = el("input", { type: "password", placeholder: "Enter your PIN" });
  const notice = el("div", { class: "notice" });
  return el("div", { class: "card", style: "max-width:340px" }, [
    el("div", { class: "field" }, [el("label", { text: "Enter your PIN to continue" }), pinInput]),
    el("button", { class: "primary", onclick: async () => {
      try { session = await api("/api/login", { method: "POST", body: JSON.stringify({ pin: pinInput.value }) }); render(); }
      catch (e) { notice.className = "notice err"; notice.textContent = e.message; }
    }, text: "Log in" }),
    notice,
  ]);
}

function renderTabs() {
  let tabs;
  if (session.role === "owner") {
    tabs = [["owner-summary", "Dashboard"], ["owner-sales", "All jobs"], ["manager-jobs", "Job status"], ["owner-team", "Employees"], ["owner-managers", "Managers"], ["owner-test", "Test tool"]];
  } else if (session.role === "manager") {
    tabs = [["manager-jobs", "Job status"]];
  } else {
    tabs = [["jobs", "My jobs"], ["performance", "My performance"]];
  }
  const wrap = el("div", { class: "tabs" });
  tabs.forEach(([key, label]) => {
    wrap.appendChild(el("button", {
      class: "tab-btn" + (currentTab === key ? " active" : ""),
      onclick: () => { currentTab = key; render(); },
      text: label,
    }));
  });
  wrap.appendChild(el("button", { class: "tab-btn", style: "margin-left:auto", onclick: async () => { await api("/api/logout", { method: "POST" }); session = { role: null }; render(); }, text: "Log out" }));
  return wrap;
}

// ---------------- Employee views ----------------
async function renderEmployeeTabContent(content) {
  if (currentTab === "performance") return renderPerformance(content);
  return renderMyJobs(content);
}

async function renderMyJobs(content) {
  const jobs = await api("/api/my/jobs");
  content.appendChild(el("div", { class: "muted", style: "margin-bottom:10px", text: `Logged in as ${session.name}` }));
  if (jobs.length === 0) { content.appendChild(el("div", { class: "muted", text: "No jobs assigned to you yet." })); return; }
  jobs.sort((a, b) => (a.date < b.date ? 1 : -1)).forEach((job) => {
    const upsellForm = renderUpsellForm(job.id, () => renderMyJobs(clear(content)));
    const upsellList = el("div", {}, (job.upsells || []).map((u) =>
      el("span", { class: "pill", text: `${u.name} — ${money(u.price)}` })
    ));
    content.appendChild(el("div", { class: "card" }, [
      el("div", { class: "row" }, [
        el("div", {}, [
          el("div", { style: "font-weight:500", text: job.car }),
          el("div", { class: "muted", text: `${job.date ? job.date.slice(0, 10) : ""} · ${job.baseService || "Service not set"}` }),
        ]),
        el("div", { class: "mono", style: "color:var(--cyan)", text: money(job.upsellTotal) + " upsold" }),
      ]),
      upsellList,
      upsellForm,
    ]));
  });
}

function renderUpsellForm(jobId, onDone) {
  const nameInput = el("input", { placeholder: "Upsell (e.g. Headlight tint)" });
  const priceInput = el("input", { type: "number", placeholder: "Price", style: "max-width:100px" });
  const notice = el("div", { class: "notice" });
  return el("div", { style: "display:flex;gap:8px;margin-top:10px;align-items:center" }, [
    nameInput, priceInput,
    el("button", { class: "ghost", onclick: async () => {
      try {
        await api(`/api/sales/${jobId}/upsells`, { method: "POST", body: JSON.stringify({ name: nameInput.value, price: priceInput.value }) });
        onDone();
      } catch (e) { notice.className = "notice err"; notice.textContent = e.message; }
    }, text: "Add upsell" }),
    notice,
  ]);
}

async function renderPerformance(content) {
  const monthPicker = el("input", { type: "month", value: new Date().toISOString().slice(0, 7) });
  const body = el("div");
  async function load() {
    const stats = await api(`/api/my/performance?month=${monthPicker.value}`);
    body.innerHTML = "";
    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Your upsell revenue" }), el("div", { class: "metric-value mono", style: "color:var(--cyan)", text: money(stats.upsellRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Cars serviced" }), el("div", { class: "metric-value mono", text: stats.cars })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Attach rate" }), el("div", { class: "metric-value mono", text: pct(stats.attachRate) })]),
      stats.commissionRate > 0 ? el("div", { class: "metric" }, [el("div", { class: "metric-label", text: `Est. commission (${stats.commissionRate}%)` }), el("div", { class: "metric-value mono", style: "color:var(--green)", text: money(stats.commission) })]) : null,
    ]));
    if (stats.top && stats.top.length) {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:8px", text: "STRONG SUIT" }),
        ...stats.top.map((t) => el("div", { class: "row", style: "margin-bottom:4px" }, [el("span", { text: t.name }), el("span", { class: "mono muted", text: `${t.count}x · ${money(t.revenue)}` })])),
      ]));
    }
    if (stats.growthArea) {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:8px", text: "GROWTH AREA" }),
        el("div", { class: "row" }, [el("span", { text: stats.growthArea.name }), el("span", { class: "mono muted", text: `${stats.growthArea.count}x · ${money(stats.growthArea.revenue)}` })]),
      ]));
    }
  }
  content.appendChild(el("div", { class: "field", style: "max-width:200px" }, [el("label", { text: "Month" }), monthPicker]));
  monthPicker.addEventListener("change", load);
  content.appendChild(body);
  await load();
}

// ---------------- Owner views ----------------
async function renderOwnerTabContent(content) {
  if (currentTab === "owner-sales") return renderOwnerSales(content);
  if (currentTab === "owner-team") return renderOwnerTeam(content);
  if (currentTab === "owner-managers") return renderOwnerManagers(content);
  if (currentTab === "manager-jobs") return renderManagerJobs(content);
  if (currentTab === "owner-test") return renderTestTool(content);
  return renderOwnerSummary(content);
}

async function renderOwnerSummary(content) {
  const monthPicker = el("input", { type: "month", value: new Date().toISOString().slice(0, 7) });
  const body = el("div");
  async function load() {
    const s = await api(`/api/owner/summary?month=${monthPicker.value}`);
    body.innerHTML = "";
    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Total revenue" }), el("div", { class: "metric-value mono", style: "color:var(--amber)", text: money(s.totalRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Total upsell revenue" }), el("div", { class: "metric-value mono", style: "color:var(--cyan)", text: money(s.totalUpsellRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Upsell % of revenue" }), el("div", { class: "metric-value mono", text: pct(s.upsellPercentOfRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Shop attach rate" }), el("div", { class: "metric-value mono", text: pct(s.attachRate) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Cars serviced" }), el("div", { class: "metric-value mono", text: s.carCount })]),
    ]));
    const empTable = el("table", {}, [
      el("tr", {}, [el("th", { text: "Employee" }), el("th", { text: "Cars" }), el("th", { text: "Revenue" }), el("th", { text: "Upsell revenue" })]),
      ...s.perEmployee.map((e) => el("tr", {}, [el("td", { text: e.name }), el("td", { class: "mono", text: e.cars }), el("td", { class: "mono", text: money(e.revenue) }), el("td", { class: "mono", style: "color:var(--cyan)", text: money(e.upsellRevenue) })])),
    ]);
    body.appendChild(el("div", { class: "card" }, [el("div", { class: "muted", style: "margin-bottom:10px", text: "PER-EMPLOYEE BREAKDOWN" }), empTable]));

    const lbTable = el("table", {}, [
      el("tr", {}, [el("th", { text: "Upsell" }), el("th", { text: "Employee" }), el("th", { text: "Times sold" }), el("th", { text: "Revenue" })]),
      ...s.leaderboard.map((r) => el("tr", {}, [el("td", { text: r.upsell }), el("td", { class: "muted", text: r.employee }), el("td", { class: "mono", text: r.count }), el("td", { class: "mono", style: "color:var(--cyan)", text: money(r.revenue) })])),
    ]);
    body.appendChild(el("div", { class: "card" }, [el("div", { class: "muted", style: "margin-bottom:10px", text: "UPSELL LEADERBOARD BY EMPLOYEE" }), s.leaderboard.length ? lbTable : el("div", { class: "muted", text: "No upsells logged yet this month." })]));
  }
  content.appendChild(el("div", { class: "field", style: "max-width:200px" }, [el("label", { text: "Month" }), monthPicker]));
  monthPicker.addEventListener("change", load);
  content.appendChild(body);
  await load();
}

async function renderOwnerSales(content) {
  const monthPicker = el("input", { type: "month", value: new Date().toISOString().slice(0, 7) });
  const body = el("div");
  async function load() {
    const sales = await api(`/api/owner/sales?month=${monthPicker.value}`);
    body.innerHTML = "";
    if (sales.length === 0) { body.appendChild(el("div", { class: "muted", text: "No jobs this month." })); return; }
    sales.sort((a, b) => (a.date < b.date ? 1 : -1)).forEach((s) => {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500", text: `${s.car} ${s.syncedFromGHL ? "🔗" : ""}` }),
            el("div", { class: "muted", text: `${s.date ? s.date.slice(0, 10) : ""} · ${s.employeeName} · ${s.baseService || "no service set"}` }),
            (s.upsells || []).length ? el("div", { style: "margin-top:6px" }, s.upsells.map((u) => el("span", { class: "pill", text: `${u.name} — ${money(u.price)}` }))) : null,
          ]),
          el("div", { style: "text-align:right" }, [
            el("div", { class: "mono", style: "color:var(--amber);font-size:17px", text: money(s.total) }),
            el("button", { class: "icon-danger", onclick: async () => { await api(`/api/sales/${s.id}`, { method: "DELETE" }); load(); }, text: "Delete" }),
          ]),
        ]),
      ]));
    });
  }
  content.appendChild(el("div", { class: "field", style: "max-width:200px" }, [el("label", { text: "Month" }), monthPicker]));
  monthPicker.addEventListener("change", load);
  content.appendChild(body);
  await load();
}

async function renderOwnerTeam(content) {
  const nameInput = el("input", { placeholder: "Name" });
  const pinInput = el("input", { type: "text", placeholder: "PIN (4+ digits)", style: "max-width:140px" });
  const rateInput = el("input", { type: "number", placeholder: "Commission %", style: "max-width:130px" });
  const notice = el("div", { class: "notice" });
  const list = el("div");

  async function loadList() {
    const employees = await api("/api/employees");
    list.innerHTML = "";
    employees.forEach((e) => {
      const rate = el("input", { type: "number", value: e.commissionRate, style: "max-width:80px" });
      rate.addEventListener("change", () => api(`/api/employees/${e.id}`, { method: "PATCH", body: JSON.stringify({ commissionRate: rate.value }) }));
      list.appendChild(el("div", { class: "card row" }, [
        el("div", { style: "flex:1;font-weight:500", text: e.name }),
        rate,
        el("span", { class: "muted", text: "% commission" }),
        el("button", { class: "icon-danger", onclick: async () => { await api(`/api/employees/${e.id}`, { method: "DELETE" }); loadList(); }, text: "Remove" }),
      ]));
    });
  }

  content.appendChild(el("div", { class: "card" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "ADD EMPLOYEE — give them the PIN so they can log in" }),
    el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [nameInput, pinInput, rateInput,
      el("button", { class: "primary", onclick: async () => {
        try {
          await api("/api/employees", { method: "POST", body: JSON.stringify({ name: nameInput.value, pin: pinInput.value, commissionRate: rateInput.value }) });
          nameInput.value = ""; pinInput.value = ""; rateInput.value = "";
          notice.className = "notice ok"; notice.textContent = "Added.";
          loadList();
        } catch (e) { notice.className = "notice err"; notice.textContent = e.message; }
      }, text: "Add" }),
    ]),
    notice,
  ]));
  content.appendChild(list);
  await loadList();
}

function clear(node) { node.innerHTML = ""; return node; }

// ---------------- Manager job-status board (used by both manager and owner) ----------------
async function renderManagerJobs(content) {
  const monthPicker = el("input", { type: "month", value: new Date().toISOString().slice(0, 7) });
  const body = el("div");
  async function load() {
    const jobs = await api(`/api/manager/jobs?month=${monthPicker.value}`);
    body.innerHTML = "";
    if (jobs.length === 0) { body.appendChild(el("div", { class: "muted", text: "No jobs this month." })); return; }
    jobs.sort((a, b) => (a.date < b.date ? 1 : -1)).forEach((job) => {
      const mkToggle = (field, label) => {
        const active = job[field];
        return el("button", {
          class: "tab-btn" + (active ? " active" : ""),
          style: "border-color:" + (active ? "var(--green)" : "var(--border)") + ";color:" + (active ? "var(--green)" : "var(--sub)"),
          onclick: async () => {
            await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ [field]: !active }) });
            load();
          },
          text: (active ? "✓ " : "") + label,
        });
      };
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row", style: "margin-bottom:10px" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500", text: job.car }),
            el("div", { class: "muted", text: `${job.date ? job.date.slice(0, 10) : ""} · ${job.customerName || ""} · ${job.employeeName} · ${job.baseService || "no service set"}` }),
          ]),
          el("div", { class: "mono", style: "color:var(--amber)", text: money(job.total) }),
        ]),
        el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [
          mkToggle("arrived", "Arrived"),
          mkToggle("completed", "Service complete"),
          mkToggle("paid", "Paid"),
        ]),
      ]));
    });
  }
  content.appendChild(el("div", { class: "field", style: "max-width:200px" }, [el("label", { text: "Month" }), monthPicker]));
  monthPicker.addEventListener("change", load);
  content.appendChild(body);
  await load();
}

// ---------------- Owner: manage managers ----------------
async function renderOwnerManagers(content) {
  const nameInput = el("input", { placeholder: "Name" });
  const pinInput = el("input", { type: "text", placeholder: "PIN (4+ digits)", style: "max-width:140px" });
  const notice = el("div", { class: "notice" });
  const list = el("div");

  async function loadList() {
    const managers = await api("/api/managers");
    list.innerHTML = "";
    if (managers.length === 0) list.appendChild(el("div", { class: "muted", text: "No managers added yet." }));
    managers.forEach((m) => {
      list.appendChild(el("div", { class: "card row" }, [
        el("div", { style: "flex:1;font-weight:500", text: m.name }),
        el("button", { class: "icon-danger", onclick: async () => { await api(`/api/managers/${m.id}`, { method: "DELETE" }); loadList(); }, text: "Remove" }),
      ]));
    });
  }

  content.appendChild(el("div", { class: "card" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "ADD MANAGER — they get their own PIN and a Job Status dashboard only (no revenue, no commissions, no team management)" }),
    el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [nameInput, pinInput,
      el("button", { class: "primary", onclick: async () => {
        try {
          await api("/api/managers", { method: "POST", body: JSON.stringify({ name: nameInput.value, pin: pinInput.value }) });
          nameInput.value = ""; pinInput.value = "";
          notice.className = "notice ok"; notice.textContent = "Added.";
          loadList();
        } catch (e) { notice.className = "notice err"; notice.textContent = e.message; }
      }, text: "Add" }),
    ]),
    notice,
  ]));
  content.appendChild(list);
  await loadList();
}

// ---------------- Owner: built-in webhook test tool ----------------
async function renderTestTool(content) {
  const car = el("input", { placeholder: "Car (e.g. 2023 BMW M3)", value: "2023 BMW M3" });
  const customer = el("input", { placeholder: "Customer name", value: "Test Customer" });
  const employeeName = el("input", { placeholder: "Employee name (must match Employees tab exactly)", value: "" });
  const baseService = el("select", {}, [
    el("option", { value: "Window Tint", text: "Window Tint" }),
    el("option", { value: "PPF", text: "PPF" }),
    el("option", { value: "Ceramic Coating", text: "Ceramic Coating" }),
  ]);
  const basePrice = el("input", { type: "number", placeholder: "Base price", value: "899" });
  const notice = el("div", { class: "notice" });

  content.appendChild(el("div", { class: "card", style: "max-width:480px" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "SIMULATE A JOB COMING IN FROM GOHIGHLEVEL — use this to test the whole flow before wiring up the real GHL webhook" }),
    el("div", { class: "field" }, [el("label", { text: "Car" }), car]),
    el("div", { class: "field" }, [el("label", { text: "Customer" }), customer]),
    el("div", { class: "field" }, [el("label", { text: "Employee name" }), employeeName]),
    el("div", { class: "field" }, [el("label", { text: "Base service" }), baseService]),
    el("div", { class: "field" }, [el("label", { text: "Base price" }), basePrice]),
    el("button", { class: "primary", onclick: async () => {
      try {
        await api("/api/owner/simulate-webhook", { method: "POST", body: JSON.stringify({
          date: new Date().toISOString(), customerName: customer.value, car: car.value,
          employeeName: employeeName.value, baseService: baseService.value, basePrice: basePrice.value,
        }) });
        notice.className = "notice ok";
        notice.textContent = "Test job created — check the \"All jobs\" or \"Job status\" tab to see it.";
      } catch (e) { notice.className = "notice err"; notice.textContent = e.message; }
    }, text: "Create test job" }),
    notice,
  ]));
}

boot();
