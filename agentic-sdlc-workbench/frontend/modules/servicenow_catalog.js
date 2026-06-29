/**
 * modules/servicenow_catalog.js — Administration › ServiceNow Catalog (whole-instance awareness)
 *
 * Read-only, identity-only CROSS-SCOPE sweep of the linked ServiceNow instance (names,
 * sys_ids, scope, 1-2 discriminators — no payloads). Complements the scoped deep-capture:
 * catalog the whole instance to know WHAT EXISTS (collision awareness for the deployer +
 * cross-scope net-new for governance), then deep-capture one scope to edit its design.
 * Nothing is written.
 */
import { apiFetch, el, showToast, getCurrentProjectId } from '../app.js';

function num(n) { return (n == null) ? '—' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function when(ts) { return ts ? String(ts).slice(0, 16).replace('T', ' ') : '—'; }

// Workbench design type → SN surface(s). Mirrors DESIGN_SURFACE_MAP in sn-instance-catalog.js.
const DESIGN_GROUPS = [
  { label: 'AI Agents',         surfaces: ['sn_aia_agent']                     },
  { label: 'AI Tools',          surfaces: ['sn_aia_tool']                      },
  { label: 'AI Use Cases',      surfaces: ['sn_aia_usecase']                   },
  { label: 'Flows & Workflows', surfaces: ['sys_hub_flow']                     },
  { label: 'Data Models',       surfaces: ['sys_db_object']                    },
  { label: 'Impl. Artifacts',   surfaces: ['sys_script', 'sys_script_include'] },
  { label: 'Catalog Items',     surfaces: ['sc_cat_item']                      },
  { label: 'Integrations',      surfaces: ['sys_rest_message']                 },
];

let _poll = null;
function stopPoll() { if (_poll) { clearInterval(_poll); _poll = null; } }

export async function render(container) {
  stopPoll();
  container.innerHTML = '';
  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'ServiceNow Catalog'),
    el('p', { className: 'purpose-text' },
      'Read-only "table of contents" of the whole ServiceNow instance — names and ids only, no ' +
      'payloads. Gives the deployer collision awareness and surfaces records created directly on ' +
      'the instance. Nothing is written to ServiceNow.')
  ));

  const pid = getCurrentProjectId();
  if (!pid) {
    container.appendChild(el('div', { className: 'error-state' }, 'Select an Application first (top-right selector).'));
    return;
  }

  let project;
  try { project = await apiFetch(`/projects/${pid}`); }
  catch (err) { container.appendChild(el('div', { className: 'error-state' }, 'Failed to load Application: ' + err.message)); return; }

  // ── Run panel ────────────────────────────────────────────────────────────────
  const runPanel = el('div', { className: 'panel' });
  runPanel.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, `Sweep — ${project.project_name || pid}`)));
  const runBody = el('div', { className: 'panel-body', style: 'display:grid;gap:12px;max-width:680px' });
  runPanel.appendChild(runBody);
  container.appendChild(runPanel);

  runBody.appendChild(el('div', { style: 'font-size:13px' },
    el('div', {}, el('strong', {}, 'Instance: '), project.servicenow_instance || '(from server SN_INSTANCE env)'),
    el('div', {}, el('strong', {}, 'Credentials: '), project.has_sn_password ? `${project.sn_user || '(user)'} / ••••••••` : '(server env fallback)'),
    el('div', { style: 'color:var(--text-muted);margin-top:4px' },
      'The sweep reflects only what this account can read — ServiceNow hides rows it lacks access to silently.')));

  const runBtn = el('button', { className: 'btn btn-primary' }, 'Run catalog sweep');
  const out = el('div', { style: 'margin-top:8px' });
  runBody.appendChild(el('div', {}, runBtn));
  container.appendChild(out);

  const resultsPanel = el('div', {});
  container.appendChild(resultsPanel);

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    out.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Sweeping instance (read-only)…</span></div>';
    resultsPanel.innerHTML = '';
    try {
      await apiFetch(`/projects/${pid}/servicenow/catalog`, { method: 'POST', body: JSON.stringify({}) });
      pollCatalog(pid, out, resultsPanel, runBtn);
    } catch (err) {
      out.innerHTML = ''; out.appendChild(el('div', { className: 'error-state' }, 'Sweep failed: ' + err.message)); runBtn.disabled = false;
    }
  });

  // Show the most recent catalog run, if any.
  try {
    const latest = await apiFetch(`/projects/${pid}/servicenow/catalog/latest`);
    if (latest && latest.status === 'complete') {
      renderSummary(resultsPanel, pid, latest);
    } else if (latest && latest.status === 'running') {
      out.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>A catalog sweep is running…</span></div>';
      runBtn.disabled = true;
      pollCatalog(pid, out, resultsPanel, runBtn);
    } else if (latest && latest.status === 'failed') {
      resultsPanel.appendChild(el('div', { className: 'error-state' }, 'Last sweep failed: ' + (latest.error || 'unknown error')));
    }
  } catch { /* none yet (404) — first run */ }
}

