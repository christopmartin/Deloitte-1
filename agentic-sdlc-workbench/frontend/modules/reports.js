/**
 * modules/reports.js — Reports & Export
 */
import { apiFetch, tag, statusTag, formatDate, formatDateTime, el, escHtml, showToast, getCurrentProjectId } from '../app.js';

const REPORT_TYPES = [
  { id: 'requirements_summary', label: 'Requirements Summary', desc: 'All requirements by type and status' },
  { id: 'change_log', label: 'Change Log', desc: 'Full audit trail for a baseline period' },
  { id: 'validation_report', label: 'Validation Report', desc: 'Open exceptions and compliance status' },
  { id: 'baseline_snapshot', label: 'Baseline Snapshot', desc: 'Point-in-time application scope view' },
  { id: 'agent_activity', label: 'Agent Activity', desc: 'Agent actions, trust events, overrides' },
  { id: 'traceability_matrix', label: 'Traceability Matrix', desc: 'End-to-end requirements traceability' },
];

const FORMATS = [
  { id: 'pdf', label: 'PDF' },
  { id: 'xlsx', label: 'Excel (XLSX)' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'json', label: 'JSON' },
];

export async function render(container) {
  container.innerHTML = '';

  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'Reports & Export'),
    el('p', { className: 'purpose-text' }, 'Generate application reports and export data for stakeholders, reviewers, and regulatory audiences.')
  ));

  const twoCol = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' } });

  // Left: export form
  const leftCol = el('div');
  leftCol.appendChild(buildExportForm());
  twoCol.appendChild(leftCol);

  // Right: recent exports
  const rightCol = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } });
  rightCol.appendChild(await buildRecentExports());
  twoCol.appendChild(rightCol);

  container.appendChild(twoCol);
}

// ============================================================
// Export form
// ============================================================
function buildExportForm() {
  const panel = el('div', { className: 'panel' });
  panel.appendChild(el('div', { className: 'panel-header' }, el('span', { className: 'panel-title' }, 'New Export')));

  const body = el('div', { className: 'panel-body' });

  // Report type radio cards
  body.appendChild(el('div', { className: 'section-label' }, 'Report Type'));
  const typeGrid = el('div', { className: 'radio-card-grid', style: { marginBottom: '18px' } });
  let selectedType = REPORT_TYPES[0].id;

  REPORT_TYPES.forEach(rt => {
    const wrap = el('div', { className: 'radio-card' });
    const input = el('input', { type: 'radio', name: 'report_type', id: `rt_${rt.id}`, value: rt.id });
    if (rt.id === selectedType) input.checked = true;
    input.addEventListener('change', () => { selectedType = rt.id; });
    const label = el('label', { for: `rt_${rt.id}` });
    label.appendChild(el('div', { style: { fontWeight: '600', fontSize: '13px' } }, rt.label));
    label.appendChild(el('div', { style: { fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '2px' } }, rt.desc));
    wrap.appendChild(input);
    wrap.appendChild(label);
    typeGrid.appendChild(wrap);
  });
  body.appendChild(typeGrid);

  // Scope section
  body.appendChild(el('div', { className: 'section-label' }, 'Scope'));

  // Application selector
  const projGroup = el('div', { className: 'form-group' });
  projGroup.appendChild(el('label', { className: 'form-label' }, 'Application'));
  const projSelect = el('select', { className: 'form-select', id: 'report-project-select' });
  projSelect.innerHTML = '<option value="">— All Applications —</option>';
  projGroup.appendChild(projSelect);
  body.appendChild(projGroup);

  // Load projects async
  apiFetch('/projects').then(data => {
    const projects = Array.isArray(data) ? data : (data.items || []);
    projects.forEach(p => projSelect.appendChild(el('option', { value: p.project_id }, p.project_name)));
    const activeId = getCurrentProjectId();
    if (activeId) projSelect.value = activeId;
  }).catch(() => {});

  // Baseline selector
  const bslGroup = el('div', { className: 'form-group' });
  bslGroup.appendChild(el('label', { className: 'form-label' }, 'Baseline (optional)'));
  const bslSelect = el('select', { className: 'form-select' });
  bslSelect.innerHTML = '<option value="">Latest</option>';
  bslGroup.appendChild(bslSelect);
  body.appendChild(bslGroup);

  projSelect.addEventListener('change', async () => {
    bslSelect.innerHTML = '<option value="">Latest</option>';
    if (projSelect.value) {
      try {
        const data = await apiFetch(`/baselines?project_id=${projSelect.value}`);
        const baselines = Array.isArray(data) ? data : (data.items || []);
        baselines.forEach(b => bslSelect.appendChild(el('option', { value: b.baseline_id }, b.baseline_name || `Baseline ${b.baseline_id}`)));
      } catch {}
    }
  });

  // Include checkboxes
  body.appendChild(el('div', { className: 'section-label', style: { marginTop: '12px' } }, 'Include Sections'));
  const includeWrap = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' } });
  const sections = ['Executive Summary', 'Change Log', 'Validation Status', 'Traceability', 'Agent Activity', 'Open Items'];
  const sectionInputs = {};
  sections.forEach(s => {
    const key = s.toLowerCase().replace(/\s+/g, '_');
    const wrap = el('label', { className: 'checkbox-wrap' });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = ['Executive Summary', 'Change Log', 'Validation Status'].includes(s);
    sectionInputs[key] = cb;
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode(s));
    includeWrap.appendChild(wrap);
  });
  body.appendChild(includeWrap);

  // Audience
  const audGroup = el('div', { className: 'form-group' });
  audGroup.appendChild(el('label', { className: 'form-label' }, 'Audience'));
  const audSelect = el('select', { className: 'form-select' });
  audSelect.innerHTML = '<option value="internal">Internal Team</option><option value="client">Client</option><option value="executive">Executive</option><option value="regulator">Regulator</option>';
  audGroup.appendChild(audSelect);
  body.appendChild(audGroup);

  // Format radios
  body.appendChild(el('div', { className: 'section-label' }, 'Output Format'));
  const formatRow = el('div', { style: { display: 'flex', gap: '8px', marginBottom: '18px', flexWrap: 'wrap' } });
  let selectedFormat = 'pdf';

  FORMATS.forEach(f => {
    const wrap = el('div', { className: 'radio-card' });
    const input = el('input', { type: 'radio', name: 'report_format', id: `fmt_${f.id}`, value: f.id });
    if (f.id === selectedFormat) input.checked = true;
    input.addEventListener('change', () => { selectedFormat = f.id; });
    const label = el('label', { for: `fmt_${f.id}`, style: { minWidth: '90px' } }, f.label);
    wrap.appendChild(input);
    wrap.appendChild(label);
    formatRow.appendChild(wrap);
  });
  body.appendChild(formatRow);

  // Action buttons
  const btnRow = el('div', { className: 'btn-group' });
  const previewBtn = el('button', { className: 'btn btn-ghost' }, '👁 Preview');
  const generateBtn = el('button', { className: 'btn btn-primary' }, '⬇ Generate Report');

  previewBtn.addEventListener('click', async () => {
    previewBtn.disabled = true;
    previewBtn.textContent = 'Generating preview…';
    try {
      await new Promise(r => setTimeout(r, 600)); // stub delay
      showToast('Preview generated (stub — would open in new tab).', 'info');
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent = '👁 Preview';
    }
  });

  generateBtn.addEventListener('click', async () => {
    if (!projSelect.value) { showToast('Select an application first.', 'error'); return; }
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating…';
    try {
      const includedSections = {};
      Object.entries(sectionInputs).forEach(([k, cb]) => { includedSections[k] = cb.checked; });

      const reportLabel = REPORT_TYPES.find(r => r.id === selectedType)?.label || selectedType;
      const payload = {
        report_type: selectedType,
        title: `${reportLabel} — ${new Date().toLocaleDateString('en-CA')}`,
        project_id: projSelect.value || null,
        baseline_id: bslSelect.value || null,
        audience: audSelect.value,
        format: selectedFormat,
        include_sections: includedSections,
      };

      await apiFetch('/reports', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Report queued for generation.', 'success');

      // Refresh recent exports
      const recentContainer = document.getElementById('recent-exports-table');
      if (recentContainer) await refreshRecentExports(recentContainer, projSelect.value);
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = '⬇ Generate Report';
    }
  });

  btnRow.appendChild(previewBtn);
  btnRow.appendChild(generateBtn);
  body.appendChild(btnRow);

  panel.appendChild(body);
  return panel;
}

