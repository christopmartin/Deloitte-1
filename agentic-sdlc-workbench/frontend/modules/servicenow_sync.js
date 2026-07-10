/**
 * modules/servicenow_sync.js — Administration › ServiceNow Sync (Phase F)
 *
 * Pulls a linked ServiceNow app's live design, runs the reconciliation pipeline
 * (reverse-engineer → reconcile → independent review) and GATES each proposal:
 * safe additive changes auto-apply (non-destructively, storing source_hash);
 * everything else lands in a pending_review Change Packet for human review.
 *
 *   • Apply-mode toggle (system setting: additive_hitl | confidence_gate | review_all)
 *   • Preview (dry-run) — see the gated plan with confidence / destructive flags
 *     and the auto-vs-HITL decision per item, writing nothing.
 *   • Run sync — apply the safe additive changes and queue the rest.
 */
import { apiFetch, el, showToast, getCurrentProjectId, navigate } from '../app.js';

const previewKey = pid => `wb_sn_preview_${pid}`;

const APPLY_MODES = [
  { id: 'additive_hitl',  label: 'Additive auto + HITL (default)', hint: 'Auto-apply safe additive changes (new records, fills into empty fields) above the confidence threshold; everything else goes to human review.' },
  { id: 'confidence_gate', label: 'Confidence gate',               hint: 'Auto-apply any non-destructive change that clears the project confidence threshold; the rest goes to human review.' },
  { id: 'review_all',     label: 'Review everything',              hint: 'Nothing auto-applies — every proposed change is queued for human review.' },
];

function pill(text, color) {
  return el('span', { style: `display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:${color}` }, text);
}
function decisionPill(target) {
  if (target === 'auto') return pill('AUTO-APPLY', '#1a7f37');
  if (target === 'hitl') return pill('HUMAN REVIEW', '#bf8700');
  return pill('NO CHANGE', '#6b7280');
}
function classPill(cls) {
  const c = { new: '#0969da', changed: '#8250df', drift: '#9a6700', unchanged: '#6b7280' }[cls] || '#6b7280';
  return pill(cls, c);
}
function conf(n) { return (typeof n === 'number') ? (n * 100).toFixed(0) + '%' : '—'; }

