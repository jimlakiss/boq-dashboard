/*************************************************************
 * BOQ CSV (AUTO-LOAD) + HIERARCHY + COLLAPSE + ROLLUP ENGINE
 *
 * FIX (required):
 * - Build the visible tree by deriving PARENT relationships from codes,
 *   not from "depth math".
 * - Parent = most specific PRIOR row in same trade that "covers" child
 *   (all parent's non-zero slots match child's slots).
 *
 * Keeps:
 * - UI look/feel
 * - CSV format
 * - Rollup behaviour
 * - Progressive disclosure (open only 1 level down)
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
  // fixed-length numeric slots after trade prefix
  return stripRate(code).split(".").slice(2).map(n => parseInt(n, 10));
}

function nonZeroCount(code) {
  return numericSlots(code).reduce((acc, n) => acc + (n !== 0 ? 1 : 0), 0);
}

/**
 * "Covers" relationship:
 * parent covers child if for every slot:
 * - parent slot == 0 (wildcard) OR parent slot == child slot
 * And trade prefix must match.
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

/**
 * Descendant = any deeper node covered by parent AND not equal.
 * This is used for rollups and subtree hiding.
 */
function isDescendant(parentCode, childCode) {
  if (!parentCode || !childCode) return false;
  if (stripRate(parentCode) === stripRate(childCode)) return false; // not equal
  if (isRate(childCode)) return false; // rates handled separately for desc visibility
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
 * HIERARCHY INDEX (NEW, REQUIRED)
 * ------------------------------------------------------------
 * Build a parent/children index from the CSV order:
 * - For each non-rate row, its parent is the most specific prior row
 *   that covers it (same trade), by highest nonZeroCount.
 * - If none: parent = null (top of that trade)
 * - Rates: parent = base code (stripRate)
 * ============================================================ */
function buildHierarchyIndex(allRows) {
  const nodes = allRows
    .map((r, idx) => ({ el: r, code: r.dataset.code, idx }))
    .filter(x => x.code && !isRate(x.code));

  const parentOf = new Map();    // code -> parentCode|null
  const childrenOf = new Map();  // code -> array of child codes (non-rate)
  const rateChildrenOf = new Map(); // code -> array of rate codes
  const depthOf = new Map();     // code -> UI depth (0 for trade root)

  // Initialize containers
  for (const n of nodes) {
    childrenOf.set(n.code, []);
    rateChildrenOf.set(n.code, []);
  }

  // Compute parent for each node by scanning prior nodes
  for (const n of nodes) {
    let bestParent = null;
    let bestSpec = -1;
    let bestIdx = -1;

    for (const p of nodes) {
      if (p.idx >= n.idx) break; // only prior rows (nodes are in DOM order)
      if (tradePrefix(p.code) !== tradePrefix(n.code)) continue;
      if (!covers(p.code, n.code)) continue;

      const spec = nonZeroCount(p.code);
      if (spec > bestSpec || (spec === bestSpec && p.idx > bestIdx)) {
        bestParent = p.code;
        bestSpec = spec;
        bestIdx = p.idx;
      }
    }

    // If bestParent is itself (can happen if exact code repeats): null it
    if (bestParent === n.code) bestParent = null;

    parentOf.set(n.code, bestParent);

    if (bestParent && childrenOf.has(bestParent)) {
      childrenOf.get(bestParent).push(n.code);
    }
  }

  // Attach rate children
  const rateRows = allRows
    .map(r => r.dataset.code)
    .filter(code => code && isRate(code));

  for (const rc of rateRows) {
    const base = stripRate(rc);
    if (!rateChildrenOf.has(base)) rateChildrenOf.set(base, []);
    rateChildrenOf.get(base).push(rc);
  }

  // Compute depth (UI indent depth) from parent chain
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

/* ================= ROLLUPS (UNCHANGED INTENT) =================
 * Rollups apply to NON-RATE rows.
 * Sum all rates that are attached directly or appear under descendants
 * by coverage.
 */
function recomputeAllRollups(allRows) {
  const nodes = allRows.filter(r => !isRate(r.dataset.code));

  for (const node of nodes) {
    const nCode = node.dataset.code;
    let qty = 0, subtotal = 0, total = 0;

    for (const r of allRows) {
      const rCode = r.dataset.code;
      if (!isRate(rCode)) continue;

      // Rate contributes if:
      // - attached to this node OR
      // - attached to any descendant node covered by this node
      const base = stripRate(rCode);
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

/* ================= VISIBILITY (PROGRESSIVE DISCLOSURE) ================= */
function hideSubtree(code, allRows, hierarchy) {
  const { childrenOf, rateChildrenOf } = hierarchy;

  // Hide rate leaves
  const rates = rateChildrenOf.get(code) || [];
  for (const rc of rates) {
    const el = allRows.find(r => r.dataset.code === rc);
    if (el) el.style.display = "none";
  }

  // Hide child nodes and recurse
  const kids = childrenOf.get(code) || [];
  for (const kc of kids) {
    const el = allRows.find(r => r.dataset.code === kc);
    if (el) {
      el.style.display = "none";
      el.classList.add("collapsed");
      el.classList.remove("expanded");
    }
    hideSubtree(kc, allRows, hierarchy);
  }
}

function showImmediateChildren(code, allRows, hierarchy) {
  const { childrenOf, rateChildrenOf } = hierarchy;

  // Show only immediate children (one level down)
  const kids = childrenOf.get(code) || [];
  for (const kc of kids) {
    const el = allRows.find(r => r.dataset.code === kc);
    if (el) el.style.display = "grid";
  }

  // Show attached rates ONLY for this node (direct parent)
  const rates = rateChildrenOf.get(code) || [];
  for (const rc of rates) {
    const el = allRows.find(r => r.dataset.code === rc);
    if (el) el.style.display = "grid";
  }
}

function hasChildren(code, hierarchy) {
  const { childrenOf, rateChildrenOf } = hierarchy;
  return (childrenOf.get(code)?.length || 0) > 0 || (rateChildrenOf.get(code)?.length || 0) > 0;
}

/* ================= UI INIT ================= */
function initBoqUI(allRows, hierarchy) {
  const { depthOf } = hierarchy;

  for (const r of allRows) {
    const code = r.dataset.code;
    const codeCell = r.children[COL.CODE];
    const descCell = r.children[COL.DESC];
    if (!code || !codeCell || !descCell) continue;

    // Indentation (same feel; now driven by computed UI depth)
    if (!isRate(code)) {
      const d = depthOf.get(code) || 0;
      descCell.style.paddingLeft = `${d * INDENT_PX}px`;
    } else {
      // rate indent = parent depth + 1 step
      const base = stripRate(code);
      const pd = depthOf.get(base) || 0;
      descCell.style.paddingLeft = `${(pd + 1) * INDENT_PX}px`;
    }

    // Rebuild CODE cell with toggle (non-rate only)
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
          // Collapse: hide subtree + reset descendants to collapsed
          r.classList.remove("expanded");
          r.classList.add("collapsed");
          icon.textContent = "▸";
          hideSubtree(code, allRows, hierarchy);
        } else {
          // Expand: show only immediate children + attached rates
          r.classList.add("expanded");
          r.classList.remove("collapsed");
          icon.textContent = "▾";
          showImmediateChildren(code, allRows, hierarchy);
        }
      });
    } else {
      codeCell.classList.add("text-slate-700");
    }

    const label = document.createElement("span");
    label.textContent = code;
    wrap.appendChild(label);
    codeCell.appendChild(wrap);
  }
}

/* ================= CSV LOAD ================= */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  lines.shift(); // headers (locked)
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

/* ================= BOOTSTRAP ================= */
document.addEventListener("DOMContentLoaded", async () => {
  const res = await fetch(AUTO_CSV_PATH, { cache: "no-store" });
  const text = await res.text();
  const data = parseCSV(text);

  clearBoq();
  renderFromCSV(data);

  const all = rows();

  // Build hierarchy index (required for correct parenting + indent)
  const hierarchy = buildHierarchyIndex(all);

  // Initial visibility:
  // - show only top-level (parent null) non-rate rows
  // - hide everything else (including rates)
  for (const r of all) {
    const code = r.dataset.code;
    if (!code) continue;

    if (isRate(code)) {
      r.style.display = "none";
      continue;
    }

    const p = hierarchy.parentOf.get(code) || null;
    if (p === null) {
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
  recomputeAllRollups(all);
});