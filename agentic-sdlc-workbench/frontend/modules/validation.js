/**
 * modules/validation.js — Validation & Exception Queue
 */
import { apiFetch, tag, statusTag, formatDate, formatDateTime, el, escHtml, showToast, getCurrentProjectId } from '../app.js';

let allExceptions = [];
let selectedEx = null;
let filterType = '';
let filterSearch = '';

export async function render(container) {
  container.innerHTML = '';
  allExceptions = [];
  selectedEx = null;

  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'Validation & Exception Queue'),
    el('p', { className: 'purpose-text' }, 'Review validation failures, rule exceptions, and suggested corrections across all applications.')
  ));

  // Project picker
  const toolbar = el('div', { className: 'filter-bar', style: { marginBottom: '16px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', background: 'var(--color-panel)' } });
  const projLabel = el('label', { className: 'form-label', style: { margin: 0 } }, 'Application:');
  const projSelect = el('select', { className: 'filter-select' });
  projSelect.innerHTML = '<option value="">— All Applications —</option>';
  toolbar.appendChild(projLabel);
  toolbar.appendChild(projSelect);
  container.appendChild(toolbar);

  // KPI row
  const kpiRow = el('div', { className: 'kpi-grid', id: 'val-kpis' });
  container.appendChild(kpiRow);

  // Exception list + detail
  const layout = el('div', { className: 'two-pane' });
  const paneLeft = el('div', { className: 'pane-left' });
  const paneRight = el('div', { className: 'pane-right', id: 'ex-detail' });
  paneRight.innerHTML = '<div class="empty-state" style="height:100%"><div class="empty-state-icon">✅</div><h3>Select an exception</h3><p>Click a row to view details and take action.</p></div>';

  layout.appendChild(paneLeft);
  layout.appendChild(paneRight);
  container.appendChild(layout);

  // Build exception list
  await buildExceptionList(paneLeft, paneRight, kpiRow, projSelect);

  // Load projects
  try {
    const projData = await apiFetch('/projects');
    const projects = Array.isArray(projData) ? projData : (projData.items || []);
    projects.forEach(p => projSelect.appendChild(el('option', { value: p.project_id }, p.project_name)));

    const activeId = getCurrentProjectId();
    if (activeId) projSelect.value = activeId;
  } catch {}

  projSelect.addEventListener('change', async () => {
    selectedEx = null;
    paneRight.innerHTML = '<div class="empty-state" style="height:100%"><p>Select an exception.</p></div>';
    await loadExceptions(projSelect.value, paneLeft, paneRight, kpiRow);
  });

  // Initial load
  await loadExceptions(projSelect.value || getCurrentProjectId() || '', paneLeft, paneRight, kpiRow);
}

async function buildExceptionList(paneLeft, paneRight, kpiRow, projSelect) {
  // Filter bar
  const filterBar = el('div', { className: 'filter-bar' });
  const searchInput = el('input', { type: 'text', className: 'filter-input', placeholder: 'Search exceptions…' });
  const typeSel = el('select', { className: 'filter-select' });
  typeSel.innerHTML = '<option value="">All Types</option><option>missing_owner</option><option>invalid_value</option><option>schema_violation</option><option>rule_failure</option><option>stale_review</option>';

  searchInput.addEventListener('input', () => {
    filterSearch = searchInput.value.toLowerCase();
    refreshExList(paneLeft, paneRight);
  });
  typeSel.addEventListener('change', () => {
    filterType = typeSel.value;
    refreshExList(paneLeft, paneRight);
  });

  filterBar.appendChild(searchInput);
  filterBar.appendChild(typeSel);

  paneLeft.appendChild(el('div', { className: 'pane-header' }, el('span', { className: 'pane-title' }, 'Exceptions')));
  paneLeft.appendChild(filterBar);

  const listBody = el('div', { className: 'pane-body', id: 'ex-list-body' });
  listBody.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
  paneLeft.appendChild(listBody);
}

async function loadExceptions(projectId, paneLeft, paneRight, kpiRow) {
  const listBody = document.getElementById('ex-list-body');
  if (listBody) listBody.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
  kpiRow.innerHTML = '';

  try {
    const params = new URLSearchParams();
    if (projectId) params.set('project_id', projectId);

    const [summaryData, exceptionsData] = await Promise.all([
      apiFetch(`/exceptions/summary?${params}`).catch(() => null),
      apiFetch(`/exceptions?${params}`).catch(() => ({ items: [] })),
    ]);

    allExceptions = Array.isArray(exceptionsData) ? exceptionsData : (exceptionsData.items || exceptionsData.exceptions || []);

    renderKPIs(kpiRow, summaryData, allExceptions);
    refreshExList(paneLeft, paneRight);
  } catch (err) {
    if (listBody) listBody.innerHTML = `<div class="error-state"><strong>Error:</strong> ${escHtml(err.message)}</div>`;
  }
}

