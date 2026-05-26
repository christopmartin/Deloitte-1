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

  pane.appendChild(body);
}

function openNewProject(pane) {
  pane.innerHTML = '';

  const header = el('div', { className: 'pane-header' },
    el('span', { className: 'pane-title' }, 'New Application')
  );
  pane.appendChild(header);

  const body = el('div', { className: 'pane-body' });
  const form = el('div', { className: 'detail-section' });

  const fields = [
    { key: 'project_name', label: 'Application Name', required: true },
    { key: 'project_code', label: 'Application Code (e.g. ACME-P2)', required: true },
    { key: 'client_id', label: 'Client ID' },
    { key: 'stage', label: 'Stage (draft/build/pilot/production)', required: true },
  ];

  const inputs = {};
  fields.forEach(f => {
    const group = el('div', { className: 'form-group' });
    group.appendChild(el('label', { className: 'form-label' }, f.label + (f.required ? ' *' : '')));
    let input;
    if (f.type === 'textarea') {
      input = el('textarea', { className: 'form-textarea', rows: '3' });
    } else {
      input = el('input', { type: 'text', className: 'form-input' });
    }
    inputs[f.key] = input;
    group.appendChild(input);
    form.appendChild(group);
  });

  const saveBtn = el('button', { className: 'btn btn-primary' }, 'Create Application');
  saveBtn.addEventListener('click', async () => {
    const payload = {};
    fields.forEach(f => { payload[f.key] = inputs[f.key].value; });
    if (!payload.project_name) { showToast('Application name is required.', 'error'); return; }
    saveBtn.disabled = true;
    try {
      const created = await apiFetch('/projects', {
        method: 'POST',
        body: JSON.stringify(payload),
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
