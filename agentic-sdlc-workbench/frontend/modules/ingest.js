/**
 * modules/ingest.js — Document Ingestion
 *
 * Users submit source documents for AI agent processing.
 * The agent extracts structured entities, raises clarifying questions for anything
 * below the application's confidence threshold, and loops until confident.
 * Staged extractions are reviewed by the user, then promoted to Change Packets.
 */
import {
  apiFetch, tag, statusTag, formatDateTime,
  el, escHtml, showToast, getCurrentProjectId, getCurrentUserId,
} from '../app.js';

const DOC_TYPES = [
  { id: 'requirements_doc',     label: 'Requirements Document' },
  { id: 'interview_transcript', label: 'Interview / Workshop Transcript' },
  { id: 'process_map',          label: 'Process Map' },
  { id: 'policy_document',      label: 'Policy / Governance Document' },
  { id: 'technical_spec',       label: 'Technical Specification' },
  { id: 'as_is_analysis',       label: 'As-Is Analysis' },
  { id: 'to_be_design',         label: 'To-Be Design' },
  { id: 'test_plan',            label: 'Test Plan' },
  { id: 'other',                label: 'Other' },
];

const ENTITY_LABELS = {
  use_case:          'Use Case',
  process_segment:   'Process Segment',
  workflow:          'Workflow',
  workflow_step:     'Workflow Step',
  agent_spec:        'Agent Spec',
  guardrail:         'Guardrail',
  hitl_gate:         'HITL Gate',
  data_source:       'Data Source',
  user_story:        'User Story',
  governance_control:'Governance Control',
};

const STATUS_META = {
  pending:          { label: 'Pending',        variant: 'warn'   },
  processing:       { label: 'Processing',     variant: 'info'   },
  review_required:  { label: 'Needs Answers',  variant: 'warn'   },
  staged:           { label: 'Ready to Promote', variant: 'accent' },
  promoted:         { label: 'Promoted',       variant: 'ok'     },
  failed:           { label: 'Failed',         variant: 'danger' },
};

function ingestTag(status) {
  const m = STATUS_META[status] || { label: status || '—', variant: 'muted' };
  return tag(m.label, m.variant);
}

function entityName(type, data) {
  if (!data) return type;
  return data.use_case_name || data.workflow_name || data.step_name ||
         data.rule_name || data.segment_name || data.source_name ||
         data.agent_name || data.gate_name || data.control_name ||
         (data.role && data.want ? `${data.role}: ${data.want}` : null) ||
         type;
}

// ── Module state ──────────────────────────────────────────────────────────────
let allDocs = [];
let filterStatus = '';
let filterType   = '';
let filterArchived = false;   // when true, the catalog shows cancelled docs
let _processingPoll = null;   // active setInterval id while a doc is 'processing'

// ── Processing poll lifecycle ─────────────────────────────────────────────────
// While a document is 'processing', poll its status every few seconds and re-render
// the detail pane the moment it resolves (staged | review_required | failed). A new
// renderDetail (or navigating away) supersedes any prior poll.
function stopProcessingPoll() {
  if (_processingPoll) { clearInterval(_processingPoll); _processingPoll = null; }
}
function startProcessingPoll(doc, pane) {
  stopProcessingPoll();
  _processingPoll = setInterval(async () => {
    // Navigated away — the pane was detached. Stop polling.
    if (!document.body.contains(pane)) { stopProcessingPoll(); return; }
    let fresh;
    try { fresh = await apiFetch(`/ingest-documents/${doc.ingest_id}`); }
    catch { return; }   // transient network error — keep polling
    if (fresh && fresh.ingest_status !== 'processing') {
      stopProcessingPoll();
      const cb = document.getElementById('ingest-catalog-body');
      if (cb) refreshCatalog(cb, pane).catch(() => {});   // update the left-list status chip
      renderDetail(fresh, pane);                           // render the resolved state
    }
  }, 4000);
}

// ── Render ────────────────────────────────────────────────────────────────────
export async function render(container) {
  container.innerHTML = '';
  allDocs        = [];
  filterStatus   = '';
  filterType     = '';
  filterArchived = false;

  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'Ingest Documents'),
    el('p', { className: 'purpose-text' },
      'Submit source documents for AI agent processing. The agent extracts structured design ' +
      'entities, asks clarifying questions for anything ambiguous, and loops until it meets your ' +
      'application\'s confidence threshold. You review the staged results, then promote them to ' +
      'Change Packets — nothing touches the database until a human approves.'
    )
  ));

  container.appendChild(buildSubmitPanel());

  const layout   = el('div', { className: 'two-pane', style: { marginTop: '20px' } });
  const paneLeft = el('div', { className: 'pane-left'  });
  const paneRight = el('div', { className: 'pane-right', id: 'ingest-detail' });
  emptyDetailPane(paneRight);

  layout.appendChild(paneLeft);
  layout.appendChild(paneRight);
  container.appendChild(layout);

  await buildCatalog(paneLeft, paneRight);
}

function emptyDetailPane(pane) {
  pane.innerHTML = `
    <div class="empty-state" style="height:100%">
      <div class="empty-state-icon">📄</div>
      <h3>Select a document</h3>
      <p>Click a row to view processing details, answer clarification questions, and promote extractions.</p>
    </div>`;
}

