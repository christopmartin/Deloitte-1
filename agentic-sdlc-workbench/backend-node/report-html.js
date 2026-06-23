// report-html.js — Unified Design Review Report generator
// Returns a self-contained HTML string. Open in a browser and File→Print→Save as PDF.
'use strict';

// ── Utilities ────────────────────────────────────────────────────────────────

function safeJson(val, fallback) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function badge(text, cls) {
  if (!text) return '';
  return `<span class="badge badge-${esc(cls)}">${esc(text)}</span>`;
}

function renderList(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '—';
  return `<ul>${arr.map(i => `<li>${esc(String(i))}</li>`).join('')}</ul>`;
}

function jsonDisplay(val) {
  const v = safeJson(val, null);
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) {
    if (v.length === 0) return '—';
    // Array of objects → small table; array of strings → list
    if (typeof v[0] === 'object' && v[0] !== null) {
      const keys = Object.keys(v[0]);
      const rows = v.map(row =>
        `<tr>${keys.map(k => `<td>${esc(String(row[k] ?? ''))}</td>`).join('')}</tr>`
      ).join('');
      return `<table class="data-table mini-table"><thead><tr>${keys.map(k => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    return `<ul>${v.map(i => `<li>${esc(String(i))}</li>`).join('')}</ul>`;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v).filter(([, val]) => val !== null && val !== undefined && val !== '');
    if (entries.length === 0) return '—';
    return `<dl class="kv-list">${entries.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(String(val))}</dd>`).join('')}</dl>`;
  }
  return esc(String(v));
}

function labeledField(label, html) {
  if (!html || html === '—' || html === '') return '';
  return `<div class="field-row"><span class="field-label">${esc(label)}</span><div class="field-value">${html}</div></div>`;
}

function emptySection(title) {
  return `<p class="empty-note"><em>No ${esc(title.toLowerCase())} defined.</em></p>`;
}

function sectionOpen(n, title) {
  return `<div class="section" id="s${n}"><h2 class="section-title">${esc(title)}</h2>`;
}

function sectionClose() {
  return `</div>`;
}

function supervisionClass(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('autonomous')) return 'supervision-autonomous';
  if (m.includes('supervised') || m.includes('hitl')) return 'supervision-supervised';
  if (m.includes('advisory')) return 'supervision-advisory';
  return 'supervision-default';
}

function riskClass(tier) {
  const t = (tier || '').toLowerCase();
  if (t === 'high') return 'risk-high';
  if (t === 'medium' || t === 'med') return 'risk-medium';
  if (t === 'low') return 'risk-low';
  return 'risk-default';
}

function severityClass(sev) {
  const s = (sev || '').toLowerCase();
  if (s === 'high' || s === 'critical') return 'risk-high';
  if (s === 'medium' || s === 'med') return 'risk-medium';
  if (s === 'low') return 'risk-low';
  return 'risk-default';
}

function statusClass(status) {
  const s = (status || '').toLowerCase();
  if (s === 'approved' || s === 'pass' || s === 'active') return 'status-approved';
  if (s === 'draft') return 'status-draft';
  if (s === 'review' || s === 'in_review' || s === 'under_review') return 'status-review';
  if (s === 'fail' || s === 'rejected') return 'status-fail';
  return 'status-default';
}