export async function render(container) {
  container.innerHTML = '';

  const headerEl = el('div', { className: 'module-header' },
    el('h2', {}, 'ServiceNow Sync'),
    el('p', { className: 'purpose-text' },
      'Reconcile a linked ServiceNow application back into this Workbench design. The sync is ' +
      'non-destructive: it never blanks, shrinks, or deletes populated Workbench content. Safe ' +
      'additive changes can auto-apply; conflicts and anything uncertain go to human review.')
  );

  // Direction banner
  const dirBanner = el('div', {
    style: 'display:flex;align-items:center;justify-content:space-between;' +
           'background:var(--color-bg);border:1px solid var(--color-border);' +
           'border-radius:var(--radius);padding:8px 14px;margin-top:10px;' +
           'font-size:12px;color:var(--color-text-muted);'
  },
    el('span', {},
      el('strong', { style: 'color:var(--color-text)' }, 'Inbound: ServiceNow → Workbench'),
      document.createTextNode('  ·  Pull the latest design changes from ServiceNow and reconcile them into your Workbench design.')
    ),
    el('a', {
      style: 'font-size:11px;color:var(--color-accent);cursor:pointer;white-space:nowrap;margin-left:16px;text-decoration:none;flex-shrink:0;',
      title: 'Go to Build Export to deploy Workbench changes back to ServiceNow'
    },
      'Deploy to SN ↗'
    )
  );
  // Wire the reciprocal link
  dirBanner.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); navigate('build_export'); });
  headerEl.appendChild(dirBanner);

  container.appendChild(headerEl);

  const pid = getCurrentProjectId();
  if (!pid) {
    container.appendChild(el('div', { className: 'error-state' }, 'Select a project first (top-right project selector).'));
    return;
  }

  let project;
  try { project = await apiFetch(`/projects/${pid}`); }
  catch (err) { container.appendChild(el('div', { className: 'error-state' }, 'Failed to load project: ' + err.message)); return; }

  // ── Apply-mode panel ───────────────────────────────────────────────────────
  const modePanel = el('div', { className: 'panel' });
  modePanel.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, 'Apply mode (system-wide)')));
  const modeBody = el('div', { className: 'panel-body', style: 'display:grid;gap:12px;max-width:640px' });
  modePanel.appendChild(modeBody);
  container.appendChild(modePanel);

  const modeSel = el('select', { className: 'form-input', style: 'max-width:340px' });
  APPLY_MODES.forEach(m => modeSel.appendChild(el('option', { value: m.id }, m.label)));
  const modeHint = el('div', { style: 'font-size:11px;color:var(--text-muted)' });
  const refreshHint = () => { const m = APPLY_MODES.find(x => x.id === modeSel.value); modeHint.textContent = m ? m.hint : ''; };
  modeSel.addEventListener('change', refreshHint);
  try {
    const cur = await apiFetch('/settings/sn-sync-apply-mode');
    if (cur && cur.mode) modeSel.value = cur.mode;
  } catch { /* leave default */ }
  refreshHint();

  const saveMode = el('button', { className: 'btn btn-secondary' }, 'Save apply mode');
  saveMode.addEventListener('click', async () => {
    saveMode.disabled = true;
    try { await apiFetch('/settings/sn-sync-apply-mode', { method: 'PUT', body: JSON.stringify({ mode: modeSel.value }) }); showToast('Apply mode saved', 'success'); }
    catch (err) { showToast('Save failed: ' + err.message, 'error'); }
    finally { saveMode.disabled = false; }
  });
  modeBody.appendChild(el('div', { className: 'form-group' }, el('label', { className: 'form-label' }, 'How freely safe changes apply'), modeSel, modeHint));
  modeBody.appendChild(el('div', {},
    saveMode,
    el('span', { style: 'margin-left:14px;font-size:12px;color:var(--text-muted)' },
      `Confidence threshold for this project: ${conf(project.confidence_threshold)} (edit in Projects).`)));

  // ── Link status + actions ────────────────────────────────────────────────────
  const linkPanel = el('div', { className: 'panel', style: 'margin-top:18px' });
  linkPanel.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, `Sync — ${project.project_name || pid}`)));
  const linkBody = el('div', { className: 'panel-body' });
  linkPanel.appendChild(linkBody);
  container.appendChild(linkPanel);

  if (!project.servicenow_scope) {
    linkBody.appendChild(el('div', { className: 'empty-state' },
      'This project is not linked to a ServiceNow scope. Link it (servicenow_scope / instance) before syncing.'));
    return;
  }
  linkBody.appendChild(el('div', { style: 'font-size:13px;margin-bottom:12px' },
    el('div', {}, el('strong', {}, 'Scope: '), project.servicenow_scope),
    el('div', {}, el('strong', {}, 'Instance: '), project.servicenow_instance || '(from server SN_INSTANCE env)'),
    project.sn_last_synced_at ? el('div', {}, el('strong', {}, 'Last synced: '), project.sn_last_synced_at) : null));

  // ── Active import slice (bounds capture + write-back) ─────────────────────────
  const sliceLine = el('div', { style: 'font-size:12px;margin-bottom:12px;padding:8px 10px;background:var(--color-bg-panel,#f6f8fa);border:1px solid var(--color-border);border-radius:var(--radius)' }, 'Ingest scope: loading…');
  linkBody.appendChild(sliceLine);
  try {
    const ip = await apiFetch(`/projects/${pid}/servicenow/import-profile`);
    if (ip && ip.source === 'saved' && ip.profile && (ip.profile.include_surfaces || []).length) {
      const surfaces = ip.profile.include_surfaces;
      sliceLine.innerHTML = '';
      sliceLine.appendChild(el('strong', {}, `Slice: ${surfaces.length} surface${surfaces.length === 1 ? '' : 's'}`));
      sliceLine.appendChild(document.createTextNode(` — ${surfaces.slice(0, 8).join(', ')}${surfaces.length > 8 ? ', …' : ''}${ip.profile.per_surface_cap ? ` · cap ${ip.profile.per_surface_cap}/surface` : ''}. `));
      const editLink = el('a', { style: 'color:var(--color-accent);cursor:pointer;text-decoration:none' }, 'Edit in Assessment ↗');
      editLink.addEventListener('click', (e) => { e.preventDefault(); navigate('servicenow_assessment'); });
      sliceLine.appendChild(editLink);
    } else {
      sliceLine.innerHTML = '';
      sliceLine.appendChild(el('strong', {}, 'Whole scope'));
      sliceLine.appendChild(document.createTextNode(' — no slice set; the entire scope will be ingested. '));
      const setLink = el('a', { style: 'color:var(--color-accent);cursor:pointer;text-decoration:none' }, 'Define a slice in Assessment ↗');
      setLink.addEventListener('click', (e) => { e.preventDefault(); navigate('servicenow_assessment'); });
      sliceLine.appendChild(setLink);
    }
  } catch { sliceLine.textContent = 'Ingest scope: whole scope (import profile unavailable).'; }

  // ── Credential status (read-only — edit in Applications Admin) ─────────────
  linkBody.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:14px' },
    project.has_sn_password
      ? `Credentials: ${project.sn_user || '(user not set)'} / •••••••• — edit in Applications Admin.`
      : 'No stored credentials — using server SN_USER / SN_PASSWORD env vars. Configure per-project credentials in Applications Admin.'));

  const previewBtn = el('button', { className: 'btn btn-secondary' }, 'Preview sync (dry run)');
  const runBtn = el('button', { className: 'btn btn-primary', style: 'margin-left:10px' }, 'Run sync');
  const out = el('div', { style: 'margin-top:16px' });
  linkBody.appendChild(el('div', {}, previewBtn, runBtn));
  linkBody.appendChild(out);

  // Restore last dry-run preview — survives navigation without re-running the AI pipeline
  const _saved = localStorage.getItem(previewKey(pid));
  if (_saved) {
    try {
      const { plan, ts } = JSON.parse(_saved);
      const ageMin = Math.round((Date.now() - ts) / 60000);
      renderPlan(out, plan, false);
      out.insertBefore(
        el('div', { style: 'font-size:12px;color:var(--text-muted);padding:6px 10px;background:var(--color-bg-panel,#f6f8fa);border:1px solid var(--color-border);border-radius:var(--radius);margin-bottom:8px' },
          `ℹ Preview from ${ageMin < 1 ? 'just now' : ageMin + ' min ago'} — run again to refresh.`),
        out.firstChild
      );
    } catch { localStorage.removeItem(previewKey(pid)); }
  }

  const busy = (on) => { previewBtn.disabled = on; runBtn.disabled = on; };

  previewBtn.addEventListener('click', () => runEstimatedSyncFlow(pid, out, busy, true));
  runBtn.addEventListener('click', () => runEstimatedSyncFlow(pid, out, busy, false));
}

