/**
 * modules/servicenow_assessment.js — Administration › ServiceNow Assessment (Phase 0)
 *
 * Read-only discovery / fit analysis of a linked ServiceNow instance, run BEFORE any
 * extraction. Surfaces: platform version, capability matrix, scope census with record
 * counts, a coverage map (mapped/partial/unmapped vs. the Workbench), a volume/cost
 * estimate, a capacity verdict, and a recommended import profile (bounds for extraction).
 */
import { apiFetch, el, showToast, getCurrentProjectId, navigate } from '../app.js';

function pill(text, color) {
  return el('span', { style: `display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:${color}` }, text);
}
const VERDICT_COLOR = { green: '#1a7f37', yellow: '#bf8700', red: '#cf222e', unknown: '#6b7280' };
function mappingPill(status) {
  const c = { mapped: '#1a7f37', partial: '#bf8700', unmapped: '#cf222e', absent: '#6b7280' }[status] || '#6b7280';
  return pill(status, c);
}
// For a 'partial' row: distinguish lossy-by-intent (fine) from a fidelity gap (to fix).
function intentPill(partialIntent) {
  if (partialIntent === 'by-intent') return pill('by intent', '#6b7280');
  if (partialIntent === 'gap') return pill('gap to fix', '#cf222e');
  return null;
}
function num(n) { return (n == null) ? '—' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

let _poll = null;
function stopPoll() { if (_poll) { clearInterval(_poll); _poll = null; } }

export async function render(container) {
  stopPoll();
  container.innerHTML = '';
  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'ServiceNow Assessment'),
    el('p', { className: 'purpose-text' },
      'Read-only fit analysis of a linked ServiceNow instance — run before importing. It detects the ' +
      'platform version, which design surfaces exist, the size of each scope, what the Workbench can and ' +
      'cannot represent, and an estimated import cost. Nothing is written to ServiceNow or the design.')
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
  runPanel.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, `Scan — ${project.project_name || pid}`)));
  const runBody = el('div', { className: 'panel-body', style: 'display:grid;gap:12px;max-width:680px' });
  runPanel.appendChild(runBody);
  container.appendChild(runPanel);

  const hasCreds = !!(project.servicenow_instance || project.has_sn_password);
  runBody.appendChild(el('div', { style: 'font-size:13px' },
    el('div', {}, el('strong', {}, 'Instance: '), project.servicenow_instance || '(from server SN_INSTANCE env)'),
    el('div', {}, el('strong', {}, 'Credentials: '), project.has_sn_password ? `${project.sn_user || '(user)'} / ••••••••` : '(server env fallback)')));

  const scopeRow = el('div', { className: 'form-group' });
  scopeRow.appendChild(el('label', { className: 'form-label' }, 'Scopes to assess (comma-separated; blank = the linked scope, or discover all)'));
  const scopeInput = el('input', { type: 'text', className: 'form-input', placeholder: 'x_acme_app1, x_acme_app2', value: project.servicenow_scope || '' });
  scopeRow.appendChild(scopeInput);
  runBody.appendChild(scopeRow);

  const runBtn = el('button', { className: 'btn btn-primary' }, 'Scan instance');
  const out = el('div', { style: 'margin-top:8px' });
  runBody.appendChild(el('div', {}, runBtn));
  container.appendChild(out);

  const resultsPanel = el('div', {});
  container.appendChild(resultsPanel);

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    out.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Scanning instance (read-only)…</span></div>';
    resultsPanel.innerHTML = '';
    try {
      const scopes = scopeInput.value.split(',').map(s => s.trim()).filter(Boolean);
      const started = await apiFetch(`/projects/${pid}/servicenow/assess`, { method: 'POST', body: JSON.stringify(scopes.length ? { scopes } : {}) });
      pollAssessment(pid, started.assessment_id, out, resultsPanel, runBtn);
    } catch (err) {
      out.innerHTML = ''; out.appendChild(el('div', { className: 'error-state' }, 'Scan failed: ' + err.message)); runBtn.disabled = false;
    }
  });

  // Show the most recent assessment, if any.
  try {
    const list = await apiFetch(`/projects/${pid}/servicenow/assessments`);
    if (Array.isArray(list) && list.length) {
      const latest = list[0];
      if (latest.status === 'complete') {
        const full = await apiFetch(`/projects/${pid}/servicenow/assessments/${latest.assessment_id}`);
        renderReport(resultsPanel, full.report, latest, pid);
      } else if (latest.status === 'running') {
        out.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>An assessment is running…</span></div>';
        runBtn.disabled = true;
        pollAssessment(pid, latest.assessment_id, out, resultsPanel, runBtn);
      }
    }
  } catch { /* none yet */ }
}

