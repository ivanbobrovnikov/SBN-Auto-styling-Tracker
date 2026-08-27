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
function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Reusable Day / Week / Month / Year selector. Calls onChange({period, date, month}) whenever it changes.
function nextOrTodayTuesday(fromDateStr) {
  const d = new Date(fromDateStr + "T00:00:00Z");
  const day = d.getUTCDay(); // 0=Sun ... 2=Tue
  const diff = (2 - day + 7) % 7;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function renderPeriodPicker(onChange, defaultPeriod = "month") {
  let period = defaultPeriod;
  const today = new Date().toISOString().slice(0, 10);
  const vis = (key) => (period === key ? "" : "display:none");
  const dayInput = el("input", { type: "date", value: today, style: vis("day") });
  const weekInput = el("input", { type: "date", value: today, style: vis("week") });
  const monthInput = el("input", { type: "month", value: today.slice(0, 7), style: vis("month") });
  const yearInput = el("input", { type: "number", value: String(new Date().getFullYear()), style: vis("year") + ";max-width:100px" });
  const payPeriodInput = el("input", { type: "date", value: nextOrTodayTuesday(today), style: vis("payperiod") });
  const payPeriodLabel = el("div", { class: "muted", style: `font-size:11.5px;${vis("payperiod")}` });

  function updatePayPeriodLabel() {
    const end = new Date(payPeriodInput.value + "T00:00:00Z");
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 13);
    const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    payPeriodLabel.textContent = `Covers ${fmt(start)} – ${fmt(end)}`;
  }

  function currentParams() {
    if (period === "day") return { period, date: dayInput.value };
    if (period === "week") return { period, date: weekInput.value };
    if (period === "year") return { period, date: `${yearInput.value}-01-01` };
    if (period === "payperiod") return { period, date: payPeriodInput.value };
    return { period: "month", month: monthInput.value };
  }
  function fire() { onChange(currentParams()); }

  const periodTabs = el("div", { style: "display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap" });
  [["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"], ["payperiod", "Pay period"]].forEach(([p, label]) => {
    const btn = el("button", {
      class: "tab-btn" + (p === period ? " active" : ""),
      text: label,
    });
    btn.addEventListener("click", () => {
      period = p;
      Array.from(periodTabs.children).forEach((c) => c.classList.remove("active"));
      dayInput.style.display = p === "day" ? "" : "none";
      weekInput.style.display = p === "week" ? "" : "none";
      monthInput.style.display = p === "month" ? "" : "none";
      yearInput.style.display = p === "year" ? "" : "none";
      payPeriodInput.style.display = p === "payperiod" ? "" : "none";
      payPeriodLabel.style.display = p === "payperiod" ? "" : "none";
      if (p === "payperiod") updatePayPeriodLabel();
      btn.classList.add("active");
      fire();
    });
    periodTabs.appendChild(btn);
  });

  [dayInput, weekInput, monthInput, yearInput].forEach((inp) => inp.addEventListener("change", fire));
  payPeriodInput.addEventListener("change", () => { updatePayPeriodLabel(); fire(); });
  if (period === "payperiod") updatePayPeriodLabel();

  const wrap = el("div", { class: "field", style: "max-width:320px" }, [
    el("label", { text: "Time period" }),
    periodTabs,
    dayInput, weekInput, monthInput, yearInput, payPeriodInput,
    payPeriodLabel,
  ]);
  return { el: wrap, getParams: currentParams };
}

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
  else if (session.role === "manager") renderManagerTabContent(content);
  else if (session.role === "sales") renderSalesTabContent(content);
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
    tabs = [["owner-summary", "Dashboard"], ["owner-payroll", "Payroll"], ["owner-sales", "All jobs"], ["manager-jobs", "Job status"], ["owner-attendance", "Attendance"], ["owner-search", "Search"], ["owner-team", "Employees"], ["owner-managers", "Managers"], ["owner-salesreps", "Sales Reps"], ["owner-test", "Test tool"]];
  } else if (session.role === "manager") {
    tabs = [["manager-jobs", "Job status"], ["owner-attendance", "Attendance"], ["owner-search", "Search"], ["manager-performance", "My performance"]];
  } else if (session.role === "sales") {
    tabs = [["sales-schedule", "My Bookings"], ["sales-fullschedule", "Full Schedule"], ["sales-performance", "My Performance"]];
  } else {
    tabs = [["schedule", "Schedule"], ["performance", "My performance"]];
  }
  const wrap = el("div", { class: "tabs" });
  tabs.forEach(([key, label]) => {
    wrap.appendChild(el("button", {
      class: "tab-btn" + (currentTab === key ? " active" : ""),
      onclick: () => { currentTab = key; render(); },
      text: label,
    }));
  });
  wrap.appendChild(el("button", { class: "tab-btn", style: "margin-left:auto", onclick: async () => { await api("/api/logout", { method: "POST" }); await boot(); }, text: "Log out" }));
  return wrap;
}

// ---------------- Employee views ----------------
async function renderEmployeeTabContent(content) {
  if (currentTab === "performance") return renderPerformance(content);
  return renderSchedule(content);
}

// Full schedule — every booked job, every employee sees the same list. Clicking any car
// lets you log an upsell on it, regardless of whether you're the one assigned to work it.
// Who worked the car (employeeNames) is a manager-entered record now, shown for context only.
// No base price or total sale $ shown here — that stays owner/manager-only.
async function renderSchedule(content) {
  const body = el("div");
  const nav = renderDayNav((params) => load(params));
  async function load(params) {
    const p = params || nav.getParams();
    const qs = new URLSearchParams(p).toString();
    const jobs = await api(`/api/my/jobs?${qs}`);
    body.innerHTML = "";
    if (jobs.length === 0) { body.appendChild(el("div", { class: "muted", text: "Nothing booked on this day." })); return; }
    jobs.sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((job) => {
      const upsellList = el("div", { style: "margin-bottom:6px" }, (job.upsells || []).map((u) =>
        el("span", { class: "pill", text: `${u.name} — ${money(u.price)} (${u.attributedToName})` })
      ));
      const upsellForm = renderUpsellForm(job.id, () => load());
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row", style: "margin-bottom:8px" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500", text: job.car }),
            el("div", { class: "muted", text: `${formatDateTime(job.date)} · ${job.baseService || "no service set"}` }),
            el("div", { class: "muted", text: `Worked by: ${job.employeeNames}` }),
          ]),
          el("div", { class: "muted", text: job.status === "arrived" ? "Arrived" : job.status === "no_show" ? "No-show" : "Upcoming" }),
        ]),
        el("div", { style: "border-top:0.5px solid var(--border);padding-top:8px" }, [upsellList, upsellForm]),
      ]));
    });
  }
  content.appendChild(nav.el);
  content.appendChild(body);
  await load();
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
  const body = el("div");
  const picker = renderPeriodPicker((params) => load(params), "month");
  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    const stats = await api(`/api/my/performance?${qs}`);
    body.innerHTML = "";
    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Your upsell revenue" }), el("div", { class: "metric-value mono", style: "color:var(--cyan)", text: money(stats.upsellRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Cars worked" }), el("div", { class: "metric-value mono", text: stats.cars })]),
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
  content.appendChild(picker.el);
  content.appendChild(body);
  await load();
}

// ---------------- Owner views ----------------
async function renderManagerTabContent(content) {
  if (currentTab === "owner-search") return renderSearch(content);
  if (currentTab === "owner-attendance") return renderAttendance(content);
  if (currentTab === "manager-performance") return renderManagerPerformance(content);
  return renderManagerJobs(content);
}

async function renderSalesTabContent(content) {
  if (currentTab === "sales-performance") return renderSalesPerformance(content);
  if (currentTab === "sales-fullschedule") return renderSalesFullSchedule(content);
  return renderSalesSchedule(content);
}