// ── #105: estimate → confirm → async job (progress meter + cancel) ─────────────────────────
// A dry run is NOT free — it runs the same AI stages as a real run and only skips the DB
// write — so BOTH Preview and Run go through the same estimate-then-confirm flow before any
// AI money is spent, then hand off to the async job endpoints for a live progress meter and a
// cancel button (a long sync previously had no visibility and no way to stop it — #101/#105).
async function runEstimatedSyncFlow(pid, out, busy, dryRun) {
  busy(true);
  out.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Estimating…</span></div>';
  let est;
  try {
    est = await apiFetch(`/projects/${pid}/servicenow/sync/estimate`, { method: 'POST', body: JSON.stringify({}) });
  } catch (err) {
    out.innerHTML = ''; out.appendChild(el('div', { className: 'error-state' }, 'Estimate failed: ' + err.message));
    busy(false); return;
  }
  renderEstimatePanel(out, est, {
    dryRun,
    onAbort: () => { out.innerHTML = ''; busy(false); },
    onStart: () => startAsyncSyncJob(pid, out, busy, dryRun),
  });
}

function renderEstimatePanel(out, est, { dryRun, onAbort, onStart }) {
  out.innerHTML = '';
  const box = el('div', { className: 'panel' });
  box.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, dryRun ? 'Preview — before you start' : 'Run sync — before you start')));
  const body = el('div', { className: 'panel-body', style: 'display:grid;gap:12px;max-width:600px' });
  box.appendChild(body);

  const stat = (val, lbl) => el('div', {}, el('div', { style: 'font-size:19px;font-weight:700' }, val), el('div', { style: 'font-size:11px;color:var(--text-muted)' }, lbl));
  body.appendChild(el('div', { style: 'display:flex;gap:24px;flex-wrap:wrap' },
    stat(String(est.total_new + est.total_changed), 'Records to process'),
    stat(String(est.ai_path_count), 'Need AI interpretation'),
    stat(String(est.deterministic_count), 'Deterministic (free, instant)'),
    stat(est.estimated_seconds < 60 ? `~${est.estimated_seconds}s` : `~${Math.ceil(est.estimated_seconds / 60)} min`, 'Est. time'),
    stat(`~$${est.estimated_cost_usd.toFixed(2)}`, 'Est. AI cost')));

  if (est.ai_path_count === 0) {
    body.appendChild(el('div', { style: 'font-size:12px;color:#1a7f37' },
      '✓ No AI interpretation needed for this scope — this runs deterministically, in seconds, at no cost.'));
  } else {
    body.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' },
      `${est.ai_path_count} record(s) need AI interpretation (e.g. AI agents, use cases, tools, or a flow header) — ` +
      (dryRun ? 'a preview runs the same AI stages as a real run and is not free.'
              : 'safe additive changes apply automatically; everything else is queued for human review. Populated Workbench content is never overwritten.')));
  }
  if (est.total_unchanged) body.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted)' }, `${est.total_unchanged} record(s) unchanged — skipped.`));

  // §3 — platform-wide (open-ended) tables: a distinct line, never folded into the counts
  // above, since these are a capped best-effort sample rather than a complete import.
  if (est.platform_wide && est.platform_wide.total) {
    const tableList = est.platform_wide.tables.map(t => `${t.table} (${t.count})`).join(', ');
    body.appendChild(el('div', { style: 'font-size:12px;color:#9a6700;background:rgba(154,103,0,0.08);padding:8px;border-radius:6px' },
      `⚠ Platform-wide table(s) — ${tableList}. ${est.platform_wide.note}.`));
  }

  const startBtn = el('button', { className: 'btn btn-primary' }, dryRun ? 'Start preview' : 'Start sync');
  const abortBtn = el('button', { className: 'btn btn-ghost', style: 'margin-left:8px' }, 'Cancel');
  startBtn.addEventListener('click', onStart);
  abortBtn.addEventListener('click', onAbort);
  body.appendChild(el('div', {}, startBtn, abortBtn));
  out.appendChild(box);
}