// ── Submit panel ──────────────────────────────────────────────────────────────
function buildSubmitPanel() {
  const panel = el('div', { className: 'panel' });
  panel.appendChild(el('div', { className: 'panel-header' },
    el('span', { className: 'panel-title' }, 'Submit for Analysis'),
    el('span', { style: { fontSize: '11px', color: 'var(--color-text-muted)' } },
      'Upload a document file OR type requirements directly — Claude will extract structured design entities and generate Change Packets'
    )
  ));
  const body = el('div', { className: 'panel-body' });

  // Row 1: application / type / title
  const row1 = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '12px' } });

  const appGroup = el('div', { className: 'form-group', style: { margin: 0 } });
  appGroup.appendChild(el('label', { className: 'form-label' }, 'Application *'));
  const appSelect = el('select', { className: 'form-select', id: 'ingest-app-select' });
  appSelect.innerHTML = '<option value="">— Select Application —</option>';
  apiFetch('/projects').then(data => {
    const ps = Array.isArray(data) ? data : (data.items || []);
    ps.forEach(p => appSelect.appendChild(el('option', { value: p.project_id },
      `${p.client_name ? p.client_name + ' — ' : ''}${p.project_name}`)));
    const active = getCurrentProjectId();
    if (active) appSelect.value = active;
  }).catch(() => {});
  appGroup.appendChild(appSelect);

  const typeGroup = el('div', { className: 'form-group', style: { margin: 0 } });
  typeGroup.appendChild(el('label', { className: 'form-label' }, 'Document Type *'));
  const typeSelect = el('select', { className: 'form-select' });
  DOC_TYPES.forEach(dt => typeSelect.appendChild(el('option', { value: dt.id }, dt.label)));
  typeGroup.appendChild(typeSelect);

  const titleGroup = el('div', { className: 'form-group', style: { margin: 0 } });
  titleGroup.appendChild(el('label', { className: 'form-label' }, 'Title *'));
  const titleInput = el('input', { type: 'text', className: 'form-input',
    placeholder: 'e.g. "Add PO lookup to Invoice agent"' });
  titleGroup.appendChild(titleInput);

  row1.appendChild(appGroup);
  row1.appendChild(typeGroup);
  row1.appendChild(titleGroup);
  body.appendChild(row1);

  // Row 2: description + scope (two halves)
  const row2 = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' } });

  const descGroup = el('div', { className: 'form-group', style: { margin: 0 } });
  descGroup.appendChild(el('label', { className: 'form-label' }, 'Description / Notes'));
  const descInput = el('textarea', { className: 'form-input', rows: '2',
    style: { resize: 'vertical', minHeight: '58px' },
    placeholder: 'What does this cover? Who provided it? Any context for Claude.' });
  descGroup.appendChild(descInput);

  const scopeGroup = el('div', { className: 'form-group', style: { margin: 0 } });
  scopeGroup.appendChild(el('label', { className: 'form-label' }, 'Design Area (for targeted updates)'));
  const scopeSelect = el('select', { className: 'form-select' });
  scopeSelect.innerHTML = `
    <option value="all">Whole Application (let Claude decide)</option>
    <option value="use_case">Use Case / Objectives</option>
    <option value="workflow">Workflow / Process Steps</option>
    <option value="agent_spec">Agent Specifications</option>
    <option value="tools">Tools &amp; Integrations</option>
    <option value="guardrails">Guardrails &amp; Constraints</option>
    <option value="data_sources">Data Sources</option>
    <option value="test_scenarios">Test Scenarios</option>
    <option value="governance">Governance Controls</option>
    <option value="user_stories">User Stories</option>
    <option value="data_model">Data Model / Schema (ServiceNow)</option>
    <option value="form_design">Forms &amp; UI (ServiceNow)</option>
    <option value="business_logic">Business Logic (ServiceNow)</option>
    <option value="catalog_item">Catalog Items (ServiceNow)</option>
  `;
  scopeGroup.appendChild(scopeSelect);

  row2.appendChild(descGroup);
  row2.appendChild(scopeGroup);
  body.appendChild(row2);

  // AI mode dial — Faithful (transcribe only) ⟷ Suggestive (propose best-practice additions).
  const modeGroupNew = el('div', { className: 'form-group', style: { margin: '0 0 16px 0' } });
  modeGroupNew.appendChild(el('label', { className: 'form-label' }, 'AI mode'));
  const modeSelectNew = el('select', { className: 'form-select', style: { maxWidth: '520px' } });
  [
    ['faithful',   'Faithful — extract only what the document states'],
    ['balanced',   'Balanced — also fill obviously-implied empty fields'],
    ['suggestive', 'Suggestive — also propose best-practice additions (✨ flagged for review)'],
  ].forEach(([v, l]) => modeSelectNew.appendChild(el('option', { value: v }, l)));
  modeGroupNew.appendChild(modeSelectNew);
  body.appendChild(modeGroupNew);

  // Row 3: file drop zone  —OR—  text entry (side by side)
  const inputRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '0', alignItems: 'stretch', marginBottom: '16px' } });

  // ── Left: file drop zone ──────────────────────────────────────────────
  let droppedFile = null;

  const dropZone = el('div', { className: 'drop-zone', style: { cursor: 'pointer', minHeight: '110px', borderRadius: 'var(--radius) 0 0 var(--radius)', borderRight: 'none' } });
  const dropLabel = el('div', { className: 'drop-zone-label' }, 'Drop file here or click to browse');
  const dropIcon  = el('div', { className: 'drop-zone-icon', style: { fontSize: '22px' } }, '📎');
  dropZone.appendChild(dropIcon);
  dropZone.appendChild(dropLabel);
  dropZone.appendChild(el('div', { className: 'drop-zone-sub' }, 'DOCX · TXT · CSV · MP3 · WAV'));

  const fileInput = el('input', { type: 'file', accept: '.docx,.txt,.csv,.mp3,.wav,.m4a', style: { display: 'none' } });
  body.appendChild(fileInput);

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) setDroppedFile(fileInput.files[0]);
  });
  ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault(); dropZone.classList.add('drag-over');
  }));
  ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    if (ev === 'drop' && e.dataTransfer?.files[0]) setDroppedFile(e.dataTransfer.files[0]);
  }));

  function setDroppedFile(f) {
    droppedFile = f;
    dropIcon.textContent = '📄';
    dropLabel.textContent = f.name;
    dropLabel.style.fontWeight = '600';
    dropLabel.style.color = 'var(--color-text)';
    if (!titleInput.value) titleInput.value = f.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
    // Dim the text area to signal mutual exclusivity
    reqTextarea.disabled = true;
    reqTextarea.style.opacity = '0.4';
    reqTextarea.placeholder = 'Clear the attached file to type directly instead';
  }

  function resetFile() {
    droppedFile = null;
    fileInput.value = '';
    dropIcon.textContent = '📎';
    dropLabel.textContent = 'Drop file here or click to browse';
    dropLabel.style.fontWeight = '';
    dropLabel.style.color = '';
    reqTextarea.disabled = false;
    reqTextarea.style.opacity = '';
    reqTextarea.placeholder = reqPlaceholder;
  }

  // ── Divider ────────────────────────────────────────────────────────────
  const divider = el('div', { style: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    padding: '0 12px',
    color: 'var(--color-text-muted)',
    fontSize: '11px', fontWeight: '600', letterSpacing: '.5px',
    gap: '6px',
  }});
  const divLine = (vertical) => el('div', { style: {
    flex: '1',
    width: vertical ? '1px' : '100%',
    height: vertical ? '100%' : '1px',
    background: 'var(--color-border)',
  }});
  divider.appendChild(divLine(true));
  divider.appendChild(el('span', {}, 'OR'));
  divider.appendChild(divLine(true));

  // ── Right: text entry ──────────────────────────────────────────────────
  const reqPlaceholder =
    'Type or paste requirements directly:\n' +
    '• "The agent should also handle PO status lookup via SAP MM. Owner: Bryan Burnside. SLA: 2 min."\n' +
    '• "Add a HITL gate before posting work notes with dollar amounts. Approver: Finance Manager."\n' +
    '• "Remove the guardrail blocking SAP IH module — integration is now approved."';

  const textSide = el('div', { style: { display: 'flex', flexDirection: 'column' } });
  const textLabel = el('label', { className: 'form-label', style: { marginBottom: '4px' } }, 'Or type / paste requirements:');
  const reqTextarea = el('textarea', {
    className: 'form-input',
    style: {
      flex: '1', resize: 'vertical', minHeight: '110px',
      fontFamily: 'inherit', fontSize: '12px', lineHeight: '1.6',
      borderRadius: '0 var(--radius) var(--radius) 0',
    },
    placeholder: reqPlaceholder,
  });

  // When text is typed, indicate file would be ignored
  reqTextarea.addEventListener('input', () => {
    if (reqTextarea.value.trim() && droppedFile) {
      // file takes priority — just leave as-is, file wins
    }
  });

  // Clear file link below the drop zone
  const clearFileLink = el('button', { style: {
    background: 'none', border: 'none', color: 'var(--color-accent)',
    fontSize: '11px', cursor: 'pointer', padding: '4px 0 0', textDecoration: 'underline',
    display: 'none',
  }}, '✕ Clear file');
  clearFileLink.addEventListener('click', () => {
    resetFile();
    clearFileLink.style.display = 'none';
  });

  // Override setDroppedFile to also show the clear link
  const _orig = setDroppedFile;
  // patch: show clear link when file attached
  fileInput.addEventListener('change', () => { clearFileLink.style.display = 'inline'; });
  dropZone.addEventListener('drop', () => { clearFileLink.style.display = 'inline'; });

  const leftCol = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
  leftCol.appendChild(dropZone);
  leftCol.appendChild(clearFileLink);

  textSide.appendChild(textLabel);
  textSide.appendChild(reqTextarea);

  inputRow.appendChild(leftCol);
  inputRow.appendChild(divider);
  inputRow.appendChild(textSide);
  body.appendChild(inputRow);

  // Submit button row
  const btnRow = el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } });
  const submitBtn = el('button', { className: 'btn btn-primary' }, '↑ Submit for Analysis');
  submitBtn.addEventListener('click', () =>
    doSubmit(appSelect, typeSelect, titleInput, descInput, scopeSelect,
             () => droppedFile, reqTextarea, resetFile, submitBtn));
  btnRow.appendChild(submitBtn);
  btnRow.appendChild(el('span', { className: 'text-muted text-sm' },
    'Queued documents appear in the catalog below. Click "Start Extraction" to process with Claude.'
  ));
  body.appendChild(btnRow);

  panel.appendChild(body);
  return panel;
}