async function renderOwnerTabContent(content) {
  if (currentTab === "owner-sales") return renderOwnerSales(content);
  if (currentTab === "owner-payroll") return renderOwnerPayroll(content);
  if (currentTab === "owner-team") return renderOwnerTeam(content);
  if (currentTab === "owner-managers") return renderOwnerManagers(content);
  if (currentTab === "owner-salesreps") return renderOwnerSalesReps(content);
  if (currentTab === "owner-attendance") return renderAttendance(content);
  if (currentTab === "manager-jobs") return renderManagerJobs(content);
  if (currentTab === "owner-search") return renderSearch(content);
  if (currentTab === "owner-test") return renderTestTool(content);
  return renderOwnerSummary(content);
}

// Payroll — every person's own upsells grouped together, their commission owed, and the
// shop-wide combined total for comparison. This is the page built specifically for running pay.
async function renderOwnerPayroll(content) {
  const body = el("div");
  const picker = renderPeriodPicker((params) => load(params), "payperiod");

  function personCard(p, subtitle) {
    const upsellRows = p.upsells.length
      ? p.upsells.map((u) => el("div", { class: "row", style: "margin-bottom:3px" }, [
          el("span", { style: "font-size:13px", text: u.name }),
          el("span", { class: "mono muted", style: "font-size:13px", text: `${u.count}x · ${money(u.revenue)}` }),
        ]))
      : [el("div", { class: "muted", style: "font-size:12.5px", text: "No upsells logged in this period." })];

    return el("div", { class: "card" }, [
      el("div", { class: "row", style: "margin-bottom:2px" }, [
        el("div", { class: "oswald", style: "font-size:15px", text: p.name }),
        el("div", { class: "mono", style: "color:var(--cyan);font-size:16px", text: money(p.upsellRevenue) }),
      ]),
      el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:10px", text: subtitle }),
      el("div", { style: "border-top:0.5px solid var(--border);padding-top:8px;margin-bottom:8px" }, upsellRows),
      p.commissionRate > 0
        ? el("div", { class: "row", style: "border-top:0.5px solid var(--border);padding-top:8px" }, [
            el("span", { class: "muted", style: "font-size:12.5px", text: `Commission owed (${p.commissionRate}% of upsells)` }),
            el("span", { class: "mono", style: "color:var(--green);font-weight:600", text: money(p.commission) }),
          ])
        : el("div", { class: "muted", style: "font-size:11.5px;border-top:0.5px solid var(--border);padding-top:8px", text: "No commission rate set for this person." }),
    ]);
  }

  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    const d = await api(`/api/owner/payroll?${qs}`);
    body.innerHTML = "";

    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Combined upsell revenue — everyone" }), el("div", { class: "metric-value mono", style: "color:var(--cyan)", text: money(d.shopTotalUpsellRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Total commission owed" }), el("div", { class: "metric-value mono", style: "color:var(--green)", text: money(d.employees.reduce((a, e) => a + e.commission, 0) + d.managers.reduce((a, m) => a + m.commission, 0) + (d.salesReps || []).reduce((a, r) => a + r.commission, 0)) })]),
    ]));

    body.appendChild(el("div", { class: "muted", style: "margin:16px 0 8px;font-size:11.5px;letter-spacing:0.04em", text: "EMPLOYEES — EACH PERSON'S OWN UPSELLS" }));
    if (d.employees.length === 0) body.appendChild(el("div", { class: "muted", text: "No employees added yet." }));
    d.employees.forEach((e) => body.appendChild(personCard(e, `${e.carsWorked} car${e.carsWorked !== 1 ? "s" : ""} worked · ${e.upsellCount} upsell${e.upsellCount !== 1 ? "s" : ""} sold`)));

    if (d.managers.length > 0) {
      body.appendChild(el("div", { class: "muted", style: "margin:16px 0 8px;font-size:11.5px;letter-spacing:0.04em", text: "MANAGERS — EACH PERSON'S OWN UPSELLS" }));
      d.managers.forEach((m) => body.appendChild(personCard(m, `${m.upsellCount} upsell${m.upsellCount !== 1 ? "s" : ""} sold`)));
    }

    if (d.salesReps && d.salesReps.length > 0) {
      body.appendChild(el("div", { class: "muted", style: "margin:16px 0 8px;font-size:11.5px;letter-spacing:0.04em", text: "SALES REPS — COMMISSION ON SHOWED SALES" }));
      d.salesReps.forEach((r) => {
        body.appendChild(el("div", { class: "card" }, [
          el("div", { class: "row", style: "margin-bottom:2px" }, [
            el("div", { class: "oswald", style: "font-size:15px", text: r.name }),
            el("div", { class: "mono", style: "color:var(--amber);font-size:16px", text: money(r.showedValue) }),
          ]),
          el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:10px", text: `${r.totalBooked} booked · ${r.showedCount} showed (no-shows earn nothing)` }),
          r.commissionRate > 0
            ? el("div", { class: "row", style: "border-top:0.5px solid var(--border);padding-top:8px" }, [
                el("span", { class: "muted", style: "font-size:12.5px", text: `Commission owed (${r.commissionRate}% of showed value)` }),
                el("span", { class: "mono", style: "color:var(--green);font-weight:600", text: money(r.commission) }),
              ])
            : el("div", { class: "muted", style: "font-size:11.5px;border-top:0.5px solid var(--border);padding-top:8px", text: "No commission rate set for this person." }),
        ]));
      });
    }
  }
  content.appendChild(picker.el);
  content.appendChild(body);
  await load();
}

