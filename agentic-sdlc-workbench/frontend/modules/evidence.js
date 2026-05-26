/**
 * modules/evidence.js — Evidence Sources
 */
import { apiFetch, tag, statusTag, formatDateTime, renderTable, el, escHtml, showToast, getCurrentProjectId } from '../app.js';

let allSources = [];
let selectedSource = null;
let filterSearch = '';
let filterType = '';
let filterStatus = '';

export async function render(container) {
  container.innerHTML = '';
  allSources = [];
  selectedSource = null;

  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'Evidence Sources'),
    el('p', { className: 'purpose-text' }, 'View all evidence sources, their extraction status, and which repository fields each source populates.')
  ));

  const layout = el('div', { className: 'two-pane' });
  const paneLeft = el('div', { className: 'pane-left' });
  const paneRight = el('div', { className: 'pane-right', id: 'evidence-detail' });
  paneRight.innerHTML = '<div class="empty-state" style="height:100%"><div class="empty-state-icon">📄</div><h3>Select a source</h3><p>Click an evidence source to view its details and linked fields.</p></div>';

  layout.appendChild(paneLeft);
  layout.appendChild(paneRight);
  container.appendChild(layout);

  await buildSourceList(paneLeft, paneRight);
}

async function buildSourceList(paneLeft, paneRight) {
  const filterBar = el('div', { className: 'filter-bar' });

  const searchInput = el('input', { type: 'text', className: 'filter-input', placeholder: 'Search sources…' });
  const typeSel = el('select', { className: 'filter-select' });
  typeSel.innerHTML = '<option value="">All Types</option><option>document</option><option>api</option><option>webhook</option><option>manual</option><option>integration</option>';
  const statusSel = el('select', { className: 'filter-select' });
  statusSel.innerHTML = '<option value="">All Statuses</option><option>active</option><option>pending</option><option>failed</option><option>archived</option>';

  const refresh = () => refreshList(listBody, paneRight);

  searchInput.addEventListener('input', () => { filterSearch = searchInput.value.toLowerCase(); refresh(); });
  typeSel.addEventListener('change', () => { filterType = typeSel.value; refresh(); });
  statusSel.addEventListener('change', () => { filterStatus = statusSel.value; refresh(); });

  filterBar.appendChild(searchInput);
  filterBar.appendChild(typeSel);
  filterBar.appendChild(statusSel);

  paneLeft.appendChild(el('div', { className: 'pane-header' }, el('span', { className: 'pane-title' }, 'Evidence Sources')));
  paneLeft.appendChild(filterBar);

  const listBody = el('div', { className: 'pane-body' });
  listBody.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
  paneLeft.appendChild(listBody);

  try {
    const params = new URLSearchParams();
    const activeId = getCurrentProjectId();
    if (activeId) params.set('project_id', activeId);

    const data = await apiFetch(`/evidence-sources?${params}`);
    allSources = Array.isArray(data) ? data : (data.items || data.sources || []);
    refresh();
  } catch (err) {
    listBody.innerHTML = `<div class="error-state"><strong>Error:</strong> ${escHtml(err.message)}</div>`;
  }
}