async function startAsyncSyncJob(pid, out, busy, dryRun) {
  out.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Starting…</span></div>';
  let start;
  try {
    start = await apiFetch(`/projects/${pid}/servicenow/sync/async${dryRun ? '?dry_run=1' : ''}`, { method: 'POST', body: JSON.stringify({}) });
  } catch (err) {
    out.innerHTML = ''; out.appendChild(el('div', { className: 'error-state' }, 'Start failed: ' + err.message));
    busy(false); return;
  }
  pollSyncJob(pid, start.job_id, out, dryRun, busy);
}

const STAGE_LABEL = { capturing: 'Capturing from ServiceNow…', reverse_engineer: 'Reverse-engineering records', reconcile: 'Reconciling changes', review: 'Reviewing changes' };

function renderProgressPanel(out, progress, cancelling, onCancel) {
  out.innerHTML = '';
  const box = el('div', { className: 'panel' });
  box.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, 'Working…')));
  const body = el('div', { className: 'panel-body', style: 'display:grid;gap:10px;max-width:560px' });
  box.appendChild(body);
  const stage = progress && progress.stage;
  const label = STAGE_LABEL[stage] || stage || 'Working…';
  body.appendChild(el('div', { style: 'font-size:13px' }, `${label}${progress && progress.total ? ` (${progress.current}/${progress.total})` : '…'}`));
  const pct = (progress && progress.total) ? Math.round((progress.current / progress.total) * 100) : 0;
  const barOuter = el('div', { style: 'height:8px;background:var(--color-bg-panel,#eceff3);border-radius:4px;overflow:hidden' });
  barOuter.appendChild(el('div', { style: `height:100%;width:${pct}%;background:var(--color-accent,#0969da);transition:width .3s` }));
  body.appendChild(barOuter);
  const cancelBtn = el('button', { className: 'btn btn-ghost btn-sm', disabled: cancelling }, cancelling ? 'Cancelling…' : 'Cancel');
  cancelBtn.addEventListener('click', onCancel);
  body.appendChild(cancelBtn);
  out.appendChild(box);
}

