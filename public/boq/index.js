/*************************************************************
 * BOQ CSV (AUTO-LOAD) + HIERARCHY + COLLAPSE + ROLLUP ENGINE
 *
 * IMPROVEMENTS:
 * - Fixed UTF-8 character encoding issues
 * - Removed px-3 from generated rows (handled by CSS)
 * - Added error handling for CSV loading
 * - Added input validation
 * - Using CSS custom properties for indentation
 * - Better CSV parsing for quoted fields
 * - Performance improvements
 *************************************************************/

/* ================= COLUMN MAP ================= */
const COL = {
  CODE: 0,
  DESC: 1,
  QTY: 2,
  UNIT: 3,
  RATE: 4,
  SUBTOTAL: 5,
  MARKUP: 6, // UI label = FACTOR
  TOTAL: 7
};

/* ================= CONFIG ================= */
const CONFIG = {
  INDENT_PX: 20,           // ~3-5mm
  AUTO_CSV_PATH: "./boq.csv",
  STORAGE_KEY: "boqRateOverrides",
  COLLAPSE_ICON: "▸",      // Right-pointing triangle
  EXPAND_ICON: "▾"         // Down-pointing triangle
};

/* ================= CODE UTILITIES ================= */
function isRate(code) {
  return /\.R\d+$/.test(code || "");
}

function stripRate(code) {
  return (code || "").replace(/\.R\d+$/, "");
}

function tradePrefix(code) {
  const parts = stripRate(code).split(".");
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : "";
}

function numericSlots(code) {
  return stripRate(code).split(".").slice(2).map(n => parseInt(n, 10));
}

function nonZeroCount(code) {
  return numericSlots(code).reduce((a, n) => a + (n !== 0 ? 1 : 0), 0);
}

/**
 * Covers relationship:
 * parent covers child if all parent non-zero slots match child's slots.
 */
function covers(parentCode, childCode) {
  if (!parentCode || !childCode) return false;
  if (tradePrefix(parentCode) !== tradePrefix(childCode)) return false;

  const p = numericSlots(parentCode);
  const c = numericSlots(childCode);
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== 0 && p[i] !== c[i]) return false;
  }
  return true;
}

function isDescendant(parentCode, childCode) {
  if (!parentCode || !childCode) return false;
  if (stripRate(parentCode) === stripRate(childCode)) return false;
  if (isRate(childCode)) return false; // rates handled via base
  return covers(parentCode, childCode);
}

/* ================= DOM HELPERS ================= */
function rows() {
  return Array.from(document.querySelectorAll(".boq-row[data-code]"));
}