async function doSubmit(appSelect, typeSelect, titleInput, descInput, scopeSelect, getFile, reqTextarea, resetFile, btn) {
  if (!appSelect.value)         { showToast('Select an application first.', 'error'); return; }
  if (!titleInput.value.trim()) { showToast('Enter a title.', 'error'); return; }

  const droppedFile = getFile();
  const rawText     = reqTextarea?.value?.trim() || null;

  // Must have either a file or some typed text
  if (!droppedFile && !rawText) {
    showToast('Attach a file or type requirements before submitting.', 'error');
    return;
  }

  btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    let fetchOpts;

    if (droppedFile) {
      // ── multipart/form-data — file takes priority ─────────────────────────
      const fd = new FormData();
      fd.append('file',           droppedFile);
      fd.append('project_id',     appSelect.value);
      fd.append('document_title', titleInput.value.trim());
      fd.append('document_type',  typeSelect.value);
      fd.append('file_name',      droppedFile.name);
      fd.append('file_type',      droppedFile.name.split('.').pop().toLowerCase());
      if (descInput.value.trim()) fd.append('description', descInput.value.trim());
      fd.append('enrichment_level', modeSelectNew.value);
      fetchOpts = { method: 'POST', body: fd };
    } else {
      // ── JSON — typed/pasted text, prepend scope hint if set ───────────────
      const scope = scopeSelect?.value || 'all';
      const fullText = (scope !== 'all')
        ? `[Design area: ${scope}]\n\n${rawText}`
        : rawText;
      fetchOpts = {
        method: 'POST',
        body: JSON.stringify({
          project_id:     appSelect.value,
          document_title: titleInput.value.trim(),
          document_type:  typeSelect.value,
          description:    descInput.value.trim() || null,
          raw_text:       fullText,
          enrichment_level: modeSelectNew.value,
        }),
      };
    }

    await apiFetch('/ingest-documents', fetchOpts);
    showToast(`"${titleInput.value.trim()}" queued for analysis.`, 'success');
    titleInput.value  = '';
    descInput.value   = '';
    if (reqTextarea) reqTextarea.value = '';
    if (scopeSelect) scopeSelect.value = 'all';
    resetFile();
    const catalogBody = document.getElementById('ingest-catalog-body');
    const detail      = document.getElementById('ingest-detail');
    if (catalogBody && detail) await refreshCatalog(catalogBody, detail);
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '↑ Submit for Analysis';
  }
}

