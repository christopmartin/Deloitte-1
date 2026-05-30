/**
 * modules/testing.js — Testing tab
 *
 * Two top-level views:
 *   - Acceptance Criteria (grouped by Use Case + User Story)
 *   - Test Cases (sub-filtered by scope: agent | workflow | tool | use_case)
 *
 * Rows are inline-editable and deletable; "+ Add" inserts a new draft row
 * per group. Edits create auto-approved Change Packets server-side.
 */

import { apiFetch, el, escHtml, showToast, getCurrentProjectId } from '../app.js';

// ─── module state ───────────────────────────────────────────────────────────

let _projectId   = null;
let _reportArea  = null;
let _topView     = 'ac';   // 'ac' | 'tc'
let _tcScope     = 'use_case';

// ─── entry point ────────────────────────────────────────────────────────────

export async function render(container) {
  container.innerHTML = '';
  injectStyles();

  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'Testing'),
    el('p', { className: 'purpose-text' },
      'Acceptance Criteria for sign-off and Test Cases for unit + integration coverage. ' +
      'Generated drafts (when an extraction pipeline produces them) can be edited or added to here.')
  ));

  // ── controls bar ──────────────────────────────────────────────
  const bar = el('div', { className: 'tst-controls' });

  const projSel = el('select', { className: 'filter-select', style: { minWidth: '240px' } });
  projSel.innerHTML = '<option value="">— Select application —</option>';
  bar.appendChild(projSel);

  // Top-level toggle: AC vs Test Cases vs Coverage
  const toggle = el('div', { className: 'tst-toggle' });
  const acBtn = el('button', { className: 'tst-toggle-btn', 'data-view': 'ac' }, 'Acceptance Criteria');
  const tcBtn = el('button', { className: 'tst-toggle-btn', 'data-view': 'tc' }, 'Test Cases');
  const covBtn = el('button', { className: 'tst-toggle-btn', 'data-view': 'coverage' }, 'Coverage');
  toggle.appendChild(acBtn);
  toggle.appendChild(tcBtn);
  toggle.appendChild(covBtn);
  bar.appendChild(toggle);

  container.appendChild(bar);

  // ── report area ───────────────────────────────────────────────
  _reportArea = el('div', { id: 'tst-report-area' });
  container.appendChild(_reportArea);

  // ── load project list ─────────────────────────────────────────
  try {
    const projects = await apiFetch('/projects');
    projects.forEach(p => {
      const opt = el('option', { value: p.project_id },
        `${p.project_name}${p.project_code ? ` — ${p.project_code}` : ''}`);
      projSel.appendChild(opt);
    });
  } catch (err) {
    _reportArea.innerHTML = `<div class="error-state">Could not load projects: ${escHtml(err.message)}</div>`;
    return;
  }

  // Pre-select current project if set
  const pid = getCurrentProjectId();
  if (pid) { projSel.value = pid; _projectId = pid; }

  // ── wire toggle ────────────────────────────────────────────────
  const setView = (v) => {
    _topView = v;
    [acBtn, tcBtn, covBtn].forEach(b => b.classList.toggle('active', b.dataset.view === v));
    if (_projectId) loadView();
    else showEmptyState();
  };
  acBtn.addEventListener('click', () => setView('ac'));
  tcBtn.addEventListener('click', () => setView('tc'));
  covBtn.addEventListener('click', () => setView('coverage'));
  setView('ac');

  // ── wire project selector ──────────────────────────────────────
  projSel.addEventListener('change', () => {
    _projectId = projSel.value || null;
    if (_projectId) loadView();
    else showEmptyState();
  });

  if (_projectId) loadView();
  else showEmptyState();
}

function showEmptyState() {
  _reportArea.innerHTML =
    '<div class="empty-state" style="margin-top:40px"><div class="empty-state-icon">🧪</div>' +
    '<h3>Select an application</h3><p>Choose one above to view its acceptance criteria and test cases.</p></div>';
}

// ─── view loaders ───────────────────────────────────────────────────────────

async function loadView() {
  _reportArea.innerHTML =
    '<div class="loading-state"><div class="loading-spinner"></div><span>Loading…</span></div>';
  try {
    if (_topView === 'ac')            await renderAcView();
    else if (_topView === 'coverage') await renderCoverageView();
    else                              await renderTcView();
  } catch (err) {
    _reportArea.innerHTML = `<div class="error-state">${escHtml(err.message)}</div>`;
  }
}

// ─── Acceptance Criteria view ───────────────────────────────────────────────

