/**
 * modules/home.js — Dashboard module
 */
import { apiFetch, tag, statusTag, formatDateTime, renderTable, el, escHtml, showToast, navigate } from '../app.js';

export async function render(container) {
  container.innerHTML = '';

  const header = el('div', { className: 'module-header' },
    el('h2', {}, 'Dashboard'),
    el('p', { className: 'purpose-text' }, 'Overview of repository health, recent changes, and items requiring attention.')
  );
  container.appendChild(header);

  // Plan D — post-apply banner (populated once dashboard data loads)
  const bannerSection = el('div');
  container.appendChild(bannerSection);

  // Loading placeholder
  const kpiSection = el('div', { className: 'kpi-grid' });
  container.appendChild(kpiSection);

  const grid = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '0' } });
  container.appendChild(grid);

  // Fetch dashboard data
  try {
    const data = await apiFetch('/dashboard');
    renderPostApplyBanner(bannerSection, data);
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

// Plan D — banner when a recently-applied change packet has unresolved post-apply
// findings (residual references to a term it changed). Names the packets so they're
// findable even though approved CPs are hidden from the default Change Packets view.
const POST_APPLY_DISMISS_KEY = 'postApplyBannerDismissed';

function getDismissedPostApply() {
  try { return JSON.parse(localStorage.getItem(POST_APPLY_DISMISS_KEY) || '[]'); }
  catch { return []; }
}

function renderPostApplyBanner(container, data) {
  container.innerHTML = '';
  const changes = data.recent_changes || data.recent_repository_changes || [];
  const flagged = changes.filter(c => c.post_apply_status === 'flagged');
  if (flagged.length === 0) return;

  // Dismissal persists per flagged-packet set: stays hidden on reload, but
  // re-shows if a new packet gets flagged.
  const ids = flagged.map(c => c.packet_code || c.change_packet_id);
  const dismissed = getDismissedPostApply();
  if (ids.every(id => dismissed.includes(id))) return;

  const banner = el('div', { style: 'position:relative;border:1px solid var(--color-danger);border-left:3px solid var(--color-danger);background:var(--color-danger-bg);border-radius:8px;padding:12px 14px;margin-bottom:16px;cursor:pointer' });

  const closeBtn = el('button', {
    title: 'Dismiss',
    'aria-label': 'Dismiss',
    style: 'position:absolute;top:8px;right:10px;border:none;background:transparent;color:var(--color-danger);font-size:18px;line-height:1;cursor:pointer;padding:2px 6px'
  }, '×');
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    localStorage.setItem(POST_APPLY_DISMISS_KEY, JSON.stringify([...new Set([...dismissed, ...ids])]));
    container.innerHTML = '';
  });
  banner.appendChild(closeBtn);
  banner.appendChild(el('div', { style: 'font-weight:600;color:var(--color-danger);margin-bottom:4px;padding-right:24px' },
    `⚠ ${flagged.length} recently-applied change packet${flagged.length !== 1 ? 's' : ''} need a post-apply review`));
  banner.appendChild(el('div', { style: 'font-size:12px;color:var(--color-text-muted);margin-bottom:6px' },
    'A change was applied but other design elements may still reference the old term. Open the packet to review residual references.'));
  flagged.slice(0, 5).forEach(c => banner.appendChild(
    el('div', { style: 'font-size:12px;color:var(--color-text)' },
      `• ${c.packet_code || c.change_packet_id}${c.project_name ? ' — ' + c.project_name : ''}`)));
  banner.appendChild(el('div', { style: 'font-size:11px;color:var(--color-accent);margin-top:6px;font-weight:600' }, 'Open Change Packets →'));
  banner.addEventListener('click', () => navigate('change_packets'));
  container.appendChild(banner);
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
