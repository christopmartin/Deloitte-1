// test-req-linker.js — unit tests for the req-linker AI Agent (offline / mock).
// Tests the JSON parsing, error-tolerance, null-match handling, and edge cases
// WITHOUT making a real API call (the Anthropic SDK is monkey-patched).
//
// Run:  node test-req-linker.js   (from backend-node/)
'use strict';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { console.log('  ok  -', m); pass++; } else { console.error('  FAIL-', m); fail++; } };

// ── Monkey-patch Anthropic to return canned responses ────────────────────────
const Module = require('module');
const origLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === '@anthropic-ai/sdk') {
    return class FakeAnthropic {
      constructor() {}
      get messages() {
        return {
          create: async ({ messages }) => {
            const prompt = messages[0].content;
            // Identify which canned scenario to return based on prompt content
            if (prompt.includes('Scenario_A')) {
              return { content: [{ type: 'text', text: JSON.stringify([
                { requirement_title: 'User can log in', use_case_title: 'User Authentication' },
                { requirement_title: 'System emails on signup', use_case_title: 'User Registration' },
              ]) }], usage: { input_tokens: 100, output_tokens: 50 } };
            }
            if (prompt.includes('Scenario_B')) {
              // Cross-cutting NFR → null
              return { content: [{ type: 'text', text: JSON.stringify([
                { requirement_title: 'Uptime 99.9%', use_case_title: null },
              ]) }], usage: {} };
            }
            if (prompt.includes('Scenario_C')) {
              // Bad JSON
              return { content: [{ type: 'text', text: 'I cannot help with that.' }], usage: {} };
            }
            if (prompt.includes('Scenario_D')) {
              // API throws
              throw new Error('API timeout');
            }
            return { content: [], usage: {} };
          }
        };
      }
    };
  }
  return origLoad.call(this, request, ...args);
};

// Stub aiConfig
const origConfig = Module._load;
// We'll patch at module load — ai-config is required inside req-linker
// Use env var override instead
process.env.ANTHROPIC_API_KEY = 'test-key';

// Clear module cache so the monkey-patch applies
Object.keys(require.cache).filter(k => k.includes('req-linker') || k.includes('ai-config')).forEach(k => delete require.cache[k]);

const { linkRequirements } = require('./agent/req-linker');

async function main() {
  // ── Scenario A: normal matching ──────────────────────────────────────────────
  console.log('\n--- Scenario A: normal matches ---');
  const orphans_A = [
    { entity_type: 'functional_req',    entity_data: { title: 'User can log in Scenario_A',      description: 'Auth flow' } },
    { entity_type: 'functional_req',    entity_data: { title: 'System emails on signup Scenario_A', description: 'Email notification' } },
  ];
  const ucs_A = [
    { title: 'User Authentication', summary: 'Login and session management' },
    { title: 'User Registration',   summary: 'New user signup' },
  ];
  // Titles won't match because we appended 'Scenario_A' — but the mock uses content check
  // so we need to pass raw titles. Let's use a simpler approach: remove the tag from entity_data.
  const orphans_A2 = [
    { entity_type: 'functional_req', entity_data: { title: 'User can log in',       description: 'Auth flow Scenario_A' } },
    { entity_type: 'functional_req', entity_data: { title: 'System emails on signup', description: 'Email Scenario_A' } },
  ];
  const result_A = await linkRequirements(orphans_A2, ucs_A, 'proj-a');
  assert(result_A['User can log in'] === 'User Authentication', 'FR matched to auth UC');
  assert(result_A['System emails on signup'] === 'User Registration', 'FR matched to registration UC');

  // ── Scenario B: cross-cutting NFR returns null → not in result ───────────────
  console.log('\n--- Scenario B: cross-cutting NFR omitted from result ---');
  const orphans_B = [{ entity_type: 'nonfunctional_req', entity_data: { title: 'Uptime 99.9%', description: 'Availability Scenario_B' } }];
  const ucs_B = [{ title: 'Plant Adoption', summary: 'Adopt a plant' }];
  const result_B = await linkRequirements(orphans_B, ucs_B, 'proj-b');
  assert(!result_B['Uptime 99.9%'], 'Cross-cutting NFR (null) omitted from result map');

  // ── Scenario C: bad JSON → empty result, no throw ────────────────────────────
  console.log('\n--- Scenario C: bad JSON is non-fatal ---');
  const orphans_C = [{ entity_type: 'functional_req', entity_data: { title: 'Some FR', description: 'Scenario_C' } }];
  const result_C = await linkRequirements(orphans_C, [{ title: 'UC One' }], 'proj-c');
  assert(typeof result_C === 'object' && Object.keys(result_C).length === 0, 'Bad JSON → empty result (no throw)');

  // ── Scenario D: API throws → empty result, no throw ─────────────────────────
  console.log('\n--- Scenario D: API error is non-fatal ---');
  const orphans_D = [{ entity_type: 'functional_req', entity_data: { title: 'FR D', description: 'Scenario_D' } }];
  const result_D = await linkRequirements(orphans_D, [{ title: 'UC One' }], 'proj-d');
  assert(typeof result_D === 'object' && Object.keys(result_D).length === 0, 'API error → empty result (no throw)');

  // ── Edge: empty inputs → skip API call ──────────────────────────────────────
  console.log('\n--- Edge cases ---');
  const result_empty1 = await linkRequirements([], [{ title: 'UC' }], 'p');
  assert(Object.keys(result_empty1).length === 0, 'Empty orphan list → no call, empty result');
  const result_empty2 = await linkRequirements([{ entity_type: 'functional_req', entity_data: { title: 'FR' } }], [], 'p');
  assert(Object.keys(result_empty2).length === 0, 'Empty UC list → no call, empty result');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('TEST ERROR', e); process.exit(1); });
