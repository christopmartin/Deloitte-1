/**
 * modules/cost_projections.js — Agentic Cost Projections (Phase 4)
 *
 * Read-only view of computed Now Assist costs for the current project, drilling
 * Agent → Workflow → Step → Skill with the $/period and the formula visible.
 * Also hosts the "Generate Bindings with AI" trigger (moved off the UC card).
 */
import { apiFetch, el, showToast, escHtml, getCurrentProjectId } from '../app.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtMoney(val) {
  if (val == null || isNaN(val)) return '—';
  const n = Number(val);
  if (n === 0) return '$0';
  if (n < 1)   return '$' + n.toFixed(4);
  if (n < 100) return '$' + n.toFixed(2);
  return '$' + Math.round(n).toLocaleString();
}

function fmtPct(val) {
  if (val == null || isNaN(val)) return '—';
  return (Number(val) * 100).toFixed(0) + '%';
}

// Convert ServiceNow planning_period name → a unit noun for "per X" labels.
function periodNoun(planningPeriod) {
  const map = { Weekly: 'week', Monthly: 'month', Quarterly: 'quarter', Annual: 'year' };
  return map[planningPeriod] || 'period';
}

// Cost of a single binding given runs_per_period and cost_per_assist.
function bindingCost(b, runsPerPeriod, costPerAssist) {
  return Number(b.qty_per_run) *
    (b.branch_probability == null ? 1 : Number(b.branch_probability)) *
    Number(b.assists_per_unit) *
    runsPerPeriod *
    costPerAssist;
}

// ─── Main render ────────────────────────────────────────────────────────────

