/**
 * modules/audit.js — Audit Log Viewer
 */
import { apiFetch, statusTag, formatDateTime, el, escHtml, showToast, getCurrentProjectId } from '../app.js';

export async function render(container) {
  container.innerHTML = '';

  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'Audit Log'),
    el('p', { className: 'purpose-text' }, 'Search the full change history for any repository record or field. Every write is logged.')
  ));

  // Search bar
  const searchPanel = el('div', { className: 'panel', style: { marginBottom: '16px' } });
  const searchBody = el('div', { className: 'panel-body' });
  const searchRow = el('div', { style: { display: 'flex', gap: '10px', alignItems: 'flex-end' } });

  const recordIdGroup = el('div', { className: 'form-group', style: { flex: '1' } });
  recordIdGroup.appendChild(el('label', { className: 'form-label' }, 'Record ID'));
  const recordIdInput = el('input', { type: 'text', className: 'form-input', placeholder: 'e.g. proj_123, req_456…' });
  recordIdGroup.appendChild(recordIdInput);

  const tableGroup = el('div', { className: 'form-group', style: { flex: '1' } });
  tableGroup.appendChild(el('label', { className: 'form-label' }, 'Table / Record Type'));
  const tableInput = el('input', { type: 'text', className: 'form-input', placeholder: 'e.g. applications, requirements…' });
  tableGroup.appendChild(tableInput);

  const fieldGroup = el('div', { className: 'form-group', style: { flex: '1' } });
  fieldGroup.appendChild(el('label', { className: 'form-label' }, 'Field Path (optional)'));
  const fieldInput = el('input', { type: 'text', className: 'form-input', placeholder: 'e.g. name, status…' });
  fieldGroup.appendChild(fieldInput);

  const searchBtn = el('button', { className: 'btn btn-primary', style: { marginBottom: '14px' } }, 'Search');
  searchRow.appendChild(recordIdGroup);
  searchRow.appendChild(tableGroup);
  searchRow.appendChild(fieldGroup);
  searchRow.appendChild(searchBtn);

  searchBody.appendChild(searchRow);
  searchPanel.appendChild(searchBody);
  container.appendChild(searchPanel);

  // Results area
  const resultLayout = el('div', { className: 'two-pane' });
  const leftPane = el('div', { className: 'pane-left', id: 'audit-left' });
  leftPane.innerHTML = '<div class="empty-state" style="height:100%"><p>Search for a record to see its audit summary.</p></div>';
  const rightPane = el('div', { className: 'pane-right', id: 'audit-right' });
  rightPane.innerHTML = '<div class="empty-state" style="height:100%"><p>Audit timeline will appear here.</p></div>';
  resultLayout.appendChild(leftPane);
  resultLayout.appendChild(rightPane);
  container.appendChild(resultLayout);

  // Search handler
  const doSearch = async () => {
    const recordId = recordIdInput.value.trim();
    const tableName = tableInput.value.trim();
    const fieldPath = fieldInput.value.trim();

    if (!recordId && !tableName) {
      showToast('Enter a Record ID or Table name.', 'error');
      return;
    }

    searchBtn.disabled = true;
    searchBtn.textContent = 'Searching…';
    leftPane.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
    rightPane.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';

    try {
      const params = new URLSearchParams();
      if (recordId) params.set('record_id', recordId);
      if (tableName) params.set('table_name', tableName);
      if (fieldPath) params.set('field_path', fieldPath);

      const data = await apiFetch(`/audit-log?${params}`);
      const entries = Array.isArray(data) ? data : (data.items || data.entries || []);

      renderSummary(leftPane, entries, recordId, tableName);
      renderTimeline(rightPane, entries);
    } catch (err) {
      leftPane.innerHTML = `<div class="error-state"><strong>Error:</strong> ${escHtml(err.message)}</div>`;
      rightPane.innerHTML = '';
    } finally {
      searchBtn.disabled = false;
      searchBtn.textContent = 'Search';
    }
  };

  searchBtn.addEventListener('click', doSearch);
  [recordIdInput, tableInput, fieldInput].forEach(input => {
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  });
}

