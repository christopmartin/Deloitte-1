/**
 * modules/projects.js — Application Registry
 */
import { apiFetch, tag, statusTag, formatDate, renderTable, el, escHtml, showToast, getCurrentProjectId } from '../app.js';

let allProjects = [];
let selectedProject = null;
let filterClient = '';
let filterSearch = '';
let inlineAddMember = false;

export async function render(container) {
  container.innerHTML = '';

  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'Applications'),
    el('p', { className: 'purpose-text' }, 'Manage application identities, team members, reuse scope, and agent settings.')
  ));

  const layout = el('div', { className: 'two-pane wide-left' });
  const paneLeft = el('div', { className: 'pane-left' });
  const paneRight = el('div', { className: 'pane-right', id: 'project-detail-pane' });
  paneRight.innerHTML = '<div class="empty-state" style="height:100%"><div class="empty-state-icon">📋</div><h3>Select an application</h3><p>Click an application in the list to view its details.</p></div>';

  layout.appendChild(paneLeft);
  layout.appendChild(paneRight);
  container.appendChild(layout);

  await buildProjectList(paneLeft, paneRight);
}

async function buildProjectList(paneLeft, paneRight) {
  // Filter bar
  const filterBar = el('div', { className: 'filter-bar' });
  const searchInput = el('input', { type: 'text', className: 'filter-input', placeholder: 'Search applications…' });
  const clientSelect = el('select', { className: 'filter-select' });
  clientSelect.innerHTML = '<option value="">All Clients</option>';

  searchInput.addEventListener('input', () => {
    filterSearch = searchInput.value.toLowerCase();
    refreshList(listBody, paneRight);
  });

  clientSelect.addEventListener('change', () => {
    filterClient = clientSelect.value;
    refreshList(listBody, paneRight);
  });

  filterBar.appendChild(searchInput);
  filterBar.appendChild(clientSelect);

  const newBtn = el('button', { className: 'btn btn-primary btn-sm' }, '+ New Application');
  newBtn.addEventListener('click', () => openNewProject(paneRight));
  filterBar.appendChild(newBtn);

  // Header
  const header = el('div', { className: 'pane-header' },
    el('span', { className: 'pane-title' }, 'Applications')
  );
  paneLeft.appendChild(header);
  paneLeft.appendChild(filterBar);

  const listBody = el('div', { className: 'pane-body' });
  listBody.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
  paneLeft.appendChild(listBody);

  try {
    const data = await apiFetch('/projects');
    allProjects = Array.isArray(data) ? data : (data.items || data.projects || []);

    // Populate client filter
    const clients = [...new Set(allProjects.map(p => p.client_name).filter(Boolean))];
    clients.forEach(c => {
      clientSelect.appendChild(el('option', { value: c }, c));
    });

    refreshList(listBody, paneRight);

    // Auto-select active project
    const activeId = getCurrentProjectId();
    if (activeId) {
      const found = allProjects.find(p => String(p.project_id) === String(activeId));
      if (found) loadDetail(found, paneRight);
    }
  } catch (err) {
    listBody.innerHTML = `<div class="error-state"><strong>Error:</strong> ${escHtml(err.message)}</div>`;
  }
}