export async function render(container) {
  container.innerHTML = '';
  const pid = getCurrentProjectId();

  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'Costs'),
    el('p', { className: 'purpose-text' },
      'Projected ServiceNow Now Assist costs for the current project. Costs are computed automatically ' +
      'from skill bindings on workflow steps. Use "Generate Bindings with AI" to have Claude infer the ' +
      'right Now Assist skills from your workflow design.')
  ));

  if (!pid) {
    container.appendChild(el('div', { className: 'empty-state' },
      el('p', {}, 'Select a project to view cost projections.')));
    return;
  }

  // ── Toolbar (header band) ─────────────────────────────────────────────────
  const toolbar = el('div', { className: 'panel', style: 'margin-bottom:16px' });
  const toolbarBody = el('div', { className: 'panel-body',
    style: 'display:flex;align-items:center;gap:16px;flex-wrap:wrap' });
  toolbar.appendChild(toolbarBody);
  container.appendChild(toolbar);

  const totalsBox = el('div', { style: 'display:flex;gap:24px;flex:1;flex-wrap:wrap' });
  toolbarBody.appendChild(totalsBox);

  const genBtn = el('button', { className: 'btn btn-primary', title:
    'Use Claude AI to infer which Now Assist skills each workflow step invokes, ' +
    'and write the bindings into the project.' }, '🤖 Generate Bindings with AI');
  toolbarBody.appendChild(genBtn);

  genBtn.addEventListener('click', async () => {
    genBtn.disabled = true;
    genBtn.textContent = '⏳ Generating…';
    try {
      const result = await apiFetch(`/projects/${pid}/cost-estimate`, { method: 'POST' });
      if (result.status === 'unavailable') {
        showToast('AI estimation unavailable — ' + result.message, 'warn');
      } else {
        showToast(`Bindings generated — ${result.bindings_created} row(s) written`, 'success');
        loadAndRender();
      }
    } catch (err) {
      showToast('Generation failed: ' + err.message, 'error');
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = '🤖 Generate Bindings with AI';
    }
  });

  // ── Application cost params (per-Application planning + entitlement) ─────
  const appParamsPanel = el('div', { className: 'panel', style: 'margin-bottom:16px' });
  const appParamsHeader = el('div', { className: 'panel-header' },
    el('h3', { className: 'panel-title' }, 'Application Cost Parameters'),
    el('span', { className: 'badge badge-info', style: 'margin-left:8px' }, 'Per-application'));
  appParamsPanel.appendChild(appParamsHeader);
  const appParamsBody = el('div', { className: 'panel-body' });
  appParamsBody.appendChild(el('p', { style: 'margin:0 0 10px 0;color:var(--text-muted);font-size:12px' },
    'Planning cadence and entitlement for this application. Global vendor pricing ' +
    '(cost per assist, overage rate) is set under Cost Management.'));
  appParamsPanel.appendChild(appParamsBody);
  container.appendChild(appParamsPanel);

  // ── Assumption row ────────────────────────────────────────────────────────
  const assumpRow = el('div', { className: 'panel', style: 'margin-bottom:16px' });
  const assumpBody = el('div', { className: 'panel-body',
    style: 'display:flex;gap:24px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--text-muted)' });
  assumpRow.appendChild(assumpBody);
  container.appendChild(assumpRow);

  // ── Breakdown panel ───────────────────────────────────────────────────────
  const breakdownPanel = el('div', { className: 'panel' });
  const breakdownHeader = el('div', { className: 'panel-header' },
    el('h3', { className: 'panel-title' }, 'Cost Breakdown'));
  breakdownPanel.appendChild(breakdownHeader);
  const breakdownBody = el('div', { className: 'panel-body' });
  breakdownPanel.appendChild(breakdownBody);
  container.appendChild(breakdownPanel);

  // ── Data load + render ────────────────────────────────────────────────────
  async function loadAndRender() {
    totalsBox.innerHTML = '<span style="color:var(--text-muted)">Loading…</span>';
    assumpBody.innerHTML = '';
    breakdownBody.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading projections…</span></div>';

    let costParams, useCases, workflows, agents;
    try {
      [costParams, useCases, workflows, agents] = await Promise.all([
        apiFetch(`/projects/${pid}/cost-params`),      // per-app pricing + planning + entitlement
        apiFetch(`/projects/${pid}/design-report/use-cases`),
        apiFetch(`/projects/${pid}/design-report/workflows`),
        apiFetch(`/projects/${pid}/design-report/agents`),
      ]);
    } catch (err) {
      breakdownBody.innerHTML = '';
      breakdownBody.appendChild(el('p', { style: 'color:var(--danger)' },
        'Failed to load cost data: ' + err.message));
      return;
    }
    // /cost-params now returns all 7 cost fields for this Application.
    const assumption = {
      cost_per_assist:           costParams.cost_per_assist,
      overage_rate:              costParams.overage_rate,
      cost_per_assist_expansion: costParams.cost_per_assist_expansion,
      planning_period:           costParams.planning_period,
      periods_per_year:          costParams.periods_per_year,
      entitlement_enabled:       costParams.entitlement_enabled,
      annual_included_assists:   costParams.annual_included_assists,
    };

    // Render the editable per-app cost params form
    renderAppParamsForm(appParamsBody, pid, costParams, loadAndRender);

    const ucs = useCases.use_cases || [];
    const wfs = workflows.workflows || [];
    const ags = agents.agents     || [];
    const costPerAssist = Number(assumption.cost_per_assist);
    const periods = Number(assumption.periods_per_year) || 12;
    const unitNoun = periodNoun(assumption.planning_period);

    // ── Aggregate by agent (and compute per-bucket subtotals from bindings) ─
    // For each agent, walk its participants → owned steps → bindings.
    // For workflows with no owning agent, lump under "Non-Agentic Costs".
    // The bucket subtotal is computed from the bindings that actually fall in
    // this bucket — NOT from wf.workflow_cost_per_period (which is the WHOLE
    // workflow). Same applies to the per-WF row inside each bucket.
    const agentMap = new Map();
    ags.forEach(a => agentMap.set(a.agent_spec_id, {
      agent: a,
      monthly_cost: 0,                // computed from bindings below
      cost_model:   a.cost_model,
      workflows:    new Map(),        // wf_id → { wf, steps: [], monthly_cost: 0 }
    }));

    const nonAgentic = { workflows: new Map(), monthly_cost: 0 };

    wfs.forEach(wf => {
      const wfRunsPerPeriod = Number(wf.runs_per_period) || 0;
      (wf.steps || []).forEach(step => {
        const ownerParticipantId = step.owner_participant_id;
        let ownerAgentId = null;
        if (ownerParticipantId) {
          const part = (wf.participants || []).find(p => p.workflow_participant_id === ownerParticipantId);
          if (part) ownerAgentId = part.agent_spec_id || null;
        }
        const bucket = ownerAgentId && agentMap.has(ownerAgentId)
          ? agentMap.get(ownerAgentId)
          : nonAgentic;

        if (!bucket.workflows.has(wf.workflow_id)) {
          bucket.workflows.set(wf.workflow_id, { wf, steps: [], monthly_cost: 0 });
        }
        const wfRow = bucket.workflows.get(wf.workflow_id);
        const bindings = step.cost_bindings || [];
        if (bindings.length === 0) return;
        const stepBucketCost = bindings.reduce(
          (s, b) => s + bindingCost(b, wfRunsPerPeriod, costPerAssist), 0);
        wfRow.steps.push({ step, bindings, wfRunsPerPeriod });
        wfRow.monthly_cost  += stepBucketCost;
        bucket.monthly_cost += stepBucketCost;
      });
    });

    const agenticTotal    = [...agentMap.values()].reduce((s, b) => s + b.monthly_cost, 0);
    const nonAgenticTotal = nonAgentic.monthly_cost;
    const monthly         = agenticTotal + nonAgenticTotal;
    const annual          = monthly * periods;
    const baseline        = ucs.reduce((s, u) => s + (Number(u.baseline_cost_annual_usd) || 0), 0);
    const roi             = baseline > 0 && annual > 0 ? baseline / annual : null;

    // ── Totals header ───────────────────────────────────────────────────────
    totalsBox.innerHTML = '';
    totalsBox.appendChild(metricBlock(
      'Projected / ' + unitNoun, fmtMoney(monthly), 'var(--info-text,#1565c0)',
      // Subline shows Agentic / Non-Agentic split when both are present
      (nonAgenticTotal > 0 && agenticTotal > 0)
        ? `Agentic ${fmtMoney(agenticTotal)} · Non-Agentic ${fmtMoney(nonAgenticTotal)}`
        : (agenticTotal > 0 ? 'Agentic only' : (nonAgenticTotal > 0 ? 'Non-Agentic only' : null))
    ));
    totalsBox.appendChild(metricBlock('Projected / year', fmtMoney(annual), 'var(--info-text,#1565c0)'));
    if (baseline > 0) {
      const annualSavings = baseline - annual;
      const savingsPct    = annualSavings / baseline;
      totalsBox.appendChild(metricBlock('Baseline / year', fmtMoney(baseline), 'var(--text-muted)'));
      // Phase 5 ROI polish: show savings dollars + percent alongside the ratio.
      if (annualSavings > 0) {
        totalsBox.appendChild(metricBlock(
          'Savings / year',
          fmtMoney(annualSavings),
          'var(--success-text,#2e7d32)',
          fmtPct(savingsPct) + ' of baseline'
        ));
      }
    }
    if (roi != null) {
      totalsBox.appendChild(metricBlock(
        'ROI ratio',
        '~' + roi.toFixed(2) + '×',
        'var(--success-text,#2e7d32)',
        'baseline ÷ projected annual'
      ));
    }

    assumpBody.innerHTML = '';
    assumpBody.appendChild(el('span', {}, el('strong', {}, 'Cost per assist: '),
      '$' + Number(assumption.cost_per_assist).toFixed(4)));
    assumpBody.appendChild(el('span', {}, el('strong', {}, 'Planning period: '),
      assumption.planning_period + ' (' + periods + ' / yr)'));
    assumpBody.appendChild(el('span', {}, el('strong', {}, 'Formula: '),
      el('code', {}, 'qty × branch_prob × assists_per_unit × runs_per_period × cost_per_assist')));

    // ── Render breakdown ────────────────────────────────────────────────────
    breakdownBody.innerHTML = '';
    const ctx = { pid, assumption, reload: loadAndRender, unitNoun };
    const orderedAgents = [...agentMap.values()].sort((a, b) => b.monthly_cost - a.monthly_cost);
    let renderedSomething = false;
    orderedAgents.forEach(bucket => {
      if (bucket.workflows.size === 0) return;
      breakdownBody.appendChild(renderAgentBlock(bucket, ctx));
      renderedSomething = true;
    });
    if (nonAgentic.workflows.size > 0) {
      breakdownBody.appendChild(renderNonAgenticBlock(nonAgentic, ctx));
      renderedSomething = true;
    }
    if (!renderedSomething) {
      breakdownBody.appendChild(el('div', { className: 'empty-state' },
        el('p', {}, 'No cost bindings yet for this project.'),
        el('p', { style: 'color:var(--text-muted);font-size:12px' },
          'Click "🤖 Generate Bindings with AI" above to have Claude infer skills from your design, ' +
          'or add bindings manually via the workflow step editor.')));
    }
  }

  await loadAndRender();
}

