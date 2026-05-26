/**
 * modules/baseline.js — Baseline Management
 */
import { apiFetch, tag, statusTag, formatDate, formatDateTime, el, escHtml, showToast, getCurrentProjectId } from '../app.js';

const STAGE_ORDER = ['draft', 'build', 'pilot', 'production', 'post_prod'];
let selectedBaseline = null;
let allBaselines = [];

export async function render(container) {
  container.innerHTML = '';
  selectedBaseline = null;
  allBaselines = [];

  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'Baselines'),
    el('p', { className: 'purpose-text' }, 'Manage application baselines across lifecycle stages. Lock milestones, compare versions, and track scope.')
  ));

  // Project picker toolbar
  const toolbar = el('div', { className: 'filter-bar', style: { marginBottom: '16px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', background: 'var(--color-panel)' } });
  const projLabel = el('label', { className: 'form-label', style: { margin: 0 } }, 'Application:');
  const projSelect = el('select', { className: 'filter-select', id: 'baseline-project-select' });
  projSelect.innerHTML = '<option value="">— Select Application —</option>';
  toolbar.appendChild(projLabel);
  toolbar.appendChild(projSelect);
  container.appendChild(toolbar);

  // Rail container
  const railPanel = el('div', { className: 'panel', style: { marginBottom: '16px' } });
  railPanel.appendChild(el('div', { className: 'panel-header' }, el('span', { className: 'panel-title' }, 'Lifecycle Rail')));
  const railBody = el('div', { className: 'panel-body' });
  railBody.innerHTML = '<div class="empty-state"><p>Select an application to view its baselines.</p></div>';
  railPanel.appendChild(railBody);
  container.appendChild(railPanel);

  // Version history panel
  const verPanel = el('div', { className: 'panel', style: { marginBottom: '16px' } });
  verPanel.appendChild(el('div', { className: 'panel-header' }, el('span', { className: 'panel-title' }, 'App Version History')));
  const verBody = el('div', { className: 'panel-body', id: 'baseline-ver-body' });
  verBody.innerHTML = '<div class="empty-state"><p>Select an application above.</p></div>';
  verPanel.appendChild(verBody);
  container.appendChild(verPanel);

  // Detail area
  const detailArea = el('div', { id: 'baseline-detail' });
  container.appendChild(detailArea);

  // Load projects
  try {
    const projData = await apiFetch('/projects');
    const projects = Array.isArray(projData) ? projData : (projData.items || []);
    projects.forEach(p => projSelect.appendChild(el('option', { value: p.project_id }, p.project_name)));

    const activeId = getCurrentProjectId();
    if (activeId) {
      projSelect.value = activeId;
      await loadBaselines(activeId, railBody, detailArea);
    }
  } catch (err) {
    railBody.innerHTML = `<div class="error-state"><strong>Error:</strong> ${escHtml(err.message)}</div>`;
  }

  projSelect.addEventListener('change', async () => {
    selectedBaseline = null;
    detailArea.innerHTML = '';
    if (projSelect.value) {
      await loadBaselines(projSelect.value, railBody, detailArea);
    } else {
      railBody.innerHTML = '<div class="empty-state"><p>Select an application to view baselines.</p></div>';
    }
  });
}

async function loadBaselines(projectId, railBody, detailArea) {
  railBody.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';

  try {
    const [data, verData] = await Promise.all([
      apiFetch(`/baselines?project_id=${projectId}`),
      apiFetch(`/projects/${projectId}/version-history`).catch(() => null),
    ]);
    allBaselines = Array.isArray(data) ? data : (data.items || data.baselines || []);
    renderRail(allBaselines, railBody, detailArea, projectId);
    renderVersionHistory(verData);
  } catch (err) {
    railBody.innerHTML = `<div class="error-state"><strong>Error loading baselines:</strong> ${escHtml(err.message)}</div>`;
  }
}

