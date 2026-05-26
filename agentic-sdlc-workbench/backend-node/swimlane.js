/**
 * swimlane.js — Custom horizontal swimlane SVG generator
 *
 * Renders an Agentic SDLC Workbench workflow as a BPMN-style horizontal
 * swimlane diagram (lanes are rows; flow is left-to-right).
 *
 * Lane stack, top → bottom:
 *   1. Humans      (Human Role + Human Coordinator)
 *   2. AI Agents   (any participant with agent_spec_id)
 *   3. Systems     (Orchestrator/Specialist Agent w/ no agent_spec_id — heuristic)
 *   4. Manual      (only if a participant named "Manual"/"Manual Process" exists)
 *   5. Missing     (red banner, only if any steps have NULL owner_participant_id)
 *
 * No external dependencies — pure SVG string generation. Output works in
 * PowerPoint 2016+ / Office 365 and Word natively (paste as picture).
 */

'use strict';

// ─── Layout constants ─────────────────────────────────────────────────────────
const C = {
  titleHeight:     60,
  laneHeaderWidth: 180,
  laneMinHeight:   110,
  laneVPad:        20,    // vertical padding inside each lane row
  stepWidth:       170,
  stepHeight:      60,
  diamondWidth:    150,
  diamondHeight:   90,
  circleRadius:    24,
  colGap:          40,    // horizontal gap between columns
  leftMargin:      20,
  rightMargin:     20,
  topMargin:       20,
  bottomMargin:    20,
  fontFamily:      'Helvetica, Arial, sans-serif',
};

// ─── Colors ───────────────────────────────────────────────────────────────────
const COLOR = {
  laneHumanBg:   '#FBFCFD',
  laneAgentBg:   '#F4FAF6',
  laneSystemBg:  '#F4F5F8',
  laneManualBg:  '#FFF8E1',
  laneMissingBg: '#FDEBEC',
  laneHeaderBg:  '#FFFFFF',
  laneHeaderHuman:   '#E8F0FE',
  laneHeaderAgent:   '#E6F4EA',
  laneHeaderSystem:  '#ECEEF2',
  laneHeaderManual:  '#FFF3CD',
  laneHeaderMissing: '#F8D7DA',
  laneBorder:    '#D9DCE0',
  stepFill:      '#FFFFFF',
  stepBorder:    '#444444',
  stepText:      '#222222',
  approvalBorder:'#9C27B0',
  diamondFill:   '#FFF9E6',
  diamondBorder: '#B8960C',
  startFill:     '#86BC25',  // Deloitte green
  endFill:       '#222222',
  arrow:         '#555555',
  arrowFallback: '#C62828',
  arrowLabel:    '#444444',
  hitlBadge:     '#1F2937',
  missingText:   '#B71C1C',
  title:         '#111111',
  subtitle:      '#888888',
};

// ──────────────────────────────────────────────────────────────────────────────
// Participant categorization
// ──────────────────────────────────────────────────────────────────────────────
/** Bucket a participant into human / agent / system / manual. */
function categoryOf(p) {
  const name = (p.swimlane_display_name || p.human_role_name || '').trim();
  if (/^manual( process)?$/i.test(name)) return 'manual';
  if (p.participant_type === 'Human Role' || p.participant_type === 'Human Coordinator') return 'human';
  if (p.agent_spec_id) return 'agent';
  if (p.participant_type === 'Orchestrator Agent' || p.participant_type === 'Specialist Agent') return 'system';
  return 'system';
}

function categoryWeight(cat) {
  return { human: 1, agent: 2, system: 3, manual: 4, missing: 5 }[cat] || 9;
}

/**
 * Build the ordered lane stack.
 * @param participants  asdlc_workflow_participant rows
 * @param activeOwnerIds  Set of participant IDs that actually own ≥1 step
 * @param hasMissingOwners  true if any step has owner_participant_id NULL
 * @param opts.showEmpty  if true, include participant lanes with zero steps
 */
