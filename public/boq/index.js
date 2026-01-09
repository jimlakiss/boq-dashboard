/*************************************************************
 * BOQ CSV (AUTO-LOAD) + HIERARCHY + COLLAPSE + ROLLUP ENGINE
 *
 * THIS REVISION:
 * - Keeps previous working render/UI/CSS behaviour (no layout changes)
 * - Fixes rollups so parents sum:
 *    (a) rate rows (.R#)
 *    (b) non-rate rows that carry values (QTY/SUBTOTAL/TOTAL != 0),
 *        even if those rows have children (e.g. "Trench Mesh" case)
 *
 * NEW (CALCULATIONS):
 * - SUBTOTAL = QTY × RATE, ONLY if SUBTOTAL cell is blank (CSV prevails)
 * - TOTAL = SUBTOTAL × (1 + MARKUP%), ONLY if TOTAL cell is blank (CSV prevails)
 * - If MARKUP blank, TOTAL = SUBTOTAL (when TOTAL blank)
 *
 * No Bootstrap. Tailwind layout unchanged.
 *************************************************************/

/* ================= COLUMN MAP ================= */
const COL = {
  CODE: 0,
  DESC: 1,
  QTY: 2,
  UNIT: 3,
  RATE: 4,
  SUBTOTAL: 5,
  MARKUP: 6,
  TOTAL: 7
};

/* ================= CONFIG ================= */
const INDENT_PX = 20;           // ~3–5mm
const AUTO_CSV_PATH = "./boq.csv";

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

function cellHasUploadedValue(cellEl) {
  // IMPORTANT: use text presence, not numeric > 0
  // because "$0.00" or "0" are valid uploaded values.
  return !!cellEl && String(cellEl.textContent ?? "").trim().length > 0;
}

/* ============================================================
 * CALCULATIONS (NEW, DOES NOT OVERRIDE UPLOADED VALUES)
 *
 * Rules:
 * - If SUBTOTAL cell has any text -> keep it.
 *   Else if QTY and RATE are present -> SUBTOTAL = QTY × RATE
 *
 * - If TOTAL cell has any text -> keep it.
 *   Else if SUBTOTAL is available (uploaded or computed):
 *        If MARKUP cell has any text -> TOTAL = SUBTOTAL × (1 + %/100)
 *        Else TOTAL = SUBTOTAL
 * ============================================================ */
function applyRowCalculations(allRows) {
  for (const r of allRows) {
    if (!r || !r.children) continue;

    const qtyCell = r.children[COL.QTY];
    const rateCell = r.children[COL.RATE];
    const subtotalCell = r.children[COL.SUBTOTAL];
    const markupCell = r.children[COL.MARKUP];
    const totalCell = r.children[COL.TOTAL];

    if (!qtyCell || !rateCell || !subtotalCell || !markupCell || !totalCell) continue;

    // If subtotal uploaded, we preserve it.
    let subtotal = null;

    if (cellHasUploadedValue(subtotalCell)) {
      subtotal = parseMoney(subtotalCell.textContent);
    } else {
      const qty = parseNumber(qtyCell.textContent);
      const rate = parseMoney(rateCell.textContent);
      if (qty !== 0 && rate !== 0) {
        subtotal = qty * rate;
        subtotalCell.textContent = formatMoney(subtotal);
      }
    }

    // TOTAL: uploaded wins.
    if (cellHasUploadedValue(totalCell)) continue;

    if (subtotal !== null) {
      let total = subtotal;

      if (cellHasUploadedValue(markupCell)) {
        const pct = parsePercent(markupCell.textContent);
        if (pct !== null) total = subtotal * (1 + pct / 100);
      }

      totalCell.textContent = formatMoney(total);
    }
  }
}

/* ============================================================
 * HIERARCHY INDEX (unchanged)
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

  for (const n of nodes) {
    let bestParent = null;
    let bestSpec = -1;
    let bestIdx = -1;

    for (const p of nodes) {
      if (p.idx >= n.idx) break; // prior rows only
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
 * PRESENTATION (unchanged from working GH Pages version)
 * Applies AFTER CODE cell rebuild, uses !important to win.
 * Level 1: bold + underline + lighter grey + subtle shading
 * Level 2+: bold description
 * Rates: unchanged
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
 * ROLLUPS (FIXED, value-based contribution)
 * ============================================================ */
function rowHasValues(rowEl) {
  const qty = parseNumber(rowEl.children[COL.QTY]?.textContent);
  const sub = parseMoney(rowEl.children[COL.SUBTOTAL]?.textContent);
  const tot = parseMoney(rowEl.children[COL.TOTAL]?.textContent);
  return qty !== 0 || sub !== 0 || tot !== 0;
}

