/**
 * modules/admin_ai.js — Administration › AI Settings + Usage
 *
 * Global model selection per AI role (all 11 roles, grouped by pipeline), a
 * thinking-effort dial for the reasoning roles, max tokens, a data-driven model
 * registry (extendable without code changes), plus a token/cost usage view.
 * Settings persist in asdlc_app_setting and take effect without a server restart.
 */
import { apiFetch, el, showToast, formatDateTime } from '../app.js';

// Display metadata per role — grouped to mirror the pipelines they power.
// `thinking: true` marks the roles whose pipelines actually consume the effort dial.
const ROLE_GROUPS = [
  {
    group: 'Ingestion & Design',
    roles: [
      { key: 'extraction',    label: 'Document extraction',   thinking: true,  hint: 'Reads ingested docs → staged design entities' },
      { key: 'synthesis',     label: 'Design synthesis',      thinking: true,  hint: 'Fills design blanks + proposes net-new entities after extraction (the "magic" pass)' },
      { key: 'prompt_drafter',label: 'Agent prompt drafter',  thinking: false, hint: 'Drafts agent system prompts' },
    ],
  },
  {
    group: 'Quality & Review',
    roles: [
      { key: 'quality_reviewer', label: 'Quality reviewer',    thinking: false, hint: 'Audits design entities for gaps/conflicts (also powers cross-check, traceability, test generation)' },
      { key: 'build_review',     label: 'Build-spec AI review',thinking: false, hint: 'Optional review appended to the build export' },
    ],
  },
  {
    group: 'ServiceNow Round-Trip',
    roles: [
      { key: 'reverse_engineer',   label: 'Reverse-engineer AI Agent', thinking: true, hint: 'Infers design intent from captured ServiceNow records' },
      { key: 'reconciler',         label: 'Reconciler AI Agent',       thinking: true, hint: 'Proposes non-destructive merges of SN changes into the design' },
      { key: 'reconcile_reviewer', label: 'Reviewer AI Agent',         thinking: true, hint: 'Independent adversarial check on reconciliation proposals' },
    ],
  },
  {
    group: 'Utilities',
    roles: [
      { key: 'req_linker',    label: 'Requirement Linker',  thinking: false, hint: 'Infers use-case assignments for orphaned requirements at promote time' },
      { key: 'rasic_deriver', label: 'RASIC deriver',       thinking: true,  hint: 'Infers the RASIC responsibility matrix' },
      { key: 'cost_estimate', label: 'Now Assist cost estimate', thinking: false, hint: 'Maps workflow steps to Now Assist skills for cost projection' },
    ],
  },
];

const STATUS_BADGE = { legacy: '⏳ legacy', deprecated: '⚠ deprecated' };