function buildLanes(participants, activeOwnerIds, hasMissingOwners, opts = {}) {
  const showEmpty = opts.showEmpty === true;
  const lanes = participants
    .filter(p => p.include_in_swimlane !== 0)
    .filter(p => showEmpty || activeOwnerIds.has(p.workflow_participant_id))
    .map(p => ({
      key:        p.workflow_participant_id,
      label:      p.swimlane_display_name || p.human_role_name || (p.agent_name || 'Unknown'),
      category:   categoryOf(p),
      participantIds: new Set([p.workflow_participant_id]),
      laneOrder:  p.lane_order || 99,
    }));

  // Sort: by category (humans, agents, systems, manual), then lane_order
  lanes.sort((a, b) => {
    const dc = categoryWeight(a.category) - categoryWeight(b.category);
    if (dc !== 0) return dc;
    return a.laneOrder - b.laneOrder;
  });

  // Add Missing lane if needed
  if (hasMissingOwners) {
    lanes.push({
      key: '__MISSING__',
      label: '⚠ Missing Owner',
      category: 'missing',
      participantIds: new Set(),
    });
  }

  return lanes;
}

// ──────────────────────────────────────────────────────────────────────────────
// Topological layout — assign each step a column (X) position
// ──────────────────────────────────────────────────────────────────────────────
function computeColumns(steps, paths) {
  // adjacency: predecessors of each step
  const preds = new Map();
  const succs = new Map();
  for (const s of steps) { preds.set(s.workflow_step_id, []); succs.set(s.workflow_step_id, []); }
  for (const p of paths) {
    if (preds.has(p.to_step_id))   preds.get(p.to_step_id).push(p.from_step_id);
    if (succs.has(p.from_step_id)) succs.get(p.from_step_id).push(p.to_step_id);
  }

  // depth = longest path from a "source" (a step with no preds)
  // BFS-like with memoization, cycle-safe via visited
  const depth = new Map();
  function computeDepth(id, stack) {
    if (depth.has(id)) return depth.get(id);
    if (stack.has(id)) return 0; // cycle break
    stack.add(id);
    const ps = preds.get(id) || [];
    let d = 0;
    for (const p of ps) {
      const dp = computeDepth(p, stack);
      if (dp + 1 > d) d = dp + 1;
    }
    stack.delete(id);
    depth.set(id, d);
    return d;
  }
  for (const s of steps) computeDepth(s.workflow_step_id, new Set());

  // Resolve collisions: if two steps in the same lane share a depth, push one right.
  // For simplicity v1: sort steps in each column by step_number, increment depth if
  // they share a lane with a preceding step.
  // (Done after lane assignment — handled in main render flow below.)

  return depth;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function escapeXML(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Wrap long step labels onto multiple <tspan> lines. */
function wrapText(text, maxChars = 22) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) lines.push(cur);
  // cap to 3 lines max — ellipsis the rest
  if (lines.length > 3) {
    lines.length = 3;
    lines[2] = lines[2].replace(/\s*\S+\s*$/, '…');
  }
  return lines;
}

// ──────────────────────────────────────────────────────────────────────────────
// SVG shape builders
// ──────────────────────────────────────────────────────────────────────────────

function renderTextLines(cx, cy, lines, color, fontSize = 12, bold = false) {
  const lh = fontSize + 2;
  const totalH = lh * lines.length;
  const startY = cy - totalH / 2 + fontSize - 2;
  return lines.map((l, i) =>
    `<text x="${cx}" y="${startY + i * lh}" font-family="${C.fontFamily}" font-size="${fontSize}" ` +
    `font-weight="${bold ? 600 : 400}" fill="${color}" text-anchor="middle">${escapeXML(l)}</text>`
  ).join('');
}

function activityRect(x, y, w, h, label, opts = {}) {
  const rx = 6;
  const stroke = opts.border || COLOR.stepBorder;
  const strokeW = opts.thickBorder ? 2.5 : 1.5;
  const lines = wrapText(label, Math.floor(w / 8));
  return `
    <g>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ry="${rx}"
            fill="${COLOR.stepFill}" stroke="${stroke}" stroke-width="${strokeW}"/>
      ${renderTextLines(x + w / 2, y + h / 2, lines, COLOR.stepText, 12, false)}
    </g>`;
}

