// build_export.js — Build Export module for Agentic SDLC Workbench
// Exports a complete application design as a Markdown build spec for Claude Code / ServiceNow.
import { apiFetch, getCurrentProjectId, el, showToast } from '../app.js';

// ─── Section groups ───────────────────────────────────────────────────────────
const SECTION_GROUPS = [
  {
    label: 'Design Entities',
    items: [
      { id: 'use_cases',  label: 'Use Cases'  },
      { id: 'workflows',  label: 'Workflows'  },
      { id: 'agents',     label: 'Agents'     },
      { id: 'tools',      label: 'Tools'      },
    ],
  },
  {
    label: 'Supporting Evidence',
    items: [
      { id: 'guardrails',     label: 'Guardrails'      },
      { id: 'data_sources',   label: 'Data Sources'    },
      { id: 'test_scenarios', label: 'Test Scenarios'  },
      { id: 'user_stories',   label: 'User Stories'    },
      { id: 'governance',     label: 'Governance'      },
    ],
  },
  {
    label: 'Architecture',
    items: [
      { id: 'relationships', label: 'Relationships' },
    ],
  },
  {
    label: 'Planning',
    items: [
      { id: 'cost_summary', label: 'Cost Projections' },
    ],
  },
];

// ─── Module-level state ───────────────────────────────────────────────────────
let _projectId       = null;
let _baselineSelect  = null;
let _downloadBtn     = null;
let _previewEl       = null;
let _allCheckboxes   = [];
let _aiReviewChk     = null;

// ─── Styles ───────────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('be-styles')) return;
  const style = document.createElement('style');
  style.id = 'be-styles';
  style.textContent = `
    .be-page { padding: 24px; }
    .be-layout {
      display: grid;
      grid-template-columns: 360px 1fr;
      gap: 24px;
      align-items: start;
    }
    @media (max-width: 860px) { .be-layout { grid-template-columns: 1fr; } }

    .be-card {
      background: var(--color-panel);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      padding: 22px;
      box-shadow: var(--shadow);
    }
    .be-card-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin: 0 0 18px 0;
    }

    .be-field { margin-bottom: 18px; }
    .be-field label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: var(--color-text);
      margin-bottom: 6px;
    }
    .be-select {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius);
      background: var(--color-bg);
      color: var(--color-text);
      font-size: 13px;
      box-sizing: border-box;
    }
    .be-select:focus { outline: none; border-color: var(--color-accent); }

    .be-sections-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin: 0 0 14px 0;
    }
    .be-section-group { margin-bottom: 16px; }
    .be-section-group-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .be-section-group-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.9px;
    }
    .be-toggle-btn {
      font-size: 11px;
      color: var(--color-accent);
      background: none;
      border: none;
      cursor: pointer;
      padding: 0;
      line-height: 1;
    }
    .be-toggle-btn:hover { text-decoration: underline; }

    .be-checkbox-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 7px;
    }
    .be-chk-label {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 13px;
      color: var(--color-text);
      cursor: pointer;
      user-select: none;
    }
    .be-chk-label input[type="checkbox"] {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      cursor: pointer;
      accent-color: var(--color-accent);
    }

    .be-divider { border: none; border-top: 1px solid var(--color-border); margin: 18px 0; }

    .be-download-btn {
      width: 100%;
      padding: 12px;
      background: var(--color-accent);
      color: #fff;
      border: none;
      border-radius: var(--radius);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity .15s;
    }
    .be-download-btn:hover:not(:disabled) { opacity: .88; }
    .be-download-btn:disabled { opacity: .4; cursor: not-allowed; }

    /* Preview card */
    .be-preview-empty {
      text-align: center;
      padding: 48px 20px;
      color: var(--color-text-muted);
      font-size: 14px;
    }
    .be-preview-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 18px;
    }
    @media (max-width: 640px) { .be-preview-grid { grid-template-columns: repeat(2, 1fr); } }
    .be-stat-card {
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius);
      padding: 14px 10px;
      text-align: center;
    }
    .be-stat-num {
      font-size: 30px;
      font-weight: 700;
      color: var(--color-accent);
      line-height: 1;
      margin-bottom: 5px;
    }
    .be-stat-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.7px;
    }
    .be-status-line {
      padding: 10px 14px;
      border-radius: var(--radius);
      font-size: 13px;
      font-weight: 500;
      text-align: center;
      cursor: default;
    }
    .be-status-ready { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
    .be-status-empty { background: var(--color-warn-bg); color: var(--color-warn); border: 1px solid #fcd34d; }

    .be-detail-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px 20px;
      margin-top: 16px;
      padding-top: 14px;
      border-top: 1px solid var(--color-border);
    }
    .be-detail-row {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--color-text-muted);
      padding: 2px 0;
    }
    .be-detail-val { font-weight: 600; color: var(--color-text); }

    .be-evidence-note {
      margin-top: 14px;
      font-size: 12px;
      color: var(--color-text-muted);
      line-height: 1.5;
    }
    .be-loading {
      text-align: center;
      padding: 48px 20px;
      color: var(--color-text-muted);
      font-size: 14px;
    }
  `;
  document.head.appendChild(style);
}