// ─── Component renderers ────────────────────────────────────────────────────

function metricBlock(label, value, color, subline) {
  const block = el('div', { style: 'display:flex;flex-direction:column;min-width:140px' },
    el('span', { style: 'font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px' }, label),
    el('span', { style: 'font-size:22px;font-weight:600;color:' + (color || 'var(--text)') }, value));
  if (subline) {
    block.appendChild(el('span', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' }, subline));
  }
  return block;
}

function renderAgentBlock(bucket, ctx) {
  const assumption = ctx.assumption;
  const a = bucket.agent;
  const wrap = el('div', { style: 'margin-bottom:24px;border:1px solid var(--border);border-radius:6px' });

  const hdr = el('div', { style:
    'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;' +
    'background:var(--surface-secondary,#f5f7fa);border-bottom:1px solid var(--border);border-radius:6px 6px 0 0' });
  hdr.appendChild(el('div', {},
    el('span', { style: 'font-family:monospace;font-size:11px;color:var(--text-muted);margin-right:8px' },
      a.slug || ''),
    el('strong', {}, a.name || 'Unnamed agent'),
    el('span', { className: 'tag', style:
      'margin-left:10px;font-size:10px;background:' +
      (a.cost_model === 'servicenow_now_assist' ? 'var(--info-bg,#e8f4fd)' : 'var(--surface)') +
      ';color:var(--text-muted)' },
      'cost_model: ' + (a.cost_model || 'none'))
  ));
  hdr.appendChild(el('div', { style: 'font-size:18px;font-weight:600;color:var(--info-text,#1565c0)' },
    fmtMoney(bucket.monthly_cost) + ' / ' + ctx.unitNoun));
  wrap.appendChild(hdr);

  const body = el('div', { style: 'padding:0' });
  [...bucket.workflows.values()].forEach(wfRow => {
    body.appendChild(renderWorkflowBlock(wfRow, ctx));
  });
  wrap.appendChild(body);
  return wrap;
}

function renderNonAgenticBlock(bucket, ctx) {
  const wrap = el('div', { style: 'margin-bottom:24px;border:1px dashed var(--border);border-radius:6px' });
  const hdr = el('div', { style:
    'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;' +
    'background:var(--surface-secondary,#f5f7fa);border-bottom:1px solid var(--border);border-radius:6px 6px 0 0' });
  hdr.appendChild(el('div', {},
    el('strong', {}, 'Non-Agentic Costs'),
    el('span', { style: 'font-size:12px;color:var(--text-muted);margin-left:8px' },
      'Now Assist skills consumed outside an agent (embedded panels, standalone skills, etc.)')
  ));
  hdr.appendChild(el('div', { style: 'font-size:18px;font-weight:600;color:var(--text)' },
    fmtMoney(bucket.monthly_cost) + ' / ' + ctx.unitNoun));
  wrap.appendChild(hdr);
  const body = el('div', { style: 'padding:0' });
  [...bucket.workflows.values()].forEach(wfRow => {
    body.appendChild(renderWorkflowBlock(wfRow, ctx));
  });
  wrap.appendChild(body);
  return wrap;
}

function renderWorkflowBlock(wfRow, ctx) {
  const wf = wfRow.wf;
  const runs = Number(wf.runs_per_period) || 0;

  const wfHdr = el('div', { style:
    'padding:8px 14px;background:var(--surface);border-top:1px solid var(--border);' +
    'display:flex;align-items:center;justify-content:space-between' });
  wfHdr.appendChild(el('div', {},
    el('span', { style: 'font-family:monospace;font-size:11px;color:var(--text-muted);margin-right:8px' },
      wf.slug || ''),
    el('strong', { style: 'font-size:13px' }, wf.name || ''),
    el('span', { style: 'font-size:11px;color:var(--text-muted);margin-left:8px' },
      runs > 0 ? `(${runs.toLocaleString()} runs / ${ctx.unitNoun})` :
                 '(no runs_per_period set — costs will be $0)')
  ));
  // Subtotal of bindings in THIS bucket's slice of the workflow (not the whole WF cost).
  wfHdr.appendChild(el('div', { style: 'font-size:13px;font-weight:600' },
    fmtMoney(wfRow.monthly_cost)));

  const wrap = el('div', {});
  wrap.appendChild(wfHdr);

  if (wfRow.steps.length === 0) {
    wrap.appendChild(el('div', { style: 'padding:8px 14px;font-size:12px;color:var(--text-muted)' },
      'No skill bindings on any step.'));
    return wrap;
  }

  // Skill rows table
  const tbl = el('table', { className: 'dr-compact-table', style: 'width:100%;font-size:12px' });
  const thead = el('thead');
  thead.appendChild(el('tr', {},
    el('th', { style: 'width:60px' }, 'Step'),
    el('th', {},                       'Step Name'),
    el('th', {},                       'Skill'),
    el('th', { style: 'text-align:right;width:60px' },  'Qty'),
    el('th', { style: 'text-align:right;width:90px', title: 'Editable — % of runs that invoke this skill. Blank = 100%.' }, 'Branch % ✎'),
    el('th', { style: 'text-align:right;width:90px' },  'Assists/Unit'),
    el('th', { style: 'text-align:right;width:80px' },  'Assists/Run'),
    el('th', { style: 'text-align:right;width:90px' },  '$ / ' + ctx.unitNoun),
    el('th', { style: 'width:40px' }, '')
  ));
  tbl.appendChild(thead);
  const tbody = el('tbody');

  const costPerAssist = Number(ctx.assumption.cost_per_assist);
  const stepRowsSorted = [...wfRow.steps].sort((a, b) =>
    (b.step.step_cost_per_period || 0) - (a.step.step_cost_per_period || 0));

  stepRowsSorted.forEach(({ step, bindings, wfRunsPerPeriod }) => {
    bindings
      .slice()
      .sort((x, y) => bindingCost(y, wfRunsPerPeriod, costPerAssist) - bindingCost(x, wfRunsPerPeriod, costPerAssist))
      .forEach((b, idx) => {
        const tr = el('tr');
        if (idx === 0) {
          tr.appendChild(el('td', { style: 'font-family:monospace;font-size:11px' }, String(step.step_number || '')));
          tr.appendChild(el('td', {}, step.name || ''));
        } else {
          tr.appendChild(el('td', {}, ''));
          tr.appendChild(el('td', { style: 'color:var(--text-muted);font-size:11px' }, '↳'));
        }
        const skillTd = el('td', {});
        skillTd.appendChild(el('span', {}, b.skill_name));
        if (b.ai_generated) {
          skillTd.appendChild(el('span', { className: 'tag',
            style: 'margin-left:6px;font-size:9px;background:var(--accent-bg,#fff3e0);color:var(--accent-text,#e65100)' },
            'AI'));
        }
        tr.appendChild(skillTd);
        tr.appendChild(el('td', { style: 'text-align:right;font-family:monospace' },
          Number(b.qty_per_run).toString()));
        tr.appendChild(renderBranchPctCell(b, step, ctx));
        tr.appendChild(el('td', { style: 'text-align:right;font-family:monospace' },
          Number(b.assists_per_unit).toString()));
        const assistsPerRun = Number(b.qty_per_run) *
          (b.branch_probability == null ? 1 : Number(b.branch_probability)) *
          Number(b.assists_per_unit);
        tr.appendChild(el('td', { style: 'text-align:right;font-family:monospace' },
          assistsPerRun.toFixed(2)));
        tr.appendChild(el('td', { style: 'text-align:right;font-family:monospace;font-weight:600' },
          fmtMoney(bindingCost(b, wfRunsPerPeriod, costPerAssist))));
        const reasonTd = el('td', { style: 'text-align:center' });
        if (b.ai_reasoning) {
          reasonTd.appendChild(Object.assign(el('span', { title: b.ai_reasoning,
            style: 'cursor:help;color:var(--text-muted)' }, 'ⓘ')));
        }
        tr.appendChild(reasonTd);
        tbody.appendChild(tr);
      });
  });

  tbl.appendChild(tbody);
  wrap.appendChild(el('div', { style: 'padding:6px 14px 14px' }, tbl));
  return wrap;
}

// Inline-editable Branch % cell. This is the one cost-binding field that is a
// usage assumption (not a design fact), so it lives here in the Costs module
// rather than on the workflow step. Saves to PUT /projects/:id/steps/:stepId/cost-bindings/:bid.
function renderBranchPctCell(b, step, ctx) {
  const td = el('td', { style: 'text-align:right;font-family:monospace;padding:2px 4px' });
  const initial = b.branch_probability == null ? 100 : Math.round(Number(b.branch_probability) * 100);

  const input = el('input', {
    type: 'number', min: '0', max: '100', step: '1',
    value: String(initial),
    title: 'Edit branch %. Blank = 100%.',
    style: 'width:60px;text-align:right;font-family:monospace;font-size:12px;' +
           'padding:2px 4px;border:1px solid var(--border);border-radius:3px;background:var(--surface)'
  });

  let saving = false;
  const commit = async () => {
    if (saving) return;
    const raw = input.value.trim();
    const pct = raw === '' ? 100 : Math.max(0, Math.min(100, Number(raw)));
    if (!Number.isFinite(pct)) { input.value = String(initial); return; }
    const newProb = pct >= 100 ? null : pct / 100;       // store null for 100% (matches "always invoked" semantics)
    const curProb = b.branch_probability;
    const sameAsCurrent =
      (curProb == null && newProb == null) ||
      (curProb != null && newProb != null && Math.abs(curProb - newProb) < 1e-6);
    if (sameAsCurrent) { input.value = String(pct); return; }

    saving = true;
    input.disabled = true;
    try {
      await apiFetch(`/projects/${ctx.pid}/steps/${step.workflow_step_id}/cost-bindings/${b.binding_id}`, {
        method: 'PUT',
        body: JSON.stringify({ branch_probability: newProb }),
      });
      showToast(`Branch % updated to ${pct}% — recomputing`, 'success');
      ctx.reload();
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
      input.value = String(initial);
    } finally {
      saving = false;
      input.disabled = false;
    }
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { input.value = String(initial); input.blur(); }
  });

  td.appendChild(input);
  return td;
}

// ─── Per-application cost params form ───────────────────────────────────────
// Renders an editable grid of all 7 cost fields for the current application:
// pricing (cost_per_assist, overage_rate, cost_per_assist_expansion),
// planning (planning_period, periods_per_year),
// entitlement (entitlement_enabled, annual_included_assists).
// Save calls PUT /projects/:id/cost-params and triggers a full reload so totals refresh.
function renderAppParamsForm(container, pid, params, reload) {
  container.querySelectorAll('._cpForm, ._cpFormSection').forEach(n => n.remove());

  // ── Pricing section ────────────────────────────────────────────────────
  const pricingHdr = el('div', { className: '_cpFormSection',
    style: 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-top:4px' },
    'Pricing (per-Application contract)');
  container.appendChild(pricingHdr);

  const pricingGrid = el('div', { className: '_cpForm',
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;align-items:end;margin-top:6px;margin-bottom:12px' });

  // cost_per_assist
  const cpaGrp = el('div', { className: 'form-group' });
  cpaGrp.appendChild(el('label', { className: 'form-label' }, 'Cost per Assist (USD)'));
  const cpaInput = el('input', { type: 'number', className: 'form-input', min: '0', step: '0.001',
    value: params.cost_per_assist ?? 0.015 });
  cpaGrp.appendChild(cpaInput);
  cpaGrp.appendChild(el('small', { style: 'color:var(--text-muted)' }, 'Negotiated rate · e.g. $0.015 = 1.5¢/assist'));
  pricingGrid.appendChild(cpaGrp);

  // overage_rate
  const orGrp = el('div', { className: 'form-group' });
  orGrp.appendChild(el('label', { className: 'form-label' }, 'Overage Rate (USD/assist)'));
  const orInput = el('input', { type: 'number', className: 'form-input', min: '0', step: '0.001',
    value: params.overage_rate ?? '' });
  orGrp.appendChild(orInput);
  orGrp.appendChild(el('small', { style: 'color:var(--text-muted)' }, 'Price for assists above the entitlement'));
  pricingGrid.appendChild(orGrp);

  // cost_per_assist_expansion
  const xpaGrp = el('div', { className: 'form-group' });
  xpaGrp.appendChild(el('label', { className: 'form-label' }, 'Expansion Pack Cost per Assist (USD)'));
  const xpaInput = el('input', { type: 'number', className: 'form-input', min: '0', step: '0.001',
    value: params.cost_per_assist_expansion ?? '' });
  xpaGrp.appendChild(xpaInput);
  xpaGrp.appendChild(el('small', { style: 'color:var(--text-muted)' }, 'Stored for future use · not yet in calcs'));
  pricingGrid.appendChild(xpaGrp);

  container.appendChild(pricingGrid);

  // ── Planning + Entitlement section ─────────────────────────────────────
  const planHdr = el('div', { className: '_cpFormSection',
    style: 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-top:8px' },
    'Planning & Entitlement');
  container.appendChild(planHdr);

  const form = el('div', { className: '_cpForm',
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;align-items:end;margin-top:6px' });

  // planning_period
  const ppGrp = el('div', { className: 'form-group' });
  ppGrp.appendChild(el('label', { className: 'form-label' }, 'Planning Period'));
  const ppSelect = el('select', { className: 'form-input' });
  ['Weekly', 'Monthly', 'Quarterly', 'Annual'].forEach(p => {
    const opt = el('option', { value: p }, p);
    if (p === (params.planning_period || 'Monthly')) opt.selected = true;
    ppSelect.appendChild(opt);
  });
  ppGrp.appendChild(ppSelect);
  form.appendChild(ppGrp);

  // periods_per_year
  const ppyGrp = el('div', { className: 'form-group' });
  ppyGrp.appendChild(el('label', { className: 'form-label' }, 'Periods per Year'));
  const ppyInput = el('input', { type: 'number', className: 'form-input', min: '1', step: '1',
    value: params.periods_per_year ?? 12 });
  ppyGrp.appendChild(ppyInput);
  form.appendChild(ppyGrp);

  // entitlement toggle
  const entGrp = el('div', { className: 'form-group' });
  entGrp.appendChild(el('label', { className: 'form-label' }, 'Entitlement'));
  const entToggle = el('input', { type: 'checkbox' });
  entToggle.checked = !!params.entitlement_enabled;
  entGrp.appendChild(el('label', { style: 'display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 0' },
    entToggle, el('span', {}, 'Track annual included assists')));
  form.appendChild(entGrp);

  // annual_included_assists
  const aiaGrp = el('div', { className: 'form-group',
    style: `display:${entToggle.checked ? 'block' : 'none'}` });
  aiaGrp.appendChild(el('label', { className: 'form-label' }, 'Annual Included Assists'));
  const aiaInput = el('input', { type: 'number', className: 'form-input', min: '0',
    value: params.annual_included_assists ?? '' });
  aiaGrp.appendChild(aiaInput);
  form.appendChild(aiaGrp);

  entToggle.addEventListener('change', () => {
    aiaGrp.style.display = entToggle.checked ? 'block' : 'none';
  });

  // Save button
  const saveGrp = el('div', { className: 'form-group' });
  const saveBtn = el('button', { className: 'btn btn-primary' }, 'Save App Params');
  saveGrp.appendChild(saveBtn);
  form.appendChild(saveGrp);

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const payload = {
        // Pricing
        cost_per_assist:           parseFloat(cpaInput.value) || 0.015,
        overage_rate:              orInput.value  !== '' ? parseFloat(orInput.value)  : null,
        cost_per_assist_expansion: xpaInput.value !== '' ? parseFloat(xpaInput.value) : null,
        // Planning + entitlement
        planning_period:         ppSelect.value,
        periods_per_year:        parseFloat(ppyInput.value) || 12,
        entitlement_enabled:     entToggle.checked ? 1 : 0,
        annual_included_assists: entToggle.checked && aiaInput.value !== ''
          ? parseFloat(aiaInput.value) : null,
      };
      await apiFetch(`/projects/${pid}/cost-params`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showToast('Application cost parameters saved', 'success');
      reload();
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save App Params';
    }
  });

  container.appendChild(form);
}
