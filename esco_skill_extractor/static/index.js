/* ================== ESCO Skill Extractor Frontend ==================*/

/* ------------------ Helpers ------------------ */

let lastExtractedSkills = []; // last extracted results (optional)
let lastSearchResults = [];   // last DB search results (independent)
let reviewedSkills = {}; // { skillKey: "have" | "need" } for reviewed skills

function tailToTitle(s) {
  const last = (s || "").split("/").pop() || s || "";
  return last.replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function cleanSkillLabel(label, id = "") {
  const sqlUri = "http://data.europa.eu/esco/skill/598de5b0-5b58-4ea7-8058-a4bc4d18c742";
  const text = String(label || "");
  const skillId = String(id || "");

  if (
    text.includes(sqlUri) ||
    skillId.includes(sqlUri) ||
    (text.toLowerCase().includes("sql") && text.includes("dtype"))
  ) {
    return "SQL";
  }

  return text;
}

function normalizeItem(item) {
  if (typeof item === "string") {
    return {
      id: item,
      label: tailToTitle(item),
      score: null,
      green: false,
      digital: false,
      path: [],
      skillType: "",
    };
  }

  if (item && typeof item === "object") {
    const id = item.id || item.url || "";
    let label = item.label || item.name || tailToTitle(id);

    const sqlUri = "http://data.europa.eu/esco/skill/598de5b0-5b58-4ea7-8058-a4bc4d18c742";

    if (
      (typeof label === "string" && label.includes(sqlUri)) ||
      (typeof id === "string" && id.includes(sqlUri))
    ) {
      label = "SQL";
    }

    const score = typeof item.score === "number" ? item.score : null;
    const green = !!item.green;
    const digital = !!item.digital;
    const path = Array.isArray(item.path) ? item.path.filter(Boolean) : [];
    const skillType = item.skillType || "";
    const description = item.description || "";

    return { id, label, score, green, digital, path, skillType, description,similar: item.similar || [] };
  }
}

function unwrapResults(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}


/*------------------ Downloading (JSON, CSV, Excel) ------------------ */
function downloadJSON(data, filename = "skills.json") {
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();

  URL.revokeObjectURL(url);
}

function downloadCSV(items, filename = "skills.csv") {
  const header = ["label", "digital", "green", "id", "skillType", "path"];
  const rows = items.map((x) => [
    `"${String(x.label || "").replaceAll('"', '""')}"`,
    x.digital ? "true" : "false",
    x.green ? "true" : "false",
    `"${String(x.id || "").replaceAll('"', '""')}"`,
    `"${String(x.skillType || "").replaceAll('"', '""')}"`,
    `"${Array.isArray(x.path) ? x.path.join(" > ").replaceAll('"', '""') : ""}"`
  ]);

  const csv = [header.join(","), ...rows.map(r => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();

  URL.revokeObjectURL(url);
}

function downloadExcel(items, filename = "skills.xls") {
  const header = ["Label", "Digital", "Green", "ID", "Skill Type", "Path"];
  const rows = items.map((x) => [
    x.label || "",
    x.digital ? "true" : "false",
    x.green ? "true" : "false",
    x.id || "",
    x.skillType || "",
    Array.isArray(x.path) ? x.path.join(" > ") : ""
  ]);

  const tableHtml = `
    <table>
      <tr>${header.map(h => `<th>${h}</th>`).join("")}</tr>
      ${rows.map(row => `<tr>${row.map(cell => `<td>${String(cell)}</td>`).join("")}</tr>`).join("")}
    </table>
  `;

  const blob = new Blob([tableHtml], { type: "application/vnd.ms-excel" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();

  URL.revokeObjectURL(url);
}

/* ------------------ Skills Review + Transfer ------------------ */

function getSkillKey(item) {
  return item.id || item.label;
}
function clearReviewedSkill(item) {
  const key = getSkillKey(item);
  delete reviewedSkills[key];
  renderSkillsResult(lastExtractedSkills, { title: "Extracted skills" });
}
function setReviewedSkill(item, value) {
  const key = getSkillKey(item);
  if (!key) return;

  // second click on the same button removes selection
  if (reviewedSkills[key] === value) {
    delete reviewedSkills[key];
  } else {
    reviewedSkills[key] = value; 
  }

  renderSkillsResult(lastExtractedSkills, { title: "Extracted skills" });
  const { have, need } = getReviewedLists();
  sessionStorage.setItem("sgaSkillPayload", JSON.stringify({ have, need }));
}

function getReviewedLists() {
  const have = [];
  const need = [];

  for (const item of lastExtractedSkills.map(normalizeItem)) {
    const key = getSkillKey(item);
    const status = reviewedSkills[key];

    if (status === "have") have.push(item.label);
    if (status === "need") need.push(item.label);
  }

  return { have, need };
}

function transferReviewedSkillsToGap() {
  const { have, need } = getReviewedLists();

  // Save whatever we have (even if empty) 
  sessionStorage.setItem("sgaSkillPayload", JSON.stringify({ have, need }));

  const gapBtn = document.querySelector('.entity-btn[data-entity="skill_gap_analysis"]');
  if (gapBtn) {
    const haveField = document.getElementById("skills-have");
    const needField = document.getElementById("skills-need");
    if (haveField) haveField.value = have.join(", ");
    if (needField) needField.value = need.join(", ");
    gapBtn.click();
    return;
  }

  window.location.href = "/sga";
}

/* ------------------ Skill Display Formatting ------------------ */

function getContextFromPath(item) {
  const path = Array.isArray(item.path) ? item.path.filter(Boolean) : [];
  if (!path.length) return "";
  if (path.length >= 2) return path[path.length - 2];
  return "";
}

function renderBadges(item) {
  return `
    ${item.digital ? `<span class="badge badge-digital">DIGITAL SKILL</span>` : ""}
    ${item.green ? `<span class="badge badge-green">GREEN SKILL</span>` : ""}
  `;
}

/* ------------------ Tree Building ------------------ */

function buildTree(items) {
  const root = { name: "__root__", children: new Map(), skills: [] };

  for (const it of items) {
    const path = Array.isArray(it.path) ? it.path.filter(Boolean) : [];
    let node = root;

    for (const p of path) {
      if (!node.children.has(p)) {
        node.children.set(p, { name: p, children: new Map(), skills: [] });
      }
      node = node.children.get(p);
    }
    node.skills.push(it);
  }

  return root;
}

function renderTree(node, depth = 0) {
  const children = Array.from(node.children.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((child) => {
      const inner = renderTree(child, depth + 1);
      return `
        <li class="tree-node">
          <details class="tree-details" >
            <summary class="tree-label">
              <span class="tree-level">Level ${depth}</span>
              <span class="tree-name">${escapeHtml(child.name)}</span>
            </summary>
            <ul class="tree-children">
              ${inner}
            </ul>
          </details>
        </li>
      `;
    })
    .join("");

  const skills = (node.skills || [])
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((x) => {
      const href = x.id || "#";
      const pct =
        x.score !== null && typeof x.score === "number"
          ? `<span class="skill-score">${(x.score * 100).toFixed(1)}%</span>`
          : "";

      return `
        <li class="skill-item">
          <div class="skill-left">
            <a class="skill-tag" href="${href}" target="_blank" rel="noopener noreferrer">
              ${escapeHtml(x.label)}
            </a>
            ${pct}
          </div>
          <div class="skill-right">${renderBadges(x)}</div>
        </li>
      `;
    })
    .join("");

  return `${children}${skills}`;
}

/* ------------------ Clipboard ------------------ */

async function copyToClipboard(text) {
  try {
    const button = document.getElementById("copyButton");
    await navigator.clipboard.writeText(text);
    if (button) {
      button.textContent = "Copied!";
      setTimeout(() => (button.textContent = "Copy CSV"), 1000);
    }
  } catch (e) {
    console.error("Failed to copy:", e);
  }
}

/* ------------------ Controls ------------------ */

async function loadSkillTypesIntoSelect() {
  const sel = document.getElementById("skill-type");
  if (!sel) return;

  try {
    const resp = await fetch(`${window.SERVER}/skill-types`);
    if (!resp.ok) return;
    const types = await resp.json(); 

    sel.innerHTML = (types || [])
      .map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`)
      .join("");
  } catch (e) {
    console.warn("Failed to load skill types:", e);
  }
}

function readSearchControls() {
  const query = document.getElementById("skill-search")?.value || "";
  const skillType = document.getElementById("skill-type")?.value || "ALL";

  const tags = [];
  if (document.getElementById("tag-digital")?.checked) tags.push("DIGITAL");
  if (document.getElementById("tag-green")?.checked) tags.push("GREEN");

  return { query, skillType, tags };
}

function clearSearchControls() {
  const s = document.getElementById("skill-search");
  const t = document.getElementById("skill-type");
  const d = document.getElementById("tag-digital");
  const g = document.getElementById("tag-green");
  if (s) s.value = "";
  if (t) t.value = "ALL";
  if (d) d.checked = false;
  if (g) g.checked = false;
}

function selectSkill(label) {
  addSkillToField(label, 'skills-have');

  const dropdown = document.getElementById("search-dropdown");
  if (dropdown) dropdown.innerHTML = "";
}

/* ------------------ Independent Search (DB) ------------------ */
/**
 * Requires backend endpoint:
 * POST /search-skills  {query, skillType, tags, limit}
 */
async function runIndependentSearch() {
  const query     = (document.getElementById('skill-search')?.value || '').trim();
  const skillType = document.getElementById('skill-type')?.value || 'ALL';
  const tags      = [];
  if (document.getElementById('tag-digital')?.checked) tags.push('DIGITAL');
  if (document.getElementById('tag-green')?.checked)   tags.push('GREEN');

  const dd = document.getElementById('search-dropdown');
  if (!query) { if (dd) dd.innerHTML = ''; return; }

  try {
    const resp = await fetch(`${window.SERVER}/search-skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, skillType, tags, limit: 30 }),
    });
    if (!resp.ok) return;
    const results = await resp.json();

    if (dd) {
      if (!results.length) { dd.innerHTML = '<div class="sga-dd-empty">No results</div>'; return; }

      const isSkillsPage = !!document.getElementById('text');

      if (isSkillsPage) {
        // Skills page: plain clickable rows, no buttons
        dd.innerHTML = results.map(s => `
          <div class="search-result-item"
               onclick="addSkillToTextarea('${escapeHtml(s.label)}'); document.getElementById('search-dropdown').innerHTML='';">
            ${escapeHtml(s.label)}
          </div>
        `).join('');
      } else {
        // SGA page: I Know / I Need buttons
        dd.innerHTML = results.map(s => `
          <div class="sga-dd-item">
            <span class="sga-dd-label">${escapeHtml(s.label)}</span>
              <button type="button" class="sga-dd-btn sga-btn-have"
                onclick="window.addSkillToField('${escapeHtml(s.label)}', 'skills-have')">
                ✓ I Know
              </button>
              <button type="button" class="sga-dd-btn sga-btn-need"
                onclick="window.addSkillToField('${escapeHtml(s.label)}', 'skills-need')">
                − I Need
              </button>
            </div>
          </div>
        `).join('');
      }
    }
  } catch(e) { console.error(e); }
}


/* ------------------ Optional: Filter Extracted (kept) ------------------ */
/**
 * It uses /filter-skills and needs lastExtractedSkills not empty.
 */
async function filterExtractedAndRender() {
  if (!lastExtractedSkills.length) {
    alert("Extract skills first, then filter extracted results.");
    return;
  }

  const { query, skillType, tags } = readSearchControls();

  const resp = await fetch(`${window.SERVER}/filter-skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      extracted: lastExtractedSkills,
      query,
      skillType,
      tags,
    }),
  });

  if (!resp.ok) {
    console.error("filter-skills failed:", resp.status);
    return;
  }

  const filtered = await resp.json();
  renderSkillsResult(filtered, { title: "Filtered extracted skills", keepControls: true });
}



/* ------------------ Rendering ------------------ */

function renderSkillSummary(items) {
  const normalized = (items || []).map(normalizeItem);

  const total = normalized.length;
  const digital = normalized.filter(x => x.digital).length;
  const green = normalized.filter(x => x.green).length;
  const other = total - digital - green;

  return `
    <div class="kpi-grid skill-summary-grid">
      <div class="kpi-card">
        <span class="kpi-value">${total}</span>
        <span class="kpi-label">Total Skills</span>
      </div>

      <div class="kpi-card">
        <span class="kpi-value">${digital}</span>
        <span class="kpi-label">Digital</span>
      </div>

      <div class="kpi-card">
        <span class="kpi-value">${green}</span>
        <span class="kpi-label">Green</span>
      </div>

      <div class="kpi-card highlight">
        <span class="kpi-value">${other}</span>
        <span class="kpi-label">Other</span>
      </div>
    </div>
  `;
}

function toggleReviewDropdown(button) {
  const dropdown = button.closest(".review-dropdown");
  const isOpen = dropdown.classList.contains("open");

  document.querySelectorAll(".review-dropdown.open").forEach((el) => {
    el.classList.remove("open");
  });

  if (!isOpen) {
    dropdown.classList.add("open");
  }
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".review-dropdown")) {
    document.querySelectorAll(".review-dropdown.open").forEach((el) => {
      el.classList.remove("open");
    });
  }
});

function renderSkillsResult(rawItems, { title = "Extracted skills", keepControls = false } = {}) {

  const listContainer = document.getElementById("skills-list");
  const detailsContainer = document.getElementById("skill-details");
  const items = (rawItems || []).flat().map(normalizeItem).filter((x) => x.label);

  const sortedItems = items
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label));
 

  if (!items.length) {
      if (listContainer) listContainer.innerHTML = `<p>No results.</p>`;
      if (detailsContainer) detailsContainer.innerHTML = `Select a skill to see details`;
      return;
    }

  // CSV
  const csv = items
    .map((x) => {
      const p = Array.isArray(x.path) && x.path.length ? x.path.join(" > ") + " > " : "";
      return `${p}${x.label}`;
    })
    .join("\n");

  const hasAnyPath = items.some((x) => Array.isArray(x.path) && x.path.length);

 // ===== Build LEFT list (skills) =====
    const summaryHtml = sortedItems.map((x, index) => {
    const key = getSkillKey(x);
    const status = reviewedSkills[key] || "";

    return `
      <li class="summary-item skill-review-row" onclick="showSkillDetails(${index})">
        
        <div class="skill-main">
          <a class="skill-tag" href="${escapeHtml(x.id || '#')}" target="_blank" rel="noopener noreferrer">
            ${escapeHtml(x.label)}
          </a>

        </div>

        <div class="skill-actions">
        <div class="action-badges">
              ${renderBadges(x)}
            </div>


          <div class="review-dropdown">
            <button
              type="button"
              class="review-select-btn ${status === 'have' ? 'review-have' : status === 'need' ? 'review-need' : 'review-neutral'}"
              onclick="event.stopPropagation(); toggleReviewDropdown(this)"
            >
              <span class="review-left-icon">
                ${status === 'have' ? '✓' : status === 'need' ? '−' : '?'}
              </span>
              <span class="review-label">
                ${status === 'have' ? 'I know' : status === 'need' ? "I don't know" : 'Select if you know this skill'}
              </span>
              <span class="review-arrow">▾</span>
            </button>

            <div class="review-options">
              <button type="button" class="review-option review-option-have"
                onclick='event.stopPropagation(); setReviewedSkill(${JSON.stringify(x)}, "have")'>
                ✓ I know
              </button>
              <button type="button" class="review-option review-option-need"
                onclick='event.stopPropagation(); setReviewedSkill(${JSON.stringify(x)}, "need")'>
                − I don't know
              </button>
              ${status ? `<button type="button" class="review-option review-option-clear"
                onclick='event.stopPropagation(); clearReviewedSkill(${JSON.stringify(x)})'>
                ✕ Clear
              </button>` : ''}
            </div>
          </div>
        </div>

      </li>
    `;
  })
  .join("");


// ===== Render FULL layout =====
const summaryContainer = document.getElementById("skills-summary");

if (summaryContainer) {
  summaryContainer.innerHTML = renderSkillSummary(sortedItems);
}
// LEFT SIDE (skills list)
if (listContainer) {
  listContainer.innerHTML = `
    <div class="sga-results-header">
      <span class="results-title">Extracted Skills:</span>
      <div class="sga-toolbar">

        <button class="sga-toolbar-btn" onclick="openSaveModal('skills', window._lastExtractedForSave, 'Extracted skills — ' + new Date().toLocaleDateString())">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H7a2 2 0 0 0-2 2v14l7-3 7 3V5a2 2 0 0 0-2-2z"/></svg>
          Save into your profile
        </button>

        <div class="sga-toolbar-divider"></div>

        <button class="sga-toolbar-btn" id="skills-copy-btn" onclick="
          navigator.clipboard.writeText(lastExtractedSkills.map(s => s.label).join(',') || '').then(() => {
            const el = document.getElementById('skills-copy-title');
            if (el) { el.textContent = 'Copied!'; setTimeout(() => el.textContent = 'Copy CSV', 1500); }
          })">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>
          <span id="skills-copy-title">Copy CSV</span>
        </button>

        <div class="sga-toolbar-divider"></div>

        <div class="sga-toolbar-btn sga-toolbar-download" id="skills-dl-wrap">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 16l-5-5h3V4h4v7h3l-5 5zm-7 2h14v2H5v-2z"/></svg>
          Download results
          <svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px;"><path d="M7 10l5 5 5-5z"/></svg>
          <div class="sga-toolbar-dropdown">
            <button onclick="event.stopPropagation(); downloadJSON(lastExtractedSkills,'skills.json')">JSON</button>
            <button onclick="event.stopPropagation(); downloadCSV(lastExtractedSkills,'skills.csv')">CSV</button>
            <button onclick="event.stopPropagation(); downloadExcel(lastExtractedSkills,'skills.xls')">Excel</button>
          </div>
        </div>

      </div>
    </div>
    <ul class="summary-list">
      ${summaryHtml}
    </ul>

  
  `;


  setTimeout(() => {
  const dlBtn = document.getElementById('skills-dl-wrap');
  if (dlBtn) {
    dlBtn.addEventListener('click', () => dlBtn.classList.toggle('open'));
    document.addEventListener('click', e => {
      if (!e.target.closest('#skills-dl-wrap')) dlBtn.classList.remove('open');
    });
  }
}, 0);
}

// RIGHT SIDE (default message)
if (detailsContainer) {
  detailsContainer.innerHTML = `
  <h3 class="results-title">Skill Details:</h3>
    Select a skill to see details
  `;
}


// ===== Store data globally for click =====
lastExtractedSkills = sortedItems;


// ===== Show FIRST skill by default =====
if (items.length) {
  showSkillDetails(0);
}
window._lastExtractedForSave = sortedItems;
}

function copySkillsCSV() {
  const text = lastExtractedSkills.map(x => x.label).join("\n");
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById("copy-csv-btn");
    if (btn) { btn.textContent = "✓ Copied!"; setTimeout(() => btn.textContent = "📋 Copy CSV", 1500); }
  });
}

function toggleDownloadMenu(btn) {
  const menu = btn.nextElementSibling;
  const isOpen = menu.style.display === "flex";
  // close all open menus first
  document.querySelectorAll(".download-menu").forEach(m => m.style.display = "none");
  menu.style.display = isOpen ? "none" : "flex";
}

// close on outside click — add inside existing DOMContentLoaded or alongside the other document.addEventListener("click") blocks
document.addEventListener("click", e => {
  if (!e.target.closest(".download-dropdown-wrap")) {
    document.querySelectorAll(".download-menu").forEach(m => m.style.display = "none");
  }
});

function renderSaveSkillsButton(skills) {
  let container = document.getElementById('save-skills-btn-wrap');
  if (!container) {
    container = document.createElement('div');
    container.id = 'save-skills-btn-wrap';
    container.style.marginTop = '8px';
    const summary = document.getElementById('skills-summary');
    if (summary) summary.after(container);
  }

  if (!skills || !skills.length) { container.innerHTML = ''; return; }

  // Store data on window instead of inline JSON to avoid quote issues
  window._lastExtractedForSave = skills;

  container.innerHTML = `
    <button class="action-btn" onclick="openSaveModal('skills', window._lastExtractedForSave, 'Extracted skills — ' + new Date().toLocaleDateString())">
      🔖 Save to Profile
    </button>
  `;
}

function addSkillField(value = "") {
  const container = document.getElementById("manual-skills-container");

  const row = document.createElement("div");
  row.className = "skill-input-row";

  row.innerHTML = `
    <input type="text" class="skill-input" value="${value}" placeholder="Enter skill..." />
    <button type="button" class="remove-skill-btn">✕</button>
  `;

  row.querySelector(".remove-skill-btn").onclick = () => row.remove();

  container.appendChild(row);
}
/* ------------------Digital skills or Green skills details (right side)------------------ */

function showSkillDetails(index) {
  const container = document.getElementById("skill-details");
  const item = lastExtractedSkills[index];


  if (!item || !container) return;

  container.innerHTML = `
   <h3 class="results-title">Skill Details:</h3>
    <h2>${escapeHtml(item.label)}</h2>

    ${
        item.description
          ? `<p style="margin-top:10px; color:#444;"><strong>Description:</strong><br>${escapeHtml(item.description)}</p>`
          : `<p style="margin-top:10px; color:#666;"><strong>Description:</strong><br>No description available.</p>`
      }



    ${
      item.path?.length 
        ? `
        <div class="hierarchy-box">

          <div class="hierarchy-header">
            <i class="fas fa-sitemap hierarchy-icon"></i>
            <div>
              <div class="hierarchy-title">Skill Hierarchy</div>
              <div class="hierarchy-subtitle">ESCO classification</div>
            </div>
          </div>

          <div class="hierarchy-tree">
            ${item.path.map((level, i) => `
              
              <div class="hierarchy-level level-${i}">
                
                ${
                  i < item.path.length - 1
                    ? `<span class="arrow" onclick="toggleLevel(${i})">▸</span>`
                    : `<span class="arrow-placeholder"></span>`
                }

                <span class="hierarchy-pill">
                  <span class="level-badge">Level ${i}:</span>
                  <span class="level-text">${level}</span>
                </span>

              </div>

            `).join("")}
          </div>

        </div>
        `
        : ""
    }

      ${
          (item.similar && item.similar.length)
            ? `
            <div class="similar-box">
              
              <div class="similar-title">Similar skills:</div>

              <div class="similar-skills">
                ${item.similar.map(s => `
                  <a 
                    href="${s.id}" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    class="similar-pill-link"
                  >
                    ${escapeHtml(s.label)}
                  </a>
                `).join("")}
              </div>

            </div>
            `
            : ""
        }

         
          <div class="skills-next-actions">

          <div class="skills-next-card">  
            <div class="skills-next-icon">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9 7V6a3 3 0 0 1 6 0v1h1.5A2.5 2.5 0 0 1 19 9.5v5A2.5 2.5 0 0 1 16.5 17h-9A2.5 2.5 0 0 1 5 14.5v-5A2.5 2.5 0 0 1 7.5 7H9Z" fill="currentColor" opacity="0.18"/>
                <path d="M9 7V6a3 3 0 0 1 6 0v1M7.5 7h9A2.5 2.5 0 0 1 19 9.5v5A2.5 2.5 0 0 1 16.5 17h-9A2.5 2.5 0 0 1 5 14.5v-5A2.5 2.5 0 0 1 7.5 7Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M12 11.25v1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
              </svg>
            </div>

            <div class="skills-next-content">
              <div class="skills-next-title">Explore opportunities</div>
              <div class="skills-next-text">
                Find jobs that match this skill
              </div>

              <button
                type="button"
                class="skills-next-btn"
                onclick='transferReviewedSkillsToOccupations(${JSON.stringify(item)})'
              >
                See occupations
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M4.167 10h11.666" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
                  <path d="M10.833 5 15.833 10l-5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
          </div>

          <div class="skills-next-divider" aria-hidden="true"></div>

          <div class="skills-next-card">
            <div class="skills-next-icon">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M5 16.5 9 12.5l3 3 6-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M16 8.5h2v2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M4.5 19h15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.45"/>
              </svg>
            </div>

            <div class="skills-next-content">
              <div class="skills-next-title">Next step</div>
              <div class="skills-next-text">
                Compare your skills with a target job’s requirements to see what’s missing
              </div>

              <button
                type="button"
                class="skills-next-btn"
                onclick="transferReviewedSkillsToGap()"
              >
                Analyze skill gap
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M4.167 10h11.666" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
                  <path d="M10.833 5 15.833 10l-5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
          </div>

        </div>

        



      
    `;

    document.querySelectorAll(".hierarchy-level").forEach((el, i) => {
    if (i !== 0) el.style.display = "none";
  });
}

function transferReviewedSkillsToOccupations(selectedSkill = null) {
  const { have, need } = getReviewedLists();

  const payload = {
    selectedSkill,
    have,
    need,
    reviewedSkills,
    allExtracted: lastExtractedSkills,
  };

  sessionStorage.setItem("occupationsSkillPayload", JSON.stringify(payload));

  window.location.href = "/occupations";
}

function toggleLevel(index) {
  
  const levels = document.querySelectorAll(".hierarchy-level");

  const arrow = levels[index].querySelector(".arrow");
  const isOpen = arrow.textContent === "▾";

  if (isOpen) {
    for (let i = index + 1; i < levels.length; i++) {
      levels[i].style.display = "none";

      const a = levels[i].querySelector(".arrow");
      if (a) a.textContent = "▸";
    }

    arrow.textContent = "▸";

  } else {
    if (levels[index + 1]) {
      levels[index + 1].style.display = "flex";
    }

    arrow.textContent = "▾";
  }
}


/* ------------------ Tab Switching ------------------ */

function setupEntityButtons() {
  const buttons = document.querySelectorAll(".entity-btn");

  const textarea = document.getElementById("text");
  const gapInputs = document.getElementById("gap-analysis-inputs");
  const submitButton = document.getElementById("submit-button");
  const output = document.getElementById("output");
  const searchPanel = document.getElementById("search-panel");
  const skillsUploadBox = document.getElementById("skills-upload-box");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });

      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");

      const selected = btn.dataset.entity;

      textarea.style.display = "none";
      gapInputs.style.display = "none";
      submitButton.style.display = "none";
      if (searchPanel) searchPanel.style.display = "none";
      if (skillsUploadBox) skillsUploadBox.style.display = "none";

      if (selected === "skill_gap_analysis") {
        gapInputs.style.display = "block";
        submitButton.style.display = "block";
        submitButton.textContent = "Analyze Skill Gap";
        output.textContent = "Skill gap analysis results will appear here";
        return;
      }

      if (selected === "search") {
        if (searchPanel) searchPanel.style.display = "block";
        output.textContent = "Search results will appear here";
        return;
      }

      if (selected === "skills") {
        textarea.style.display = "block";
        submitButton.style.display = "block";
        if (skillsUploadBox) skillsUploadBox.style.display = "flex";
        textarea.placeholder = "Paste your text here to extract skills.";
        submitButton.textContent = "Extract Skills";
        output.textContent = "Extracted skills will appear here";
        return;
      }

      if (selected === "occupations") {
        textarea.style.display = "block";
        submitButton.style.display = "block";
        textarea.placeholder = "Paste your text here to extract occupations.";
        submitButton.textContent = "Extract occupations";
        output.textContent = "Extracted occupations will appear here";
      }
    });
  });
}


/* ------------------ Independent Search (DB) ------------------ */
async function uploadCvAndExtractSkills() {
  const fileInput = document.getElementById("cv-file");
  const output = document.getElementById("output");
  const haveField = document.getElementById("skills-have");

  if (!fileInput || !fileInput.files || !fileInput.files[0]) {
    alert("Please choose a CV file first.");
    return;
  }

  const formData = new FormData();
  formData.append("file", fileInput.files[0]);

  if (output) output.innerHTML = "<p>Uploading CV and extracting skills...</p>";

  try {
    const resp = await fetch(`${window.SERVER}/extract-skills-from-file`, {
      method: "POST",
      body: formData,
    });

    const data = await resp.json();

    if (!resp.ok) {
      output.innerHTML = `<pre style="color:red;">${escapeHtml(data.error || "Upload failed")}</pre>`;
      return;
    }

    const skills = Array.isArray(data.skills) ? data.skills.map(normalizeItem) : [];
    const labels = [...new Set(
  skills
    .map((s) => (s.label || "").trim())
    .filter((label) =>
      label &&
      !label.toLowerCase().startsWith("id http") &&
      !label.toLowerCase().startsWith("name:") &&
      !label.includes("http://") &&
      !label.includes("https://") &&
      label.length < 80
    )
)];

    if (haveField) {
      haveField.value = labels.join(", ");
    }

    if (output) {
      output.innerHTML = `
        <div class="result-box">
          <p class="output-title">Extracted skills from CV</p>
          <ul class="summary-list">
            ${skills
              .map(
                (x) => `
              <li class="summary-item">
                <span class="skill-tag">${escapeHtml(x.label)}</span>

              </li>
            `
              )
              .join("")}
          </ul>
        </div>
      `;
    }
  } catch (e) {
    console.error(e);
    if (output) output.innerHTML = "<p>Failed to upload file.</p>";
  }
}

/* ------------------ Upload + Extract Skills from File (general, can be used for CV or any text file) ------------------ */
async function uploadFileAndExtractSkillsToSkillsTab() {
  console.log("uploadFileAndExtractSkillsToSkillsTab CALLED");
  const fileInput = document.getElementById("skills-file");
  const output = document.getElementById("output");
  const textField = document.getElementById("text");

  if (!fileInput || !fileInput.files || !fileInput.files[0]) {
    alert("Please choose a file first.");
    return;
  }

  const formData = new FormData();
  formData.append("file", fileInput.files[0]);

  if (output) output.innerHTML = "<p>Uploading file and extracting skills...</p>";

  try {
    const resp = await fetch(`${window.SERVER}/extract-skills-from-file`, {
      method: "POST",
      body: formData,
    });
    console.log("UPLOAD RESPONSE STATUS:", resp.status);
    const data = await resp.json();

    if (!resp.ok) {
      output.innerHTML = `<pre style="color:red; white-space:pre-wrap;">${escapeHtml(data.error || "Upload failed")}</pre>`;
      return;
    }

    const skills = Array.isArray(data.skills) ? data.skills.map(normalizeItem) : [];
    lastExtractedSkills = skills;

    if (textField && data.text) {
      textField.value = data.text;
    }

    renderSkillsResult(skills, { title: "Extracted skills from file" });
  } catch (e) {
    console.error(e);
    if (output) output.innerHTML = "<p>Failed to upload and extract skills.</p>";
  }
}


function getManualSkills() {
  const inputs = document.querySelectorAll(".skill-input");
  
  return Array.from(inputs)
    .map(input => input.value.trim())
    .filter(Boolean);
}

function syncManualToTextarea() {
  const textarea = document.getElementById("text");
  const manualSkills = getManualSkills();

  if (!textarea.value.trim()) {
    textarea.value = manualSkills.join(", ");
  }
}

/* ------------------ Submit Handler ------------------ */

async function extractEntity(event) {
  console.log("🚀 BUTTON CLICKED");
  if (event) event.preventDefault();

  const activeBtn = document.querySelector(".entity-btn.active");
  const entity = activeBtn ? activeBtn.dataset.entity : "skills";
  const output = document.getElementById("output");
  const submitBtn = document.getElementById("submit-button");

  if (entity === "search") {
  // Search tab should not submit extraction
  submitBtn.disabled = false;
  return;
}

  try {
    /* ---------- Skill Gap Analysis ---------- */
    if (entity === "skill_gap_analysis") {
      const have = document.getElementById("skills-have").value.trim();
      const need = document.getElementById("skills-need").value.trim();

      if (!have || !need) {
        output.textContent = "Please fill in both fields.";
        return;
      }

      output.innerHTML = "<p>Analyzing skill gap...</p>";

      const resp = await fetch(`${window.SERVER}/extract-skill_gap_analysis`, {
        method: "POST",
        body: JSON.stringify({ have, need }),
        headers: { "Content-Type": "application/json" },
      });

      if (!resp.ok) {
        const txt = await resp.text();
        let msg = txt;
        try {
          const j = JSON.parse(txt);
          msg = (j.error || "Server error") + "\n\n" + (j.traceback || "");
        } catch (_) {}
        output.innerHTML = `<pre style="color:red; white-space:pre-wrap;">${escapeHtml(msg)}</pre>`;
        return;
      }

      const data = await resp.json();
      const kpi = data.summary_chart || {};
      const chart = data.similarity_chart || [];

      output.innerHTML = `
        <div class="gap-section">

          <div class="kpi-grid">
            <div class="kpi-card">
              <span class="kpi-value">${kpi.need || 0}</span>
              <span class="kpi-label">Required skills</span>
            </div>

            <div class="kpi-card">
              <span class="kpi-value">${kpi.have || 0}</span>
              <span class="kpi-label">Your skills</span>
            </div>

            <div class="kpi-card">
              <span class="kpi-value">${kpi.missing || 0}</span>
              <span class="kpi-label">Missing skills</span>
            </div>

            <div class="kpi-card highlight">
              <span class="kpi-value">${kpi.need ? Math.round((kpi.covered / kpi.need) * 100) : 0}%</span>
              <span class="kpi-label">Match</span>
            </div>
          </div>

          <h3>Skill Gap Strength</h3>
          <div class="progress-chart">
            ${chart.map(c => `
              <div class="progress-row">
                <span class="progress-label">${escapeHtml(cleanSkillLabel(c.label, c.id || ""))}</span>
                <div class="progress-bar">
                  <div class="progress-fill" style="width:${c.percent}%"></div>
                </div>
                <span class="progress-score">${Math.round(c.percent)}%</span>
              </div>
            `).join("")}
          </div>

          <h3>Missing Skills</h3>
          <ul class="gap-list">
            ${(data.missing || []).map(s => `
              <li>
                <a href="${s.url}" target="_blank" class="gap-skill">${escapeHtml(cleanSkillLabel(s.label, s.url || ""))}</a>
                ${s.digital ? `<span class="badge badge-digital">DIGITAL</span>` : ""}
                ${s.green ? `<span class="badge badge-green">GREEN</span>` : ""}
              </li>
            `).join("")}
          </ul>

          <h3>Similarity Scores</h3>
          <ul class="gap-list">
            ${(data.scores || []).map(s => `<li>${escapeHtml(cleanSkillLabel(s))}</li>`).join("")}
          </ul>

          <h3>Recommended Learning Path</h3>
          <ol class="gap-list">
            ${(data.path || []).map(s => `<li>${escapeHtml(s)}</li>`).join("")}
          </ol>

        </div>
      `;
      return;
    }

    /* ---------- Skills / Occupations Extraction ---------- */

  const text = document.getElementById("text").value.trim();
  const manualSkills = getManualSkills();

  if (!text && manualSkills.length === 0) {
    output.textContent = `Please paste text or add skills manually.`;
    return;
  }

// Combine both inputs
const STOP_WORDS = new Set([
  'the','and','for','with','are','was','has','have','had','been','will',
  'our','your','their','this','that','these','those','from','into','onto',
  'looking','seeking','experience','knowledge','ability','skills','skill',
  'working','using','use','work','team','role','job','position','company',
  'software','engineer','developer','analyst','manager','senior','junior',
  'strong','good','great','excellent','required','preferred','must','plus',
  'also','well','able','both','all','any','some','such','other','more'
]);

const rawParts = text
  .split(/[,;\n]| and /i)
  .map(t => t.trim().replace(/[.!?]+$/, ''))
  .filter(Boolean);

const parts = [
  ...rawParts.flatMap(t => {
    const words = t.split(/\s+/);
    if (words.length > 4) {
      return words
        .map(w => w.toLowerCase().replace(/[^a-z0-9#+.]/g, ''))
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
    }
    return [t];
  }),
  ...manualSkills
];


    output.innerHTML = `<p>Extracting ${entity}...</p>`;

    
    const resp = await fetch(`${window.SERVER}/extract-${entity}`, {
      method: "POST",
      body: JSON.stringify(parts),
      headers: { "Content-Type": "application/json" },
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();
    const raw = unwrapResults(data);
    const extracted = raw.flat();

    if (!extracted.length) {
      output.innerHTML = `<p>No ${entity} found.</p>`;
      return;
    }

    if (entity === "skills") {
      lastExtractedSkills = extracted;

      const validKeys = new Set(extracted.map((x) => getSkillKey(normalizeItem(x))));
      reviewedSkills = Object.fromEntries(
        Object.entries(reviewedSkills).filter(([key]) => validKeys.has(key))
      );

      renderSkillsResult(extracted, { title: "Extracted skills" });
      return;
    }

    // Occupations: simple list
    const items = extracted.map(normalizeItem).filter((x) => x.label);
    const listHtml = items
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((x) => {
        const href = x.id || "#";
        return `
          <li class="skill-item">
            <div class="skill-left">
              <a class="skill-tag" href="${href}" target="_blank" rel="noopener noreferrer">
                ${escapeHtml(x.label)}
              </a>
            </div>
          </li>
        `;
      })
      .join("");

    output.innerHTML = `
      <div class="result-box">
        <p class="output-title">Extracted ${escapeHtml(entity)}</p>
        <ul class="skills-list">${listHtml}</ul>
      </div>
    `;
  } catch (err) {
    console.error(err);
    output.innerHTML = `<p>Sorry, something went wrong extracting ${entity}.</p>`;
  } finally {
    submitBtn.disabled = false;
  }
}


/*-------------------main-page--------------------*/

function showToolPage(entity = "skills") {
  const mainPage = document.getElementById("main-page");
  const toolPage = document.getElementById("tool-page");

  if (mainPage) mainPage.style.display = "none";
  if (toolPage) toolPage.style.display = "block";

  const targetBtn = document.querySelector(`.entity-btn[data-entity="${entity}"]`);
  if (targetBtn) {
    targetBtn.click();
  }
}

function setupMainPageNavigation() {
  const startBtn = document.getElementById("start-skills-btn");
  const skillsBtn = document.getElementById("card-skills-btn");
  const occupationsBtn = document.getElementById("card-occupations-btn");
  const gapBtn = document.getElementById("card-gap-btn");

  startBtn?.addEventListener("click", () => showToolPage("skills"));
  skillsBtn?.addEventListener("click", () => showToolPage("skills"));
  occupationsBtn?.addEventListener("click", () => showToolPage("occupations"));
  gapBtn?.addEventListener("click", () => showToolPage("skill_gap_analysis"));
}


function addSkillToTextarea(label) {
  const textarea = document.getElementById("text");
  if (!textarea) return;

  const current = textarea.value.split(",").map(s => s.trim());

  if (!current.includes(label)) {
    textarea.value = current.filter(Boolean).concat(label).join(", ");
  }
}

/* ------------------ Boot ------------------ */

document.addEventListener("DOMContentLoaded", () => {
  setupEntityButtons();
  setupMainPageNavigation();
  loadSkillTypesIntoSelect();

  if (document.getElementById("text")) {
  document.getElementById("submit-button")?.addEventListener("click", extractEntity);
}
document.getElementById("clear-all-btn")?.addEventListener("click", () => {
  document.getElementById("text").value = "";
  document.querySelectorAll(".skill-input").forEach(i => i.closest(".skill-input-row")?.remove());
  document.getElementById("output").innerHTML = "";
  document.getElementById("skills-summary").innerHTML = "";
  document.getElementById("skills-list").innerHTML = "Skills will appear here";
  document.getElementById("skill-details").innerHTML = "Select a skill to see details";
  lastExtractedSkills = [];
  reviewedSkills = {};
});
  

  document.getElementById("search-skills-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    runIndependentSearch();
  });

  document.getElementById("clear-skills-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    clearSearchControls();
    lastSearchResults = [];
    document.getElementById("output").textContent = "Search results will appear here";
  });

  document.getElementById("skill-search")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runIndependentSearch();
    }
  });

  const ta = document.getElementById("text");
  ta?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) extractEntity(e);
  });

  document.getElementById("upload-cv-btn")?.addEventListener("click", () => {
    document.getElementById("cv-file")?.click();
  });

  document.getElementById("cv-file")?.addEventListener("change", () => {
    uploadCvAndExtractSkills();
  });

 document.addEventListener("click", (e) => {
  if (e.target.closest("#upload-skills-file-btn")) {
    // Only trigger on skills page (has #text textarea), not SGA page
    if (document.getElementById("text")) {
      document.getElementById("skills-file")?.click();
    }
  }
});

  document.addEventListener("change", (e) => {
    if (e.target && e.target.id === "skills-file") {
      console.log("FILE SELECTED ✅");
      uploadFileAndExtractSkillsToSkillsTab();
    }
  });

  document.getElementById("skill-search")?.addEventListener("input", () => {
  runIndependentSearch();
  });

  document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-bar")) {
    const dropdown = document.getElementById("search-dropdown");
    if (dropdown) dropdown.innerHTML = "";
  }
});

document.getElementById("skill-type")?.addEventListener("change", runIndependentSearch);

document.getElementById("tag-digital")?.addEventListener("change", runIndependentSearch);
document.getElementById("tag-green")?.addEventListener("change", runIndependentSearch);

document.getElementById("add-skill-field-btn")?.addEventListener("click", () => {
  addSkillField();
});

document.getElementById("add-skill-field-btn-top")?.addEventListener("click", () => {
  addSkillField();
});

checkAuth();


});

window.extractEntity = extractEntity;
window.setReviewedSkill = setReviewedSkill;
window.transferReviewedSkillsToGap = transferReviewedSkillsToGap;
window.transferReviewedSkillsToOccupations = transferReviewedSkillsToOccupations;




/* ── Inject modal HTML once (called on first open) ── */
function _ensureModalExists() {
  if (document.getElementById('save-modal-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id    = 'save-modal-overlay';
  overlay.className = 'save-modal-overlay';
  overlay.innerHTML = `
    <div class="save-modal-card" role="dialog" aria-modal="true" aria-labelledby="save-modal-title">
      <button class="save-modal-close" onclick="closeSaveModal()" aria-label="Close">✕</button>

      <!-- Auth required state -->
      <div id="save-modal-auth-required" style="display:none;">
        <div class="save-modal-icon">🔒</div>
        <h2 id="save-modal-title" class="save-modal-title">Save to Profile</h2>
        <p class="save-modal-desc">You need to be logged in to save items.</p>
        <div class="save-modal-actions">
          <a href="/auth/login" class="auth-btn-sm">Log in</a>
          <a href="/auth/register" class="auth-btn-sm secondary">Register</a>
        </div>
      </div>

      <!-- Save form state -->
      <div id="save-modal-form">
        <div class="save-modal-icon">🔖</div>
        <h2 id="save-modal-title" class="save-modal-title">Save to Profile</h2>
        <p class="save-modal-desc" id="save-modal-desc">Give this a name so you can find it later.</p>
        <input
          type="text"
          id="save-modal-label"
          class="save-modal-input"
          placeholder="e.g. My CV — April 2025"
          maxlength="200"
        />
        <div id="save-modal-error" class="save-modal-error" style="display:none;"></div>
        <div class="save-modal-actions">
          <button class="save-cancel-btn" onclick="closeSaveModal()">Cancel</button>
          <button class="save-confirm-btn" onclick="window._saveItem()">
            Save <span>→</span>
          </button>
        </div>
      </div>

      <!-- Success state -->
      <div id="save-modal-success" style="display:none;">
        <div class="save-modal-icon">✅</div>
        <h2 class="save-modal-title">Saved!</h2>
        <p class="save-modal-desc">You can find it in your <a href="/profile">Profile</a>.</p>
        <div class="save-modal-actions">
          <button class="save-confirm-btn" onclick="closeSaveModal()">Done</button>
        </div>
      </div>

    </div>
  `;

  // Close on backdrop click
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeSaveModal();
  });

  document.body.appendChild(overlay);
}


/* ── Track SGA modal (separate, simpler) ── */
function _ensureTrackModalExists() {
  if (document.getElementById('track-modal-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id    = 'track-modal-overlay';
  overlay.className = 'save-modal-overlay';
  overlay.innerHTML = `
    <div class="save-modal-card" role="dialog" aria-modal="true">
      <button class="save-modal-close" onclick="closeTrackModal()" aria-label="Close">✕</button>

      <div id="track-modal-auth-required" style="display:none;">
        <div class="save-modal-icon">🔒</div>
        <h2 class="save-modal-title">Track Progress</h2>
        <p class="save-modal-desc">You need to be logged in to track skill gap progress.</p>
        <div class="save-modal-actions">
          <a href="/auth/login" class="auth-btn-sm">Log in</a>
          <a href="/auth/register" class="auth-btn-sm secondary">Register</a>
        </div>
      </div>

      <div id="track-modal-form">
        <div class="save-modal-icon">📈</div>
        <h2 class="save-modal-title">Track your progress</h2>
        <p class="save-modal-desc">Name this goal — you'll be able to check off skills as you learn them.</p>
        <input
          type="text"
          id="track-modal-label"
          class="save-modal-input"
          placeholder="e.g. Road to Google SWE"
          maxlength="200"
        />
        <div id="track-modal-error" class="save-modal-error" style="display:none;"></div>
        <div class="save-modal-actions">
          <button class="save-cancel-btn" onclick="closeTrackModal()">Cancel</button>
          <button class="save-confirm-btn" onclick="window._trackSga()">
            Start Tracking <span>→</span>
          </button>
        </div>
      </div>

    </div>
  `;

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeTrackModal();
  });

  document.body.appendChild(overlay);
}


/* ── Internal state ── */
window._saveModalState = {
  type:    null, 
  payload: null,  
};

window._trackSgaState = {
  missing:          [],
  have:             [],
  need:             [],
  occupationLabel:  '',
};


/* ── Public: open save modal ── */
async function openSaveModal(type, payload, defaultLabel = '') {
  _ensureModalExists();
  window._saveModalState = { type, payload };

  const overlay = document.getElementById('save-modal-overlay');
  const formEl  = document.getElementById('save-modal-form');
  const authEl  = document.getElementById('save-modal-auth-required');
  const successEl = document.getElementById('save-modal-success');
  const errEl   = document.getElementById('save-modal-error');
  const inputEl = document.getElementById('save-modal-label');

  // Reset state
  formEl.style.display    = '';
  authEl.style.display    = 'none';
  successEl.style.display = 'none';
  errEl.style.display     = 'none';
  inputEl.value           = defaultLabel;

  // Set description text
  const descMap = {
    skills:     'Name this set of extracted skills.',
    occupation: 'Name this saved occupation.',
    sga:        'Name this skill gap analysis snapshot.',
  };
  const descEl = document.getElementById('save-modal-desc');
  if (descEl) descEl.textContent = descMap[type] || 'Give this a name.';

  // Check auth
  try {
    const res  = await fetch('/auth/me');
    const data = await res.json();
    if (!data.logged_in) {
      formEl.style.display = 'none';
      authEl.style.display = '';
    }
  } catch(e) {
    formEl.style.display = 'none';
    authEl.style.display = '';
  }

  overlay.classList.add('open');
  setTimeout(() => inputEl?.focus(), 100);
}


function closeSaveModal() {
  const overlay = document.getElementById('save-modal-overlay');
  if (overlay) overlay.classList.remove('open');
}


/* ── Internal: save item ── */
window._saveItem = async function() {
  const label  = (document.getElementById('save-modal-label')?.value || '').trim();
  const errEl  = document.getElementById('save-modal-error');

  errEl.style.display = 'none';
  if (!label) { errEl.textContent = 'Please enter a name.'; errEl.style.display = ''; return; }

  const btn = document.querySelector('.save-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const res = await fetch('/api/saved', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type:    window._saveModalState.type,
        label,
        payload: window._saveModalState.payload,
      }),
    });

    if (!res.ok) throw new Error('Save failed');

    // Show success
    document.getElementById('save-modal-form').style.display    = 'none';
    document.getElementById('save-modal-success').style.display = '';

  } catch(e) {
    errEl.textContent   = 'Could not save. Please try again.';
    errEl.style.display = '';
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = 'Save <span>→</span>'; }
  }
};


/* ── Public: open track SGA modal ── */
async function openTrackSgaModal(missing, have, need, occupationLabel = '') {
  _ensureTrackModalExists();
  window._trackSgaState = { missing, have, need, occupationLabel };

  const overlay = document.getElementById('track-modal-overlay');
  const formEl  = document.getElementById('track-modal-form');
  const authEl  = document.getElementById('track-modal-auth-required');
  const errEl   = document.getElementById('track-modal-error');
  const inputEl = document.getElementById('track-modal-label');

  formEl.style.display = '';
  authEl.style.display = 'none';
  errEl.style.display  = 'none';
  inputEl.value        = occupationLabel ? `Road to ${occupationLabel}` : '';

  // Check auth
  try {
    const res  = await fetch('/auth/me');
    const data = await res.json();
    if (!data.logged_in) {
      formEl.style.display = 'none';
      authEl.style.display = '';
    }
  } catch(e) {
    formEl.style.display = 'none';
    authEl.style.display = '';
  }

  overlay.classList.add('open');
  setTimeout(() => inputEl?.focus(), 100);
}


function closeTrackModal() {
  const overlay = document.getElementById('track-modal-overlay');
  if (overlay) overlay.classList.remove('open');
}


window._trackSga = async function() {
  const title  = (document.getElementById('track-modal-label')?.value || '').trim();
  const errEl  = document.getElementById('track-modal-error');

  errEl.style.display = 'none';
  if (!title) { errEl.textContent = 'Please enter a name.'; errEl.style.display = ''; return; }

  const btn = document.querySelector('#track-modal-overlay .save-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const s   = window._trackSgaState;
    const res = await fetch('/api/sga-tracker', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        title,
        occupation_label: s.occupationLabel,
        missing:          s.missing,
        have:             s.have,
        need:             s.need,
      }),
    });

    if (!res.ok) throw new Error('Failed');

    closeTrackModal();
    // Redirect to profile tracker tab
    window.location.href = '/profile#tracker';

  } catch(e) {
    errEl.textContent   = 'Could not save. Please try again.';
    errEl.style.display = '';
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = 'Start Tracking <span>→</span>'; }
  }
};


/*  Topbar auth state injection  */
async function checkAuth() {
  try {
    const res  = await fetch('/auth/me');
    const data = await res.json();

    // Find the topbar right nav
    const nav = document.querySelector('.topbar-right');
    if (!nav) return;


    nav.querySelector('.topbar-auth-link')?.remove();

    if (data.logged_in) {
      const initials = getTopbarInitials(data.display_name || data.email);
      const link     = document.createElement('a');
      link.href      = '/profile';
      link.className = 'topbar-auth-link topbar-profile-link';
      link.innerHTML = `
        <span class="topbar-avatar-circle">${initials}</span>
        <span>My Profile</span>
      `;
      nav.appendChild(link);
    } else {
      const link     = document.createElement('a');
      link.href      = '/auth/login';
      link.className = 'topbar-auth-link';
      link.textContent = 'Log in';
      nav.appendChild(link);
    }
  } catch(e) {

  }
}

function getTopbarInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
}


/* ── Modal CSS (injected dynamically) ── */
(function injectModalStyles() {
  if (document.getElementById('save-modal-css')) return;
  const style = document.createElement('style');
  style.id    = 'save-modal-css';
  style.textContent = `
    .save-modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.35);
      backdrop-filter: blur(3px);
      z-index: 9000;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s;
    }
    .save-modal-overlay.open {
      opacity: 1;
      pointer-events: auto;
    }
    .save-modal-card {
      background: #fff;
      border-radius: 22px;
      padding: 32px 28px 28px;
      width: min(420px, calc(100vw - 40px));
      box-shadow: 0 24px 60px rgba(0,0,0,0.18);
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0;
      transform: translateY(6px);
      transition: transform 0.18s;
    }
    .save-modal-overlay.open .save-modal-card {
      transform: translateY(0);
    }
    .save-modal-close {
      position: absolute;
      top: 14px; right: 16px;
      border: none;
      background: transparent;
      font-size: 16px;
      cursor: pointer;
      color: #9ca3af;
      padding: 4px 8px;
      border-radius: 6px;
      transition: color 0.15s;
    }
    .save-modal-close:hover { color: #374151; }
    .save-modal-icon {
      font-size: 32px;
      margin-bottom: 10px;
    }
    .save-modal-title {
      font-size: 19px;
      font-weight: 700;
      margin: 0 0 6px;
      color: #111;
      text-align: center;
    }
    .save-modal-desc {
      font-size: 14px;
      color: #6b7280;
      margin: 0 0 16px;
      text-align: center;
    }
    .save-modal-desc a { color: #4f46e5; font-weight: 600; }
    .save-modal-input {
      width: 100%;
      padding: 11px 14px;
      border: 1.5px solid #e5e7eb;
      border-radius: 12px;
      font-size: 15px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
      margin-bottom: 12px;
    }
    .save-modal-input:focus {
      border-color: #4f46e5;
      box-shadow: 0 0 0 4px rgba(79,70,229,.15);
    }
    .save-modal-error {
      width: 100%;
      color: #dc2626;
      font-size: 13px;
      margin-bottom: 8px;
    }
    .save-modal-actions {
      display: flex;
      gap: 10px;
      width: 100%;
      justify-content: flex-end;
      margin-top: 4px;
    }
    .save-cancel-btn {
      border: 1px solid #e5e7eb;
      background: #f9fafb;
      color: #374151;
      border-radius: 10px;
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .save-cancel-btn:hover { background: #f3f4f6; }
    .save-confirm-btn {
      border: none;
      background: linear-gradient(135deg, #4f46e5, #6366f1);
      color: #fff;
      border-radius: 10px;
      padding: 10px 20px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      box-shadow: 0 6px 16px rgba(79,70,229,.22);
      transition: filter 0.15s;
    }
    .save-confirm-btn:hover { filter: brightness(1.05); }
    .save-confirm-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .auth-btn-sm {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 20px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      flex: 1;
      text-align: center;
    }
    .auth-btn-sm:not(.secondary) {
      background: linear-gradient(135deg, #4f46e5, #6366f1);
      color: #fff;
      box-shadow: 0 6px 16px rgba(79,70,229,.22);
    }
    .auth-btn-sm.secondary {
      background: #f3f4f6;
      color: #374151;
      border: 1px solid #e5e7eb;
    }
    .topbar-profile-link {
      display: inline-flex !important;
      align-items: center;
      gap: 7px;
    }
    .topbar-avatar-circle {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: linear-gradient(135deg, #4f46e5, #6366f1);
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
  `;
  document.head.appendChild(style);
})();


/* ── Export globals ── */
window.openSaveModal      = openSaveModal;
window.closeSaveModal     = closeSaveModal;
window.openTrackSgaModal  = openTrackSgaModal;
window.closeTrackModal    = closeTrackModal;
window.checkAuth          = checkAuth;