function diamondShape(cx, cy, w, h, label) {
  const points = [
    [cx, cy - h / 2],
    [cx + w / 2, cy],
    [cx, cy + h / 2],
    [cx - w / 2, cy],
  ].map(p => p.join(',')).join(' ');
  const lines = wrapText(label, Math.floor(w / 9));
  return `
    <g>
      <polygon points="${points}" fill="${COLOR.diamondFill}" stroke="${COLOR.diamondBorder}" stroke-width="1.5"/>
      ${renderTextLines(cx, cy, lines, COLOR.stepText, 11, false)}
    </g>`;
}

function startCircle(cx, cy, r) {
  return `
    <g>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${COLOR.startFill}" stroke="#5C9418" stroke-width="2"/>
    </g>`;
}

function endCircle(cx, cy, r) {
  return `
    <g>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#FFFFFF" stroke="${COLOR.endFill}" stroke-width="2"/>
      <circle cx="${cx}" cy="${cy}" r="${r - 6}" fill="${COLOR.endFill}"/>
    </g>`;
}

function hitlBadge(stepX, stepY, stepW) {
  // Lock icon badge in the top-right corner of a step
  const x = stepX + stepW - 18;
  const y = stepY + 4;
  return `
    <g>
      <rect x="${x - 12}" y="${y}" width="28" height="16" rx="3"
            fill="${COLOR.hitlBadge}"/>
      <text x="${x + 2}" y="${y + 12}" font-family="${C.fontFamily}" font-size="9"
            font-weight="700" fill="#FFFFFF" text-anchor="middle">HITL</text>
    </g>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Arrow rendering — orthogonal (right-angle) routing
// ──────────────────────────────────────────────────────────────────────────────
function orthogonalArrow(x1, y1, x2, y2, opts = {}) {
  const stroke = opts.dashed ? COLOR.arrowFallback : COLOR.arrow;
  const dash = opts.dashed ? 'stroke-dasharray="5,4"' : '';
  // L-shape: right from source to midX, down/up to targetY, right to target
  const midX = (x1 + x2) / 2;
  let path;
  if (Math.abs(y1 - y2) < 4) {
    // Straight horizontal
    path = `M ${x1} ${y1} L ${x2 - 8} ${y2}`;
  } else {
    path = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2 - 8} ${y2}`;
  }
  return `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.6" ${dash}
            marker-end="url(#arrowhead${opts.dashed ? 'Red' : ''})"/>`;
}

