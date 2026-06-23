/**
 * modules/sn_artifacts.js — Administration › ServiceNow Artifacts (Phase 4b)
 *
 * View + edit the generic ServiceNow artifacts captured onto the extensible substrate
 * (asdlc_sn_artifact) — the long tail (ACLs, roles, properties, SLAs, UI pages, …) plus
 * recursive children (a table's columns, a flow's actions) that have no dedicated
 * Level-1 design table. Schema-driven editing:
 *   • Tier-A  → projected onto a Level-1 row; edited via Design Review (read-only here).
 *   • Tier-B  → form rendered from the type's curated field_schema.
 *   • Tier-C  → raw key/value editor of the payload + an "advanced" override panel.
 * Level-2 provenance (sys_id, source table/scope/hash) is read-only, behind a disclosure.
 */
import { apiFetch, el, showToast, getCurrentProjectId, navigate } from '../app.js';

function pill(text, color) {
  return el('span', { style: `display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:${color}` }, text);
}
const tierPill = t => pill('Tier ' + (t || 'C'), { A: '#1a7f37', B: '#0969da', C: '#6b7280' }[t] || '#6b7280');
const deployPill = s => pill(s || 'record', s === 'typed' ? '#8250df' : '#57606a');

function titleCase(s) { return String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }

export async function render(container) {
  container.innerHTML = '';
  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'ServiceNow Artifacts'),
    el('p', { className: 'purpose-text' },
      'Every ServiceNow artifact captured onto the generic substrate — the long tail (access controls, ' +
      'roles, properties, UI pages, …) and recursive children — that has no dedicated Level-1 design table. ' +
      'Edit field values here; type identity and ServiceNow provenance are read-only.')
  ));

  const pid = getCurrentProjectId();
  if (!pid) {
    container.appendChild(el('div', { className: 'error-state' }, 'Select a project first (top-right project selector).'));
    return;
  }

  const layout = el('div', { style: 'display:grid;grid-template-columns:minmax(320px,1fr) minmax(380px,1.4fr);gap:18px;align-items:start' });
  const listPanel = el('div', { className: 'panel' });
  const detailPanel = el('div', { className: 'panel' });
  listPanel.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, 'Captured artifacts')));
  const listBody = el('div', { className: 'panel-body' });
  listPanel.appendChild(listBody);
  detailPanel.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, 'Detail')));
  const detailBody = el('div', { className: 'panel-body' });
  detailPanel.appendChild(detailBody);
  detailBody.appendChild(el('div', { className: 'empty-state' }, 'Select an artifact to view or edit it.'));
  layout.appendChild(listPanel);
  layout.appendChild(detailPanel);
  container.appendChild(layout);

  listBody.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading artifacts…</span></div>';
  let data;
  try { data = await apiFetch(`/projects/${pid}/sn-artifacts`); }
  catch (err) { listBody.innerHTML = ''; listBody.appendChild(el('div', { className: 'error-state' }, 'Failed to load: ' + err.message)); return; }

  const artifacts = (data && data.artifacts) || [];
  if (!artifacts.length) {
    listBody.innerHTML = '';
    listBody.appendChild(el('div', { className: 'empty-state' },
      'No generic artifacts captured for this project yet. Run a ServiceNow Sync to capture them.'));
    return;
  }

  // Group by metadata type for a scannable list.
  const byType = {};
  for (const a of artifacts) (byType[a.sn_metadata_type] = byType[a.sn_metadata_type] || []).push(a);

  listBody.innerHTML = '';
  listBody.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:10px' },
    `${artifacts.length} artifact(s) across ${Object.keys(byType).length} type(s).`));

  let selectedBtn = null;
  for (const type of Object.keys(byType).sort()) {
    const rows = byType[type];
    listBody.appendChild(el('div', { style: 'font-weight:600;font-size:12px;margin:12px 0 4px;color:var(--text-muted)' },
      `${titleCase(type)} · ${rows.length}`));
    for (const a of rows) {
      const btn = el('button', {
        className: 'nav-item',
        style: 'width:100%;text-align:left;display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--color-border);border-radius:var(--radius);margin-bottom:4px;background:var(--color-bg);cursor:pointer',
      },
        el('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
          (a.child_role ? '↳ ' : '') + (a.name || a.slug || a.sn_artifact_id)),
        tierPill(a.tier), deployPill(a.deploy_strategy),
        a.source_sys_id ? pill('linked', '#1a7f37') : pill('new', '#bf8700'));
      btn.addEventListener('click', () => {
        if (selectedBtn) selectedBtn.style.outline = '';
        selectedBtn = btn; btn.style.outline = '2px solid var(--color-accent,#0969da)';
        openDetail(pid, a.sn_artifact_id, detailBody);
      });
      listBody.appendChild(btn);
    }
  }
}