function openPrintableReport(title, s, periodLabel) {
  const win = window.open("", "_blank");
  const rowsEmp = s.perEmployee.map((e) => `<tr><td>${e.name}</td><td>${e.cars}</td><td>${money(e.upsellRevenue)}</td></tr>`).join("");
  const rowsMgr = (s.perManager || []).map((m) => `<tr><td>${m.name}</td><td>${money(m.upsellRevenue)}</td></tr>`).join("");
  const rowsLb = s.leaderboard.map((r) => `<tr><td>${r.upsell}</td><td>${r.employee}</td><td>${r.count}</td><td>${money(r.revenue)}</td></tr>`).join("");
  win.document.write(`
    <html><head><title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; color: #111; padding: 30px; }
      h1 { font-size: 20px; margin-bottom: 2px; }
      .sub { color: #666; font-size: 13px; margin-bottom: 20px; }
      .metrics { display: flex; gap: 24px; margin-bottom: 24px; flex-wrap: wrap; }
      .metric { border: 1px solid #ddd; border-radius: 6px; padding: 10px 16px; }
      .metric-label { font-size: 11px; color: #666; text-transform: uppercase; }
      .metric-value { font-size: 20px; font-weight: 600; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; }
      th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; }
      th { color: #666; font-weight: 600; }
      h2 { font-size: 14px; margin: 20px 0 8px; }
    </style></head>
    <body>
      <h1>SBN Autostyling Tracker — ${title}</h1>
      <div class="sub">${periodLabel}</div>
      <div class="metrics">
        <div class="metric"><div class="metric-label">Total revenue</div><div class="metric-value">${money(s.totalRevenue)}</div></div>
        <div class="metric"><div class="metric-label">Total upsell revenue</div><div class="metric-value">${money(s.totalUpsellRevenue)}</div></div>
        <div class="metric"><div class="metric-label">Upsell % of revenue</div><div class="metric-value">${pct(s.upsellPercentOfRevenue)}</div></div>
        <div class="metric"><div class="metric-label">Cars serviced</div><div class="metric-value">${s.carCount}</div></div>
      </div>
      <h2>Per-employee breakdown</h2>
      <table><tr><th>Employee</th><th>Cars worked</th><th>Upsell revenue</th></tr>${rowsEmp}</table>
      ${rowsMgr ? `<h2>Manager upsells</h2><table><tr><th>Manager</th><th>Upsell revenue</th></tr>${rowsMgr}</table>` : ""}
      <h2>Upsell leaderboard</h2>
      <table><tr><th>Upsell</th><th>Employee</th><th>Times sold</th><th>Revenue</th></tr>${rowsLb}</table>
    </body></html>
  `);
  win.document.close();
  setTimeout(() => win.print(), 300);
}

  const cloudStatus = el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:16px" });
  const cloudStatusText = el("span", {});
  async function loadCloudStatus() {
    try {
      const s = await api("/api/owner/backup-status");
      if (!s.configured) {
        cloudStatusText.textContent = "☁ Automatic cloud backup: not set up yet.";
        cloudStatusText.style.color = "var(--sub)";
      } else if (s.last && s.last.ok) {
        cloudStatusText.textContent = `☁ Automatic cloud backup: last succeeded ${formatDateTime(s.last.time)}`;
        cloudStatusText.style.color = "var(--green)";
      } else if (s.last) {
        cloudStatusText.textContent = `☁ Automatic cloud backup: last attempt failed — ${s.last.error}`;
        cloudStatusText.style.color = "var(--red)";
      } else {
        cloudStatusText.textContent = "☁ Automatic cloud backup: configured, waiting for first run.";
        cloudStatusText.style.color = "var(--sub)";
      }
    } catch (e) {}
  }
  const backupNowBtn = el("button", { class: "ghost", style: "margin-left:8px", text: "Test now", onclick: async () => {
    backupNowBtn.textContent = "Testing...";
    await api("/api/owner/backup-now", { method: "POST" });
    await loadCloudStatus();
    backupNowBtn.textContent = "Test now";
  } });
  cloudStatus.appendChild(cloudStatusText);
  cloudStatus.appendChild(backupNowBtn);

  async function renderOwnerSummary(content) {
  const body = el("div");
  const picker = renderPeriodPicker((params) => load(params), "month");
  let lastSummary = null, lastQs = "";
  const actions = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px" }, [
    el("button", { class: "ghost", text: "Print report", onclick: () => { if (lastSummary) openPrintableReport("Dashboard report", lastSummary, lastQs); } }),
    el("a", { href: "#", class: "ghost", style: "text-decoration:none;display:inline-block", text: "Export CSV", onclick: (e) => { e.preventDefault(); window.location.href = `/api/owner/export/csv?${lastQs}`; } }),
    el("a", { href: "/api/owner/backup", class: "ghost", style: "text-decoration:none;display:inline-block", text: "Download full backup" }),
  ]);
  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    lastQs = qs;
    const s = await api(`/api/owner/summary?${qs}`);
    lastSummary = s;
    body.innerHTML = "";
    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Total revenue" }), el("div", { class: "metric-value mono", style: "color:var(--amber)", text: money(s.totalRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Total upsell revenue" }), el("div", { class: "metric-value mono", style: "color:var(--cyan)", text: money(s.totalUpsellRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Upsell % of revenue" }), el("div", { class: "metric-value mono", text: pct(s.upsellPercentOfRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Shop attach rate" }), el("div", { class: "metric-value mono", text: pct(s.attachRate) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Cars serviced" }), el("div", { class: "metric-value mono", text: s.carCount })]),
    ]));
    const empTable = el("table", {}, [
      el("tr", {}, [el("th", { text: "Employee" }), el("th", { text: "Cars worked" }), el("th", { text: "Their upsell revenue" })]),
      ...s.perEmployee.map((e) => el("tr", {}, [el("td", { text: e.name }), el("td", { class: "mono", text: e.cars }), el("td", { class: "mono", style: "color:var(--cyan)", text: money(e.upsellRevenue) })])),
    ]);
    body.appendChild(el("div", { class: "card" }, [
      el("div", { class: "muted", style: "margin-bottom:10px", text: "PER-EMPLOYEE BREAKDOWN" }),
      el("div", { class: "muted", style: "margin-bottom:10px;font-size:11.5px", text: "Cars worked counts every job a tech was part of, including tag-teamed ones. Upsell revenue only counts what that person personally logged." }),
      empTable,
    ]));

    if (s.perManager && s.perManager.length > 0) {
      const mgrTable = el("table", {}, [
        el("tr", {}, [el("th", { text: "Manager" }), el("th", { text: "Their upsell revenue" })]),
        ...s.perManager.map((m) => el("tr", {}, [el("td", { text: m.name }), el("td", { class: "mono", style: "color:var(--cyan)", text: money(m.upsellRevenue) })])),
      ]);
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:10px", text: "MANAGER UPSELLS" }),
        mgrTable,
      ]));
    }

    if (s.perSalesRep && s.perSalesRep.length > 0) {
      const repTable = el("table", {}, [
        el("tr", {}, [el("th", { text: "Sales rep" }), el("th", { text: "Booked" }), el("th", { text: "Showed" }), el("th", { text: "Showed value" }), el("th", { text: "Commission" })]),
        ...s.perSalesRep.map((r) => el("tr", {}, [
          el("td", { text: r.name }), el("td", { class: "mono", text: r.totalBooked }), el("td", { class: "mono", style: "color:var(--green)", text: r.showedCount }),
          el("td", { class: "mono", style: "color:var(--amber)", text: money(r.showedValue) }), el("td", { class: "mono", style: "color:var(--green)", text: money(r.commission) }),
        ])),
      ]);
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:10px", text: "SALES REP PERFORMANCE" }),
        el("div", { class: "muted", style: "margin-bottom:10px;font-size:11.5px", text: "Commission is on the base sale, only counted once a manager marks it arrived — no-shows earn nothing." }),
        repTable,
      ]));
    }

    const lbTable = el("table", {}, [
      el("tr", {}, [el("th", { text: "Upsell" }), el("th", { text: "Employee" }), el("th", { text: "Times sold" }), el("th", { text: "Revenue" })]),
      ...s.leaderboard.map((r) => el("tr", {}, [el("td", { text: r.upsell }), el("td", { class: "muted", text: r.employee }), el("td", { class: "mono", text: r.count }), el("td", { class: "mono", style: "color:var(--cyan)", text: money(r.revenue) })])),
    ]);
    body.appendChild(el("div", { class: "card" }, [el("div", { class: "muted", style: "margin-bottom:10px", text: "UPSELL LEADERBOARD BY EMPLOYEE" }), s.leaderboard.length ? lbTable : el("div", { class: "muted", text: "No upsells logged yet in this period." })]));
  }
  content.appendChild(picker.el);
  content.appendChild(actions);
  content.appendChild(cloudStatus);
  content.appendChild(body);
  await load();
  await loadCloudStatus();
}

function sameLocalDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}
function jobStatusColors(s) {
  if (s.status === "cancelled") return { bg: "var(--borderSoft)", border: "var(--muted)", text: "var(--muted)" };
  if (s.status === "arrived") return { bg: "#173404", border: "var(--green)", text: "var(--green)" };
  if (s.status === "no_show") return { bg: "#501313", border: "var(--red)", text: "var(--red)" };
  return { bg: "var(--cyanDim)", border: "var(--cyan)", text: "var(--cyan)" };
}