function pollSyncJob(pid, jobId, out, dryRun, busy) {
  let cancelling = false;
  const timer = setInterval(tick, 1200);
  async function tick() {
    let job;
    try { job = await apiFetch(`/projects/${pid}/servicenow/sync/async/${jobId}`); }
    catch (err) {
      clearInterval(timer);
      out.innerHTML = ''; out.appendChild(el('div', { className: 'error-state' }, 'Lost connection to the sync job: ' + err.message));
      busy(false); return;
    }
    if (job.status === 'running') {
      renderProgressPanel(out, job.progress, cancelling, async () => {
        if (cancelling) return;
        cancelling = true;
        try { await apiFetch(`/projects/${pid}/servicenow/sync/async/${jobId}/cancel`, { method: 'POST', body: JSON.stringify({}) }); showToast('Cancelling — finishing the current record…', 'info'); }
        catch (err) { showToast('Cancel failed: ' + err.message, 'error'); cancelling = false; }
      });
      return;
    }
    clearInterval(timer);
    if (job.status === 'complete' || job.status === 'cancelled') {
      if (dryRun) {
        renderPlan(out, job.planView, false);
        localStorage.setItem(previewKey(pid), JSON.stringify({ plan: job.planView, ts: Date.now() }));
      } else {
        renderResult(out, { plan: job.planView, result: job.result });
        localStorage.removeItem(previewKey(pid));
      }
      if (job.status === 'cancelled') {
        out.insertBefore(el('div', {
          style: 'font-size:12px;color:#92400e;background:#fff8e1;border:1px solid #f0e0a0;border-radius:6px;padding:8px 10px;margin-bottom:8px',
        }, '⏹ Cancelled — showing the partial result for what completed before the stop. Unprocessed records will re-surface next sync.'), out.firstChild);
      }
    } else {
      out.innerHTML = ''; out.appendChild(el('div', { className: 'error-state' }, 'Sync failed: ' + (job.error || 'unknown error')));
    }
    busy(false);
  }
  tick();
}

function summaryRow(s) {
  return el('div', { style: 'display:flex;gap:20px;flex-wrap:wrap;margin-bottom:12px;font-size:13px' },
    el('div', {}, el('strong', {}, String(s.auto || 0)), ' auto-apply'),
    el('div', {}, el('strong', {}, String(s.hitl || 0)), ' human review'),
    el('div', {}, el('strong', {}, String(s.no_change || 0)), ' no change'),
    el('div', {}, el('strong', {}, String(s.unchanged || 0)), ' unchanged (skipped)'),
    s.capture_errors ? el('div', { style: 'color:var(--danger,#cf222e)' }, el('strong', {}, String(s.capture_errors)), ' capture errors') : null);
}