function renderVersionHistory(verData) {
  const verBody = document.getElementById('baseline-ver-body');
  if (!verBody) return;
  verBody.innerHTML = '';

  if (!verData) {
    verBody.innerHTML = '<div class="empty-state"><p>Version history unavailable.</p></div>';
    return;
  }

  const currentVer = verData.current_version_string ?? verData.current_version ?? '—';
  const events = verData.events || [];

  // Current version badge
  const hdr = el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' } });
  hdr.appendChild(el('span', { style: { fontSize: '13px', color: 'var(--color-text-muted)' } }, 'Current version:'));
  hdr.appendChild(el('span', { style: { fontSize: '20px', fontWeight: '700', color: 'var(--color-accent)' } }, `v${currentVer}`));
  hdr.appendChild(el('span', { style: { fontSize: '12px', color: 'var(--color-text-muted)', fontStyle: 'italic' } },
    events.length ? `${events.length} version event${events.length !== 1 ? 's' : ''}` : 'No version events yet — approve a Change Packet to increment'
  ));
  verBody.appendChild(hdr);

  if (!events.length) return;

  const table = el('table', { className: 'wf-table' });
  table.innerHTML = `<thead><tr>
    <th>Date</th><th>Version</th><th>Triggered By</th><th>Approved By</th>
  </tr></thead>`;
  const tbody = el('tbody');
  for (const ev of events) {
    const tr = el('tr');
    tr.appendChild(el('td', { style: { whiteSpace: 'nowrap' } }, formatDateTime(ev.changed_at)));
    const oldVer = ev.old_version_string ?? (ev.old_version != null ? ev.old_version : '?');
    const newVer = ev.new_version_string ?? (ev.new_version != null ? ev.new_version : '?');
    tr.appendChild(el('td', { style: { fontWeight: '700', color: 'var(--color-accent)' } },
      `v${oldVer} → v${newVer}`
    ));
    const cpCell = el('td');
    if (ev.triggered_by_cp) {
      cpCell.appendChild(el('span', { style: { fontFamily: 'monospace', fontSize: '12px', color: 'var(--color-accent)' } }, ev.triggered_by_cp.packet_code));
      if (ev.triggered_by_cp.summary) {
        cpCell.appendChild(el('div', { style: { fontSize: '11px', color: 'var(--color-text-muted)' } }, ev.triggered_by_cp.summary.slice(0, 60)));
      }
    } else {
      cpCell.textContent = '—';
    }
    tr.appendChild(cpCell);
    tr.appendChild(el('td', { style: { color: 'var(--color-text-muted)', fontSize: '12px' } }, ev.changed_by_name || ev.changed_by || '—'));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  verBody.appendChild(table);
}

function renderRail(baselines, railBody, detailArea, projectId) {
  railBody.innerHTML = '';

  if (baselines.length === 0) {
    railBody.innerHTML = '<div class="empty-state"><p>No baselines for this application yet.</p></div>';
    return;
  }

  // Sort baselines by stage order
  const sorted = [...baselines].sort((a, b) => {
    const ai = STAGE_ORDER.indexOf(a.stage || a.baseline_type);
    const bi = STAGE_ORDER.indexOf(b.stage || b.baseline_type);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const rail = el('div', { className: 'baseline-rail' });

  sorted.forEach((b, idx) => {
    const stage = b.baseline_type || 'draft';
    const isLocked = b.locked_at != null || b.baseline_status === 'approved';
    const isCurrent = b.baseline_status === 'draft';
    const isDraft = !isLocked && stage === 'draft';

    let nodeClass = 'baseline-node';
    if (isLocked) nodeClass += ' locked';
    if (isCurrent) nodeClass += ' current';
    if (isDraft) nodeClass += ' draft';
    if (selectedBaseline?.baseline_id === b.baseline_id) nodeClass += ' selected';

    const node = el('div', { className: nodeClass });

    const box = el('div', { className: 'baseline-node-box' });
    box.appendChild(el('span', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.4px' } }, stage));
    box.appendChild(el('span', { style: { fontSize: '11px', fontWeight: '700', marginTop: '2px' } }, b.baseline_name || `v${idx + 1}`));
    if (isLocked) box.appendChild(el('span', { style: { fontSize: '9px', marginTop: '1px' } }, '🔒'));
    node.appendChild(box);

    const label = el('div', { className: 'baseline-node-label' },
      formatDate(b.locked_at || b.created_at)
    );
    node.appendChild(label);

    node.addEventListener('click', () => {
      document.querySelectorAll('.baseline-node.selected').forEach(n => n.classList.remove('selected'));
      node.classList.add('selected');
      selectedBaseline = b;
      loadBaselineDetail(b, detailArea, sorted, projectId);
    });

    rail.appendChild(node);

    if (idx < sorted.length - 1) {
      rail.appendChild(el('div', { className: 'baseline-arrow' }));
    }
  });

  railBody.appendChild(rail);
}

async function loadBaselineDetail(baseline, detailArea, allSorted, projectId) {
  detailArea.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';

  try {
    const full = await apiFetch(`/baselines/${baseline.id}`).catch(() => baseline);
    renderBaselineDetail(full, detailArea, allSorted, projectId);
  } catch (err) {
    detailArea.innerHTML = `<div class="error-state"><strong>Error:</strong> ${escHtml(err.message)}</div>`;
  }
}

function renderBaselineDetail(b, detailArea, allSorted, projectId) {
  detailArea.innerHTML = '';

  const layout = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' } });

  // Contents panel
  const contentPanel = el('div', { className: 'panel' });
  contentPanel.appendChild(el('div', { className: 'panel-header' },
    el('span', { className: 'panel-title' }, `Baseline: ${b.baseline_name || b.baseline_id}`),
    el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      statusTag(b.baseline_status || (b.locked_at ? 'locked' : 'draft')),
      buildLockBtn(b, detailArea, allSorted, projectId)
    )
  ));

  const contentBody = el('div', { className: 'panel-body' });

  // Meta grid
  const grid = el('div', { className: 'meta-grid', style: { marginBottom: '16px' } });
  const metas = [
    ['Stage', b.baseline_type || '—'],
    ['Name', b.baseline_name || '—'],
    ['Records', b.record_count ?? b.records?.length ?? '—'],
    ['Open CPs', b.open_change_packets ?? '—'],
    ['Owner', b.owner || b.created_by || '—'],
    ['Status', statusTag(b.baseline_status || '—')],
    ['Created', formatDateTime(b.created_at)],
    ['Locked', b.locked_at ? formatDateTime(b.locked_at) : '—'],
  ];
  metas.forEach(([k, v]) => {
    const item = el('div', { className: 'meta-item' }, el('div', { className: 'meta-key' }, k));
    const val = el('div', { className: 'meta-val' });
    if (v instanceof Node) val.appendChild(v);
    else val.textContent = String(v ?? '—');
    item.appendChild(val);
    grid.appendChild(item);
  });
  contentBody.appendChild(grid);

  // Records table
  const records = b.records || b.contents || [];
  if (records.length > 0) {
    contentBody.appendChild(el('div', { className: 'section-label' }, `Records (${records.length})`));
    const t = el('table', { className: 'wf-table' });
    t.innerHTML = `<thead><tr><th>Type</th><th>Name</th><th>Status</th></tr></thead>`;
    const tb = el('tbody');
    records.slice(0, 20).forEach(r => {
      tb.appendChild(el('tr', {},
        el('td', {}, r.content_type || r.type || '—'),
        el('td', {}, r.name || r.label || r.id || '—'),
        el('td', {}, statusTag(r.status))
      ));
    });
    if (records.length > 20) {
      tb.appendChild(el('tr', {}, el('td', { colSpan: '3', className: 'muted', style: { textAlign: 'center' } },
        `+ ${records.length - 20} more records`
      )));
    }
    t.appendChild(tb);
    contentBody.appendChild(t);
  }

  contentPanel.appendChild(contentBody);
  layout.appendChild(contentPanel);

  // Compare panel
  const comparePanel = el('div', { className: 'panel' });
  comparePanel.appendChild(el('div', { className: 'panel-header' },
    el('span', { className: 'panel-title' }, 'Comparison vs Previous')
  ));

  const compareBody = el('div', { className: 'panel-body' });
  const idx = allSorted.findIndex(x => x.baseline_id === b.baseline_id);
  const prev = idx > 0 ? allSorted[idx - 1] : null;

  if (!prev) {
    compareBody.appendChild(el('div', { className: 'empty-state' }, el('p', {}, 'No previous baseline to compare.')));
  } else {
    compareBody.appendChild(el('p', { style: { fontSize: '13px', color: 'var(--color-text-muted)', marginBottom: '12px' } },
      `Comparing vs ${prev.baseline_name || prev.baseline_id}`
    ));
    loadComparison(b, prev, compareBody);
  }

  comparePanel.appendChild(compareBody);
  layout.appendChild(comparePanel);

  detailArea.appendChild(layout);
}

async function loadComparison(current, previous, compareBody) {
  const spinner = el('div', { className: 'loading-state' }, el('div', { className: 'loading-spinner' }));
  compareBody.appendChild(spinner);

  try {
    const diff = await apiFetch(`/baselines/${current.baseline_id}/compare/${previous.baseline_id}`).catch(() => null);
    spinner.remove();

    if (!diff) {
      compareBody.appendChild(el('p', { className: 'text-muted text-sm' }, 'Comparison data unavailable.'));
      return;
    }

    const changes = diff.changes || diff.diffs || diff.items || [];
    if (changes.length === 0) {
      compareBody.appendChild(el('div', { className: 'empty-state' }, el('p', {}, 'No differences found.')));
      return;
    }

    changes.slice(0, 15).forEach(change => {
      const row = el('div', { className: 'diff-row' });
      const field = el('div', { className: 'diff-field' });
      field.appendChild(el('span', { className: 'field-path' }, change.field_path || change.field || '—'));
      row.appendChild(field);
      if (change.old_value != null) row.appendChild(el('span', { className: 'diff-old' }, String(change.old_value)));
      row.appendChild(el('span', { className: 'diff-arrow' }, '→'));
      if (change.new_value != null) row.appendChild(el('span', { className: 'diff-new' }, String(change.new_value)));
      compareBody.appendChild(row);
    });

    if (changes.length > 15) {
      compareBody.appendChild(el('p', { className: 'text-muted text-sm', style: { marginTop: '8px' } },
        `+ ${changes.length - 15} more changes`
      ));
    }
  } catch (err) {
    spinner.remove();
    compareBody.appendChild(el('p', { className: 'text-muted text-sm' }, 'Could not load comparison.'));
  }
}

function buildLockBtn(b, detailArea, allSorted, projectId) {
  if (b.locked_at != null || b.baseline_status === 'approved') {
    return el('span', { className: 'tag tag-ok' }, '🔒 Locked');
  }

  const btn = el('button', { className: 'btn btn-primary btn-sm' }, '🔒 Lock Current');
  btn.addEventListener('click', async () => {
    if (!confirm(`Lock baseline "${b.baseline_name || b.baseline_id}"? This cannot be undone.`)) return;
    btn.disabled = true;
    btn.textContent = 'Locking…';
    try {
      const updated = await apiFetch(`/baselines/${b.baseline_id}/lock`, { method: 'POST' });
      showToast('Baseline locked.', 'success');
      // Refresh
      await loadBaselines(projectId,
        document.querySelector('#baseline-detail').previousElementSibling?.querySelector('.panel-body'),
        detailArea
      );
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
      btn.disabled = false;
      btn.textContent = '🔒 Lock Current';
    }
  });
  return btn;
}
