/**
 * modules/cost_management.js — Now Assist Cost Management (Phase 4)
 *
 * As of the per-Application pricing model, ALL cost params (cost_per_assist,
 * overage_rate, cost_per_assist_expansion, planning_period, periods_per_year,
 * entitlement_enabled, annual_included_assists) live on each Application and
 * are edited under Cost Projections. This page is now the global Now Assist
 * Rate Card (132 skills) only.
 */
import { apiFetch, el, showToast, escHtml } from '../app.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtCurrency(val) {
  if (val == null) return '—';
  return '$' + Number(val).toFixed(4);
}

// ─── Main render ────────────────────────────────────────────────────────────

export async function render(container) {
  container.innerHTML = '';

  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'Cost Management'),
    el('p', { className: 'purpose-text' },
      'Global Now Assist skill rate card. All cost parameters (cost per assist, overage rate, ' +
      'expansion pack rate, planning period, entitlement, annual included assists) are set per Application ' +
      'on the Cost Projections page.')
  ));

  // ── Rate Card (the only thing on this page now) ──────────────────────────
  const rcPanel = el('div', { className: 'panel' });
  const rcHeader = el('div', { className: 'panel-header', style: 'display:flex;align-items:center;justify-content:space-between' });
  rcHeader.appendChild(el('h3', { className: 'panel-title' }, 'Now Assist Rate Card'));
  const rcCountBadge = el('span', { className: 'badge badge-info' }, 'Loading…');
  rcHeader.appendChild(rcCountBadge);
  rcPanel.appendChild(rcHeader);

  const rcBody = el('div', { className: 'panel-body' });
  rcPanel.appendChild(rcBody);
  container.appendChild(rcPanel);

  // Filter row
  const filterRow = el('div', { style: 'display:flex;gap:10px;margin-bottom:12px;align-items:center' });
  const categoryFilter = el('select', { className: 'form-input', style: 'max-width:180px' });
  categoryFilter.appendChild(el('option', { value: '' }, 'All categories'));
  const skillFilter = el('input', { type: 'text', className: 'form-input', placeholder: 'Search skill name…',
    style: 'flex:1;max-width:400px' });
  filterRow.appendChild(el('label', { className: 'form-label', style: 'margin:0' }, 'Category:'));
  filterRow.appendChild(categoryFilter);
  filterRow.appendChild(skillFilter);
  rcBody.appendChild(filterRow);

  const rcTableWrap = el('div', { style: 'overflow-x:auto' });
  rcBody.appendChild(rcTableWrap);

  let allSkills = [];

  async function loadRateCard() {
    try {
      allSkills = await apiFetch('/rate-card');
      rcCountBadge.textContent = `${allSkills.length} skills`;
      // Populate categories
      const cats = [...new Set(allSkills.map(s => s.category))].sort();
      categoryFilter.innerHTML = '<option value="">All categories</option>';
      cats.forEach(c => categoryFilter.appendChild(el('option', { value: c }, c)));
      renderTable();
    } catch (err) {
      rcBody.appendChild(el('p', { style: 'color:var(--danger)' }, 'Failed to load rate card: ' + err.message));
    }
  }

  function renderTable() {
    const catVal = categoryFilter.value;
    const nameVal = skillFilter.value.toLowerCase();
    const filtered = allSkills.filter(s =>
      (!catVal || s.category === catVal) &&
      (!nameVal || s.skill_name.toLowerCase().includes(nameVal))
    );

    const table = el('table', { className: 'dr-compact-table', style: 'width:100%' });
    const thead = el('thead');
    thead.appendChild(el('tr', {},
      el('th', {}, 'Skill Name'),
      el('th', { style: 'width:120px' }, 'Category'),
      el('th', { style: 'width:120px;text-align:right' }, 'Assists/Unit'),
      el('th', { style: 'width:60px' }, '')
    ));
    table.appendChild(thead);

    const tbody = el('tbody');
    filtered.forEach(skill => {
      const tr = el('tr');
      const nameTd = el('td', {});
      const nameText = el('span', {}, skill.skill_name);
      if (skill.category === 'Agentic') {
        nameText.style.fontWeight = '600';
        nameText.style.color = 'var(--primary)';
      }
      nameTd.appendChild(nameText);
      if (skill.description) {
        nameTd.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px;max-width:500px' },
          skill.description.substring(0, 120) + (skill.description.length > 120 ? '…' : '')));
      }
      tr.appendChild(nameTd);
      tr.appendChild(el('td', {}, el('span', { className: 'badge' }, skill.category || '—')));
      tr.appendChild(el('td', { style: 'text-align:right;font-family:monospace' }, String(skill.assists_per_unit)));

      // Edit button
      const editBtn = el('button', { className: 'btn-icon', title: 'Edit assists per unit' }, '✏️');
      editBtn.addEventListener('click', () => openEditSkillModal(skill, loadRateCard));
      tr.appendChild(el('td', { style: 'text-align:center' }, editBtn));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    rcTableWrap.innerHTML = '';
    rcTableWrap.appendChild(table);

    if (filtered.length === 0) {
      rcTableWrap.appendChild(el('p', { className: 'dr-empty-note' }, 'No skills match the current filter.'));
    }
  }

  categoryFilter.addEventListener('change', renderTable);
  skillFilter.addEventListener('input', renderTable);

  await loadRateCard();
}

// ─── Edit skill modal ────────────────────────────────────────────────────────

function openEditSkillModal(skill, onSaved) {
  const overlay = el('div', { className: '_p2Overlay' });
  const modal = el('div', { className: '_p2Header', style: 'max-width:480px' });

  modal.appendChild(el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px' },
    el('h3', { style: 'margin:0' }, 'Edit Skill: ' + skill.skill_name),
    Object.assign(el('button', { className: '_p2Close' }, '×'), {
      onclick: () => overlay.remove()
    })
  ));

  const form = el('div', { style: 'display:grid;gap:12px' });

  form.appendChild(el('div', { className: 'form-group' },
    el('label', { className: 'form-label' }, 'Skill Name (read-only)'),
    el('input', { type: 'text', className: 'form-input', value: skill.skill_name, readOnly: true,
      style: 'background:var(--surface-secondary);opacity:0.7' })
  ));

  const assistsGrp = el('div', { className: 'form-group' });
  assistsGrp.appendChild(el('label', { className: 'form-label' }, 'Assists per Unit'));
  const assistsInput = el('input', { type: 'number', className: 'form-input', min: '0', step: '0.5',
    value: skill.assists_per_unit });
  assistsGrp.appendChild(assistsInput);
  form.appendChild(assistsGrp);

  const catGrp = el('div', { className: 'form-group' });
  catGrp.appendChild(el('label', { className: 'form-label' }, 'Category'));
  const catInput = el('input', { type: 'text', className: 'form-input', value: skill.category || '' });
  catGrp.appendChild(catInput);
  form.appendChild(catGrp);

  const saveBtn = el('button', { className: 'btn btn-primary' }, 'Save');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await apiFetch(`/rate-card/${encodeURIComponent(skill.skill_id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assists_per_unit: parseFloat(assistsInput.value),
          category: catInput.value.trim(),
        })
      });
      showToast('Skill updated', 'success');
      overlay.remove();
      onSaved();
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });

  modal.appendChild(form);
  modal.appendChild(el('div', { style: 'margin-top:16px;text-align:right' }, saveBtn));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}
