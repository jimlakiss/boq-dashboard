/*************************************************************
 * BOQ CSV (AUTO-LOAD) + HIERARCHY + COLLAPSE + ROLLUP ENGINE
 *
 * REQUIRED FIXES:
 * 1) Heading emphasis MUST show (even if your CSS uses !important):
 *    - Level 1 (trade roots): bold + underline + lighter grey text + subtle grey row shading
 *    - Level 2+ headings (non-rate): bold
 *    - Rates: unchanged (light blue background)
 *
 * 2) Rollups MUST include:
 *    - Rate rows (.R#)
 *    - Non-rate TRUE LEAF rows carrying quantities (fixes "Trench mesh" style cases)
 *
 * NO BOOTSTRAP (none referenced/used)
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
const INDENT_PX = 14;           // ~3–5mm
const AUTO_CSV_PATH = "boq.csv";

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
  if (isRate(childCode)) return false;
  return covers(parentCode, childCode);
}

/* ================= DOM HELPERS ================= */
function rows() {
  return Array.from(document.querySelectorAll(".boq-row[data-code]"));
}

/* ================= NUMBER HELPERS ================= */
function parseNumber(v) {
  const n = parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parseMoney(v) {
  const n = parseFloat(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(n) {
  // If you prefer blank instead of $0.00, adjust here (not touched otherwise).
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/* ============================================================
 * HIERARCHY INDEX
 * Parent = most specific PRIOR row that covers the child
 * Rates attach to their base code.
 * ============================================================ */
function buildHierarchyIndex(allRows) {
  const nodes = allRows
    .map((r, idx) => ({ code: r.dataset.code, idx }))
    .filter(x => x.code && !isRate(x.code));

  const parentOf = new Map();        // code -> parentCode|null
  const childrenOf = new Map();      // code -> [child codes] (non-rate)
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
      if (p.idx >= n.idx) break; // prior only
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

  // attach rates
  for (const r of allRows) {
    const code = r.dataset.code;
    if (!code || !isRate(code)) continue;
    const base = stripRate(code);
    if (!rateChildrenOf.has(base)) rateChildrenOf.set(base, []);
    rateChildrenOf.get(base).push(code);
  }

  // compute depth by parent chain
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

/**
 * TRUE LEAF = no non-rate children AND no attached rates
 * (Only these non-rate rows should contribute upward directly.)
 */
function isTrueLeafNonRate(code, hierarchy) {
  if (!code || isRate(code)) return false;
  const { childrenOf, rateChildrenOf } = hierarchy;
  const hasNonRateKids = (childrenOf.get(code)?.length || 0) > 0;
  const hasRates = (rateChildrenOf.get(code)?.length || 0) > 0;
  return !hasNonRateKids && !hasRates;
}

/* ============================================================
 * ROLLUPS (FIXED)
 * Include:
 * - Rate rows always
 * - Non-rate TRUE LEAF rows that carry quantities
 * ============================================================ */
function recomputeAllRollups(allRows, hierarchy) {
  const nodes = allRows.filter(r => r.dataset.code && !isRate(r.dataset.code));

  for (const node of nodes) {
    const nCode = node.dataset.code;
    let qty = 0, subtotal = 0, total = 0;

    for (const r of allRows) {
      const rCode = r.dataset.code;
      if (!rCode) continue;

      const contribute =
        isRate(rCode) ||
        (isTrueLeafNonRate(rCode, hierarchy)); // <- key fix

      if (!contribute) continue;

      const base = stripRate(rCode); // for non-rate this is itself
      if (base === nCode || isDescendant(nCode, base)) {
        qty += parseNumber(r.children[COL.QTY]?.textContent || 0);
        subtotal += parseMoney(r.children[COL.SUBTOTAL]?.textContent || 0);
        total += parseMoney(r.children[COL.TOTAL]?.textContent || 0);
      }
    }

    node.children[COL.QTY].textContent = qty ? String(qty) : "";
    node.children[COL.SUBTOTAL].textContent = formatMoney(subtotal);
    node.children[COL.TOTAL].textContent = formatMoney(total);
  }
}

/* ================= VISIBILITY ================= */
function hideSubtree(code, allRows, hierarchy) {
  const { childrenOf, rateChildrenOf } = hierarchy;

  // hide attached rates
  (rateChildrenOf.get(code) || []).forEach(rc => {
    const el = allRows.find(r => r.dataset.code === rc);
    if (el) el.style.display = "none";
  });

  // hide children and recurse
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

  // show only immediate children
  (childrenOf.get(code) || []).forEach(child => {
    const el = allRows.find(r => r.dataset.code === child);
    if (el) el.style.display = "grid";
  });

  // show only rates directly attached to this node
  (rateChildrenOf.get(code) || []).forEach(rc => {
    const el = allRows.find(r => r.dataset.code === rc);
    if (el) el.style.display = "grid";
  });
}

/* ============================================================
 * PRESENTATION (GUARANTEED, even against external CSS !important)
 * Apply AFTER rebuilding CODE cell.
 *
 * Level 1: bold + underline + slate grey + subtle grey row shading
 * Level 2+: bold (desc only)
 * Rates: unchanged
 * ============================================================ */
function applyLevelPresentation(rowEl, code, codeCell, descCell, hierarchy) {
  // reset to avoid stacking
  rowEl.style.removeProperty("background-color");

  // Rates unchanged
  if (isRate(code)) return;

  const depth = hierarchy.depthOf.get(code) || 0;

  if (depth === 0) {
    // subtle row shading
    rowEl.style.setProperty("background-color", "#f1f5f9", "important"); // slate-100

    // CODE cell (and its label) - grey, bold, underline
    if (codeCell) {
      codeCell.style.setProperty("color", "#64748b", "important"); // slate-500
      codeCell.style.setProperty("font-weight", "700", "important");
      codeCell.style.setProperty("text-decoration", "underline", "important");

      // also force the inner label span (some CSS targets spans)
      const labelSpan = codeCell.querySelector("span:last-child");
      if (labelSpan) {
        labelSpan.style.setProperty("color", "#64748b", "important");
        labelSpan.style.setProperty("font-weight", "700", "important");
        labelSpan.style.setProperty("text-decoration", "underline", "important");
      }
    }

    // DESCRIPTION cell - same emphasis
    if (descCell) {
      descCell.style.setProperty("color", "#64748b", "important");
      descCell.style.setProperty("font-weight", "700", "important");
      descCell.style.setProperty("text-decoration", "underline", "important");
    }
  } else {
    // Level 2+ headings: bold description
    if (descCell) {
      descCell.style.setProperty("font-weight", "700", "important");
      descCell.style.removeProperty("text-decoration"); // leave default
    }
  }
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

    // indentation (unchanged intent)
    if (!isRate(code)) {
      const d = depthOf.get(code) || 0;
      descCell.style.setProperty("padding-left", `${d * INDENT_PX}px`, "important");
    } else {
      const base = stripRate(code);
      const pd = depthOf.get(base) || 0;
      descCell.style.setProperty("padding-left", `${(pd + 1) * INDENT_PX}px`, "important");
    }

    // rebuild CODE cell (existing behaviour)
    const codeLabel = code;
    codeCell.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "flex items-center gap-2 select-none";

    if (!isRate(code) && hasChildren(code, hierarchy)) {
      const icon = document.createElement("span");
      icon.textContent = r.classList.contains("expanded") ? "▾" : "▸";
      icon.className = "text-slate-500";
      wrap.appendChild(icon);

      // keep clickable styling
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

    // ✅ Apply presentation AFTER rebuild (and with !important)
    applyLevelPresentation(r, code, codeCell, descCell, hierarchy);
  }
}

/* ================= CSV LOAD ================= */
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

    // Rates stay light blue
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

/* ================= STARTUP ================= */
document.addEventListener("DOMContentLoaded", async () => {
  const res = await fetch(AUTO_CSV_PATH, { cache: "no-store" });
  const text = await res.text();
  const data = parseCSV(text);

  clearBoq();
  renderFromCSV(data);

  const all = rows();
  const hierarchy = buildHierarchyIndex(all);

  // initial visibility: show only root headings; hide all others
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
  recomputeAllRollups(all, hierarchy);
});