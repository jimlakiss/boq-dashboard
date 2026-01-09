/*************************************************************
 * BOQ CSV (AUTO-LOAD) + HIERARCHY + COLLAPSE + ROLLUP ENGINE
 *
 * REQUIRED FIXES INCLUDED:
 * 1) Level styling that ACTUALLY shows:
 *    - Level 1 (root per trade): bold + underline + lighter grey text + subtle grey shading
 *    - Level 2+ headings (non-rates): bold
 *    - Rates: unchanged (light blue)
 *
 * 2) Rollups include:
 *    - Rate rows (.R#)
 *    - Non-rate LEAF rows that carry quantities (fixes "Trench Mesh" not rolling up)
 *
 * NO BOOTSTRAP (none used here)
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
// const AUTO_CSV_PATH = "boq.csv";
const AUTO_CSV_PATH = "/boq/boq.csv";

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

function isAttachedRate(parentCode, childCode) {
  return (
    isRate(childCode) &&
    tradePrefix(parentCode) === tradePrefix(childCode) &&
    stripRate(childCode) === stripRate(parentCode)
  );
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
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/* ============================================================
 * HIERARCHY INDEX (unchanged parent selection approach)
 * Parent = most specific PRIOR row that covers the child
 * Rates attach to their base code
 * ============================================================ */
function buildHierarchyIndex(allRows) {
  const nodes = allRows
    .map((r, idx) => ({ el: r, code: r.dataset.code, idx }))
    .filter(x => x.code && !isRate(x.code));

  const parentOf = new Map();        // code -> parentCode|null
  const childrenOf = new Map();      // code -> [child codes]
  const rateChildrenOf = new Map();  // code -> [rate codes]
  const depthOf = new Map();         // code -> UI depth (0 = Level 1 per trade)

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

  // Attach rate rows to base nodes
  for (const r of allRows) {
    const c = r.dataset.code;
    if (!c || !isRate(c)) continue;
    const base = stripRate(c);
    if (!rateChildrenOf.has(base)) rateChildrenOf.set(base, []);
    rateChildrenOf.get(base).push(c);
  }

  // Compute UI depth
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

/* ================= CHILD CHECK (used for leaf rollups) ================= */
function hasChildren(code, hierarchy) {
  if (!code || isRate(code)) return false;
  const { childrenOf, rateChildrenOf } = hierarchy;
  return (childrenOf.get(code)?.length || 0) > 0 || (rateChildrenOf.get(code)?.length || 0) > 0;
}

/* ============================================================
 * ROLLUPS (FIXED)
 * Include:
 * - Rate rows
 * - Non-rate LEAF rows with values (fixes "Trench Mesh" issue)
 * ============================================================ */
function recomputeAllRollups(allRows, hierarchy) {
  const nodes = allRows.filter(r => r.dataset.code && !isRate(r.dataset.code));

  for (const node of nodes) {
    const nCode = node.dataset.code;
    let qty = 0, subtotal = 0, total = 0;

    for (const r of allRows) {
      const rCode = r.dataset.code;
      if (!rCode) continue;

      const isRateRow = isRate(rCode);

      // Non-rate leaf items should roll up too
      const isLeafNonRate = !isRateRow && !hasChildren(rCode, hierarchy);

      if (!isRateRow && !isLeafNonRate) continue;

      const base = stripRate(rCode); // rates base to their parent; non-rates unchanged

      // Contributes if:
      // - the base equals this node, or
      // - the base is a descendant under this node
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

  // show only attached rates (direct)
  (rateChildrenOf.get(code) || []).forEach(rc => {
    const el = allRows.find(r => r.dataset.code === rc);
    if (el) el.style.display = "grid";
  });
}

/* ============================================================
 * PRESENTATION (GUARANTEED)
 * Apply styles AFTER the CODE cell is rebuilt.
 * ============================================================ */
function applyLevelPresentation(rowEl, code, codeCell, descCell, hierarchy) {
  // Reset (idempotent)
  rowEl.style.backgroundColor = "";
  if (codeCell) {
    codeCell.style.color = "";
    codeCell.style.fontWeight = "";
    codeCell.style.textDecoration = "";
  }
  if (descCell) {
    descCell.style.color = "";
    descCell.style.fontWeight = "";
    descCell.style.textDecoration = "";
  }

  // Rates: leave as-is (blue pill background already applied in renderFromCSV)
  if (isRate(code)) return;

  const depth = hierarchy.depthOf.get(code) || 0;

  if (depth === 0) {
    // Level 1: bold + underline + lighter grey + subtle shading
    rowEl.style.backgroundColor = "#f1f5f9"; // slate-100 (subtle shading)
    if (codeCell) {
      codeCell.style.color = "#64748b"; // slate-500
      codeCell.style.fontWeight = "700";
      codeCell.style.textDecoration = "underline";
    }
    if (descCell) {
      descCell.style.color = "#64748b";
      descCell.style.fontWeight = "700";
      descCell.style.textDecoration = "underline";
    }
  } else {
    // Level 2+: bold headings (non-rates)
    if (descCell) {
      descCell.style.fontWeight = "700";
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

    // Indentation (unchanged intent)
    if (!isRate(code)) {
      const d = depthOf.get(code) || 0;
      descCell.style.paddingLeft = `${d * INDENT_PX}px`;
    } else {
      const base = stripRate(code);
      const pd = depthOf.get(base) || 0;
      descCell.style.paddingLeft = `${(pd + 1) * INDENT_PX}px`;
    }

    // Rebuild CODE cell (existing behaviour)
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

    // ✅ APPLY PRESENTATION AFTER rebuild (THIS is what was missing)
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

/* ================= BOOTSTRAP (NO BOOTSTRAP USED) ================= */
document.addEventListener("DOMContentLoaded", async () => {
  const res = await fetch(AUTO_CSV_PATH, { cache: "no-store" });
  const text = await res.text();
  const data = parseCSV(text);

  clearBoq();
  renderFromCSV(data);

  const all = rows();
  const hierarchy = buildHierarchyIndex(all);

  // Initial visibility: show only root (parent null) non-rate rows; hide all others
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