function arrowLabel(text, x, y) {
  if (!text) return '';
  const w = Math.max(40, text.length * 6 + 10);
  return `
    <g>
      <rect x="${x - w / 2}" y="${y - 8}" width="${w}" height="16" rx="3"
            fill="#FFFFFF" stroke="${COLOR.laneBorder}" stroke-width="0.5" opacity="0.92"/>
      <text x="${x}" y="${y + 4}" font-family="${C.fontFamily}" font-size="10"
            fill="${COLOR.arrowLabel}" text-anchor="middle">${escapeXML(text)}</text>
    </g>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main entrypoint — builds the full SVG document
// ──────────────────────────────────────────────────────────────────────────────
function buildSwimlaneSVG(wf, projectName) {
  const { steps, participants, paths, name } = wf;
  if (!steps || steps.length === 0) throw new Error('Workflow has no steps');

  // ── 1. Identify steps with missing owners + active owners ──────────────────
  const hasMissingOwners = steps.some(s => !s.owner_participant_id);
  const activeOwnerIds   = new Set(steps.map(s => s.owner_participant_id).filter(Boolean));

  // ── 2. Build lane stack (hide empty lanes by default) ──────────────────────
  const showEmpty = !!(arguments[2] && arguments[2].showEmpty);
  const lanes = buildLanes(participants, activeOwnerIds, hasMissingOwners, { showEmpty });
  if (lanes.length === 0) {
    lanes.push({ key: '__MISSING__', label: '⚠ No Participants Defined', category: 'missing', participantIds: new Set() });
  }

  // Map participantId → lane index
  const laneByParticipant = new Map();
  lanes.forEach((lane, idx) => {
    for (const pid of lane.participantIds) laneByParticipant.set(pid, idx);
  });
  const missingLaneIdx = lanes.findIndex(l => l.category === 'missing');

  // ── 3. Assign step → lane index ─────────────────────────────────────────────
  const stepLane = new Map();
  for (const s of steps) {
    const li = laneByParticipant.has(s.owner_participant_id)
      ? laneByParticipant.get(s.owner_participant_id)
      : missingLaneIdx;
    stepLane.set(s.workflow_step_id, li);
  }

  // ── 4. Compute column positions (topological depth) ─────────────────────────
  let depth = computeColumns(steps, paths);

  // Collision resolution within a lane: if two steps in the same lane share a
  // depth, bump one of them right. Use step_number to break ties.
  const sortedSteps = steps.slice().sort((a, b) => a.step_number - b.step_number);
  const usedByLane = new Map(); // laneIdx → Set<depth>
  for (const s of sortedSteps) {
    const li = stepLane.get(s.workflow_step_id);
    let d = depth.get(s.workflow_step_id) || 0;
    if (!usedByLane.has(li)) usedByLane.set(li, new Set());
    while (usedByLane.get(li).has(d)) d++;
    usedByLane.get(li).add(d);
    depth.set(s.workflow_step_id, d);
  }

  const maxDepth = Math.max(...Array.from(depth.values()), 0);
  const numCols  = maxDepth + 1;

  // ── 5. Compute SVG dimensions ───────────────────────────────────────────────
  const contentWidth = numCols * (C.stepWidth + C.colGap) + C.colGap;
  const svgWidth     = C.leftMargin + C.laneHeaderWidth + contentWidth + C.rightMargin;

  const laneHeight = C.laneMinHeight;
  const contentTop = C.topMargin + C.titleHeight;
  const laneEnd    = contentTop + lanes.length * laneHeight;
  // Footer (below lanes) holds legend on the left + optional fallback box on the right
  const fallbacks = Array.isArray(wf.fallback_paths) ? wf.fallback_paths : [];
  const fallbackBoxH = fallbacks.length > 0 ? (24 + fallbacks.length * 16) : 0;
  const legendHeight = 30;
  const footerHeight = Math.max(legendHeight, fallbackBoxH) + 20;
  const svgHeight    = laneEnd + footerHeight + C.bottomMargin;

  // Pre-compute X for each column
  const colX = (col) => C.leftMargin + C.laneHeaderWidth + C.colGap + col * (C.stepWidth + C.colGap);
  // Pre-compute Y center for each lane
  const laneCY = (idx) => contentTop + idx * laneHeight + laneHeight / 2;

  // ── 6. Build path lookups ───────────────────────────────────────────────────
  const stepById = Object.fromEntries(steps.map(s => [s.workflow_step_id, s]));
  const outPaths = new Map();
  for (const s of steps) outPaths.set(s.workflow_step_id, []);
  for (const p of paths) {
    if (outPaths.has(p.from_step_id)) outPaths.get(p.from_step_id).push(p);
  }

  // ── 7. Render header (lane bands + labels) ──────────────────────────────────
  const svgParts = [];
  svgParts.push(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>`);
  svgParts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" ` +
    `viewBox="0 0 ${svgWidth} ${svgHeight}">`
  );

  // Arrowhead marker defs
  svgParts.push(`
    <defs>
      <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="strokeWidth">
        <path d="M 0 0 L 8 5 L 0 10 Z" fill="${COLOR.arrow}"/>
      </marker>
      <marker id="arrowheadRed" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="strokeWidth">
        <path d="M 0 0 L 8 5 L 0 10 Z" fill="${COLOR.arrowFallback}"/>
      </marker>
    </defs>
  `);

  // Background
  svgParts.push(`<rect x="0" y="0" width="${svgWidth}" height="${svgHeight}" fill="#FFFFFF"/>`);

  // Title
  svgParts.push(`
    <text x="${svgWidth / 2}" y="28" font-family="${C.fontFamily}" font-size="18" font-weight="700"
          fill="${COLOR.title}" text-anchor="middle">${escapeXML(name)}</text>
    <text x="${svgWidth / 2}" y="48" font-family="${C.fontFamily}" font-size="12"
          fill="${COLOR.subtitle}" text-anchor="middle">${escapeXML(projectName)}</text>
  `);

  // Lane bands
  lanes.forEach((lane, idx) => {
    const y = contentTop + idx * laneHeight;
    const bandBg     = {human:COLOR.laneHumanBg, agent:COLOR.laneAgentBg, system:COLOR.laneSystemBg, manual:COLOR.laneManualBg, missing:COLOR.laneMissingBg}[lane.category] || COLOR.laneHumanBg;
    const headerBg   = {human:COLOR.laneHeaderHuman, agent:COLOR.laneHeaderAgent, system:COLOR.laneHeaderSystem, manual:COLOR.laneHeaderManual, missing:COLOR.laneHeaderMissing}[lane.category] || COLOR.laneHeaderBg;
    const labelColor = lane.category === 'missing' ? COLOR.missingText : COLOR.stepText;

    // Lane content band (right of header)
    svgParts.push(`<rect x="${C.leftMargin + C.laneHeaderWidth}" y="${y}"
                          width="${contentWidth}" height="${laneHeight}"
                          fill="${bandBg}" stroke="${COLOR.laneBorder}" stroke-width="0.5"/>`);
    // Lane header
    svgParts.push(`<rect x="${C.leftMargin}" y="${y}"
                          width="${C.laneHeaderWidth}" height="${laneHeight}"
                          fill="${headerBg}" stroke="${COLOR.laneBorder}" stroke-width="0.5"/>`);
    // Header label — rotated vertical text for true BPMN look
    const cx = C.leftMargin + C.laneHeaderWidth / 2;
    const cy = y + laneHeight / 2;
    const catTag = {human:'Human', agent:'AI Agent', system:'System', manual:'Manual', missing:''}[lane.category] || '';
    svgParts.push(`
      <text x="${cx}" y="${cy - 6}" font-family="${C.fontFamily}" font-size="14" font-weight="700"
            fill="${labelColor}" text-anchor="middle">${escapeXML(lane.label)}</text>
      ${catTag ? `<text x="${cx}" y="${cy + 12}" font-family="${C.fontFamily}" font-size="10"
            fill="${COLOR.subtitle}" text-anchor="middle">${escapeXML(catTag)}</text>` : ''}
    `);
  });

  // ── 8. Render arrows (paths) ────────────────────────────────────────────────
  // First, so steps overlay them
  for (const p of paths) {
    const fromStep = stepById[p.from_step_id];
    const toStep   = stepById[p.to_step_id];
    if (!fromStep || !toStep) continue;
    const fromCol = depth.get(p.from_step_id);
    const toCol   = depth.get(p.to_step_id);
    const fromLane = stepLane.get(p.from_step_id);
    const toLane   = stepLane.get(p.to_step_id);

    const fromX = colX(fromCol) + C.stepWidth;
    const fromY = laneCY(fromLane);
    const toX   = colX(toCol);
    const toY   = laneCY(toLane);

    svgParts.push(orthogonalArrow(fromX, fromY, toX, toY, {}));

    // Label only if there's a branch_label (don't clutter linear arrows)
    if (p.branch_label) {
      const midX = (fromX + toX) / 2;
      const midY = fromLane === toLane ? fromY - 14 : (fromY + toY) / 2;
      svgParts.push(arrowLabel(p.branch_label, midX, midY));
    }
  }

  // ── 9. Render steps ─────────────────────────────────────────────────────────
  for (const s of steps) {
    const col = depth.get(s.workflow_step_id);
    const li  = stepLane.get(s.workflow_step_id);
    const cx  = colX(col) + C.stepWidth / 2;
    const cy  = laneCY(li);

    const isStart    = s.step_type === 'Start';
    const isEnd      = s.step_type === 'End' || s.is_end_step;
    const isDecision = s.step_type === 'Decision' || (outPaths.get(s.workflow_step_id) || []).length > 1;
    const isApproval = s.step_type === 'Approval';
    const hasHitl    = !!s.hitl_gate;

    if (isStart) {
      // Render as labeled rectangle with a small green circle marker on its left
      svgParts.push(`<circle cx="${cx - C.stepWidth / 2 - 18}" cy="${cy}" r="${C.circleRadius - 6}"
                       fill="${COLOR.startFill}" stroke="#5C9418" stroke-width="2"/>`);
      svgParts.push(activityRect(cx - C.stepWidth / 2, cy - C.stepHeight / 2,
                                 C.stepWidth, C.stepHeight, s.name, { thickBorder: false }));
      if (hasHitl) svgParts.push(hitlBadge(cx - C.stepWidth / 2, cy - C.stepHeight / 2, C.stepWidth));
    } else if (isEnd) {
      svgParts.push(activityRect(cx - C.stepWidth / 2, cy - C.stepHeight / 2,
                                 C.stepWidth, C.stepHeight, s.name, { thickBorder: false }));
      // black "end" marker on the right
      svgParts.push(`<circle cx="${cx + C.stepWidth / 2 + 18}" cy="${cy}" r="${C.circleRadius - 6}"
                       fill="#FFFFFF" stroke="${COLOR.endFill}" stroke-width="2"/>`);
      svgParts.push(`<circle cx="${cx + C.stepWidth / 2 + 18}" cy="${cy}" r="${C.circleRadius - 12}"
                       fill="${COLOR.endFill}"/>`);
      if (hasHitl) svgParts.push(hitlBadge(cx - C.stepWidth / 2, cy - C.stepHeight / 2, C.stepWidth));
    } else if (isDecision) {
      svgParts.push(diamondShape(cx, cy, C.diamondWidth, C.diamondHeight, s.name));
      if (hasHitl) svgParts.push(hitlBadge(cx - C.diamondWidth / 2 + 20, cy - C.diamondHeight / 2 + 8, 60));
    } else {
      svgParts.push(activityRect(cx - C.stepWidth / 2, cy - C.stepHeight / 2,
                                 C.stepWidth, C.stepHeight, s.name,
                                 { thickBorder: isApproval, border: isApproval ? COLOR.approvalBorder : undefined }));
      if (hasHitl) svgParts.push(hitlBadge(cx - C.stepWidth / 2, cy - C.stepHeight / 2, C.stepWidth));
    }
  }

  // ── 10. Render fallback paths (workflow-level) as dashed red box in footer ──
  if (fallbacks.length > 0) {
    const cbW = 320;
    const cbX = svgWidth - C.rightMargin - cbW;
    const cbY = laneEnd + 10;
    svgParts.push(`
      <g>
        <rect x="${cbX}" y="${cbY}" width="${cbW}" height="${fallbackBoxH}" rx="4"
              fill="#FFFFFF" stroke="${COLOR.arrowFallback}" stroke-width="1" stroke-dasharray="4,3"/>
        <text x="${cbX + 10}" y="${cbY + 16}" font-family="${C.fontFamily}" font-size="11"
              font-weight="700" fill="${COLOR.arrowFallback}">Fallback paths</text>
        ${fallbacks.map((f, i) =>
          `<text x="${cbX + 10}" y="${cbY + 34 + i * 16}" font-family="${C.fontFamily}" font-size="10"
                 fill="${COLOR.stepText}">• ${escapeXML(String(f).slice(0, 60))}</text>`
        ).join('')}
      </g>
    `);
  }

  // ── 11. Legend (below the lane stack — no overlap) ─────────────────────────
  const legendX = C.leftMargin + 10;
  const legendY = laneEnd + 20;
  svgParts.push(`
    <g font-family="${C.fontFamily}" font-size="10" fill="${COLOR.subtitle}">
      <text x="${legendX}" y="${legendY}">Activity</text>
      <rect x="${legendX + 50}" y="${legendY - 10}" width="22" height="12" rx="2"
            fill="${COLOR.stepFill}" stroke="${COLOR.stepBorder}" stroke-width="1"/>
      <text x="${legendX + 90}" y="${legendY}">Decision</text>
      <polygon points="${legendX + 140},${legendY - 4} ${legendX + 150},${legendY - 10} ${legendX + 160},${legendY - 4} ${legendX + 150},${legendY + 2}"
               fill="${COLOR.diamondFill}" stroke="${COLOR.diamondBorder}"/>
      <text x="${legendX + 180}" y="${legendY}">HITL</text>
      <rect x="${legendX + 210}" y="${legendY - 10}" width="28" height="12" rx="2" fill="${COLOR.hitlBadge}"/>
    </g>
  `);

  svgParts.push(`</svg>`);
  return svgParts.join('\n');
}

module.exports = { buildSwimlaneSVG };
