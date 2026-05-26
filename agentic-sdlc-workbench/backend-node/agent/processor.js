// agent/processor.js — processor router
//
// Picks the real Claude extraction engine when ANTHROPIC_API_KEY is set,
// falls back to the stub processor for local dev without a key.
//
'use strict';

const hasKey =
  process.env.ANTHROPIC_API_KEY &&
  process.env.ANTHROPIC_API_KEY !== 'paste-your-anthropic-key-here';

if (hasKey) {
  console.log('[processor] ANTHROPIC_API_KEY detected — using claude-processor');
  module.exports = require('./claude-processor');
} else {
  console.log('[processor] No ANTHROPIC_API_KEY — falling back to stub-processor');
  module.exports = require('./stub-processor');
}