async function renderAcView() {
  // Fetch use cases + their AC, plus user stories scoped to this project.
  const [useCasesReport, allAc] = await Promise.all([
    apiFetch(`/projects/${_projectId}/design-report/use-cases`),
    apiFetch(`/projects/${_projectId}/acceptance-criteria`),
  ]);
  // user stories live as extractions inside the use cases report when available
  // (they're also available via /design-report/user-stories).
  let userStories = [];
  try {
    const usReport = await apiFetch(`/projects/${_projectId}/design-report/user-stories`);
    userStories = usReport.user_stories || [];
  } catch { /* empty */ }

  const useCases = useCasesReport.use_cases || [];
  const acByUseCase = groupBy(allAc.filter(a => a.parent_type === 'use_case'), 'parent_id');
  const acByStory   = groupBy(allAc.filter(a => a.parent_type === 'user_story'), 'parent_id');

  _reportArea.innerHTML = '';

  if (!useCases.length && !userStories.length) {
    _reportArea.appendChild(el('div', { className: 'empty-state', style: { margin: '40px 0' } },
      el('div', { className: 'empty-state-icon' }, '📋'),
      el('h3', {}, 'No use cases or user stories found'),
      el('p', {}, 'Ingest a use case document first.')));
    return;
  }

  // Use Case AC blocks
  if (useCases.length) {
    _reportArea.appendChild(el('h3', { className: 'tst-section-title' }, 'Use Case Acceptance Criteria'));
    useCases.forEach(uc => {
      _reportArea.appendChild(buildAcBlock({
        parentLabel: uc.title || '(untitled use case)',
        parentSubtitle: uc.business_objective || '',
        parentType: 'use_case',
        parentId: uc.use_case_id,
        items: acByUseCase[uc.use_case_id] || [],
      }));
    });
  }

  // User Story AC blocks
  if (userStories.length) {
    _reportArea.appendChild(el('h3', { className: 'tst-section-title', style: { marginTop: '32px' } },
      'User Story Acceptance Criteria'));
    userStories.forEach(us => {
      const storyId = us.story_id_ref || us.id;
      if (!storyId) return;
      _reportArea.appendChild(buildAcBlock({
        parentLabel: `${storyId}: ${us.title || ''}`,
        parentSubtitle: us.description || '',
        parentType: 'user_story',
        parentId: storyId,
        items: acByStory[storyId] || [],
      }));
    });
  }
}

function buildAcBlock({ parentLabel, parentSubtitle, parentType, parentId, items }) {
  const block = el('div', { className: 'tst-block' });

  const hdr = el('div', { className: 'tst-block-header' });
  hdr.appendChild(el('div', { className: 'tst-block-title' }, parentLabel));
  if (parentSubtitle) hdr.appendChild(el('div', { className: 'tst-block-subtitle' }, parentSubtitle));
  block.appendChild(hdr);

  const list = el('div', { className: 'tst-ac-list' });
  if (!items.length) {
    list.appendChild(el('div', { className: 'tst-empty-row' }, 'No acceptance criteria yet.'));
  } else {
    items.forEach(ac => list.appendChild(buildAcRow(ac, parentType, parentId)));
  }
  block.appendChild(list);

  // Add button
  const addBtn = el('button', { className: 'btn btn-ghost btn-sm tst-add-btn' }, '+ Add Acceptance Criterion');
  addBtn.addEventListener('click', () => addAc(parentType, parentId, list));
  block.appendChild(addBtn);

  return block;
}

function buildAcRow(ac, parentType, parentId) {
  const row = el('div', { className: 'tst-row' });

  const textEl = el('div', { className: 'tst-row-text', contentEditable: 'true', spellcheck: 'true' });
  textEl.textContent = ac.text || '';

  const meta = el('div', { className: 'tst-row-meta' });
  // Show requirement traceability link if this AC satisfies a specific FR/NFR
  if (ac.req_slug) {
    const reqTag = el('span', { className: 'tst-req-tag', title: 'Satisfies requirement ' + ac.req_slug }, ac.req_slug);
    meta.appendChild(reqTag);
  }
  meta.appendChild(sourcePill(ac.source));
  meta.appendChild(statusPill(ac.status, async (newStatus) => {
    await updateAc(ac, { status: newStatus });
    ac.status = newStatus;
  }));
  const delBtn = el('button', { className: 'tst-row-delete', title: 'Delete' }, '✕');
  delBtn.addEventListener('click', async () => {
    if (!confirm('Delete this acceptance criterion?')) return;
    try {
      await apiFetch(`/projects/${_projectId}/acceptance-criteria/${ac.acceptance_criterion_id}`,
        { method: 'DELETE' });
      row.remove();
      showToast('Acceptance criterion deleted', 'success');
    } catch (err) { showToast(`Delete failed: ${err.message}`, 'error'); }
  });
  meta.appendChild(delBtn);

  // Save on blur if text changed
  let lastText = ac.text || '';
  textEl.addEventListener('blur', async () => {
    const newText = textEl.textContent.trim();
    if (newText === lastText) return;
    if (!newText) {
      textEl.textContent = lastText;
      return;
    }
    try {
      const result = await updateAc(ac, { text: newText });
      lastText = newText;
      ac.text = newText;
      // Refresh source pill if server flipped it
      if (result.source && result.source !== ac.source) {
        ac.source = result.source;
        meta.replaceChild(sourcePill(ac.source), meta.firstChild);
      }
      showToast(result._cp?.cpCode ? `Saved — CP ${result._cp.cpCode}` : 'Saved', 'success');
    } catch (err) {
      textEl.textContent = lastText;
      showToast(`Save failed: ${err.message}`, 'error');
    }
  });
  textEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') { textEl.textContent = lastText; textEl.blur(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textEl.blur(); }
  });

  row.appendChild(textEl);
  row.appendChild(meta);
  return row;
}