// Week view — a real time-of-day grid, same visual language across all three calendar levels.
function renderWeekGrid(sales) {
  const startHour = 7, endHour = 19;
  const first = sales.length ? new Date(sales[0].date) : new Date();
  const day = first.getDay();
  const monday = new Date(first); monday.setDate(first.getDate() - ((day + 6) % 7)); monday.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
  const today = new Date();
  const gridHeight = (endHour - startHour) * 44;

  const header = el("div", { style: "display:grid;grid-template-columns:44px repeat(7,1fr);gap:0;font-size:11px;margin-bottom:2px" }, [
    el("div", {}),
    ...days.map((d) => el("div", {
      style: `text-align:center;padding:6px 2px;${sameLocalDay(d, today) ? "background:var(--cardAlt);border-radius:6px 6px 0 0;color:var(--amber);font-weight:500" : "color:var(--sub)"}`,
      text: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }),
    })),
  ]);

  const axis = el("div", { style: `display:grid;grid-template-rows:repeat(${(endHour - startHour) / 2},88px)` });
  for (let h = startHour; h < endHour; h += 2) {
    axis.appendChild(el("div", { class: "muted", style: "font-size:10px;padding-top:2px", text: h === 12 ? "12pm" : h > 12 ? `${h - 12}pm` : `${h}am` }));
  }

  const grid = el("div", { style: `display:grid;grid-template-columns:44px repeat(7,minmax(90px,1fr));gap:0;border-top:0.5px solid var(--border)` }, [axis]);
  days.forEach((d) => {
    const col = el("div", { style: `position:relative;height:${gridHeight}px;border-left:0.5px solid var(--borderSoft)` });
    sales.filter((s) => sameLocalDay(new Date(s.date), d)).forEach((s) => {
      const jd = new Date(s.date);
      const hourFrac = Math.max(startHour, Math.min(endHour, jd.getHours() + jd.getMinutes() / 60));
      const top = ((hourFrac - startHour) / (endHour - startHour)) * gridHeight;
      const c = jobStatusColors(s);
      const timeLabel = jd.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      col.appendChild(el("div", {
        style: `position:absolute;top:${top}px;left:2px;right:2px;background:${c.bg};border-left:3px solid ${c.border};border-radius:4px;padding:3px 5px;font-size:10px;cursor:default`,
        text: s.car,
      }, [el("div", { style: `color:${c.text};font-size:9.5px`, text: timeLabel })]));
    });
    grid.appendChild(col);
  });

  return el("div", { style: "background:var(--panel);border-radius:12px;padding:14px;overflow-x:auto" }, [header, grid]);
}

// Month view — a day-grid (30 tiny time-grids would be unreadable), using the same colored
// chip language as the week view for visual consistency.
function renderMonthGrid(sales, monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  const firstOfMonth = new Date(y, m - 1, 1);
  const startOffset = firstOfMonth.getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(y, m - 1, d));
  const today = new Date();

  const header = el("div", { style: "display:grid;grid-template-columns:repeat(7,1fr);gap:1px;font-size:11px;margin-bottom:4px" },
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => el("div", { class: "muted", style: "text-align:center;padding:4px", text: d })));

  const grid = el("div", { style: "display:grid;grid-template-columns:repeat(7,1fr);grid-auto-rows:76px;gap:1px;background:var(--borderSoft)" });
  cells.forEach((d) => {
    if (!d) { grid.appendChild(el("div", { style: "background:var(--panel)" })); return; }
    const dayJobs = sales.filter((s) => sameLocalDay(new Date(s.date), d));
    const isToday = sameLocalDay(d, today);
    const cell = el("div", { style: `background:${isToday ? "var(--cardAlt)" : "var(--panel)"};padding:4px;${isToday ? "border:1px solid var(--amber)" : ""}` }, [
      el("div", { style: `font-size:10px;${isToday ? "color:var(--amber);font-weight:500" : "color:var(--sub)"}`, text: d.getDate() }),
    ]);
    dayJobs.slice(0, 2).forEach((s) => {
      const c = jobStatusColors(s);
      const jd = new Date(s.date);
      const timeLabel = jd.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      cell.appendChild(el("div", { style: `background:${c.bg};border-radius:3px;padding:1px 4px;font-size:9.5px;color:${c.text};margin-top:2px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis`, text: `${s.car} ${timeLabel}` }));
    });
    if (dayJobs.length > 2) cell.appendChild(el("div", { class: "muted", style: "font-size:9px;margin-top:1px", text: `+${dayJobs.length - 2} more` }));
    grid.appendChild(cell);
  });

  return el("div", { style: "background:var(--panel);border-radius:12px;padding:14px;overflow-x:auto" }, [header, grid]);
}

// Year view — a density heatmap, the only readable way to show 365 days at once. Same
// amber-intensity language as the mockup: darker means more jobs that day.
function renderYearGrid(sales, yearStr) {
  const year = parseInt(yearStr, 10);
  const countsByDay = {};
  sales.forEach((s) => {
    const d = new Date(s.date);
    if (d.getFullYear() !== year) return;
    const key = `${d.getMonth()}-${d.getDate()}`;
    countsByDay[key] = (countsByDay[key] || 0) + 1;
  });
  const maxCount = Math.max(1, ...Object.values(countsByDay));
  const shades = ["var(--borderSoft)", "#4A3A22", "#854F0B", "#412402"];
  function shadeFor(count) {
    if (!count) return shades[0];
    const ratio = count / maxCount;
    if (ratio > 0.66) return shades[3];
    if (ratio > 0.33) return shades[2];
    return shades[1];
  }
  const months = el("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px" });
  for (let m = 0; m < 12; m++) {
    const daysInMonth = new Date(year, m + 1, 0).getDate();
    const monthLabel = new Date(year, m, 1).toLocaleDateString(undefined, { month: "short" });
    const dayGrid = el("div", { style: "display:grid;grid-template-columns:repeat(7,1fr);gap:2px" });
    for (let d = 1; d <= daysInMonth; d++) {
      const count = countsByDay[`${m}-${d}`] || 0;
      dayGrid.appendChild(el("div", { style: `aspect-ratio:1;background:${shadeFor(count)};border-radius:2px` }));
    }
    months.appendChild(el("div", {}, [el("div", { style: "font-size:11.5px;color:var(--amber);margin-bottom:4px", text: monthLabel }), dayGrid]));
  }
  const legend = el("div", { style: "display:flex;align-items:center;gap:6px;font-size:10px;margin-top:14px", class: "muted" }, [
    el("span", { text: "Fewer jobs" }),
    ...shades.map((s) => el("div", { style: `width:12px;height:12px;background:${s};border-radius:2px` })),
    el("span", { text: "More jobs" }),
  ]);
  return el("div", { style: "background:var(--panel);border-radius:12px;padding:14px" }, [months, legend]);
}

