#!/usr/bin/env node
/**
 * generate-swimlane.js — Agentic SDLC Workbench Skill
 *
 * Generates a professional swimlane diagram from a workbench workflow
 * and saves it as a PNG (or SVG) file ready to paste into PowerPoint or Word.
 *
 * Usage:
 *   node skills/generate-swimlane.js --project <project_id_or_code> [options]
 *
 * Options:
 *   --project  <id>      Project ID (UUID) or project_code (e.g. EXX)      [required]
 *   --workflow <id|slug> Workflow UUID or slug (e.g. WF-001). Defaults to first workflow.
 *   --out      <path>    Output file path. Default: ./swimlane-<slug>.<format>
 *   --format   png|svg   Output format. Default: png
 *   --base-url <url>     Workbench base URL. Default: http://localhost:3000
 *
 * Requirements:
 *   - Node 18+ (uses built-in fetch — no extra npm installs)
 *   - Workbench server running at --base-url
 *   - Internet access to https://kroki.io (renders PlantUML → image, free, no API key)
 *
 * Example:
 *   node skills/generate-swimlane.js --project EE000000-0000-0000-0000-000000000010
 *   node skills/generate-swimlane.js --project EXX --workflow WF-001 --format svg
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── CLI arg parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

const PROJECT_ARG  = getArg('--project');
const WORKFLOW_ARG = getArg('--workflow');
const OUT_ARG      = getArg('--out');
const FORMAT       = (getArg('--format') || 'png').toLowerCase();
const BASE_URL     = (getArg('--base-url') || 'http://localhost:3000').replace(/\/$/, '');

if (!PROJECT_ARG) {
  console.error('Error: --project is required.\n');
  console.error('Usage: node skills/generate-swimlane.js --project <project_id_or_code> [--workflow <id|slug>] [--out <file>] [--format png|svg]');
  process.exit(1);
}
if (!['png', 'svg'].includes(FORMAT)) {
  console.error('Error: --format must be png or svg');
  process.exit(1);
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function apiGet(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

// ─── Step 1: resolve project ──────────────────────────────────────────────────

async function resolveProject() {
  const data = await apiGet('/api/v1/projects');
  const projects = data.projects || data;
  // match by UUID or project_code
  const arg = PROJECT_ARG.toUpperCase();
  const proj = projects.find(p =>
    p.project_id === PROJECT_ARG ||
    (p.project_code || '').toUpperCase() === arg ||
    (p.project_code || '').toUpperCase().startsWith(arg) ||
    (p.project_name || '').toLowerCase().includes(PROJECT_ARG.toLowerCase())
  );
  if (!proj) {
    const codes = projects.map(p => `${p.project_code} (${p.project_id.slice(0,8)}…)`).join(', ');
    throw new Error(`Project "${PROJECT_ARG}" not found. Available: ${codes}`);
  }
  return proj;
}

// ─── Step 2: fetch workflow data ──────────────────────────────────────────────

async function resolveWorkflow(projectId) {
  const data = await apiGet(`/api/v1/projects/${projectId}/design-report/workflows`);
  const workflows = data.workflows || [];
  if (workflows.length === 0) throw new Error('No workflows found for this project.');

  let wf;
  if (WORKFLOW_ARG) {
    wf = workflows.find(w => w.workflow_id === WORKFLOW_ARG || w.slug === WORKFLOW_ARG);
    if (!wf) {
      const slugs = workflows.map(w => `${w.slug} "${w.name}"`).join(', ');
      throw new Error(`Workflow "${WORKFLOW_ARG}" not found. Available: ${slugs}`);
    }
  } else {
    wf = workflows[0];
    if (workflows.length > 1) {
      console.log(`ℹ  Multiple workflows found. Using first: ${wf.slug} "${wf.name}"`);
      console.log(`   Pass --workflow <slug> to choose a specific one.\n`);
    }
  }
  return wf;
}

// ─── Step 3: fetch participant + path data (separate endpoints) ───────────────
// The design-report already includes participants + paths, so nothing extra needed.

// ─── Step 4: build PlantUML ────────────────────────────────────────────────────

function buildPlantUML(wf, projectName) {
  const { steps, participants, paths, name } = wf;

  if (!steps || steps.length === 0) throw new Error('Workflow has no steps.');

  // ── Lookups ──
  const stepById        = Object.fromEntries(steps.map(s => [s.workflow_step_id, s]));
  const participantById = Object.fromEntries(participants.map(p => [p.workflow_participant_id, p]));

  // pathsFrom[stepId] = [path, ...] — non-default paths FIRST, default path LAST
  const pathsFrom = {};
  for (const p of paths) {
    if (!pathsFrom[p.from_step_id]) pathsFrom[p.from_step_id] = [];
    pathsFrom[p.from_step_id].push(p);
  }
  for (const id in pathsFrom) {
    pathsFrom[id].sort((a, b) => Number(a.is_default_path) - Number(b.is_default_path));
  }

  // Lane name for a participant (returns null if not in swimlane)
  const getLane = (pid) => {
    if (!pid) return null;
    const p = participantById[pid];
    if (!p || !p.include_in_swimlane) return null;
    return p.swimlane_display_name || p.human_role_name || 'Unknown';
  };

  // ── Merge-point detection ──
  // For a branching step, find the first downstream step reachable from ALL branches.
  function findMergePoint(stepId) {
    const outs = pathsFrom[stepId] || [];
    if (outs.length < 2) return null;

    const reachableSets = outs.map(p => {
      const reachable = new Set();
      const queue = [p.to_step_id];
      const seen  = new Set();
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        reachable.add(id);
        const s = stepById[id];
        if (!s || s.step_type === 'End' || s.is_end_step) continue;
        for (const np of (pathsFrom[id] || [])) queue.push(np.to_step_id);
        if (seen.size > 100) break; // safety valve
      }
      return reachable;
    });

    // First step (by step_number) that every branch can reach
    return steps
      .slice()
      .sort((a, b) => a.step_number - b.step_number)
      .find(s => reachableSets.every(r => r.has(s.workflow_step_id)))
      ?.workflow_step_id || null;
  }

  // ── PlantUML line accumulator ──
  const lines   = [];
  const visited = new Set();
  let currentLane = null;

  function switchLane(lane) {
    if (lane && lane !== currentLane) {
      lines.push(`|${lane}|`);
      currentLane = lane;
    }
  }

  // Recursive step emitter. Stops before emitting stepId === stopAt.
  function emitStep(stepId, stopAt) {
    if (!stepId || visited.has(stepId) || stepId === stopAt) return;
    visited.add(stepId);

    const step = stepById[stepId];
    if (!step) return;

    const lane     = getLane(step.owner_participant_id);
    const outPaths = pathsFrom[stepId] || [];
    const isBranch = outPaths.length > 1;

    // Switch swimlane if owner changed
    switchLane(lane);

    // ── Emit based on step type ──
    if (step.step_type === 'Start') {
      lines.push('start');
      // If the Start step has a meaningful name, emit it as the first activity
      if (step.name && step.name.toLowerCase() !== 'start') {
        lines.push(`:${step.name};`);
      }
      // Follow the single outgoing path from Start
      const next = outPaths.find(p => p.is_default_path) || outPaths[0];
      emitStep(next?.to_step_id, stopAt);

    } else if (step.step_type === 'End' || step.is_end_step) {
      // If the End step has a meaningful name (not just "End"), show it as a final activity
      if (step.name && step.name.toLowerCase() !== 'end') {
        lines.push(`:${step.name};`);
      }
      lines.push('stop');

    } else if (isBranch) {
      // ── Branching step (Decision or Activity with multiple outgoing paths) ──
      const mergeId    = findMergePoint(stepId);
      const nonDefault = outPaths.filter(p => !p.is_default_path);
      const defaultP   = outPaths.find(p => p.is_default_path) || outPaths[outPaths.length - 1];

      // Emit this step as an activity first (the diamond comes from the if statement)
      if (step.step_type !== 'Decision') {
        lines.push(`:${step.name};`);
      }

      // if/then for the first non-default branch
      const firstBranch = nonDefault[0] || outPaths[0];
      const condition   = firstBranch.branch_condition || firstBranch.branch_label || step.name;
      const yesLabel    = firstBranch.branch_label || 'Yes';
      const noLabel     = defaultP.branch_label    || 'No';

      lines.push(`if (${condition}?) then (${yesLabel})`);
      emitStep(firstBranch.to_step_id, mergeId);

      // elseif for any additional non-default branches
      for (let i = 1; i < nonDefault.length; i++) {
        const p = nonDefault[i];
        lines.push(`elseif (${p.branch_condition || p.branch_label || `Branch ${i + 1}`}?) then (${p.branch_label || `Branch ${i + 1}`})`);
        emitStep(p.to_step_id, mergeId);
      }

      // else for the default path
      lines.push(`else (${noLabel})`);
      emitStep(defaultP.to_step_id, mergeId);

      lines.push('endif');

      // Continue from merge point
      if (mergeId) emitStep(mergeId, stopAt);

    } else {
      // ── Simple activity / approval / notification / wait ──
      const hitlBadge = step.hitl_gate ? '\n<&lock> HITL Review' : '';
      lines.push(`:${step.name}${hitlBadge};`);

      const next = outPaths.find(p => p.is_default_path) || outPaths[0];
      if (next) emitStep(next.to_step_id, stopAt);
    }
  }

  // ── Header ──
  lines.push('@startuml');
  lines.push(`title ${name}\\n<size:10><color:#888888>${projectName}</color></size>`);
  lines.push('');
  lines.push('skinparam swimlaneWidth 240');
  lines.push('skinparam ArrowColor #555555');
  lines.push('skinparam ActivityBorderColor #444444');
  lines.push('skinparam ActivityBackgroundColor #F7F7F7');
  lines.push('skinparam ActivityBorderThickness 1');
  lines.push('skinparam ActivityDiamondBackgroundColor #FFFBE6');
  lines.push('skinparam ActivityDiamondBorderColor #B8960C');
  lines.push('skinparam ActivityStartColor #86BC25');
  lines.push('skinparam ActivityEndColor #86BC25');
  lines.push('skinparam swimlaneBorderColor #CCCCCC');
  lines.push('skinparam swimlaneTitleFontStyle bold');
  lines.push('skinparam swimlaneTitleFontSize 12');
  lines.push('skinparam defaultFontSize 11');
  lines.push('skinparam defaultFontName "Helvetica Neue"');
  lines.push('');

  // ── Emit lane headers for participants that are in the swimlane (ensures all lanes appear) ──
  // PlantUML only shows a lane if content is emitted inside it, so we need to walk the steps.
  const laneParticipants = participants
    .filter(p => p.include_in_swimlane)
    .sort((a, b) => (a.lane_order || 99) - (b.lane_order || 99));

  if (laneParticipants.length === 0) {
    // No participants defined — emit everything in a single default lane
    lines.push('|Workflow|');
    for (const step of steps.sort((a, b) => a.step_number - b.step_number)) {
      if (step.step_type === 'Start') {
        lines.push('start');
      } else if (step.step_type === 'End' || step.is_end_step) {
        if (step.name && step.name.toLowerCase() !== 'end') lines.push(`:${step.name};`);
        lines.push('stop');
      } else {
        lines.push(`:${step.name};`);
      }
    }
    lines.push('@enduml');
    return lines.join('\n');
  }

  // ── Walk from the Start step ──
  const startStep = steps.find(s => s.step_type === 'Start')
    || steps.slice().sort((a, b) => a.step_number - b.step_number)[0];

  // Ensure first lane is emitted before start
  const startLane = getLane(startStep?.owner_participant_id);
  if (startLane) {
    lines.push(`|${startLane}|`);
    currentLane = startLane;
  }

  emitStep(startStep.workflow_step_id, null);

  // Safety net: emit any steps the graph walk missed (disconnected steps)
  for (const step of steps.sort((a, b) => a.step_number - b.step_number)) {
    if (!visited.has(step.workflow_step_id) && step.step_type !== 'End' && !step.is_end_step) {
      const lane = getLane(step.owner_participant_id);
      switchLane(lane);
      lines.push(`:${step.name} [disconnected];`);
    }
  }

  lines.push('@enduml');
  return lines.join('\n');
}

// ─── Step 5: render via kroki.io ──────────────────────────────────────────────

async function renderDiagram(pumlText, format) {
  const KROKI_URL = `https://kroki.io/plantuml/${format}`;
  console.log(`⟳  Sending to kroki.io for ${format.toUpperCase()} rendering...`);

  const res = await fetch(KROKI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: pumlText,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`kroki.io returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    // 1. Resolve project
    console.log(`\n🔍  Resolving project "${PROJECT_ARG}"...`);
    const project = await resolveProject();
    console.log(`✓   Project: ${project.project_name} (${project.project_code})`);

    // 2. Fetch workflow
    console.log(`🔍  Loading workflow data...`);
    const wf = await resolveWorkflow(project.project_id);
    console.log(`✓   Workflow: ${wf.slug} — "${wf.name}"`);
    console.log(`    Steps: ${wf.steps.length}  |  Participants: ${wf.participants.length}  |  Paths: ${wf.paths.length}`);

    // 3. Build PlantUML
    console.log(`⟳   Building PlantUML diagram...`);
    const pumlText = buildPlantUML(wf, project.project_name);

    // 4. Save the .puml source alongside the image (useful for manual edits)
    const slug    = wf.slug || 'workflow';
    const outFile = OUT_ARG || path.resolve(process.cwd(), `swimlane-${slug}.${FORMAT}`);
    const pumlFile = outFile.replace(/\.(png|svg)$/i, '.puml');

    fs.writeFileSync(pumlFile, pumlText, 'utf8');
    console.log(`✓   PlantUML source saved: ${pumlFile}`);

    // 5. Render via kroki.io
    const imageBuffer = await renderDiagram(pumlText, FORMAT);

    // 6. Save output image
    fs.writeFileSync(outFile, imageBuffer);
    console.log(`✓   Diagram saved:         ${outFile}`);
    console.log(`\n🎉  Done! Open ${path.basename(outFile)} and paste into PowerPoint or Word.\n`);

  } catch (err) {
    console.error(`\n❌  Error: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
})();