function recomputeAllRollups(allRows, hierarchy) {
  const nodes = allRows.filter(r => r.dataset.code && !isRate(r.dataset.code));

  for (const node of nodes) {
    const nCode = node.dataset.code;
    let subtotal = 0;
    let total = 0;

    const rateChildren = hierarchy.rateChildrenOf.get(nCode) || [];

    if (rateChildren.length > 0) {
      // 🔒 Sum ONLY direct child RATE rows
      for (const rateCode of rateChildren) {
        const r = allRows.find(row => row.dataset.code === rateCode);
        if (!r) continue;

        subtotal += parseMoney(r.children[COL.SUBTOTAL]?.textContent);
        total += parseMoney(r.children[COL.TOTAL]?.textContent);
      }
    } else {
      // 🔁 Fallback: sum descendant values (SUBTOTAL + TOTAL only)
      for (const r of allRows) {
        const rCode = r.dataset.code;
        if (!rCode) continue;

        const contributes = isRate(rCode) || rowHasValues(r);
        if (!contributes) continue;

        const base = stripRate(rCode);

        if (base === nCode || isDescendant(nCode, base)) {
          subtotal += parseMoney(r.children[COL.SUBTOTAL]?.textContent);
          total += parseMoney(r.children[COL.TOTAL]?.textContent);
        }
      }
    }

    // 🔒 Parent rows never show quantity
    node.children[COL.QTY].textContent = "";

    node.children[COL.SUBTOTAL].textContent = formatMoney(subtotal);
    node.children[COL.TOTAL].textContent = formatMoney(total);
  }
}

/* ================= VISIBILITY (unchanged) ================= */
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
    if (el) el.style.display = "grid";
  });
}

/* ================= UI INIT (unchanged) ================= */
function initBoqUI(allRows, hierarchy) {
  const { depthOf } = hierarchy;

  for (const r of allRows) {
    const code = r.dataset.code;
    if (!code) continue;

    const codeCell = r.children[COL.CODE];
    const descCell = r.children[COL.DESC];
    if (!codeCell || !descCell) continue;

    // Indentation
    if (!isRate(code)) {
      const d = depthOf.get(code) || 0;
      descCell.style.setProperty("padding-left", `${d * INDENT_PX}px`, "important");
    } else {
      const base = stripRate(code);
      const pd = depthOf.get(base) || 0;
      descCell.style.setProperty("padding-left", `${(pd + 1) * INDENT_PX}px`, "important");
    }

    // Rebuild CODE cell
    const codeLabel = code;
    codeCell.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "flex items-center gap-2 select-none";

    if (!isRate(code) && hasChildren(code, hierarchy)) {
      const icon = document.createElement("span");
      icon.textContent = r.classList.contains("expanded") ? "▾" : "▸";
      icon.className = "text-slate-500";
      wrap.appendChild(icon);

      codeCell.classList.add("cursor-pointer", "text-blue-700");

      codeCell.addEventListener("click", () => {
        const isExpanded = r.classList.contains("expanded");
        if (isExpanded) {
          r.classList.remove("expanded");
          r.classList.add("collapsed");
          icon.textContent = "▸";
          hideSubtree(code, allRows, hierarchy);
        } else {
          r.classList.add("expanded");
          r.classList.remove("collapsed");
          icon.textContent = "▾";
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

/* ================= CSV LOAD (unchanged) ================= */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  lines.shift(); // headers
  return lines
    .filter(l => l.trim().length > 0)
    .map(l => {
      const v = l.split(",");
      return {
        CODE: (v[0] ?? "").trim(),
        DESCRIPTION: (v[1] ?? "").trim(),
        QTY: (v[2] ?? "").trim(),
        UNIT: (v[3] ?? "").trim(),
        RATE: (v[4] ?? "").trim(),
        SUBTOTAL: (v[5] ?? "").trim(),
        MARKUP: (v[6] ?? "").trim(),
        TOTAL: (v[7] ?? "").trim()
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
    el.className = "boq-row boq-grid px-3 py-2";
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

    container.appendChild(el);
  });
}

/* ================= STARTUP (ONLY CHANGE: CALCS BEFORE ROLLUPS) ================= */
document.addEventListener("DOMContentLoaded", async () => {
  const res = await fetch(AUTO_CSV_PATH, { cache: "no-store" });
  const text = await res.text();
  const data = parseCSV(text);

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

  // ✅ NEW: fill SUBTOTAL/TOTAL only when those cells are blank
  applyRowCalculations(all);

  // ✅ Rollups run after calculations
  recomputeAllRollups(all, hierarchy);
});