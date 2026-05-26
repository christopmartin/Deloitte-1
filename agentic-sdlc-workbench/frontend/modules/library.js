/**
 * modules/library.js — Reusable Pattern Library
 */
import { apiFetch, tag, statusTag, formatDate, renderTable, el, escHtml, showToast, navigate, setDrillDown } from '../app.js';

let allItems = [];
let filterScope = '';
let filterType = '';
let filterStatus = '';
let filterSearch = '';

export async function render(container) {
  container.innerHTML = '';
  allItems = [];

  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'Reusable Pattern Library'),
    el('p', { className: 'purpose-text' }, 'Browse and manage reusable design content: patterns, templates, standards, and best practices shared across applications.')
  ));

  // Filter bar
  const filterBar = el('div', { className: 'filter-bar', style: { marginBottom: '16px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', background: 'var(--color-panel)' } });

  const searchInput = el('input', { type: 'text', className: 'filter-input', placeholder: 'Search library…' });
  const scopeSel = el('select', { className: 'filter-select' });
  scopeSel.innerHTML = '<option value="">All Scopes</option><option value="PROGRAM">Program</option><option value="ORGANIZATION">Organization</option><option value="GLOBAL">Global</option>';
  const typeSel = el('select', { className: 'filter-select' });
  typeSel.innerHTML = '<option value="">All Types</option><option>requirement</option><option>risk</option><option>constraint</option><option>assumption</option><option>decision</option><option>pattern</option><option>standard</option><option>template</option>';
  const statusSel = el('select', { className: 'filter-select' });
  statusSel.innerHTML = '<option value="">All Statuses</option><option>active</option><option>draft</option><option>archived</option><option>in_review</option>';

  const refresh = () => refreshTable(tableContainer);
  searchInput.addEventListener('input', () => { filterSearch = searchInput.value.toLowerCase(); refresh(); });
  scopeSel.addEventListener('change', () => { filterScope = scopeSel.value; refresh(); });
  typeSel.addEventListener('change', () => { filterType = typeSel.value; refresh(); });
  statusSel.addEventListener('change', () => { filterStatus = statusSel.value; refresh(); });

  filterBar.appendChild(searchInput);
  filterBar.appendChild(scopeSel);
  filterBar.appendChild(typeSel);
  filterBar.appendChild(statusSel);
  container.appendChild(filterBar);

  // Count badge
  const countRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } });
  const countLabel = el('span', { className: 'text-muted text-sm', id: 'library-count' }, 'Loading…');
  countRow.appendChild(countLabel);
  container.appendChild(countRow);

  // Table panel
  const tablePanel = el('div', { className: 'panel' });
  const tableContainer = el('div', { id: 'library-table' });
  tableContainer.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
  tablePanel.appendChild(tableContainer);
  container.appendChild(tablePanel);

  // Load data
  try {
    const params = new URLSearchParams();
    const data = await apiFetch(`/library?${params}`);
    if (Array.isArray(data)) {
      allItems = data;
    } else {
      // API returns { use_cases, workflows, tools, knowledge_articles }
      allItems = [
        ...(data.use_cases || []),
        ...(data.workflows || []),
        ...(data.tools || []),
        ...(data.knowledge_articles || []),
        ...(data.items || []),
      ];
    }

    refresh();
  } catch (err) {
    tableContainer.innerHTML = `<div class="error-state"><strong>Error loading library:</strong> ${escHtml(err.message)}</div>`;
    document.getElementById('library-count').textContent = '';
  }
}

