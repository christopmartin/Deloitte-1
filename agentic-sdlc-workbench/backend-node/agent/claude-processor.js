// agent/claude-processor.js
//
// Real Claude extraction engine — replaces stub-processor.js.
// Uses Anthropic API with tool use (function calling) to extract structured
// design entities from ingested documents and stage them for human review.
//
// Tool definitions, entity→table mapping, and conflict fields all come from
// agent/entity-registry.js (single source of truth). This module adds:
//   - context-aware extraction (existing-design summary → create/update/delete)
//   - best-practice injection (global house rules from Admin)
//   - live model + extended-thinking selection (Admin AI Settings)
//   - token-usage logging
//
// Same public interface as stub-processor:
//   async processDocument(ingestId)
//   → { extractions_staged, clarifications_raised, round, new_status, threshold }
//
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const { db, generateId } = require('../db');
const registry  = require('./entity-registry');
const aiConfig  = require('./ai-config');

// ── Anthropic client (lazy) ───────────────────────────────────────────────────
let _client;
function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env');
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ── Schema loaded once at startup ─────────────────────────────────────────────
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');

// ── Safety cap on the tool-call agentic loop ──────────────────────────────────
const MAX_API_LOOPS = 10;

// ─────────────────────────────────────────────────────────────────────────────
// TOOL DEFINITIONS — entity tools come from the registry; raise_clarification is
// the one non-entity tool defined locally.
// ─────────────────────────────────────────────────────────────────────────────
const EXTRACTION_TOOLS = [
  ...registry.buildApiTools(),
  {
    name: 'raise_clarification',
    description: [
      'Raise a clarification question when you cannot determine a field with sufficient confidence.',
      'Use this alongside the extraction tool — extract your best guess AND raise the question.',
      'Do NOT use this for things that can be reasonably inferred from the document.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        question_text:      { type: 'string', description: 'The specific, answerable question to ask the user' },
        target_entity_type: { type: 'string', description: 'The entity type this question is about' },
        target_field:       { type: 'string', description: 'The specific field you need clarification on' },
        context_snippet:    { type: 'string', description: 'A short quote or context from the document that prompted this question' },
        why_uncertain:      { type: 'string', description: 'Why the document does not make this clear' },
      },
      required: ['question_text', 'target_entity_type', 'target_field'],
    },
  },
  {
    name: 'get_existing_entity',
    description: [
      'Fetch the FULL current record of an existing design entity by its slug, so you can reconcile',
      'EVERY field before proposing an update or delete. The existing-design list shows only names —',
      'not field values — so you MUST call this before any operation=update/delete to see what is',
      'actually stored. Use the slug and entity_type exactly as shown in the existing-design list.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        slug:        { type: 'string', description: 'The slug from the existing-design list, e.g. "T-002"' },
        entity_type: { type: 'string', description: 'The entity_type from the existing-design list, e.g. "tool"' },
      },
      required: ['slug', 'entity_type'],
    },
  },
];

// ── tool name → entity_type (from registry) ───────────────────────────────────
const TOOL_TO_ENTITY = registry.toolToEntity();

/**
 * Fetch a single existing entity's full current record by slug, for the
 * get_existing_entity lookup tool. Returns a cleaned object (internal/audit
 * columns dropped, JSON string columns parsed) or null when not found.
 */
function fetchExistingEntity(projectId, entityType, slug) {
  if (!projectId || !entityType || !slug) return null;
  const e = registry.byEntityType[entityType];
  if (!e || !e.table) return null;
  let row;
  try {
    row = db.prepare(
      `SELECT * FROM ${e.table}
       WHERE project_id = ? AND slug = ?
         AND (lifecycle_status IS NULL OR lifecycle_status != 'retired')`
    ).get(projectId, slug);
  } catch { return null; }
  if (!row) return null;

  const DROP = new Set(['created_by', 'updated_by', 'created_at', 'updated_at', 'project_id', 'version', 'visibility_scope']);
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (DROP.has(k)) continue;
    if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
      try { out[k] = JSON.parse(v); continue; } catch { /* keep as string */ }
    }
    out[k] = v;
  }
  return out;
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function getCurrentRound(ingestId) {
  const row = db.prepare(
    'SELECT MAX(round) AS r FROM asdlc_ingest_clarification WHERE ingest_id = ?'
  ).get(ingestId);
  return (row?.r ?? 0) + 1;
}