// ============================================================
// Recent exports
// ============================================================
async function buildRecentExports() {
  const panel = el('div', { className: 'panel' });
  panel.appendChild(el('div', { className: 'panel-header' }, el('span', { className: 'panel-title' }, 'Recent Exports')));

  const tableContainer = el('div', { id: 'recent-exports-table' });
  tableContainer.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
  panel.appendChild(tableContainer);

  const activeId = getCurrentProjectId();
  await refreshRecentExports(tableContainer, activeId || '');
  return panel;
}

async function refreshRecentExports(container, projectId) {
  container.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';

  try {
    const params = new URLSearchParams();
    if (projectId) params.set('project_id', projectId);
    const data = await apiFetch(`/reports?${params}`);
    const reports = Array.isArray(data) ? data : (data.items || data.reports || []);

    container.innerHTML = '';

    if (reports.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No exports yet.</p></div>';
      return;
    }

    const table = el('table', { className: 'wf-table' });
    table.innerHTML = `<thead><tr><th>Date</th><th>Title</th><th>Type</th><th>Format</th><th>Status</th><th></th></tr></thead>`;
    const tbody = el('tbody');

    reports.forEach(r => {
      const row = el('tr', {},
        el('td', { className: 'muted' }, formatDateTime(r.created_at || r.generated_at)),
        el('td', { style: { fontWeight: '500' } }, r.title || r.report_type || '—'),
        el('td', {}, tag(r.report_type || '—', 'muted')),
        el('td', {}, tag((r.format || '—').toUpperCase(), 'info')),
        el('td', {}, statusTag(r.status))
      );

      const actCell = el('td');
      if (r.download_url || r.url) {
        const dlBtn = el('a', { href: r.download_url || r.url, className: 'btn btn-ghost btn-sm', download: '' }, '↓');
        actCell.appendChild(dlBtn);
      }
      row.appendChild(actCell);
      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    container.appendChild(table);
  } catch (err) {
    container.innerHTML = `<div class="error-state"><strong>Error:</strong> ${escHtml(err.message)}</div>`;
  }
}
