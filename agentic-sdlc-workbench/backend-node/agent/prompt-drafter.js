// agent/prompt-drafter.js
//
// Generates a starting system prompt for an Agent design using Claude via the
// Anthropic SDK. When ANTHROPIC_API_KEY is not configured, returns a
// templated stub so local dev still works.
//
// Public interface:
//   async draftAgentSystemPrompt(ctx) → { draft, model, source }
//     where source ∈ { 'claude', 'stub' }
//
// Mirrors the pattern used by agent/claude-processor.js: lazy client, single
// API call (no tool loop), env-key based fallback.
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { withWiki } = require('./wiki-context');

// ── Anthropic client (lazy) ───────────────────────────────────────────────────
let _client;
function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set in .env');
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ── Model config ──────────────────────────────────────────────────────────────
const aiConfig   = require('./ai-config');
const MAX_TOKENS = 2048;

// ── Helpers ──────────────────────────────────────────────────────────────────
function hasKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  return !!k && k.trim() !== '' && k !== 'paste-your-anthropic-key-here' && k !== 'your_anthropic_api_key_here';
}

function bulletList(items, fallback = '_(none specified)_') {
  if (!Array.isArray(items) || items.length === 0) return fallback;
  return items.map(x => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n');
}

// ── Stub fallback ────────────────────────────────────────────────────────────
function stubDraft(ctx) {
  const name = ctx.name || 'this agent';
  const scope = ctx.scope || '(scope to be defined)';
  const goalsList = bulletList(ctx.goals);
  const doneList = bulletList(ctx.done_criteria);
  const toolsLine = (ctx.tools && ctx.tools.length)
    ? ctx.tools.map(t => `\`${t.name}\``).join(', ')
    : '_(no tools bound)_';

  return [
    `# System Prompt — ${name}`,
    '',
    `## Role`,
    `You are **${name}**, an agent operating within the ${ctx.workflow_name || 'designated workflow'} for the ${ctx.use_case_title || 'business use case'}.`,
    '',
    `## Scope`,
    scope,
    '',
    `## Goals`,
    goalsList,
    '',
    `## Done Criteria`,
    doneList,
    '',
    `## Available Tools`,
    toolsLine,
    '',
    `## Operating Rules`,
    `- Stay strictly within your defined scope and goals.`,
    `- When uncertain, escalate to a human reviewer rather than guess.`,
    `- Cite the tool you used and the inputs you passed for every action you take.`,
    `- Never invent data — if required input is missing, request it via the configured handoff channel.`,
    '',
    `_This is a stub draft generated without an Anthropic API key. Set ANTHROPIC_API_KEY in backend-node/.env to enable Claude-drafted prompts._`,
  ].join('\n');
}

// ── Claude-drafted version ───────────────────────────────────────────────────
function buildClaudePrompt(ctx) {
  // Construct a single user message that gives Claude all the agent context.
  const sections = [];
  sections.push(`You are designing the **starting system prompt** that will be used to control an AI agent. The agent details below come from a structured design workbench. Write a clear, production-ready system prompt the engineer can refine.`);
  sections.push('');
  sections.push(`# Agent context`);
  sections.push('');
  sections.push(`**Agent name:** ${ctx.name || '(unnamed)'}`);
  if (ctx.scope)         sections.push(`**Scope:** ${ctx.scope}`);
  if (ctx.use_case_title) sections.push(`**Use case:** ${ctx.use_case_title}`);
  if (ctx.workflow_name)  sections.push(`**Workflow:** ${ctx.workflow_name}`);
  if (ctx.supervision_model)      sections.push(`**Supervision model:** ${ctx.supervision_model}`);
  if (ctx.orchestration_strategy) sections.push(`**Orchestration:** ${ctx.orchestration_strategy}`);
  if (ctx.latency_target)         sections.push(`**Latency target:** ${ctx.latency_target}`);

  if (Array.isArray(ctx.goals) && ctx.goals.length) {
    sections.push('');
    sections.push(`**Goals:**`);
    for (const g of ctx.goals) sections.push(`- ${typeof g === 'string' ? g : JSON.stringify(g)}`);
  }
  if (Array.isArray(ctx.done_criteria) && ctx.done_criteria.length) {
    sections.push('');
    sections.push(`**Done criteria:**`);
    for (const d of ctx.done_criteria) sections.push(`- ${typeof d === 'string' ? d : JSON.stringify(d)}`);
  }
  if (Array.isArray(ctx.tools) && ctx.tools.length) {
    sections.push('');
    sections.push(`**Tools available to the agent:**`);
    for (const t of ctx.tools) {
      const purpose = t.purpose ? ` — ${t.purpose}` : '';
      sections.push(`- \`${t.name}\`${purpose}`);
    }
  }
  if (Array.isArray(ctx.design_risks) && ctx.design_risks.length) {
    sections.push('');
    sections.push(`**Known design risks to address in the prompt:**`);
    for (const r of ctx.design_risks) sections.push(`- ${typeof r === 'string' ? r : JSON.stringify(r)}`);
  }
  if (Array.isArray(ctx.bestPractices) && ctx.bestPractices.length) {
    sections.push('');
    sections.push(`**House rules / platform guidance to honour in this prompt:**`);
    for (const b of ctx.bestPractices) sections.push(`- ${b.title ? b.title + ': ' : ''}${b.rule_text}`);
  }

  sections.push('');
  sections.push(`# Writing instructions`);
  sections.push(`1. Open with a **Role** section that names the agent and frames its purpose in one sentence.`);
  sections.push(`2. Include a **Scope** section listing what the agent will and will not do.`);
  sections.push(`3. Include a **Tools** section that explains when to use each tool and any guardrails on their use.`);
  sections.push(`4. Include a **Done criteria** section that defines when a task is complete.`);
  sections.push(`5. Include an **Operating rules** section covering: handling uncertainty, when to escalate to a human, how to cite tool use and inputs, and never inventing data.`);
  sections.push(`6. Mention the supervision/orchestration model so the agent's autonomy boundary is explicit.`);
  sections.push(`7. Use Markdown headings (##) so it renders cleanly when reviewed and edited.`);
  sections.push(`8. Be concrete and specific — refer to the actual tool names and goals above rather than generic placeholders.`);
  sections.push(`9. Aim for 250–500 words. Output the system prompt only — no preamble, no explanation, no closing remarks.`);

  return sections.join('\n');
}

async function claudeDraft(ctx) {
  const client = getClient();
  const userPrompt = buildClaudePrompt(ctx);
  const model = aiConfig.resolveModel('prompt_drafter');

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: withWiki(),
    messages: [{ role: 'user', content: userPrompt }],
  });

  // Concatenate any text blocks returned.
  const text = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  if (!text) throw new Error('Claude returned no text content for prompt draft.');
  return { text, usage: response.usage, model };
}

// ── Public API ───────────────────────────────────────────────────────────────
/**
 * Draft a starting system prompt for an Agent design.
 * @param {object} ctx
 *   Expected shape: { name, scope, goals[], done_criteria[], tools[],
 *                    use_case_title, workflow_name, supervision_model,
 *                    orchestration_strategy, latency_target, design_risks[] }
 * @returns {Promise<{ draft: string, model: string, source: 'claude'|'stub' }>}
 */
async function draftAgentSystemPrompt(ctx) {
  if (!hasKey()) {
    return { draft: stubDraft(ctx), model: 'stub', source: 'stub' };
  }
  try {
    const { text, usage, model } = await claudeDraft(ctx);
    return { draft: text, model, source: 'claude', usage };
  } catch (err) {
    console.error('[prompt-drafter] Claude call failed, falling back to stub:', err.message);
    return { draft: stubDraft(ctx), model: 'stub', source: 'stub', error: err.message };
  }
}

module.exports = { draftAgentSystemPrompt };