function refreshList(listBody, paneRight) {
  listBody.innerHTML = '';
  const filtered = allProjects.filter(p => {
    const matchSearch = !filterSearch ||
      (p.project_name || '').toLowerCase().includes(filterSearch) ||
      (p.client_name || '').toLowerCase().includes(filterSearch);
    const matchClient = !filterClient || p.client_name === filterClient;
    return matchSearch && matchClient;
  });

  if (filtered.length === 0) {
    listBody.innerHTML = '<div class="empty-state"><p>No applications match filters.</p></div>';
    return;
  }

  const table = el('table', { className: 'wf-table' });
  table.innerHTML = `<thead><tr><th>Client</th><th>Application</th><th>Stage</th></tr></thead>`;
  const tbody = el('tbody');

  filtered.forEach(p => {
    const tr = el('tr', { className: 'clickable' },
      el('td', { className: 'muted' }, p.client_name || '—'),
      el('td', {}, p.project_name),
      el('td', {}, statusTag(p.stage || p.status))
    );
    tr.addEventListener('click', () => {
      document.querySelectorAll('#project-detail-pane ~ * tr.selected, .pane-left tr.selected')
        .forEach(r => r.classList.remove('selected'));
      document.querySelectorAll('.pane-left tr.selected').forEach(r => r.classList.remove('selected'));
      tr.classList.add('selected');
      loadDetail(p, paneRight);
    });
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  listBody.appendChild(table);
}

async function loadDetail(project, pane) {
  selectedProject = project;
  pane.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';

  try {
    const full = await apiFetch(`/projects/${project.project_id}`);
    renderDetail(full, pane);
  } catch (err) {
    renderDetail(project, pane);
  }
}

function renderDetail(p, pane) {
  pane.innerHTML = '';

  const header = el('div', { className: 'pane-header' },
    el('span', { className: 'pane-title' }, p.project_name),
    statusTag(p.stage || p.status)
  );
  pane.appendChild(header);

  const body = el('div', { className: 'pane-body' });

  // Identity fields
  const idSection = el('div', { className: 'detail-section' });
  idSection.appendChild(el('h4', {}, 'Identity'));
  const grid = el('div', { className: 'meta-grid' });

  const fields = [
    { key: 'project_id', label: 'Application ID' },
    { key: 'client_name', label: 'Client' },
    { key: 'project_name', label: 'Application Name' },
    { key: 'stage', label: 'Stage' },
    { key: 'created_at', label: 'Created', type: 'date' },
    { key: 'owner', label: 'Owner' },
    { key: 'confidence_threshold', label: 'Agent Confidence Threshold (0–1)', type: 'number' },
    { key: 'ripple_scan_scope', label: 'Ingest Ripple-Scan Scope', type: 'select',
      options: [['project', 'Whole project (default)'], ['workflow', 'Workflow + linked use case']] },
    { key: 'target_platform', label: 'Target Platform (which AI Guidance applies)', type: 'select',
      options: [['servicenow', 'ServiceNow'], ['generic', 'Generic']] },
    { key: 'description', label: 'Description', wide: true },
  ];

  const inputs = {};
  fields.forEach(f => {
    const wrap = el('div', { className: 'meta-item' + (f.wide ? ' form-group' : '') });
    if (f.wide) {
      const label = el('label', { className: 'form-label' }, f.label);
      const input = el('textarea', { className: 'form-textarea', rows: '2' });
      input.value = p[f.key] || '';
      inputs[f.key] = input;
      wrap.appendChild(label);
      wrap.appendChild(input);
    } else if (f.type === 'number') {
      wrap.appendChild(el('div', { className: 'meta-key' }, f.label));
      const input = el('input', { type: 'number', className: 'form-input',
        min: '0', max: '1', step: '0.05' });
      input.value = p[f.key] != null ? p[f.key] : '0.75';
      inputs[f.key] = input;
      wrap.appendChild(input);
    } else if (f.type === 'select') {
      wrap.appendChild(el('div', { className: 'meta-key' }, f.label));
      const input = el('select', { className: 'form-input' });
      (f.options || []).forEach(([val, lbl]) => {
        const opt = el('option', { value: val }, lbl);
        if ((p[f.key] || f.options[0][0]) === val) opt.selected = true;
        input.appendChild(opt);
      });
      inputs[f.key] = input;
      wrap.appendChild(input);
    } else {
      wrap.appendChild(el('div', { className: 'meta-key' }, f.label));
      const input = el('input', { type: 'text', className: 'form-input' });
      input.value = p[f.key] || '';
      inputs[f.key] = input;
      wrap.appendChild(input);
    }
    grid.appendChild(wrap);
  });

  idSection.appendChild(grid);
  body.appendChild(idSection);

  // ── ServiceNow Connection ────────────────────────────────────────────────────
  const snSection = el('div', { className: 'detail-section' });
  snSection.appendChild(el('h4', {}, 'ServiceNow Connection'));
  snSection.appendChild(el('p', { className: 'text-muted text-sm', style: 'margin-bottom:12px' },
    'Connect this application to a live ServiceNow instance. Once configured, use Administration → ServiceNow Sync to reverse-engineer the design from the running app.'));

  const snGrid = el('div', { className: 'meta-grid' });

  const snInstanceWrap = el('div', { className: 'meta-item', style: 'grid-column:span 2' });
  snInstanceWrap.appendChild(el('div', { className: 'meta-key' }, 'Instance URL'));
  const snInstanceInput = el('input', { type: 'text', className: 'form-input', placeholder: 'https://example.service-now.com' });
  snInstanceInput.value = p.servicenow_instance || '';
  snInstanceWrap.appendChild(snInstanceInput);
  snGrid.appendChild(snInstanceWrap);

  const snScopeWrap = el('div', { className: 'meta-item' });
  snScopeWrap.appendChild(el('div', { className: 'meta-key' }, 'Application Scope'));
  const snScopeInput = el('input', { type: 'text', className: 'form-input', placeholder: 'x_acme_myapp' });
  snScopeInput.value = p.servicenow_scope || '';
  snScopeWrap.appendChild(snScopeInput);
  snGrid.appendChild(snScopeWrap);

  const snSysAppWrap = el('div', { className: 'meta-item' });
  snSysAppWrap.appendChild(el('div', { className: 'meta-key' }, 'Sys App ID (optional)'));
  const snSysAppInput = el('input', { type: 'text', className: 'form-input', placeholder: 'b9c3fc870aa5…' });
  snSysAppInput.value = p.servicenow_sys_app_id || '';
  snSysAppWrap.appendChild(snSysAppInput);
  snGrid.appendChild(snSysAppWrap);

  const snUserWrap = el('div', { className: 'meta-item' });
  snUserWrap.appendChild(el('div', { className: 'meta-key' }, 'Username'));
  const snUserInput = el('input', { type: 'text', className: 'form-input', placeholder: 'svc_account' });
  snUserInput.value = p.sn_user || '';
  snUserWrap.appendChild(snUserInput);
  snGrid.appendChild(snUserWrap);

  const snPwWrap = el('div', { className: 'meta-item' });
  snPwWrap.appendChild(el('div', { className: 'meta-key' }, 'Password'));
  const snPwInput = el('input', { type: 'password', className: 'form-input',
    placeholder: p.has_sn_password ? '(stored — enter to update)' : 'Enter password' });
  snPwWrap.appendChild(snPwInput);
  snGrid.appendChild(snPwWrap);

  snSection.appendChild(snGrid);

  const snCredStatus = el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:8px;margin-bottom:10px' },
    p.has_sn_password
      ? `Credentials stored for "${p.sn_user || '(user not set)'}". Leave password blank to keep existing.`
      : 'No stored credentials — global SN_USER / SN_PASSWORD env vars will be used as fallback.');
  snSection.appendChild(snCredStatus);

  const saveSnBtn = el('button', { className: 'btn btn-secondary btn-sm' }, 'Save connection');
  const clearSnBtn = el('button', { className: 'btn btn-ghost btn-sm', style: 'margin-left:8px' }, 'Clear credentials');

  saveSnBtn.addEventListener('click', async () => {
    saveSnBtn.disabled = true;
    try {
      const payload = {
        servicenow_instance: snInstanceInput.value.trim() || null,
        servicenow_scope: snScopeInput.value.trim() || null,
        servicenow_sys_app_id: snSysAppInput.value.trim() || null,
        sn_user: snUserInput.value.trim() || null,
      };
      if (snPwInput.value) payload.sn_password = snPwInput.value;
      const updated = await apiFetch(`/projects/${p.project_id}/servicenow-link`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      snPwInput.value = '';
      snCredStatus.textContent = updated.has_sn_password
        ? `Credentials stored for "${updated.sn_user || '(user not set)'}". Leave password blank to keep existing.`
        : 'No stored credentials — global SN_USER / SN_PASSWORD env vars will be used as fallback.';
      showToast('ServiceNow connection saved.', 'success');
    } catch (err) { showToast('Save failed: ' + err.message, 'error'); }
    finally { saveSnBtn.disabled = false; }
  });

  clearSnBtn.addEventListener('click', async () => {
    if (!confirm('Clear stored ServiceNow credentials? The server env vars will be used as fallback.')) return;
    clearSnBtn.disabled = true;
    try {
      await apiFetch(`/projects/${p.project_id}/servicenow-credentials`, { method: 'DELETE' });
      snUserInput.value = '';
      snPwInput.value = '';
      snCredStatus.textContent = 'No stored credentials — global SN_USER / SN_PASSWORD env vars will be used as fallback.';
      showToast('Credentials cleared.', 'success');
    } catch (err) { showToast('Clear failed: ' + err.message, 'error'); }
    finally { clearSnBtn.disabled = false; }
  });

  snSection.appendChild(el('div', {}, saveSnBtn, clearSnBtn));
  body.appendChild(snSection);

  // Reuse scope
  const reuseSection = el('div', { className: 'detail-section' });
  reuseSection.appendChild(el('h4', {}, 'Reuse Scope'));
  const reuse = p.reuse_scope || [];
  if (reuse.length === 0) {
    reuseSection.appendChild(el('p', { className: 'text-muted text-sm' }, 'No reuse scope entries.'));
  } else {
    const t = el('table', { className: 'wf-table' });
    t.innerHTML = `<thead><tr><th>Type</th><th>Name</th><th>Visibility</th></tr></thead>`;
    const tb = el('tbody');
    reuse.forEach(r => tb.appendChild(el('tr', {},
      el('td', {}, r.content_type || r.type || '—'),
      el('td', {}, r.name || '—'),
      el('td', {}, statusTag(r.visibility_scope || r.scope))
    )));
    t.appendChild(tb);
    reuseSection.appendChild(t);
  }
  body.appendChild(reuseSection);

  // Members
  const membersSection = el('div', { className: 'detail-section' });
  const membersHeader = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' } });
  membersHeader.appendChild(el('h4', { style: { marginBottom: '0' } }, 'Team Members'));
  const addMemberBtn = el('button', { className: 'btn btn-ghost btn-sm' }, '+ Add Member');
  membersHeader.appendChild(addMemberBtn);
  membersSection.appendChild(membersHeader);

  const members = p.members || [];
  if (members.length > 0) {
    const t = el('table', { className: 'wf-table' });
    t.innerHTML = `<thead><tr><th>Name</th><th>Role</th><th>Email</th></tr></thead>`;
    const tb = el('tbody');
    members.forEach(m => tb.appendChild(el('tr', {},
      el('td', {}, m.display_name || m.user_id || '—'),
      el('td', {}, statusTag(m.member_role)),
      el('td', { className: 'muted' }, m.email || '—')
    )));
    t.appendChild(tb);
    membersSection.appendChild(t);
  } else {
    membersSection.appendChild(el('p', { className: 'text-muted text-sm' }, 'No team members yet.'));
  }

  // Inline add member form
  const inlineForm = el('div', { className: 'inline-form', style: { display: 'none' } });
  inlineForm.innerHTML = `
    <div class="inline-form-row">
      <div class="form-group" style="flex:1"><label class="form-label">User ID / Email</label>
        <input type="text" class="form-input" id="new-member-id" placeholder="user@example.com"></div>
      <div class="form-group"><label class="form-label">Role</label>
        <select class="form-select" id="new-member-role">
          <option>viewer</option><option>contributor</option><option>owner</option><option>admin</option>
        </select></div>
      <button class="btn btn-success btn-sm" id="save-member-btn" style="margin-top:22px">Add</button>
      <button class="btn btn-ghost btn-sm" id="cancel-member-btn" style="margin-top:22px">Cancel</button>
    </div>`;

  addMemberBtn.addEventListener('click', () => {
    inlineForm.style.display = inlineForm.style.display === 'none' ? 'block' : 'none';
  });

  inlineForm.querySelector('#cancel-member-btn').addEventListener('click', () => {
    inlineForm.style.display = 'none';
  });

  inlineForm.querySelector('#save-member-btn').addEventListener('click', async () => {
    const userId = inlineForm.querySelector('#new-member-id').value.trim();
    const role = inlineForm.querySelector('#new-member-role').value;
    if (!userId) { showToast('Enter a user ID or email.', 'error'); return; }
    try {
      await apiFetch(`/projects/${p.project_id}/members`, {
        method: 'POST',
        body: JSON.stringify({ user_id: userId, display_name: userId, member_role: role }),
      });
      showToast('Member added.', 'success');
      const updated = await apiFetch(`/projects/${p.project_id}`);
      renderDetail(updated, pane);
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  });

  membersSection.appendChild(inlineForm);
  body.appendChild(membersSection);

  // Agent checkboxes
  const agentSection = el('div', { className: 'detail-section' });
  agentSection.appendChild(el('h4', {}, 'Enabled Agents'));
  const agents = p.enabled_agents || p.agents || [];
  if (agents.length === 0) {
    agentSection.appendChild(el('p', { className: 'text-muted text-sm' }, 'No agent settings configured. Set them in Agent Trust.'));
  } else {
    const list = el('div', { className: 'agent-list' });
    agents.forEach(a => {
      const row = el('label', { className: 'checkbox-wrap' });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = a.enabled !== false;
      row.appendChild(cb);
      row.appendChild(document.createTextNode(a.agent_name || a.name || a.id));
      list.appendChild(row);
    });
    agentSection.appendChild(list);
  }
  body.appendChild(agentSection);

  // Save button
  const footer = el('div', { className: 'detail-section', style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } });
  const saveBtn = el('button', { className: 'btn btn-primary' }, 'Save Changes');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const payload = {};
      fields.forEach(f => { if (inputs[f.key]) payload[f.key] = inputs[f.key].value; });
      await apiFetch(`/projects/${p.project_id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      showToast('Application saved.', 'success');
      // Refresh list
      const idx = allProjects.findIndex(x => x.project_id === p.project_id);
      if (idx >= 0) allProjects[idx] = { ...allProjects[idx], ...payload };
    } catch (err) {
      showToast(`Save failed: ${err.message}`, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
    }
  });
  footer.appendChild(el('button', { className: 'btn btn-ghost' }, 'Discard'));
  footer.appendChild(saveBtn);
  body.appendChild(footer);

  // ── AI Cost section (async-loaded) ──────────────────────────────────────────
  const costSection = el('div', { className: 'detail-section' });
  costSection.appendChild(el('h4', {}, 'AI Cost'));
  const costBody = el('div', {});
  costBody.appendChild(el('p', { className: 'text-muted text-sm' }, 'Loading…'));
  costSection.appendChild(costBody);
  body.appendChild(costSection);

  // Load async — don't block render
  apiFetch(`/projects/${p.project_id}/usage`).then(usage => {
    costBody.innerHTML = '';
    const t = usage.totals || {};
    const fmtC = n => n == null ? '—' : '$' + Number(n).toFixed(4);
    const fmtT = n => { n = Number(n || 0); return n >= 1000 ? (n/1000).toFixed(1)+'k' : String(n); };
    const fmtSrc = s => (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    // Summary stat chips
    const stats = el('div', { style: 'display:flex;gap:20px;flex-wrap:wrap;margin-bottom:12px' });
    [[fmtC(t.cost_usd), 'Est. total cost'], [String(t.runs||0), 'AI Agent runs'],
     [fmtT(t.input_tokens), 'Input tokens'], [fmtT(t.output_tokens), 'Output tokens']
    ].forEach(([val, lbl]) => stats.appendChild(el('div', {},
      el('div', { style: 'font-size:20px;font-weight:700' }, val),
      el('div', { style: 'font-size:11px;color:var(--text-muted)' }, lbl))));
    costBody.appendChild(stats);

    if (!(usage.rows||[]).length) {
      costBody.appendChild(el('p', { className: 'text-muted text-sm' }, 'No AI activity recorded for this Application yet.'));
      return;
    }

    // By AI Agent (source)
    if ((usage.by_source||[]).length) {
      costBody.appendChild(el('h5', { style: 'margin:10px 0 6px' }, 'By AI Agent'));
      const tbl = el('table', { className: 'dr-compact-table', style: 'width:100%;margin-bottom:12px' });
      tbl.appendChild(el('thead', {}, el('tr', {},
        el('th', {}, 'AI Agent'), el('th', { style:'text-align:right' }, 'Runs'),
        el('th', { style:'text-align:right' }, 'Est. Cost'))));
      const tb = el('tbody');
      usage.by_source.forEach(r => tb.appendChild(el('tr', {},
        el('td', {}, fmtSrc(r.source)),
        el('td', { style:'text-align:right' }, String(r.runs)),
        el('td', { style:'text-align:right;font-family:monospace' }, fmtC(r.cost_usd)))));
      tbl.appendChild(tb);
      costBody.appendChild(tbl);
    }

    // By model
    if ((usage.by_model||[]).length) {
      costBody.appendChild(el('h5', { style: 'margin:10px 0 6px' }, 'By model'));
      const tbl = el('table', { className: 'dr-compact-table', style: 'width:100%;margin-bottom:12px' });
      tbl.appendChild(el('thead', {}, el('tr', {},
        el('th', {}, 'Model'), el('th', { style:'text-align:right' }, 'Runs'),
        el('th', { style:'text-align:right' }, 'In'), el('th', { style:'text-align:right' }, 'Out'),
        el('th', { style:'text-align:right' }, 'Est. Cost'))));
      const tb = el('tbody');
      usage.by_model.forEach(r => tb.appendChild(el('tr', {},
        el('td', {}, r.model || '—'),
        el('td', { style:'text-align:right' }, String(r.runs)),
        el('td', { style:'text-align:right;font-family:monospace' }, fmtT(r.input_tokens)),
        el('td', { style:'text-align:right;font-family:monospace' }, fmtT(r.output_tokens)),
        el('td', { style:'text-align:right;font-family:monospace' }, fmtC(r.cost_usd)))));
      tbl.appendChild(tb);
      costBody.appendChild(tbl);
    }

    // Recent runs
    costBody.appendChild(el('h5', { style: 'margin:10px 0 6px' }, 'Recent runs'));
    const tbl = el('table', { className: 'dr-compact-table', style: 'width:100%' });
    tbl.appendChild(el('thead', {}, el('tr', {},
      el('th', {}, 'When'), el('th', {}, 'AI Agent'), el('th', {}, 'Model'),
      el('th', { style:'text-align:right' }, 'In'), el('th', { style:'text-align:right' }, 'Out'),
      el('th', { style:'text-align:right' }, 'Cost'))));
    const tb = el('tbody');
    (usage.rows||[]).slice(0,15).forEach(r => tb.appendChild(el('tr', {},
      el('td', { style:'white-space:nowrap' }, (r.created_at||'').slice(0,16).replace('T',' ')),
      el('td', {}, el('span', { className: 'badge' }, fmtSrc(r.source))),
      el('td', {}, r.model || '—'),
      el('td', { style:'text-align:right;font-family:monospace' }, fmtT(r.input_tokens)),
      el('td', { style:'text-align:right;font-family:monospace' }, fmtT(r.output_tokens)),
      el('td', { style:'text-align:right;font-family:monospace' }, fmtC(r.cost_usd)))));
    tbl.appendChild(tb);
    costBody.appendChild(tbl);
  }).catch(() => {
    costBody.innerHTML = '<p class="text-muted text-sm">Could not load AI cost data.</p>';
  });

  pane.appendChild(body);
}

async function openNewProject(pane) {
  pane.innerHTML = '';

  const header = el('div', { className: 'pane-header' },
    el('span', { className: 'pane-title' }, 'New Application')
  );
  pane.appendChild(header);

  const body = el('div', { className: 'pane-body' });
  const form = el('div', { className: 'detail-section' });

  // ── Client selector (dropdown of real clients + "new client" option) ─────────
  // Replaces the old free-text "Client ID" box that caused FK errors when a name
  // (or blank) was typed instead of a real client_id UUID.
  let clients = [];
  try { clients = await apiFetch('/clients'); } catch (err) { console.warn('[projects] could not load clients:', err.message); }

  const clientGroup = el('div', { className: 'form-group' });
  clientGroup.appendChild(el('label', { className: 'form-label' }, 'Client *'));
  const clientSelect = el('select', { className: 'form-input' });
  clients.forEach(c => clientSelect.appendChild(
    el('option', { value: c.client_id }, `${c.client_name} (${c.client_code})`)
  ));
  clientSelect.appendChild(el('option', { value: '__new__' }, '➕ New client…'));
  clientGroup.appendChild(clientSelect);
  form.appendChild(clientGroup);

  // Inline new-client fields (hidden unless "New client" is chosen)
  const newClientWrap = el('div', { style: { display: 'none', paddingLeft: '12px', borderLeft: '2px solid var(--color-border)', marginBottom: '8px' } });
  const newClientName = el('input', { type: 'text', className: 'form-input', placeholder: 'e.g. Globex Corporation' });
  const newClientCode = el('input', { type: 'text', className: 'form-input', placeholder: 'e.g. GLOBEX' });
  newClientWrap.appendChild(el('div', { className: 'form-group' },
    el('label', { className: 'form-label' }, 'New Client Name *'), newClientName));
  newClientWrap.appendChild(el('div', { className: 'form-group' },
    el('label', { className: 'form-label' }, 'New Client Code *'), newClientCode));
  form.appendChild(newClientWrap);

  const syncNewClientVisibility = () => {
    newClientWrap.style.display = clientSelect.value === '__new__' ? 'block' : 'none';
  };
  clientSelect.addEventListener('change', syncNewClientVisibility);
  // If there are no existing clients, default to the new-client path.
  if (!clients.length) { clientSelect.value = '__new__'; }
  syncNewClientVisibility();

  // ── Remaining application fields ──────────────────────────────────────────────
  const fields = [
    { key: 'project_name', label: 'Application Name', required: true },
    { key: 'project_code', label: 'Application Code (e.g. ACME-P2)', required: true },
    { key: 'stage',        label: 'Stage (draft/build/pilot/production)', required: true },
  ];
  const inputs = {};
  fields.forEach(f => {
    const group = el('div', { className: 'form-group' });
    group.appendChild(el('label', { className: 'form-label' }, f.label + (f.required ? ' *' : '')));
    const input = el('input', { type: 'text', className: 'form-input' });
    if (f.key === 'stage') input.value = 'draft';
    inputs[f.key] = input;
    group.appendChild(input);
    form.appendChild(group);
  });

  // Target platform — drives which AI Guidance (house rules) apply to this app's ingests.
  const platGroup = el('div', { className: 'form-group' });
  platGroup.appendChild(el('label', { className: 'form-label' }, 'Target Platform'));
  const platformInput = el('select', { className: 'form-input' });
  [['servicenow', 'ServiceNow'], ['generic', 'Generic']].forEach(([val, lbl]) =>
    platformInput.appendChild(el('option', { value: val }, lbl)));
  platGroup.appendChild(platformInput);
  form.appendChild(platGroup);

  const saveBtn = el('button', { className: 'btn btn-primary' }, 'Create Application');
  saveBtn.addEventListener('click', async () => {
    const project_name = inputs.project_name.value.trim();
    const project_code = inputs.project_code.value.trim();
    if (!project_name) { showToast('Application name is required.', 'error'); return; }
    if (!project_code) { showToast('Application code is required.', 'error'); return; }

    saveBtn.disabled = true;
    try {
      // Resolve the client_id — creating a new client first if requested.
      let client_id = clientSelect.value;
      if (client_id === '__new__') {
        const cname = newClientName.value.trim();
        const ccode = newClientCode.value.trim();
        if (!cname || !ccode) { showToast('New client name and code are required.', 'error'); saveBtn.disabled = false; return; }
        const newClient = await apiFetch('/clients', {
          method: 'POST',
          body: JSON.stringify({ client_name: cname, client_code: ccode }),
        });
        client_id = newClient.client_id;
      }

      const created = await apiFetch('/projects', {
        method: 'POST',
        body: JSON.stringify({ client_id, project_name, project_code, stage: inputs.stage.value.trim() || 'draft', target_platform: platformInput.value }),
      });
      allProjects.push(created);
      showToast('Application created.', 'success');
      loadDetail(created, pane);
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  form.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '12px' } }, saveBtn));
  body.appendChild(form);
  pane.appendChild(body);
}