function fmtCurrency(num) {
  if (num === null || num === undefined || isNaN(num)) return '—';
  return '$' + Number(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtNum(num) {
  if (num === null || num === undefined || isNaN(num)) return '—';
  return Number(num).toLocaleString('en-US');
}

// ── Data Gathering ───────────────────────────────────────────────────────────

function gatherData(db, projectId) {
  const project = db.prepare(`
    SELECT p.*, c.client_name
    FROM asdlc_project p
    LEFT JOIN asdlc_client c ON c.client_id = p.client_id
    WHERE p.project_id = ?
  `).get(projectId);

  if (!project) return null;

  // Cost params (mirrors getEffectiveCostParams in server.js)
  const globalRow = db.prepare(`SELECT cost_per_assist FROM asdlc_cost_assumption LIMIT 1`).get() || {};
  const costPerAssist = project.cost_per_assist ?? globalRow.cost_per_assist ?? 0.015;
  const planningPeriod = project.planning_period ?? 'Monthly';
  const periodsPerYear = project.periods_per_year ?? 12;

  // Use Cases
  const useCases = db.prepare(`
    SELECT * FROM asdlc_use_case
    WHERE project_id = ? AND lifecycle_status != 'deleted'
    ORDER BY title
  `).all(projectId).map(uc => ({
    ...uc,
    success_criteria:  safeJson(uc.success_criteria, []),
    constraints_list:  safeJson(uc.constraints_list, []),
    volume_assumptions: safeJson(uc.volume_assumptions, {}),
  }));

  // Workflows + steps + HITL gates
  const workflowRows = db.prepare(`
    SELECT * FROM asdlc_workflow
    WHERE project_id = ? AND lifecycle_status != 'deleted'
    ORDER BY name
  `).all(projectId);

  const stepsStmt  = db.prepare(`SELECT * FROM asdlc_workflow_step WHERE workflow_id = ? ORDER BY step_number`);
  const hitlStmt   = db.prepare(`SELECT * FROM asdlc_hitl_gate WHERE workflow_id = ?`);
  const ucForWfStmt = db.prepare(`SELECT use_case_id, slug, title FROM asdlc_use_case WHERE use_case_id = ?`);

  const workflows = workflowRows.map(wf => {
    const steps = stepsStmt.all(wf.workflow_id).map(s => ({
      ...s,
      decisions: safeJson(s.decisions_list, []),
      inputs:    safeJson(s.inputs, {}),
      outputs:   safeJson(s.outputs, {}),
    }));
    const hitlGates = hitlStmt.all(wf.workflow_id);
    const useCase = wf.use_case_id ? ucForWfStmt.get(wf.use_case_id) : null;
    return {
      ...wf,
      trigger:  safeJson(wf.trigger_def, {}),
      handoffs: safeJson(wf.handoffs, []),
      steps,
      hitlGates,
      useCase,
    };
  });

  // Agents + tool bindings + linked use cases
  const agentRows = db.prepare(`
    SELECT * FROM asdlc_agent_spec
    WHERE project_id = ? AND lifecycle_status != 'deleted'
    ORDER BY name
  `).all(projectId);

  const ucLinksStmt = db.prepare(`
    SELECT auc.business_value, auc.notes, uc.use_case_id, uc.slug, uc.title
    FROM asdlc_agent_use_case auc
    JOIN asdlc_use_case uc ON uc.use_case_id = auc.use_case_id
    WHERE auc.agent_spec_id = ?
    ORDER BY auc.created_at
  `);
  const toolBindingsStmt = db.prepare(`
    SELECT at.purpose, at.binding_supervision_model, at.tool_execution_mode, at.details,
           t.name AS tool_name, t.slug AS tool_slug, t.dev_status, t.execution_mode
    FROM asdlc_agent_tool at
    JOIN asdlc_tool t ON t.tool_id = at.tool_id
    WHERE at.agent_spec_id = ?
    ORDER BY t.name
  `);

  const agents = agentRows.map(ag => ({
    ...ag,
    goals:         safeJson(ag.goals, []),
    done_criteria: safeJson(ag.done_criteria, []),
    design_risks:  safeJson(ag.design_risks, []),
    inputs:        safeJson(ag.inputs, {}),
    outputs:       safeJson(ag.outputs, {}),
    run_as_model:  safeJson(ag.run_as_model, {}),
    ucLinks:       ucLinksStmt.all(ag.agent_spec_id),
    toolBindings:  toolBindingsStmt.all(ag.agent_spec_id),
  }));

  // Tools
  const tools = db.prepare(`
    SELECT * FROM asdlc_tool
    WHERE project_id = ? AND lifecycle_status = 'active'
    ORDER BY name
  `).all(projectId).map(t => ({
    ...t,
    contract:            safeJson(t.contract, {}),
    inputs:              safeJson(t.inputs, {}),
    outputs:             safeJson(t.outputs, {}),
    errors:              safeJson(t.errors, []),
    access_requirements: safeJson(t.access_requirements, {}),
    boundaries:          safeJson(t.boundaries, []),
  }));

  // Data Models + linked Forms + Business Logic
  const dmRows = db.prepare(`
    SELECT * FROM asdlc_data_model
    WHERE project_id = ? AND lifecycle_status != 'deleted'
    ORDER BY name
  `).all(projectId);

  const formsByDMStmt  = db.prepare(`SELECT * FROM asdlc_form_design    WHERE data_model_id = ? AND lifecycle_status != 'deleted' ORDER BY name`);
  const logicByDMStmt  = db.prepare(`SELECT * FROM asdlc_business_logic WHERE data_model_id = ? AND lifecycle_status != 'deleted' ORDER BY name`);

  const dataModels = dmRows.map(dm => ({
    ...dm,
    fields:        safeJson(dm.fields, []),
    relationships: safeJson(dm.relationships, []),
    forms:         formsByDMStmt.all(dm.data_model_id).map(f => ({
      ...f,
      sections:         safeJson(f.sections, []),
      related_lists:    safeJson(f.related_lists, []),
      mandatory_fields: safeJson(f.mandatory_fields, []),
      readonly_fields:  safeJson(f.readonly_fields, []),
    })),
    logic: logicByDMStmt.all(dm.data_model_id).map(l => ({
      ...l,
      requirement_refs: safeJson(l.requirement_refs, []),
    })),
  }));

  // Catalog Items
  const catalogItems = db.prepare(`
    SELECT ci.*, wf.name AS workflow_name
    FROM asdlc_catalog_item ci
    LEFT JOIN asdlc_workflow wf ON ci.workflow_id = wf.workflow_id
    WHERE ci.project_id = ? AND ci.lifecycle_status != 'deleted'
    ORDER BY ci.name
  `).all(projectId).map(ci => ({
    ...ci,
    variables: safeJson(ci.variables, []),
  }));

  // Integrations
  const integrations = db.prepare(`
    SELECT * FROM asdlc_integration
    WHERE project_id = ? AND lifecycle_status != 'deleted'
    ORDER BY integration_type, name
  `).all(projectId).map(i => ({
    ...i,
    functions: safeJson(i.functions, []),
  }));

  // Functional + Non-Functional Requirements
  const frs = db.prepare(`
    SELECT fr.*, uc.slug AS use_case_slug, uc.title AS use_case_title
    FROM asdlc_functional_req fr
    LEFT JOIN asdlc_use_case uc ON fr.use_case_id = uc.use_case_id
    WHERE fr.project_id = ? AND fr.status != 'deleted'
    ORDER BY fr.slug ASC
  `).all(projectId).map(r => ({
    ...r,
    acceptance_criteria: safeJson(r.acceptance_criteria, []),
    dependencies:        safeJson(r.dependencies, []),
  }));

  const nfrs = db.prepare(`
    SELECT nfr.*, uc.slug AS use_case_slug, uc.title AS use_case_title
    FROM asdlc_nonfunctional_req nfr
    LEFT JOIN asdlc_use_case uc ON nfr.use_case_id = uc.use_case_id
    WHERE nfr.project_id = ? AND nfr.status != 'deleted'
    ORDER BY nfr.slug ASC
  `).all(projectId).map(r => ({
    ...r,
    dependencies: safeJson(r.dependencies, []),
  }));

  // Test Cases
  const testCases = db.prepare(`
    SELECT * FROM asdlc_test_case
    WHERE project_id = ? AND lifecycle_status != 'deleted'
    ORDER BY scope, slug, created_at
  `).all(projectId).map(tc => ({
    ...tc,
    requirement_ids: safeJson(tc.requirement_ids, []),
  }));

  // Per-agent cost projections (Now Assist costs for steps owned by each agent)
  const agentCostStmt = db.prepare(`
    SELECT b.qty_per_run, b.branch_probability, r.assists_per_unit, wf.runs_per_period
    FROM asdlc_workflow_step_cost_binding b
    JOIN asdlc_assist_rate_card r ON r.skill_name = b.skill_name
    JOIN asdlc_workflow_step s ON s.workflow_step_id = b.workflow_step_id
    JOIN asdlc_workflow wf ON wf.workflow_id = s.workflow_id
    JOIN asdlc_workflow_participant p ON p.workflow_participant_id = s.owner_participant_id
    WHERE p.agent_spec_id = ? AND wf.project_id = ?
  `);
  const agentCosts = agentRows.map(ag => {
    const rows = agentCostStmt.all(ag.agent_spec_id, projectId);
    const costPerPeriod = rows.reduce((sum, c) => {
      return sum + c.qty_per_run * (c.branch_probability ?? 1.0) * c.assists_per_unit * (c.runs_per_period || 0) * costPerAssist;
    }, 0);
    return { agent_spec_id: ag.agent_spec_id, slug: ag.slug, name: ag.name, cost_per_period: costPerPeriod };
  });

  // Now Assist projected costs per use case (mirrors build-export query in server.js)
  const nowAssistCosts = db.prepare(`
    SELECT uc.use_case_id, uc.slug, uc.title, uc.baseline_cost_annual_usd,
      COALESCE(SUM(
        b.qty_per_run * COALESCE(b.branch_probability, 1.0)
        * r.assists_per_unit * COALESCE(wf.runs_per_period, 0)
        * COALESCE(ap.cost_per_assist, ca.cost_per_assist, 0.015)
      ), 0) AS projected_per_period
    FROM asdlc_use_case uc
    LEFT JOIN asdlc_workflow wf
      ON wf.use_case_id = uc.use_case_id AND wf.lifecycle_status != 'deleted'
    LEFT JOIN asdlc_workflow_step s ON s.workflow_id = wf.workflow_id
    LEFT JOIN asdlc_workflow_step_cost_binding b ON b.workflow_step_id = s.workflow_step_id
    LEFT JOIN asdlc_assist_rate_card r ON r.skill_name = b.skill_name
    LEFT JOIN asdlc_project ap ON ap.project_id = uc.project_id
    LEFT JOIN asdlc_cost_assumption ca ON ca.cost_assumption_id = 'cost-assumption-global'
    WHERE uc.project_id = ? AND uc.lifecycle_status != 'deleted'
    GROUP BY uc.use_case_id ORDER BY uc.title
  `).all(projectId);

  // LLM usage (actual Claude API costs incurred by the workbench)
  const llmTotals = db.prepare(`
    SELECT COUNT(*) AS runs,
           COALESCE(SUM(input_tokens),0)  AS input_tokens,
           COALESCE(SUM(output_tokens),0) AS output_tokens,
           COALESCE(SUM(cost_usd),0)      AS cost_usd
    FROM asdlc_ai_usage WHERE project_id = ?
  `).get(projectId);

  const llmByModel = db.prepare(`
    SELECT model, COUNT(*) AS runs,
           COALESCE(SUM(input_tokens),0)  AS input_tokens,
           COALESCE(SUM(output_tokens),0) AS output_tokens,
           COALESCE(SUM(cost_usd),0)      AS cost_usd
    FROM asdlc_ai_usage WHERE project_id = ? GROUP BY model ORDER BY cost_usd DESC
  `).all(projectId);

  const llmBySource = db.prepare(`
    SELECT source, COUNT(*) AS runs,
           COALESCE(SUM(cost_usd),0) AS cost_usd
    FROM asdlc_ai_usage WHERE project_id = ? GROUP BY source ORDER BY cost_usd DESC
  `).all(projectId);

  // Guardrails
  const guardrails = db.prepare(`
    SELECT * FROM asdlc_guardrail
    WHERE project_id = ? AND lifecycle_status != 'retired'
    ORDER BY severity DESC, rule_name
  `).all(projectId);

  // Governance controls (extraction-sourced)
  const ingestDoc = db.prepare(
    'SELECT ingest_id FROM asdlc_ingest_document WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(projectId);
  const governance = ingestDoc
    ? db.prepare(
        'SELECT entity_data FROM asdlc_ingest_extraction WHERE ingest_id = ? AND entity_type = ? ORDER BY rowid'
      ).all(ingestDoc.ingest_id, 'governance_control').map(r => safeJson(r.entity_data, {}))
    : [];

  // Data Sources
  const dataSources = db.prepare(`
    SELECT * FROM asdlc_data_source
    WHERE project_id = ? AND lifecycle_status != 'retired'
    ORDER BY source_name
  `).all(projectId).map(ds => ({
    ...ds,
    access_requirements: safeJson(ds.access_requirements, []),
  }));

  return {
    project,
    costPerAssist,
    planningPeriod,
    periodsPerYear,
    useCases,
    workflows,
    agents,
    tools,
    dataModels,
    catalogItems,
    integrations,
    agentCosts,
    frs,
    nfrs,
    testCases,
    nowAssistCosts,
    llmTotals,
    llmByModel,
    llmBySource,
    guardrails,
    governance,
    dataSources,
  };
}

// ── Section Renderers ────────────────────────────────────────────────────────

function renderCover(project, generatedAt) {
  const stage = (project.stage || '').toUpperCase();
  const client = project.client_name || '';
  const dateStr = new Date(generatedAt).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  return `
<div class="cover">
  <div class="cover-inner">
    <div class="cover-top-bar"></div>
    <div class="cover-logo">AGENTIC SDLC WORKBENCH</div>
    <div class="cover-title">${esc(project.project_name || 'Design Review')}</div>
    ${project.project_code ? `<div class="cover-subtitle">${esc(project.project_code)}</div>` : ''}
    ${client ? `<div class="cover-meta">Client: ${esc(client)}</div>` : ''}
    ${stage ? `<div class="cover-meta">Stage: ${stage}</div>` : ''}
    <div class="cover-meta cover-date">Generated ${esc(dateStr)}</div>
    <div class="cover-tagline">Design Review — Complete Reference</div>
    <div class="cover-bottom-bar"></div>
  </div>
</div>`;
}

function renderToc(data) {
  const sections = [
    [2,  'Executive Summary'],
    [3,  'Use Cases'],
    [4,  'Workflows'],
    [5,  'Agents'],
    [6,  'Tools'],
    [7,  'Data Models'],
    [8,  'Catalog Items'],
    [9,  'Integrations'],
    [10, 'Requirements'],
    [11, 'Test Cases'],
    [12, 'AI Costs'],
    [13, 'Guardrails'],
    [14, 'Governance'],
    [15, 'Data Sources'],
  ];
  const items = sections.map(([n, title]) => `<li><a href="#s${n}">${esc(title)}</a></li>`).join('');
  return `
<nav class="toc no-print">
  <div class="toc-title">Contents</div>
  <ol>${items}</ol>
</nav>`;
}

function renderExecSummary(data) {
  const { useCases, workflows, agents, tools, frs, nfrs, testCases, nowAssistCosts, planningPeriod } = data;
  const totalNowAssist = nowAssistCosts.reduce((s, r) => s + (r.projected_per_period || 0), 0);

  // Supervision model distribution
  const supervisionCount = {};
  useCases.forEach(uc => {
    const m = uc.supervision_model || 'Unknown';
    supervisionCount[m] = (supervisionCount[m] || 0) + 1;
  });

  // Risk tier distribution
  const riskCount = {};
  useCases.forEach(uc => {
    const r = uc.risk_tier || 'Unset';
    riskCount[r] = (riskCount[r] || 0) + 1;
  });

  const statRows = [
    ['Use Cases', useCases.length],
    ['Workflows', workflows.length],
    ['Agents', agents.length],
    ['Tools', tools.length],
    ['Data Models', data.dataModels.length],
    ['Catalog Items', data.catalogItems.length],
    ['Integrations', data.integrations.length],
    ['Functional Requirements', frs.length],
    ['Non-Functional Requirements', nfrs.length],
    ['Test Cases', testCases.length],
  ].map(([label, count]) =>
    `<tr><td>${esc(label)}</td><td class="num">${count}</td></tr>`
  ).join('');

  const supervisionRows = Object.entries(supervisionCount).map(([m, c]) =>
    `<tr><td>${badge(m, supervisionClass(m))}</td><td class="num">${c}</td></tr>`
  ).join('') || '<tr><td colspan="2"><em>—</em></td></tr>';

  const riskRows = Object.entries(riskCount).map(([r, c]) =>
    `<tr><td>${badge(r, riskClass(r))}</td><td class="num">${c}</td></tr>`
  ).join('') || '<tr><td colspan="2"><em>—</em></td></tr>';

  return `
${sectionOpen(2, 'Executive Summary')}
<div class="exec-grid">
  <div class="exec-card">
    <div class="exec-card-title">Design Entity Counts</div>
    <table class="data-table">
      <thead><tr><th>Entity</th><th class="num">Count</th></tr></thead>
      <tbody>${statRows}</tbody>
    </table>
  </div>
  <div class="exec-card">
    <div class="exec-card-title">Use Case Supervision Models</div>
    <table class="data-table">
      <thead><tr><th>Model</th><th class="num">Count</th></tr></thead>
      <tbody>${supervisionRows}</tbody>
    </table>
  </div>
  <div class="exec-card">
    <div class="exec-card-title">Use Case Risk Tiers</div>
    <table class="data-table">
      <thead><tr><th>Tier</th><th class="num">Count</th></tr></thead>
      <tbody>${riskRows}</tbody>
    </table>
  </div>
  ${totalNowAssist > 0 ? `
  <div class="exec-card">
    <div class="exec-card-title">Now Assist Cost Projection</div>
    <table class="data-table">
      <thead><tr><th>Period</th><th class="num">Total</th></tr></thead>
      <tbody>
        <tr><td>${esc(planningPeriod)}</td><td class="num">${fmtCurrency(totalNowAssist)}</td></tr>
        <tr><td>Annual (est.)</td><td class="num">${fmtCurrency(totalNowAssist * (data.periodsPerYear || 12))}</td></tr>
      </tbody>
    </table>
  </div>` : ''}
</div>
${sectionClose()}`;
}

function renderUseCases({ useCases }) {
  if (!useCases.length) {
    return `${sectionOpen(3, 'Use Cases')}${emptySection('Use Cases')}${sectionClose()}`;
  }
  const cards = useCases.map(uc => {
    const vol = uc.volume_assumptions;
    const hasVol = vol && typeof vol === 'object' && Object.keys(vol).some(k => vol[k] !== null && vol[k] !== '');
    return `
<div class="entity-card">
  <div class="card-header">
    <h3 class="entity-name">${uc.slug ? `<span class="slug">${esc(uc.slug)}</span> ` : ''}${esc(uc.title)}</h3>
    <div class="card-badges">
      ${badge(uc.supervision_model || 'Unknown', supervisionClass(uc.supervision_model))}
      ${uc.risk_tier ? badge(uc.risk_tier + ' Risk', riskClass(uc.risk_tier)) : ''}
      ${badge(uc.readiness || 'draft', statusClass(uc.readiness))}
    </div>
  </div>
  <div class="card-body">
    ${labeledField('Summary', esc(uc.summary))}
    ${labeledField('Business Objective', esc(uc.business_objective))}
    ${labeledField('Expected Value', esc(uc.expected_value))}
    ${labeledField('Owner', esc(uc.owner))}
    ${labeledField('Primary Success Metric', esc(uc.primary_success_metric))}
    ${labeledField('Success Criteria', renderList(uc.success_criteria))}
    ${labeledField('Constraints', renderList(uc.constraints_list))}
    ${hasVol ? labeledField('Volume Assumptions', jsonDisplay(vol)) : ''}
    ${uc.baseline_cost_annual_usd != null ? labeledField('Baseline Cost / Year', fmtCurrency(uc.baseline_cost_annual_usd)) : ''}
  </div>
</div>`;
  }).join('');

  return `${sectionOpen(3, 'Use Cases')}${cards}${sectionClose()}`;
}

function renderWorkflows({ workflows }) {
  if (!workflows.length) {
    return `${sectionOpen(4, 'Workflows')}${emptySection('Workflows')}${sectionClose()}`;
  }

  const cards = workflows.map(wf => {
    const trigger = wf.trigger || {};

    // Steps table
    let stepsHtml = '';
    if (wf.steps.length) {
      const stepRows = wf.steps.map(s => {
        const decisions = Array.isArray(s.decisions) && s.decisions.length
          ? s.decisions.map(d => esc(typeof d === 'object' ? (d.label || d.description || JSON.stringify(d)) : d)).join('; ')
          : '';
        return `<tr>
          <td class="num">${s.step_number}</td>
          <td>${esc(s.name)}</td>
          <td>${esc(s.actor_role)}</td>
          <td class="num">${s.sla_hours != null ? s.sla_hours + 'h' : '—'}</td>
          <td class="small-text">${decisions}</td>
        </tr>`;
      }).join('');
      stepsHtml = `
<div class="sub-section">
  <div class="sub-section-title">Process Steps</div>
  <table class="data-table">
    <thead><tr><th>#</th><th>Name</th><th>Actor / Role</th><th class="num">SLA</th><th>Key Decisions</th></tr></thead>
    <tbody>${stepRows}</tbody>
  </table>
</div>`;
    }

    // HITL gates table
    let hitlHtml = '';
    if (wf.hitlGates.length) {
      const gateRows = wf.hitlGates.map(h => `<tr>
        <td>${badge(h.gate_type, 'gate')}</td>
        <td>${esc(h.criteria)}</td>
        <td>${esc(h.owner_role)}</td>
        <td>${esc(h.sla)}</td>
        <td class="small-text">${esc(h.handoff_mechanism)}</td>
      </tr>`).join('');
      hitlHtml = `
<div class="sub-section">
  <div class="sub-section-title">HITL Gates</div>
  <table class="data-table">
    <thead><tr><th>Gate Type</th><th>Criteria</th><th>Owner Role</th><th>SLA</th><th>Handoff</th></tr></thead>
    <tbody>${gateRows}</tbody>
  </table>
</div>`;
    }

    return `
<div class="entity-card">
  <div class="card-header">
    <h3 class="entity-name">${wf.slug ? `<span class="slug">${esc(wf.slug)}</span> ` : ''}${esc(wf.name)}</h3>
    <div class="card-badges">
      ${badge(wf.readiness || 'draft', statusClass(wf.readiness))}
      ${wf.sla_hours != null ? `<span class="meta-chip">SLA: ${wf.sla_hours}h</span>` : ''}
    </div>
  </div>
  <div class="card-body">
    ${wf.useCase ? labeledField('Use Case', `${wf.useCase.slug ? `<span class="slug">${esc(wf.useCase.slug)}</span> ` : ''}${esc(wf.useCase.title)}`) : ''}
    ${trigger.description ? labeledField('Trigger', esc(trigger.description)) : ''}
    ${trigger.type ? labeledField('Trigger Type', badge(trigger.type, 'trigger')) : ''}
    ${trigger.source_system ? labeledField('Trigger System', esc(trigger.source_system)) : ''}
    ${stepsHtml}
    ${hitlHtml}
  </div>
</div>`;
  }).join('');

  return `${sectionOpen(4, 'Workflows')}${cards}${sectionClose()}`;
}

function renderAgents({ agents }) {
  if (!agents.length) {
    return `${sectionOpen(5, 'Agents')}${emptySection('Agents')}${sectionClose()}`;
  }

  const cards = agents.map(ag => {
    const model = ag.run_as_model || {};

    // Linked use cases table
    let ucHtml = '';
    if (ag.ucLinks.length) {
      const ucRows = ag.ucLinks.map(u => `<tr>
        <td>${u.slug ? `<span class="slug">${esc(u.slug)}</span> ` : ''}${esc(u.title)}</td>
        <td class="small-text">${esc(u.business_value)}</td>
      </tr>`).join('');
      ucHtml = `
<div class="sub-section">
  <div class="sub-section-title">Linked Use Cases</div>
  <table class="data-table">
    <thead><tr><th>Use Case</th><th>Business Value</th></tr></thead>
    <tbody>${ucRows}</tbody>
  </table>
</div>`;
    }

    // Tool bindings table
    let toolHtml = '';
    if (ag.toolBindings.length) {
      const toolRows = ag.toolBindings.map(b => `<tr>
        <td>${b.tool_slug ? `<span class="slug">${esc(b.tool_slug)}</span> ` : ''}${esc(b.tool_name)}</td>
        <td>${esc(b.tool_execution_mode || b.execution_mode)}</td>
        <td>${badge(b.binding_supervision_model, supervisionClass(b.binding_supervision_model))}</td>
        <td class="small-text">${esc(b.purpose)}</td>
      </tr>`).join('');
      toolHtml = `
<div class="sub-section">
  <div class="sub-section-title">Tool Bindings</div>
  <table class="data-table">
    <thead><tr><th>Tool</th><th>Mode</th><th>Supervision</th><th>Purpose</th></tr></thead>
    <tbody>${toolRows}</tbody>
  </table>
</div>`;
    }

    // Design risks
    let risksHtml = '';
    if (Array.isArray(ag.design_risks) && ag.design_risks.length) {
      const riskItems = ag.design_risks.map(r => `<li>${esc(typeof r === 'object' ? (r.risk || JSON.stringify(r)) : r)}</li>`).join('');
      risksHtml = `
<div class="sub-section">
  <div class="sub-section-title">Design Risks</div>
  <ul class="risk-list">${riskItems}</ul>
</div>`;
    }

    return `
<div class="entity-card">
  <div class="card-header">
    <h3 class="entity-name">${ag.slug ? `<span class="slug">${esc(ag.slug)}</span> ` : ''}${esc(ag.name)}</h3>
    <div class="card-badges">
      ${badge(ag.supervision_model || 'Unknown', supervisionClass(ag.supervision_model))}
      ${ag.orchestration_strategy ? badge(ag.orchestration_strategy, 'strategy') : ''}
    </div>
  </div>
  <div class="card-body">
    ${labeledField('Scope', esc(ag.scope))}
    ${ag.goals.length ? labeledField('Goals', renderList(ag.goals)) : ''}
    ${ag.done_criteria.length ? labeledField('Done Criteria', renderList(ag.done_criteria)) : ''}
    ${ag.instructions ? labeledField('Instructions', `<pre class="instructions-block">${esc(ag.instructions)}</pre>`) : ''}
    ${model.model ? labeledField('Model', esc(model.model)) : ''}
    ${ag.latency_target ? labeledField('Latency Target', esc(ag.latency_target)) : ''}
    ${ag.maintenance_owner ? labeledField('Maintenance Owner', esc(ag.maintenance_owner)) : ''}
    ${ucHtml}
    ${toolHtml}
    ${risksHtml}
  </div>
</div>`;
  }).join('');

  return `${sectionOpen(5, 'Agents')}${cards}${sectionClose()}`;
}

function renderTools({ tools }) {
  if (!tools.length) {
    return `${sectionOpen(6, 'Tools')}${emptySection('Tools')}${sectionClose()}`;
  }

  const cards = tools.map(t => {
    const contract = t.contract || {};
    const access   = t.access_requirements || {};

    return `
<div class="entity-card">
  <div class="card-header">
    <h3 class="entity-name">${t.slug ? `<span class="slug">${esc(t.slug)}</span> ` : ''}${esc(t.name)}</h3>
    <div class="card-badges">
      ${badge(t.execution_mode, 'exec-mode')}
      ${t.dev_status ? badge(t.dev_status, t.dev_status === 'Existing' ? 'status-approved' : 'status-draft') : ''}
    </div>
  </div>
  <div class="card-body">
    ${contract.endpoint_type ? labeledField('Endpoint Type', esc(contract.endpoint_type)) : ''}
    ${contract.auth_method ? labeledField('Auth Method', esc(contract.auth_method)) : ''}
    ${contract.base_url ? labeledField('Base URL', esc(contract.base_url)) : ''}
    ${Object.keys(t.inputs || {}).length ? labeledField('Inputs', jsonDisplay(t.inputs)) : ''}
    ${Object.keys(t.outputs || {}).length ? labeledField('Outputs', jsonDisplay(t.outputs)) : ''}
    ${access.role_required ? labeledField('Role Required', esc(access.role_required)) : ''}
    ${access.data_classification ? labeledField('Data Classification', esc(access.data_classification)) : ''}
    ${access.pii_flag ? labeledField('Contains PII', badge('Yes', 'risk-high')) : ''}
    ${access.rate_limits ? labeledField('Rate Limits', esc(access.rate_limits)) : ''}
    ${t.boundaries.length ? labeledField('Boundaries', renderList(t.boundaries)) : ''}
  </div>
</div>`;
  }).join('');

  return `${sectionOpen(6, 'Tools')}${cards}${sectionClose()}`;
}

function renderDataModels({ dataModels }) {
  if (!dataModels.length) {
    return `${sectionOpen(7, 'Data Models')}${emptySection('Data Models')}${sectionClose()}`;
  }

  const cards = dataModels.map(dm => {
    // Fields table
    let fieldsHtml = '';
    const fields = Array.isArray(dm.fields) ? dm.fields : [];
    if (fields.length) {
      const hasType = fields.some(f => f.type || f.field_type);
      const hasMandatory = fields.some(f => f.mandatory !== undefined);
      const headerCols = ['Field Name', hasType ? 'Type' : null, hasMandatory ? 'Mandatory' : null, 'Notes'].filter(Boolean);
      const fRows = fields.map(f => {
        const name = f.name || f.column_name || f.field_name || JSON.stringify(f);
        const type = f.type || f.field_type || '';
        const mandatory = f.mandatory !== undefined ? (f.mandatory ? 'Yes' : 'No') : null;
        const notes = f.notes || f.description || '';
        return `<tr>
          <td>${esc(name)}</td>
          ${hasType ? `<td>${esc(type)}</td>` : ''}
          ${hasMandatory ? `<td>${esc(mandatory)}</td>` : ''}
          <td class="small-text">${esc(notes)}</td>
        </tr>`;
      }).join('');
      fieldsHtml = `
<div class="sub-section">
  <div class="sub-section-title">Fields (${fields.length})</div>
  <table class="data-table">
    <thead><tr>${headerCols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${fRows}</tbody>
  </table>
</div>`;
    }

    // Forms
    let formsHtml = '';
    if (dm.forms.length) {
      formsHtml = dm.forms.map(f => `
<div class="entity-card entity-card-compact" style="margin-left:1em">
  <div class="card-header">
    <h4 class="entity-name">${f.slug ? `<span class="slug">${esc(f.slug)}</span> ` : ''}${esc(f.name)}</h4>
    ${f.view_name ? `<span class="meta-chip">${esc(f.view_name)}</span>` : ''}
  </div>
  <div class="card-body">
    ${f.mandatory_fields.length ? labeledField('Mandatory Fields', renderList(f.mandatory_fields)) : ''}
    ${f.readonly_fields.length  ? labeledField('Read-only Fields', renderList(f.readonly_fields))  : ''}
    ${f.behavior_notes ? labeledField('Behavior Notes', esc(f.behavior_notes)) : ''}
  </div>
</div>`).join('');
      formsHtml = `<div class="sub-section"><div class="sub-section-title">Forms</div>${formsHtml}</div>`;
    }

    // Business Logic
    const LOGIC_TYPE_LABELS = {
      business_rule: 'Business Rule', client_script: 'Client Script',
      script_include: 'Script Include', ui_action: 'UI Action',
      scheduled_job: 'Scheduled Job', ui_policy: 'UI Policy',
    };
    let logicHtml = '';
    if (dm.logic.length) {
      const logicRows = dm.logic.map(l => `<tr>
        <td>${l.slug ? `<span class="slug">${esc(l.slug)}</span> ` : ''}${esc(l.name)}</td>
        <td>${badge(LOGIC_TYPE_LABELS[l.logic_type] || l.logic_type, 'logic-type')}</td>
        <td class="small-text">${esc(l.plain_english)}</td>
        <td class="small-text">${esc(l.when_runs)}</td>
      </tr>`).join('');
      logicHtml = `
<div class="sub-section">
  <div class="sub-section-title">Business Logic</div>
  <table class="data-table">
    <thead><tr><th>Name</th><th>Type</th><th>Plain English</th><th>When Runs</th></tr></thead>
    <tbody>${logicRows}</tbody>
  </table>
</div>`;
    }

    return `
<div class="entity-card">
  <div class="card-header">
    <h3 class="entity-name">${dm.slug ? `<span class="slug">${esc(dm.slug)}</span> ` : ''}${esc(dm.name)}</h3>
    ${dm.physical_name ? `<span class="meta-chip">${esc(dm.physical_name)}</span>` : ''}
  </div>
  <div class="card-body">
    ${labeledField('Purpose', esc(dm.purpose))}
    ${dm.extends_table ? labeledField('Extends Table', esc(dm.extends_table)) : ''}
    ${dm.audited ? labeledField('Audited', 'Yes') : ''}
    ${fieldsHtml}
    ${formsHtml}
    ${logicHtml}
  </div>
</div>`;
  }).join('');

  return `${sectionOpen(7, 'Data Models')}${cards}${sectionClose()}`;
}

function renderCatalogItems({ catalogItems }) {
  if (!catalogItems.length) {
    return `${sectionOpen(8, 'Catalog Items')}${emptySection('Catalog Items')}${sectionClose()}`;
  }

  const cards = catalogItems.map(ci => {
    const vars = Array.isArray(ci.variables) ? ci.variables : [];
    let varsHtml = '';
    if (vars.length) {
      // Variables can be either standard SN catalog form variables {name,label,type,mandatory}
      // or arbitrary JSON objects (e.g. tool inventory tables). Render generically.
      const keys = [...new Set(vars.flatMap(v => typeof v === 'object' && v !== null ? Object.keys(v) : []))];
      let tableHtml;
      if (keys.length) {
        const headerRow = keys.map(k => `<th>${esc(k)}</th>`).join('');
        const bodyRows = vars.map(v => {
          if (typeof v !== 'object' || v === null) return `<tr><td colspan="${keys.length}">${esc(String(v))}</td></tr>`;
          return `<tr>${keys.map(k => `<td class="small-text">${esc(String(v[k] ?? ''))}</td>`).join('')}</tr>`;
        }).join('');
        tableHtml = `<table class="data-table"><thead><tr>${headerRow}</tr></thead><tbody>${bodyRows}</tbody></table>`;
      } else {
        tableHtml = renderList(vars.map(v => typeof v === 'string' ? v : JSON.stringify(v)));
      }
      varsHtml = `
<div class="sub-section">
  <div class="sub-section-title">Variables / Data (${vars.length} rows)</div>
  <div class="scroll-x">${tableHtml}</div>
</div>`;
    }

    return `
<div class="entity-card">
  <div class="card-header">
    <h3 class="entity-name">${ci.slug ? `<span class="slug">${esc(ci.slug)}</span> ` : ''}${esc(ci.name)}</h3>
    ${ci.category ? `<span class="meta-chip">${esc(ci.category)}</span>` : ''}
  </div>
  <div class="card-body">
    ${labeledField('Short Description', esc(ci.short_description))}
    ${ci.who_can_order ? labeledField('Who Can Order', esc(ci.who_can_order)) : ''}
    ${ci.delivery_time ? labeledField('Delivery Time', esc(ci.delivery_time)) : ''}
    ${ci.workflow_name ? labeledField('Fulfillment Workflow', esc(ci.workflow_name)) : ''}
    ${varsHtml}
  </div>
</div>`;
  }).join('');

  return `${sectionOpen(8, 'Catalog Items')}${cards}${sectionClose()}`;
}

function renderIntegrations({ integrations }) {
  if (!integrations.length) {
    return `${sectionOpen(9, 'Integrations')}${emptySection('Integrations')}${sectionClose()}`;
  }

  const cards = integrations.map(i => {
    const fns = Array.isArray(i.functions) ? i.functions : [];
    let fnHtml = '';
    if (fns.length) {
      const fnRows = fns.map(f => {
        const name = f.name || f.function_name || JSON.stringify(f);
        const method = f.method || f.http_method || '';
        const desc = f.description || '';
        return `<tr><td>${esc(name)}</td><td>${esc(method)}</td><td class="small-text">${esc(desc)}</td></tr>`;
      }).join('');
      fnHtml = `
<div class="sub-section">
  <div class="sub-section-title">Functions</div>
  <table class="data-table">
    <thead><tr><th>Function</th><th>Method</th><th>Description</th></tr></thead>
    <tbody>${fnRows}</tbody>
  </table>
</div>`;
    }

    return `
<div class="entity-card">
  <div class="card-header">
    <h3 class="entity-name">${i.slug ? `<span class="slug">${esc(i.slug)}</span> ` : ''}${esc(i.name)}</h3>
    <div class="card-badges">
      ${i.integration_type ? badge(i.integration_type, 'source-type') : ''}
      ${i.auth_type ? badge(i.auth_type, 'exec-mode') : ''}
      ${i.connection_type ? badge(i.connection_type, 'strategy') : ''}
    </div>
  </div>
  <div class="card-body">
    ${labeledField('Description', esc(i.description))}
    ${i.endpoint ? labeledField('Endpoint', `<code>${esc(i.endpoint)}</code>`) : ''}
    ${i.alias_type ? labeledField('Alias Type', esc(i.alias_type)) : ''}
    ${i.notes ? labeledField('Notes', esc(i.notes)) : ''}
    ${fnHtml}
  </div>
</div>`;
  }).join('');

  return `${sectionOpen(9, 'Integrations')}${cards}${sectionClose()}`;
}

function renderRequirements({ frs, nfrs }) {
  let html = sectionOpen(10, 'Requirements');

  // Functional Requirements
  html += `<h3 class="sub-heading">Functional Requirements</h3>`;
  if (!frs.length) {
    html += emptySection('Functional Requirements');
  } else {
    const frRows = frs.map(fr => `<tr>
      <td>${badge(fr.slug, 'slug-badge')}</td>
      <td>${esc(fr.title)}</td>
      <td>${esc(fr.use_case_slug || '')}</td>
      <td>${badge(fr.priority || 'unknown', 'priority')}</td>
      <td>${badge(fr.status || 'draft', statusClass(fr.status))}</td>
      <td class="small-text">${esc(fr.description)}</td>
    </tr>`).join('');
    html += `
<table class="data-table req-table">
  <thead><tr><th>Slug</th><th>Title</th><th>Use Case</th><th>Priority</th><th>Status</th><th>Description</th></tr></thead>
  <tbody>${frRows}</tbody>
</table>`;
  }

  // Non-Functional Requirements
  html += `<h3 class="sub-heading">Non-Functional Requirements</h3>`;
  if (!nfrs.length) {
    html += emptySection('Non-Functional Requirements');
  } else {
    const nfrRows = nfrs.map(nfr => `<tr>
      <td>${badge(nfr.slug, 'slug-badge')}</td>
      <td>${esc(nfr.title)}</td>
      <td>${esc(nfr.category || '')}</td>
      <td>${badge(nfr.priority || 'unknown', 'priority')}</td>
      <td>${badge(nfr.status || 'draft', statusClass(nfr.status))}</td>
      <td class="small-text">${esc(nfr.measurable_target || nfr.description)}</td>
    </tr>`).join('');
    html += `
<table class="data-table req-table">
  <thead><tr><th>Slug</th><th>Title</th><th>Category</th><th>Priority</th><th>Status</th><th>Target / Description</th></tr></thead>
  <tbody>${nfrRows}</tbody>
</table>`;
  }

  html += sectionClose();
  return html;
}

function renderTestCases({ testCases }) {
  if (!testCases.length) {
    return `${sectionOpen(11, 'Test Cases')}${emptySection('Test Cases')}${sectionClose()}`;
  }

  // Group by scope
  const SCOPE_LABELS = {
    use_case: 'Use Case Tests',
    workflow: 'Workflow Tests',
    agent_spec: 'Agent Tests',
    tool: 'Tool Tests',
  };

  const byScope = {};
  testCases.forEach(tc => {
    const s = tc.scope || 'other';
    if (!byScope[s]) byScope[s] = [];
    byScope[s].push(tc);
  });

  const scopeOrder = ['use_case', 'workflow', 'agent_spec', 'tool'];
  const otherScopes = Object.keys(byScope).filter(s => !scopeOrder.includes(s));

  let html = sectionOpen(11, 'Test Cases');
  for (const scope of [...scopeOrder, ...otherScopes]) {
    if (!byScope[scope]) continue;
    const label = SCOPE_LABELS[scope] || scope;
    html += `<h3 class="sub-heading">${esc(label)}</h3>`;
    const rows = byScope[scope].map(tc => `<tr>
      <td>${tc.slug ? badge(tc.slug, 'slug-badge') : '—'}</td>
      <td>${esc(tc.title)}</td>
      <td>${badge(tc.case_type || 'unknown', 'case-type')}</td>
      <td>${badge(tc.status || 'draft', statusClass(tc.status))}</td>
      <td class="small-text">${esc(tc.test_action)}</td>
      <td class="small-text">${esc(tc.expected_result)}</td>
    </tr>`).join('');
    html += `
<table class="data-table">
  <thead><tr><th>Slug</th><th>Title</th><th>Type</th><th>Status</th><th>Action</th><th>Expected Result</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
  }

  html += sectionClose();
  return html;
}

function renderAiCosts({ nowAssistCosts, agentCosts, planningPeriod, periodsPerYear }) {
  let html = sectionOpen(12, 'AI Costs');

  const hasNowAssist = nowAssistCosts.some(r => r.projected_per_period > 0);
  const hasAgentCosts = agentCosts.some(a => a.cost_per_period > 0);

  if (!hasNowAssist && !hasAgentCosts) {
    html += `<p class="empty-note"><em>No Now Assist cost bindings have been configured for this application. Use the Cost Estimation feature on each workflow step to add cost data.</em></p>`;
    html += sectionClose();
    return html;
  }

  // ── By Use Case ────────────────────────────────────────────────────────────
  html += `<h3 class="sub-heading">Projected Now Assist Costs — by Use Case</h3>`;
  if (!hasNowAssist) {
    html += `<p class="empty-note"><em>No use case cost bindings configured.</em></p>`;
  } else {
    const totalPeriod = nowAssistCosts.reduce((s, r) => s + (r.projected_per_period || 0), 0);
    const ucRows = nowAssistCosts.map(uc => `<tr>
      <td>${uc.slug ? `<span class="slug">${esc(uc.slug)}</span> ` : ''}${esc(uc.title)}</td>
      <td class="num">${fmtCurrency(uc.projected_per_period)}</td>
      <td class="num">${fmtCurrency(uc.projected_per_period * periodsPerYear)}</td>
      <td class="num">${uc.baseline_cost_annual_usd != null ? fmtCurrency(uc.baseline_cost_annual_usd) : '—'}</td>
    </tr>`).join('');
    html += `
<table class="data-table" style="margin-bottom:1.5em">
  <thead><tr>
    <th>Use Case</th>
    <th class="num">Cost / ${esc(planningPeriod)}</th>
    <th class="num">Annual Est.</th>
    <th class="num">Baseline Cost / Year</th>
  </tr></thead>
  <tbody>
    ${ucRows}
    <tr class="total-row">
      <td><strong>Total</strong></td>
      <td class="num"><strong>${fmtCurrency(totalPeriod)}</strong></td>
      <td class="num"><strong>${fmtCurrency(totalPeriod * periodsPerYear)}</strong></td>
      <td>—</td>
    </tr>
  </tbody>
</table>`;
  }

  // ── By Agent ───────────────────────────────────────────────────────────────
  html += `<h3 class="sub-heading">Projected Now Assist Costs — by Agent</h3>`;
  if (!hasAgentCosts) {
    html += `<p class="empty-note"><em>No agent cost bindings configured (agents need workflow participants assigned to steps with cost bindings).</em></p>`;
  } else {
    const totalAgent = agentCosts.reduce((s, a) => s + a.cost_per_period, 0);
    const agRows = agentCosts
      .filter(a => a.cost_per_period > 0)
      .sort((a, b) => b.cost_per_period - a.cost_per_period)
      .map(a => `<tr>
        <td>${a.slug ? `<span class="slug">${esc(a.slug)}</span> ` : ''}${esc(a.name)}</td>
        <td class="num">${fmtCurrency(a.cost_per_period)}</td>
        <td class="num">${fmtCurrency(a.cost_per_period * periodsPerYear)}</td>
      </tr>`).join('');
    html += `
<table class="data-table">
  <thead><tr>
    <th>Agent</th>
    <th class="num">Cost / ${esc(planningPeriod)}</th>
    <th class="num">Annual Est.</th>
  </tr></thead>
  <tbody>
    ${agRows}
    <tr class="total-row">
      <td><strong>Total</strong></td>
      <td class="num"><strong>${fmtCurrency(totalAgent)}</strong></td>
      <td class="num"><strong>${fmtCurrency(totalAgent * periodsPerYear)}</strong></td>
    </tr>
  </tbody>
</table>`;
  }

  html += sectionClose();
  return html;
}

function renderGuardrails({ guardrails }) {
  if (!guardrails.length) {
    return `${sectionOpen(13, 'Guardrails')}${emptySection('Guardrails')}${sectionClose()}`;
  }

  const cards = guardrails.map(g => `
<div class="entity-card entity-card-compact">
  <div class="card-header">
    <h4 class="entity-name">${g.slug ? `<span class="slug">${esc(g.slug)}</span> ` : ''}${esc(g.rule_name)}</h4>
    <div class="card-badges">
      ${badge(g.severity, severityClass(g.severity))}
    </div>
  </div>
  <div class="card-body">
    ${labeledField('Rule', esc(g.rule_text))}
    ${g.applies_to ? labeledField('Applies To', esc(g.applies_to)) : ''}
    ${g.threshold_value ? labeledField('Threshold', `${esc(g.threshold_value)}${g.threshold_unit ? ' ' + esc(g.threshold_unit) : ''}`) : ''}
    ${g.regulatory_reference ? labeledField('Regulatory Reference', esc(g.regulatory_reference)) : ''}
    ${g.action_if_triggered ? labeledField('Action If Triggered', esc(g.action_if_triggered)) : ''}
  </div>
</div>`).join('');

  return `${sectionOpen(13, 'Guardrails')}${cards}${sectionClose()}`;
}

function renderGovernance({ governance }) {
  if (!governance.length) {
    return `${sectionOpen(14, 'Governance')}${emptySection('Governance Controls')}${sectionClose()}`;
  }

  const cards = governance.map(g => {
    const title = g.title || g.control_type || g.category || 'Governance Control';
    const desc  = g.description || g.control_description || '';
    const risk  = g.risk_level || g.risk_classification || '';
    const reqs  = Array.isArray(g.requirements) ? g.requirements
                  : Array.isArray(g.audit_requirements) ? g.audit_requirements
                  : [];

    return `
<div class="entity-card entity-card-compact">
  <div class="card-header">
    <h4 class="entity-name">${esc(title)}</h4>
    <div class="card-badges">
      ${risk ? badge(risk, riskClass(risk)) : ''}
    </div>
  </div>
  <div class="card-body">
    ${desc ? labeledField('Description', esc(desc)) : ''}
    ${reqs.length ? labeledField('Requirements', renderList(reqs)) : ''}
    ${g.monitoring_requirements ? labeledField('Monitoring', renderList(Array.isArray(g.monitoring_requirements) ? g.monitoring_requirements : [g.monitoring_requirements])) : ''}
    ${g.approvals_required ? labeledField('Approvals Required', jsonDisplay(g.approvals_required)) : ''}
  </div>
</div>`;
  }).join('');

  return `${sectionOpen(14, 'Governance')}${cards}${sectionClose()}`;
}

function renderDataSources({ dataSources }) {
  if (!dataSources.length) {
    return `${sectionOpen(15, 'Data Sources')}${emptySection('Data Sources')}${sectionClose()}`;
  }

  const cards = dataSources.map(ds => {
    const access = ds.access_requirements;
    const accessItems = Array.isArray(access)
      ? access.map(a => typeof a === 'object' ? (a.description || JSON.stringify(a)) : String(a))
      : [];

    return `
<div class="entity-card entity-card-compact">
  <div class="card-header">
    <h4 class="entity-name">${ds.slug ? `<span class="slug">${esc(ds.slug)}</span> ` : ''}${esc(ds.source_name)}</h4>
    <div class="card-badges">
      ${badge(ds.source_type, 'source-type')}
      ${ds.contains_pii ? badge('Contains PII', 'risk-high') : ''}
    </div>
  </div>
  <div class="card-body">
    ${labeledField('Description', esc(ds.description))}
    ${ds.access_type ? labeledField('Access Type', esc(ds.access_type)) : ''}
    ${ds.rate_limits ? labeledField('Rate Limits', esc(ds.rate_limits)) : ''}
    ${accessItems.length ? labeledField('Access Requirements', renderList(accessItems)) : ''}
  </div>
</div>`;
  }).join('');

  return `${sectionOpen(15, 'Data Sources')}${cards}${sectionClose()}`;
}

// ── HTML Shell ───────────────────────────────────────────────────────────────

function buildCss() {
  return `
/* ── Reset & Base ── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: system-ui, -apple-system, 'Segoe UI', Arial, sans-serif;
  font-size: 11pt;
  line-height: 1.5;
  color: #1e293b;
  background: #ffffff;
  padding: 0 2em 4em;
  max-width: 1100px;
  margin: 0 auto;
}
h2 { font-size: 1.4em; color: #0f172a; margin-bottom: 0.5em; }
h3 { font-size: 1.15em; color: #1e293b; margin-bottom: 0.4em; }
h4 { font-size: 1em; color: #1e293b; }
a { color: #2563eb; text-decoration: none; }
a:hover { text-decoration: underline; }
ul { padding-left: 1.25em; }
li { margin-bottom: 0.15em; }
pre { font-family: 'Cascadia Code', 'Consolas', monospace; }

/* ── Cover Page ── */
.cover {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  page-break-after: always;
  text-align: center;
  padding: 2em;
}
.cover-inner { max-width: 600px; width: 100%; }
.cover-top-bar { height: 8px; background: #1e293b; border-radius: 4px; margin-bottom: 3em; }
.cover-bottom-bar { height: 4px; background: #3b82f6; border-radius: 4px; margin-top: 3em; }
.cover-logo { font-size: 0.75em; letter-spacing: 0.15em; color: #64748b; text-transform: uppercase; margin-bottom: 2em; }
.cover-title { font-size: 2.2em; font-weight: 700; color: #0f172a; line-height: 1.2; margin-bottom: 0.4em; }
.cover-subtitle { font-size: 1.1em; color: #475569; margin-bottom: 0.5em; font-weight: 600; }
.cover-meta { font-size: 0.9em; color: #64748b; margin-bottom: 0.3em; }
.cover-date { margin-top: 1.5em; }
.cover-tagline { font-size: 0.8em; color: #94a3b8; margin-top: 2em; letter-spacing: 0.05em; }

/* ── Table of Contents ── */
.toc {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 1.5em 2em;
  margin: 2em 0;
  break-inside: avoid;
}
.toc-title { font-weight: 700; font-size: 1.05em; color: #0f172a; margin-bottom: 0.75em; }
.toc ol { columns: 2; column-gap: 2em; list-style: decimal; padding-left: 1.5em; }
.toc li { margin-bottom: 0.35em; break-inside: avoid; }
.toc a { color: #2563eb; }

/* ── Sections ── */
.section { margin-top: 2.5em; page-break-before: auto; }
.section-title {
  font-size: 1.4em;
  font-weight: 700;
  color: #0f172a;
  padding: 0.6em 0;
  border-bottom: 2px solid #1e293b;
  margin-bottom: 1em;
}
.sub-heading {
  font-size: 1.1em;
  font-weight: 600;
  color: #334155;
  margin: 1.5em 0 0.6em;
  padding-bottom: 0.25em;
  border-bottom: 1px solid #e2e8f0;
}

/* ── Entity Cards ── */
.entity-card {
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  margin-bottom: 1em;
  break-inside: avoid;
  overflow: hidden;
}
.entity-card-compact .card-body { padding: 0.65em 1em 0.75em; }
.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1em;
  background: #f8fafc;
  padding: 0.6em 1em;
  border-bottom: 1px solid #e2e8f0;
}
.card-header h3, .card-header h4 { margin: 0; }
.entity-name { font-size: 1em; font-weight: 600; color: #0f172a; }
.card-badges { display: flex; flex-wrap: wrap; gap: 0.3em; align-items: center; flex-shrink: 0; }
.card-body { padding: 0.75em 1em 1em; }

/* ── Fields ── */
.field-row {
  display: flex;
  gap: 0.75em;
  margin-bottom: 0.5em;
  align-items: flex-start;
}
.field-label {
  font-size: 0.8em;
  font-weight: 600;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  min-width: 9em;
  flex-shrink: 0;
  padding-top: 0.15em;
}
.field-value { flex: 1; font-size: 0.95em; }

/* ── Sub-sections ── */
.sub-section { margin-top: 1em; }
.sub-section-title {
  font-size: 0.8em;
  font-weight: 700;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 0.4em;
}

/* ── Tables ── */
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 9.5pt;
  margin-top: 0.25em;
}
.data-table th {
  background: #f1f5f9;
  color: #475569;
  font-size: 0.78em;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.4em 0.6em;
  text-align: left;
  border-bottom: 2px solid #e2e8f0;
}
.data-table td {
  padding: 0.4em 0.6em;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: top;
}
.data-table tr:last-child td { border-bottom: none; }
.data-table tr:nth-child(even) td { background: #fafafa; }
.data-table tr:hover td { background: #f0f7ff; }
.data-table .num { text-align: right; white-space: nowrap; }
.data-table .small-text { font-size: 0.85em; }
.req-table { margin-bottom: 1.5em; }
.total-row td { background: #eff6ff !important; font-weight: 600; }
.mini-table { margin: 0.25em 0; }

/* ── KV List ── */
.kv-list { display: grid; grid-template-columns: auto 1fr; gap: 0.2em 0.75em; font-size: 0.9em; }
.kv-list dt { font-weight: 600; color: #64748b; }
.kv-list dd { color: #1e293b; }

/* ── Instructions block ── */
.scroll-x {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.instructions-block {
  font-size: 8.5pt;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  padding: 0.5em 0.75em;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  max-height: 20em;
  overflow-y: auto;
  line-height: 1.4;
}

/* ── Executive summary grid ── */
.exec-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1em; margin-top: 0.5em; }
.exec-card { border: 1px solid #e2e8f0; border-radius: 6px; padding: 1em; break-inside: avoid; }
.exec-card-title { font-weight: 700; font-size: 0.85em; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.6em; }

/* ── Risk list ── */
.risk-list { margin: 0; padding-left: 1.25em; }
.risk-list li { margin-bottom: 0.2em; font-size: 0.9em; }

/* ── Empty note ── */
.empty-note { color: #94a3b8; font-style: italic; padding: 0.5em 0; }

/* ── Slug / meta chips ── */
.slug {
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 0.8em;
  background: #dbeafe;
  color: #1d4ed8;
  border-radius: 3px;
  padding: 0.1em 0.35em;
  font-weight: 600;
}
.meta-chip {
  font-size: 0.78em;
  color: #64748b;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  border-radius: 3px;
  padding: 0.15em 0.4em;
}

/* ── Badges ── */
.badge {
  display: inline-block;
  font-size: 0.72em;
  font-weight: 600;
  border-radius: 3px;
  padding: 0.15em 0.45em;
  white-space: nowrap;
}
.badge-supervision-autonomous    { background: #dcfce7; color: #15803d; }
.badge-supervision-supervised    { background: #fef9c3; color: #854d0e; }
.badge-supervision-advisory      { background: #dbeafe; color: #1d4ed8; }
.badge-supervision-default       { background: #f1f5f9; color: #475569; }
.badge-risk-high                 { background: #fee2e2; color: #b91c1c; }
.badge-risk-medium               { background: #fef3c7; color: #92400e; }
.badge-risk-low                  { background: #dcfce7; color: #15803d; }
.badge-risk-default              { background: #f1f5f9; color: #475569; }
.badge-status-approved           { background: #dcfce7; color: #15803d; }
.badge-status-draft              { background: #f1f5f9; color: #475569; }
.badge-status-review             { background: #fef9c3; color: #92400e; }
.badge-status-fail               { background: #fee2e2; color: #b91c1c; }
.badge-status-default            { background: #f1f5f9; color: #475569; }
.badge-strategy                  { background: #ede9fe; color: #6d28d9; }
.badge-gate                      { background: #fce7f3; color: #9d174d; }
.badge-trigger                   { background: #ecfdf5; color: #065f46; }
.badge-exec-mode                 { background: #f1f5f9; color: #334155; }
.badge-priority                  { background: #fef3c7; color: #92400e; }
.badge-source-type               { background: #f0f9ff; color: #0369a1; }
.badge-case-type                 { background: #fdf4ff; color: #86198f; }
.badge-slug-badge                { background: #dbeafe; color: #1d4ed8; font-family: monospace; }
.badge-logic-type                { background: #fdf4ff; color: #6b21a8; }

/* ── Print ── */
@media print {
  body { font-size: 10pt; padding: 0; max-width: none; }
  .no-print { display: none !important; }
  .cover { page-break-after: always; min-height: 100vh; }
  .section { page-break-before: auto; }
  .entity-card { break-inside: avoid; }
  .data-table, .exec-card { break-inside: avoid; }
  .instructions-block { max-height: none; overflow: visible; }
  a { color: #1e293b; text-decoration: none; }
  .toc { display: none; }
  .data-table tr:hover td { background: inherit; }
}
`;
}

function wrapHtml(body, title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${buildCss()}</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ── Main Export ──────────────────────────────────────────────────────────────

function buildDesignReviewHtml(db, projectId) {
  const data = gatherData(db, projectId);
  if (!data) throw new Error(`Project not found: ${projectId}`);

  const { project } = data;
  const generatedAt = new Date().toISOString();
  const title = `${project.project_name || 'Design Review'} — Design Review Report`;

  const body = [
    renderCover(project, generatedAt),
    renderToc(data),
    renderExecSummary(data),
    renderUseCases(data),
    renderWorkflows(data),
    renderAgents(data),
    renderTools(data),
    renderDataModels(data),
    renderCatalogItems(data),
    renderIntegrations(data),
    renderRequirements(data),
    renderTestCases(data),
    renderAiCosts(data),
    renderGuardrails(data),
    renderGovernance(data),
    renderDataSources(data),
  ].join('\n');

  return wrapHtml(body, title);
}

module.exports = { buildDesignReviewHtml };