// ── Catalog list ──────────────────────────────────────────────────────────────
async function buildCatalog(paneLeft, paneRight) {
  paneLeft.appendChild(el('div', { className: 'pane-header' },
    el('span', { className: 'pane-title' }, 'Document Catalog')
  ));

  const filterBar = el('div', { className: 'filter-bar' });
  const statusSel = el('select', { className: 'filter-select' });
  statusSel.innerHTML = '<option value="">All Statuses</option>';
  Object.entries(STATUS_META).forEach(([k, v]) =>
    statusSel.appendChild(el('option', { value: k }, v.label)));
  const typeSel = el('select', { className: 'filter-select' });
  typeSel.innerHTML = '<option value="">All Types</option>';
  DOC_TYPES.forEach(dt => typeSel.appendChild(el('option', { value: dt.id }, dt.label)));

  statusSel.addEventListener('change', () => { filterStatus = statusSel.value; renderCatalog(catalogBody, paneRight); });
  typeSel.addEventListener('change',   () => { filterType   = typeSel.value;   renderCatalog(catalogBody, paneRight); });

  // Archived / cancelled toggle — re-fetches because cancelled docs are excluded server-side by default
  const archChk = el('input', { type: 'checkbox' });
  archChk.addEventListener('change', () => { filterArchived = archChk.checked; refreshCatalog(catalogBody, paneRight); });
  const archLabel = el('label',
    { className: 'filter-archived', style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--color-text-muted)' } },
    archChk, 'Show cancelled');

  filterBar.appendChild(statusSel);
  filterBar.appendChild(typeSel);
  filterBar.appendChild(archLabel);
  paneLeft.appendChild(filterBar);

  const catalogBody = el('div', { className: 'pane-body', id: 'ingest-catalog-body' });
  catalogBody.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
  paneLeft.appendChild(catalogBody);

  await refreshCatalog(catalogBody, paneRight);
}

async function refreshCatalog(catalogBody, paneRight) {
  catalogBody.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
  try {
    const params = new URLSearchParams();
    const active = getCurrentProjectId();
    if (active) params.set('project_id', active);
    if (filterArchived) params.set('archived', '1');
    const data = await apiFetch(`/ingest-documents?${params}`);
    allDocs = Array.isArray(data) ? data : (data.items || []);
    renderCatalog(catalogBody, paneRight);
  } catch (err) {
    catalogBody.innerHTML = `<div class="error-state"><strong>Error:</strong> ${escHtml(err.message)}</div>`;
  }
}