function pollCatalog(pid, out, resultsPanel, runBtn) {
  stopPoll();
  let ticks = 0;
  _poll = setInterval(async () => {
    if (++ticks > 60) { stopPoll(); out.innerHTML = ''; out.appendChild(el('div', { className: 'error-state' }, 'Catalog sweep timed out.')); runBtn.disabled = false; return; }
    let row;
    try { row = await apiFetch(`/projects/${pid}/servicenow/catalog/latest`); } catch { return; }
    if (row.status === 'complete') {
      stopPoll(); out.innerHTML = ''; runBtn.disabled = false;
      renderSummary(resultsPanel, pid, row);
      showToast('Catalog sweep complete', 'success');
    } else if (row.status === 'failed') {
      stopPoll(); out.innerHTML = ''; runBtn.disabled = false;
      out.appendChild(el('div', { className: 'error-state' }, 'Catalog sweep failed: ' + (row.error || 'unknown error')));
    }
  }, 2500);
}

function renderSummary(panel, pid, latest) {
  panel.innerHTML = '';
  const s = latest.summary || {};
  const counts = s.surface_counts || {};
  const surfaces = Object.keys(counts).filter(t => counts[t] > 0);

  // Headline metrics
  const stats = el('div', { style: 'display:flex;gap:26px;flex-wrap:wrap;margin:16px 0' });
  const stat = (val, lbl) => el('div', {}, el('div', { style: 'font-size:20px;font-weight:700' }, val), el('div', { style: 'font-size:11px;color:var(--text-muted)' }, lbl));
  stats.appendChild(stat(num(s.total_entries), 'Records cataloged'));
  stats.appendChild(stat(String(surfaces.length), 'Surfaces with records'));
  stats.appendChild(stat(when(s.captured_at), 'Captured'));
  stats.appendChild(stat(latest.capturing_user || '—', 'By account'));
  panel.appendChild(stats);

  // Completeness caveat (ACL).
  panel.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin:-6px 0 4px' },
    '⚠ Reflects only what the capturing account can read — ServiceNow ACL-filters rows silently, so absence is not proof a name is free.'));
  if ((s.capped_surfaces || []).length) {
    panel.appendChild(el('div', { style: 'font-size:12px;color:#cf222e;margin-bottom:6px' },
      '⚠ Capped (PARTIAL) surfaces: ' + s.capped_surfaces.join(', ') + ' — raise SN_CAPTURE_MAX_ROWS to capture fully.'));
  }

  // Sweep errors — only real failures (auth, network, 5xx). HTTP 400/403/404 are silently
  // skipped as "not visible to this account" and do not appear here.
  if ((s.warnings || []).length) {
    const box = el('div', { style: 'background:#fff8f0;border:1px solid #e8a94c;border-radius:6px;padding:10px 14px;margin:8px 0;font-size:12px' });
    box.appendChild(el('div', { style: 'font-weight:600;color:#92400e;margin-bottom:6px' },
      `Sweep errors (${s.warnings.length} surface${s.warnings.length === 1 ? '' : 's'} failed):`));
    const ul = el('ul', { style: 'margin:0;padding-left:18px;color:#78350f' });
    s.warnings.slice(0, 10).forEach(w => ul.appendChild(el('li', { style: 'font-family:monospace;margin:2px 0' }, w)));
    if (s.warnings.length > 10) ul.appendChild(el('li', { style: 'color:var(--text-muted)' }, `… and ${s.warnings.length - 10} more`));
    box.appendChild(ul);
    box.appendChild(el('div', { style: 'margin-top:8px;color:#92400e' },
      'Common causes: auth failure (401), network error, or server error (5xx). Check the server log for details.'));
    panel.appendChild(box);
  }

  // ── Design elements ─────────────────────────────────────────────────────────
  // The Tier 1 view: counts grouped by Workbench design type, not raw SN table.
  panel.appendChild(el('h4', { style: 'margin:20px 0 6px' }, 'Design elements on this instance'));
  const dt = el('table', { className: 'dr-compact-table', style: 'width:100%;max-width:520px' });
  dt.appendChild(el('thead', {}, el('tr', {},
    el('th', {}, 'Design type'),
    el('th', { style: 'text-align:right' }, 'Count'),
    el('th', { style: 'font-size:11px;color:var(--text-muted)' }, 'SN surface(s)'),
  )));
  const dtb = el('tbody');
  let anyDesignRecord = false;
  for (const g of DESIGN_GROUPS) {
    const total = g.surfaces.reduce((acc, tbl) => acc + (counts[tbl] || 0), 0);
    if (total > 0) anyDesignRecord = true;
    dtb.appendChild(el('tr', {},
      el('td', {}, g.label),
      el('td', { style: 'text-align:right;font-family:monospace' },
        total > 0 ? num(total) : el('span', { style: 'color:var(--text-muted)' }, '—')),
      el('td', { style: 'font-family:monospace;font-size:11px;color:var(--text-muted)' }, g.surfaces.join(', ')),
    ));
  }
  dt.appendChild(dtb);
  panel.appendChild(dt);
  if (!anyDesignRecord) {
    panel.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:4px' },
      'No design element records visible to this account — try sweeping with an account that has access to AI, flow, and script tables.'));
  }

  // ── Drift / governance (loads async) ────────────────────────────────────────
  const driftBox = el('div', { style: 'margin-top:16px' },
    el('div', { className: 'loading-state' }, el('div', { className: 'loading-spinner' }), el('span', {}, 'Checking drift…')));
  panel.appendChild(driftBox);
  loadDrift(pid, driftBox);

  // ── All surfaces (collapsed reference) ──────────────────────────────────────
  const details = el('details', { style: 'margin-top:16px' });
  details.appendChild(el('summary', { style: 'cursor:pointer;font-size:13px;color:var(--text-muted);user-select:none' },
    `All surfaces (${surfaces.length})`));
  const allT = el('table', { className: 'dr-compact-table', style: 'width:100%;max-width:520px;margin-top:8px' });
  allT.appendChild(el('thead', {}, el('tr', {}, el('th', {}, 'Surface'), el('th', { style: 'text-align:right' }, 'Records'))));
  const allTb = el('tbody');
  surfaces.sort((a, b) => counts[b] - counts[a]).forEach(surf => allTb.appendChild(el('tr', {},
    el('td', { style: 'font-family:monospace;font-size:12px' }, surf),
    el('td', { style: 'text-align:right;font-family:monospace' }, num(counts[surf])))));
  allT.appendChild(allTb);
  details.appendChild(allT);
  panel.appendChild(details);
}

