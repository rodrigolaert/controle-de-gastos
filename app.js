(() => {
  "use strict";

  const STORAGE_KEY = "gastos-mensais-v1";
  const MONTH_NAMES = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
  ];
  /** Categorias fixas iniciais de cada mês (ainda é possível adicionar/excluir). */
  const DEFAULT_CATEGORIES = [
    "Condomínio",
    "Energia",
    "Gás",
    "Impostos",
    "Funcionários",
    "Escola",
    "Cartão",
    "Consórcio",
  ];

  const LEGACY_DEFAULT_SETS = [
    ["Aluguel", "Condomínio", "Água", "Luz", "Internet", "Mercado", "Streaming", "Outros"],
    ["Condomínio", "Energia", "Gás", "Impostos", "Funcionários", "Escola"],
    ["Condomínio", "Energia", "Gás", "Impostos", "Funcionários", "Escola", "Cartão"],
  ].map((names) => new Set(names.map((n) => n.toLocaleLowerCase("pt-BR"))));

  const money = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

  const els = {
    yearSelect: document.getElementById("yearSelect"),
    viewBtns: [...document.querySelectorAll(".view-btn")],
    monthlyView: document.getElementById("monthlyView"),
    yearlyView: document.getElementById("yearlyView"),
    prevMonth: document.getElementById("prevMonth"),
    nextMonth: document.getElementById("nextMonth"),
    monthTitle: document.getElementById("monthTitle"),
    settleBtn: document.getElementById("settleBtn"),
    pctRodrigo: document.getElementById("pctRodrigo"),
    pctCamila: document.getElementById("pctCamila"),
    rangeRodrigo: document.getElementById("rangeRodrigo"),
    rangeCamila: document.getElementById("rangeCamila"),
    splitHint: document.getElementById("splitHint"),
    addCategoryForm: document.getElementById("addCategoryForm"),
    newCategoryInput: document.getElementById("newCategoryInput"),
    expenseRows: document.getElementById("expenseRows"),
    expenseFoot: document.getElementById("expenseFoot"),
    monthComments: document.getElementById("monthComments"),
    monthlySummary: document.getElementById("monthlySummary"),
    yearLabel: document.getElementById("yearLabel"),
    yearlySummary: document.getElementById("yearlySummary"),
    yearRows: document.getElementById("yearRows"),
    categoryYearBars: document.getElementById("categoryYearBars"),
    exportBtn: document.getElementById("exportBtn"),
    exportCsvBtn: document.getElementById("exportCsvBtn"),
    importInput: document.getElementById("importInput"),
    clearMonthBtn: document.getElementById("clearMonthBtn"),
  };

  const now = new Date();
  let state = loadState();
  let currentYear = clampYear(state.lastYear ?? now.getFullYear());
  let currentMonth = clampMonth(state.lastMonth ?? now.getMonth());
  let currentView = "mensal";
  let syncingSplit = false;

  function clampYear(y) {
    const n = Number(y);
    if (!Number.isFinite(n)) return now.getFullYear();
    return Math.min(2100, Math.max(2000, Math.round(n)));
  }

  function clampMonth(m) {
    const n = Number(m);
    if (!Number.isFinite(n)) return now.getMonth();
    return Math.min(11, Math.max(0, Math.round(n)));
  }

  function clampPct(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.min(100, Math.max(0, Math.round(n)));
  }

  function toNumber(v) {
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    if (typeof v !== "string") return 0;
    const cleaned = v.replace(/\s/g, "").replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }

  function monthKey(year, month) {
    return `${year}-${String(month + 1).padStart(2, "0")}`;
  }

  function emptyCategories() {
    return DEFAULT_CATEGORIES.map((name) => ({
      id: crypto.randomUUID(),
      name,
      rodrigo: 0,
      camila: 0,
    }));
  }

  function emptyMonth() {
    return {
      pctRodrigo: 50,
      pctCamila: 50,
      comments: "",
      settled: false,
      categories: emptyCategories(),
    };
  }

  function sameNameSet(categories, nameSet) {
    if (categories.length !== nameSet.size) return false;
    return categories.every((c) => nameSet.has(c.name.toLocaleLowerCase("pt-BR")));
  }

  function categoriesFromDefaults(byName) {
    return DEFAULT_CATEGORIES.map((name) => {
      const prev = byName.get(name.toLocaleLowerCase("pt-BR"));
      return {
        id: crypto.randomUUID(),
        name,
        rodrigo: prev?.rodrigo ?? 0,
        camila: prev?.camila ?? 0,
      };
    });
  }

  function normalizeMonth(raw) {
    const base = emptyMonth();
    if (!raw || typeof raw !== "object") return base;

    const pctR = clampPct(raw.pctRodrigo ?? 50);
    let categories = Array.isArray(raw.categories)
      ? raw.categories
          .map((c) => ({
            id: typeof c?.id === "string" && c.id ? c.id : crypto.randomUUID(),
            name: String(c?.name || "").trim().slice(0, 40),
            rodrigo: Math.max(0, toNumber(c?.rodrigo)),
            camila: Math.max(0, toNumber(c?.camila)),
          }))
          .filter((c) => c.name)
      : [];

    if (!categories.length) {
      categories = base.categories;
    } else {
      const isLegacyDefault = LEGACY_DEFAULT_SETS.some((set) => sameNameSet(categories, set));
      const isCurrentDefault = sameNameSet(
        categories,
        new Set(DEFAULT_CATEGORIES.map((n) => n.toLocaleLowerCase("pt-BR")))
      );
      if (isLegacyDefault && !isCurrentDefault) {
        const byName = new Map(
          categories.map((c) => [c.name.toLocaleLowerCase("pt-BR"), c])
        );
        categories = categoriesFromDefaults(byName);
      }
    }

    return {
      pctRodrigo: pctR,
      pctCamila: clampPct(raw.pctCamila ?? 100 - pctR),
      comments: String(raw.comments || "").slice(0, 2000),
      settled: Boolean(raw.settled),
      categories,
    };
  }

  function defaultState() {
    return { version: 1, months: {}, lastYear: now.getFullYear(), lastMonth: now.getMonth() };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return defaultState();
      const months = {};
      if (parsed.months && typeof parsed.months === "object") {
        for (const [key, value] of Object.entries(parsed.months)) {
          if (/^\d{4}-\d{2}$/.test(key)) months[key] = normalizeMonth(value);
        }
      }
      return {
        version: 1,
        months,
        lastYear: clampYear(parsed.lastYear ?? now.getFullYear()),
        lastMonth: clampMonth(parsed.lastMonth ?? now.getMonth()),
      };
    } catch {
      return defaultState();
    }
  }

  function saveState() {
    state.lastYear = currentYear;
    state.lastMonth = currentMonth;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function getMonthData(year = currentYear, month = currentMonth) {
    const key = monthKey(year, month);
    if (!state.months[key]) {
      state.months[key] = emptyMonth();
      saveState();
    } else {
      state.months[key] = normalizeMonth(state.months[key]);
    }
    return state.months[key];
  }

  function calcMonth(data) {
    let paidR = 0;
    let paidC = 0;
    for (const cat of data.categories) {
      paidR += toNumber(cat.rodrigo);
      paidC += toNumber(cat.camila);
    }
    const total = paidR + paidC;
    const pctR = clampPct(data.pctRodrigo);
    const pctC = clampPct(data.pctCamila);
    const dueR = (total * pctR) / 100;
    const dueC = (total * pctC) / 100;
    // Positive => Rodrigo overpaid (Camila owes him). Negative => Camila overpaid.
    const balance = paidR - dueR;
    return { paidR, paidC, total, pctR, pctC, dueR, dueC, balance };
  }

  function balanceLabel(balance) {
    const abs = Math.abs(balance);
    if (abs < 0.005) return { text: "Quitados", who: "even", amount: 0 };
    if (balance > 0) {
      return {
        text: `Camila deve a Rodrigo`,
        who: "camila",
        amount: abs,
      };
    }
    return {
      text: `Rodrigo deve a Camila`,
      who: "rodrigo",
      amount: abs,
    };
  }

  function fillYears() {
    const years = new Set([currentYear, now.getFullYear()]);
    for (const key of Object.keys(state.months)) {
      years.add(Number(key.slice(0, 4)));
    }
    for (let y = now.getFullYear() - 2; y <= now.getFullYear() + 3; y++) years.add(y);
    const sorted = [...years].sort((a, b) => a - b);
    els.yearSelect.innerHTML = sorted
      .map((y) => `<option value="${y}"${y === currentYear ? " selected" : ""}>${y}</option>`)
      .join("");
  }

  function setSplitUI(pctR, pctC, { fromRange = false } = {}) {
    syncingSplit = true;
    els.pctRodrigo.value = pctR;
    els.pctCamila.value = pctC;
    if (!fromRange || document.activeElement !== els.rangeRodrigo) {
      els.rangeRodrigo.value = pctR;
    }
    if (!fromRange || document.activeElement !== els.rangeCamila) {
      els.rangeCamila.value = pctC;
    }
    if (pctR === 50 && pctC === 50) {
      els.splitHint.textContent = "Divisão equilibrada 50 / 50";
    } else {
      els.splitHint.textContent = `Divisão ${pctR}% Rodrigo / ${pctC}% Camila`;
    }
    syncingSplit = false;
  }

  function applySplit(pctR, source) {
    const r = clampPct(pctR);
    const c = 100 - r;
    const data = getMonthData();
    data.pctRodrigo = r;
    data.pctCamila = c;
    setSplitUI(r, c, { fromRange: source === "range" });
    saveState();
    renderMonthlySummary();
    if (currentView === "anual") renderYearly();
  }

  function renderExpenseRows() {
    const data = getMonthData();
    const canRemove = data.categories.length > 1;
    els.expenseRows.innerHTML = data.categories
      .map((cat) => {
        const total = toNumber(cat.rodrigo) + toNumber(cat.camila);
        return `
          <tr data-id="${escapeAttr(cat.id)}">
            <td>
              <div class="category-cell-inner">
                <span class="category-name" title="${escapeAttr(cat.name)}">${escapeHtml(cat.name)}</span>
                <button type="button" class="remove-category${canRemove ? "" : " is-placeholder"}" data-remove="${escapeAttr(cat.id)}" aria-label="Remover ${escapeAttr(cat.name)}"${canRemove ? "" : ' tabindex="-1"'}>×</button>
              </div>
            </td>
            <td>
              <input class="input-rodrigo" type="number" min="0" step="0.01" inputmode="decimal"
                data-field="rodrigo" data-id="${escapeAttr(cat.id)}" value="${formatInput(cat.rodrigo)}" aria-label="${escapeAttr(cat.name)} Rodrigo" />
            </td>
            <td>
              <input class="input-camila" type="number" min="0" step="0.01" inputmode="decimal"
                data-field="camila" data-id="${escapeAttr(cat.id)}" value="${formatInput(cat.camila)}" aria-label="${escapeAttr(cat.name)} Camila" />
            </td>
            <td class="row-total">${money.format(total)}</td>
          </tr>
        `;
      })
      .join("");

    const totals = calcMonth(data);
    els.expenseFoot.innerHTML = `
      <tr>
        <td>Totais pagos</td>
        <td class="total-rodrigo">${money.format(totals.paidR)}</td>
        <td class="total-camila">${money.format(totals.paidC)}</td>
        <td class="row-total">${money.format(totals.total)}</td>
      </tr>
    `;
  }

  function formatInput(n) {
    const v = toNumber(n);
    if (v === 0) return "";
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, "&#39;");
  }

  function summaryCard(label, value, extraClass = "") {
    return `
      <article class="summary-card ${extraClass}">
        <span>${label}</span>
        <strong>${value}</strong>
      </article>
    `;
  }

  function renderSettleBtn(settled) {
    const isSettled = Boolean(settled);
    els.settleBtn.classList.toggle("is-settled", isSettled);
    els.settleBtn.setAttribute("aria-pressed", isSettled ? "true" : "false");
    els.settleBtn.title = isSettled
      ? "Dívida marcada como quitada — clique para desfazer"
      : "Marcar dívida do mês como quitada";
    els.settleBtn.querySelector(".settle-icon").textContent = isSettled ? "✓" : "";
    els.settleBtn.querySelector(".settle-label").textContent = isSettled ? "Quitado" : "Pendente";
  }

  function renderMonthlySummary() {
    const data = getMonthData();
    const t = calcMonth(data);
    const bal = balanceLabel(t.balance);
    let balanceClass = "balance-zero";
    let balanceValue = money.format(0);
    let balanceText = bal.text;
    if (data.settled) {
      balanceClass = "balance-settled";
      balanceValue = bal.who === "even" ? money.format(0) : money.format(bal.amount);
      balanceText = "Dívida quitada";
    } else if (bal.who !== "even") {
      balanceClass = "balance-negative";
      balanceValue = money.format(bal.amount);
    }

    els.monthlySummary.innerHTML = [
      summaryCard("Total do mês", money.format(t.total)),
      summaryCard(`Devido Rodrigo (${t.pctR}%)`, money.format(t.dueR)),
      summaryCard(`Devido Camila (${t.pctC}%)`, money.format(t.dueC)),
      summaryCard("Pago Rodrigo", money.format(t.paidR)),
      summaryCard("Pago Camila", money.format(t.paidC)),
      summaryCard(balanceText, balanceValue, balanceClass),
    ].join("");
  }

  function renderMonthly() {
    const data = getMonthData();
    els.monthTitle.textContent = `${MONTH_NAMES[currentMonth]} ${currentYear}`;
    setSplitUI(data.pctRodrigo, data.pctCamila);
    els.monthComments.value = data.comments || "";
    renderSettleBtn(data.settled);
    renderExpenseRows();
    renderMonthlySummary();
  }

  function renderYearly() {
    els.yearLabel.textContent = String(currentYear);
    const rows = [];
    let yearTotal = 0;
    let yearPaidR = 0;
    let yearPaidC = 0;
    let yearDueR = 0;
    let yearDueC = 0;
    let monthsWithData = 0;
    const categoryTotals = new Map();

    let openBalance = 0;

    for (let m = 0; m < 12; m++) {
      const key = monthKey(currentYear, m);
      const data = state.months[key] ? normalizeMonth(state.months[key]) : null;
      if (!data) {
        rows.push({
          month: m,
          empty: true,
          settled: false,
          total: 0,
          dueR: 0,
          dueC: 0,
          paidR: 0,
          paidC: 0,
          balance: 0,
        });
        continue;
      }
      const t = calcMonth(data);
      const hasValues = t.total > 0 || data.comments.trim() || data.pctRodrigo !== 50 || data.settled;
      if (hasValues || t.total > 0) monthsWithData += 1;
      yearTotal += t.total;
      yearPaidR += t.paidR;
      yearPaidC += t.paidC;
      yearDueR += t.dueR;
      yearDueC += t.dueC;
      if (!data.settled) openBalance += t.balance;
      for (const cat of data.categories) {
        const sum = toNumber(cat.rodrigo) + toNumber(cat.camila);
        if (sum <= 0) continue;
        categoryTotals.set(cat.name, (categoryTotals.get(cat.name) || 0) + sum);
      }
      rows.push({
        month: m,
        empty: t.total === 0 && !data.comments.trim() && !data.settled,
        settled: Boolean(data.settled),
        ...t,
      });
    }

    const bal = balanceLabel(openBalance);
    const avgPctR = yearTotal > 0 ? Math.round((yearDueR / yearTotal) * 100) : 50;
    const avgPctC = 100 - avgPctR;

    els.yearlySummary.innerHTML = [
      summaryCard("Total anual", money.format(yearTotal)),
      summaryCard("Média contribuição Rodrigo", `${avgPctR}%`),
      summaryCard("Média contribuição Camila", `${avgPctC}%`),
      summaryCard("Pago Rodrigo", money.format(yearPaidR)),
      summaryCard("Pago Camila", money.format(yearPaidC)),
      summaryCard(
        bal.who === "even" ? "Saldo em aberto" : `Em aberto — ${bal.text}`,
        bal.who === "even" ? money.format(0) : money.format(bal.amount),
        bal.who === "even" ? "balance-zero" : "balance-negative"
      ),
    ].join("");

    els.yearRows.innerHTML = rows
      .map((row) => {
        const balRow = balanceLabel(row.balance || 0);
        const badge = row.settled
          ? `<span class="badge settled">Quitado</span>`
          : row.empty && row.total === 0
            ? `<span class="badge even">—</span>`
            : balRow.who === "even"
              ? `<span class="badge even">OK</span>`
              : `<span class="badge ${balRow.who}">${money.format(balRow.amount)}</span>`;
        const settleClass = row.settled ? "settle-toggle is-settled" : "settle-toggle";
        return `
          <tr data-month="${row.month}">
            <td>${MONTH_NAMES[row.month]}</td>
            <td>${row.total ? money.format(row.total) : "—"}</td>
            <td>${row.total ? money.format(row.dueR) : "—"}</td>
            <td>${row.total ? money.format(row.dueC) : "—"}</td>
            <td>${row.paidR ? money.format(row.paidR) : "—"}</td>
            <td>${row.paidC ? money.format(row.paidC) : "—"}</td>
            <td>${badge}</td>
            <td>
              <button
                type="button"
                class="${settleClass}"
                data-settle-month="${row.month}"
                aria-label="${row.settled ? "Desmarcar quitado" : "Marcar como quitado"} ${MONTH_NAMES[row.month]}"
                aria-pressed="${row.settled ? "true" : "false"}"
                title="${row.settled ? "Quitado" : "Marcar como quitado"}"
              >${row.settled ? "✓" : ""}</button>
            </td>
          </tr>
        `;
      })
      .join("");

    const sortedCats = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]);
    const maxCat = sortedCats[0]?.[1] || 0;
    if (!sortedCats.length) {
      els.categoryYearBars.innerHTML = `<p class="hint">Nenhum gasto registrado neste ano.</p>`;
    } else {
      els.categoryYearBars.innerHTML = sortedCats
        .map(([name, value]) => {
          const pct = maxCat ? Math.max(4, (value / maxCat) * 100) : 0;
          return `
            <div class="bar-row">
              <span class="bar-label">${escapeHtml(name)}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
              <span class="bar-value">${money.format(value)}</span>
            </div>
          `;
        })
        .join("");
    }

    void monthsWithData;
  }

  function setView(view) {
    currentView = view;
    els.viewBtns.forEach((btn) => {
      const active = btn.dataset.view === view;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    els.monthlyView.classList.toggle("hidden", view !== "mensal");
    els.yearlyView.classList.toggle("hidden", view !== "anual");
    if (view === "anual") renderYearly();
    else renderMonthly();
  }

  function findCategory(id) {
    return getMonthData().categories.find((c) => c.id === id);
  }

  // Events
  els.yearSelect.addEventListener("change", () => {
    currentYear = clampYear(els.yearSelect.value);
    saveState();
    if (currentView === "anual") renderYearly();
    else renderMonthly();
  });

  els.viewBtns.forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  els.prevMonth.addEventListener("click", () => {
    if (currentMonth === 0) {
      currentMonth = 11;
      currentYear -= 1;
      fillYears();
      els.yearSelect.value = String(currentYear);
    } else {
      currentMonth -= 1;
    }
    saveState();
    renderMonthly();
  });

  els.nextMonth.addEventListener("click", () => {
    if (currentMonth === 11) {
      currentMonth = 0;
      currentYear += 1;
      fillYears();
      els.yearSelect.value = String(currentYear);
    } else {
      currentMonth += 1;
    }
    saveState();
    renderMonthly();
  });

  function onPctInput(person) {
    if (syncingSplit) return;
    if (person === "rodrigo") applySplit(els.pctRodrigo.value, "number");
    else applySplit(100 - clampPct(els.pctCamila.value), "number");
  }

  els.pctRodrigo.addEventListener("input", () => onPctInput("rodrigo"));
  els.pctCamila.addEventListener("input", () => onPctInput("camila"));
  els.rangeRodrigo.addEventListener("input", () => {
    if (syncingSplit) return;
    applySplit(els.rangeRodrigo.value, "range");
  });
  els.rangeCamila.addEventListener("input", () => {
    if (syncingSplit) return;
    applySplit(100 - clampPct(els.rangeCamila.value), "range");
  });

  els.monthComments.addEventListener("input", () => {
    const data = getMonthData();
    data.comments = els.monthComments.value.slice(0, 2000);
    saveState();
  });

  els.addCategoryForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = els.newCategoryInput.value.trim().slice(0, 40);
    if (!name) return;
    const data = getMonthData();
    const exists = data.categories.some(
      (c) => c.name.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR")
    );
    if (exists) {
      els.newCategoryInput.focus();
      return;
    }
    data.categories.push({
      id: crypto.randomUUID(),
      name,
      rodrigo: 0,
      camila: 0,
    });
    els.newCategoryInput.value = "";
    saveState();
    renderExpenseRows();
    renderMonthlySummary();
  });

  els.expenseRows.addEventListener("input", (e) => {
    const input = e.target.closest("input[data-id][data-field]");
    if (!input) return;
    const cat = findCategory(input.dataset.id);
    if (!cat) return;
    cat[input.dataset.field] = Math.max(0, toNumber(input.value));
    const row = input.closest("tr");
    if (row) {
      const totalCell = row.querySelector(".row-total");
      if (totalCell) {
        totalCell.textContent = money.format(toNumber(cat.rodrigo) + toNumber(cat.camila));
      }
    }
    const data = getMonthData();
    const totals = calcMonth(data);
    els.expenseFoot.innerHTML = `
      <tr>
        <td>Totais pagos</td>
        <td class="total-rodrigo">${money.format(totals.paidR)}</td>
        <td class="total-camila">${money.format(totals.paidC)}</td>
        <td class="row-total">${money.format(totals.total)}</td>
      </tr>
    `;
    saveState();
    renderMonthlySummary();
  });

  els.expenseRows.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove]");
    if (!btn || btn.classList.contains("is-placeholder")) return;
    const data = getMonthData();
    if (data.categories.length <= 1) return;
    const id = btn.getAttribute("data-remove");
    data.categories = data.categories.filter((c) => c.id !== id);
    saveState();
    renderExpenseRows();
    renderMonthlySummary();
  });

  function toggleSettled(year, month) {
    const data = getMonthData(year, month);
    data.settled = !data.settled;
    saveState();
    if (currentView === "anual") renderYearly();
    else renderMonthly();
  }

  els.settleBtn.addEventListener("click", () => {
    toggleSettled(currentYear, currentMonth);
  });

  els.yearRows.addEventListener("click", (e) => {
    const settleBtn = e.target.closest("[data-settle-month]");
    if (settleBtn) {
      e.stopPropagation();
      toggleSettled(currentYear, clampMonth(settleBtn.dataset.settleMonth));
      return;
    }
    const tr = e.target.closest("tr[data-month]");
    if (!tr) return;
    currentMonth = clampMonth(tr.dataset.month);
    saveState();
    setView("mensal");
  });

  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    if (/[;"\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  function formatCsvNumber(n) {
    return String(Math.round(toNumber(n) * 100) / 100).replace(".", ",");
  }

  function buildCsv() {
    const sep = ";";
    const header = [
      "Ano",
      "Mês",
      "Categoria",
      "Rodrigo (R$)",
      "Camila (R$)",
      "Total (R$)",
      "% Rodrigo",
      "% Camila",
      "Devido Rodrigo (R$)",
      "Devido Camila (R$)",
      "Saldo (R$)",
      "Quem deve",
      "Quitado",
      "Comentários",
    ].join(sep);

    const keys = Object.keys(state.months).sort();
    const rows = [header];

    for (const key of keys) {
      const [yearStr, monthStr] = key.split("-");
      const year = Number(yearStr);
      const month = Number(monthStr) - 1;
      const data = normalizeMonth(state.months[key]);
      const totals = calcMonth(data);
      const bal = balanceLabel(totals.balance);
      const who = data.settled
        ? "Quitado"
        : bal.who === "even"
          ? "OK"
          : bal.who === "camila"
            ? "Camila deve a Rodrigo"
            : "Rodrigo deve a Camila";
      const saldo =
        bal.who === "even" ? "0" : formatCsvNumber(bal.who === "camila" ? bal.amount : -bal.amount);

      for (const cat of data.categories) {
        const catTotal = toNumber(cat.rodrigo) + toNumber(cat.camila);
        rows.push(
          [
            year,
            MONTH_NAMES[month],
            csvEscape(cat.name),
            formatCsvNumber(cat.rodrigo),
            formatCsvNumber(cat.camila),
            formatCsvNumber(catTotal),
            totals.pctR,
            totals.pctC,
            formatCsvNumber(totals.dueR),
            formatCsvNumber(totals.dueC),
            saldo,
            csvEscape(who),
            data.settled ? "Sim" : "Não",
            csvEscape(data.comments),
          ].join(sep)
        );
      }
    }

    if (rows.length === 1) {
      rows.push(
        [
          currentYear,
          MONTH_NAMES[currentMonth],
          "",
          "0",
          "0",
          "0",
          "50",
          "50",
          "0",
          "0",
          "0",
          "OK",
          "Não",
          "",
        ].join(sep)
      );
    }

    return "\uFEFF" + rows.join("\r\n");
  }

  els.exportBtn.addEventListener("click", () => {
    downloadFile(
      `gastos-mensais-${monthKey(currentYear, currentMonth)}.json`,
      JSON.stringify(state, null, 2),
      "application/json"
    );
  });

  els.exportCsvBtn.addEventListener("click", () => {
    downloadFile(
      `gastos-mensais-${currentYear}.csv`,
      buildCsv(),
      "text/csv;charset=utf-8"
    );
  });

  els.importInput.addEventListener("change", async () => {
    const file = els.importInput.files?.[0];
    els.importInput.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !parsed.months) {
        alert("Arquivo JSON inválido.");
        return;
      }
      const next = defaultState();
      for (const [key, value] of Object.entries(parsed.months)) {
        if (/^\d{4}-\d{2}$/.test(key)) next.months[key] = normalizeMonth(value);
      }
      next.lastYear = clampYear(parsed.lastYear ?? currentYear);
      next.lastMonth = clampMonth(parsed.lastMonth ?? currentMonth);
      state = next;
      currentYear = next.lastYear;
      currentMonth = next.lastMonth;
      saveState();
      fillYears();
      els.yearSelect.value = String(currentYear);
      if (currentView === "anual") renderYearly();
      else renderMonthly();
    } catch {
      alert("Não foi possível importar o arquivo.");
    }
  });

  els.clearMonthBtn.addEventListener("click", () => {
    const label = `${MONTH_NAMES[currentMonth]} ${currentYear}`;
    if (!confirm(`Limpar todos os dados de ${label}?`)) return;
    state.months[monthKey(currentYear, currentMonth)] = emptyMonth();
    saveState();
    renderMonthly();
    if (currentView === "anual") renderYearly();
  });

  fillYears();
  els.yearSelect.value = String(currentYear);
  setView("mensal");
})();
