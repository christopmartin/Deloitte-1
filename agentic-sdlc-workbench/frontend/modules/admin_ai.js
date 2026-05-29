/**
 * modules/admin_ai.js — Administration › AI Settings + Usage
 *
 * Global model selection per agent role, extended-thinking config, max tokens
 * (WI-5), plus a token/cost usage view (WI-8). Settings persist in
 * asdlc_app_setting and take effect without a server restart.
 */
import { apiFetch, el, showToast, formatDateTime } from '../app.js';

const ROLE_FIELDS = [
  { key: 'extraction_model',       label: 'Document extraction',  hint: 'Reads ingested docs → staged design entities' },
  { key: 'quality_reviewer_model', label: 'Quality reviewer',     hint: 'Audits design entities for gaps/conflicts' },
  { key: 'prompt_drafter_model',   label: 'Agent prompt drafter', hint: 'Drafts agent system prompts' },
  { key: 'build_review_model',     label: 'Build-spec AI review', hint: 'Optional review appended to the build export' },
];

function fmtTokens(n) {
  n = Number(n || 0);
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
function fmtCost(n) {
  if (n == null) return '—';
  return '$' + Number(n).toFixed(4);
}

export async function render(container) {
  container.innerHTML = '';
  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'AI Settings'),
    el('p', { className: 'purpose-text' },
      'Choose which Claude model each AI role uses, tune extended thinking and output tokens, ' +
      'and review token usage and estimated cost. Settings are global and apply without a restart.')
  ));

  let config;
  try {
    config = await apiFetch('/settings/ai');
  } catch (err) {
    container.appendChild(el('div', { className: 'error-state' }, 'Failed to load AI settings: ' + err.message));
    return;
  }
  const models = config.available_models || [];
  const s = config.settings || {};

  // ── Settings panel ─────────────────────────────────────────────────────────
  const panel = el('div', { className: 'panel' });
  panel.appendChild(el('div', { className: 'panel-header' }, el('h3', { className: 'panel-title' }, 'Model selection')));
  const body = el('div', { className: 'panel-body', style: 'display:grid;gap:14px;max-width:640px' });
  panel.appendChild(body);

  const inputs = {};
  function modelSelect(key) {
    const sel = el('select', { className: 'form-input' });
    models.forEach(m => {
      const opt = el('option', { value: m.id }, m.label);
      if (s[key] === m.id) opt.selected = true;
      sel.appendChild(opt);
    });
    // If the current value isn't in the catalog (e.g. set via env), show it too
    if (s[key] && !models.some(m => m.id === s[key])) {
      const opt = el('option', { value: s[key] }, s[key] + ' (current)');
      opt.selected = true;
      sel.appendChild(opt);
    }
    inputs[key] = sel;
    return sel;
  }

  ROLE_FIELDS.forEach(rf => {
    body.appendChild(el('div', { className: 'form-group' },
      el('label', { className: 'form-label' }, rf.label),
      modelSelect(rf.key),
      el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' }, rf.hint)
    ));
  });

  // Extended thinking (extraction)
  const thinkWrap = el('div', { className: 'form-group', style: 'border-top:1px solid var(--border);padding-top:12px' });
  const thinkToggle = el('input', { type: 'checkbox' });
  thinkToggle.checked = !!s.extraction_thinking_enabled;
  inputs.extraction_thinking_enabled = thinkToggle;
  thinkWrap.appendChild(el('label', { className: 'form-label', style: 'display:flex;align-items:center;gap:8px' },
    thinkToggle, 'Enable extended thinking for document extraction'));
  thinkWrap.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin:4px 0 8px 0' },
    'Gives Claude more time to reason before extracting. Slower and more expensive, but better on complex or ambiguous documents.'));

  // Effort level (Claude 4: low/medium/high; Claude 3: mapped to budget_tokens internally)
  const effortSel = el('select', { className: 'form-input', style: 'max-width:200px' });
  // Stored as a number (legacy) or string effort level — normalise to effort string for display
  const storedBudget = s.extraction_thinking_budget;
  const toEffort = v => { if (v === 'low' || v === 'medium' || v === 'high') return v; const n = parseInt(v,10); return n < 4000 ? 'low' : n < 8000 ? 'medium' : 'high'; };
  const curEffort = toEffort(storedBudget || 4000);
  [['low','Low — fastest, least token use'],['medium','Medium — balanced (recommended)'],['high','High — deepest reasoning, highest cost']].forEach(([val, label]) => {
    const opt = el('option', { value: val }, label);
    if (curEffort === val) opt.selected = true;
    effortSel.appendChild(opt);
  });
  inputs.extraction_thinking_budget = effortSel;
  thinkWrap.appendChild(el('label', { className: 'form-label' }, 'Thinking effort level'));
  thinkWrap.appendChild(effortSel);
  body.appendChild(thinkWrap);

  // Max tokens
  const maxInput = el('input', { type: 'number', className: 'form-input', min: '1024', step: '512',
    value: s.max_tokens || 8192, style: 'max-width:200px' });
  inputs.max_tokens = maxInput;
  body.appendChild(el('div', { className: 'form-group' },
    el('label', { className: 'form-label' }, 'Max output tokens per call'), maxInput));

  const saveBtn = el('button', { className: 'btn btn-primary' }, 'Save settings');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      const payload = {
        extraction_model:            inputs.extraction_model.value,
        quality_reviewer_model:      inputs.quality_reviewer_model.value,
        prompt_drafter_model:        inputs.prompt_drafter_model.value,
        build_review_model:          inputs.build_review_model.value,
        extraction_thinking_enabled: inputs.extraction_thinking_enabled.checked,
        extraction_thinking_budget:  parseInt(inputs.extraction_thinking_budget.value, 10) || 4000,
        max_tokens:                  parseInt(inputs.max_tokens.value, 10) || 8192,
      };
      await apiFetch('/settings/ai', { method: 'PUT', body: JSON.stringify(payload) });
      showToast('AI settings saved', 'success');
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

    if ((usage.by_model || []).length) {
      usageBody.appendChild(el('h4', { style: 'margin:8px 0' }, 'By model'));
      const mt = el('table', { className: 'dr-compact-table', style: 'width:100%;margin-bottom:16px' });
      mt.appendChild(el('thead', {}, el('tr', {},
        el('th', {}, 'Model'), el('th', { style: 'text-align:right' }, 'Runs'),
        el('th', { style: 'text-align:right' }, 'In'), el('th', { style: 'text-align:right' }, 'Out'),
        el('th', { style: 'text-align:right' }, 'Cost'))));
      const mb = el('tbody');
      usage.by_model.forEach(r => mb.appendChild(el('tr', {},
        el('td', {}, r.model || '—'),
        el('td', { style: 'text-align:right' }, String(r.runs)),
        el('td', { style: 'text-align:right;font-family:monospace' }, fmtTokens(r.input_tokens)),
        el('td', { style: 'text-align:right;font-family:monospace' }, fmtTokens(r.output_tokens)),
        el('td', { style: 'text-align:right;font-family:monospace' }, fmtCost(r.cost_usd)))));
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
}

function stat(label, value) {
  return el('div', {},
    el('div', { style: 'font-size:22px;font-weight:700' }, String(value)),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, label));
}