function fmtTokens(n) {
  n = Number(n || 0);
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
function fmtCost(n) {
  if (n == null) return '—';
  return '$' + Number(n).toFixed(4);
}

function validationBanner(validation) {
  const issues = (validation && validation.issues) || [];
  const errs  = issues.filter(i => i.level === 'error');
  const warns = issues.filter(i => i.level === 'warn');
  if (!errs.length && !warns.length) return null;
  const box = el('div', {
    style: `border:1px solid ${errs.length ? 'var(--danger)' : 'var(--warning, #b8860b)'};` +
           'border-radius:6px;padding:10px 12px;margin-bottom:14px;font-size:12px',
  });
  box.appendChild(el('div', { style: 'font-weight:700;margin-bottom:4px' },
    errs.length ? '⛔ AI model configuration problems' : '⚠ AI model configuration warnings'));
  [...errs, ...warns].forEach(i =>
    box.appendChild(el('div', {}, `${i.role ? `[${i.role}] ` : ''}${i.message}`)));
  return box;
}

export async function render(container) {
  container.innerHTML = '';
  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'AI Settings'),
    el('p', { className: 'purpose-text' },
      'Choose which Claude model each AI role uses, tune thinking effort and output tokens, ' +
      'and review token usage and estimated cost. Settings are global and apply without a restart. ' +
      'New models are added as registry entries — no code changes.')
  ));

  let config;
  try {
    config = await apiFetch('/settings/ai');
  } catch (err) {
    container.appendChild(el('div', { className: 'error-state' }, 'Failed to load AI settings: ' + err.message));
    return;
  }
  const models = config.available_models || [];
  const effortLevels = config.effort_levels || ['low', 'medium', 'high', 'xhigh', 'max'];
  const s = config.settings || {};
  const byId = new Map(models.map(m => [m.id, m]));

  const banner = validationBanner(config.validation);
  if (banner) container.appendChild(banner);

  // ── Settings panel ─────────────────────────────────────────────────────────
  const panel = el('div', { className: 'panel' });
  panel.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, 'Model selection')));
  const body = el('div', { className: 'panel-body', style: 'display:grid;gap:14px;max-width:680px' });
  panel.appendChild(body);

  const inputs = {};

  function modelSelect(key) {
    const sel = el('select', { className: 'form-input' });
    // Group options by registry family
    const families = [...new Set(models.map(m => m.family || 'Other'))];
    families.forEach(fam => {
      const grp = el('optgroup', { label: fam });
      models.filter(m => (m.family || 'Other') === fam).forEach(m => {
        const badge = STATUS_BADGE[m.status] ? ` — ${STATUS_BADGE[m.status]}` : '';
        const opt = el('option', { value: m.id }, `${m.display || m.id}${badge}`);
        if (s[key] === m.id) opt.selected = true;
        grp.appendChild(opt);
      });
      sel.appendChild(grp);
    });
    // If the current value isn't in the catalog (e.g. set via env), show it too
    if (s[key] && !byId.has(s[key])) {
      const opt = el('option', { value: s[key] }, s[key] + ' (current — not in registry)');
      opt.selected = true;
      sel.appendChild(opt);
    }
    inputs[key] = sel;
    return sel;
  }

  function effortSelect(roleKey, modelSel) {
    const key = `${roleKey}_thinking_effort`;
    const sel = el('select', { className: 'form-input', style: 'max-width:220px' });
    const rebuild = () => {
      const entry = byId.get(modelSel.value);
      const supported = (entry && Array.isArray(entry.efforts) && entry.efforts.length)
        ? entry.efforts
        : (entry && entry.thinking_style === 'budget' ? effortLevels : effortLevels);
      const current = sel.value || s[key] || 'off';
      sel.innerHTML = '';
      sel.appendChild(el('option', { value: 'off' }, 'Off — no extended thinking'));
      effortLevels.forEach(lv => {
        if (!supported.includes(lv) && entry && entry.thinking_style !== 'budget') return;
        sel.appendChild(el('option', { value: lv }, lv));
      });
      // Restore selection (fall back to nearest available)
      const values = [...sel.options].map(o => o.value);
      sel.value = values.includes(current) ? current : (values.includes('high') ? 'high' : 'off');
    };
    rebuild();
    sel.value = s[key] || 'off';
    if (![...sel.options].some(o => o.value === sel.value)) sel.value = 'off';
    modelSel.addEventListener('change', rebuild);
    inputs[key] = sel;
    return sel;
  }

  ROLE_GROUPS.forEach(g => {
    body.appendChild(el('div', { style: 'font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);border-bottom:1px solid var(--border);padding-bottom:4px;margin-top:6px' }, g.group));
    g.roles.forEach(rf => {
      const modelKey = `${rf.key}_model`;
      const row = el('div', { className: 'form-group' },
        el('label', { className: 'form-label' }, rf.label),
      );
      const controls = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center' });
      const mSel = modelSelect(modelKey);
      mSel.style.flex = '1 1 260px';
      controls.appendChild(mSel);
      if (rf.thinking) {
        controls.appendChild(el('span', { style: 'font-size:11px;color:var(--text-muted)' }, 'thinking:'));
        controls.appendChild(effortSelect(rf.key, mSel));
      }
      row.appendChild(controls);
      row.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' }, rf.hint));
      body.appendChild(row);
    });
  });

  // Max tokens
  const maxInput = el('input', { type: 'number', className: 'form-input', min: '1024', step: '512',
    value: s.max_tokens || 8192, style: 'max-width:200px' });
  inputs.max_tokens = maxInput;
  body.appendChild(el('div', { className: 'form-group', style: 'border-top:1px solid var(--border);padding-top:12px' },
    el('label', { className: 'form-label' }, 'Max output tokens per call'), maxInput));

  // Max extraction loops
  const maxLoopsInput = el('input', { type: 'number', className: 'form-input', min: '5', max: '50', step: '5',
    value: s.max_extraction_loops || 20, style: 'max-width:200px' });
  inputs.max_extraction_loops = maxLoopsInput;
  body.appendChild(el('div', { className: 'form-group' },
    el('label', { className: 'form-label' }, 'Max extraction loops per ingest run'),
    maxLoopsInput,
    el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' },
      'Safety cap on the agentic loop during document ingestion. Raise this for large or complex documents. Default: 20.')));

  // Model registry (advanced) — extend/override the model catalog as data
  const regDetails = el('details', { style: 'border-top:1px solid var(--border);padding-top:12px' });
  regDetails.appendChild(el('summary', { style: 'cursor:pointer;font-weight:600;font-size:13px' },
    'Model registry (advanced) — add or override models without code changes'));
  regDetails.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin:6px 0' },
    'JSON array merged over the built-in registry by "id". Example: ' +
    '[{"id":"claude-new-model","display":"Claude New","family":"Claude 6","tier":"reasoning","status":"active",' +
    '"thinking_style":"adaptive","efforts":["low","medium","high","xhigh","max"],"pricing":{"in":5,"out":25,"cacheRead":0.5}}] · ' +
    'Use {"id":"...","remove":true} to hide a built-in entry. Leave empty to use the built-in registry as-is.'));
  const regTa = el('textarea', { className: 'form-input', rows: '5',
    style: 'width:100%;font-family:monospace;font-size:11px', placeholder: '[]' });
  regTa.value = config.registry_custom || '';
  inputs.model_registry_custom = regTa;
  regDetails.appendChild(regTa);
  body.appendChild(regDetails);

  const saveBtn = el('button', { className: 'btn btn-primary' }, 'Save settings');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      const payload = {
        max_tokens:           parseInt(inputs.max_tokens.value, 10) || 8192,
        max_extraction_loops: parseInt(inputs.max_extraction_loops.value, 10) || 20,
        model_registry_custom: inputs.model_registry_custom.value.trim(),
      };
      for (const g of ROLE_GROUPS) for (const rf of g.roles) {
        payload[`${rf.key}_model`] = inputs[`${rf.key}_model`].value;
        if (inputs[`${rf.key}_thinking_effort`]) {
          payload[`${rf.key}_thinking_effort`] = inputs[`${rf.key}_thinking_effort`].value;
        }
      }
      const result = await apiFetch('/settings/ai', { method: 'PUT', body: JSON.stringify(payload) });
      showToast('AI settings saved', 'success');
      // Refresh so the validation banner + registry-driven dropdowns reflect the save
      if (result && result.validation && result.validation.issues && result.validation.issues.length) {
        render(container);
      }
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = 'Save settings';
    }
  });
  body.appendChild(el('div', { style: 'margin-top:4px' }, saveBtn));
  container.appendChild(panel);

  // ── Usage panel ──────────────────────────────────────────────────────────
  const usagePanel = el('div', { className: 'panel', style: 'margin-top:18px' });
  usagePanel.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, 'AI usage & cost')));
  const usageBody = el('div', { className: 'panel-body' });
  usagePanel.appendChild(usageBody);
  container.appendChild(usagePanel);

  try {
    const usage = await apiFetch('/usage?limit=50');
    const t = usage.totals || {};
    usageBody.appendChild(el('div', { style: 'display:flex;gap:24px;flex-wrap:wrap;margin-bottom:14px' },
      stat('Runs', t.runs || 0),
      stat('Input tokens', fmtTokens(t.input_tokens)),
      stat('Output tokens', fmtTokens(t.output_tokens)),
      stat('Est. cost', fmtCost(t.cost_usd)),
    ));
    if ((t.pricing_missing_models || []).length) {
      usageBody.appendChild(el('div', { style: 'font-size:12px;color:var(--warning, #b8860b);margin-bottom:10px' },
        `⚠ No pricing configured for: ${t.pricing_missing_models.join(', ')} — their usage is recorded but not costed. Add pricing in the model registry.`));
    }

    if ((usage.by_model || []).length) {
      usageBody.appendChild(el('h4', { style: 'margin:8px 0' }, 'By model'));
      const mt = el('table', { className: 'dr-compact-table', style: 'width:100%;margin-bottom:16px' });
      mt.appendChild(el('thead', {}, el('tr', {},
        el('th', {}, 'Model'), el('th', { style: 'text-align:right' }, 'Runs'),
        el('th', { style: 'text-align:right' }, 'In'), el('th', { style: 'text-align:right' }, 'Out'),
        el('th', { style: 'text-align:right' }, 'Cost'))));
      const mb = el('tbody');
      usage.by_model.forEach(r => mb.appendChild(el('tr', {},
        el('td', {}, (r.model || '—') + (r.has_pricing === false && r.model ? ' ⚠' : '')),
        el('td', { style: 'text-align:right' }, String(r.runs)),
        el('td', { style: 'text-align:right;font-family:monospace' }, fmtTokens(r.input_tokens)),
        el('td', { style: 'text-align:right;font-family:monospace' }, fmtTokens(r.output_tokens)),
        el('td', { style: 'text-align:right;font-family:monospace' }, r.has_pricing === false ? '— (no pricing)' : fmtCost(r.cost_usd)))));
      mt.appendChild(mb);
      usageBody.appendChild(mt);
    }

    usageBody.appendChild(el('h4', { style: 'margin:8px 0' }, 'Recent runs'));
    if (!(usage.rows || []).length) {
      usageBody.appendChild(el('p', { className: 'dr-empty-note' }, 'No AI runs recorded yet. Process an ingest document to populate this.'));
    } else {
      const rt = el('table', { className: 'dr-compact-table', style: 'width:100%' });
      rt.appendChild(el('thead', {}, el('tr', {},
        el('th', {}, 'When'), el('th', {}, 'Source'), el('th', {}, 'Model'),
        el('th', { style: 'text-align:right' }, 'In'), el('th', { style: 'text-align:right' }, 'Out'),
        el('th', { style: 'text-align:right' }, 'Cost'))));
      const rb = el('tbody');
      usage.rows.forEach(r => rb.appendChild(el('tr', {},
        el('td', {}, formatDateTime(r.created_at)),
        el('td', {}, el('span', { className: 'badge' }, (r.source || '').replace(/_/g, ' '))),
        el('td', {}, r.model || '—'),
        el('td', { style: 'text-align:right;font-family:monospace' }, fmtTokens(r.input_tokens)),
        el('td', { style: 'text-align:right;font-family:monospace' }, fmtTokens(r.output_tokens)),
        el('td', { style: 'text-align:right;font-family:monospace' }, fmtCost(r.cost_usd)))));
      rt.appendChild(rb);
      usageBody.appendChild(rt);
    }
  } catch (err) {
    usageBody.appendChild(el('p', { style: 'color:var(--danger)' }, 'Failed to load usage: ' + err.message));
  }

  // ── Tool Call Audit ────────────────────────────────────────────────────────
  const auditPanel = el('div', { className: 'panel' });
  auditPanel.appendChild(el('div', { className: 'panel-header' },
    el('h3', { className: 'panel-title' }, 'Tool Call Audit'),
    el('span', { style: 'font-size:12px;color:var(--text-muted);margin-left:8px' },
      'Every tool Claude invoked via the API — proof of which tools were used')
  ));
  const auditBody = el('div', { className: 'panel-body' });
  auditPanel.appendChild(auditBody);
  container.appendChild(auditPanel);

  try {
    const audit = await apiFetch('/admin/tool-calls');
    if (!(audit.distinct_tools || []).length) {
      auditBody.appendChild(el('p', { className: 'dr-empty-note' },
        'No tool calls recorded yet. Run an ingest or ServiceNow sync to populate this.'));
    } else {
      const t = el('table', { className: 'dr-compact-table', style: 'width:100%' });
      t.appendChild(el('thead', {}, el('tr', {},
        el('th', {}, 'Tool Name'),
        el('th', { style: 'text-align:right' }, 'Total Calls'),
        el('th', {}, 'Last Seen'))));
      const tb = el('tbody');
      audit.distinct_tools.forEach(r => tb.appendChild(el('tr', {},
        el('td', {}, el('code', { style: 'font-size:12px' }, r.tool_name)),
        el('td', { style: 'text-align:right' }, String(r.total_count)),
        el('td', {}, formatDateTime(r.last_seen)))));
      t.appendChild(tb);
      auditBody.appendChild(t);

      // Per-source breakdown (collapsible)
      const details = el('details', { style: 'margin-top:12px' });
      details.appendChild(el('summary', { style: 'cursor:pointer;font-size:12px;color:var(--text-muted)' }, 'Show breakdown by phase'));
      const bt = el('table', { className: 'dr-compact-table', style: 'width:100%;margin-top:8px' });
      bt.appendChild(el('thead', {}, el('tr', {},
        el('th', {}, 'Phase'), el('th', {}, 'Tool'), el('th', { style: 'text-align:right' }, 'Calls'), el('th', {}, 'Last Seen'))));
      const bb = el('tbody');
      audit.by_source.forEach(r => bb.appendChild(el('tr', {},
        el('td', {}, el('span', { className: 'badge' }, (r.source || '').replace(/_/g, ' '))),
        el('td', {}, el('code', { style: 'font-size:12px' }, r.tool_name)),
        el('td', { style: 'text-align:right' }, String(r.count)),
        el('td', {}, formatDateTime(r.last_seen)))));
      bt.appendChild(bb);
      details.appendChild(bt);
      auditBody.appendChild(details);
    }
  } catch (err) {
    auditBody.appendChild(el('p', { style: 'color:var(--danger)' }, 'Failed to load tool call audit: ' + err.message));
  }
}

function stat(label, value) {
  return el('div', {},
    el('div', { style: 'font-size:22px;font-weight:700' }, String(value)),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, label));
}
