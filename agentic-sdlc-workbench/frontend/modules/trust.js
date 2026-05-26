/**
 * modules/trust.js — Agent Trust & Permission Console
 */
import { apiFetch, tag, statusTag, formatDate, el, escHtml, showToast, getCurrentProjectId } from '../app.js';

let pendingChanges = {}; // settingId → { trust_level, enabled }

export async function render(container) {
  container.innerHTML = '';
  pendingChanges = {};

  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'Agent Trust & Permission Console'),
    el('p', { className: 'purpose-text' }, 'Configure trust levels, allowed behaviors, and approval expectations for each AI agent per application.')
  ));

  // Project picker
  const toolbar = el('div', { className: 'filter-bar', style: { marginBottom: '16px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', background: 'var(--color-panel)' } });
  const projLabel = el('label', { className: 'form-label', style: { marginBottom: 0 } }, 'Application:');
  const projSelect = el('select', { className: 'filter-select', id: 'trust-project-select' });
  projSelect.innerHTML = '<option value="">— Select Application —</option>';
  toolbar.appendChild(projLabel);
  toolbar.appendChild(projSelect);

  const resetBtn = el('button', { className: 'btn btn-ghost btn-sm' }, 'Reset to Defaults');
  const saveBtn = el('button', { className: 'btn btn-primary btn-sm' }, 'Save Changes');
  toolbar.appendChild(el('div', { style: { flex: '1' } }));
  toolbar.appendChild(resetBtn);
  toolbar.appendChild(saveBtn);
  container.appendChild(toolbar);

  const tableContainer = el('div', { className: 'panel' });
  container.appendChild(tableContainer);

  // Load projects
  try {
    const data = await apiFetch('/projects');
    const projects = Array.isArray(data) ? data : (data.items || data.projects || []);
    projects.forEach(p => {
      projSelect.appendChild(el('option', { value: p.project_id }, p.project_name));
    });

    // Set current project if known
    const activeId = getCurrentProjectId();
    if (activeId) {
      projSelect.value = activeId;
      await loadTrustTable(tableContainer, activeId, resetBtn);
    } else {
      tableContainer.innerHTML = '<div class="empty-state"><p>Select an application above to view agent trust settings.</p></div>';
    }
  } catch (err) {
    tableContainer.innerHTML = `<div class="error-state"><strong>Error loading applications:</strong> ${escHtml(err.message)}</div>`;
  }

  projSelect.addEventListener('change', async () => {
    if (projSelect.value) {
      pendingChanges = {};
      await loadTrustTable(tableContainer, projSelect.value, resetBtn);
    } else {
      tableContainer.innerHTML = '<div class="empty-state"><p>Select an application to view agent settings.</p></div>';
    }
  });

  saveBtn.addEventListener('click', async () => {
    const projectId = projSelect.value;
    if (!projectId) { showToast('Select an application first.', 'error'); return; }
    if (Object.keys(pendingChanges).length === 0) { showToast('No changes to save.', 'info'); return; }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    let saved = 0;
    let errors = 0;

    await Promise.all(Object.entries(pendingChanges).map(async ([settingId, changes]) => {
      try {
        await apiFetch(`/projects/${projectId}/agent-settings/${settingId}`, {
          method: 'PUT',
          body: JSON.stringify(changes),
        });
        saved++;
      } catch (e) {
        errors++;
        console.error(`Failed to save setting ${settingId}:`, e);
      }
    }));

    if (errors === 0) {
      showToast(`Saved ${saved} agent setting${saved !== 1 ? 's' : ''}.`, 'success');
      pendingChanges = {};
    } else {
      showToast(`${saved} saved, ${errors} failed.`, 'error');
    }

    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Changes';
  });
}