// ─── Main render entry point ──────────────────────────────────────────────────
export async function render(container) {
  injectStyles();
  _allCheckboxes = [];

  const page = el('div', { className: 'be-page' });

  // Module header
  page.appendChild(
    el('div', { className: 'module-header' },
      el('div', {},
        el('h2', { className: 'module-title' }, 'Build Export'),
        el('p',  { className: 'module-subtitle' }, 'Export a complete application design as a Markdown build specification for Claude Code.')
      )
    )
  );

  // Load projects
  let projects = [];
  try {
    const raw = await apiFetch('/projects');
    projects = Array.isArray(raw) ? raw : (raw.items || raw.projects || []);
  } catch (err) {
    page.appendChild(el('div', { className: 'error-state' }, `Failed to load projects: ${err.message}`));
    container.innerHTML = '';
    container.appendChild(page);
    return;
  }

  // Two-column layout
  const layout = el('div', { className: 'be-layout' });
  const controlsCard = el('div', { className: 'be-card' });
  _previewEl = el('div', { className: 'be-card' });
  layout.appendChild(controlsCard);
  layout.appendChild(_previewEl);
  page.appendChild(layout);

  container.innerHTML = '';
  container.appendChild(page);

  buildControls(controlsCard, projects);
}

// ─── Controls card ────────────────────────────────────────────────────────────
function buildControls(card, projects) {
  card.innerHTML = '';
  card.appendChild(el('div', { className: 'be-card-title' }, 'Export Settings'));

  // ── Application selector ──────────────────────────────────────────────────
  const projectField = el('div', { className: 'be-field' },
    el('label', { for: 'be-project-select' }, 'Application')
  );
  const projectSelect = el('select', { id: 'be-project-select', className: 'be-select' });
  projectSelect.appendChild(el('option', { value: '' }, '— Select application —'));
  for (const p of projects) {
    const label = (p.client_name ? `${p.client_name} — ` : '') + p.project_name;
    projectSelect.appendChild(el('option', { value: p.project_id }, label));
  }
  projectField.appendChild(projectSelect);
  card.appendChild(projectField);

  // ── Version selector ──────────────────────────────────────────────────────
  const versionField = el('div', { className: 'be-field' },
    el('label', { for: 'be-baseline-select' }, 'Version')
  );
  _baselineSelect = el('select', { id: 'be-baseline-select', className: 'be-select' });
  _baselineSelect.appendChild(el('option', { value: '' }, 'Current live design (recommended)'));
  versionField.appendChild(_baselineSelect);
  card.appendChild(versionField);

  // ── Section checkboxes ────────────────────────────────────────────────────
  card.appendChild(el('div', { className: 'be-sections-title' }, 'Include Sections'));

  for (const group of SECTION_GROUPS) {
    const groupEl  = el('div', { className: 'be-section-group' });
    const groupHdr = el('div', { className: 'be-section-group-hdr' },
      el('span', { className: 'be-section-group-label' }, group.label)
    );

    // "all / none" toggle for this group
    const toggleBtn = el('button', { className: 'be-toggle-btn' }, 'all / none');
    const groupCheckboxIds = group.items.map(item => `be-chk-${item.id}`);
    toggleBtn.addEventListener('click', () => {
      const groupChks = groupCheckboxIds.map(id => document.getElementById(id)).filter(Boolean);
      const anyOn = groupChks.some(c => c.checked);
      groupChks.forEach(c => { c.checked = !anyOn; });
    });
    groupHdr.appendChild(toggleBtn);
    groupEl.appendChild(groupHdr);

    const grid = el('div', { className: 'be-checkbox-grid' });
    for (const item of group.items) {
      const chkId = `be-chk-${item.id}`;
      const chk   = el('input', { type: 'checkbox', id: chkId });
      chk.checked = true;
      _allCheckboxes.push(chk);
      grid.appendChild(
        el('label', { className: 'be-chk-label', for: chkId }, chk, item.label)
      );
    }
    groupEl.appendChild(grid);
    card.appendChild(groupEl);
  }

  card.appendChild(el('hr', { className: 'be-divider' }));

  // ── Optional AI review (additive; deterministic spec is unchanged) ─────────
  _aiReviewChk = el('input', { type: 'checkbox', id: 'be-chk-ai-review' });
  card.appendChild(el('label', { className: 'be-chk-label', for: 'be-chk-ai-review', style: 'margin-bottom:8px' },
    _aiReviewChk, 'Append AI design review & summary'));
  card.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin:-4px 0 10px 0' },
    'Adds an AI-written Executive Summary, gaps/completeness review, and implementation notes after the deterministic spec.'));

  // ── Download button ───────────────────────────────────────────────────────
  _downloadBtn = el('button', { className: 'be-download-btn' }, '⬇  Download Build Spec');
  _downloadBtn.addEventListener('click', handleDownload);
  card.appendChild(_downloadBtn);

  // ── Wire project change ───────────────────────────────────────────────────
  projectSelect.addEventListener('change', async () => {
    _projectId = projectSelect.value || null;
    // Reset baseline list
    _baselineSelect.innerHTML = '';
    _baselineSelect.appendChild(el('option', { value: '' }, 'Current live design (recommended)'));
    if (_projectId) {
      await Promise.all([loadBaselines(_projectId), loadPreview(_projectId)]);
    } else {
      renderPreviewEmpty();
    }
  });

  // Pre-select current project from global selector
  const currentPid = getCurrentProjectId();
  if (currentPid && projects.some(p => p.project_id === currentPid)) {
    projectSelect.value = currentPid;
    _projectId = currentPid;
    // Fire initial load without waiting (renders spinner then data)
    loadBaselines(currentPid);
    loadPreview(currentPid);
  } else {
    renderPreviewEmpty();
  }
}