function getAnsweredClarifications(ingestId) {
  return db.prepare(
    'SELECT * FROM asdlc_ingest_clarification WHERE ingest_id = ? AND answer_text IS NOT NULL ORDER BY round, created_at'
  ).all(ingestId);
}

/**
 * Build a compact, token-bounded snapshot of the application's existing design so
 * Claude can match new requirements against current entities (create vs update vs
 * delete). Iterates registry entries flagged summarizable. Returns '' for a brand
 * new application.
 */
function buildExistingDesignSummary(projectId) {
  if (!projectId) return '';
  const CAP = 150;
  const lines = [];
  let total = 0;
  let omitted = 0;

  for (const e of registry.REGISTRY) {
    if (!e.summarizable || !e.materializable) continue;
    const nameKey = e.nameKeys && e.nameKeys[0];
    const nameCol = nameKey && e.fieldMap && e.fieldMap[nameKey] ? e.fieldMap[nameKey].col : null;
    if (!nameCol) continue;

    let rows;
    try {
      rows = db.prepare(
        `SELECT slug, ${nameCol} AS nm FROM ${e.table}
         WHERE project_id = ? AND (lifecycle_status IS NULL OR lifecycle_status != 'retired')
         ORDER BY slug`
      ).all(projectId);
    } catch { continue; }

    for (const r of rows) {
      if (total >= CAP) { omitted++; continue; }
      const slug = r.slug || '(no-slug)';
      lines.push(`  ${slug} | ${e.entity_type} | "${String(r.nm || '').slice(0, 80)}"`);
      total++;
    }
  }

  if (omitted > 0) lines.push(`  (… ${omitted} more entities omitted for brevity)`);
  return lines.join('\n');
}

/** Upsert an extraction row — match on entity_type + primary name field to avoid duplicates on re-runs. */
function upsertExtraction(ingestId, entityType, entityData, confidence, status, round) {
  const keyValue = registry.entityName(entityType, entityData) ||
    entityData.title || entityData.name || entityData.rule_name ||
    entityData.gate_name || entityData.segment_name || entityData.source_name ||
    entityData.control_name ||
    (entityData.role && entityData.want ? `${entityData.role}::${entityData.want}` : null);

  let existingId = null;

  if (keyValue) {
    const rows = db.prepare(
      "SELECT extraction_id, entity_data FROM asdlc_ingest_extraction WHERE ingest_id=? AND entity_type=?"
    ).all(ingestId, entityType);

    for (const row of rows) {
      try {
        const d = JSON.parse(row.entity_data);
        const k = registry.entityName(entityType, d) ||
          d.title || d.name || d.rule_name ||
          d.gate_name || d.segment_name || d.source_name ||
          d.control_name ||
          (d.role && d.want ? `${d.role}::${d.want}` : null);
        if (k === keyValue) { existingId = row.extraction_id; break; }
      } catch { /* skip unparseable rows */ }
    }
  }

  if (existingId) {
    db.prepare(
      "UPDATE asdlc_ingest_extraction SET entity_data=?, confidence=?, status=?, round=? WHERE extraction_id=?"
    ).run(JSON.stringify(entityData), confidence, status, round, existingId);
    return existingId;
  }

  const id = generateId();
  db.prepare(`
    INSERT INTO asdlc_ingest_extraction
      (extraction_id, ingest_id, entity_type, entity_data, confidence, status, round, created_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))
  `).run(id, ingestId, entityType, JSON.stringify(entityData), confidence, status, round);
  return id;
}

/** Write a clarification question — skip if an open question already exists for the same field. */
function writeClarification(ingestId, round, q) {
  q = q || {};
  // The model may omit question_text or name it differently. node:sqlite cannot bind
  // `undefined`, so coerce to a safe string and skip (rather than crash the whole
  // extraction) when there is genuinely no question to ask.
  const questionText = String(q.question_text || q.question || q.text || '').trim();
  if (!questionText) {
    console.warn('[claude-processor] raise_clarification with no question text — skipping');
    return false;
  }
  const targetEntityType = String(q.target_entity_type || 'general');
  const targetField      = String(q.target_field || 'general');
  const contextSnippet   = String(q.context_snippet || q.why_uncertain || '').slice(0, 500);

  const already = db.prepare(
    "SELECT 1 FROM asdlc_ingest_clarification WHERE ingest_id=? AND target_entity_type=? AND target_field=? AND answer_text IS NULL"
  ).get(ingestId, targetEntityType, targetField);
  if (already) return false;

  db.prepare(`
    INSERT INTO asdlc_ingest_clarification
      (clarification_id, ingest_id, round, question_text, context_snippet,
       target_entity_type, target_field, created_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))
  `).run(
    generateId(), ingestId, round,
    questionText, contextSnippet, targetEntityType, targetField
  );
  return true;
}