/* ================= NUMBER HELPERS ================= */
function parseNumber(v) {
  const n = parseFloat(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function parseMoney(v) {
  const n = parseFloat(String(v ?? "").replace(/[$,\s]/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function parsePercent(v) {
  const n = parseFloat(String(v ?? "").replace(/[%\s]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function formatMoney(n) {
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Uploaded values are those that came from CSV at render time.
 * Computed values are allowed to change after user edits.
 */
function cellHasUploadedValue(cellEl) {
  return !!cellEl && cellEl.dataset && cellEl.dataset.uploaded === "1";
}

/* ================= LOCAL STORAGE HELPERS ================= */
function loadOverrides() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveOverrides(obj) {
  localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(obj));
}

function normaliseEditableNumberText(s) {
  const cleaned = String(s ?? "")
    .replace(/[$,%\s]/g, "")
    .replace(/,/g, "")
    .trim();

  if (cleaned === "") return "";

  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? String(n) : "";
}

/* ================= MINIMAL UI: INPUT CREATOR ================= */
function makeNumericInput(initialValue = "") {
  const input = document.createElement("input");
  input.type = "text";
  input.value = initialValue;
  input.className = "boq-input"; // Using CSS class instead of Tailwind

  // Add input validation
  input.addEventListener('input', (e) => {
    const value = e.target.value;
    // Allow numbers, decimals, negative, and empty
    if (value && !/^-?\d*\.?\d*$/.test(value)) {
      e.target.value = value.slice(0, -1);
    }
  });

  return input;
}

function getCellNumericText(cellEl) {
  if (!cellEl) return "";
  const inp = cellEl.querySelector("input");
  return inp ? inp.value : cellEl.textContent;
}

/* ============================================================
 * CALCULATIONS (DOES NOT OVERRIDE UPLOADED VALUES)
 * ============================================================ */
function applyRowCalculations(allRows) {
  for (const r of allRows) {
    if (!r || !r.children) continue;

    const qtyCell = r.children[COL.QTY];
    const rateCell = r.children[COL.RATE];
    const subtotalCell = r.children[COL.SUBTOTAL];
    const markupCell = r.children[COL.MARKUP]; // FACTOR
    const totalCell = r.children[COL.TOTAL];

    if (!qtyCell || !rateCell || !subtotalCell || !markupCell || !totalCell) continue;

    const qty = parseNumber(getCellNumericText(qtyCell));
    const rate = parseMoney(getCellNumericText(rateCell));

    // SUBTOTAL
    let subtotal = null;

    if (cellHasUploadedValue(subtotalCell)) {
      subtotal = parseMoney(subtotalCell.textContent);
    } else {
      if (qty !== 0 && rate !== 0) {
        subtotal = qty * rate;
        subtotalCell.textContent = formatMoney(subtotal);
      } else {
        subtotalCell.textContent = "";
      }
    }

    // TOTAL
    if (cellHasUploadedValue(totalCell)) continue;

    if (subtotal !== null) {
      let total = subtotal;

      // FACTOR (percentage logic)
      const factorText = String(getCellNumericText(markupCell) ?? "").trim();
      if (cellHasUploadedValue(markupCell) || factorText.length > 0) {
        const pct = parsePercent(factorText);
        if (pct !== null) total = subtotal * (1 + pct / 100);
      }

      totalCell.textContent = formatMoney(total);
    } else {
      if (!cellHasUploadedValue(totalCell)) totalCell.textContent = "";
    }
  }
}

/* ============================================================
 * HIERARCHY INDEX
 * Parent = most specific PRIOR row that covers the child
 * Rates attach to their base code.
 * ============================================================ */
function buildHierarchyIndex(allRows) {
  const nodes = allRows
    .map((r, idx) => ({ el: r, code: r.dataset.code, idx }))
    .filter(x => x.code && !isRate(x.code));

  const parentOf = new Map();        // code -> parentCode|null
  const childrenOf = new Map();      // code -> [child codes]
  const rateChildrenOf = new Map();  // baseCode -> [rate codes]
  const depthOf = new Map();         // code -> UI depth

  for (const n of nodes) {
    childrenOf.set(n.code, []);
    rateChildrenOf.set(n.code, []);
  }

  // Build parent lookup map by trade prefix for better performance
  const candidatesByPrefix = new Map();
  
  for (const n of nodes) {
    const prefix = tradePrefix(n.code);
    if (!candidatesByPrefix.has(prefix)) {
      candidatesByPrefix.set(prefix, []);
    }
    candidatesByPrefix.get(prefix).push(n);
  }

  // Find parents efficiently
  for (const n of nodes) {
    const prefix = tradePrefix(n.code);
    const candidates = candidatesByPrefix.get(prefix) || [];
    
    let bestParent = null;
    let bestSpec = -1;
    let bestIdx = -1;

    for (const p of candidates) {
      if (p.idx >= n.idx) continue; // prior rows only
      if (!covers(p.code, n.code)) continue;

      const spec = nonZeroCount(p.code);
      if (spec > bestSpec || (spec === bestSpec && p.idx > bestIdx)) {
        bestParent = p.code;
        bestSpec = spec;
        bestIdx = p.idx;
      }
    }

    if (bestParent === n.code) bestParent = null;

    parentOf.set(n.code, bestParent);
    if (bestParent && childrenOf.has(bestParent)) {
      childrenOf.get(bestParent).push(n.code);
    }
  }

  // Attach rate rows
  for (const r of allRows) {
    const c = r.dataset.code;
    if (!c || !isRate(c)) continue;
    const base = stripRate(c);
    if (!rateChildrenOf.has(base)) rateChildrenOf.set(base, []);
    rateChildrenOf.get(base).push(c);
  }

  // Compute depth
  function computeDepth(code) {
    if (depthOf.has(code)) return depthOf.get(code);
    const p = parentOf.get(code);
    const d = p ? computeDepth(p) + 1 : 0;
    depthOf.set(code, d);
    return d;
  }
  for (const n of nodes) computeDepth(n.code);

  return { parentOf, childrenOf, rateChildrenOf, depthOf };
}

function hasChildren(code, hierarchy) {
  if (!code || isRate(code)) return false;
  const { childrenOf, rateChildrenOf } = hierarchy;
  return (childrenOf.get(code)?.length || 0) > 0 || (rateChildrenOf.get(code)?.length || 0) > 0;
}

/* ============================================================
 * PRESENTATION
 * ============================================================ */
function applyLevelPresentation(rowEl, code, codeCell, descCell, hierarchy) {
  rowEl.style.removeProperty("background-color");

  if (isRate(code)) return;

  const depth = hierarchy.depthOf.get(code) || 0;

  if (depth === 0) {
    rowEl.style.setProperty("background-color", "#f1f5f9", "important"); // slate-100

    if (codeCell) {
      codeCell.style.setProperty("color", "#64748b", "important"); // slate-500
      codeCell.style.setProperty("font-weight", "700", "important");
      codeCell.style.setProperty("text-decoration", "underline", "important");

      const labelSpan = codeCell.querySelector("span:last-child");
      if (labelSpan) {
        labelSpan.style.setProperty("color", "#64748b", "important");
        labelSpan.style.setProperty("font-weight", "700", "important");
        labelSpan.style.setProperty("text-decoration", "underline", "important");
      }
    }

    if (descCell) {
      descCell.style.setProperty("color", "#64748b", "important");
      descCell.style.setProperty("font-weight", "700", "important");
      descCell.style.setProperty("text-decoration", "underline", "important");
    }
  } else {
    if (descCell) {
      descCell.style.setProperty("font-weight", "700", "important");
    }
  }
}

/* ============================================================
 * ROLLUPS
 * Rule:
 * - Parent sums ALL descendant RATE rows recursively
 * - PLUS non-rate rows that have uploaded SUBTOTAL/TOTAL
 * - Avoid double-counting rollup nodes
 * ============================================================ */
function rowHasUploadedMoney(rowEl) {
  const subCell = rowEl.children[COL.SUBTOTAL];
  const totCell = rowEl.children[COL.TOTAL];
  return (subCell && cellHasUploadedValue(subCell)) || (totCell && cellHasUploadedValue(totCell));
}

function recomputeAllRollups(allRows, hierarchy) {
  const nodes = allRows.filter(r => r.dataset.code && !isRate(r.dataset.code));

  for (const node of nodes) {
    const nCode = node.dataset.code;
    let subtotal = 0;
    let total = 0;

    for (const r of allRows) {
      const rCode = r.dataset.code;
      if (!rCode) continue;

      // Descendancy test is done on base codes
      const base = stripRate(rCode);
      const within = base === nCode || isDescendant(nCode, base);

      if (!within) continue;

      if (isRate(rCode)) {
        // Recursive: include ALL descendant rate rows
        subtotal += parseMoney(r.children[COL.SUBTOTAL]?.textContent);
        total += parseMoney(r.children[COL.TOTAL]?.textContent);
        continue;
      }

      // Non-rate rows: ONLY include if they have uploaded money values
      if (rowHasUploadedMoney(r)) {
        subtotal += parseMoney(r.children[COL.SUBTOTAL]?.textContent);
        total += parseMoney(r.children[COL.TOTAL]?.textContent);
      }
    }

    // Parent rows never show quantity
    node.children[COL.QTY].textContent = "";

    node.children[COL.SUBTOTAL].textContent = formatMoney(subtotal);
    node.children[COL.TOTAL].textContent = formatMoney(total);
  }
}

/* ================= VISIBILITY ================= */
function hideSubtree(code, allRows, hierarchy) {
  const { childrenOf, rateChildrenOf } = hierarchy;

  (rateChildrenOf.get(code) || []).forEach(rc => {
    const el = allRows.find(r => r.dataset.code === rc);
    if (el) el.style.display = "none";
  });

  (childrenOf.get(code) || []).forEach(child => {
    const el = allRows.find(r => r.dataset.code === child);
    if (el) {
      el.style.display = "none";
      el.classList.add("collapsed");
      el.classList.remove("expanded");
    }
    hideSubtree(child, allRows, hierarchy);
  });
}

function showImmediateChildren(code, allRows, hierarchy) {
  const { childrenOf, rateChildrenOf } = hierarchy;

  (childrenOf.get(code) || []).forEach(child => {
    const el = allRows.find(r => r.dataset.code === child);
    if (el) el.style.display = "grid";
  });

  (rateChildrenOf.get(code) || []).forEach(rc => {
    const el = allRows.find(r => r.dataset.code === rc);
    if (el) {
      el.style.display = "grid";
      // Ensure newly shown rate rows get inputs + listeners
      enableEditingForRateRow(el, hierarchy);
    }
  });
}

/* ================= UI INIT ================= */
function initBoqUI(allRows, hierarchy) {
  const { depthOf } = hierarchy;

  for (const r of allRows) {
    const code = r.dataset.code;
    if (!code) continue;

    const codeCell = r.children[COL.CODE];
    const descCell = r.children[COL.DESC];
    if (!codeCell || !descCell) continue;

    // Indentation using CSS custom properties
    if (!isRate(code)) {
      const d = depthOf.get(code) || 0;
      descCell.style.setProperty("--indent-level", d);
      descCell.classList.add("boq-indent");
    } else {
      const base = stripRate(code);
      const pd = depthOf.get(base) || 0;
      descCell.style.setProperty("--indent-level", pd + 1);
      descCell.classList.add("boq-indent");
    }

    // Rebuild CODE cell
    const codeLabel = code;
    codeCell.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "flex items-center gap-2 select-none";

    if (!isRate(code) && hasChildren(code, hierarchy)) {
      const icon = document.createElement("span");
      icon.textContent = r.classList.contains("expanded") ? CONFIG.EXPAND_ICON : CONFIG.COLLAPSE_ICON;
      icon.className = "text-slate-500";
      wrap.appendChild(icon);

      codeCell.classList.add("cursor-pointer", "text-blue-700");

      codeCell.addEventListener("click", () => {
        const isExpanded = r.classList.contains("expanded");
        if (isExpanded) {
          r.classList.remove("expanded");
          r.classList.add("collapsed");
          icon.textContent = CONFIG.COLLAPSE_ICON;
          hideSubtree(code, allRows, hierarchy);
        } else {
          r.classList.add("expanded");
          r.classList.remove("collapsed");
          icon.textContent = CONFIG.EXPAND_ICON;
          showImmediateChildren(code, allRows, hierarchy);
        }
      });
    }

    const label = document.createElement("span");
    label.textContent = codeLabel;
    wrap.appendChild(label);
    codeCell.appendChild(wrap);

    // Apply presentation AFTER rebuild
    applyLevelPresentation(r, code, codeCell, descCell, hierarchy);
  }
}

/* ================= CSV LOAD (with better parsing) ================= */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  lines.shift(); // Remove header
  
  return lines
    .filter(l => l.trim().length > 0)
    .map(line => {
      // Handle quoted fields with commas
      const regex = /("([^"]*)"|[^,]+)/g;
      const values = [];
      let match;
      
      while ((match = regex.exec(line)) !== null) {
        // If matched group 2 exists, it's a quoted field
        values.push((match[2] !== undefined ? match[2] : match[1]).trim());
      }
      
      // Pad with empty strings if needed
      while (values.length < 8) values.push("");
      
      return {
        CODE: values[0],
        DESCRIPTION: values[1],
        QTY: values[2],
        UNIT: values[3],
        RATE: values[4],
        SUBTOTAL: values[5],
        MARKUP: values[6],
        TOTAL: values[7]
      };
    });
}

function clearBoq() {
  document.querySelectorAll(".boq-row").forEach(r => r.remove());
}

function renderFromCSV(data) {
  const container = document.getElementById("boqContainer");

  data.forEach(row => {
    const el = document.createElement("div");
    // Removed px-3 - now handled by CSS
    el.className = "boq-row boq-grid py-2";
    el.dataset.code = row.CODE;

    // Rate rows stay light blue
    if (isRate(row.CODE)) {
      el.classList.add("bg-sky-100", "mx-2", "my-1", "rounded-md");
    }

    el.innerHTML = `
      <div></div>
      <div>${row.DESCRIPTION || ""}</div>
      <div class="text-right">${row.QTY || ""}</div>
      <div class="text-right">${row.UNIT || ""}</div>
      <div class="text-right">${row.RATE || ""}</div>
      <div class="text-right">${row.SUBTOTAL || ""}</div>
      <div class="text-right">${row.MARKUP || ""}</div>
      <div class="text-right">${row.TOTAL || ""}</div>
    `;

    const subtotalCell = el.children[COL.SUBTOTAL];
    const markupCell = el.children[COL.MARKUP];
    const totalCell = el.children[COL.TOTAL];

    if (row.SUBTOTAL && subtotalCell) subtotalCell.dataset.uploaded = "1";
    if (row.MARKUP && markupCell) markupCell.dataset.uploaded = "1";
    if (row.TOTAL && totalCell) totalCell.dataset.uploaded = "1";

    container.appendChild(el);
  });
}

/* ================= RATE EDITING (INPUT FIELDS) ================= */
function enableEditingForRateRow(r, hierarchy) {
  const code = r.dataset.code;
  if (!code || !isRate(code)) return;

  const qtyCell = r.children[COL.QTY];
  const rateCell = r.children[COL.RATE];
  const factorCell = r.children[COL.MARKUP];
  if (!qtyCell || !rateCell || !factorCell) return;

  // Prevent double-binding / double-injection
  if (qtyCell.dataset.editEnabled === "1") return;

  qtyCell.dataset.editEnabled = "1";
  rateCell.dataset.editEnabled = "1";
  factorCell.dataset.editEnabled = "1";

  const overrides = loadOverrides();

  // Determine initial values (CSV first, then override)
  const initialQty =
    overrides[code] && overrides[code].qty !== undefined
      ? String(overrides[code].qty)
      : String(qtyCell.textContent || "");

  const initialRate =
    overrides[code] && overrides[code].rate !== undefined
      ? String(overrides[code].rate)
      : String(rateCell.textContent || "");

  const initialFactor =
    overrides[code] && overrides[code].factor !== undefined
      ? String(overrides[code].factor)
      : String(factorCell.textContent || "");

  // Inject inputs
  const qtyInput = makeNumericInput(initialQty);
  const rateInput = makeNumericInput(initialRate);
  const factorInput = makeNumericInput(initialFactor);

  qtyCell.textContent = "";
  rateCell.textContent = "";
  factorCell.textContent = "";
  qtyCell.appendChild(qtyInput);
  rateCell.appendChild(rateInput);
  factorCell.appendChild(factorInput);

  function persistAndRefresh() {
    const qTxt = normaliseEditableNumberText(qtyInput.value);
    const rTxt = normaliseEditableNumberText(rateInput.value);
    const fTxt = normaliseEditableNumberText(factorInput.value);

    qtyInput.value = qTxt;
    rateInput.value = rTxt;
    factorInput.value = fTxt;

    overrides[code] = {
      qty: qTxt === "" ? "" : parseNumber(qTxt),
      rate: rTxt === "" ? "" : parseNumber(rTxt),
      factor: fTxt === "" ? "" : parseNumber(fTxt)
    };
    saveOverrides(overrides);

    const allNow = rows();
    applyRowCalculations(allNow);
    recomputeAllRollups(allNow, hierarchy);
  }

  qtyInput.addEventListener("blur", persistAndRefresh);
  rateInput.addEventListener("blur", persistAndRefresh);
  factorInput.addEventListener("blur", persistAndRefresh);

  // Enter commits
  qtyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      qtyInput.blur();
    }
  });
  rateInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      rateInput.blur();
    }
  });
  factorInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      factorInput.blur();
    }
  });
}