// ─── Baseline loader ──────────────────────────────────────────────────────────
async function loadBaselines(projectId) {
  try {
    const raw  = await apiFetch(`/baselines?project_id=${projectId}`);
    const all  = Array.isArray(raw) ? raw : (raw.items || []);
    const locked = all
      .filter(b => b.locked_at)
      .sort((a, b) => new Date(b.locked_at) - new Date(a.locked_at));

    _baselineSelect.innerHTML = '';
    _baselineSelect.appendChild(el('option', { value: '' }, 'Current live design (recommended)'));
    for (const b of locked) {
      const date = b.locked_at ? b.locked_at.slice(0, 10) : '';
      _baselineSelect.appendChild(
        el('option', { value: b.baseline_id }, `${b.baseline_name} — locked ${date}`)
      );
    }
  } catch (err) {
    console.warn('[build_export] Could not load baselines:', err.message);
  }
}

// ─── Preview card ─────────────────────────────────────────────────────────────
function renderPreviewEmpty() {
  _previewEl.innerHTML = '';
  _previewEl.appendChild(el('div', { className: 'be-card-title' }, 'Preview'));
  _previewEl.appendChild(el('div', { className: 'be-preview-empty' }, 'Select an application to see a preview.'));
}

async function loadPreview(projectId) {
  _previewEl.innerHTML = '';
  _previewEl.appendChild(el('div', { className: 'be-card-title' }, 'Preview'));
  _previewEl.appendChild(el('div', { className: 'be-loading' }, 'Loading entity counts…'));

  try {
    const data = await apiFetch(`/projects/${projectId}/design-report/relationships`);
    const rel  = data.relationships || {};
    const ucList   = rel.use_cases     || [];
    const toolList = rel.project_tools || [];

    let agentCount = 0, wfCount = 0, stepCount = 0, hitlCount = 0;
    for (const uc of ucList) {
      wfCount += (uc.workflows || []).length;
      for (const wf of (uc.workflows || [])) {
        agentCount += (wf.agents     || []).length;
        stepCount  += wf.step_count  || 0;
        hitlCount  += (wf.hitl_roles || []).length;
      }
    }

    _previewEl.innerHTML = '';
    _previewEl.appendChild(el('div', { className: 'be-card-title' }, 'Preview'));

    const hasData = ucList.length || wfCount || agentCount || toolList.length;
    if (!hasData) {
      _previewEl.appendChild(el('div', { className: 'be-status-line be-status-empty' }, '⚠  No design data found for this application.'));
      return;
    }

    // Stat grid
    const grid = el('div', { className: 'be-preview-grid' });
    const stats = [
      { num: ucList.length,   label: 'Use Cases' },
      { num: wfCount,         label: 'Workflows'  },
      { num: agentCount,      label: 'Agents'     },
      { num: toolList.length, label: 'Tools'      },
    ];
    for (const s of stats) {
      grid.appendChild(el('div', { className: 'be-stat-card' },
        el('div', { className: 'be-stat-num'   }, String(s.num)),
        el('div', { className: 'be-stat-label' }, s.label)
      ));
    }
    _previewEl.appendChild(grid);

    // Status line
    _previewEl.appendChild(el('div', { className: 'be-status-line be-status-ready' }, '✓  Design data found — use the Download button on the left to export'));

    // Detail grid — structural counts
    const detail = el('div', { className: 'be-detail-grid' });
    const rows = [
      ['Workflow Steps', stepCount],
      ['HITL Gates',     hitlCount],
    ];
    for (const [label, val] of rows) {
      detail.appendChild(el('div', { className: 'be-detail-row' },
        el('span', {}, label),
        el('span', { className: 'be-detail-val' }, String(val))
      ));
    }
    _previewEl.appendChild(detail);

    _previewEl.appendChild(el('p', { className: 'be-evidence-note' },
      'Guardrails, data sources, test scenarios, user stories, and governance controls are included when an ingested document is available for this application.'
    ));
  } catch (err) {
    _previewEl.innerHTML = '';
    _previewEl.appendChild(el('div', { className: 'be-card-title' }, 'Preview'));
    _previewEl.appendChild(el('div', { className: 'error-state' }, `Could not load preview: ${err.message}`));
  }
}

// ─── Download handler ─────────────────────────────────────────────────────────
function handleDownload() {
  if (!_projectId) {
    showToast('Please select an application first', 'warn');
    return;
  }

  const checkedSections = _allCheckboxes
    .filter(chk => chk.checked)
    .map(chk => chk.id.replace('be-chk-', ''));

  if (!checkedSections.length) {
    showToast('Please select at least one section to export', 'warn');
    return;
  }

  const params = new URLSearchParams();
  const baselineId = _baselineSelect?.value;
  if (baselineId) params.set('baseline_id', baselineId);
  params.set('sections', checkedSections.join(','));
  if (_aiReviewChk?.checked) params.set('ai_review', '1');

  if (_aiReviewChk?.checked) {
    showToast('Generating AI review — the download may take a few seconds…', 'info');
  }

  // Direct navigation triggers browser file download (Content-Disposition: attachment)
  window.location.href = `/api/v1/projects/${_projectId}/build-export?${params.toString()}`;
}