function renderKPIs(kpiRow, summary, exceptions) {
  kpiRow.innerHTML = '';

  const typeCount = {};
  exceptions.forEach(e => {
    const t = e.exception_type || e.type || 'unknown';
    typeCount[t] = (typeCount[t] || 0) + 1;
  });

  const kpis = summary ? [
    { label: 'Total Open', value: summary.total_open ?? summary.total ?? exceptions.length, variant: 'warn' },
    { label: 'Critical', value: summary.critical ?? 0, variant: 'danger' },
    { label: 'Missing Owners', value: summary.missing_owner ?? typeCount['missing_owner'] ?? 0, variant: 'warn' },
    { label: 'Schema Violations', value: summary.schema_violation ?? typeCount['schema_violation'] ?? 0, variant: 'danger' },
    { label: 'Rule Failures', value: summary.rule_failure ?? typeCount['rule_failure'] ?? 0, variant: 'warn' },
    { label: 'Stale Reviews', value: summary.stale_review ?? typeCount['stale_review'] ?? 0, variant: 'accent' },
    { label: 'Resolved Today', value: summary.resolved_today ?? 0, variant: 'ok' },
  ] : [
    { label: 'Total Exceptions', value: exceptions.length, variant: 'warn' },
  ];

  kpis.forEach(k => {
    kpiRow.appendChild(el('div', { className: `kpi-card ${k.variant}` },
      el('div', { className: 'kpi-label' }, k.label),
      el('div', { className: 'kpi-value' }, String(k.value)),
    ));
  });
}