/* ================= ENABLE EDITING FOR ALL RATES ================= */
function enableRateEditing(allRows, hierarchy) {
  for (const r of allRows) {
    enableEditingForRateRow(r, hierarchy);
  }
}

/* ================= STARTUP (Rails Turbo-safe with error handling) ================= */
async function bootBoq() {
  const container = document.getElementById("boqContainer");
  if (!container) return;

  // Prevent double init on the same DOM
  if (container.dataset.boqInit === "1") return;
  container.dataset.boqInit = "1";

  // Show loading state
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'p-8 text-center text-slate-600';
  loadingDiv.innerHTML = '<p>Loading BOQ data...</p>';
  container.appendChild(loadingDiv);

  try {
    const res = await fetch(CONFIG.AUTO_CSV_PATH, { cache: "no-store" });
    
    if (!res.ok) {
      throw new Error(`Failed to load CSV: ${res.status} ${res.statusText}`);
    }
    
    const text = await res.text();
    const data = parseCSV(text);

    // Remove loading
    loadingDiv.remove();

    clearBoq();
    renderFromCSV(data);

    const all = rows();
    const hierarchy = buildHierarchyIndex(all);

    // Initial visibility: show only root headings; hide all others
    for (const r of all) {
      const code = r.dataset.code;
      if (!code) continue;

      if (isRate(code)) {
        r.style.display = "none";
        continue;
      }

      const parent = hierarchy.parentOf.get(code);
      if (parent === null) {
        r.style.display = "grid";
        r.classList.add("collapsed");
        r.classList.remove("expanded");
      } else {
        r.style.display = "none";
        r.classList.add("collapsed");
        r.classList.remove("expanded");
      }
    }

    initBoqUI(all, hierarchy);

    // Enable editing (inputs) for all rate rows (even while hidden)
    enableRateEditing(all, hierarchy);

    // Calculate after overrides
    applyRowCalculations(all);

    // Rollups after calculations
    recomputeAllRollups(all, hierarchy);

  } catch (error) {
    console.error('BOQ load error:', error);
    loadingDiv.innerHTML = `
      <div class="text-red-600">
        <p class="font-bold">Failed to load BOQ data</p>
        <p class="text-sm">${error.message}</p>
        <p class="text-sm mt-2">Please ensure boq.csv is in the same directory as this HTML file.</p>
      </div>
    `;
  }
}

// Plain static + first load
document.addEventListener("DOMContentLoaded", bootBoq);

// Rails Turbo navigation
document.addEventListener("turbo:load", () => {
  // New DOM, allow init again
  const container = document.getElementById("boqContainer");
  if (container) delete container.dataset.boqInit;
  bootBoq();
});