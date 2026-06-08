// agent/req-linker.js
//
// AI Agent that matches orphan FRs/NFRs to their parent use cases at promote time.
//
// Background: the extraction AI Agent extracts FRs/NFRs in pass 1 (before use cases),
// so it may not yet know the exact use case titles to set on use_case_title. The
// re-linker runs as a cheap post-extraction pass: it sees the full list of orphan
// requirements AND the use cases being promoted in the same packet (or already in the
// DB), and infers the parent relationship for each unlinked requirement.
//
// Design contract:
//   - Uses claude-haiku (cheap, fast, single-shot, no tool-use) — never Opus/Sonnet for this.
//   - Non-fatal: if the API call fails or returns nothing, promote continues with
//     unlinked requirements rather than blocking the user.
//   - Returns only CONFIDENT matches — it returns null for cross-cutting NFRs
//     (security, availability) rather than guessing.
//   - Logs token usage via aiConfig.logUsage for the AI Settings cost view.
//
// Exported:
//   async linkRequirements(orphanReqs, useCases, projectId)
//     orphanReqs — extraction objects with entity_data { title, description? }
//     useCases   — [{ title, summary? }] from the same packet + DB
//     projectId  — string, for usage logging
//   → Promise<Object>  map of { requirement_title → use_case_title }
//
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const aiConfig  = require('./ai-config');

// Model resolved at call-time so admin changes take effect without a restart.
// Default: Haiku (fast/cheap lightweight inference). Configurable via Admin AI Settings.
function linkerModel() { return aiConfig.resolveModel('req_linker'); }

/**
 * Match orphan requirements to their parent use cases.
 * Returns a map of { requirement_title → use_case_title } for matched pairs.
 * Titles with no confident match are absent from the returned map.
 */
async function linkRequirements(orphanReqs, useCases, projectId) {
  if (!orphanReqs || !orphanReqs.length) return {};
  if (!useCases  || !useCases.length)  return {};

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return {};

  const client = new Anthropic({ apiKey });

  const reqLines = orphanReqs.map((ex, i) => {
    const d = ex.entity_data || {};
    const tag = ex.entity_type === 'functional_req' ? 'FR' : 'NFR';
    return `${i + 1}. [${tag}] "${d.title}"${d.description ? ': ' + d.description.slice(0, 200) : ''}`;
  }).join('\n');

  const ucLines = useCases.map((uc, i) =>
    `${i + 1}. "${uc.title}"${uc.summary ? ': ' + String(uc.summary).slice(0, 150) : ''}`
  ).join('\n');

  const prompt = [
    'You are a business analyst linking requirements to their parent use cases in a software design repository.',
    '',
    `## Requirements to link (${orphanReqs.length} items without a use case assignment):`,
    reqLines,
    '',
    `## Available use cases (${useCases.length} items):`,
    ucLines,
    '',
    '## Task',
    'For each requirement, identify the use case it most directly supports.',
    'Rules:',
    '  - Use the EXACT title string from the use cases list above.',
    '  - If a functional requirement clearly belongs to one use case, assign it.',
    '  - If a non-functional requirement is genuinely cross-cutting (e.g. "system uptime 99.9%",',
    '    "data encrypted at rest") and applies equally to ALL use cases, set use_case_title to null.',
    '  - Do NOT force a match if you are not reasonably confident — null is better than a wrong link.',
    '  - Do NOT invent use case titles not in the list above.',
    '',
    'Respond with ONLY a JSON array — no markdown fences, no explanation:',
    '[',
    '  { "requirement_title": "exact title from the requirements list", "use_case_title": "exact UC title or null" },',
    '  ...',
    ']',
  ].join('\n');

  let response;
  try {
    const model = linkerModel();
    response = await client.messages.create({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    console.warn('[req-linker] API call failed (non-fatal):', err.message);
    return {};
  }

  // Log usage (non-fatal)
  if (response.usage) {
    try {
      aiConfig.logUsage({
        projectId,
        source: 'req_linker',
        refId:  null,
        model:  linkerModel(),
        usage:  response.usage,
      });
    } catch { /* ignore */ }
  }

  const text = (response.content || []).find(b => b.type === 'text')?.text || '';

  // Extract the JSON array from the response (tolerate minor surrounding text)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn('[req-linker] No JSON array in response — no links applied');
    return {};
  }

  const result = {};
  try {
    const items = JSON.parse(jsonMatch[0]);
    let matched = 0;
    for (const item of items) {
      if (item && item.requirement_title && item.use_case_title) {
        result[item.requirement_title] = item.use_case_title;
        matched++;
      }
    }
    console.log(`[req-linker] Matched ${matched}/${orphanReqs.length} orphan requirements to use cases`);
  } catch (err) {
    console.warn('[req-linker] JSON parse failed (non-fatal):', err.message);
  }

  return result;
}

module.exports = { linkRequirements };