// ── Prompt builders ───────────────────────────────────────────────────────────
function buildSystemPrompt(doc, threshold, answeredClarifications, existingSummary, bestPractices) {
  const lines = [
    `You are an expert requirements extraction agent for an Agentic AI Software Development Lifecycle (SDLC) Workbench.`,
    ``,
    `Your job: read the document and call the appropriate extraction tool for EVERY design entity you find.`,
    `Call tools repeatedly — one call per entity. Do not combine multiple entities into one tool call.`,
  ];

  if (bestPractices && bestPractices.length > 0) {
    lines.push(
      ``,
      `## Best practices / house rules (FOLLOW THESE)`,
      ...bestPractices.map(b => `  - ${b.title ? b.title + ': ' : ''}${b.rule_text}`),
    );
  }

  lines.push(
    ``,
    `## Confidence rules`,
    `- confidence is on a 0–1 scale and is REQUIRED on every extraction tool call.`,
    `- If confidence >= ${threshold}: extract it. It will be staged for human review.`,
    `- If confidence < ${threshold}: STILL extract it (with your best guess), AND call raise_clarification`,
    `  with a specific answerable question targeting the uncertain field.`,
    `- Be honest. Overconfidence creates bad data. It is better to ask than to guess wrong.`,
    `- Confidence means: how certain are you the extracted FIELD VALUES are accurate — not just that the entity exists.`,
    ``,
    `## What to extract`,
    `  functional_req    — every explicit functional requirement, user need, or system capability`,
    `  nonfunctional_req — every non-functional constraint (performance, security, scalability, compliance, etc.)`,
    `  use_case          — any business objective or automation goal`,
    `  workflow          — any named process or sequence of steps`,
    `  workflow_step     — each individual step within a workflow (one tool call per step)`,
    `  hitl_gate         — any point where a human must review, approve, or decide`,
    `  agent_spec        — any AI agent described or clearly implied`,
    `  tool              — any tool, API, function, query, or integration an agent uses`,
    `  acceptance_criterion — ONE verifiable condition per call; ONLY when the parent Use Case is known`,
    `  test_case         — ONE test scenario per call; link requirement_refs to FR/NFR slugs`,
    `  guardrail         — any rule, constraint, limit, or boundary on agent behaviour`,
    `  user_story        — any requirement stated from a user's perspective`,
    `  data_source       — any system, database, API, or data store mentioned`,
    `  process_segment   — named phases or stages (as-is or to-be analysis)`,
    `  governance_control — any recurring audit, review, or oversight mechanism`,
    ``,
    `## Extraction order — follow this sequence`,
    `  1. functional_req / nonfunctional_req FIRST — they are the source; everything else is derived.`,
    `     Assign a priority (must_have / should_have / could_have / wont_have) to each.`,
    `  2. use_case / workflow / agent_spec / tool — design entities derived from requirements.`,
    `     Set use_case_title on each to link it to the requirement it serves.`,
    `  3. acceptance_criterion — extract ONLY when you can name the parent Use Case exactly.`,
    `     Set req_slug to the FR-### or NFR-### it satisfies (e.g. req_slug: "FR-003").`,
    `     If no Use Case is identifiable, raise a clarification instead of guessing.`,
    `  4. test_case — link scope_entity_name to a Use Case, Workflow, Agent, or Tool you are`,
    `     extracting. Set requirement_refs to the FR/NFR slugs this test validates`,
    `     (e.g. ["FR-003", "NFR-001"]). Use slugs from the existing design or from this`,
    `     extraction — if the FR has no slug yet, reference its title instead and the system`,
    `     will resolve it post-materialization.`,
    ``,
    `## Linking entities`,
    `  - When you extract a workflow, set use_case_title to the use case it belongs to.`,
    `  - When you extract a workflow_step or hitl_gate, set workflow_name to its parent workflow.`,
    `  - When you extract an agent_spec, set use_case_title (and workflow_name if relevant).`,
    `  - When you extract a functional_req or nonfunctional_req, set use_case_title if the`,
    `    associated use case is identifiable in the document (leave blank if not yet designed).`,
    `  - Use the EXACT title/name of an entity you are also extracting, or one already in the existing design.`,
    ``,
    `## What NOT to do`,
    `  - Do not invent entities not present or clearly implied in the document`,
    `  - Do not extract the same entity twice`,
    `  - Do not extract acceptance_criterion or test_case when the parent Use Case is ambiguous — raise a clarification`,
    `  - Do not raise clarification questions for things you can reasonably infer`,
    `  - Do not stop early — read the entire document before concluding`,
  );

  // ── Conflict detection against existing design ──────────────────────────────
  lines.push(
    ``,
    `## Existing design for this application (detect overlaps before creating new)`,
  );
  if (existingSummary && existingSummary.trim()) {
    lines.push(
      `Each line is:  slug | entity_type | "name"`,
      existingSummary,
      ``,
      `For every entity you extract, set these fields:`,
      `  - operation: "create" for a brand-new entity; "update" if it changes one of the entities`,
      `    listed above; "delete" if the document says to remove one.`,
      `  - target_slug: REQUIRED for update/delete — the slug from the list above. NEVER invent a slug.`,
      `  - conflict_classification: net_new | modifies_existing | deletes_existing.`,
      `  - conflict_rationale: one sentence explaining the classification.`,
      `If you are unsure whether something matches an existing entity, prefer operation=create and note the`,
      `possible overlap in conflict_rationale so a human can decide.`,
      ``,
      `### Reconciling updates (IMPORTANT — avoid leaving stale data)`,
      `The list above shows only slugs and names, NOT field values. Before you propose operation=update`,
      `or operation=delete, you MUST call get_existing_entity(slug, entity_type) to load the entity's`,
      `full current record. Then re-emit the COMPLETE entity with EVERY field reconciled — not just the`,
      `one field the document mentions. Only fields you include are written; any field you omit keeps its`,
      `old value.`,
      `Changes ripple: e.g. renaming a tool from a SAP integration to an Oracle one usually also changes`,
      `its error codes (sap_unavailable → oracle_unavailable), access roles ("SAP AP read role" → the`,
      `Oracle equivalent), endpoints, base URLs, and descriptions. Inspect every field of the loaded`,
      `record and update anything that still references the old system, name, or behaviour. Do not leave`,
      `stale values behind.`,
    );
  } else {
    lines.push(
      `This application has no existing design yet — everything you find is brand new.`,
      `Set operation="create" and conflict_classification="net_new" on every entity.`,
    );
  }

  lines.push(
    ``,
    `## Document context`,
    `  Application : ${doc.project_name || 'Unknown'}`,
    `  Document type: ${doc.document_type}`,
    `  Title        : ${doc.document_title}`,
    `  Description  : ${doc.description || 'None provided'}`,
    `  Confidence threshold for this application: ${threshold}`,
  );

  if (answeredClarifications && answeredClarifications.length > 0) {
    lines.push(
      ``,
      `## Clarification answers (use these to improve low-confidence extractions)`,
      ...answeredClarifications.map(a =>
        `  [Round ${a.round} | ${a.target_entity_type}.${a.target_field}]\n  Q: ${a.question_text}\n  A: ${a.answer_text}`
      ),
      ``,
      `Focus on re-extracting items that had low confidence in previous rounds.`,
      `Do NOT re-extract items that were already confidently staged.`
    );
  }

  lines.push(
    ``,
    `## Workbench database schema`,
    `Use the column names below as a guide for what fields to populate in each tool call.`,
    ``,
    SCHEMA_SQL
  );

  return lines.join('\n');
}

