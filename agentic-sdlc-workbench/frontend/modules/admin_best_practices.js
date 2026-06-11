/**
 * modules/admin_best_practices.js — Administration › AI Guidance
 *
 * WI-10: human-authored best practices / house rules injected into the AI's
 * extraction prompt. WI-9: a learning view showing how often reviewers accepted
 * vs rejected AI proposals, with a one-click "Save as best practice" on any
 * correction to close the loop.
 */
import { apiFetch, el, showToast, formatDateTime, escHtml } from '../app.js';

export async function render(container) {
  container.innerHTML = '';
  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'AI Guidance & Learning'),
    el('p', { className: 'purpose-text' },
      'Best practices are house rules the extraction agent must follow — they are injected into its prompt. ' +
      'The learning panel shows how often your team accepted or rejected the AI\'s proposals so you can turn ' +
      'recurring corrections into new rules.')
  ));

  // ── Add form (also the target of "Save as best practice") ──────────────────
  const addPanel = el('div', { className: 'panel' });
  addPanel.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, 'Add a best practice')));
  const addBody = el('div', { className: 'panel-body', style: 'display:grid;gap:10px;max-width:680px' });
  const titleInput = el('input', { type: 'text', className: 'form-input', placeholder: 'Short title (e.g. "Classify SLA mentions as guardrails")' });
  const ruleInput  = el('textarea', { className: 'form-input', rows: '3', placeholder: 'The rule, in plain English. The AI will follow this on every extraction.' });
  const scopeSel   = el('select', { className: 'form-input', style: 'max-width:240px' });
  scopeSel.appendChild(el('option', { value: 'global' }, 'Global (all entities)'));
  ['use_case','workflow','workflow_step','hitl_gate','agent_spec','tool','guardrail','user_story','data_source','governance_control']
    .forEach(t => scopeSel.appendChild(el('option', { value: t }, t)));
  const platformSel = el('select', { className: 'form-input', style: 'max-width:240px' });
  [['any','Any platform'],['servicenow','ServiceNow only'],['generic','Generic only']]
    .forEach(([v, label]) => platformSel.appendChild(el('option', { value: v }, label)));
  addBody.appendChild(el('div', { className: 'form-group' }, el('label', { className: 'form-label' }, 'Title'), titleInput));
  addBody.appendChild(el('div', { className: 'form-group' }, el('label', { className: 'form-label' }, 'Rule'), ruleInput));
  addBody.appendChild(el('div', { className: 'form-group' }, el('label', { className: 'form-label' }, 'Scope'), scopeSel));
  addBody.appendChild(el('div', { className: 'form-group' },
    el('label', { className: 'form-label' }, 'Platform'),
    platformSel,
    el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:4px' },
      'Which target platform this rule applies to. "Any" applies to every document; "ServiceNow only" applies just to ServiceNow-tagged work.')));
  const addBtn = el('button', { className: 'btn btn-primary' }, 'Add best practice');
  let pendingSource = 'manual';
  addBtn.addEventListener('click', async () => {
    if (!titleInput.value.trim() || !ruleInput.value.trim()) { showToast('Title and rule are required', 'error'); return; }
    addBtn.disabled = true;
    try {
      await apiFetch('/best-practices', { method: 'POST', body: JSON.stringify({
        title: titleInput.value.trim(), rule_text: ruleInput.value.trim(),
        scope: scopeSel.value, platform: platformSel.value, source: pendingSource,
      })});
      showToast('Best practice added', 'success');
      titleInput.value = ''; ruleInput.value = ''; scopeSel.value = 'global'; platformSel.value = 'any'; pendingSource = 'manual';
      await loadList();
    } catch (err) { showToast('Failed: ' + err.message, 'error'); }
    finally { addBtn.disabled = false; }
  });
  addBody.appendChild(el('div', {}, addBtn));
  addPanel.appendChild(addBody);
  container.appendChild(addPanel);

  // ── Existing rules ─────────────────────────────────────────────────────────
  const listPanel = el('div', { className: 'panel', style: 'margin-top:18px' });
  listPanel.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, 'Active & inactive rules')));
  const listBody = el('div', { className: 'panel-body' });
  listPanel.appendChild(listBody);
  container.appendChild(listPanel);

  // ── Standing Questions ──────────────────────────────────────────────────────
  // Questions (practice_type='question') are surfaced to the product owner during
  // ingest review — they are NOT injected into the AI prompt. One question is asked
  // once per project for each scope (workflow run volume, agent cost model).
  const sqPanel = el('div', { className: 'panel', style: 'margin-top:18px' });
  sqPanel.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, 'Standing Questions')));
  const sqBody = el('div', { className: 'panel-body' });
  sqPanel.appendChild(sqBody);
  container.appendChild(sqPanel);

  // Add question form
  const sqAddWrap = el('div', { style: 'margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border)' });
  const sqTitleInput = el('input', { type: 'text', className: 'form-input', placeholder: 'Short title (e.g. "Workflow run volume")' });
  const sqTextInput  = el('textarea', { className: 'form-input', rows: '3', placeholder: 'The question shown to the product owner during ingest review.' });
  const sqScopeSel   = el('select', { className: 'form-input', style: 'max-width:240px' });
  ['workflow','agent_spec','use_case','global']
    .forEach(t => sqScopeSel.appendChild(el('option', { value: t }, t)));
  const sqAddBtn = el('button', { className: 'btn btn-primary', style: 'margin-top:8px' }, 'Add standing question');
  sqAddBtn.addEventListener('click', async () => {
    if (!sqTitleInput.value.trim() || !sqTextInput.value.trim()) { showToast('Title and question text are required', 'error'); return; }
    sqAddBtn.disabled = true;
    try {
      await apiFetch('/best-practices', { method: 'POST', body: JSON.stringify({
        title: sqTitleInput.value.trim(), rule_text: sqTextInput.value.trim(),
        scope: sqScopeSel.value, source: 'manual', practice_type: 'question',
      })});
      showToast('Standing question added', 'success');
      sqTitleInput.value = ''; sqTextInput.value = ''; sqScopeSel.value = 'workflow';
      await loadList();
    } catch (err) { showToast('Failed: ' + err.message, 'error'); }
    finally { sqAddBtn.disabled = false; }
  });
  sqAddWrap.appendChild(el('div', { style: 'display:grid;gap:10px;max-width:680px' },
    el('div', { className: 'form-group' }, el('label', { className: 'form-label' }, 'Title'), sqTitleInput),
    el('div', { className: 'form-group' }, el('label', { className: 'form-label' }, 'Question text'), sqTextInput),
    el('div', { className: 'form-group' }, el('label', { className: 'form-label' }, 'Scope'), sqScopeSel),
    sqAddBtn
  ));
  sqBody.appendChild(sqAddWrap);
  sqBody.appendChild(el('p', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:12px' },
    'Standing questions are asked once per project, the first time entities of the relevant scope are extracted. ' +
    'Answers are applied directly to all matching design entities — no AI re-extraction needed for these fields.'));

  const sqListBody = el('div');
  sqBody.appendChild(sqListBody);

  async function loadList() {
    listBody.innerHTML = '';
    sqListBody.innerHTML = '';
    let allBPs;
    try { allBPs = await apiFetch('/best-practices'); }
    catch (err) {
      listBody.appendChild(el('p', { style: 'color:var(--danger)' }, 'Failed to load: ' + err.message));
      return;
    }

    const rules = allBPs.filter(r => !r.practice_type || r.practice_type === 'rule');
    const questions = allBPs.filter(r => r.practice_type === 'question');

    // Render rules
    if (!rules.length) {
      listBody.appendChild(el('p', { className: 'dr-empty-note' }, 'No best practices yet. Add one above, or promote a correction below.'));
    } else {
      rules.forEach(r => {
        const row = el('div', { style: 'display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--border)' + (r.is_active ? '' : ';opacity:0.55') });
        const main = el('div', { style: 'flex:1' },
          el('div', { style: 'font-weight:600' }, r.title),
          el('div', { style: 'font-size:13px;color:var(--text-secondary);margin-top:2px' }, r.rule_text),
          el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:4px' },
            `${r.scope}${r.platform && r.platform !== 'any' ? ' · ' + r.platform : ''}${r.source === 'from_correction' ? ' · from correction' : ''}`)
        );
        const toggle = el('button', { className: 'btn btn-sm' }, r.is_active ? 'Deactivate' : 'Activate');
        toggle.addEventListener('click', async () => {
          try { await apiFetch(`/best-practices/${r.best_practice_id}`, { method: 'PUT', body: JSON.stringify({ is_active: !r.is_active }) }); await loadList(); }
          catch (err) { showToast('Failed: ' + err.message, 'error'); }
        });
        const del = el('button', { className: 'btn btn-sm btn-danger' }, 'Delete');
        del.addEventListener('click', async () => {
          if (!confirm('Delete this best practice?')) return;
          try { await apiFetch(`/best-practices/${r.best_practice_id}`, { method: 'DELETE' }); await loadList(); }
          catch (err) { showToast('Failed: ' + err.message, 'error'); }
        });
        row.appendChild(main);
        row.appendChild(el('div', { style: 'display:flex;gap:6px' }, toggle, del));
        listBody.appendChild(row);
      });
    }

    // Render standing questions
    if (!questions.length) {
      sqListBody.appendChild(el('p', { className: 'dr-empty-note' }, 'No standing questions yet. Add one above.'));
    } else {
      questions.forEach(q => {
        const row = el('div', { style: 'display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--border)' + (q.is_active ? '' : ';opacity:0.55') });
        const main = el('div', { style: 'flex:1' },
          el('div', { style: 'font-weight:600' }, q.title),
          el('div', { style: 'font-size:13px;color:var(--text-secondary);margin-top:2px' }, q.rule_text),
          el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:4px' },
            `scope: ${q.scope}${q.source === 'system' ? ' · pre-seeded' : ''}`)
        );
        const toggle = el('button', { className: 'btn btn-sm' }, q.is_active ? 'Deactivate' : 'Activate');
        toggle.addEventListener('click', async () => {
          try { await apiFetch(`/best-practices/${q.best_practice_id}`, { method: 'PUT', body: JSON.stringify({ is_active: !q.is_active }) }); await loadList(); }
          catch (err) { showToast('Failed: ' + err.message, 'error'); }
        });
        const del = el('button', { className: 'btn btn-sm btn-danger' }, 'Delete');
        del.addEventListener('click', async () => {
          if (!confirm('Delete this standing question?')) return;
          try { await apiFetch(`/best-practices/${q.best_practice_id}`, { method: 'DELETE' }); await loadList(); }
          catch (err) { showToast('Failed: ' + err.message, 'error'); }
        });
        row.appendChild(main);
        row.appendChild(el('div', { style: 'display:flex;gap:6px' }, toggle, del));
        sqListBody.appendChild(row);
      });
    }
  }

  // ── Learning / feedback ────────────────────────────────────────────────────
  const learnPanel = el('div', { className: 'panel', style: 'margin-top:18px' });
  learnPanel.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, 'Learning — proposal acceptance')));
  const learnBody = el('div', { className: 'panel-body' });
  learnPanel.appendChild(learnBody);
  container.appendChild(learnPanel);

  function prefillFromCorrection(fb) {
    let proposed = fb.proposed_value;
    try { const o = JSON.parse(fb.proposed_value); proposed = o.title || o.name || o.rule_name || JSON.stringify(o).slice(0, 120); } catch {}
    titleInput.value = `Guidance for ${fb.entity_type} extraction`;
    ruleInput.value = fb.outcome === 'rejected'
      ? `Do not extract "${proposed}" as a ${fb.entity_type} — reviewers rejected this. Be stricter about what qualifies as a ${fb.entity_type}.`
      : `When extracting a ${fb.entity_type} like "${proposed}", ensure the values match how reviewers refined it.`;
    scopeSel.value = [...scopeSel.options].some(o => o.value === fb.entity_type) ? fb.entity_type : 'global';
    pendingSource = 'from_correction';
    titleInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    titleInput.focus();
  }

  try {
    const fb = await apiFetch('/feedback/summary');
    const counts = {}; (fb.by_outcome || []).forEach(o => counts[o.outcome] = o.n);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const accepted = (counts.accepted_asis || 0) + (counts.accepted_edited || 0);
    const rate = total ? Math.round((accepted / total) * 100) : null;

    learnBody.appendChild(el('div', { style: 'display:flex;gap:24px;flex-wrap:wrap;margin-bottom:12px' },
      stat('Reviewed', total),
      stat('Accepted', accepted),
      stat('Rejected', counts.rejected || 0),
      stat('Acceptance', rate == null ? '—' : rate + '%'),
    ));

    const recent = fb.recent || [];
    if (!recent.length) {
      learnBody.appendChild(el('p', { className: 'dr-empty-note' }, 'No review feedback yet. Approve or reject ingested change packets to build this signal.'));
    } else {
      learnBody.appendChild(el('h4', { style: 'margin:8px 0' }, 'Recent reviewed items'));
      const tbl = el('table', { className: 'dr-compact-table', style: 'width:100%' });
      tbl.appendChild(el('thead', {}, el('tr', {},
        el('th', {}, 'When'), el('th', {}, 'Entity'), el('th', {}, 'Outcome'),
        el('th', {}, 'Model'), el('th', {}, ''))));
      const tb = el('tbody');
      recent.slice(0, 40).forEach(r => {
        const tr = el('tr', {},
          el('td', {}, formatDateTime(r.created_at)),
          el('td', {}, r.entity_type || '—'),
          el('td', {}, el('span', { className: 'badge' }, (r.outcome || '').replace(/_/g, ' '))),
          el('td', {}, r.model || '—'));
        const btn = el('button', { className: 'btn btn-sm' }, 'Save as best practice');
        btn.addEventListener('click', () => prefillFromCorrection(r));
        tr.appendChild(el('td', {}, btn));
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      learnBody.appendChild(tbl);
    }
  } catch (err) {
    learnBody.appendChild(el('p', { style: 'color:var(--danger)' }, 'Failed to load feedback: ' + err.message));
  }

  await loadList();
}

function stat(label, value) {
  return el('div', {},
    el('div', { style: 'font-size:22px;font-weight:700' }, String(value)),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, label));
}
