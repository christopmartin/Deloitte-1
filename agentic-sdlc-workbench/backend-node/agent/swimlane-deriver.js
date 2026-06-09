// agent/swimlane-deriver.js
//
// DETERMINISTIC (non-AI) swimlane backfill for ingested workflows.
//
// PROBLEM IT SOLVES
// -----------------
// The AI ingest pipeline extracts workflow_step rows with `actor_role` as free
// text ("Plant Matcher (AI agent)", "Onboarding Coordinator", "System / CRM"),
// but the entity registry has NO extraction type for workflow PARTICIPANTS or
// PATHS, and nothing sets each step's owner_participant_id. The swimlane renderer
// (swimlane.js) is built entirely around participants → lanes, owner_participant_id
// → lane assignment, and paths → arrows. With none of those populated, every
// ingested workflow renders as: all steps dumped into the red "⚠ Missing Owner"
// lane, no arrows, and (because every step gets topological depth 0) strung out
// in a single flat row. That is the "swimlane is way off" defect.
//
// WHAT THIS DOES
// --------------
// For a workflow, derive the missing relational structure DETERMINISTICALLY from
// what ingest already captured:
//   1. Categorize each step's actor_role into human / AI agent / system and
//      create (deduped) asdlc_workflow_participant lanes, linking AI-agent lanes
//      to their agent_spec when the name matches.
//   2. Set each step's owner_participant_id to its lane.
//   3. If the workflow has NO paths yet, create sequential paths between
//      consecutive steps (a sensible linear default the user can refine).
//
// SAFETY: purely additive + idempotent. Never overwrites a step that already has
// an owner, never touches a workflow that already has paths, never deletes.
// No Claude calls — safe to run inside a DB transaction (e.g. applyChangePacket).
//
'use strict';

const { db, generateId, auditLog, nextSlug } = require('../db');

// ── actor_role → participant categorization ───────────────────────────────────
// Mirrors swimlane.js categoryOf(): a participant is rendered as
//   - 'agent'  when agent_spec_id is set
//   - 'system' when participant_type is Orchestrator/Specialist Agent w/o agent_spec_id
//   - 'human'  when participant_type is Human Role / Human Coordinator
const SYSTEM_HINT  = /\b(system|crm|email|integration|api|erp|database|db|service|platform|gateway|queue|webhook|sap|oracle|servicenow|salesforce)\b/i;
const AGENT_HINT   = /\b(agent|\bai\b|assistant|bot|llm|model|copilot)\b/i;
const COORD_HINT   = /\b(coordinator|manager|admin|administrator|lead|supervisor|approver)\b/i;