function renderSummary(pane, entries, recordId, tableName) {
  pane.innerHTML = '';
  pane.appendChild(el('div', { className: 'pane-header' }, el('span', { className: 'pane-title' }, 'Record Summary')));

  const body = el('div', { className: 'pane-body' });
  const section = el('div', { className: 'detail-section' });

  if (entries.length === 0) {
    section.appendChild(el('div', { className: 'empty-state' }, el('p', {}, 'No audit entries found.')));
    body.appendChild(section);
    pane.appendChild(body);
    return;
  }

  const latest = entries[0];
  const oldest = entries[entries.length - 1];

  // Count distinct fields
  const fields = new Set(entries.map(e => e.field_path || e.field).filter(Boolean));
  const operators = new Set(entries.map(e => e.changed_by || e.user_id).filter(Boolean));

  const metas = [
    ['Table', latest.table_name || tableName || '—'],
    ['Record ID', latest.record_id || recordId || '—'],
    ['Total Changes', entries.length],
    ['Distinct Fields', fields.size],
    ['Contributors', operators.size],
    ['First Change', formatDateTime(oldest.changed_at)],
    ['Last Change', formatDateTime(latest.changed_at)],
    ['Last Operation', statusTag(latest.operation)],
  ];

  const grid = el('div', { className: 'meta-grid' });
  metas.forEach(([k, v]) => {
    const item = el('div', { className: 'meta-item' },
      el('div', { className: 'meta-key' }, k)
    );
    const val = el('div', { className: 'meta-val' });
    if (v instanceof Node) val.appendChild(v);
    else val.textContent = String(v);
    item.appendChild(val);
    grid.appendChild(item);
  });
  section.appendChild(grid);

  // Field breakdown table
  if (fields.size > 0) {
    section.appendChild(el('div', { className: 'section-divider' }));
    section.appendChild(el('div', { className: 'section-label' }, 'Changed Fields'));

    const fieldCounts = {};
    entries.forEach(e => {
      const f = e.field_path || e.field;
      if (f) fieldCounts[f] = (fieldCounts[f] || 0) + 1;
    });

    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
    Object.entries(fieldCounts).sort((a, b) => b[1] - a[1]).forEach(([f, count]) => {
      list.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '3px 0', borderBottom: '1px solid var(--color-border)' } },
        el('span', { className: 'field-path' }, f),
        el('span', { className: 'tag tag-muted' }, `${count}x`)
      ));
    });
    section.appendChild(list);
  }

  body.appendChild(section);
  pane.appendChild(body);
}

function renderTimeline(pane, entries) {
  pane.innerHTML = '';
  pane.appendChild(el('div', { className: 'pane-header' },
    el('span', { className: 'pane-title' }, 'Change Timeline'),
    el('span', { className: 'tag tag-muted' }, `${entries.length} entries`)
  ));

  const body = el('div', { className: 'pane-body' });

  if (entries.length === 0) {
    body.appendChild(el('div', { className: 'empty-state' }, el('p', {}, 'No entries to show.')));
    pane.appendChild(body);
    return;
  }

  const timeline = el('div', { className: 'timeline', style: { padding: '16px 16px 16px 40px' } });

  entries.forEach(entry => {
    const item = el('div', { className: 'timeline-item' });

    item.appendChild(el('div', { className: 'timeline-time' }, formatDateTime(entry.changed_at)));

    const opRow = el('div', { className: 'timeline-op', style: { display: 'flex', gap: '8px', alignItems: 'center' } });
    opRow.appendChild(statusTag(entry.operation));
    if (entry.field_path || entry.field) {
      opRow.appendChild(el('span', { className: 'field-path' }, entry.field_path || entry.field));
    }
    item.appendChild(opRow);

    // Old → New
    if (entry.old_value != null || entry.new_value != null) {
      const diffRow = el('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '8px', marginTop: '6px', flexWrap: 'wrap' } });
      if (entry.old_value != null) {
        diffRow.appendChild(el('span', { className: 'diff-old' }, String(entry.old_value)));
      }
      if (entry.old_value != null && entry.new_value != null) {
        diffRow.appendChild(el('span', { className: 'diff-arrow' }, '→'));
      }
      if (entry.new_value != null) {
        diffRow.appendChild(el('span', { className: 'diff-new' }, String(entry.new_value)));
      }
      item.appendChild(diffRow);
    }

    item.appendChild(el('div', { className: 'timeline-by' },
      `by ${entry.changed_by || entry.user_name || entry.user_id || 'system'}`
      + (entry.source ? ` via ${entry.source}` : '')
    ));

    if (entry.change_packet_code || entry.cp_code) {
      item.appendChild(el('div', { style: { marginTop: '4px' } },
        el('span', { className: 'tag tag-accent' }, entry.change_packet_code || entry.cp_code)
      ));
    }

    timeline.appendChild(item);
  });

  body.appendChild(timeline);
  pane.appendChild(body);
}