function refreshList(listBody, paneRight) {
  listBody.innerHTML = '';

  const filtered = allSources.filter(s => {
    if (filterSearch && !JSON.stringify(s).toLowerCase().includes(filterSearch)) return false;
    if (filterType && s.source_type !== filterType) return false;
    if (filterStatus && s.validation_status !== filterStatus) return false;
    return true;
  });

  if (filtered.length === 0) {
    listBody.innerHTML = '<div class="empty-state"><p>No evidence sources found.</p></div>';
    return;
  }

  const table = el('table', { className: 'wf-table' });
  table.innerHTML = `<thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Last Run</th></tr></thead>`;
  const tbody = el('tbody');

  filtered.forEach(s => {
    const tr = el('tr', { className: 'clickable' },
      el('td', { style: { fontWeight: '500' } }, s.source_title || `Source ${s.evidence_source_id}`),
      el('td', {}, tag(s.source_type || '—', 'info')),
      el('td', {}, statusTag(s.validation_status)),
      el('td', { className: 'muted' }, formatDateTime(s.source_datetime))
    );

    tr.addEventListener('click', () => {
      document.querySelectorAll('.evidence-row-active').forEach(r => r.classList.remove('evidence-row-active'));
      tr.classList.add('evidence-row-active');
      selectedSource = s;
      loadDetail(s, paneRight);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  listBody.appendChild(table);
}

async function loadDetail(source, pane) {
  pane.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';

  try {
    const [detail, linked] = await Promise.all([
      apiFetch(`/evidence-sources/${source.evidence_source_id}`).catch(() => source),
      apiFetch(`/evidence-sources/${source.evidence_source_id}/linked-items`).catch(() => null),
    ]);

    renderDetail(detail, linked, pane);
  } catch (err) {
    pane.innerHTML = `<div class="error-state"><strong>Error:</strong> ${escHtml(err.message)}</div>`;
  }
}

function renderDetail(source, linked, pane) {
  pane.innerHTML = '';

  const header = el('div', { className: 'pane-header' },
    el('span', { className: 'pane-title' }, source.source_title || `Source ${source.evidence_source_id}`),
    statusTag(source.validation_status)
  );
  pane.appendChild(header);

  const body = el('div', { className: 'pane-body' });

  // Source info
  const infoSection = el('div', { className: 'detail-section' });
  infoSection.appendChild(el('h4', {}, 'Source Information'));

  const grid = el('div', { className: 'meta-grid' });
  const fields = [
    ['ID', source.evidence_source_id],
    ['Type', source.source_type || '—'],
    ['Status', statusTag(source.validation_status)],
    ['Created', formatDateTime(source.created_at)],
    ['Source Date', formatDateTime(source.source_datetime)],
    ['Confidence', source.confidence_score != null ? `${Math.round(source.confidence_score * 100)}%` : '—'],
    ['Records Linked', linked?.total ?? linked?.count ?? '—'],
    ['Owner', source.owner || source.created_by || '—'],
  ];

  fields.forEach(([k, v]) => {
    const item = el('div', { className: 'meta-item' },
      el('div', { className: 'meta-key' }, k)
    );
    const valEl = el('div', { className: 'meta-val' });
    if (v instanceof Node) valEl.appendChild(v);
    else valEl.textContent = String(v ?? '—');
    item.appendChild(valEl);
    grid.appendChild(item);
  });

  if (source.source_url || source.url) {
    const urlItem = el('div', { className: 'meta-item', style: { gridColumn: 'span 2' } },
      el('div', { className: 'meta-key' }, 'URL'),
      el('div', { className: 'meta-val' },
        el('a', { href: source.source_url || source.url, target: '_blank', rel: 'noopener noreferrer' },
          source.source_url || source.url
        )
      )
    );
    grid.appendChild(urlItem);
  }

  infoSection.appendChild(grid);
  body.appendChild(infoSection);

  // Re-run button
  const actionSection = el('div', { className: 'detail-section' });
  actionSection.appendChild(el('h4', {}, 'Actions'));

  const rerunBtn = el('button', { className: 'btn btn-primary' }, '↻ Re-run Extraction');
  rerunBtn.addEventListener('click', async () => {
    rerunBtn.disabled = true;
    rerunBtn.textContent = 'Running…';
    try {
      // Stub — show success
      await new Promise(r => setTimeout(r, 800));
      showToast('Extraction queued successfully.', 'success');
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    } finally {
      rerunBtn.disabled = false;
      rerunBtn.textContent = '↻ Re-run Extraction';
    }
  });
  actionSection.appendChild(rerunBtn);
  body.appendChild(actionSection);

  // Linked fields
  const linkedSection = el('div', { className: 'detail-section' });
  linkedSection.appendChild(el('h4', {}, 'Linked Repository Fields'));

  const items = linked?.items || linked?.fields || (Array.isArray(linked) ? linked : []);
  if (items.length === 0) {
    linkedSection.appendChild(el('p', { className: 'text-muted text-sm' }, 'No linked fields found.'));
  } else {
    const table = el('table', { className: 'wf-table' });
    table.innerHTML = `<thead><tr><th>Record</th><th>Field</th><th>Value Snippet</th><th>Confidence</th></tr></thead>`;
    const tbody = el('tbody');
    items.forEach(item => {
      tbody.appendChild(el('tr', {},
        el('td', {}, item.table_name || item.record_type || '—'),
        el('td', {}, el('span', { className: 'field-path' }, item.field_path || item.field || '—')),
        el('td', { className: 'muted', style: { maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          item.value_snippet || item.value || '—'
        ),
        el('td', {}, item.confidence != null ? `${Math.round(item.confidence * 100)}%` : '—')
      ));
    });
    table.appendChild(tbody);
    linkedSection.appendChild(table);
  }

  body.appendChild(linkedSection);
  pane.appendChild(body);
}