function refreshExList(paneLeft, paneRight) {
  const listBody = document.getElementById('ex-list-body');
  if (!listBody) return;
  listBody.innerHTML = '';

  const filtered = allExceptions.filter(e => {
    if (filterSearch && !JSON.stringify(e).toLowerCase().includes(filterSearch)) return false;
    if (filterType && (e.exception_type || e.type) !== filterType) return false;
    return true;
  });

  if (filtered.length === 0) {
    listBody.innerHTML = '<div class="empty-state"><p>No exceptions match filters.</p></div>';
    return;
  }

  const list = el('div', { style: { display: 'flex', flexDirection: 'column' } });

  filtered.forEach(ex => {
    const row = el('div', {
      style: {
        padding: '9px 14px',
        borderBottom: '1px solid var(--color-border)',
        cursor: 'pointer',
        transition: 'background var(--transition)',
      }
    });

    const isSelected = selectedEx?.exception_id === ex.exception_id;
    if (isSelected) row.style.background = 'var(--color-accent-light)';
    row.addEventListener('mouseenter', () => { if (!isSelected) row.style.background = 'var(--color-bg)'; });
    row.addEventListener('mouseleave', () => { if (selectedEx?.exception_id !== ex.exception_id) row.style.background = ''; });

    const top = el('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '3px' } });
    top.appendChild(el('span', { style: { fontFamily: 'monospace', fontSize: '11px', color: 'var(--color-accent)' } },
      ex.exception_id ? `EX-${ex.exception_id.slice(0, 8)}` : '—'
    ));
    top.appendChild(statusTag(ex.status || 'open'));
    row.appendChild(top);

    const typeRow = el('div', { style: { display: 'flex', gap: '6px', marginBottom: '3px' } });
    typeRow.appendChild(tag(ex.exception_type || ex.type || 'unknown', 'warn'));
    if (ex.age_days != null) typeRow.appendChild(el('span', { className: 'text-muted text-sm' }, `${ex.age_days}d old`));
    row.appendChild(typeRow);

    const reason = el('div', { style: { fontSize: '12px', color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      ex.description || '—'
    );
    row.appendChild(reason);

    row.addEventListener('click', () => {
      document.querySelectorAll('.ex-row-active').forEach(r => {
        r.classList.remove('ex-row-active');
        r.style.background = '';
      });
      row.classList.add('ex-row-active');
      row.style.background = 'var(--color-accent-light)';
      selectedEx = ex;
      renderExDetail(ex, paneRight);
    });

    list.appendChild(row);
  });

  listBody.appendChild(list);
}

function renderExDetail(ex, pane) {
  pane.innerHTML = '';

  pane.appendChild(el('div', { className: 'pane-header' },
    el('span', { className: 'pane-title' },
      el('span', { style: { fontFamily: 'monospace', color: 'var(--color-accent)', marginRight: '8px' } },
        ex.exception_id ? `EX-${ex.exception_id.slice(0, 8)}` : '—')
    ),
    statusTag(ex.status || 'open')
  ));

  const body = el('div', { className: 'pane-body' });

  // Meta
  const metaSection = el('div', { className: 'detail-section' });
  metaSection.appendChild(el('h4', {}, 'Exception Details'));

  const grid = el('div', { className: 'meta-grid' });
  const metas = [
    ['Type', tag(ex.exception_type || ex.type || '—', 'warn')],
    ['Status', statusTag(ex.status)],
    ['Record', ex.related_entity_id || '—'],
    ['Entity Type', ex.related_entity_type || '—'],
    ['Severity', ex.severity || '—'],
    ['Detected', formatDateTime(ex.created_at || ex.detected_at)],
  ];
  metas.forEach(([k, v]) => {
    const item = el('div', { className: 'meta-item' }, el('div', { className: 'meta-key' }, k));
    const val = el('div', { className: 'meta-val' });
    if (v instanceof Node) val.appendChild(v);
    else val.textContent = String(v);
    item.appendChild(val);
    grid.appendChild(item);
  });
  metaSection.appendChild(grid);

  if (ex.description) {
    metaSection.appendChild(el('div', { style: { marginTop: '12px' } },
      el('div', { className: 'section-label' }, 'Description'),
      el('p', { style: { fontSize: '13px' } }, ex.description)
    ));
  }

  if (ex.resolution_summary) {
    metaSection.appendChild(el('div', { style: { marginTop: '12px' } },
      el('div', { className: 'section-label' }, 'Resolution'),
      el('p', { style: { fontSize: '13px', color: 'var(--color-ok)', fontStyle: 'italic' } },
        ex.resolution_summary
      )
    ));
  }

  body.appendChild(metaSection);

  // Answer / resolve section
  const actionSection = el('div', { className: 'detail-section' });
  actionSection.appendChild(el('h4', {}, ex.status === 'resolved' ? 'Resolution' : 'Enter Answer'));

  if (ex.status !== 'resolved') {
    // Notes textarea
    actionSection.appendChild(el('div', { style: { fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '6px' } },
      'Type your answer or evidence below, then click Save & Resolve.'
    ));
    const notesArea = el('textarea', {
      className: 'form-input',
      placeholder: 'e.g. "Confirmed with Bryan Burnside: retention policy is 1 year for work notes. SAP event name is ZFIAPACD."',
      style: { width: '100%', minHeight: '90px', resize: 'vertical', fontFamily: 'inherit', fontSize: '13px', marginBottom: '8px' }
    });
    if (ex.resolution_summary) notesArea.value = ex.resolution_summary;
    actionSection.appendChild(notesArea);

    const btnRow = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });

    // Save notes only (keep open)
    const saveBtn = el('button', { className: 'btn btn-ghost' }, 'Save Notes');
    saveBtn.addEventListener('click', async () => {
      const notes = notesArea.value.trim();
      if (!notes) { showToast('Enter some notes first.', 'warn'); return; }
      saveBtn.disabled = true;
      try {
        await apiFetch(`/exceptions/${ex.exception_id}`, { method: 'PUT', body: JSON.stringify({ resolution_summary: notes }) });
        ex.resolution_summary = notes;
        const idx = allExceptions.findIndex(x => x.exception_id === ex.exception_id);
        if (idx >= 0) allExceptions[idx].resolution_summary = notes;
        showToast('Notes saved.', 'success');
      } catch (err) { showToast(`Error: ${err.message}`, 'error'); }
      finally { saveBtn.disabled = false; }
    });

    // Save + resolve
    const resolveBtn = el('button', { className: 'btn btn-success' }, '✓ Save & Resolve');
    resolveBtn.addEventListener('click', async () => {
      const notes = notesArea.value.trim();
      resolveBtn.disabled = true;
      try {
        await apiFetch(`/exceptions/${ex.exception_id}`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'resolved', resolution_summary: notes || ex.resolution_summary }),
        });
        showToast('Exception resolved.', 'success');
        const updated = { ...ex, status: 'resolved', resolution_summary: notes || ex.resolution_summary };
        const idx = allExceptions.findIndex(x => x.exception_id === ex.exception_id);
        if (idx >= 0) allExceptions[idx] = updated;
        renderExDetail(updated, pane);
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
        resolveBtn.disabled = false;
      }
    });

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(resolveBtn);
    actionSection.appendChild(btnRow);
  } else {
    // Already resolved — show resolution summary read-only + reopen option
    if (ex.resolution_summary) {
      actionSection.appendChild(el('p', {
        style: { fontSize: '13px', color: 'var(--color-ok)', fontStyle: 'italic', background: 'var(--color-ok-bg)', padding: '10px 12px', borderRadius: 'var(--radius)', marginBottom: '8px' }
      }, ex.resolution_summary));
    }
    const reopenBtn = el('button', { className: 'btn btn-ghost' }, 'Re-open');
    reopenBtn.addEventListener('click', async () => {
      reopenBtn.disabled = true;
      try {
        await apiFetch(`/exceptions/${ex.exception_id}`, { method: 'PUT', body: JSON.stringify({ status: 'open' }) });
        const updated = { ...ex, status: 'open' };
        const idx = allExceptions.findIndex(x => x.exception_id === ex.exception_id);
        if (idx >= 0) allExceptions[idx] = updated;
        renderExDetail(updated, pane);
        showToast('Exception re-opened.', 'info');
      } catch (err) { showToast(`Error: ${err.message}`, 'error'); reopenBtn.disabled = false; }
    });
    actionSection.appendChild(reopenBtn);
  }

  body.appendChild(actionSection);

  pane.appendChild(body);
}
