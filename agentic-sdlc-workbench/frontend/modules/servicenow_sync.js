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
import { apiFetch, el, showToast, getCurrentProjectId } from '../app.js';

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
  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'ServiceNow Sync'),
    el('p', { className: 'purpose-text' },
      'Reconcile a linked ServiceNow application back into this Workbench design. The sync is ' +
      'non-destructive: it never blanks, shrinks, or deletes populated Workbench content. Safe ' +
      'additive changes can auto-apply; conflicts and anything uncertain go to human review.')
  ));

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

  const busy = (on) => { previewBtn.disabled = on; runBtn.disabled = on; };

  previewBtn.addEventListener('click', async () => {
    busy(true); out.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Capturing &amp; reconciling…</span></div>';
    try {
      const res = await apiFetch(`/projects/${pid}/servicenow/sync?dry_run=1`, { method: 'POST', body: JSON.stringify({}) });
      renderPlan(out, res.plan, false);
    } catch (err) { out.innerHTML = ''; out.appendChild(el('div', { className: 'error-state' }, 'Preview failed: ' + err.message)); }
    finally { busy(false); }
  });

  runBtn.addEventListener('click', async () => {
    if (!confirm('Run the sync? Safe additive changes will be applied automatically; everything else will be queued for review. Populated Workbench content is never overwritten.')) return;
    busy(true); out.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Syncing…</span></div>';
    try {
      const res = await apiFetch(`/projects/${pid}/servicenow/sync`, { method: 'POST', body: JSON.stringify({}) });
      renderResult(out, res);
    } catch (err) { out.innerHTML = ''; out.appendChild(el('div', { className: 'error-state' }, 'Sync failed: ' + err.message)); }
    finally { busy(false); }
  });
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