function renderCatalog(catalogBody, paneRight) {
  catalogBody.innerHTML = '';
  const filtered = allDocs.filter(d => {
    if (filterStatus && d.ingest_status !== filterStatus) return false;
    if (filterType   && d.document_type   !== filterType)   return false;
    return true;
  });

  if (filtered.length === 0) {
    catalogBody.innerHTML = `<div class="empty-state"><p>${filterArchived ? 'No cancelled documents.' : 'No documents found.'}</p></div>`;
    return;
  }

  const table = el('table', { className: 'wf-table' });
  table.innerHTML = `<thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Submitted</th></tr></thead>`;
  const tbody = el('tbody');

  filtered.forEach(d => {
    const typeLabel = DOC_TYPES.find(t => t.id === d.document_type)?.label || d.document_type || '—';
    const tr = el('tr', { className: 'clickable' },
      el('td', { style: { fontWeight: '500' } }, d.document_title),
      el('td', {}, tag(typeLabel, 'info')),
      el('td', {}, d.lifecycle_status === 'cancelled' ? tag('Cancelled', 'danger') : ingestTag(d.ingest_status)),
      el('td', { className: 'muted' }, formatDateTime(d.uploaded_at))
    );
    tr.addEventListener('click', () => {
      document.querySelectorAll('.ingest-row-active').forEach(r => r.classList.remove('ingest-row-active'));
      tr.classList.add('ingest-row-active');
      renderDetail(d, paneRight);
    });
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  catalogBody.appendChild(table);
}

// ── Detail pane ───────────────────────────────────────────────────────────────
async function renderDetail(doc, pane) {
  // A fresh render supersedes any in-flight processing poll (e.g. switching docs).
  stopProcessingPoll();
  pane.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';

  // Fetch live state + extractions + clarifications + AI usage in parallel
  let fresh = doc, extractions = [], clarifications = [], usage = [];
  try {
    [fresh, extractions, clarifications, usage] = await Promise.all([
      apiFetch(`/ingest-documents/${doc.ingest_id}`).catch(() => doc),
      apiFetch(`/ingest-documents/${doc.ingest_id}/extractions`).catch(() => []),
      apiFetch(`/ingest-documents/${doc.ingest_id}/clarifications`).catch(() => []),
      apiFetch(`/ingest-documents/${doc.ingest_id}/usage`).catch(() => []),
    ]);
  } catch { /* use defaults */ }

  pane.innerHTML = '';

  const header = el('div', { className: 'pane-header' },
    el('span', { className: 'pane-title' }, fresh.document_title),
    fresh.lifecycle_status === 'cancelled' ? tag('Cancelled', 'danger') : ingestTag(fresh.ingest_status)
  );
  pane.appendChild(header);

  const body = el('div', { className: 'pane-body' });

  // ── 1. Document info ────────────────────────────────────────────────────────
  const infoSec = el('div', { className: 'detail-section' });
  infoSec.appendChild(el('h4', {}, 'Document Information'));
  const grid = el('div', { className: 'meta-grid' });
  const typeLabel = DOC_TYPES.find(t => t.id === fresh.document_type)?.label || fresh.document_type || '—';
  const metaRows = [
    ['Application',   fresh.project_name || '—'],
    ['Document Type', typeLabel],
    ['File',          fresh.file_name || '—'],
    ['Submitted By',  fresh.uploaded_by_name || '—'],
    ['Submitted',     formatDateTime(fresh.uploaded_at)],
    ['CPs Generated', fresh.change_packets_generated ?? 0],
  ];
  // AI usage (token/cost) for this ingest — part of the audit trail
  if (Array.isArray(usage) && usage.length) {
    const tot = usage.reduce((a, u) => ({
      in:  a.in  + (u.input_tokens  || 0),
      out: a.out + (u.output_tokens || 0),
      cost: a.cost + (u.cost_usd || 0),
    }), { in: 0, out: 0, cost: 0 });
    const k = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    const model = usage[0].model || '';
    metaRows.push(['AI Usage',
      `${k(tot.in)} in / ${k(tot.out)} out${tot.cost ? ` · ~$${tot.cost.toFixed(3)}` : ''}${model ? ` · ${model}` : ''}`]);
  }
  metaRows.forEach(([k, v]) => {
    const item = el('div', { className: 'meta-item' }, el('div', { className: 'meta-key' }, k));
    item.appendChild(el('div', { className: 'meta-val' }, String(v)));
    grid.appendChild(item);
  });
  infoSec.appendChild(grid);
  if (fresh.description) {
    infoSec.appendChild(el('div', { className: 'section-divider' }));
    infoSec.appendChild(el('div', { className: 'section-label' }, 'Description'));
    infoSec.appendChild(el('p', { style: { fontSize: '13px', lineHeight: '1.6', marginTop: '6px' } }, fresh.description));
  }
  body.appendChild(infoSec);

  // ── 2. Source document (collapsible) ───────────────────────────────────────
  if (fresh.raw_text || fresh.file_path) {
    body.appendChild(buildSourceSection(fresh));
  }

  // ── 3. Status-dependent content ────────────────────────────────────────────
  // A cancelled doc is on hold: hide all action sections, show the cancelled
  // banner + restore instead.
  if (fresh.lifecycle_status === 'cancelled') {
    body.appendChild(buildCancelledSection(fresh, pane));
    pane.appendChild(body);
    return;
  }

  if (fresh.ingest_status === 'pending' || fresh.ingest_status === 'failed') {
    body.appendChild(buildTriggerSection(fresh, pane));

  } else if (fresh.ingest_status === 'processing') {
    body.appendChild(buildProcessingSection());
    startProcessingPoll(fresh, pane);   // auto-refresh when extraction resolves

  } else if (fresh.ingest_status === 'review_required') {
    const openQ = clarifications.filter(c => !c.answer_text);
    const answered = clarifications.filter(c => c.answer_text);
    const currentRound = openQ.length > 0 ? Math.max(...openQ.map(c => c.round)) : 1;

    // Staged so far
    if (extractions.some(e => e.status === 'staged')) {
      body.appendChild(buildExtractionsSection(
        extractions.filter(e => e.status === 'staged'), false, fresh, pane
      ));
    }

    // Previously answered rounds (collapsed summary)
    if (answered.length > 0) {
      body.appendChild(buildAnsweredSummary(answered));
    }

    // Current round questions
    body.appendChild(buildClarificationForm(fresh, openQ, currentRound, pane));

  } else if (fresh.ingest_status === 'staged') {
    body.appendChild(buildExtractionsSection(
      extractions.filter(e => e.status === 'staged'), true, fresh, pane
    ));

    // Show answered history
    if (clarifications.some(c => c.answer_text)) {
      body.appendChild(buildAnsweredSummary(clarifications.filter(c => c.answer_text)));
    }

  } else if (fresh.ingest_status === 'promoted') {
    body.appendChild(buildPromotedSection(fresh));
  }

  // ── 3. Cancel action — allowed any time before promote ──────────────────────
  if (fresh.ingest_status !== 'promoted') {
    body.appendChild(buildCancelAction(fresh, pane));
  }

  pane.appendChild(body);
}

// Cancel action (soft, reversible). Shown for any non-promoted, active document.
function buildCancelAction(doc, pane) {
  const sec = el('div', { className: 'detail-section' });
  const btn = el('button', { className: 'btn btn-secondary', style: { color: 'var(--color-danger)' } }, '✕ Cancel document');
  btn.addEventListener('click', async () => {
    if (!confirm('Cancel this document? It moves to the cancelled list and its extractions/questions are put on hold. You can restore it later.')) return;
    const reason = (prompt('Optional reason for cancelling (leave blank to skip):') || '').trim();
    btn.disabled = true; btn.textContent = 'Cancelling…';
    try {
      await apiFetch(`/ingest-documents/${doc.ingest_id}/cancel`, {
        method: 'POST', body: JSON.stringify({ reason }),
      });
      showToast('Document cancelled.', 'success');
      const cb = document.getElementById('ingest-catalog-body');
      if (cb) await refreshCatalog(cb, pane);
      await renderDetail(doc, pane);   // re-fetches fresh → now shows the cancelled banner
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
      btn.disabled = false; btn.textContent = '✕ Cancel document';
    }
  });
  sec.appendChild(btn);
  return sec;
}

// Banner shown for a cancelled document, with a Restore (un-cancel) action.
function buildCancelledSection(doc, pane) {
  const sec = el('div', { className: 'detail-section' });
  sec.appendChild(el('h4', {}, 'Cancelled'));
  sec.appendChild(el('p',
    { style: { fontSize: '13px', color: 'var(--color-text-muted)', marginBottom: '12px', lineHeight: '1.6' } },
    `This document was cancelled${doc.cancelled_by_name ? ' by ' + doc.cancelled_by_name : ''}` +
    `${doc.cancelled_at ? ' on ' + formatDateTime(doc.cancelled_at) : ''}. ` +
    'Its extractions and clarification questions are on hold and cannot be promoted until it is restored.'));
  if (doc.cancel_reason) {
    sec.appendChild(el('div', { className: 'section-label' }, 'Reason'));
    sec.appendChild(el('p', { style: { fontSize: '13px', marginTop: '4px', marginBottom: '12px' } }, doc.cancel_reason));
  }
  const restoreBtn = el('button', { className: 'btn btn-primary' }, '↻ Restore document');
  restoreBtn.addEventListener('click', async () => {
    restoreBtn.disabled = true; restoreBtn.textContent = 'Restoring…';
    try {
      await apiFetch(`/ingest-documents/${doc.ingest_id}/restore`, { method: 'POST' });
      showToast('Document restored.', 'success');
      const cb = document.getElementById('ingest-catalog-body');
      if (cb) await refreshCatalog(cb, pane);
      await renderDetail(doc, pane);   // re-fetches fresh → back to its normal state
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
      restoreBtn.disabled = false; restoreBtn.textContent = '↻ Restore document';
    }
  });
  sec.appendChild(restoreBtn);
  return sec;
}

// ── Section builders ──────────────────────────────────────────────────────────

function buildTriggerSection(doc, pane) {
  const sec = el('div', { className: 'detail-section' });
  sec.appendChild(el('h4', {}, 'AI Extraction'));

  const note = el('p', { style: { fontSize: '13px', color: 'var(--color-text-muted)', marginBottom: '14px' } },
    'Start the extraction process. The agent will analyse this document, extract structured design ' +
    'entities, and raise questions for anything it cannot determine with sufficient confidence.'
  );
  sec.appendChild(note);

  // ── AI mode dial: Faithful ⟷ Balanced ⟷ Suggestive ────────────────────────
  const modeGroup = el('div', { className: 'form-group', style: { margin: '0 0 14px 0', maxWidth: '460px' } });
  modeGroup.appendChild(el('label', { className: 'form-label' }, 'AI mode'));
  const modeSel = el('select', { className: 'form-select' });
  [
    ['faithful',   'Faithful — extract only what the document states'],
    ['balanced',   'Balanced — also fill obviously-implied empty fields'],
    ['suggestive', 'Suggestive — also propose best-practice additions (✨ flagged for review)'],
  ].forEach(([v, label]) => modeSel.appendChild(el('option', { value: v }, label)));
  modeSel.value = ['faithful', 'balanced', 'suggestive'].includes(doc.enrichment_level) ? doc.enrichment_level : 'faithful';
  modeGroup.appendChild(modeSel);
  modeGroup.appendChild(el('p', { style: { fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '4px' } },
    'Suggestive lets the AI Agent act as a design consultant — adding standard agentic NFRs, implied data ' +
    'sources, and richer detail, each flagged ✨ system-generated so you can keep or delete it.'));
  sec.appendChild(modeGroup);

  if (doc.ingest_status === 'failed') {
    const failBox = el('div', { style: {
      color: 'var(--color-danger)', fontSize: '13px', marginBottom: '10px',
      background: 'var(--color-bg)', border: '1px solid var(--color-danger, #C62828)',
      borderLeft: '3px solid var(--color-danger, #C62828)', borderRadius: 'var(--radius)', padding: '10px 12px',
    } });
    failBox.appendChild(el('div', { style: { fontWeight: '600', marginBottom: doc.processing_notes ? '4px' : '0' } },
      '⚠ Previous run failed. You can re-queue the document below.'));
    if (doc.processing_notes) {
      failBox.appendChild(el('div', { style: { fontWeight: '400', whiteSpace: 'pre-wrap' } }, doc.processing_notes));
    }
    sec.appendChild(failBox);
  }

  const startBtn = el('button', { className: 'btn btn-primary' },
    doc.ingest_status === 'failed' ? '▶ Re-run Extraction' : '▶ Start Extraction');
  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true; startBtn.textContent = 'Starting…';
    try {
      // /process returns 202 immediately; the run continues in the background and
      // renderDetail() will show the spinner + poll until it resolves.
      await apiFetch(`/ingest-documents/${doc.ingest_id}/process`, {
        method: 'POST', body: JSON.stringify({ enrichment_level: modeSel.value }),
      });
      showToast(`Extraction started (${modeSel.value} mode) — this can take 1–3 minutes.`, 'success');
      await renderDetail(doc, pane);
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
      startBtn.disabled = false;
      startBtn.textContent = doc.ingest_status === 'failed' ? '▶ Re-run Extraction' : '▶ Start Extraction';
    }
  });
  sec.appendChild(startBtn);
  return sec;
}

