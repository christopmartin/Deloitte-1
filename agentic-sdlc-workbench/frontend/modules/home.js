/**
 * modules/home.js — Dashboard module
 */
import { apiFetch, tag, statusTag, formatDateTime, renderTable, el, escHtml, showToast } from '../app.js';

export async function render(container) {
  container.innerHTML = '';

  const header = el('div', { className: 'module-header' },
    el('h2', {}, 'Dashboard'),
    el('p', { className: 'purpose-text' }, 'Overview of repository health, recent changes, and items requiring attention.')
  );
  container.appendChild(header);

  // Loading placeholder
  const kpiSection = el('div', { className: 'kpi-grid' });
  container.appendChild(kpiSection);

  const grid = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '0' } });
  container.appendChild(grid);

  // Fetch dashboard data
  try {
    const data = await apiFetch('/dashboard');
    renderKPIs(kpiSection, data);
    renderRecentChanges(grid, data);
    renderSideLists(grid, data);
  } catch (err) {
    kpiSection.innerHTML = '';
    grid.innerHTML = '';
    container.appendChild(el('div', { className: 'error-state' },
      el('strong', {}, 'Dashboard error: '), err.message
    ));
  }
}

function renderKPIs(container, data) {
  container.innerHTML = '';
  const kpis = [
    { label: 'Open Change Packets', value: data.open_change_packets ?? data.open_cps ?? '—', sub: 'awaiting review', variant: 'warn' },
    { label: 'Active Applications', value: data.active_projects ?? data.projects_count ?? '—', sub: 'in flight', variant: 'accent' },
    { label: 'Validation Exceptions', value: data.open_exceptions ?? data.exceptions ?? '—', sub: 'unresolved', variant: 'danger' },
    { label: 'Evidence Sources', value: data.evidence_sources ?? data.sources ?? '—', sub: 'connected', variant: 'ok' },
  ];

  kpis.forEach(k => {
    const card = el('div', { className: `kpi-card ${k.variant}` },
      el('div', { className: 'kpi-label' }, k.label),
      el('div', { className: 'kpi-value' }, String(k.value)),
      el('div', { className: 'kpi-sub' }, k.sub)
    );
    container.appendChild(card);
  });
}

function renderRecentChanges(grid, data) {
  const changes = data.recent_changes || data.recent_repository_changes || [];

  const panel = el('div', { className: 'panel' });
  const header = el('div', { className: 'panel-header' },
    el('span', { className: 'panel-title' }, 'Recent Repository Changes'),
    el('span', { className: 'tag tag-muted' }, `${changes.length} items`)
  );
  panel.appendChild(header);

  const columns = [
    { key: 'changed_at', label: 'Time', render: v => formatDateTime(v) },
    { key: 'project_name', label: 'Project' },
    { key: 'field_path', label: 'Field', render: v => {
      const s = el('span', { className: 'field-path' });
      s.textContent = v || '—';
      return s;
    }},
    { key: 'change_summary', label: 'Change' },
    { key: 'source', label: 'Source' },
    { key: 'status', label: 'Status', render: v => statusTag(v) },
  ];

  const table = renderTable(columns, changes);
  panel.appendChild(table);
  grid.appendChild(panel);
}

function renderSideLists(grid, data) {
  const col = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } });

  // Missing owners panel
  const missingOwners = data.missing_owners || [];
  const ownerPanel = el('div', { className: 'panel' });
  ownerPanel.appendChild(el('div', { className: 'panel-header' },
    el('span', { className: 'panel-title' }, 'Missing Owners'),
    missingOwners.length > 0
      ? el('span', { className: 'tag tag-danger' }, String(missingOwners.length))
      : el('span', { className: 'tag tag-ok' }, '0')
  ));

  const ownerBody = el('div', { className: 'panel-body' });
  if (missingOwners.length === 0) {
    ownerBody.innerHTML = '<div class="empty-state" style="padding:16px"><p>No missing owners — all records assigned.</p></div>';
  } else {
    const list = el('ul', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    missingOwners.slice(0, 8).forEach(item => {
      list.appendChild(el('li', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '13px', padding: '4px 0', borderBottom: '1px solid var(--color-border)' } },
        el('span', {}, item.record_label || item.name || item.id || '—'),
        el('span', { className: 'tag tag-warn' }, item.table_name || item.type || 'record')
      ));
    });
    ownerBody.appendChild(list);
  }
  ownerPanel.appendChild(ownerBody);
  col.appendChild(ownerPanel);

  // Reusable records panel
  const reusable = data.reusable_to_review || data.reusable_records || [];
  const reusePanel = el('div', { className: 'panel' });
  reusePanel.appendChild(el('div', { className: 'panel-header' },
    el('span', { className: 'panel-title' }, 'Reusable Records to Review'),
    reusable.length > 0
      ? el('span', { className: 'tag tag-warn' }, String(reusable.length))
      : el('span', { className: 'tag tag-ok' }, '0')
  ));

  const reuseBody = el('div', { className: 'panel-body' });
  if (reusable.length === 0) {
    reuseBody.innerHTML = '<div class="empty-state" style="padding:16px"><p>No reusable records pending review.</p></div>';
  } else {
    const list = el('ul', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    reusable.slice(0, 8).forEach(item => {
      list.appendChild(el('li', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '13px', padding: '4px 0', borderBottom: '1px solid var(--color-border)' } },
        el('span', {}, item.name || item.label || item.id || '—'),
        statusTag(item.status)
      ));
    });
    reuseBody.appendChild(list);
  }
  reusePanel.appendChild(reuseBody);
  col.appendChild(reusePanel);

  grid.appendChild(col);
}