async function loadTrustTable(container, projectId, resetBtn) {
  container.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';

  try {
    const data = await apiFetch(`/projects/${projectId}/agent-settings`);
    const settings = Array.isArray(data) ? data : (data.items || data.settings || []);

    if (settings.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🤖</div><h3>No agent settings</h3><p>No agent trust settings configured for this application.</p></div>';
      return;
    }

    container.innerHTML = '';

    resetBtn.onclick = () => {
      settings.forEach(s => {
        const dial = container.querySelector(`[data-setting-id="${s.project_agent_setting_id}"]`);
        if (dial) {
          const defaultLevel = s.default_trust_level ?? s.catalog_trust_level ?? 3;
          updateDial(dial, defaultLevel, s.project_agent_setting_id);
        }
      });
      showToast('Reset to catalog defaults (unsaved).', 'info');
    };

    const table = el('table', { className: 'wf-table' });
    table.innerHTML = `
      <thead>
        <tr>
          <th>Agent</th>
          <th>Trust Level</th>
          <th>Allowed Behaviors</th>
          <th>Approval Expectation</th>
          <th>Enabled</th>
          <th>Override</th>
        </tr>
      </thead>`;

    const tbody = el('tbody');

    settings.forEach(s => {
      const tr = el('tr');

      // Agent name
      tr.appendChild(el('td', {},
        el('div', { style: { fontWeight: '500' } }, s.agent_name || `Agent ${s.project_agent_setting_id}`),
        el('div', { style: { fontSize: '11px', color: 'var(--color-text-faint)' } }, s.workbench_agent_id || '')
      ));

      // Trust dial
      const dialCell = el('td');
      const dial = buildTrustDial(s.trust_level ?? 3, s.project_agent_setting_id);
      dialCell.appendChild(dial);
      tr.appendChild(dialCell);

      // Allowed behaviors
      const behaviors = s.allowed_behaviors || [];
      const behavCell = el('td');
      if (behaviors.length > 0) {
        const wrap = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } });
        behaviors.slice(0, 4).forEach(b => wrap.appendChild(tag(b, 'muted')));
        if (behaviors.length > 4) wrap.appendChild(tag(`+${behaviors.length - 4}`, 'info'));
        behavCell.appendChild(wrap);
      } else {
        behavCell.appendChild(el('span', { className: 'text-muted text-sm' }, '—'));
      }
      tr.appendChild(behavCell);

      // Approval expectation
      tr.appendChild(el('td', {}, statusTag(s.approval_expectation || s.approval_mode || 'manual')));

      // Enabled toggle
      const toggleCell = el('td');
      toggleCell.appendChild(buildToggle(s.enabled !== false, s.project_agent_setting_id));
      tr.appendChild(toggleCell);

      // Override badge
      const overrideCell = el('td');
      if (s.project_override) {
        overrideCell.appendChild(tag('app override', 'purple'));
      } else {
        overrideCell.appendChild(el('span', { className: 'text-muted text-sm' }, 'catalog'));
      }
      tr.appendChild(overrideCell);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.appendChild(table);

  } catch (err) {
    container.innerHTML = `<div class="error-state"><strong>Error loading settings:</strong> ${escHtml(err.message)}</div>`;
  }
}

function buildTrustDial(level, settingId) {
  const dial = el('div', { className: 'trust-dial', 'data-setting-id': settingId, 'data-level': level });

  for (let i = 1; i <= 5; i++) {
    const pip = el('div', { className: 'trust-pip' + (i <= level ? ' filled' : ''), 'data-pip': i });
    pip.title = `Set trust to ${i}`;
    pip.addEventListener('click', () => updateDial(dial, i, settingId));
    pip.addEventListener('mouseenter', () => {
      dial.querySelectorAll('.trust-pip').forEach((p, idx) => {
        p.style.background = idx < i ? 'var(--color-accent)' : '';
        p.style.borderColor = idx < i ? 'var(--color-accent)' : '';
      });
    });
    pip.addEventListener('mouseleave', () => {
      const cur = parseInt(dial.dataset.level, 10);
      dial.querySelectorAll('.trust-pip').forEach((p, idx) => {
        p.style.background = '';
        p.style.borderColor = '';
        p.classList.toggle('filled', idx < cur);
      });
    });
    dial.appendChild(pip);
  }

  // Level label
  dial.appendChild(el('span', { style: { marginLeft: '6px', fontSize: '12px', color: 'var(--color-text-muted)' }, className: 'dial-label' }, `L${level}`));
  return dial;
}

function updateDial(dial, newLevel, settingId) {
  dial.dataset.level = newLevel;
  dial.querySelectorAll('.trust-pip').forEach((p, idx) => {
    p.classList.toggle('filled', idx < newLevel);
  });
  const label = dial.querySelector('.dial-label');
  if (label) label.textContent = `L${newLevel}`;

  // Track change
  pendingChanges[settingId] = pendingChanges[settingId] || {};
  pendingChanges[settingId].trust_level = newLevel;
}

function buildToggle(enabled, settingId) {
  const wrap = el('label', { className: 'toggle' });
  const input = el('input', { type: 'checkbox' });
  input.checked = enabled;

  input.addEventListener('change', () => {
    pendingChanges[settingId] = pendingChanges[settingId] || {};
    pendingChanges[settingId].enabled = input.checked;
  });

  const track = el('div', { className: 'toggle-track' },
    el('div', { className: 'toggle-thumb' })
  );

  wrap.appendChild(input);
  wrap.appendChild(track);
  return wrap;
}