async function loadDrift(pid, box) {
  let d;
  try { d = await apiFetch(`/projects/${pid}/servicenow/catalog/drift`); }
  catch { box.innerHTML = ''; return; }
  box.innerHTML = '';

  const section = (title, items, color, renderRow) => {
    if (!items || !items.length) return;
    box.appendChild(el('h4', { style: `margin:14px 0 6px;color:${color}` }, `${title} (${items.length})`));
    const t = el('table', { className: 'dr-compact-table', style: 'width:100%' });
    t.appendChild(el('thead', {}, renderRow.header));
    const tb = el('tbody'); items.forEach(it => tb.appendChild(renderRow.row(it))); t.appendChild(tb);
    box.appendChild(t);
  };

  section('🆕 Net-new — created directly on the instance', d.untracked, '#bf8700', {
    header: el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Surface'), el('th', {}, 'Scope'), el('th', {}, 'sys_id')),
    row: (it) => el('tr', {}, el('td', {}, it.name), el('td', { style: 'font-family:monospace;font-size:12px' }, it.surface), el('td', {}, it.scope || '—'), el('td', { style: 'font-family:monospace;font-size:11px' }, it.sys_id)),
  });
  if (d.untracked && d.untracked.length) {
    box.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin:4px 0 8px' },
      'Candidates for inbound sync — review and reconcile into the design via ServiceNow Sync. Nothing is auto-applied.'));
  }

  section('↔ Scope change — same record found in a different scope', d.moved, '#0969da', {
    header: el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'From scope'), el('th', {}, 'To scope'), el('th', {}, 'sys_id')),
    row: (it) => el('tr', {}, el('td', {}, it.name), el('td', {}, it.from_scope || '—'), el('td', {}, it.to_scope || '—'), el('td', { style: 'font-family:monospace;font-size:11px' }, it.source_sys_id)),
  });

  // "Not confirmed" replaces "Vanished" — same data, clearer framing.
  section('⚠ Not confirmed in this sweep', d.vanished, '#6b7280', {
    header: el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Workbench type'), el('th', {}, 'sys_id')),
    row: (it) => el('tr', {}, el('td', {}, it.name), el('td', {}, it.wb_type), el('td', { style: 'font-family:monospace;font-size:11px' }, it.source_sys_id)),
  });
  if (d.vanished && d.vanished.length) {
    box.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:4px' },
      'These tracked records were not seen in this sweep. Two possible reasons: the capturing account ' +
      'lacks read access (ACL-hidden), or the record was deleted on the instance. Re-sweep with a ' +
      'higher-privilege account to confirm. Never acted on automatically.'));
  }

  if (!(d.untracked || []).length && !(d.moved || []).length && !(d.vanished || []).length) {
    box.appendChild(el('div', { style: 'font-size:13px;color:#1a7f37;margin:8px 0' },
      '✓ No drift — all tracked records confirmed present, no net-new in this scope.'));
  }
}