function buildProcessingSection() {
  const sec = el('div', { className: 'detail-section' });
  sec.appendChild(el('h4', {}, 'AI Extraction'));
  const row = el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: 'var(--color-text-muted)' } });
  row.appendChild(el('div', { className: 'loading-spinner', style: { width: '14px', height: '14px', borderWidth: '2px' } }));
  row.appendChild(document.createTextNode('Agent is reading and interpreting this document…'));
  sec.appendChild(row);
  sec.appendChild(el('p', { style: { fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '8px' } },
    'This typically takes 1–3 minutes for a full document. This view refreshes automatically when extraction completes — you can navigate away and come back.'));
  return sec;
}

function buildClarificationForm(doc, questions, round, pane) {
  const sec = el('div', { className: 'detail-section' });

  const hdr = el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' } });
  hdr.appendChild(el('h4', { style: { margin: 0 } }, 'Clarifying Questions'));
  hdr.appendChild(tag(`Round ${round}`, 'warn'));
  hdr.appendChild(el('span', { style: { fontSize: '12px', color: 'var(--color-text-muted)' } },
    `${questions.length} question${questions.length !== 1 ? 's' : ''} need answers before extraction can complete`));
  sec.appendChild(hdr);

  sec.appendChild(el('p', { style: { fontSize: '13px', color: 'var(--color-text-muted)', marginBottom: '16px' } },
    'The agent could not reach the confidence threshold for the items below. ' +
    'Answer each question and click Submit — the agent will re-run immediately with your answers.'
  ));

  const answerMap = {}; // clarification_id → textarea

  questions.forEach((q, i) => {
    // Cross-check clarifications are namespaced in target_field: 'conflict:' = blocking
    // ripple/requirement conflict (blocks promote), 'fyi:' = non-blocking heads-up.
    const isConflict = typeof q.target_field === 'string' && q.target_field.startsWith('conflict:');
    const isFyi      = typeof q.target_field === 'string' && q.target_field.startsWith('fyi:');

    const qBlock = el('div', { style: {
      background: 'var(--color-bg)',
      border: isConflict ? '1px solid var(--color-danger, #C62828)' : '1px solid var(--color-border)',
      borderLeft: isConflict ? '3px solid var(--color-danger, #C62828)' : '1px solid var(--color-border)',
      borderRadius: 'var(--radius)',
      padding: '12px',
      marginBottom: '12px',
    }});

    // Question header
    const qHdr = el('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '8px' } });
    qHdr.appendChild(el('span', { style: {
      background: isConflict ? 'var(--color-danger, #C62828)' : 'var(--color-accent)',
      color: '#fff',
      borderRadius: '50%',
      width: '20px', height: '20px', minWidth: '20px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '11px', fontWeight: '700',
    }}, String(i + 1)));
    const qText = el('span', { style: { fontSize: '13px', fontWeight: '500', lineHeight: '1.5' } });
    if (isConflict) qText.appendChild(tag('⚠ Conflict', 'danger'));
    else if (isFyi) qText.appendChild(tag('ℹ FYI', 'muted'));
    if (isConflict || isFyi) qText.appendChild(el('span', { style: { marginRight: '6px' } }, ' '));
    qText.appendChild(document.createTextNode(q.question_text));
    qHdr.appendChild(qText);
    qBlock.appendChild(qHdr);

    // Context snippet
    if (q.context_snippet) {
      let ctx = q.context_snippet;
      try { const parsed = JSON.parse(ctx); ctx = Object.entries(parsed).slice(0, 3).map(([k,v]) => `${k}: ${v}`).join(' · '); } catch {}
      qBlock.appendChild(el('div', { style: {
        fontSize: '11px', color: 'var(--color-text-muted)',
        background: 'var(--color-panel)',
        borderRadius: '4px', padding: '4px 8px',
        marginBottom: '8px', fontFamily: 'var(--font-mono)',
      }}, `Context → ${ctx}`));
    }

    // Entity type tag
    if (q.target_entity_type) {
      const typeRow = el('div', { style: { marginBottom: '8px' } });
      typeRow.appendChild(tag(ENTITY_LABELS[q.target_entity_type] || q.target_entity_type, 'muted'));
      qBlock.appendChild(typeRow);
    }

    // Answer textarea
    const answerLabel = el('label', { className: 'form-label', style: { marginBottom: '4px' } }, 'Your answer:');
    const answerInput = el('textarea', { className: 'form-input', rows: '2',
      style: { resize: 'vertical', minHeight: '56px' },
      placeholder: 'Type your answer here…' });
    answerMap[q.clarification_id] = answerInput;
    qBlock.appendChild(answerLabel);
    qBlock.appendChild(answerInput);

    sec.appendChild(qBlock);
  });

  // Submit button
  const submitBtn = el('button', { className: 'btn btn-primary', style: { marginTop: '8px' } },
    `Submit Answers (${questions.length}) →`);
  submitBtn.addEventListener('click', async () => {
    const answers = {};
    let allFilled = true;
    for (const [cid, ta] of Object.entries(answerMap)) {
      if (!ta.value.trim()) { allFilled = false; break; }
      answers[cid] = ta.value.trim();
    }
    if (!allFilled) { showToast('Please answer all questions before submitting.', 'error'); return; }

    submitBtn.disabled = true; submitBtn.textContent = 'Submitting…';
    try {
      await apiFetch(`/ingest-documents/${doc.ingest_id}/clarifications/answer`, {
        method: 'POST',
        body: JSON.stringify({ answers }),
      });
      showToast('Answers submitted — re-running extraction…', 'info');
      await renderDetail(doc, pane);
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
      submitBtn.disabled = false; submitBtn.textContent = `Submit Answers (${questions.length}) →`;
    }
  });
  sec.appendChild(submitBtn);
  return sec;
}

function buildExtractionsSection(extractions, showPromote, doc, pane) {
  const sec = el('div', { className: 'detail-section' });

  const hdr = el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' } });
  hdr.appendChild(el('h4', { style: { margin: 0 } }, 'Staged Extractions'));
  hdr.appendChild(tag(`${extractions.length} items`, 'ok'));
  if (showPromote) {
    hdr.appendChild(el('span', { style: { fontSize: '12px', color: 'var(--color-text-muted)' } },
      '— all items are above the confidence threshold'));
  }
  sec.appendChild(hdr);

  if (showPromote) {
    sec.appendChild(el('p', { style: { fontSize: '13px', color: 'var(--color-text-muted)', marginBottom: '14px' } },
      'Review the extracted items below. Reject any that are incorrect, then click ' +
      '"Create Change Packets" to promote the remainder into the approval workflow.'
    ));
  }

  // Table
  const table = el('table', { className: 'wf-table' });
  table.innerHTML = `<thead><tr><th>Entity</th><th>Name / Summary</th><th>Confidence</th><th>Round</th>${showPromote ? '<th></th>' : ''}</tr></thead>`;
  const tbody = el('tbody');

  extractions.forEach(ex => {
    const name  = entityName(ex.entity_type, ex.entity_data);
    const conf  = Math.round((ex.confidence ?? 0) * 100);
    const confColor = conf >= 85 ? 'var(--color-ok)' : conf >= 70 ? 'var(--color-warn)' : 'var(--color-danger)';

    const tr = el('tr', {},
      el('td', {}, tag(ENTITY_LABELS[ex.entity_type] || ex.entity_type, 'info')),
      el('td', { style: { fontWeight: '500', maxWidth: '220px' } }, name),
      el('td', {}, el('span', { style: { color: confColor, fontWeight: '600', fontSize: '13px' } }, `${conf}%`)),
      el('td', { className: 'muted' }, `Round ${ex.round}`)
    );

    if (showPromote) {
      const actCell = el('td');
      const rejectBtn = el('button', { className: 'btn btn-ghost btn-sm' }, '✕ Reject');
      rejectBtn.addEventListener('click', async () => {
        rejectBtn.disabled = true;
        try {
          await apiFetch(`/ingest-documents/${doc.ingest_id}/extractions/${ex.extraction_id}`, {
            method: 'PUT', body: JSON.stringify({ status: 'rejected' }),
          });
          tr.style.opacity = '0.35';
          tr.style.textDecoration = 'line-through';
          rejectBtn.textContent = 'Rejected';
        } catch (err) {
          showToast(`Error: ${err.message}`, 'error');
          rejectBtn.disabled = false;
        }
      });
      actCell.appendChild(rejectBtn);
      tr.appendChild(actCell);
    }

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  sec.appendChild(table);

  // Promote button
  if (showPromote) {
    const promoteBtn = el('button', { className: 'btn btn-primary', style: { marginTop: '16px' } },
      `✓ Create Change Packets (${extractions.length} items)`);
    promoteBtn.addEventListener('click', async () => {
      promoteBtn.disabled = true; promoteBtn.textContent = 'Creating…';
      try {
        const result = await apiFetch(`/ingest-documents/${doc.ingest_id}/promote`, { method: 'POST' });
        const cpList = result.change_packets || [];
        showToast(`${cpList.length} Change Packet${cpList.length !== 1 ? 's' : ''} created — ready for approval.`, 'success');
        await renderDetail(doc, pane);
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
        promoteBtn.disabled = false; promoteBtn.textContent = `✓ Create Change Packets (${extractions.length} items)`;
      }
    });
    sec.appendChild(promoteBtn);
  }

  return sec;
}

function buildSourceSection(doc) {
  const sec = el('div', { className: 'detail-section' });
  const toggle = el('details');
  const label = doc.file_name ? `▸ Source document — ${doc.file_name}` : '▸ Source document';
  const summary = el('summary', { style: {
    cursor: 'pointer', fontSize: '13px', fontWeight: '500',
    color: 'var(--color-text-muted)', userSelect: 'none', padding: '4px 0',
  }}, label);
  toggle.appendChild(summary);

  const content = el('div', { style: { marginTop: '10px' } });
  toggle.appendChild(content);

  let loaded = false;
  toggle.addEventListener('toggle', async () => {
    if (!toggle.open || loaded) return;
    loaded = true;
    content.textContent = 'Loading…';
    try {
      const text = doc.raw_text
        ? doc.raw_text
        : (await apiFetch(`/ingest-documents/${doc.ingest_id}/content`)).content;
      const pre = el('pre', { style: {
        fontSize: '12px', lineHeight: '1.5',
        background: 'var(--color-bg-subtle, #f5f5f5)',
        border: '1px solid var(--color-border)',
        borderRadius: '4px', padding: '12px',
        overflow: 'auto', maxHeight: '400px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        margin: '0',
      }});
      pre.textContent = text;
      content.innerHTML = '';
      content.appendChild(pre);
    } catch (err) {
      content.innerHTML = '';
      const msg = el('p', { style: { fontSize: '13px', color: 'var(--color-text-muted)', margin: '0 0 8px' } },
        `Could not load source text: ${err.message}`);
      content.appendChild(msg);
      if (doc.file_path || doc.file_name) {
        const a = el('a', {
          href: `/api/v1/ingest-documents/${doc.ingest_id}/download`,
          download: doc.file_name || true,
          style: { fontSize: '13px' },
        }, `⬇ Download ${doc.file_name || 'file'}`);
        content.appendChild(a);
      }
    }
  });

  sec.appendChild(toggle);
  return sec;
}

function buildAnsweredSummary(answered) {
  const rounds = [...new Set(answered.map(a => a.round))].sort();
  const sec = el('div', { className: 'detail-section' });

  const toggle = el('details');
  const summary = el('summary', { style: {
    cursor: 'pointer', fontSize: '13px', fontWeight: '500',
    color: 'var(--color-text-muted)', userSelect: 'none', padding: '4px 0',
  }}, `▸ Previous Q&A rounds (${rounds.length} round${rounds.length !== 1 ? 's' : ''}, ${answered.length} answers)`);
  toggle.appendChild(summary);

  rounds.forEach(r => {
    const roundItems = answered.filter(a => a.round === r);
    toggle.appendChild(el('div', { style: { marginTop: '10px' } },
      el('div', { className: 'section-label' }, `Round ${r}`),
      ...roundItems.map(a => el('div', { style: {
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px',
        fontSize: '12px', padding: '6px 0',
        borderBottom: '1px solid var(--color-border)',
      }},
        el('div', { style: { color: 'var(--color-text-muted)' } }, a.question_text),
        el('div', { style: { fontWeight: '500' } }, a.answer_text || '—')
      ))
    ));
  });

  sec.appendChild(toggle);
  return sec;
}

function buildPromotedSection(doc) {
  const sec = el('div', { className: 'detail-section' });
  sec.appendChild(el('h4', {}, 'Promoted to Change Packets'));

  const msg = el('div', { style: {
    background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.25)',
    borderRadius: 'var(--radius)', padding: '14px', marginBottom: '14px',
  }});
  msg.appendChild(el('p', { style: { margin: 0, fontSize: '13px', color: 'var(--color-ok)', fontWeight: '500' } },
    `✓ ${doc.change_packets_generated} item${doc.change_packets_generated !== 1 ? 's' : ''} promoted to Change Packets`));
  msg.appendChild(el('p', { style: { margin: '6px 0 0', fontSize: '12px', color: 'var(--color-text-muted)' } },
    'Change Packets are now in the approval queue. Go to Change Packets → review and approve each one.'));
  sec.appendChild(msg);

  const cpBtn = el('button', { className: 'btn btn-ghost' }, '→ Go to Change Packets');
  cpBtn.addEventListener('click', () => document.querySelector('[data-module="change_packets"]')?.click());
  sec.appendChild(cpBtn);
  return sec;
}