function buildUserMessage(doc, round, threshold) {
  if (round === 1) {
    return (
      `Please analyse the following document and extract all design entities.\n\n` +
      `---\n\n${doc.raw_text}`
    );
  }

  // Subsequent rounds — only re-process items that need clarification
  const uncertain = db.prepare(
    "SELECT entity_type, entity_data, confidence FROM asdlc_ingest_extraction WHERE ingest_id=? AND status='needs_clarification'"
  ).all(doc.ingest_id);

  const summary = uncertain.map(u => {
    const d = JSON.parse(u.entity_data);
    const name = d.title || d.name || d.rule_name || d.gate_name || d.segment_name || u.entity_type;
    return `  - ${u.entity_type}: "${name}" (previous confidence ${Math.round(u.confidence * 100)}%)`;
  }).join('\n');

  return [
    `Clarification answers have been provided (see system prompt).`,
    ``,
    `The following items were previously below the ${threshold} confidence threshold:`,
    summary || '  (none — re-analysing full document)',
    ``,
    `Please re-extract ONLY these items, using the clarification answers to improve accuracy.`,
    `Do not re-extract items that were already staged (above threshold).`,
    ``,
    `Original document for reference:\n---\n${doc.raw_text}`,
  ].join('\n');
}

// ── Agentic extraction loop ───────────────────────────────────────────────────
async function runExtractionLoop(systemPrompt, userMessage, usageCtx) {
  const client = getClient();
  const projectId = usageCtx && usageCtx.projectId;
  const allToolUses = [];
  let messages = [{ role: 'user', content: userMessage }];
  let loops = 0;

  const model      = aiConfig.resolveModel('extraction');
  const thinkCfg   = aiConfig.getThinkingConfig('extraction');
  let   maxTokens  = aiConfig.getMaxTokens();
  // For Claude 3 budget_tokens thinking, ensure max_tokens > budget
  if (thinkCfg && thinkCfg.thinking && thinkCfg.thinking.budget_tokens) {
    if (maxTokens <= thinkCfg.thinking.budget_tokens) maxTokens = thinkCfg.thinking.budget_tokens + 1024;
  }

  // Accumulate token usage across the whole loop for a single usage row.
  const totalUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  while (loops < MAX_API_LOOPS) {
    loops++;

    const req = {
      model,
      max_tokens: maxTokens,
      system:     systemPrompt,
      tools:      EXTRACTION_TOOLS,
      tool_choice:{ type: 'auto' },
      messages,
    };
    if (thinkCfg) {
      req.thinking = thinkCfg.thinking;
      if (thinkCfg.outputConfig) req.output_config = thinkCfg.outputConfig;
    }

    const response = await client.messages.create(req);

    if (response.usage) {
      totalUsage.input_tokens             += response.usage.input_tokens || 0;
      totalUsage.output_tokens            += response.usage.output_tokens || 0;
      totalUsage.cache_read_input_tokens  += response.usage.cache_read_input_tokens || 0;
      totalUsage.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0;
    }

    const toolUses = response.content.filter(b => b.type === 'tool_use');

    console.log(
      `[claude-processor] Loop ${loops} — model ${model}${thinkCfg ? ' +thinking' : ''}, ` +
      `stop_reason: ${response.stop_reason}, tool_uses this turn: ${toolUses.length}, ` +
      `total so far: ${allToolUses.length + toolUses.length}`
    );

    // Lookups (get_existing_entity) are answered inline below — they are NOT
    // extractions, so keep them out of the collected tool-use set.
    allToolUses.push(...toolUses.filter(tu => tu.name !== 'get_existing_entity'));

    // Done when Claude signals end_turn or produces no tool calls
    if (response.stop_reason === 'end_turn' || toolUses.length === 0) break;

    // Build tool results (one per tool_use) and continue the conversation.
    // get_existing_entity returns the full current record so Claude can reconcile
    // every field on an update/delete; everything else is just acknowledged.
    const toolResults = toolUses.map(tu => {
      if (tu.name === 'get_existing_entity') {
        const slug = tu.input && tu.input.slug;
        const etype = tu.input && tu.input.entity_type;
        const rec = fetchExistingEntity(projectId, etype, slug);
        return {
          type:        'tool_result',
          tool_use_id: tu.id,
          content:     rec
            ? JSON.stringify(rec)
            : `No active entity found for slug "${slug}" (entity_type "${etype}"). It may not exist or may already be retired — prefer operation=create and note the uncertainty in conflict_rationale.`,
        };
      }
      return { type: 'tool_result', tool_use_id: tu.id, content: 'Recorded.' };
    });

    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user',      content: toolResults },
    ];
  }

  if (loops >= MAX_API_LOOPS) {
    console.warn(`[claude-processor] Hit MAX_API_LOOPS (${MAX_API_LOOPS}) — extraction may be incomplete`);
  }

  // Record token usage for this run (never throws)
  if (usageCtx) {
    const cost = aiConfig.logUsage({
      projectId: usageCtx.projectId,
      source:    usageCtx.source || 'ingest_extraction',
      refId:     usageCtx.ingestId,
      model,
      round:     usageCtx.round,
      usage:     totalUsage,
    });
    console.log(
      `[claude-processor] Usage — in:${totalUsage.input_tokens} out:${totalUsage.output_tokens}` +
      (cost != null ? ` ~$${cost.toFixed(4)}` : '')
    );
  }

  return allToolUses;
}