function refreshTable(tableContainer) {
  const filtered = allItems.filter(item => {
    if (filterSearch && !JSON.stringify(item).toLowerCase().includes(filterSearch)) return false;
    const scope = item.visibility_scope || item.scope || '';
    if (filterScope && scope !== filterScope) return false;
    if (filterType && (item.record_type || item.content_type) !== filterType) return false;
    if (filterStatus && (item.lifecycle_status || item.status) !== filterStatus) return false;
    return true;
  });

  const countLabel = document.getElementById('library-count');
  if (countLabel) {
    countLabel.textContent = `${filtered.length} of ${allItems.length} items`;
  }

  tableContainer.innerHTML = '';

  if (filtered.length === 0) {
    tableContainer.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📚</div><h3>No items found</h3><p>Try adjusting your filters.</p></div>';
    return;
  }

  const table = el('table', { className: 'wf-table' });
  table.innerHTML = `
    <thead>
      <tr>
        <th>Type</th>
        <th>Name</th>
        <th>Application</th>
        <th>Scope</th>
        <th>Status</th>
        <th>Last Review</th>
        <th></th>
      </tr>
    </thead>`;

  const tbody = el('tbody');

  // Map record_type → Design Review scope id
  const DR_SCOPE = { use_case: 'use-cases', workflow: 'workflows', tool: 'tools', agent_spec: 'agents' };

  filtered.forEach(item => {
    const tr = el('tr');

    // Type
    tr.appendChild(el('td', {}, tag(item.record_type || item.content_type || '—', 'info')));

    // Name + description
    const nameCell = el('td');
    nameCell.appendChild(el('span', { style: { fontWeight: '500' } }, item.name || item.label || '—'));
    if (item.description) {
      nameCell.appendChild(el('div', {
        style: { fontSize: '11px', color: 'var(--color-text-muted)', marginTop: '2px',
                 overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '220px' }
      }, item.description));
    }
    tr.appendChild(nameCell);

    // Application
    const appCell = el('td');
    if (item.project_name) {
      appCell.appendChild(el('span', { style: { fontWeight: '500', fontSize: '12px' } },
        item.client_name ? `${item.client_name} — ${item.project_name}` : item.project_name
      ));
      if (item.project_code) {
        appCell.appendChild(el('div', { style: { fontSize: '11px', color: 'var(--color-text-muted)' } }, item.project_code));
      }
    } else {
      appCell.textContent = '—';
    }
    tr.appendChild(appCell);

    // Scope
    const scope = item.visibility_scope || item.scope || '—';
    const scopeVariantMap = { PROGRAM: 'accent', ORGANIZATION: 'purple', GLOBAL: 'ok' };
    tr.appendChild(el('td', {}, tag(scope, scopeVariantMap[scope] || 'muted')));

    // Status
    tr.appendChild(el('td', {}, statusTag(item.lifecycle_status || item.status)));

    // Last Review
    tr.appendChild(el('td', { className: 'muted' }, formatDate(item.last_review_date || item.last_reviewed_at)));

    // Actions
    const actCell = el('td', { style: { whiteSpace: 'nowrap' } });
    const viewBtn = el('button', { className: 'btn btn-ghost btn-sm' }, 'View');
    viewBtn.addEventListener('click', () => showItemDetail(item));
    actCell.appendChild(viewBtn);

    // "Design Review →" button for types that have a DR tab
    const drScope = DR_SCOPE[item.record_type];
    if (drScope && item.id) {
      const drBtn = el('button', { className: 'btn btn-ghost btn-sm', style: { marginLeft: '4px', color: 'var(--color-accent)' } }, 'Design Review →');
      drBtn.addEventListener('click', () => {
        setDrillDown(drScope, `dr-entity-${item.id}`);
        navigate('design_review');
      });
      actCell.appendChild(drBtn);
    }

    tr.appendChild(actCell);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  tableContainer.appendChild(table);
}

function showItemDetail(item) {
  // Simple modal-style detail overlay
  const existing = document.getElementById('library-detail-modal');
  if (existing) existing.remove();

  const overlay = el('div', { id: 'library-detail-modal', className: 'modal-overlay' });
  const card = el('div', { className: 'modal-card', style: { width: '560px', maxWidth: '100%' } });

  // Header
  card.appendChild(el('div', { className: 'modal-header' },
    el('div', {},
      el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' } },
        tag(item.record_type || item.content_type || '—', 'info'),
        tag(item.visibility_scope || item.scope || '—', 'accent')
      ),
      el('h1', { style: { fontSize: '16px' } }, item.name || item.label || `Item ${item.id}`)
    ),
    statusTag(item.lifecycle_status || item.status)
  ));

  // Body
  const body = el('div', { style: { padding: '16px 28px', overflowY: 'auto', maxHeight: '400px' } });

  const grid = el('div', { className: 'meta-grid' });
  const appLabel = item.project_name
    ? (item.client_name ? `${item.client_name} — ${item.project_name}` : item.project_name)
    : '—';
  const metas = [
    ['Application', appLabel],
    ['Project Code', item.project_code || '—'],
    ['Owner', item.owner || '—'],
    ['Created', formatDate(item.created_at)],
    ['Last Review', formatDate(item.last_review_date || item.last_reviewed_at)],
    ['Next Review', formatDate(item.next_review_date)],
  ];
  metas.forEach(([k, v]) => {
    const i = el('div', { className: 'meta-item' },
      el('div', { className: 'meta-key' }, k),
      el('div', { className: 'meta-val' }, String(v ?? '—'))
    );
    grid.appendChild(i);
  });
  body.appendChild(grid);

  if (item.description) {
    body.appendChild(el('div', { style: { marginTop: '14px' } },
      el('div', { className: 'section-label' }, 'Description'),
      el('p', { style: { fontSize: '13px', color: 'var(--color-text)', lineHeight: '1.6' } }, item.description)
    ));
  }

  if (item.content || item.body) {
    body.appendChild(el('div', { style: { marginTop: '14px' } },
      el('div', { className: 'section-label' }, 'Content'),
      el('p', { style: { fontSize: '13px', color: 'var(--color-text)', lineHeight: '1.6' } }, item.content || item.body)
    ));
  }

  card.appendChild(body);

  // Footer
  const footer = el('div', { className: 'modal-footer' });
  const closeBtn = el('button', { className: 'btn btn-ghost' }, 'Close');
  closeBtn.addEventListener('click', () => overlay.remove());
  footer.appendChild(closeBtn);

  const drScope = { use_case: 'use-cases', workflow: 'workflows', tool: 'tools', agent_spec: 'agents' }[item.record_type];
  if (drScope && item.id) {
    const drBtn = el('button', { className: 'btn btn-primary' }, 'Open in Design Review →');
    drBtn.addEventListener('click', () => {
      overlay.remove();
      setDrillDown(drScope, `dr-entity-${item.id}`);
      navigate('design_review');
    });
    footer.appendChild(drBtn);
  }

  card.appendChild(footer);

  overlay.appendChild(card);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}