async function renderOwnerSales(content) {
  const body = el("div");
  const picker = renderPeriodPicker((params) => load(params), "day");
  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    const sales = await api(`/api/owner/sales?${qs}`);
    body.innerHTML = "";
    if (sales.length === 0) { body.appendChild(el("div", { class: "muted", text: "No jobs in this period." })); return; }

    if (p.period === "week") { body.appendChild(renderWeekGrid(sales)); return; }
    if (p.period === "month") { body.appendChild(renderMonthGrid(sales, p.month)); return; }
    if (p.period === "year") { body.appendChild(renderYearGrid(sales, p.date.slice(0, 4))); return; }

    sales.sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((s) => {
      const cancelled = s.status === "cancelled";
      const statusLabel = cancelled ? "Cancelled" : s.status === "arrived" ? "Arrived" : s.status === "no_show" ? "No-show" : "Upcoming";
      const statusColor = cancelled ? "var(--red)" : s.status === "arrived" ? "var(--green)" : s.status === "no_show" ? "var(--red)" : "var(--sub)";
      const d = new Date(s.date);
      const timeOnly = isNaN(d.getTime()) ? "—" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      const dateOnly = isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

      body.appendChild(el("div", { class: "card", style: `display:flex;gap:12px;align-items:flex-start;${cancelled ? "opacity:0.55" : ""}` }, [
        el("div", { style: "min-width:64px;text-align:center;background:var(--cardAlt);border-radius:7px;padding:8px 4px;flex-shrink:0" }, [
          el("div", { class: "mono", style: "font-size:14px;font-weight:600", text: timeOnly }),
          el("div", { class: "muted", style: "font-size:10px", text: dateOnly }),
        ]),
        el("div", { style: "flex:1;min-width:0" }, [
          el("div", { style: "font-weight:500", text: `${s.car}${s.syncedFromGHL ? " 🔗" : ""}` }),
          el("div", { class: "muted", style: "font-size:12.5px", text: `${s.employeeNames || "Unassigned"} · ${s.baseService || "no service set"}` }),
          (s.upsells || []).length ? el("div", { style: "margin-top:6px" }, s.upsells.map((u) => el("span", { class: "pill", text: `${u.name} — ${money(u.price)} (${u.attributedToName})` }))) : null,
        ]),
        el("div", { style: "text-align:right;flex-shrink:0" }, [
          el("div", { style: `color:${statusColor};font-size:12px;font-weight:600;margin-bottom:2px`, text: statusLabel }),
          el("div", { class: "mono", style: `color:${cancelled ? "var(--red)" : "var(--amber)"};font-size:16px`, text: cancelled ? "—" : money(s.total) }),
          s.paid ? el("div", { class: "muted", style: "font-size:11px", text: `Paid — ${s.paymentMethod === "cash" ? "Cash" : "Card"}` }) : el("div", { class: "muted", style: "font-size:11px", text: cancelled ? "" : "Unpaid" }),
          el("div", { style: "display:flex;gap:6px;margin-top:6px;justify-content:flex-end" }, [
            el("button", { class: "ghost", style: "font-size:10px;padding:3px 7px", onclick: () => navigator.clipboard.writeText(s.id), text: "Copy ID" }),
            el("button", { class: "icon-danger", onclick: async () => { await api(`/api/sales/${s.id}`, { method: "DELETE" }); load(); }, text: "Delete" }),
          ]),
        ]),
      ]));
    });
  }
  content.appendChild(picker.el);
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
      const newPinInput = el("input", { type: "text", placeholder: "New PIN", style: "max-width:100px" });
      const resetNotice = el("span", { class: "muted", style: "font-size:11px" });
      list.appendChild(el("div", { class: "card row" }, [
        el("div", { style: "flex:1;font-weight:500", text: e.name }),
        rate,
        el("span", { class: "muted", text: "% commission" }),
        newPinInput,
        el("button", { class: "ghost", onclick: async () => {
          if (!newPinInput.value.trim()) return;
          await api(`/api/employees/${e.id}`, { method: "PATCH", body: JSON.stringify({ pin: newPinInput.value.trim() }) });
          newPinInput.value = ""; resetNotice.textContent = "PIN reset ✓"; resetNotice.style.color = "var(--green)";
          setTimeout(() => { resetNotice.textContent = ""; }, 2500);
        }, text: "Reset PIN" }),
        resetNotice,
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

// ---------------- Sales rep: read-only bookings, no way to touch status ----------------
async function renderSalesSchedule(content) {
  const body = el("div");
  const nav = renderDayNav((params) => load(params));
  async function load(params) {
    const p = params || nav.getParams();
    const qs = new URLSearchParams(p).toString();
    const jobs = await api(`/api/my/sales-schedule?${qs}`);
    body.innerHTML = "";
    if (jobs.length === 0) { body.appendChild(el("div", { class: "muted", text: "No bookings on this day." })); return; }
    jobs.sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((job) => {
      const statusLabel = job.status === "arrived" ? "Showed" : job.status === "no_show" ? "No-show" : "Upcoming";
      const statusColor = job.status === "arrived" ? "var(--green)" : job.status === "no_show" ? "var(--red)" : "var(--sub)";
      body.appendChild(el("div", { class: "card row" }, [
        el("div", {}, [
          el("div", { style: "font-weight:500", text: job.car }),
          el("div", { class: "muted", text: `${formatDateTime(job.date)} · ${job.customerName || ""} · ${job.baseService || ""}` }),
        ]),
        el("div", { style: "text-align:right" }, [
          el("div", { class: "mono", style: "color:var(--amber)", text: money(job.basePrice) }),
          el("div", { style: `color:${statusColor};font-size:12px;font-weight:600`, text: statusLabel }),
        ]),
      ]));
    });
  }
  content.appendChild(el("div", { class: "muted", style: "margin-bottom:10px", text: "Status here is set by your manager — this is a read-only view of what you booked and whether it showed." }));
  content.appendChild(nav.el);
  content.appendChild(body);
  await load();
}

// Full shop schedule for sales reps — every job, not just their own bookings. No price
// shown (same privacy rule as employees), but arrival/completion status is visible.
async function renderSalesFullSchedule(content) {
  const body = el("div");
  const nav = renderDayNav((params) => load(params));
  async function load(params) {
    const p = params || nav.getParams();
    const qs = new URLSearchParams(p).toString();
    const jobs = await api(`/api/sales/full-schedule?${qs}`);
    body.innerHTML = "";
    if (jobs.length === 0) { body.appendChild(el("div", { class: "muted", text: "Nothing booked on this day." })); return; }
    jobs.sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((job) => {
      const statusLabel = job.status === "arrived" ? "Arrived" : job.status === "no_show" ? "No-show" : "Upcoming";
      const statusColor = job.status === "arrived" ? "var(--green)" : job.status === "no_show" ? "var(--red)" : "var(--sub)";
      body.appendChild(el("div", { class: "card row" }, [
        el("div", {}, [
          el("div", { style: "font-weight:500", text: job.car }),
          el("div", { class: "muted", text: `${formatDateTime(job.date)} · ${job.baseService || ""} · ${job.employeeNames}` }),
        ]),
        el("div", { style: "text-align:right" }, [
          el("div", { style: `color:${statusColor};font-size:12px;font-weight:600`, text: statusLabel }),
          job.completed ? el("div", { class: "muted", style: "font-size:11px", text: "Service complete" }) : null,
        ]),
      ]));
    });
  }
  content.appendChild(el("div", { class: "muted", style: "margin-bottom:10px", text: "Every car on the schedule, not just yours. Status is set by your manager." }));
  content.appendChild(nav.el);
  content.appendChild(body);
  await load();
}

async function renderSalesPerformance(content) {
  const body = el("div");
  const picker = renderPeriodPicker((params) => load(params), "payperiod");
  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    const stats = await api(`/api/my/sales-performance?${qs}`);
    body.innerHTML = "";
    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Total booked" }), el("div", { class: "metric-value mono", text: stats.totalBooked })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Booked value" }), el("div", { class: "metric-value mono", style: "color:var(--amber)", text: money(stats.totalBookedValue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Showed" }), el("div", { class: "metric-value mono", style: "color:var(--green)", text: stats.showedCount })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "No-shows" }), el("div", { class: "metric-value mono", style: "color:var(--red)", text: stats.noShowCount })]),
    ]));
    body.appendChild(el("div", { class: "card" }, [
      el("div", { class: "row", style: "margin-bottom:4px" }, [
        el("span", { class: "muted", text: "Value that showed (this is what your commission is based on)" }),
        el("span", { class: "mono", style: "color:var(--cyan)", text: money(stats.showedValue) }),
      ]),
      el("div", { class: "row", style: "margin-top:6px;font-size:12.5px" }, [
        el("span", { class: "muted", text: `During hours (${stats.commissionRate}%): ${stats.duringHoursCount} sale${stats.duringHoursCount !== 1 ? "s" : ""}` }),
        el("span", { class: "mono muted", text: money(stats.duringHoursValue) }),
      ]),
      el("div", { class: "row", style: "font-size:12.5px" }, [
        el("span", { class: "muted", text: `After hours (${stats.afterHoursCommissionRate}%): ${stats.afterHoursCount} sale${stats.afterHoursCount !== 1 ? "s" : ""}` }),
        el("span", { class: "mono muted", text: money(stats.afterHoursValue) }),
      ]),
      (stats.commissionRate > 0 || stats.afterHoursCommissionRate > 0)
        ? el("div", { class: "row", style: "border-top:0.5px solid var(--border);padding-top:8px;margin-top:8px" }, [
            el("span", { class: "muted", text: "Your total commission" }),
            el("span", { class: "mono", style: "color:var(--green);font-weight:600;font-size:18px", text: money(stats.commission) }),
          ])
        : el("div", { class: "muted", style: "font-size:11.5px;border-top:0.5px solid var(--border);padding-top:8px;margin-top:8px", text: "No commission rate set for you yet — ask the owner." }),
    ]));
  }
  content.appendChild(picker.el);
  content.appendChild(body);
  await load();
}