// ── Forced reconciliation pass (no reliance on the model choosing to look up) ──
//
// After pass 1, the server deterministically finds every update/delete whose
// target_slug resolves to a real entity, loads each one's FULL current record,
// and runs a second pass that hands those records to the model and requires a
// complete reconciled re-emit. This guarantees the model can never update an
// entity while blind to its current field values — the core fix for stale data.

/** Delete a staged extraction row (used to replace a pass-1 item with its reconciled version). */
function deleteExtraction(extractionId) {
  try { db.prepare("DELETE FROM asdlc_ingest_extraction WHERE extraction_id = ?").run(extractionId); }
  catch (err) { console.warn(`[claude-processor] deleteExtraction(${extractionId}) failed: ${err.message}`); }
}

function buildReconcileSystemPrompt(doc, bestPractices) {
  const lines = [
    `You are reconciling UPDATES to existing design entities for the application "${doc.project_name || 'Unknown'}".`,
    ``,
    `You will be given a set of existing entities that the source document changes. For EACH one you`,
    `receive its COMPLETE current stored record (JSON). Your job is to call that entity's extract_<type>`,
    `tool ONCE, re-emitting the FULL reconciled record.`,
  ];

  if (bestPractices && bestPractices.length > 0) {
    lines.push(
      ``,
      `## Best practices / house rules (FOLLOW THESE)`,
      ...bestPractices.map(b => `  - ${b.title ? b.title + ': ' : ''}${b.rule_text}`),
    );
  }

  lines.push(
    ``,
    `## Reconciliation rules (CRITICAL)`,
    `  - Call the extract_<type> tool once per entity listed below — no more, no fewer.`,
    `  - Set operation="update" (or "delete" if the document removes the entity) and target_slug to the`,
    `    slug shown for that entity. Never invent a slug.`,
    `  - Include EVERY field of the entity, not just the ones that change. Any field you omit is LOST —`,
    `    the system only writes fields you provide.`,
    `  - Start from the current record. Change every field affected by the document; keep correct fields`,
    `    exactly as they are.`,
    `  - Propagate ripple effects. A rename or system change cascades: e.g. moving a tool from SAP to`,
    `    Oracle also changes its error codes (sap_unavailable → oracle_unavailable), access roles`,
    `    ("SAP AP read role" → the Oracle equivalent), endpoints, base URLs, contract, and descriptions.`,
    `    Scan the whole record for anything still referencing the old system, name, or behaviour and fix it.`,
    `  - Do NOT introduce new entities or re-emit entities not in the list below.`,
    `  - Set confidence (0–1) and conflict_rationale on each call.`,
    ``,
    `## Workbench database schema`,
    SCHEMA_SQL,
  );

  return lines.join('\n');
}