function renderPlan(out, plan, applied) {
  out.innerHTML = '';
  out.appendChild(el('h4', { style: 'margin:6px 0' }, `Plan — mode: ${plan.mode}, threshold: ${conf(plan.threshold)}`));
  out.appendChild(summaryRow(plan.summary || {}));
  if (plan.errors && plan.errors.length) {
    out.appendChild(el('div', { style: 'font-size:12px;color:var(--danger,#cf222e);margin-bottom:8px' }, 'Capture issues: ' + plan.errors.join('; ')));
  }
  const items = plan.items || [];
  if (!items.length) { out.appendChild(el('div', { className: 'empty-state' }, 'Nothing to reconcile — the Workbench is in sync with ServiceNow.')); return; }

  const table = el('table', { className: 'dr-compact-table', style: 'width:100%' });
  table.appendChild(el('thead', {}, el('tr', {},
    el('th', {}, 'Type'), el('th', {}, 'Name'), el('th', {}, 'Action'),
    el('th', {}, 'Verdict'), el('th', { style: 'text-align:right' }, 'Conf'),
    el('th', {}, 'Decision'), el('th', {}, 'Why'))));
  const tb = el('tbody');
  items.forEach(it => {
    const why = [];
    if (it.destructive) why.push('⚠ destructive');
    if (it.decision && it.decision.reason) why.push(it.decision.reason);
    if (it.field_changes && it.field_changes.length) why.push(it.field_changes.map(f => `${f.field}:${f.change_kind}`).join(', '));
    if (it.issues && it.issues.length) why.push('issues: ' + it.issues.join('; '));
    tb.appendChild(el('tr', {},
      el('td', {}, classPill(it.classification)),
      el('td', {}, it.name || '—'),
      el('td', {}, it.action || '—'),
      el('td', {}, it.verdict || '—'),
      el('td', { style: 'text-align:right;font-family:monospace' }, conf(it.confidence)),
      el('td', {}, decisionPill(it.decision ? it.decision.target : '')),
      el('td', { style: 'font-size:11px;color:var(--text-muted)' }, why.join(' · ') || '—')));
  });
  table.appendChild(tb);
  out.appendChild(table);
  if (!applied) {
    out.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:8px' },
      'Dry run — nothing was written. Click “Run sync” to apply the auto items and queue the rest.'));
  }
}

function renderResult(out, res) {
  out.innerHTML = '';
  renderPlan(out, res.plan, true);
  const r = res.result || {};
  const card = el('div', { className: 'panel', style: 'margin-top:14px' });
  const body = el('div', { className: 'panel-body', style: 'font-size:13px;display:grid;gap:6px' });
  card.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, 'Result')));
  card.appendChild(body);
  if (r.auto_cp) body.appendChild(el('div', {}, `✅ Auto-applied packet ${r.auto_cp.packet_code} — ${r.auto_cp.item_count} item(s) ` +
    `(created ${r.auto_cp.apply_result ? r.auto_cp.apply_result.applied : 0}, updated ${r.auto_cp.apply_result ? r.auto_cp.apply_result.updated : 0}).`));
  if (r.hitl_cp) body.appendChild(el('div', {}, `📋 Review packet ${r.hitl_cp.packet_code} — ${r.hitl_cp.item_count} item(s) queued in the Change Packet Queue.`));
  if (r.hash_advanced) body.appendChild(el('div', {}, `🔖 ${r.hash_advanced} unchanged record(s) re-stamped (faster next sync).`));
  if (r.dropped && r.dropped.length) body.appendChild(el('div', { style: 'color:var(--text-muted)' },
    `Skipped ${r.dropped.length} item(s) not materializable: ` + r.dropped.map(d => d.name || d.source_sys_id).join(', ')));
  if (!r.auto_cp && !r.hitl_cp && !r.hash_advanced) body.appendChild(el('div', {}, 'No changes — already in sync.'));
  out.appendChild(card);
  showToast('Sync complete', 'success');
}