// ---------------- Owner: manage sales reps ----------------
async function renderOwnerSalesReps(content) {
  const nameInput = el("input", { placeholder: "Name" });
  const pinInput = el("input", { type: "text", placeholder: "PIN (4+ digits)", style: "max-width:140px" });
  const rateInput = el("input", { type: "number", placeholder: "Commission % (9am-6pm ET, Mon-Sat)", style: "max-width:220px" });
  const afterRateInput = el("input", { type: "number", placeholder: "After-hours %", style: "max-width:130px" });
  const notice = el("div", { class: "notice" });
  const list = el("div");

  async function loadList() {
    const reps = await api("/api/salesreps");
    list.innerHTML = "";
    if (reps.length === 0) list.appendChild(el("div", { class: "muted", text: "No sales reps added yet." }));
    reps.forEach((r) => {
      const rate = el("input", { type: "number", value: r.commissionRate || 0, style: "max-width:70px" });
      const afterRate = el("input", { type: "number", value: r.afterHoursCommissionRate || 0, style: "max-width:70px" });
      rate.addEventListener("change", () => api(`/api/salesreps/${r.id}`, { method: "PATCH", body: JSON.stringify({ commissionRate: rate.value }) }));
      afterRate.addEventListener("change", () => api(`/api/salesreps/${r.id}`, { method: "PATCH", body: JSON.stringify({ afterHoursCommissionRate: afterRate.value }) }));
      const newPinInput = el("input", { type: "text", placeholder: "New PIN", style: "max-width:90px" });
      const resetNotice = el("span", { class: "muted", style: "font-size:11px" });
      list.appendChild(el("div", { class: "card row" }, [
        el("div", { style: "flex:1;font-weight:500", text: r.name }),
        el("span", { class: "muted", style: "font-size:11.5px", text: "In hours:" }), rate, el("span", { class: "muted", style: "font-size:11.5px", text: "%" }),
        el("span", { class: "muted", style: "font-size:11.5px;margin-left:8px", text: "After hours:" }), afterRate, el("span", { class: "muted", style: "font-size:11.5px", text: "%" }),
        newPinInput,
        el("button", { class: "ghost", onclick: async () => {
          if (!newPinInput.value.trim()) return;
          await api(`/api/salesreps/${r.id}`, { method: "PATCH", body: JSON.stringify({ pin: newPinInput.value.trim() }) });
          newPinInput.value = ""; resetNotice.textContent = "PIN reset ✓"; resetNotice.style.color = "var(--green)";
          setTimeout(() => { resetNotice.textContent = ""; }, 2500);
        }, text: "Reset PIN" }),
        resetNotice,
        el("button", { class: "icon-danger", onclick: async () => { await api(`/api/salesreps/${r.id}`, { method: "DELETE" }); loadList(); }, text: "Remove" }),
      ]));
    });
  }

  content.appendChild(el("div", { class: "card" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "ADD SALES REP — this is the person who closed the deal, not the tech who worked it. Their commission is on the base sale, only counted once a manager marks the appointment as arrived. The rate that applies depends on when the deal actually closed — during business hours (Mon–Sat, 9am–6pm Eastern) or after." }),
    el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [nameInput, pinInput, rateInput, afterRateInput,
      el("button", { class: "primary", onclick: async () => {
        try {
          await api("/api/salesreps", { method: "POST", body: JSON.stringify({ name: nameInput.value, pin: pinInput.value, commissionRate: rateInput.value, afterHoursCommissionRate: afterRateInput.value }) });
          nameInput.value = ""; pinInput.value = ""; rateInput.value = ""; afterRateInput.value = "";
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

// ---------------- Attendance — who showed up, who didn't, who worked a half day ----------------
async function renderAttendance(content) {
  const dayBody = el("div");
  const nav = renderDayNav((params) => loadDay(params));
  async function loadDay(params) {
    const date = (params || nav.getParams()).date;
    const people = await api(`/api/manager/attendance?date=${date}`);
    dayBody.innerHTML = "";
    if (people.length === 0) { dayBody.appendChild(el("div", { class: "muted", text: "No employees or managers added yet." })); return; }
    people.forEach((p) => {
      const statusBtn = (value, label, color) => {
        const active = p.status === value;
        return el("button", {
          class: "tab-btn" + (active ? " active" : ""),
          style: "border-color:" + (active ? color : "var(--border)") + ";color:" + (active ? color : "var(--sub)"),
          onclick: async () => {
            await api("/api/manager/attendance", { method: "POST", body: JSON.stringify({ personType: p.type, personId: p.id, date, status: active ? null : value }) });
            loadDay();
          },
          text: (active ? "✓ " : "") + label,
        });
      };
      dayBody.appendChild(el("div", { class: "card row" }, [
        el("div", {}, [
          el("div", { style: "font-weight:500", text: p.name }),
          el("div", { class: "muted", style: "font-size:11.5px", text: p.type === "manager" ? "Manager" : "Employee" }),
        ]),
        el("div", { style: "display:flex;gap:8px" }, [
          statusBtn("present", "Present", "var(--green)"),
          statusBtn("half_day", "Half day", "var(--amber)"),
          statusBtn("absent", "Absent", "var(--red)"),
        ]),
      ]));
    });
  }

  const summaryBody = el("div");
  const summaryPicker = renderPeriodPicker((params) => loadSummary(params), "month");
  async function loadSummary(params) {
    const p = params || summaryPicker.getParams();
    const qs = new URLSearchParams(p).toString();
    const rows = await api(`/api/owner/attendance-summary?${qs}`);
    summaryBody.innerHTML = "";
    if (rows.length === 0) { summaryBody.appendChild(el("div", { class: "muted", text: "No one added yet." })); return; }
    const table = el("table", {}, [
      el("tr", {}, [el("th", { text: "Name" }), el("th", { text: "Present" }), el("th", { text: "Half day" }), el("th", { text: "Absent" })]),
      ...rows.map((r) => el("tr", {}, [
        el("td", { text: r.name }),
        el("td", { class: "mono", style: "color:var(--green)", text: r.present }),
        el("td", { class: "mono", style: "color:var(--amber)", text: r.halfDay }),
        el("td", { class: "mono", style: "color:var(--red)", text: r.absent }),
      ])),
    ]);
    summaryBody.appendChild(table);
  }

  content.appendChild(el("div", { class: "muted", style: "margin-bottom:8px;font-size:11.5px;letter-spacing:0.04em", text: "MARK TODAY (OR ANY DAY)" }));
  content.appendChild(nav.el);
  content.appendChild(dayBody);
  content.appendChild(el("div", { class: "muted", style: "margin:20px 0 8px;font-size:11.5px;letter-spacing:0.04em", text: "SUMMARY" }));
  content.appendChild(summaryPicker.el);
  content.appendChild(summaryBody);
  await loadDay();
  await loadSummary();
}

function clear(node) { node.innerHTML = ""; return node; }

// ---------------- Search — find a job by customer name, phone, email, or car ----------------
async function renderSearch(content) {
  const input = el("input", { placeholder: "Search by name, phone, email, or car...", style: "max-width:400px" });
  const results = el("div", { style: "margin-top:14px" });
  let timer;
  async function runSearch() {
    const q = input.value.trim();
    if (!q) { results.innerHTML = ""; return; }
    const rows = await api(`/api/manager/search?q=${encodeURIComponent(q)}`);
    results.innerHTML = "";
    if (rows.length === 0) { results.appendChild(el("div", { class: "muted", text: "No matches." })); return; }
    rows.forEach((s) => {
      const upsellPills = (s.upsells || []).length
        ? el("div", { style: "margin-top:6px" }, s.upsells.map((u) => el("span", { class: "pill", text: `${u.name} — ${money(u.price)} (${u.attributedToName})` })))
        : null;
      results.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500", text: s.car }),
            el("div", { class: "muted", text: `${s.customerName || ""}${s.customerPhone ? " · " + s.customerPhone : ""}${s.customerEmail ? " · " + s.customerEmail : ""}` }),
            el("div", { class: "muted", text: `${formatDateTime(s.date)} · ${s.employeeNames} · ${s.baseService || ""}` }),
          ]),
          el("div", { style: "text-align:right" }, [
            el("div", { class: "mono", style: "color:var(--amber)", text: money(s.total) }),
            el("div", { class: "muted", style: "font-size:11.5px", text: `${s.status || "pending"}${s.completed ? " · complete" : ""}${s.paid ? " · paid (" + (s.paymentMethod === "cash" ? "cash" : "card") + ")" : " · unpaid"}` }),
          ]),
        ]),
        upsellPills,
      ]));
    });
  }
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(runSearch, 300); });
  content.appendChild(el("div", { class: "field" }, [el("label", { text: "Look up a customer, vehicle, or job" }), input]));
  content.appendChild(results);
}