async function openDetail(pid, aid, host) {
  host.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading…</span></div>';
  let art;
  try { art = await apiFetch(`/projects/${pid}/sn-artifacts/${aid}`); }
  catch (err) { host.innerHTML = ''; host.appendChild(el('div', { className: 'error-state' }, 'Load failed: ' + err.message)); return; }
  host.innerHTML = '';

  host.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px' },
    el('strong', { style: 'font-size:15px' }, art.name || art.slug || aid),
    tierPill(art.tier), deployPill(art.deploy_strategy),
    art.fluent_api_name ? pill(art.fluent_api_name, '#24292f') : null));
  host.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:14px' },
    `${art.sn_metadata_type}${art.source_table ? ` · ${art.source_table}` : ''}${art.slug ? ` · ${art.slug}` : ''}`));

  // Name field (always editable for non-Tier-A).
  const nameInput = el('input', { className: 'form-input', value: art.name || '', type: 'text' });

  // ── Tier-A: edited via the Level-1 editor ──
  if (!art.editable || art.projected_entity_type) {
    host.appendChild(el('div', { className: 'empty-state', style: 'text-align:left' },
      el('div', { style: 'margin-bottom:8px' },
        `This is a Tier-A artifact projected onto a ${art.projected_entity_type || 'Level-1'} design row. ` +
        'Edit its business fields in Design Review; this technical twin updates automatically.'),
      el('button', { className: 'btn btn-secondary' }, 'Open Design Review →')));
    host.querySelector('button').addEventListener('click', () => navigate('design_review'));
    appendTechnical(host, art);
    return;
  }

  const fields = (art.field_schema && Array.isArray(art.field_schema.fields)) ? art.field_schema.fields : null;
  const editorBody = el('div', { style: 'display:grid;gap:12px' });
  host.appendChild(el('div', { className: 'form-group' }, el('label', { className: 'form-label' }, 'Name'), nameInput));

  let collect;   // returns { payload, override_fields }
  if (fields) {
    // ── Tier-B: schema-driven form ──
    host.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin:4px 0' },
      `Curated fields for ${art.fluent_api_name || art.sn_metadata_type} (deploys as a typed Fluent constructor).`));
    const inputs = {};
    for (const f of fields) {
      const cur = art.payload[f.col];
      let input;
      if (f.type === 'boolean') {
        input = el('select', { className: 'form-input' },
          el('option', { value: '' }, '—'),
          el('option', { value: 'true' }, 'true'),
          el('option', { value: 'false' }, 'false'));
        input.value = (cur === true || cur === 'true') ? 'true' : (cur === false || cur === 'false') ? 'false' : '';
      } else if (f.type === 'text') {
        input = el('textarea', { className: 'form-input', rows: 3 }); input.value = cur == null ? '' : String(cur);
      } else {
        input = el('input', { className: 'form-input', type: 'text' });
        input.value = Array.isArray(cur) ? cur.join(', ') : (cur == null ? '' : String(cur));
      }
      inputs[f.col] = { input, f };
      editorBody.appendChild(el('div', { className: 'form-group' },
        el('label', { className: 'form-label' }, `${f.prop}${f.required ? ' *' : ''}`,
          el('span', { style: 'font-weight:400;color:var(--text-muted)' }, `  (${f.col} · ${f.type})`)),
        input));
    }
    collect = () => {
      const payload = { ...art.payload };
      for (const col of Object.keys(inputs)) {
        const { input, f } = inputs[col];
        let v = input.value;
        if (v === '' && f.type === 'boolean') { delete payload[col]; continue; }
        payload[col] = (f.type === 'string[]') ? v.split(',').map(s => s.trim()).filter(Boolean) : v;
      }
      return { payload, override_fields: art.override_fields || {} };
    };
  } else {
    // ── Tier-C: raw key/value editor + advanced override panel ──
    host.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin:4px 0' },
      'Raw field values (deploys via the generic Record() — faithful to ServiceNow).'));
    const kvWrap = el('div', { style: 'display:grid;gap:6px' });
    const rows = [];
    const addRow = (k = '', v = '') => {
      const kI = el('input', { className: 'form-input', type: 'text', value: k, style: 'flex:0 0 38%' });
      const vI = el('input', { className: 'form-input', type: 'text', value: typeof v === 'object' ? JSON.stringify(v) : String(v) });
      const row = el('div', { style: 'display:flex;gap:6px;align-items:center' }, kI, vI);
      rows.push({ kI, vI }); kvWrap.appendChild(row);
    };
    for (const [k, v] of Object.entries(art.payload || {})) addRow(k, v);
    const addBtn = el('button', { className: 'btn btn-secondary', style: 'justify-self:start;font-size:12px' }, '+ Add field');
    addBtn.addEventListener('click', () => addRow());
    editorBody.appendChild(el('div', { className: 'form-group' }, el('label', { className: 'form-label' }, 'Fields'), kvWrap, addBtn));

    const ovTxt = el('textarea', { className: 'form-input', rows: 3 }, JSON.stringify(art.override_fields || {}, null, 2));
    const ov = el('details', {}, el('summary', { style: 'cursor:pointer;font-size:12px;color:var(--text-muted)' },
      'Advanced — override fields (bypass the typed API)'), ovTxt);
    editorBody.appendChild(ov);

    collect = () => {
      const payload = {};
      for (const { kI, vI } of rows) { const k = kI.value.trim(); if (k) payload[k] = vI.value; }
      let override_fields = {};
      try { override_fields = JSON.parse(ovTxt.value || '{}'); } catch { throw new Error('Override fields is not valid JSON.'); }
      return { payload, override_fields };
    };
  }

  host.appendChild(editorBody);

  const saveBtn = el('button', { className: 'btn btn-primary', style: 'margin-top:14px' }, 'Save changes');
  saveBtn.addEventListener('click', async () => {
    let body;
    try { body = collect(); } catch (err) { showToast(err.message, 'error'); return; }
    body.name = nameInput.value.trim() || art.name;
    saveBtn.disabled = true;
    try {
      await apiFetch(`/projects/${pid}/sn-artifacts/${aid}`, { method: 'PUT', body: JSON.stringify(body) });
      showToast('Artifact saved', 'success');
      openDetail(pid, aid, host);   // reload with fresh values
    } catch (err) { showToast('Save failed: ' + err.message, 'error'); saveBtn.disabled = false; }
  });
  host.appendChild(saveBtn);

  appendTechnical(host, art);
}

// Read-only Level-2 provenance + children, behind a disclosure.
function appendTechnical(host, art) {
  const rowsEl = [];
  const add = (k, v) => { if (v != null && v !== '') rowsEl.push(el('div', {}, el('strong', {}, k + ': '), String(v))); };
  add('sys_id', art.source_sys_id); add('source table', art.source_table); add('scope', art.source_scope);
  add('source hash', art.source_hash); add('sdk version', art.sdk_version);
  add('projected onto', art.projected_entity_type); add('parent', art.parent_artifact_id);
  const kids = (art.children || []);
  const details = el('details', { style: 'margin-top:16px' },
    el('summary', { style: 'cursor:pointer;font-size:12px;color:var(--text-muted)' }, 'Technical details (read-only)'),
    el('div', { style: 'font-size:12px;color:var(--text-muted);display:grid;gap:3px;margin-top:8px' }, ...rowsEl,
      kids.length ? el('div', { style: 'margin-top:6px' }, el('strong', {}, `Children (${kids.length}): `),
        kids.map(c => `${c.name}${c.child_role ? ` (${c.child_role})` : ''}`).join(', ')) : null));
  host.appendChild(details);
}