async function addAc(parentType, parentId, listContainer) {
  try {
    const created = await apiFetch(`/projects/${_projectId}/acceptance-criteria`, {
      method: 'POST',
      body: JSON.stringify({
        parent_type: parentType,
        parent_id:   parentId,
        text:        'New acceptance criterion — click to edit',
        source:      'user_added',
        status:      'draft',
      }),
    });
    // Remove empty-state placeholder if present
    const empty = listContainer.querySelector('.tst-empty-row');
    if (empty) empty.remove();
    const row = buildAcRow(created, parentType, parentId);
    listContainer.appendChild(row);
    // Focus the new row's text for immediate editing
    setTimeout(() => {
      const textEl = row.querySelector('.tst-row-text');
      textEl.focus();
      // select all
      const range = document.createRange();
      range.selectNodeContents(textEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }, 30);
  } catch (err) { showToast(`Add failed: ${err.message}`, 'error'); }
}

async function updateAc(ac, fields) {
  return await apiFetch(`/projects/${_projectId}/acceptance-criteria/${ac.acceptance_criterion_id}`, {
    method: 'PUT',
    body:   JSON.stringify(fields),
  });
}

// ─── Test Cases view ────────────────────────────────────────────────────────

const TC_SCOPES = [
  { id: 'use_case', label: 'Use Case (integration)' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'agent',    label: 'Agent (unit)' },
  { id: 'tool',     label: 'Tool' },
];

async function renderTcView() {
  _reportArea.innerHTML = '';

  // Scope sub-tabs
  const scopeBar = el('div', { className: 'tst-scope-bar' });
  TC_SCOPES.forEach(s => {
    const btn = el('button', {
      className: 'tst-scope-btn' + (s.id === _tcScope ? ' active' : ''),
      'data-scope': s.id,
    }, s.label);
    btn.addEventListener('click', () => {
      _tcScope = s.id;
      renderTcView();
    });
    scopeBar.appendChild(btn);
  });
  _reportArea.appendChild(scopeBar);

  const body = el('div');
  _reportArea.appendChild(body);
  body.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading…</span></div>';

  // Fetch test cases + parent entities for the current scope
  const [allTc, entities] = await Promise.all([
    apiFetch(`/projects/${_projectId}/test-cases?scope=${_tcScope}`),
    fetchEntitiesForScope(_tcScope),
  ]);
  const byEntity = groupBy(allTc, 'scope_entity_id');

  body.innerHTML = '';

  if (!entities.length) {
    body.appendChild(el('div', { className: 'empty-state', style: { margin: '40px 0' } },
      el('div', { className: 'empty-state-icon' }, '🧪'),
      el('h3', {}, `No ${scopeNoun(_tcScope)}s yet`),
      el('p', {}, `Add a ${scopeNoun(_tcScope)} on the Design Review tab first.`)));
    return;
  }

  entities.forEach(ent => {
    body.appendChild(buildTcBlock({
      parentLabel: ent.label,
      parentSubtitle: ent.subtitle,
      scope: _tcScope,
      scopeEntityId: ent.id,
      items: byEntity[ent.id] || [],
    }));
  });
}

function scopeNoun(scope) {
  switch (scope) {
    case 'use_case': return 'use case';
    case 'workflow': return 'workflow';
    case 'agent':    return 'agent';
    case 'tool':     return 'tool';
    default:         return scope;
  }
}

async function fetchEntitiesForScope(scope) {
  // Each branch returns [{ id, label, subtitle }]
  if (scope === 'use_case') {
    const r = await apiFetch(`/projects/${_projectId}/design-report/use-cases`);
    return (r.use_cases || []).map(uc => ({
      id: uc.use_case_id,
      label: uc.title || '(untitled)',
      subtitle: uc.business_objective || '',
    }));
  }
  if (scope === 'workflow') {
    const r = await apiFetch(`/projects/${_projectId}/design-report/workflows`);
    return (r.workflows || []).map(wf => ({
      id: wf.workflow_id,
      label: wf.name || '(untitled)',
      subtitle: (wf.trigger && wf.trigger.description) || '',
    }));
  }
  if (scope === 'agent') {
    const r = await apiFetch(`/projects/${_projectId}/design-report/agents`);
    return (r.agents || []).map(a => ({
      id: a.agent_spec_id,
      label: a.name || '(untitled)',
      subtitle: a.scope || '',
    }));
  }
  if (scope === 'tool') {
    const r = await apiFetch(`/projects/${_projectId}/design-report/tools`);
    return (r.tools || []).map(t => ({
      id: t.tool_id,
      label: t.name || '(untitled)',
      subtitle: (typeof t.contract === 'object' ? t.contract.description : t.contract) || '',
    }));
  }
  return [];
}

function buildTcBlock({ parentLabel, parentSubtitle, scope, scopeEntityId, items }) {
  const block = el('div', { className: 'tst-block' });

  const hdr = el('div', { className: 'tst-block-header' });
  hdr.appendChild(el('div', { className: 'tst-block-title' }, parentLabel));
  if (parentSubtitle) hdr.appendChild(el('div', { className: 'tst-block-subtitle' }, parentSubtitle));
  block.appendChild(hdr);

  if (!items.length) {
    block.appendChild(el('div', { className: 'tst-empty-row' }, 'No test cases yet.'));
  } else {
    const tbl = el('table', { className: 'tst-tc-table' });
    tbl.innerHTML =
      '<thead><tr>' +
      '<th style="width:22%">Title</th>' +
      '<th style="width:8%">Type</th>' +
      '<th>Test Action</th>' +
      '<th>Test Input</th>' +
      '<th>Expected Result</th>' +
      '<th style="width:90px">Source</th>' +
      '<th style="width:90px">Status</th>' +
      '<th style="width:24px"></th>' +
      '</tr></thead>';
    const tbody = el('tbody');
    items.forEach(tc => tbody.appendChild(buildTcRow(tc)));
    tbl.appendChild(tbody);
    block.appendChild(tbl);
  }

  const actions = el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;' });
  const addBtn = el('button', { className: 'btn btn-ghost btn-sm tst-add-btn' }, '+ Add Test Case');
  addBtn.addEventListener('click', () => addTc(scope, scopeEntityId, block));
  actions.appendChild(addBtn);

  const genBtn = el('button', { className: 'btn btn-ghost btn-sm' }, '✨ Generate tests (AI)');
  genBtn.title = 'Let AI draft test cases across scenario types for this ' + scopeNoun(scope);
  genBtn.addEventListener('click', async () => {
    genBtn.disabled = true; const orig = genBtn.textContent; genBtn.textContent = '✨ Generating…';
    try {
      const r = await apiFetch(`/projects/${_projectId}/test-cases/generate`, {
        method: 'POST',
        body: JSON.stringify({ scope, scope_entity_id: scopeEntityId }),
      });
      if (!r.created) {
        showToast(r.source === 'stub'
          ? 'AI key not configured — no tests generated (set ANTHROPIC_API_KEY).'
          : 'No new test cases generated (coverage may already exist).', 'warning');
      } else {
        showToast(`Generated ${r.created} draft test case${r.created === 1 ? '' : 's'} — review & approve.`, 'success');
      }
      renderTcView();
    } catch (err) {
      showToast(`Generate failed: ${err.message}`, 'error');
      genBtn.disabled = false; genBtn.textContent = orig;
    }
  });
  actions.appendChild(genBtn);
  block.appendChild(actions);

  return block;
}

function buildTcRow(tc) {
  const tr = el('tr', { className: 'tst-tc-row' });
  // Title cell — includes requirement_ids tags below the title if present
  const titleTd = editableCell(tc, 'title', { strong: true });
  const reqIds = (() => {
    try { return Array.isArray(tc.requirement_ids) ? tc.requirement_ids : JSON.parse(tc.requirement_ids || '[]'); }
    catch { return []; }
  })();
  if (reqIds.length) {
    const tagsWrap = el('div', { style: 'display:flex;flex-wrap:wrap;gap:3px;margin-top:3px' });
    reqIds.forEach(slug => tagsWrap.appendChild(
      el('span', { className: 'tst-req-tag', title: 'Validates requirement ' + slug }, slug)
    ));
    titleTd.appendChild(tagsWrap);
  }
  tr.appendChild(titleTd);
  tr.appendChild(caseTypeCell(tc));
  tr.appendChild(editableCell(tc, 'test_action'));
  tr.appendChild(editableCell(tc, 'test_input'));
  tr.appendChild(editableCell(tc, 'expected_result'));
  const srcCell = el('td', { className: 'tst-tc-source-cell' });
  srcCell.appendChild(sourcePill(tc.source));
  tr.appendChild(srcCell);
  const statusCell = el('td', { className: 'tst-tc-status-cell' });
  statusCell.appendChild(statusPill(tc.status, async (newStatus) => {
    await updateTc(tc, { status: newStatus });
    tc.status = newStatus;
  }));
  tr.appendChild(statusCell);
  const delCell = el('td', { style: { textAlign: 'center' } });
  const delBtn = el('button', { className: 'tst-row-delete', title: 'Delete' }, '✕');
  delBtn.addEventListener('click', async () => {
    if (!confirm('Delete this test case?')) return;
    try {
      await apiFetch(`/projects/${_projectId}/test-cases/${tc.test_case_id}`, { method: 'DELETE' });
      tr.remove();
      showToast('Test case deleted', 'success');
    } catch (err) { showToast(`Delete failed: ${err.message}`, 'error'); }
  });
  delCell.appendChild(delBtn);
  tr.appendChild(delCell);
  return tr;
}

function editableCell(tc, field, opts = {}) {
  const td = el('td');
  const cell = el('div', {
    className: 'tst-cell-editable' + (opts.strong ? ' tst-cell-strong' : ''),
    contentEditable: 'true', spellcheck: 'true',
  });
  cell.textContent = tc[field] || '';
  let last = tc[field] || '';
  cell.addEventListener('blur', async () => {
    const val = cell.textContent.trim();
    if (val === last) return;
    if (!val && field === 'title') { cell.textContent = last; return; }
    try {
      const result = await updateTc(tc, { [field]: val });
      last = val;
      tc[field] = val;
      // Update source pill if flipped
      if (result.source && result.source !== tc.source) {
        tc.source = result.source;
        const row = td.closest('tr');
        const srcCell = row.querySelector('.tst-tc-source-cell');
        if (srcCell) { srcCell.innerHTML = ''; srcCell.appendChild(sourcePill(tc.source)); }
      }
      showToast(result._cp?.cpCode ? `Saved — CP ${result._cp.cpCode}` : 'Saved', 'success');
    } catch (err) {
      cell.textContent = last;
      showToast(`Save failed: ${err.message}`, 'error');
    }
  });
  cell.addEventListener('keydown', e => {
    if (e.key === 'Escape') { cell.textContent = last; cell.blur(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); cell.blur(); }
  });
  td.appendChild(cell);
  return td;
}

const CASE_TYPES = ['happy_path', 'edge_case', 'negative', 'regression', 'performance'];
function caseTypeCell(tc) {
  const td = el('td');
  const sel = el('select', { className: 'tst-cell-select' });
  CASE_TYPES.forEach(t => {
    sel.appendChild(el('option', { value: t }, t.replace(/_/g, ' ')));
  });
  sel.value = tc.case_type || 'happy_path';
  sel.addEventListener('change', async () => {
    try {
      await updateTc(tc, { case_type: sel.value });
      tc.case_type = sel.value;
    } catch (err) { showToast(`Save failed: ${err.message}`, 'error'); sel.value = tc.case_type; }
  });
  td.appendChild(sel);
  return td;
}

async function addTc(scope, scopeEntityId, blockEl) {
  try {
    const created = await apiFetch(`/projects/${_projectId}/test-cases`, {
      method: 'POST',
      body: JSON.stringify({
        scope, scope_entity_id: scopeEntityId,
        title: 'New test case — click to edit',
        test_action: '', test_input: '', expected_result: '',
        case_type: 'happy_path', source: 'user_added', status: 'draft',
      }),
    });
    // Re-render the block — simplest path; we just re-pull the scope items.
    renderTcView();
    showToast('Test case added — fill in the row, blur to save.', 'success');
  } catch (err) { showToast(`Add failed: ${err.message}`, 'error'); }
}

async function updateTc(tc, fields) {
  return await apiFetch(`/projects/${_projectId}/test-cases/${tc.test_case_id}`, {
    method: 'PUT',
    body:   JSON.stringify(fields),
  });
}

// ─── Coverage view: requirement × case-type matrix ──────────────────────────
const CASE_TYPE_LABELS = {
  happy_path: 'Happy', edge_case: 'Edge', negative: 'Negative',
  regression: 'Regression', performance: 'Performance',
};

async function renderCoverageView() {
  _reportArea.innerHTML = '';

  // Toolbar: summary + AI-suggest action
  const toolbar = el('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;' });
  const summaryEl = el('div', { style: 'color:var(--text-muted,#64748b);font-size:13px;flex:1;min-width:240px;' }, 'Loading coverage…');
  const aiBtn = el('button', { className: 'btn btn-secondary btn-sm' }, '🤖 AI: suggest test → requirement links');
  toolbar.appendChild(summaryEl);
  toolbar.appendChild(aiBtn);
  _reportArea.appendChild(toolbar);

  const tableWrap = el('div');
  _reportArea.appendChild(tableWrap);

  async function load() {
    tableWrap.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading…</span></div>';
    const data = await apiFetch(`/projects/${_projectId}/test-coverage`);
    const { case_types, requirements, summary } = data;
    summaryEl.textContent =
      `${summary.requirements_with_any_tc}/${summary.total_requirements} requirements have tests · ` +
      `${summary.test_cases_with_link}/${summary.total_test_cases} test cases linked`;

    tableWrap.innerHTML = '';
    if (!requirements.length) {
      tableWrap.appendChild(el('div', { className: 'empty-state', style: 'margin:40px 0' },
        el('div', { className: 'empty-state-icon' }, '🧪'),
        el('h3', {}, 'No requirements yet'),
        el('p', {}, 'Add functional or non-functional requirements first.')));
      return;
    }

    const tbl = el('table', { className: 'tst-tc-table' });
    const headCells = ['<th style="width:34%">Requirement</th>']
      .concat(case_types.map(ct => `<th style="text-align:center">${CASE_TYPE_LABELS[ct] || ct}</th>`))
      .concat(['<th style="text-align:center;width:60px">Total</th>', '<th style="width:90px"></th>']);
    tbl.innerHTML = `<thead><tr>${headCells.join('')}</tr></thead>`;
    const tbody = el('tbody');

    requirements.forEach(r => {
      const tr = el('tr');
      const reqCell = el('td');
      reqCell.appendChild(el('span', { className: 'tst-req-tag', title: r.req_type }, r.slug));
      reqCell.appendChild(el('span', { style: 'margin-left:6px' }, r.title || ''));
      tr.appendChild(reqCell);

      case_types.forEach(ct => {
        const n = r.counts[ct] || 0;
        const td = el('td', {
          style: 'text-align:center;font-weight:600;' +
            (n === 0
              ? 'background:#fef2f2;color:#dc2626;'    // gap
              : 'background:#f0fdf4;color:#16a34a;'),
          title: n === 0 ? `No ${CASE_TYPE_LABELS[ct] || ct} test for ${r.slug}` : `${n} ${CASE_TYPE_LABELS[ct] || ct} test(s)`,
        }, n === 0 ? '—' : String(n));
        tr.appendChild(td);
      });

      tr.appendChild(el('td', { style: 'text-align:center;font-weight:700;' + (r.total === 0 ? 'color:#dc2626' : '') }, String(r.total)));

      const actionTd = el('td');
      const manageBtn = el('button', { className: 'btn btn-ghost btn-sm' }, 'Manage…');
      manageBtn.addEventListener('click', () => openTcLinkModal(r, load));
      actionTd.appendChild(manageBtn);
      tr.appendChild(actionTd);

      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    tableWrap.appendChild(tbl);
  }

  aiBtn.addEventListener('click', async () => {
    aiBtn.disabled = true; const orig = aiBtn.textContent; aiBtn.textContent = '🤖 Suggesting…';
    try {
      const r = await apiFetch(`/projects/${_projectId}/test-coverage/infer`, { method: 'POST', body: JSON.stringify({}) });
      if (r.source === 'stub') {
        showToast('AI key not configured — no links suggested (set ANTHROPIC_API_KEY).', 'warning');
      } else {
        showToast(`AI linked ${r.test_cases_updated} test case(s) — ${r.links_added} link(s) added.`, 'success');
      }
      await load();
    } catch (err) {
      showToast(`AI suggest failed: ${err.message}`, 'error');
    } finally {
      aiBtn.disabled = false; aiBtn.textContent = orig;
    }
  });

  await load();
}

// ─── Per-requirement test-case link/unlink modal (#2) ───────────────────────
async function openTcLinkModal(requirement, onSaved) {
  const overlay = el('div', { className: 'dr-edit-overlay', style: 'position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:1000;' });
  const modal = el('div', { style: 'background:#fff;border-radius:12px;max-width:760px;width:92%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.3);' });

  modal.appendChild(el('div', { style: 'padding:16px 20px;border-bottom:1px solid #e2e8f0;' },
    el('div', { style: 'font-size:16px;font-weight:700;' }, `Link test cases — ${requirement.slug}`),
    el('div', { style: 'font-size:13px;color:#64748b;margin-top:2px;' }, requirement.title || '')));

  // Case-type filter
  const filterBar = el('div', { style: 'padding:10px 20px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #f1f5f9;' });
  filterBar.appendChild(el('span', { style: 'font-size:12px;color:#64748b;' }, 'Filter:'));
  let typeFilter = 'all';
  const body = el('div', { style: 'padding:8px 20px;overflow:auto;flex:1;' });

  modal.appendChild(filterBar);
  modal.appendChild(body);

  const footer = el('div', { style: 'padding:12px 20px;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:8px;' });
  const closeBtn = el('button', { className: 'btn btn-primary' }, 'Done');
  footer.appendChild(closeBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); if (onSaved) onSaved(); };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  // Load all project test cases (across scopes)
  let allTcs = [];
  try { allTcs = await apiFetch(`/projects/${_projectId}/test-cases`); }
  catch (err) { body.innerHTML = `<div class="error-state">Could not load test cases: ${escHtml(err.message)}</div>`; return; }

  const parse = v => { try { return Array.isArray(v) ? v : JSON.parse(v || '[]'); } catch { return []; } };

  const renderList = () => {
    body.innerHTML = '';
    const rows = allTcs.filter(tc => typeFilter === 'all' || (tc.case_type || 'happy_path') === typeFilter);
    if (!rows.length) { body.appendChild(el('div', { style: 'color:#64748b;padding:16px;' }, 'No test cases for this filter.')); return; }
    rows.forEach(tc => {
      const linked = parse(tc.requirement_ids).includes(requirement.slug);
      const row = el('label', { style: 'display:flex;align-items:flex-start;gap:10px;padding:8px;border-bottom:1px solid #f1f5f9;cursor:pointer;' });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = linked;
      cb.addEventListener('change', async () => {
        cb.disabled = true;
        try {
          const cur = parse(tc.requirement_ids);
          const next = cb.checked ? [...new Set([...cur, requirement.slug])] : cur.filter(s => s !== requirement.slug);
          await updateTc(tc, { requirement_ids: next });
          tc.requirement_ids = next;
        } catch (err) { showToast(`Update failed: ${err.message}`, 'error'); cb.checked = !cb.checked; }
        finally { cb.disabled = false; }
      });
      row.appendChild(cb);
      const meta = el('div', { style: 'flex:1;' });
      meta.appendChild(el('div', { style: 'font-weight:600;font-size:13px;' }, tc.title || '(untitled)'));
      const sub = el('div', { style: 'font-size:11px;color:#64748b;margin-top:2px;' });
      sub.appendChild(el('span', { className: 'tst-pill', style: 'margin-right:6px;' }, (CASE_TYPE_LABELS[tc.case_type] || tc.case_type || 'happy')));
      sub.appendChild(el('span', {}, (tc.expected_result || tc.test_action || '').slice(0, 90)));
      meta.appendChild(sub);
      row.appendChild(meta);
      body.appendChild(row);
    });
  };

  // Filter chips
  ['all', 'happy_path', 'edge_case', 'negative', 'regression', 'performance'].forEach(ct => {
    const chip = el('button', { className: 'btn btn-ghost btn-sm', 'data-ct': ct },
      ct === 'all' ? 'All' : (CASE_TYPE_LABELS[ct] || ct));
    chip.addEventListener('click', () => {
      typeFilter = ct;
      [...filterBar.querySelectorAll('button')].forEach(b => b.classList.toggle('active', b.dataset.ct === ct));
      renderList();
    });
    filterBar.appendChild(chip);
  });

  renderList();
}

// ─── shared widgets ─────────────────────────────────────────────────────────

const SOURCE_LABELS = { generated: 'AI draft', user_added: 'User added', user_edited: 'User edited' };
function sourcePill(source) {
  const cls = source === 'generated' ? 'tst-pill-generated'
            : source === 'user_added' ? 'tst-pill-user'
            : 'tst-pill-edited';
  return el('span', { className: `tst-pill ${cls}` }, SOURCE_LABELS[source] || source);
}

const STATUS_OPTIONS = ['draft', 'approved', 'rejected'];
function statusPill(status, onChange) {
  const wrap = el('span', { className: 'tst-status-wrap' });
  const sel = el('select', { className: 'tst-status-select tst-status-' + (status || 'draft') });
  STATUS_OPTIONS.forEach(s => {
    sel.appendChild(el('option', { value: s }, s));
  });
  sel.value = status || 'draft';
  sel.addEventListener('change', async () => {
    sel.className = 'tst-status-select tst-status-' + sel.value;
    try { await onChange(sel.value); }
    catch (err) { showToast(`Save failed: ${err.message}`, 'error'); }
  });
  wrap.appendChild(sel);
  return wrap;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function groupBy(rows, key) {
  const out = {};
  rows.forEach(r => {
    const k = r[key];
    if (!out[k]) out[k] = [];
    out[k].push(r);
  });
  return out;
}

// ─── styles ─────────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('tst-styles')) return;
  const s = document.createElement('style');
  s.id = 'tst-styles';
  s.textContent = `
.tst-controls {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.tst-toggle {
  display: inline-flex;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
}
.tst-toggle-btn {
  background: none; border: none; padding: 7px 14px;
  font-size: 13px; font-weight: 600; cursor: pointer;
  color: var(--color-text-muted);
}
.tst-toggle-btn.active {
  background: var(--color-accent);
  color: #fff;
}

.tst-section-title {
  font-size: 14px; font-weight: 700; margin: 4px 0 12px;
  color: var(--color-text-primary);
  border-bottom: 2px solid var(--color-border);
  padding-bottom: 6px;
}

.tst-scope-bar {
  display: flex; gap: 6px; flex-wrap: wrap;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 8px;
}
.tst-scope-btn {
  background: none; border: 1px solid var(--color-border);
  padding: 6px 12px; font-size: 12px; font-weight: 600;
  border-radius: 4px; cursor: pointer;
  color: var(--color-text-muted);
}
.tst-scope-btn.active {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: #fff;
}

.tst-block {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  margin-bottom: 16px;
  padding: 14px 16px;
}
.tst-block-header { margin-bottom: 10px; }
.tst-block-title {
  font-size: 14px; font-weight: 700;
  color: var(--color-text-primary);
}
.tst-block-subtitle {
  font-size: 12px; color: var(--color-text-muted); margin-top: 2px;
}

.tst-empty-row {
  padding: 10px 0;
  font-size: 12px; font-style: italic;
  color: var(--color-text-faint);
}

.tst-ac-list { display: flex; flex-direction: column; gap: 4px; }
.tst-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
}
.tst-row:hover { background: var(--color-bg); }
.tst-row-text {
  flex: 1;
  font-size: 13px;
  line-height: 1.4;
  padding: 4px 6px;
  border-radius: 4px;
  border: 1px solid transparent;
  outline: none;
  min-height: 22px;
}
.tst-row-text:focus { border-color: var(--color-accent); background: #fff; }
.tst-row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.tst-row-delete {
  background: none; border: none; cursor: pointer;
  font-size: 14px; color: var(--color-text-faint);
  padding: 2px 6px; border-radius: 4px;
}
.tst-row-delete:hover { background: #fee2e2; color: #b91c1c; }

.tst-tc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin-bottom: 8px;
}
.tst-tc-table th {
  text-align: left;
  padding: 6px 8px;
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
  font-size: 11px; font-weight: 700;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.tst-tc-table td {
  vertical-align: top;
  padding: 4px 6px;
  border-bottom: 1px solid var(--color-border);
}
.tst-cell-editable {
  padding: 4px 6px;
  border-radius: 4px;
  border: 1px solid transparent;
  outline: none;
  min-height: 20px;
  white-space: pre-wrap;
}
.tst-cell-editable:focus { border-color: var(--color-accent); background: #fff; }
.tst-cell-strong { font-weight: 600; color: var(--color-text-primary); }
.tst-cell-select {
  font-size: 11px;
  padding: 2px 4px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: #fff;
  text-transform: capitalize;
}

.tst-pill {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  white-space: nowrap;
}
.tst-pill-generated { background: #ede9fe; color: #6d28d9; }
.tst-pill-user      { background: #dbeafe; color: #1d4ed8; }
.tst-pill-edited    { background: #fef3c7; color: #92400e; }

.tst-req-tag {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 10px;
  background: #dcfce7;
  color: #166534;
  white-space: nowrap;
  cursor: default;
}

.tst-status-wrap { display: inline-block; }
.tst-status-select {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: #fff;
  text-transform: capitalize;
  cursor: pointer;
}
.tst-status-draft    { background: #f3f4f6; color: #4b5563; }
.tst-status-approved { background: #dcfce7; color: #166534; }
.tst-status-rejected { background: #fee2e2; color: #991b1b; }

.tst-add-btn { margin-top: 8px; }
`;
  document.head.appendChild(s);
}