/** Strip parentheticals / "System /" prefixes for a clean lane label. */
function cleanDisplay(raw) {
  return String(raw || '')
    .replace(/\s*\((?:ai\s*)?(?:agent|system|bot|assistant)\)\s*/gi, ' ')
    .replace(/^\s*system\s*[\/:|-]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalized key for deduping participants by display label. */
function normKey(s) { return cleanDisplay(s).toLowerCase(); }

/** Find an agent_spec whose name matches the actor_role (case-insensitive, either contains the other). */
function matchAgentSpec(actorRole, agentSpecs) {
  const a = cleanDisplay(actorRole).toLowerCase();
  if (!a) return null;
  for (const spec of agentSpecs) {
    const n = String(spec.name || '').toLowerCase().trim();
    if (!n) continue;
    if (a === n || a.includes(n) || n.includes(a)) return spec;
  }
  return null;
}

/** Decide the participant shape for an actor_role string. Returns null for blank. */
function categorize(actorRole, agentSpecs) {
  const raw = String(actorRole || '').trim();
  if (!raw) return null;
  const display = cleanDisplay(raw) || raw;

  // 1. AI agent — prefer an exact agent_spec link; else an explicit "agent/AI" mention.
  const spec = matchAgentSpec(raw, agentSpecs);
  if (spec) return { participant_type: 'Specialist Agent', agent_spec_id: spec.id, display: spec.name };
  if (AGENT_HINT.test(raw)) return { participant_type: 'Specialist Agent', agent_spec_id: null, display };

  // 2. System lane (Orchestrator Agent w/o agent_spec → rendered as 'system')
  if (SYSTEM_HINT.test(raw)) return { participant_type: 'Orchestrator Agent', agent_spec_id: null, display };

  // 3. Human (default)
  const pt = COORD_HINT.test(raw) ? 'Human Coordinator' : 'Human Role';
  return { participant_type: pt, agent_spec_id: null, display, human_role_name: display };
}

function createParticipant(workflowId, projectId, cat, laneOrder, uid) {
  const id   = generateId();
  const slug = nextSlug('asdlc_workflow_participant', 'P', projectId);
  db.prepare(`
    INSERT INTO asdlc_workflow_participant
      (workflow_participant_id, workflow_id, project_id, slug, participant_type,
       agent_spec_id, human_role_name, swimlane_display_name, lane_order,
       include_in_swimlane, include_in_rasic, notes, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?,?)
  `).run(
    id, workflowId, projectId, slug, cat.participant_type,
    cat.agent_spec_id || null, cat.human_role_name || null, cat.display, laneOrder,
    'Auto-derived from step actor roles during ingest', uid, uid
  );
  auditLog('asdlc_workflow_participant', id, 'INSERT', null, null, uid);
  return db.prepare('SELECT * FROM asdlc_workflow_participant WHERE workflow_participant_id=?').get(id);
}

function createPath(workflowId, projectId, fromId, toId, uid) {
  const id   = generateId();
  const slug = nextSlug('asdlc_workflow_path', 'PATH', projectId);
  db.prepare(`
    INSERT INTO asdlc_workflow_path
      (workflow_path_id, workflow_id, project_id, slug, from_step_id, to_step_id,
       is_default_path, notes, created_by, updated_by)
    VALUES (?,?,?,?,?,?,1,?,?,?)
  `).run(id, workflowId, projectId, slug, fromId, toId,
         'Auto-derived sequential path during ingest', uid, uid);
  auditLog('asdlc_workflow_path', id, 'INSERT', null, null, uid);
  return id;
}

/**
 * Backfill participants, step owners, and (if absent) sequential paths for one workflow.
 * Additive + idempotent. Returns a small summary.
 */
function deriveSwimlane(workflowId, projectId, uid) {
  const steps = db.prepare(
    `SELECT * FROM asdlc_workflow_step
      WHERE workflow_id = ?
        AND COALESCE(lifecycle_status,'') NOT IN ('retired','deleted')
      ORDER BY step_number`
  ).all(workflowId);
  const summary = { participantsCreated: 0, ownersSet: 0, pathsCreated: 0 };
  if (!steps.length) return summary;

  const existing = db.prepare(
    "SELECT * FROM asdlc_workflow_participant WHERE workflow_id = ? AND COALESCE(lifecycle_status,'') != 'deleted'"
  ).all(workflowId);
  const agentSpecs = db.prepare(
    "SELECT agent_spec_id AS id, name FROM asdlc_agent_spec WHERE project_id = ? AND COALESCE(lifecycle_status,'') != 'retired'"
  ).all(projectId);

  // Index existing lanes so we reuse rather than duplicate.
  const partByKey = new Map();
  for (const p of existing) {
    const key = normKey(p.swimlane_display_name || p.human_role_name || '');
    if (key) partByKey.set(key, p);
  }
  let nextOrder = existing.reduce((m, p) => Math.max(m, p.lane_order || 0), -1) + 1;

  // ── 1+2. Participants + step owners ───────────────────────────────────────
  for (const s of steps) {
    if (s.owner_participant_id) continue;          // never overwrite a real owner
    const cat = categorize(s.actor_role, agentSpecs);
    if (!cat) continue;                            // blank actor_role → leave for human review

    let part = partByKey.get(normKey(cat.display));
    if (!part && cat.agent_spec_id) part = existing.find(p => p.agent_spec_id === cat.agent_spec_id) || null;
    if (!part) {
      part = createParticipant(workflowId, projectId, cat, nextOrder++, uid);
      existing.push(part);
      partByKey.set(normKey(cat.display), part);
      summary.participantsCreated++;
    }
    db.prepare('UPDATE asdlc_workflow_step SET owner_participant_id = ?, updated_by = ? WHERE workflow_step_id = ?')
      .run(part.workflow_participant_id, uid, s.workflow_step_id);
    summary.ownersSet++;
  }

  // ── 3. Sequential paths (only when the workflow has none) ─────────────────
  const pathCount = db.prepare('SELECT COUNT(*) AS c FROM asdlc_workflow_path WHERE workflow_id = ?').get(workflowId).c;
  if (pathCount === 0 && steps.length >= 2) {
    for (let i = 0; i < steps.length - 1; i++) {
      const from = steps[i];
      // Don't route out of a terminal/End step into the next listed step.
      if (from.is_end_step || from.step_type === 'End') continue;
      createPath(workflowId, projectId, from.workflow_step_id, steps[i + 1].workflow_step_id, uid);
      summary.pathsCreated++;
    }
  }

  return summary;
}

module.exports = { deriveSwimlane, categorize, cleanDisplay };