// ---------------- Manager's own performance — managers upsell too ----------------
async function renderManagerPerformance(content) {
  const body = el("div");
  const picker = renderPeriodPicker((params) => load(params), "month");
  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    const stats = await api(`/api/manager/performance?${qs}`);
    body.innerHTML = "";
    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Your upsell revenue" }), el("div", { class: "metric-value mono", style: "color:var(--cyan)", text: money(stats.upsellRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Cars you upsold" }), el("div", { class: "metric-value mono", text: stats.cars })]),
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
    body.appendChild(el("div", { class: "muted", style: "margin:16px 0 8px;font-size:11.5px;letter-spacing:0.04em", text: "CARS YOU UPSOLD THIS PERIOD" }));
    if (!stats.jobs || stats.jobs.length === 0) {
      body.appendChild(el("div", { class: "muted", text: "No upsells logged by you in this period." }));
    } else {
      stats.jobs.forEach((j) => {
        body.appendChild(el("div", { class: "card" }, [
          el("div", { class: "row" }, [
            el("div", {}, [
              el("div", { style: "font-weight:500", text: j.car }),
              el("div", { class: "muted", text: `${formatDateTime(j.date)}${j.customerName ? " · " + j.customerName : ""}` }),
            ]),
            el("div", { class: "mono", style: "color:var(--cyan)", text: money(j.upsells.reduce((a, u) => a + (parseFloat(u.price) || 0), 0)) }),
          ]),
          el("div", { style: "margin-top:6px" }, j.upsells.map((u) => el("span", { class: "pill", text: `${u.name} — ${money(u.price)}` }))),
        ]));
      });
    }
  }
  content.appendChild(picker.el);
  content.appendChild(body);
  await load();
}

// ---------------- Manager job-status board (used by both manager and owner) ----------------
function renderDayNav(onChange) {
  const dateInput = el("input", { type: "date", value: new Date().toISOString().slice(0, 10) });
  function fire() { onChange({ period: "day", date: dateInput.value }); }
  function shift(delta) {
    const d = new Date(dateInput.value + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + delta);
    dateInput.value = d.toISOString().slice(0, 10);
    fire();
  }
  const prev = el("button", { class: "ghost", text: "< Prev day" });
  prev.addEventListener("click", () => shift(-1));
  const next = el("button", { class: "ghost", text: "Next day >" });
  next.addEventListener("click", () => shift(1));
  const todayBtn = el("button", { class: "ghost", text: "Today" });
  todayBtn.addEventListener("click", () => { dateInput.value = new Date().toISOString().slice(0, 10); fire(); });
  dateInput.addEventListener("change", fire);
  const wrap = el("div", { style: "display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap" }, [prev, dateInput, next, todayBtn]);
  return { el: wrap, getParams: () => ({ period: "day", date: dateInput.value }) };
}

async function renderManagerJobs(content) {
  const body = el("div");
  const employees = await api("/api/manager/employees");
  const managersList = await api("/api/manager/managers-list");
  const nav = renderDayNav((params) => load(params));
  async function load(params) {
    const p = params || nav.getParams();
    const qs = new URLSearchParams(p).toString();
    const jobs = await api(`/api/manager/jobs?${qs}`);
    body.innerHTML = "";
    if (jobs.length === 0) { body.appendChild(el("div", { class: "muted", text: "No jobs on this day." })); return; }
    jobs.sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((job) => {
      const statusBtn = (value, label) => {
        const active = job.status === value;
        return el("button", {
          class: "tab-btn" + (active ? " active" : ""),
          style: "border-color:" + (active ? "var(--green)" : "var(--border)") + ";color:" + (active ? "var(--green)" : "var(--sub)"),
          onclick: async () => { await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ status: active ? "pending" : value }) }); load(); },
          text: (active ? "✓ " : "") + label,
        });
      };
      const boolBtn = (field, label) => {
        const active = job[field];
        return el("button", {
          class: "tab-btn" + (active ? " active" : ""),
          style: "border-color:" + (active ? "var(--green)" : "var(--border)") + ";color:" + (active ? "var(--green)" : "var(--sub)"),
          onclick: async () => { await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ [field]: !active }) }); load(); },
          text: (active ? "✓ " : "") + label,
        });
      };
      const paymentBtn = (value, label) => {
        const active = job.paymentMethod === value;
        return el("button", {
          class: "tab-btn" + (active ? " active" : ""),
          style: "border-color:" + (active ? "var(--green)" : "var(--border)") + ";color:" + (active ? "var(--green)" : "var(--sub)"),
          onclick: async () => { await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ paymentMethod: active ? null : value }) }); load(); },
          text: (active ? "✓ " : "") + label,
        });
      };

      const assignWrap = el("div", { style: "display:flex;gap:6px;flex-wrap:wrap" });
      let selected = new Set(job.employeeIds || []);
      employees.forEach((emp) => {
        const chip = el("button", {
          class: "tab-btn" + (selected.has(emp.id) ? " active" : ""),
          onclick: async () => {
            if (selected.has(emp.id)) selected.delete(emp.id); else selected.add(emp.id);
            await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ employeeIds: Array.from(selected) }) });
            load();
          },
          text: emp.name,
        });
        assignWrap.appendChild(chip);
      });

      const managerAssignWrap = el("div", { style: "display:flex;gap:6px;flex-wrap:wrap" });
      let selectedMgrs = new Set(job.managerHelperIds || []);
      managersList.forEach((mgr) => {
        const chip = el("button", {
          class: "tab-btn" + (selectedMgrs.has(mgr.id) ? " active" : ""),
          onclick: async () => {
            if (selectedMgrs.has(mgr.id)) selectedMgrs.delete(mgr.id); else selectedMgrs.add(mgr.id);
            await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ managerHelperIds: Array.from(selectedMgrs) }) });
            load();
          },
          text: mgr.name,
        });
        managerAssignWrap.appendChild(chip);
      });

      const upsellList = el("div", { style: "margin-bottom:6px" }, (job.upsells || []).map((u) => el("span", { class: "pill", text: `${u.name} — ${money(u.price)} (${u.attributedToName})` })));
      const upsellForm = renderUpsellForm(job.id, () => load());

      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row", style: "margin-bottom:10px" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500", text: job.car }),
            el("div", { class: "muted", text: `${formatDateTime(job.date)}${job.customerName ? " · " + job.customerName : ""}${job.customerPhone ? " · " + job.customerPhone : ""}` }),
            el("div", { class: "muted", text: job.baseService || "no service set" }),
          ]),
          el("div", { class: "mono", style: "color:var(--amber)", text: money(job.total) }),
        ]),
        el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px" }, [
          statusBtn("arrived", "Arrived"),
          statusBtn("no_show", "No-show"),
          boolBtn("completed", "Service complete"),
          paymentBtn("cash", "Paid — Cash"),
          paymentBtn("card", "Paid — Card"),
        ]),
        el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:2px", text: `TECHS WHO WORKED THIS CAR (currently: ${job.employeeNames})` }),
        assignWrap,
        el("div", { class: "muted", style: "font-size:11.5px;margin:8px 0 2px", text: `MANAGERS WHO ALSO HELPED (currently: ${job.managerHelperNames || "none"})` }),
        managerAssignWrap,
        el("div", { style: "margin-top:10px;border-top:0.5px solid var(--border);padding-top:10px" }, [
          upsellList,
          upsellForm,
        ]),
      ]));
    });
  }
  content.appendChild(nav.el);
  content.appendChild(body);
  await load();
}