function buildReconcileUserMessage(doc, targets) {
  const lines = [`## Entities to reconcile (${targets.length})`, ``];
  targets.forEach((t, i) => {
    lines.push(
      `### ${i + 1}. ${t.entityType} — slug ${t.slug} (operation=${t.operation})`,
      `Current stored record:`,
      '```json',
      JSON.stringify(t.current, null, 2),
      '```',
      `What the document changes about it: ${t.proposed.conflict_rationale || '(see document below)'}`,
      ``,
    );
  });
  lines.push(
    `## Source document`,
    `---`,
    doc.raw_text,
    `---`,
    ``,
    `Re-emit each of the ${targets.length} entities above by calling its extract_<type> tool with the`,
    `FULL reconciled record. Remember: omitted fields are lost.`,
  );
  return lines.join('\n');
}

/**
 * Run the forced reconciliation pass. Returns null when there is nothing to
 * reconcile (no update/delete whose target resolves to a real entity).
 * @returns {Promise<null | { corrected: Array, replacedKeys: Set<string> }>}
 */
async function reconcileUpdates(doc, threshold, round, pass1Items, bestPractices) {
  // Find pass-1 update/delete items whose target_slug resolves to a live record.
  const targets = [];
  for (const it of pass1Items) {
    const op = it.entityData.operation;
    if (op !== 'update' && op !== 'delete') continue;
    const slug = it.entityData.target_slug;
    if (!slug) continue;
    const current = fetchExistingEntity(doc.project_id, it.entityType, slug);
    if (!current) continue; // unresolved targets were/are handled as creates downstream
    targets.push({ entityType: it.entityType, slug, operation: op, current, proposed: it.entityData });
  }

  if (targets.length === 0) return null;

  console.log(`[claude-processor] Reconciliation pass — forcing full-record re-emit for ${targets.length} update/delete target(s)`);

  const toolUses = await runExtractionLoop(
    buildReconcileSystemPrompt(doc, bestPractices),
    buildReconcileUserMessage(doc, targets),
    { projectId: doc.project_id, ingestId: doc.ingest_id, round, source: 'ingest_reconcile' }
  );

  // Keep only entity extractions that target one of the slugs we asked about.
  const wanted = new Set(targets.map(t => `${t.entityType}::${t.slug}`));
  const corrected = [];
  const replacedKeys = new Set();
  for (const { name, input } of toolUses) {
    if (name === 'raise_clarification') continue;
    const entityType = TOOL_TO_ENTITY[name];
    if (!entityType) continue;
    const { confidence = 0, confidence_notes, ...entityData } = input;
    const key = `${entityType}::${entityData.target_slug}`;
    if (!wanted.has(key)) continue; // ignore anything we didn't ask to reconcile
    corrected.push({ entityType, entityData, confidence, confidence_notes });
    replacedKeys.add(key);
  }

  console.log(`[claude-processor] Reconciliation pass — reconciled ${corrected.length}/${targets.length} target(s)`);
  return { corrected, replacedKeys };
}