function pollAssessment(pid, aid, out, resultsPanel, runBtn) {
  stopPoll();
  let ticks = 0;
  _poll = setInterval(async () => {
    if (++ticks > 60) { stopPoll(); out.innerHTML = ''; out.appendChild(el('div', { className: 'error-state' }, 'Assessment timed out.')); runBtn.disabled = false; return; }
    let row;
    try { row = await apiFetch(`/projects/${pid}/servicenow/assessments/${aid}`); } catch { return; }
    if (row.status === 'complete') {
      stopPoll(); out.innerHTML = ''; runBtn.disabled = false;
      renderReport(resultsPanel, row.report, row, pid);
      showToast('Assessment complete', 'success');
    } else if (row.status === 'failed') {
      stopPoll(); out.innerHTML = ''; runBtn.disabled = false;
      out.appendChild(el('div', { className: 'error-state' }, 'Assessment failed: ' + (row.error || 'unknown error')));
    }
  }, 2500);
}

function renderReport(panel, report, row, pid) {
  panel.innerHTML = '';
  if (!report) { panel.appendChild(el('div', { className: 'error-state' }, 'No report payload.')); return; }
  const v = report.capacity_verdict || {};
  const ver = report.version || {};
  const vol = report.volume || {};

  // Verdict banner
  const vc = VERDICT_COLOR[v.level] || VERDICT_COLOR.unknown;
  const banner = el('div', { style: `margin-top:18px;padding:12px 14px;border-radius:6px;background:${vc}18;border-left:4px solid ${vc}` },
    el('div', { style: `font-weight:700;color:${vc};text-transform:uppercase;font-size:12px;letter-spacing:.04em` }, `Capacity: ${v.level || 'unknown'}`),
    el('div', { style: 'font-size:13px;margin-top:3px' }, v.reason || ''));
  panel.appendChild(banner);

  // Summary metrics
  const stats = el('div', { style: 'display:flex;gap:26px;flex-wrap:wrap;margin:16px 0' });
  const stat = (val, lbl) => el('div', {}, el('div', { style: 'font-size:20px;font-weight:700' }, val), el('div', { style: 'font-size:11px;color:var(--text-muted)' }, lbl));
  stats.appendChild(stat(ver.family ? ver.family : '—', `Release${ver.edition ? ' · ' + ver.edition : ''}`));
  stats.appendChild(stat(num(vol.total_artifacts), 'Capturable artifacts'));
  stats.appendChild(stat(num(vol.est_reverse_engineer_calls), 'Est. AI reverse-engineer calls'));
  stats.appendChild(stat(vol.est_cost_usd != null ? '$' + vol.est_cost_usd : '—', `Est. cost (${vol.est_cost_model || 'AI'})`));
  panel.appendChild(stats);
  if (vol.counts_partial) panel.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:-8px;margin-bottom:8px' }, 'Some counts were unavailable — volume is a lower bound.'));
  if (!ver.supported) panel.appendChild(el('div', { style: 'font-size:12px;color:#cf222e' }, '⚠ Detected release is below the configured support floor.'));

  // Coverage table
  panel.appendChild(el('h4', { style: 'margin:14px 0 6px' }, 'Coverage — what the Workbench can represent'));
  const cs = report.coverage_summary || {};
  panel.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:6px' },
    `${cs.mapped || 0} mapped · ${cs.partial || 0} partial · ${cs.unmapped || 0} unmapped · ${cs.absent || 0} absent on this instance`));
  const covTable = el('table', { className: 'dr-compact-table', style: 'width:100%' });
  covTable.appendChild(el('thead', {}, el('tr', {}, el('th', {}, 'ServiceNow table'), el('th', {}, 'Workbench type'), el('th', {}, 'Status'), el('th', {}, 'Feature'))));
  const covTb = el('tbody');
  (report.coverage || []).forEach(c => {
    const ip = c.mappingStatus === 'partial' ? intentPill(c.partialIntent) : null;
    covTb.appendChild(el('tr', {},
      el('td', { style: 'font-family:monospace;font-size:12px' }, c.table),
      el('td', {}, c.wbDesignType),
      el('td', {}, mappingPill(c.mappingStatus), ip ? el('span', { style: 'margin-left:5px' }, ip) : null),
      el('td', { style: 'font-size:11px;color:var(--text-muted)' }, c.featureNote || '')));
  });
  covTable.appendChild(covTb);
  panel.appendChild(covTable);

  // Per-scope census — surfaces are SELECTABLE to define the import "slice" (checkboxes).
  const prof = report.recommended_profile || {};
  const recommended = new Set(prof.include_surfaces || []);   // default selection until a saved profile loads
  const surfaceCbs = [];      // { table, checkbox }

  panel.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin:16px 0 4px' },
    'Tick the surfaces to ingest — this defines the import slice used by ServiceNow Sync. Leave all ticked to ingest the whole scope.'));

  // ── Pointer to the requirements-driven discovery planner ──────────────────────
  // Generating an import plan from requirements now happens from Ingest Documents, scoped
  // to the specific document whose requirements you're working from — see docs/BACKLOG.md
  // #106/#107 for why this moved off this page.
  const plannerNote = el('div', { style: 'font-size:13px;background:var(--surface-raised,#f6f8fa);border:1px solid var(--border-color,#d0d7de);border-radius:6px;padding:12px;display:grid;gap:8px;margin-bottom:14px' });
  plannerNote.appendChild(el('div', {},
    'Generating an import plan from requirements now happens from ', el('strong', {}, 'Ingest Documents'),
    ' — scoped to the document whose requirements you\'re working from, with the ServiceNow scan run automatically.'));
  const gotoIngestBtn = el('button', { className: 'btn btn-secondary' }, 'Go to Ingest Documents →');
  gotoIngestBtn.addEventListener('click', () => navigate('ingest'));
  plannerNote.appendChild(gotoIngestBtn);
  panel.appendChild(plannerNote);

  (report.scope_reports || []).forEach(sr => {
    panel.appendChild(el('h4', { style: 'margin:14px 0 6px' }, `Scope: ${sr.scope} — ${num(sr.artifact_count)} artifacts`));
    const present = (sr.surfaces || []).filter(s => s.present && s.count > 0);
    if (!present.length) {
      panel.appendChild(el('div', { className: 'empty-state' }, 'No records in the captured surfaces for this scope.'));
    } else {
      const t = el('table', { className: 'dr-compact-table', style: 'width:100%' });
      t.appendChild(el('thead', {}, el('tr', {}, el('th', { style: 'width:32px' }, ''), el('th', {}, 'Surface'), el('th', {}, 'Workbench type'), el('th', { style: 'text-align:right' }, 'Records'))));
      const tb = el('tbody');
      present.forEach(s => {
        const cb = el('input', { type: 'checkbox', 'data-surface': s.table });
        if (recommended.has(s.table)) cb.checked = true;
        surfaceCbs.push({ table: s.table, checkbox: cb });
        tb.appendChild(el('tr', {},
          el('td', {}, cb),
          el('td', { style: 'font-family:monospace;font-size:12px' }, s.table),
          el('td', {}, s.wbDesignType),
          el('td', { style: 'text-align:right;font-family:monospace' }, num(s.count))));
      });
      t.appendChild(tb);
      panel.appendChild(t);
    }
    const cx = (sr.complexity || []).filter(c => c.present && c.count > 0);
    if (cx.length) panel.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:4px' },
      'Complexity: ' + cx.map(c => `${c.label} ${num(c.count)}`).join(' · ')));
  });

  // ── Import profile: save the selected slice (or reset to whole-scope) ──────────
  panel.appendChild(el('h4', { style: 'margin:18px 0 6px' }, 'Import profile (slice)'));
  const profBox = el('div', { style: 'font-size:13px;background:var(--surface-raised,#f6f8fa);border:1px solid var(--border-color,#d0d7de);border-radius:6px;padding:12px;display:grid;gap:8px' });
  const statusLine = el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Loading saved profile…');
  profBox.appendChild(statusLine);
  if ((prof.materiality_disallow_types || []).length) profBox.appendChild(el('div', {}, el('strong', {}, 'Suggested: drop cosmetic logic: '), prof.materiality_disallow_types.join(', ')));
  const capWrap = el('div', { style: 'display:flex;align-items:center;gap:8px' });
  const capInput = el('input', { type: 'number', min: '1', className: 'form-input', style: 'max-width:120px', placeholder: '(no cap)' });
  if (prof.per_surface_cap) capInput.value = String(prof.per_surface_cap);
  capWrap.appendChild(el('label', { style: 'font-size:12px' }, 'Per-surface cap:'));
  capWrap.appendChild(capInput);
  profBox.appendChild(capWrap);
  const saveBtn = el('button', { className: 'btn btn-primary' }, 'Save import profile');
  const resetBtn = el('button', { className: 'btn btn-secondary', style: 'margin-left:8px' }, 'Reset to whole scope');
  profBox.appendChild(el('div', {}, saveBtn, resetBtn));
  panel.appendChild(profBox);
  panel.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:6px' },
    'The saved slice bounds ServiceNow Sync (ingest + write-back). ' + (row && row.created_at ? `Assessed ${String(row.created_at).slice(0, 16).replace('T', ' ')}.` : '')));

  const scopeForProfile = (report.scope_reports && report.scope_reports[0] && report.scope_reports[0].scope)
    || (prof.scopes && prof.scopes[0]) || null;
  const applyProfileToUI = (profile) => {
    if (!profile) { statusLine.textContent = 'No saved slice — ingesting the whole scope. Tick surfaces and Save to bound it.'; return; }
    const sel = new Set(profile.include_surfaces || []);
    surfaceCbs.forEach(({ table, checkbox }) => { checkbox.checked = sel.has(table); });
    if (profile.per_surface_cap) capInput.value = String(profile.per_surface_cap);
    statusLine.textContent = `Saved slice: ${(profile.include_surfaces || []).length} surface(s)${profile.per_surface_cap ? `, cap ${profile.per_surface_cap}` : ''}.`;
  };
  // Load any saved profile and reflect it in the UI (overrides the recommended defaults).
  if (pid) apiFetch(`/projects/${pid}/servicenow/import-profile`).then(r => {
    if (r && r.source === 'saved') applyProfileToUI(r.profile);
    else statusLine.textContent = 'No saved slice yet — recommended surfaces are pre-ticked. Save to bound the ingest.';
  }).catch(() => { statusLine.textContent = ''; });

  saveBtn.addEventListener('click', async () => {
    const include_surfaces = surfaceCbs.filter(c => c.checkbox.checked).map(c => c.table);
    if (!include_surfaces.length) { showToast('Tick at least one surface (or use Reset).', 'error'); return; }
    const capNum = parseInt(capInput.value, 10);
    saveBtn.disabled = true;
    try {
      const body = { scope: scopeForProfile, include_surfaces, per_surface_cap: Number.isFinite(capNum) && capNum > 0 ? capNum : null };
      const r = await apiFetch(`/projects/${pid}/servicenow/import-profile`, { method: 'PUT', body: JSON.stringify(body) });
      applyProfileToUI(r.profile);
      showToast(`Import slice saved (${include_surfaces.length} surface${include_surfaces.length === 1 ? '' : 's'}).`, 'success');
    } catch (err) { showToast('Save failed: ' + err.message, 'error'); }
    finally { saveBtn.disabled = false; }
  });
  resetBtn.addEventListener('click', async () => {
    resetBtn.disabled = true;
    try {
      await apiFetch(`/projects/${pid}/servicenow/import-profile`, { method: 'PUT', body: JSON.stringify({ clear: true }) });
      surfaceCbs.forEach(c => { c.checkbox.checked = true; }); capInput.value = '';
      statusLine.textContent = 'Reset — ServiceNow Sync will ingest the whole scope.';
      showToast('Import profile reset to whole scope.', 'success');
    } catch (err) { showToast('Reset failed: ' + err.message, 'error'); }
    finally { resetBtn.disabled = false; }
  });

  // Warnings
  if ((report.warnings || []).length) {
    panel.appendChild(el('div', { style: 'margin-top:12px;padding:10px;background:#fff8e1;border-radius:6px;border:1px solid #f0e0a0' },
      el('strong', { style: 'font-size:12px' }, 'Notes'),
      el('ul', { style: 'margin:6px 0 0 18px;font-size:12px' }, ...report.warnings.map(w => el('li', {}, w)))));
  }
}