// ---------------- Owner: manage managers ----------------
async function renderOwnerManagers(content) {
  const nameInput = el("input", { placeholder: "Name" });
  const pinInput = el("input", { type: "text", placeholder: "PIN (4+ digits)", style: "max-width:140px" });
  const rateInput = el("input", { type: "number", placeholder: "Commission %", style: "max-width:130px" });
  const notice = el("div", { class: "notice" });
  const list = el("div");

  async function loadList() {
    const managers = await api("/api/managers");
    list.innerHTML = "";
    if (managers.length === 0) list.appendChild(el("div", { class: "muted", text: "No managers added yet." }));
    managers.forEach((m) => {
      const rate = el("input", { type: "number", value: m.commissionRate || 0, style: "max-width:80px" });
      rate.addEventListener("change", () => api(`/api/managers/${m.id}`, { method: "PATCH", body: JSON.stringify({ commissionRate: rate.value }) }));
      const newPinInput = el("input", { type: "text", placeholder: "New PIN", style: "max-width:100px" });
      const resetNotice = el("span", { class: "muted", style: "font-size:11px" });
      list.appendChild(el("div", { class: "card row" }, [
        el("div", { style: "flex:1;font-weight:500", text: m.name }),
        rate,
        el("span", { class: "muted", text: "% commission" }),
        newPinInput,
        el("button", { class: "ghost", onclick: async () => {
          if (!newPinInput.value.trim()) return;
          await api(`/api/managers/${m.id}`, { method: "PATCH", body: JSON.stringify({ pin: newPinInput.value.trim() }) });
          newPinInput.value = ""; resetNotice.textContent = "PIN reset ✓"; resetNotice.style.color = "var(--green)";
          setTimeout(() => { resetNotice.textContent = ""; }, 2500);
        }, text: "Reset PIN" }),
        resetNotice,
        el("button", { class: "icon-danger", onclick: async () => { await api(`/api/managers/${m.id}`, { method: "DELETE" }); loadList(); }, text: "Remove" }),
      ]));
    });
  }

  content.appendChild(el("div", { class: "card" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "ADD MANAGER — they get their own PIN, a Job Status dashboard, search, and their own upsell performance (no shop-wide revenue or other people's commissions)" }),
    el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [nameInput, pinInput, rateInput,
      el("button", { class: "primary", onclick: async () => {
        try {
          await api("/api/managers", { method: "POST", body: JSON.stringify({ name: nameInput.value, pin: pinInput.value, commissionRate: rateInput.value }) });
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

// ---------------- Owner: built-in webhook test tool ----------------
async function renderTestTool(content) {
  const car = el("input", { placeholder: "Car (e.g. 2023 BMW M3)", value: "2023 BMW M3" });
  const customer = el("input", { placeholder: "Customer name", value: "Test Customer" });
  const phone = el("input", { placeholder: "Customer phone", value: "555-123-4567" });
  const email = el("input", { placeholder: "Customer email", value: "test@example.com" });
  const employeeName = el("input", { placeholder: "Employee name(s) — separate multiple with a comma", value: "" });
  const salesRepName = el("input", { placeholder: "Sales rep name (who closed it)", value: "" });
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
    el("div", { class: "field" }, [el("label", { text: "Phone" }), phone]),
    el("div", { class: "field" }, [el("label", { text: "Email" }), email]),
    el("div", { class: "field" }, [el("label", { text: "Employee name(s)" }), employeeName]),
    el("div", { class: "field" }, [el("label", { text: "Sales rep name" }), salesRepName]),
    el("div", { class: "field" }, [el("label", { text: "Base service" }), baseService]),
    el("div", { class: "field" }, [el("label", { text: "Base price" }), basePrice]),
    el("button", { class: "primary", onclick: async () => {
      try {
        await api("/api/owner/simulate-webhook", { method: "POST", body: JSON.stringify({
          date: new Date().toISOString(), customerName: customer.value, customerPhone: phone.value, customerEmail: email.value, car: car.value,
          employeeName: employeeName.value, salesRepName: salesRepName.value, baseService: baseService.value, basePrice: basePrice.value,
        }) });
        notice.className = "notice ok";
        notice.textContent = "Test job created — check \"All jobs\", \"Job status\", or \"Search\" to see it.";
      } catch (e) { notice.className = "notice err"; notice.textContent = e.message; }
    }, text: "Create test job" }),
    notice,
  ]));

  const cancelJobId = el("input", { placeholder: "Job ID to cancel (copy from All jobs)" });
  const cancelNotice = el("div", { class: "notice" });
  content.appendChild(el("div", { class: "card", style: "max-width:480px" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "SIMULATE A CANCELLATION — test what happens when GHL tells the tracker an appointment got cancelled. This removes the job from all revenue/commission totals but keeps it visible (marked Cancelled) in All Jobs and Search." }),
    el("div", { class: "field" }, [el("label", { text: "Job ID" }), cancelJobId]),
    el("button", { class: "primary", onclick: async () => {
      try {
        await api("/api/owner/simulate-cancel", { method: "POST", body: JSON.stringify({ saleId: cancelJobId.value.trim() }) });
        cancelNotice.className = "notice ok";
        cancelNotice.textContent = "Marked cancelled — check \"All jobs\" to see it, and \"Dashboard\" to confirm the revenue dropped.";
      } catch (e) { cancelNotice.className = "notice err"; cancelNotice.textContent = e.message; }
    }, text: "Cancel this job" }),
    cancelNotice,
  ]));

  const deleteJobId = el("input", { placeholder: "Job ID to delete (copy from All jobs)" });
  const deleteNotice = el("div", { class: "notice" });
  content.appendChild(el("div", { class: "card", style: "max-width:480px" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "SIMULATE A DELETION — test what happens when an appointment gets deleted in GHL, not just marked cancelled. This actually removes the job from the tracker entirely, rather than leaving it visible as Cancelled." }),
    el("div", { class: "field" }, [el("label", { text: "Job ID" }), deleteJobId]),
    el("button", { class: "primary", style: "background:var(--red);color:#fff", onclick: async () => {
      try {
        await api("/api/owner/simulate-delete", { method: "POST", body: JSON.stringify({ saleId: deleteJobId.value.trim() }) });
        deleteNotice.className = "notice ok";
        deleteNotice.textContent = "Deleted — check \"All jobs\": it should be completely gone, not showing as Cancelled.";
      } catch (e) { deleteNotice.className = "notice err"; deleteNotice.textContent = e.message; }
    }, text: "Delete this job" }),
    deleteNotice,
  ]));

  const debugBody = el("div");
  async function loadDebugLog() {
    const log = await api("/api/owner/debug-log");
    debugBody.innerHTML = "";
    if (log.length === 0) { debugBody.appendChild(el("div", { class: "muted", text: "Nothing logged yet." })); return; }
    log.forEach((entry) => {
      debugBody.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "font-size:11px;margin-bottom:6px", text: entry.receivedAt }),
        el("pre", { style: "font-family:monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-all;color:var(--text);margin:0", text: JSON.stringify(entry.body, null, 2) }),
      ]));
    });
  }
  content.appendChild(el("div", { class: "card", style: "max-width:600px" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "WEBHOOK DEBUG LOG — point any GHL webhook action at the URL below to see exactly what GHL actually sends, raw. Useful for checking whether an event (like a deleted appointment) secretly fires something we haven't mapped yet." }),
    el("div", { class: "mono", style: "font-size:11.5px;color:var(--cyan);margin-bottom:12px;word-break:break-all", text: `${window.location.origin}/api/webhook/ghl/debug?secret=YOUR_WEBHOOK_SECRET` }),
    el("div", { style: "display:flex;gap:8px;margin-bottom:12px" }, [
      el("button", { class: "ghost", onclick: loadDebugLog, text: "Refresh log" }),
      el("button", { class: "ghost", onclick: async () => { await api("/api/owner/debug-log/clear", { method: "POST" }); loadDebugLog(); }, text: "Clear log" }),
    ]),
  ]));
  content.appendChild(debugBody);
  await loadDebugLog();
}

boot();