// ── Main entry point ──────────────────────────────────────────────────────────
/**
 * Process an ingest document with the Claude extraction engine.
 * @param {string} ingestId
 * @returns {Promise<{ extractions_staged, clarifications_raised, round, new_status, threshold }>}
 */
async function processDocument(ingestId) {
  // Load doc + project config in one query
  const doc = db.prepare(`
    SELECT d.*, p.project_name, p.confidence_threshold
    FROM asdlc_ingest_document d
    LEFT JOIN asdlc_project p ON p.project_id = d.project_id
    WHERE d.ingest_id = ?
  `).get(ingestId);

  if (!doc) throw new Error(`Ingest document ${ingestId} not found`);
  if (!doc.raw_text) throw new Error('No raw_text found — run text extraction first via the /process endpoint');

  const threshold            = doc.confidence_threshold ?? 0.75;
  const round                = getCurrentRound(ingestId);
  const answeredClarifications = round > 1 ? getAnsweredClarifications(ingestId) : [];
  const existingSummary      = buildExistingDesignSummary(doc.project_id);
  const bestPractices        = aiConfig.getActiveBestPractices(Object.keys(registry.byEntityType));

  console.log(
    `[claude-processor] Starting — ingest ${ingestId}, round ${round}, threshold ${threshold}, ` +
    `model ${aiConfig.resolveModel('extraction')}, existing-design lines: ${existingSummary ? existingSummary.split('\n').length : 0}`
  );

  // Mark as processing
  db.prepare("UPDATE asdlc_ingest_document SET ingest_status='processing', updated_at=datetime('now') WHERE ingest_id=?")
    .run(ingestId);

  // ── Call Claude ────────────────────────────────────────────────────────────
  let allToolUses;
  try {
    allToolUses = await runExtractionLoop(
      buildSystemPrompt(doc, threshold, answeredClarifications, existingSummary, bestPractices),
      buildUserMessage(doc, round, threshold),
      { projectId: doc.project_id, ingestId, round }
    );
  } catch (err) {
    console.error('[claude-processor] API error:', err.message);
    db.prepare(
      "UPDATE asdlc_ingest_document SET ingest_status='failed', processing_notes=?, updated_at=datetime('now') WHERE ingest_id=?"
    ).run(`Claude API error: ${err.message}`, ingestId);
    throw err;
  }

  // ── Process tool call results (pass 1) ─────────────────────────────────────
  let clarified  = 0;
  const pass1Items = [];                 // entity extractions, with their row id
  const itemKeyToExId = new Map();       // "<type>::<target_slug>" → extraction_id (for reconcile replacement)

  for (const { name, input } of allToolUses) {
    // One malformed tool call must never abort the whole extraction round — log and
    // continue so the remaining (good) entities are still staged.
    try {
      // ── Clarification question ────────────────────────────────────────────
      if (name === 'raise_clarification') {
        if (writeClarification(ingestId, round, input)) clarified++;
        continue;
      }

      const entityType = TOOL_TO_ENTITY[name];
      if (!entityType) {
        console.warn(`[claude-processor] Unknown tool name: ${name} — skipping`);
        continue;
      }

      // Strip meta fields before storing entity_data
      const { confidence = 0, confidence_notes, ...entityData } = input;
      const status = confidence >= threshold ? 'staged' : 'needs_clarification';

      const exId = upsertExtraction(ingestId, entityType, entityData, confidence, status, round);
      pass1Items.push({ exId, entityType, entityData, confidence });
      if (entityData.target_slug) itemKeyToExId.set(`${entityType}::${entityData.target_slug}`, exId);

      if (status !== 'staged' && confidence_notes) {
        // Claude signalled uncertainty but didn't raise a question — auto-generate one
        const autoRaised = writeClarification(ingestId, round, {
          question_text:      `The "${entityData.name || entityData.title || entityData.rule_name || entityType}" extraction has low confidence (${Math.round(confidence * 100)}%). ${confidence_notes} Can you provide more detail?`,
          target_entity_type: entityType,
          target_field:       'general',
          context_snippet:    confidence_notes,
        });
        if (autoRaised) clarified++;
      }
    } catch (err) {
      console.error(`[claude-processor] tool call "${name}" failed — skipping this item: ${err.message}`);
    }
  }

  // ── Pass 2: forced reconciliation of update/delete targets ─────────────────
  // Never fatal — if the reconciliation call fails we keep the pass-1 versions.
  try {
    const result = await reconcileUpdates(doc, threshold, round, pass1Items, bestPractices);
    if (result && result.corrected.length) {
      for (const c of result.corrected) {
        const key   = `${c.entityType}::${c.entityData.target_slug}`;
        const oldId = itemKeyToExId.get(key);
        if (oldId) deleteExtraction(oldId);   // drop the blind pass-1 version
        const status = c.confidence >= threshold ? 'staged' : 'needs_clarification';
        upsertExtraction(ingestId, c.entityType, c.entityData, c.confidence, status, round);
      }
    }
  } catch (err) {
    console.warn(`[claude-processor] Reconciliation pass failed — keeping pass-1 updates: ${err.message}`);
  }

  // Recompute the staged count from the DB so it reflects both passes
  // (reconciliation may have replaced some pass-1 rows).
  const staged = db.prepare(
    "SELECT COUNT(*) AS c FROM asdlc_ingest_extraction WHERE ingest_id=? AND round=? AND status='staged'"
  ).get(ingestId, round).c;

  // ── Determine final document status ───────────────────────────────────────
  const openQ = db.prepare(
    "SELECT COUNT(*) AS c FROM asdlc_ingest_clarification WHERE ingest_id=? AND answer_text IS NULL"
  ).get(ingestId).c;

  const newStatus = openQ > 0 ? 'review_required' : 'staged';

  db.prepare(
    "UPDATE asdlc_ingest_document SET ingest_status=?, updated_at=datetime('now') WHERE ingest_id=?"
  ).run(newStatus, ingestId);

  console.log(
    `[claude-processor] Complete — staged: ${staged}, clarifications: ${clarified}, ` +
    `open questions: ${openQ}, status: ${newStatus}`
  );

  return { extractions_staged: staged, clarifications_raised: clarified, round, new_status: newStatus, threshold };
}

module.exports = { processDocument };
