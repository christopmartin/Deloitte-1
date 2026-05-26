'use strict';
/**
 * Generates: Agentic Use Case Discovery — Interview Guide.docx
 * Run: node make_interview_guide.js
 *
 * v2 — multi-agent, multi-step workflow edition
 *   + Section 5:  Workflow Architecture & Agent Topology  (NEW)
 *   + Section 6:  Agent Roster & Individual Agent Design  (NEW)
 *   + Section 9:  HITL expanded with agent-to-agent hand-off questions
 *   + Section 11: Edge Cases expanded with cross-agent failure modes
 *   + RASIC CSV updated with agent columns
 *   + New artifacts: Agent Interaction Map, Workflow State Register, Agent Roster
 *   Sections 5–12 from v1 renumbered to 7–14
 */

const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, BorderStyle, ShadingType,
  convertInchesToTwip,
} = require('docx');
const fs = require('fs');

// ── Palette ───────────────────────────────────────────────────────────────────
const NAVY     = '1E3A5F';
const SLATE    = '475569';
const ACCENT   = '2563EB';
const PURPLE   = '5B21B6';
const PURPLE_BG= 'F5F3FF';
const PURPLE_BD= 'A78BFA';
const AMBER    = '92400E';
const AMBER_BG = 'FFFBEB';
const AMBER_BD = 'FCD34D';
const GREEN    = '14532D';
const GREEN_BG = 'F0FDF4';
const GREEN_BD = '86EFAC';
const LIGHT    = 'EFF6FF';
const WHITE    = 'FFFFFF';
const BORDER   = 'CBD5E1';
const MUTED    = '64748B';
const BODY_C   = '1E293B';

// ── Base helpers ──────────────────────────────────────────────────────────────
const sp = (before = 0, after = 0) => ({ before, after });

function cover() {
  return [
    new Paragraph({ spacing: sp(0, 800) }),
    new Paragraph({
      children: [new TextRun({ text: 'AGENTIC SDLC WORKBENCH', bold: true, size: 20, color: ACCENT, allCaps: true })],
      alignment: AlignmentType.CENTER, spacing: sp(0, 100),
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Agentic Use Case Discovery', bold: true, size: 52, color: NAVY })],
      alignment: AlignmentType.CENTER, spacing: sp(0, 80),
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Interview Guide', bold: true, size: 44, color: SLATE })],
      alignment: AlignmentType.CENTER, spacing: sp(0, 400),
    }),
    new Paragraph({
      children: [new TextRun({ text: 'For:  Product Owner / Business Process Owner', size: 22, color: SLATE })],
      alignment: AlignmentType.CENTER, spacing: sp(0, 60),
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Conducted by:  SDLC Methodology Team', size: 22, color: SLATE })],
      alignment: AlignmentType.CENTER, spacing: sp(0, 60),
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Version 2.0  ·  Multi-Agent Workflow Edition  ·  Agentic SDLC Workbench', size: 20, color: MUTED })],
      alignment: AlignmentType.CENTER, spacing: sp(200, 0),
    }),
    new Paragraph({ pageBreakBefore: true }),
  ];
}

function h1(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 30, color: WHITE })],
    heading: HeadingLevel.HEADING_1,
    spacing: sp(360, 120),
    shading: { type: ShadingType.SOLID, color: NAVY, fill: NAVY },
  });
}

function h1purple(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 30, color: WHITE })],
    heading: HeadingLevel.HEADING_1,
    spacing: sp(360, 120),
    shading: { type: ShadingType.SOLID, color: PURPLE, fill: PURPLE },
  });
}

function h2(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 26, color: NAVY })],
    spacing: sp(280, 80),
    border: { bottom: { color: ACCENT, size: 6, style: BorderStyle.SINGLE } },
  });
}

function h3(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 22, color: SLATE })],
    spacing: sp(200, 60),
  });
}

function body(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 20, color: BODY_C })],
    spacing: sp(0, 100),
  });
}

function numbered(text, idx) {
  return new Paragraph({
    children: [
      new TextRun({ text: `${idx}.  `, bold: true, size: 20, color: ACCENT }),
      new TextRun({ text, size: 20, color: BODY_C }),
    ],
    spacing: sp(60, 80),
    indent: { left: convertInchesToTwip(0.3), hanging: convertInchesToTwip(0.3) },
  });
}

function pageBreak() {
  return new Paragraph({ pageBreakBefore: true });
}

function divider() {
  return new Paragraph({
    spacing: sp(120, 120),
    border: { bottom: { color: BORDER, size: 4, style: BorderStyle.SINGLE } },
  });
}

// ── Colour call-out boxes ─────────────────────────────────────────────────────
function noteBox(label, lines, bgColor, borderColor, textColor) {
  return new Table({
    rows: [new TableRow({ children: [
      new TableCell({
        shading: { type: ShadingType.SOLID, color: borderColor, fill: borderColor },
        width: { size: 200, type: WidthType.DXA },
        children: [new Paragraph({
          children: [new TextRun({ text: label, bold: true, size: 18, color: WHITE })],
          alignment: AlignmentType.CENTER,
        })],
        verticalAlign: 'center',
      }),
      new TableCell({
        shading: { type: ShadingType.SOLID, color: bgColor, fill: bgColor },
        children: lines.map(l => new Paragraph({
          children: [new TextRun({ text: l, size: 19, color: textColor })],
          spacing: sp(40, 40),
        })),
      }),
    ]})],
    width: { size: 100, type: WidthType.PERCENTAGE },
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
  });
}

const purposeBox   = text  => noteBox('PURPOSE',  [text],        LIGHT,      ACCENT,     '1E3A5F');
const interviewerNote = lines => noteBox('NOTE',  lines,         AMBER_BG,   AMBER_BD,   AMBER);
const artifactBox  = (title, lines) => noteBox('ARTIFACT', [title, ...lines], GREEN_BG, GREEN_BD, GREEN);
const newBadge     = text  => noteBox('NEW v2',   [text],        PURPLE_BG,  PURPLE_BD,  PURPLE);

// ── CSV template table ────────────────────────────────────────────────────────
function csvTable(headers, exampleRow) {
  const hCells = headers.map(h => new TableCell({
    shading: { type: ShadingType.SOLID, color: NAVY, fill: NAVY },
    children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 17, color: WHITE })] })],
  }));
  const eCells = exampleRow.map(v => new TableCell({
    shading: { type: ShadingType.SOLID, color: LIGHT, fill: LIGHT },
    children: [new Paragraph({ children: [new TextRun({ text: v, size: 17, color: MUTED, italics: true })] })],
  }));
  return new Table({
    rows: [
      new TableRow({ children: hCells, tableHeader: true }),
      new TableRow({ children: eCells }),
    ],
    width: { size: 100, type: WidthType.PERCENTAGE },
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PREAMBLE
// ─────────────────────────────────────────────────────────────────────────────
function interviewerPreamble() {
  return [
    h1('Interviewer Notes — Before You Start'),
    interviewerNote([
      'Record the session (audio or video). The file will be uploaded directly to the Workbench for AI extraction.',
      'Your job is to keep the conversation moving and probe for specificity. Vague answers now mean clarification loops later.',
      'Do not lead the witness — let the PO describe in their own words first, then sharpen with follow-ups.',
      '',
      'When the PO says "it depends" — that is a guardrail or a branching decision. Dig in.',
      'When the PO says "the system handles it" — that is a data source or a tool call. Get the system name.',
      'When the PO says "someone checks it" — that is a Human-in-the-Loop gate. Get who, when, what they check.',
      'When the PO says "the agent decides" — that is an autonomous decision. Get the rule, the threshold, and what can go wrong.',
      'When the PO says "then it passes to the next step" — that is an agent hand-off. Get what data passes and what happens if it fails.',
      '',
      'This guide is designed for multi-step workflows involving MULTIPLE AI agents and MULTIPLE humans in the loop.',
      'Sections 5 and 6 establish the full workflow topology before drilling into individual agents and steps.',
      'Do not skip to Section 7 until the overall architecture is mapped — detail without context produces wrong designs.',
      '',
      'SUPPORTING ARTIFACTS: Several sections reference a companion CSV template.',
      'Send relevant templates to the PO before the session. CSV files are machine-readable and will be',
      'ingested by the Workbench AI agent alongside the transcript.',
      '',
      'Leave Section 14 open throughout — note any "I\'ll need to check that" items in real time.',
    ]),
    new Paragraph({ spacing: sp(200, 0) }),
    h3('How This Guide Is Used'),
    body('The interview is recorded and uploaded to the Agentic SDLC Workbench as an audio file or text transcript. The AI extraction agent reads the content, identifies structured design entities — use cases, workflows, agent specs, guardrails, data sources, HITL gates, and more — and stages them for human review before promotion into Change Packets.'),
    body('Companion CSV artifacts are uploaded separately. Each CSV template maps directly to a Workbench entity type. The AI agent reads column headers and row data to extract field-level values with high confidence, bypassing the need for clarification rounds on information that is inherently tabular.'),
    new Paragraph({ spacing: sp(200, 0) }),
  ];
}

// ── SECTION 1 ─────────────────────────────────────────────────────────────────
function section1() {
  const qs = [
    'Please introduce yourself — your name, title, and the business unit you represent.',
    'How long have you been the Product Owner for this process or system area?',
    'Who are the other key stakeholders involved in this process — and are any of them available to join follow-up sessions if needed?',
    'Is there a single executive sponsor for this automation initiative, or is ownership shared across departments?',
    'Are you the right person to sign off on the final requirements, or will there be a review layer above you?',
    'Has your team done any previous AI or automation work in this area — even something small? If so, what happened to it?',
    'Is there any existing documentation about this process — process maps, SOPs, training guides, system specs — that we should ingest alongside this interview?',
    'Are there any political sensitivities we should be aware of — teams who feel threatened by automation, union considerations, regulatory scrutiny?',
    'What is your personal definition of a successful outcome for this project? Not the official KPI — your version.',
    'How much time can you commit to review cycles, clarification questions, and staged approval of the agent\'s outputs during the design phase?',
  ];
  return [
    pageBreak(),
    h1('Section 1 — Participant & Context'),
    purposeBox('Establish who you are talking to, what their authority is, and what part of the business this use case lives in. This becomes the project member record and sets context for everything that follows.'),
    new Paragraph({ spacing: sp(120, 0) }),
    ...qs.map((q, i) => numbered(q, i + 1)),
  ];
}

// ── SECTION 2 ─────────────────────────────────────────────────────────────────
function section2() {
  const qs = [
    'In one or two sentences, what is the core problem this workflow is supposed to solve?',
    'How long has this problem existed, and why hasn\'t it been solved before now?',
    'Walk me through what a bad day looks like for your team because of this problem. Give me a real example from the last month.',
    'Who feels the pain most directly — your team, your customers, a downstream department?',
    'What does this problem cost the business? Think in terms of staff time, error rates, rework, delays, or missed revenue — whatever is most meaningful in your context.',
    'Do you have any data to back that up — incident logs, SLA reports, time-and-motion studies, customer complaints?',
    'If the problem is volume — how much volume are we talking? Give me peak, average, and seasonal variation if relevant.',
    'If the problem is quality or errors — what types of errors happen most frequently, and what are the consequences when they do?',
    'Is the problem getting worse over time, and if so, why?',
    'Has anyone tried to fix this with a non-AI solution — better tooling, additional headcount, process redesign? What happened?',
    'Are there any parts of the current process that actually work well and should be preserved, even if the rest is automated?',
    'If you could only fix one thing about this process with this workflow, what would it be?',
  ];
  return [
    pageBreak(),
    h1('Section 2 — The Problem Statement'),
    purposeBox('Understand the pain being solved before discussing any solution. The richer this section, the better the use case rationale and business objective fields will be in the Workbench.'),
    new Paragraph({ spacing: sp(120, 0) }),
    ...qs.map((q, i) => numbered(q, i + 1)),
  ];
}

// ── SECTION 3 ─────────────────────────────────────────────────────────────────
function section3() {
  const qs = [
    'Walk me through the process from start to finish — from the moment it begins to the moment it is complete. Do not skip steps; assume I know nothing.',
    'What triggers the process? Is it time-based, event-based, a person kicking it off, or a system event?',
    'Who is the first person to touch it, and exactly what do they do?',
    'Where does the work go next — is it handed off to another person, a system, or does it sit in a queue? How does the next person know it is waiting for them?',
    'For each step in the process — how long does it typically take? What is the acceptable SLA or deadline?',
    'What decisions get made along the way — and who makes them? What information does the decision-maker need, and what are the possible outcomes?',
    'Where does the process branch? What causes it to go down one path versus another?',
    'What systems are used at each step? Log into anything? Reference any database or portal? Generate any document?',
    'What data is entered, looked up, copied, or calculated at each step? Where does that data come from?',
    'Where do things most commonly get stuck, delayed, or sent back?',
    'Are there any approval steps — formal sign-off, a second set of eyes, a supervisor review? Who, for what, and under what conditions?',
    'What happens when something goes wrong mid-process — who is notified, what is the recovery path?',
    'How does the process end? What is the final output, and who receives it or acts on it?',
    'Are there any parallel tracks — things that happen simultaneously rather than sequentially?',
    'Are there any regulatory or compliance steps baked into the process — audit trails, mandatory waiting periods, required notifications?',
    'How do you currently measure whether the process ran correctly? Is there any quality check or reconciliation at the end?',
    'If I shadowed your team for one full day, what would I see that would not be obvious from a process diagram?',
  ];
  return [
    pageBreak(),
    h1('Section 3 — Current State Walkthrough (As-Is)'),
    purposeBox('Map the existing process in enough detail to build as-is workflow steps, identify actors, surface system touchpoints, and find the decisions and handoffs that become HITL gates or guardrails. Ask the PO to walk through it as if explaining to a new hire.'),
    new Paragraph({ spacing: sp(120, 0) }),
    ...qs.map((q, i) => numbered(q, i + 1)),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact — Process Step & SLA Register  (CSV)'),
    artifactBox(
      'One row per process step. Each row maps to an as-is workflow step record in the Workbench.',
      [
        '  Step_Number          — sequential integer (1, 2, 3…)',
        '  Step_Name            — short descriptive name',
        '  Actor                — role or system performing the step',
        '  Swim_Lane            — department or system boundary',
        '  Trigger              — what starts this step',
        '  Output               — what this step produces',
        '  Systems_Used         — comma-separated list of system names',
        '  Avg_Duration_Hours   — typical elapsed time',
        '  SLA_Hours            — maximum acceptable elapsed time',
        '  Decision_Point       — Yes / No',
        '  Notes                — anything that does not fit above',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['Step_Number','Step_Name','Actor','Swim_Lane','Trigger','Output','Systems_Used','Avg_Duration_Hours','SLA_Hours','Decision_Point','Notes'],
      ['1','Receive request','Operations Clerk','Operations','Email received','Request logged in CRM','CRM, Email','0.5','4','No','']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
  ];
}

// ── SECTION 4 ─────────────────────────────────────────────────────────────────
function section4() {
  const qs = [
    'What are the top three business outcomes you are trying to achieve with this workflow?',
    'For each outcome — how will you measure it? What is the metric, what is the current baseline, and what is the target?',
    'Is there a time horizon attached — do these outcomes need to be achieved within a quarter, a year, something else?',
    'Which is more important: speed of delivery, quality of output, or cost reduction? If you had to rank them, how would you?',
    'What does "the workflow is working well" look like six months after go-live? Describe a normal Tuesday.',
    'What does failure look like — what would make you decide to switch the whole workflow off?',
    'Are there any outputs or outcomes that must not get worse as a result of this automation, even if other things improve?',
    'Who will be reviewing and reporting on performance — and how often?',
    'Is there a financial business case for this project? What are the expected savings or revenue gains, and who signed off on them?',
    'Are there any non-financial benefits that are equally important — employee wellbeing, customer experience, regulatory standing?',
    'What is the minimum viable outcome — the smallest version of this workflow that would still justify the investment?',
    'Is there an executive committee, steering group, or governance board that will need to approve the outcomes before go-live?',
  ];
  return [
    pageBreak(),
    h1('Section 4 — Business Objectives & Success Criteria'),
    purposeBox('Define the finish line precisely. These become the success criteria, done criteria, and KPI fields on the use case record. Forces the PO to commit to measurable outcomes.'),
    new Paragraph({ spacing: sp(120, 0) }),
    ...qs.map((q, i) => numbered(q, i + 1)),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact — Success Metrics Register  (CSV)'),
    artifactBox(
      'One row per measurable outcome. Upload alongside the transcript.',
      [
        '  Metric_Name          — short label',
        '  Category             — time / quality / cost / volume / compliance / customer',
        '  Current_Baseline     — current measured value',
        '  Target_Value         — desired value post go-live',
        '  Target_Date          — when the target must be achieved',
        '  Measurement_Method   — how it will be measured',
        '  Reporting_Owner      — who tracks and reports this metric',
        '  Priority             — must-have / nice-to-have',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['Metric_Name','Category','Current_Baseline','Target_Value','Target_Date','Measurement_Method','Reporting_Owner','Priority'],
      ['Processing time per claim','time','4 hours','30 minutes','2025-Q4','Average from system logs','Ops Manager','must-have']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
  ];
}

// ── SECTION 5 (NEW) — Workflow Architecture & Agent Topology ──────────────────
function section5() {
  const qs = [
    'Before we talk about individual agents — walk me through the workflow at the highest level. From trigger to completion, what are the major stages and who or what is responsible for each?',
    'How many distinct AI agents do you envision being involved? Give each a rough working name and a one-sentence description of its role — even if those names change later.',
    'Is there a master orchestrator agent that co-ordinates the others, or are agents triggered independently by system events or human actions?',
    'Does the workflow run in a straight line — one stage after another — or are there parallel tracks where multiple agents work simultaneously?',
    'Where does the workflow branch? What condition or data value causes it to go down one path instead of another?',
    'Are there any loops — stages that repeat until a condition is met, a confidence threshold is reached, or a human is satisfied?',
    'How long does the complete end-to-end workflow take, from trigger to final output? What drives that duration — processing time, waiting on humans, waiting on external systems?',
    'Can the workflow be paused mid-run and resumed later — for example while waiting for a human decision, a customer response, or a third-party result?',
    'What is the unique identifier that ties every agent action, human decision, and system event together into one coherent workflow instance? Is it a case ID, a transaction reference, something else?',
    'At any given moment during processing — what does "workflow state" look like? If an agent or a human picks up the work mid-stream, what do they need to know about everything that has happened so far?',
    'What context or accumulated data must pass from one stage to the next? Can a later agent see what an earlier agent produced, the reasoning it gave, and how confident it was?',
    'If the workflow partially completes and then fails — for example three out of five stages succeed — what is the correct recovery behaviour? Restart from the beginning, restart from the failure point, or escalate to a human?',
    'Are there stages where the workflow must wait for an external event before continuing — a file to arrive, a third party to respond, a regulatory window to open?',
    'Are there timeout rules at the whole-workflow level — not just individual steps? What happens when the whole job takes too long?',
    'Does someone need a live monitoring view — a dashboard showing every active workflow instance and its current stage, age, and status?',
    'Are there other workflows in the business that this one must co-ordinate with, hand off to, or receive input from?',
    'When the entire workflow completes — successfully or otherwise — who is notified, what record is created, and what happens next?',
  ];
  return [
    pageBreak(),
    h1purple('Section 5 — Workflow Architecture & Agent Topology'),
    newBadge('This section is new in v2. Do not skip it. Detail without a mapped architecture produces wrong agent designs.'),
    new Paragraph({ spacing: sp(80, 0) }),
    purposeBox('Map the complete multi-agent workflow before drilling into individual components. Establishes orchestration pattern, parallel tracks, hand-off points, state management, and recovery behaviour. Everything in Sections 6–11 is scoped against this architecture.'),
    new Paragraph({ spacing: sp(120, 0) }),
    ...qs.map((q, i) => numbered(q, i + 1)),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact 5a — Agent Interaction Map  (CSV)'),
    artifactBox(
      'One row per agent-to-agent or agent-to-human hand-off. Captures the complete interaction graph of the workflow. This is the single most important structural artifact for a multi-agent design.',
      [
        '  Interaction_ID       — unique identifier (IA-001, IA-002…)',
        '  From_Agent_Or_Role   — name of the sending agent, human role, or system',
        '  To_Agent_Or_Role     — name of the receiving agent, human role, or system',
        '  Trigger_Condition    — what causes this hand-off to occur',
        '  Execution_Pattern    — sequential / parallel / conditional / loop',
        '  Data_Passed          — comma-separated list of data fields or context objects passed',
        '  Expected_Latency     — how long this hand-off should take (seconds / minutes / hours)',
        '  On_Success           — what happens next if the receiving agent succeeds',
        '  On_Failure           — what happens if the receiving agent fails or times out',
        '  On_Low_Confidence    — what happens if the receiving agent returns a result below confidence threshold',
        '  Human_Can_Intercept  — Yes / No — can a human intervene at this hand-off point',
        '  Notes                — edge cases, retry logic, conditions',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['Interaction_ID','From_Agent_Or_Role','To_Agent_Or_Role','Trigger_Condition','Execution_Pattern','Data_Passed','Expected_Latency','On_Success','On_Failure','On_Low_Confidence','Human_Can_Intercept','Notes'],
      ['IA-001','Orchestrator Agent','Validation Agent','Intake complete, claim record created','sequential','claim_id, claim_data, intake_confidence','< 30s','Pass to Decision Agent','Halt, alert Ops Supervisor','Route to HITL review queue','Yes','']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact 5b — Workflow State & Context Register  (CSV)'),
    artifactBox(
      'One row per state field that must persist across the workflow. Defines the "memory" of the workflow — what accumulates as agents complete their work and what each subsequent agent can access.',
      [
        '  Field_Name           — name of the state field',
        '  Data_Type            — string / integer / decimal / boolean / json / list',
        '  Set_By               — which agent or role first writes this field',
        '  Read_By              — comma-separated list of agents or roles that read this field',
        '  Updated_By           — agents or roles that can update this field after it is first set',
        '  Mandatory            — Yes / No — must this field be populated for the workflow to continue?',
        '  Visible_To_Humans    — Yes / No — is this field shown in any human review screen?',
        '  Retention            — how long this state field is kept after workflow completion',
        '  Description          — what this field represents in business terms',
        '  Notes                — versioning, conflicts, immutability rules',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['Field_Name','Data_Type','Set_By','Read_By','Updated_By','Mandatory','Visible_To_Humans','Retention','Description','Notes'],
      ['validation_result','json','Validation Agent','Decision Agent, Compliance Agent, Human Reviewer','none','Yes','Yes','7 years','Output of the validation agent including confidence score and flagged issues','Immutable once set']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
  ];
}

// ── SECTION 6 (NEW) — Agent Roster & Individual Agent Design ──────────────────
function section6() {
  const qs = [
    'List every AI agent in this workflow. Give each a working name and a one-sentence description of its primary job. We will go through each one in turn.',
    'Is there an orchestrator agent — one whose job is to manage the overall workflow, decide which specialist agent to call next, and handle failures? If so, describe its decision logic.',
    'For each agent — what exactly triggers it to start working? Is it triggered by the orchestrator, by a system event, by another agent completing, or by a human clicking a button?',
    'For each agent — what does it receive as input? Be specific: what data fields, documents, context objects, or prior agent outputs does it need to do its job?',
    'For each agent — what does it produce as output? A decision, a structured data record, a document, a recommendation, a scored result, an action in another system, or something else?',
    'For each agent — which systems and tools does it need access to? Read, write, or both?',
    'For each agent — what is its trust level? Is it fully autonomous, or does its output always require human review before the workflow continues?',
    'For each agent — does it need a specific type of AI model or capability? Is it primarily reasoning-heavy, retrieval-heavy, structured-data extraction, code execution, or classification?',
    'For each agent — what is its scope boundary? What must it never do, access, decide, or communicate — even if asked?',
    'For each agent — how does it communicate uncertainty? If it is not confident enough in its result, what does it do — flag, escalate, ask a clarifying question, produce a partial result, or refuse to proceed?',
    'For each agent — what is its failure behaviour? If it cannot complete its task, does it retry, return a partial result, escalate to a human, halt the workflow, or hand off to a fallback agent?',
    'For each agent — what is its SLA? How long should it take to complete its portion of the work, and what is the maximum acceptable time before it is considered to have failed?',
    'Are there any agents that interact directly with customers or end users — sending notifications, asking questions, or presenting recommendations in a customer-facing interface?',
    'Are there any agents that need memory across multiple workflow instances — the ability to recall how similar cases were handled before and apply that learning?',
    'Are any of the agents reusable — designed to be called by other workflows beyond this one? If so, which ones and what is their intended general purpose?',
    'Which agent is responsible for the final output of the entire workflow — the one that wraps everything up, delivers the result, and closes the instance?',
    'If you had to remove one agent from the design and still get most of the value — which would you remove, and what would you lose?',
  ];
  return [
    pageBreak(),
    h1purple('Section 6 — Agent Roster & Individual Agent Design'),
    newBadge('This section is new in v2. Work through every agent identified in Section 5. Do not group agents together — each one has a distinct design.'),
    new Paragraph({ spacing: sp(80, 0) }),
    purposeBox('Define each agent in the workflow individually — role, inputs, outputs, tools, trust level, model requirements, boundaries, uncertainty handling, and failure behaviour. Each agent becomes a separate Agent Spec record in the Workbench.'),
    new Paragraph({ spacing: sp(120, 0) }),
    ...qs.map((q, i) => numbered(q, i + 1)),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact — Agent Roster  (CSV)'),
    artifactBox(
      'One row per agent. This CSV maps directly to Agent Spec records in the Workbench. Complete one row per agent before the session and refine during it.',
      [
        '  Agent_ID             — unique identifier (AG-001, AG-002…)',
        '  Agent_Name           — working name',
        '  Agent_Type           — orchestrator / specialist / reviewer / communicator / fallback',
        '  Primary_Role         — one-sentence description of what it does',
        '  Trigger              — what starts this agent (orchestrator-call / system-event / human-action / agent-output)',
        '  Input_Fields         — comma-separated list of input data fields or context objects',
        '  Output_Fields        — comma-separated list of output data fields or objects produced',
        '  Systems_And_Tools    — comma-separated list of systems and tools',
        '  Trust_Level          — 1 (full autonomy) to 5 (every output requires human approval)',
        '  Model_Type           — reasoning / retrieval / extraction / classification / code / multimodal',
        '  Max_SLA_Minutes      — maximum time allowed to complete its task',
        '  On_Uncertainty       — escalate / flag / ask-question / partial-result / refuse',
        '  On_Failure           — retry / escalate / halt / fallback-agent',
        '  Max_Retries          — integer',
        '  Customer_Facing      — Yes / No',
        '  Reusable             — Yes / No',
        '  Scope_Boundaries     — what it must never do (free text, semi-colon separated)',
        '  Notes                — open questions, design assumptions',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['Agent_ID','Agent_Name','Agent_Type','Primary_Role','Trigger','Input_Fields','Output_Fields','Systems_And_Tools','Trust_Level','Model_Type','Max_SLA_Minutes','On_Uncertainty','On_Failure','Max_Retries','Customer_Facing','Reusable','Scope_Boundaries','Notes'],
      ['AG-001','Validation Agent','specialist','Validate all mandatory fields and business rules on incoming claims','orchestrator-call','claim_id; claim_data; policy_number','validation_result; confidence_score; flags','PolicyAdmin; RulesDB','3','reasoning','2','flag','escalate','2','No','Yes','Must not modify source claim data; must not contact claimant','']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
  ];
}

// ── SECTION 7 (was 5) — Use Case Scope & Trigger ─────────────────────────────
function section7() {
  const qs = [
    'Give the overall workflow a name — what would you call this end-to-end process in a sentence?',
    'What is the single most important outcome the workflow must deliver? If it only did one thing correctly, what would that be?',
    'What starts the workflow? Is it a scheduled time, an incoming message, a system event, a file arriving, a human clicking a button — or something else?',
    'Can multiple workflow instances run at the same time, or is it a single sequential process?',
    'What is the final output of the complete workflow — a decision, a document, a data record, a notification, an action in another system, or something else?',
    'Who or what receives that final output, and what do they do with it?',
    'Where does the workflow\'s responsibility end? At what point does it hand off to a person or another system outside this design?',
    'What is explicitly out of scope — things the workflow will not do even though they are related to this process?',
    'Are there any adjacent processes or other workflows that this one might interact with or depend on?',
    'What is the expected volume — how many workflow instances per day, week, or month?',
    'Is there a peak load scenario — a month-end rush, a seasonal spike, a batch import — where volume is significantly higher?',
    'Are there different variants or subtypes — different customers, product lines, or geographies that require different agent paths through the workflow?',
    'Is this workflow expected to improve over time as agents learn, or is it fixed-logic automation?',
    'What is the expected lifespan of this workflow — is this permanent infrastructure or a temporary bridge?',
  ];
  return [
    pageBreak(),
    h1('Section 7 — Use Case Scope & Trigger'),
    purposeBox('Define exactly what the end-to-end workflow does and does not do. Feeds the use case record, process segment, and workflow trigger fields. Scope creep starts here — be precise.'),
    new Paragraph({ spacing: sp(120, 0) }),
    ...qs.map((q, i) => numbered(q, i + 1)),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact — Volume & SLA Specification  (CSV)'),
    artifactBox(
      'One row per trigger event or workflow variant. Captures the numbers that are impossible to gather accurately by conversation.',
      [
        '  Step_Or_Event        — name of the trigger or variant',
        '  Daily_Average        — average daily occurrences',
        '  Daily_Peak           — highest daily occurrences observed',
        '  Monthly_Volume       — typical monthly total',
        '  Annual_Volume        — typical annual total',
        '  SLA_Response_Hours   — maximum acceptable response time for the whole workflow',
        '  SLA_Completion_Hours — maximum acceptable completion time for the whole workflow',
        '  Peak_Period          — when peak load occurs (e.g. month-end, December)',
        '  Peak_Multiplier      — peak volume as a multiple of average (e.g. 3x)',
        '  Priority_Level       — critical / high / medium / low',
        '  Notes                — seasonality, known exceptions',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['Step_Or_Event','Daily_Average','Daily_Peak','Monthly_Volume','Annual_Volume','SLA_Response_Hours','SLA_Completion_Hours','Peak_Period','Peak_Multiplier','Priority_Level','Notes'],
      ['Standard claim','150','420','3200','38000','1','24','Jan renewals','2.8x','critical','']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
  ];
}

// ── SECTION 8 (was 6) — Data & Systems Landscape ─────────────────────────────
function section8() {
  const qs = [
    'List every system this workflow needs to interact with — even indirectly. Start with the obvious ones and think outward.',
    'For each system — which agents interact with it, and are they reading, writing, or both?',
    'What is the authentication model for each system — API key, OAuth, service account, username and password?',
    'Are any of these systems third-party SaaS platforms? Are there API usage limits or licensing considerations?',
    'Is there an existing API or integration layer for each system, or would agents interact via UI automation, file export, or database query?',
    'What specific data fields or records do the agents need to read? Can you give examples of real field names or database tables?',
    'What data will agents write, create, or update? How critical is that data — what happens if a write fails or produces an incorrect value?',
    'Are there any read-only systems — things agents can look at but must never modify?',
    'What is the data quality like in the source systems? Known gaps, inconsistencies, or fields that are frequently blank or incorrect?',
    'Are there any data privacy or personal data (PII) considerations — names, addresses, financial data, health data, or anything regulated under GDPR, HIPAA, or equivalent?',
    'Is any of the data classified as confidential or commercially sensitive beyond standard PII?',
    'Are there master data management rules — canonical sources of truth for customers, products, accounts — that agents must respect?',
    'Are there any data transformation steps — calculations, lookups, enrichments, format conversions — that agents will need to perform?',
    'What do agents do if the data they need is missing or out of date?',
    'Are there audit or logging requirements for data access — do we need to record every read or write each agent performs?',
    'Are there any data retention rules that affect what agents can store or cache during processing?',
  ];
  return [
    pageBreak(),
    h1('Section 8 — Data & Systems Landscape'),
    purposeBox('Identify every system any agent needs to read from or write to, every data element needed, and every access or quality constraint. Feeds data source records, tool definitions, and individual agent spec boundaries.'),
    new Paragraph({ spacing: sp(120, 0) }),
    ...qs.map((q, i) => numbered(q, i + 1)),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact 8a — Data Dictionary  (CSV)'),
    artifactBox(
      'One row per data field any agent reads or writes. Field-level accuracy cannot be captured reliably from a verbal interview.',
      [
        '  Field_Name           — exact field/column name in the source system',
        '  Source_System        — system name',
        '  Table_Or_Object      — table, object, or API endpoint',
        '  Data_Type            — string / integer / decimal / date / boolean / enum',
        '  Format               — e.g. YYYY-MM-DD, GBP 2dp, max 255 chars',
        '  Mandatory            — Yes / No',
        '  Valid_Values         — comma-separated list, range, or regex',
        '  Business_Description — plain-English meaning',
        '  PII                  — Yes / No',
        '  PII_Category         — name / address / financial / health / none',
        '  Agent_Access         — read / write / read-write / none',
        '  Accessing_Agents     — comma-separated Agent_IDs that use this field',
        '  Owner                — team or person responsible for data quality',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['Field_Name','Source_System','Table_Or_Object','Data_Type','Format','Mandatory','Valid_Values','Business_Description','PII','PII_Category','Agent_Access','Accessing_Agents','Owner'],
      ['claim_value','ClaimsDB','tbl_claim','decimal','GBP 2dp','Yes','0.00–9999999.99','Total claimed amount','No','none','read','AG-002, AG-003','Claims Team']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact 8b — System & Access Matrix  (CSV)'),
    artifactBox(
      'One row per system. Captures the access model, rate limits, and constraints that define agent tool boundaries.',
      [
        '  System_Name          — name of the system',
        '  System_Type          — internal / SaaS / third-party-API / database / file-store',
        '  Auth_Method          — API-key / OAuth2 / service-account / basic / none',
        '  Rate_Limit_Per_Min   — API calls per minute allowed',
        '  Accessing_Agents     — comma-separated Agent_IDs',
        '  Agent_Read           — Yes / No',
        '  Agent_Write          — Yes / No',
        '  Data_Classification  — public / internal / confidential / restricted',
        '  Contains_PII         — Yes / No',
        '  Integration_Layer    — REST / GraphQL / SOAP / JDBC / SFTP / RPA / none',
        '  Contact_Owner        — team or person for access requests',
        '  Notes                — known issues, downtime windows, licensing',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['System_Name','System_Type','Auth_Method','Rate_Limit_Per_Min','Accessing_Agents','Agent_Read','Agent_Write','Data_Classification','Contains_PII','Integration_Layer','Contact_Owner','Notes'],
      ['PolicyAdmin','internal','service-account','n/a','AG-001, AG-002','Yes','No','confidential','Yes','JDBC','IT-Ops','Read-only service account required']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
  ];
}

// ── SECTION 9 (was 7) — HITL + Agent-to-Agent Hand-offs (EXPANDED) ───────────
function section9() {
  const qs = [
    // ── Human-in-the-Loop ─────────────────────────────
    'Are there any decisions in this workflow that a human must make — ones you would not be comfortable delegating entirely to AI, at least initially?',
    'For each such decision — what information does the human need? Where in the workflow does it occur? Which agent produced the input the human is reviewing?',
    'What is the consequence of a wrong human decision at each of those points? Is it reversible?',
    'What happens if the human does not respond in time — default action, escalation to a more senior role, or halt of the entire workflow?',
    'Who specifically is authorised to make each approval decision — a named role, a named individual, or does it rotate?',
    'Is there a dollar or volume threshold above which additional or higher approval is required?',
    'Are there decisions where the agent should present multiple options to the human rather than a single recommendation?',
    'Should an agent explain its reasoning when it asks a human for approval — and if so, at what level of detail?',
    'Are there scenarios where an agent should proactively flag something to a human even if no decision is required — a risk, an anomaly, an unusual pattern?',
    'Are there any steps where two humans must agree before the workflow continues — a four-eyes or dual-authorisation requirement?',
    'Do human approval decisions need to be captured with a timestamp, a named approver, and a stated reason — for regulatory or audit purposes?',
    'Can a human intervene at any point in the workflow — not just at designated gates — to pause, redirect, or override an agent in progress?',
    'How do your team currently feel about AI making recommendations in this area — are they likely to trust it, or will there be resistance that affects how we design approval flows?',
    // ── Agent-to-Agent hand-offs ──────────────────────
    'For each agent-to-agent hand-off you described in Section 5 — what exact data fields, context objects, or prior results must be passed from the sending agent to the receiving agent?',
    'If an upstream agent produces a low-confidence result — below the application\'s threshold — should the downstream agent refuse to proceed, produce a partial result, or flag for human review?',
    'If two agents run in parallel and produce conflicting results — for example a Validation Agent approves but a Compliance Agent flags — how should the workflow resolve the conflict? Who or what is the tie-breaker?',
    'When one agent hands off to the next — does the receiving agent see all prior agent outputs, or only the specific fields it needs for its task?',
    'Is there any agent whose output should be treated as advisory only — meaning a downstream agent or human can override it without the workflow treating that as an error?',
    'After a human overrides an agent\'s output at a HITL gate — does the workflow resume from the next step, or does the upstream agent re-run with the human\'s correction as additional input?',
    'Are there any agent hand-offs that must be logged in a way that is visible to regulators or auditors — not just the workflow system, but an external compliance record?',
  ];
  return [
    pageBreak(),
    h1('Section 9 — Decisions, Approvals & Human-in-the-Loop'),
    purposeBox('Covers both human HITL gates and agent-to-agent hand-offs. Every decision point where a human must remain in the loop becomes a HITL gate record. Every agent-to-agent transition defines what data passes, what happens on low confidence, and how conflicts are resolved.'),
    new Paragraph({ spacing: sp(80, 0) }),
    interviewerNote([
      'Questions 1–13: Human-in-the-Loop gates — who, when, what they review, what authority they have.',
      'Questions 14–20: Agent-to-agent hand-offs — data passed, confidence thresholds, conflict resolution, override behaviour.',
      'These are distinct design concerns — do not conflate them.',
    ]),
    new Paragraph({ spacing: sp(120, 0) }),
    ...qs.map((q, i) => numbered(q, i + 1)),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact — RASIC Matrix  (CSV)'),
    artifactBox(
      'One row per workflow activity. Columns include BOTH human roles AND named agents. Cell values: R = Responsible  A = Accountable  S = Supporting  I = Informed  C = Consulted  blank = not involved.',
      [
        'IMPORTANT: In a multi-agent workflow, agents are first-class actors.',
        'Include one column per agent (use Agent_ID) alongside human role columns.',
        'Every activity must have exactly one A (Accountable) — this must always be a human role, never an agent.',
        '',
        '  Activity             — process step or decision name',
        '  Step_Number          — to match Section 3 Process Step Register',
        '  [Human role columns] — one column per human role; values R/A/S/I/C/blank',
        '  [Agent columns]      — one column per Agent_ID; values R/A/S/I/C/blank',
        '  HITL_Required        — Yes / No — must a human be in the loop at this step?',
        '  HITL_Timeout_Hours   — how long before escalation if human does not respond',
        '  Escalation_Role      — who to escalate to on timeout',
        '  Notes                — thresholds, conditions, exceptions',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['Activity','Step_Number','Operations_Clerk','Ops_Manager','Compliance_Officer','AG-001_Validation','AG-002_Decision','AG-003_Orchestrator','HITL_Required','HITL_Timeout_Hours','Escalation_Role','Notes'],
      ['Validate claim fields','2','R','I','C','S','','I','Yes','4','Ops_Manager','Agent flags anomalies; clerk reviews and approves']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
  ];
}

// ── SECTION 10 (was 8) — Guardrails & Constraints ────────────────────────────
function section10() {
  const qs = [
    'What should this workflow absolutely never do — regardless of what the data says or what any agent has been asked?',
    'Are there financial limits — maximum transaction values, credit limits, spend thresholds — that no agent may exceed without human approval?',
    'Are there volume or frequency limits — no agent should process more than X items per hour, per day, or per batch?',
    'Are there customer-facing limits — things agents can say or not say, offers they can or cannot make, communications they are or are not allowed to send?',
    'Are there regulatory constraints that define what agents can and cannot do — FCA rules, GDPR obligations, SOX controls, industry-specific regulations?',
    'Are there internal policy constraints — procurement rules, HR policies, brand guidelines, legal sign-off requirements?',
    'Are there system-level constraints — no agent may make more than X API calls per minute, hold data for more than Y days, or write directly to a production database?',
    'If any agent produces a result outside a normal range — a statistical outlier, an unusually high value, an unexpected pattern — what should it do?',
    'Are there time-based constraints — agents should not run during business-critical windows, must complete before a deadline, must not contact customers after hours?',
    'Are there geographical or jurisdictional constraints — this workflow applies to UK customers only, or must behave differently per country?',
    'What should an agent do if a system it depends on is unavailable — fail silently, retry, alert, or halt the whole workflow?',
    'What should an agent do if it receives data it does not recognise or cannot interpret?',
    'Are there consent or opt-out considerations — customers or employees who have opted out of automated processing?',
    'If an agent makes a mistake — what is the fastest rollback? Is that even possible, or is the action irreversible?',
    'Is there a confidence floor — below which an agent should refuse to act and always escalate to a human?',
    'Are there ethical or reputational considerations — types of decisions the business would be uncomfortable defending publicly if an automated agent made them?',
    'Do different agents have different guardrail profiles — for example, is the Intake Agent more permissive than the Decision Agent?',
  ];
  return [
    pageBreak(),
    h1('Section 10 — Guardrails & Constraints'),
    purposeBox('Define the hard and soft limits on agent behaviour across the whole workflow. These become guardrail records per agent in the Workbench. Note where guardrails differ between agents — a Validation Agent and a Decision Agent will typically have different thresholds.'),
    new Paragraph({ spacing: sp(120, 0) }),
    ...qs.map((q, i) => numbered(q, i + 1)),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact 10a — Guardrail Rules Register  (CSV)'),
    artifactBox(
      'One row per guardrail rule. Include the Agent_ID column to link each rule to the specific agent it constrains. Rules that apply to all agents use "ALL".',
      [
        '  Rule_ID              — unique identifier (GR-001, GR-002…)',
        '  Agent_ID             — Agent_ID this rule applies to, or ALL',
        '  Rule_Name            — short name',
        '  Category             — financial / volume / time / regulatory / system / ethical / privacy',
        '  Rule_Text            — plain-English rule statement',
        '  Condition            — logical condition that triggers the rule',
        '  Threshold_Value      — numeric or enumerated threshold',
        '  Threshold_Unit       — GBP / items / hours / calls / days / none',
        '  Action_If_Triggered  — block / escalate / flag / log / halt-workflow',
        '  Severity             — critical / high / medium / low',
        '  Regulatory_Reference — regulation or policy name if applicable',
        '  Override_Allowed     — Yes / No',
        '  Override_Role        — role authorised to override',
        '  Notes                — context, exceptions, review date',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['Rule_ID','Agent_ID','Rule_Name','Category','Rule_Text','Condition','Threshold_Value','Threshold_Unit','Action_If_Triggered','Severity','Regulatory_Reference','Override_Allowed','Override_Role','Notes'],
      ['GR-001','AG-002','Max auto-approval','financial','Decision Agent must not auto-approve claims above £10,000','claim_value > 10000','10000','GBP','escalate','critical','FCA ICOBS 8','Yes','Senior Manager','']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact 10b — Data Validation Rules  (CSV)'),
    artifactBox(
      'One row per field-level validation rule. Include Agent_ID to show which agent enforces each rule.',
      [
        '  Rule_ID              — unique identifier (VR-001, VR-002…)',
        '  Agent_ID             — agent that enforces this rule',
        '  Field_Name           — field this rule applies to',
        '  Source_System        — system where the field is validated',
        '  Validation_Type      — required / range / format / lookup / cross-field / uniqueness / custom',
        '  Condition            — the condition that makes the field valid',
        '  Error_Message        — message to surface when invalid',
        '  Action_If_Invalid    — reject / flag / default / escalate',
        '  Severity             — critical / high / medium / low',
        '  Owner                — who maintains this rule',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['Rule_ID','Agent_ID','Field_Name','Source_System','Validation_Type','Condition','Error_Message','Action_If_Invalid','Severity','Owner'],
      ['VR-001','AG-001','policy_number','PolicyAdmin','format','matches ^POL-[0-9]{8}$','Invalid policy number format','reject','critical','IT-Ops']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
  ];
}

// ── SECTION 11 (was 9) — Edge Cases & Failure Modes (EXPANDED) ───────────────
function section11() {
  const qs = [
    // ── Single-agent failures ─────────────────────────
    'What are the three to five most common exceptions or unusual situations your team encounters in this process today?',
    'For each — how often does it happen, and how does the team currently handle it?',
    'What is the strangest or most extreme real example you can remember from this process — the case that broke all the rules?',
    'What happens at month-end, quarter-end, or year-end that is different from normal processing?',
    'What happens when a system dependency is unavailable — a service is down, a third party does not respond, a file does not arrive?',
    'What happens when the input data is incomplete, malformed, duplicated, or contradictory?',
    'Are there known data quality issues in the source systems that agents will have to cope with?',
    'What happens when two conflicting instructions are received — from different systems, different users, or different rules?',
    'What is the right behaviour when an agent genuinely does not know what to do — halt, default, escalate, or log and continue?',
    'Are there fraud or abuse scenarios any agent needs to detect or protect against?',
    'Are there retry limits — if an agent fails to complete an action, how many times should it try before giving up?',
    'Are there any known events in the next 12 months that could stress-test this workflow — mergers, system upgrades, product launches?',
    // ── Cross-agent failures ──────────────────────────
    'What happens if an upstream agent produces an output that looks valid but is wrong — and a downstream agent acts on it before anyone notices?',
    'What happens if two agents running in parallel produce results that contradict each other? Who or what resolves the conflict, and what is the decision rule?',
    'If the orchestrator agent fails mid-workflow — not a downstream specialist, but the co-ordinator itself — what happens to all the work that was already in progress?',
    'What does a partial workflow completion look like — three of five agents have finished successfully when the fourth fails? Does the workflow roll back, pause, or continue with what it has?',
    'Are there any agent hand-offs where the receiving agent cannot tell whether the upstream agent\'s result was high quality or low quality — and what is the guard against that?',
    'If a human overrides an agent\'s output at a HITL gate and the corrected result causes a downstream agent to reach a different conclusion — is that discrepancy logged, and does it trigger any review?',
    'What is the worst-case scenario if this workflow behaves incorrectly at scale — hundreds of wrong outputs generated across many concurrent instances? What is the blast radius, and is the business prepared for that?',
  ];
  return [
    pageBreak(),
    h1('Section 11 — Edge Cases & Failure Modes'),
    purposeBox('Captures both single-agent failure modes and cross-agent failures that are unique to multi-agent architectures. These become test scenario and exception records in the Workbench.'),
    new Paragraph({ spacing: sp(80, 0) }),
    interviewerNote([
      'Questions 1–12: Single-agent and input-data failure modes.',
      'Questions 13–19: Cross-agent failures — upstream errors, parallel conflicts, orchestrator failure, partial completion.',
      'Cross-agent failures are the most dangerous in production and the most commonly missed in requirements.',
    ]),
    new Paragraph({ spacing: sp(120, 0) }),
    ...qs.map((q, i) => numbered(q, i + 1)),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact 11a — Exception Handling Matrix  (CSV)'),
    artifactBox(
      'One row per exception type. Include Agent_ID to show which agent is responsible for handling each exception.',
      [
        '  Exception_ID         — unique identifier (EX-001, EX-002…)',
        '  Exception_Name       — short descriptive name',
        '  Exception_Scope      — single-agent / cross-agent / workflow-level',
        '  Agent_ID             — agent responsible for handling, or ORCHESTRATOR / HUMAN',
        '  Trigger_Condition    — what causes this exception',
        '  Frequency            — daily / weekly / monthly / rare',
        '  Business_Impact      — consequence if not handled correctly',
        '  Current_Handling     — how the team handles it today',
        '  Agent_Action         — halt / escalate / default / retry / log / fallback-agent',
        '  Default_Value        — if defaulting, what value is used',
        '  Escalation_Role      — who to escalate to',
        '  Max_Retries          — integer',
        '  Recovery_Reversible  — Yes / No',
        '  Rollback_Scope       — step / agent / full-workflow / none',
        '  Notes                — edge cases, seasonal notes',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['Exception_ID','Exception_Name','Exception_Scope','Agent_ID','Trigger_Condition','Frequency','Business_Impact','Current_Handling','Agent_Action','Default_Value','Escalation_Role','Max_Retries','Recovery_Reversible','Rollback_Scope','Notes'],
      ['EX-004','Parallel agent conflict','cross-agent','ORCHESTRATOR','Validation Agent approves; Compliance Agent rejects same claim','weekly','Payment to non-compliant claimant','Manual adjudication by Compliance team','escalate','','Compliance Officer','0','Yes','agent','Compliance always wins tie-break']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact 11b — Test Scenario Register  (CSV)'),
    artifactBox(
      'One row per test scenario. Include Agent_ID and Interaction_ID to link scenarios to specific agents and hand-offs.',
      [
        '  Scenario_ID          — unique identifier (TS-001, TS-002…)',
        '  Scenario_Name        — short descriptive name',
        '  Scenario_Type        — happy-path / edge-case / negative / cross-agent / volume / security',
        '  Agent_ID             — primary agent under test (or ALL for workflow-level)',
        '  Interaction_ID       — hand-off under test if cross-agent scenario',
        '  Given                — precondition / starting state',
        '  When                 — the action or event being tested',
        '  Then                 — expected outcome',
        '  Expected_Result      — pass/fail criteria',
        '  Priority             — must-test / should-test / nice-to-test',
        '  Covers_Exception     — Exception_ID if testing a specific exception',
        '  Covers_Guardrail     — Guardrail Rule_ID if testing a specific guardrail',
        '  Notes                — data requirements, dependencies',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['Scenario_ID','Scenario_Name','Scenario_Type','Agent_ID','Interaction_ID','Given','When','Then','Expected_Result','Priority','Covers_Exception','Covers_Guardrail','Notes'],
      ['TS-005','Parallel conflict — compliance overrides validation','cross-agent','ORCHESTRATOR','IA-003','Validation Agent returns approved; Compliance Agent returns rejected for same claim instance','Orchestrator receives both results','Orchestrator routes to HITL escalation, not auto-approved','Status = pending_human_review; Compliance Officer notified < 5 min','must-test','EX-004','','']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
  ];
}

// ── SECTION 12 (was 10) — Stakeholders & Governance ─────────────────────────
function section12() {
  const qs = [
    'Who is the business owner of this workflow — the person who is accountable if it goes wrong?',
    'Who is the operational owner — the person who manages it day-to-day after go-live?',
    'Who in your IT or technology team is the system owner for the platforms the workflow will interact with?',
    'Who needs to sign off on the design before it goes into test — legal, compliance, IT security, a steering committee?',
    'Who needs to sign off before it goes live into production?',
    'Is there a Change Advisory Board or change management process this must pass through?',
    'Who is responsible for monitoring the workflow\'s performance after go-live, and how often will they review it?',
    'If the workflow produces an error that affects a customer or a third party — who is the first call, and what is the incident response process?',
    'Is there a data protection officer or privacy team who needs to review this design?',
    'Are there any third-party suppliers involved whose contracts or SLAs would be affected by this workflow?',
    'Who owns the training data or knowledge base the agents will draw on — and do they need to formally approve its use?',
    'Are there any union, works council, or employee consultation requirements before deploying automation that affects job roles?',
    'How will affected staff be informed about and trained on the new workflow?',
    'Is there a formal model risk management or AI governance framework in your organisation that these agents must be registered with?',
    'Who has the authority to switch the entire workflow off in an emergency — and is there a documented procedure?',
    'Can individual agents be switched off independently without halting the whole workflow?',
    'How long is the workflow expected to be in production before it is formally reviewed for continued use?',
  ];
  return [
    pageBreak(),
    h1('Section 12 — Stakeholders, Ownership & Governance'),
    purposeBox('Identify who owns what, who approves what, and who is accountable across the whole workflow. Feeds project member records, RACI fields, and governance control records.'),
    new Paragraph({ spacing: sp(120, 0) }),
    ...qs.map((q, i) => numbered(q, i + 1)),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact 12a — Stakeholder & Authority Register  (CSV)'),
    artifactBox(
      'One row per named stakeholder. Captures authority levels and contact details needed for the RASIC and governance control records.',
      [
        '  Name, Title, Department, Role_In_Project',
        '  Can_Approve_Design, Can_Approve_GoLive, Emergency_Shutdown',
        '  Availability, Email, Notes',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['Name','Title','Department','Role_In_Project','Can_Approve_Design','Can_Approve_GoLive','Emergency_Shutdown','Availability','Email','Notes'],
      ['Jane Smith','Head of Claims Ops','Operations','business-owner','Yes','Yes','Yes','review-only','j.smith@co.com','Delegate to ops manager when OOO']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact 12b — Compliance Requirements Checklist  (CSV)'),
    artifactBox(
      'One row per regulatory or policy requirement. Maps each to the agent(s) that must implement the control and the evidence required.',
      [
        '  Req_ID, Regulation_Or_Policy, Jurisdiction, Requirement_Text',
        '  Applies_To_This_UC, Responsible_Agent_IDs, Control_Required',
        '  Evidence_Required, Review_Frequency, Owner, Status, Notes',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['Req_ID','Regulation_Or_Policy','Jurisdiction','Requirement_Text','Applies_To_This_UC','Responsible_Agent_IDs','Control_Required','Evidence_Required','Review_Frequency','Owner','Status','Notes'],
      ['CR-001','GDPR Article 22','EU','No solely automated decisions with significant effect without human review','Yes','AG-002','HITL gate before final decision','Approval record with human name, timestamp, and reason','Annual','DPO','confirmed','']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
  ];
}

// ── SECTION 13 (was 11) — Priorities & Phasing ───────────────────────────────
function section13() {
  const qs = [
    'If you had to choose only the three most important capabilities for the first release — what would they be?',
    'Which agents are essential for MVP, and which can be introduced in a later phase?',
    'What can absolutely wait until a later phase, and why?',
    'Are there dependencies between agents — ones that must be built and stable before a downstream agent can be developed?',
    'Is there a hard deadline for the first release? What is driving it?',
    'What is the risk appetite for MVP? Are you comfortable deploying a subset of agents that handle the 80% case and escalate the rest, or does it need to handle 100% from day one?',
    'Are there any parallel workstreams — other system changes, process redesigns, or organisational changes — that this workflow needs to co-ordinate with?',
    'What would cause you to descope an agent from MVP — budget overrun, technical complexity, a change in business priorities?',
    'Is there a phased rollout planned — a pilot group, a geography, a single product line — before full deployment?',
    'What does the pilot look like, and how will you evaluate it before rolling out further?',
    'Are there any capabilities where a manual workaround is acceptable short-term?',
    'What would Version 2 or 3 of this workflow look like — more agents, higher autonomy, broader scope?',
    'Are there other use cases in your area that you expect to follow, and should we be thinking about how they share agents or data?',
  ];
  return [
    pageBreak(),
    h1('Section 13 — Priorities & Phasing'),
    purposeBox('Force-rank requirements and establish an MVP boundary. Determines which agents are in scope for the first baseline and shapes the initial Change Packets.'),
    new Paragraph({ spacing: sp(120, 0) }),
    ...qs.map((q, i) => numbered(q, i + 1)),
    new Paragraph({ spacing: sp(200, 0) }),
    divider(),
    h3('Companion Artifact — User Story Backlog  (CSV)'),
    artifactBox(
      'One row per user story. Include Agent_ID where a story is specific to one agent\'s behaviour.',
      [
        '  Story_ID, Role, Want, So_That',
        '  Agent_ID             — Agent_ID if this story is agent-specific, or ALL',
        '  MVP                  — Yes / No',
        '  Priority             — must-have / should-have / could-have / wont-have-yet',
        '  Acceptance_Criteria  — semicolon-separated testable conditions',
        '  Depends_On           — Story_ID(s) this depends on',
        '  Estimated_Complexity — small / medium / large / unknown',
        '  Notes',
      ]
    ),
    new Paragraph({ spacing: sp(100, 0) }),
    csvTable(
      ['Story_ID','Role','Want','So_That','Agent_ID','MVP','Priority','Acceptance_Criteria','Depends_On','Estimated_Complexity','Notes'],
      ['US-001','Claims Handler','I want the Validation Agent to check all mandatory fields on submission','I do not waste time on incomplete claims','AG-001','Yes','must-have','All required fields populated; invalid formats rejected with clear message; handler notified within 30s','','small','']
    ),
    new Paragraph({ spacing: sp(200, 0) }),
  ];
}

// ── SECTION 14 (was 12) — Wrap-Up ────────────────────────────────────────────
function section14() {
  const qs = [
    'Were there any questions in this interview where you were uncertain or gave an approximate answer? Let\'s flag those now.',
    'Are there any decisions still pending in the business that would affect the design?',
    'Is there anyone else we should interview — particularly anyone who owns a system one of these agents will interact with?',
    'Is there any documentation we should review that would add evidence to what you have described?',
    'Are there areas where you would want a second opinion from legal, compliance, IT security, or another subject matter expert?',
    'Are there any assumptions we treated as fact in this interview that you would like to put on record as assumptions?',
    'Is there anything about this workflow or any of the agents that you chose not to share today — constraints you are navigating — that you would feel comfortable sharing in a follow-up?',
    'On a scale of one to ten, how confident are you that what we captured today is complete and accurate? What would move that score higher?',
    'What are the top three risks you see in this project that we have not yet discussed?',
    'What question did we not ask that we should have?',
    'What would you like to see as a next step, and by when?',
  ];
  return [
    pageBreak(),
    h1('Section 14 — Wrap-Up & Open Items'),
    purposeBox('Capture everything that could not be answered in the room. These become the clarification queue items the Workbench will surface after ingestion. Do not end the session without completing this section.'),
    new Paragraph({ spacing: sp(120, 0) }),
    ...qs.map((q, i) => numbered(q, i + 1)),
    new Paragraph({ spacing: sp(200, 0) }),
    interviewerNote([
      'CLOSING CHECKLIST',
      '  □  Confirm the recording stopped correctly before ending the session.',
      '  □  Note any items the PO asked to keep off the record before uploading.',
      '  □  Collect names of any documents to request from the PO.',
      '  □  Send the PO all relevant companion CSV templates within 24 hours.',
      '  □  Upload the transcript or audio file within 24 hours while context is fresh.',
      '  □  Send the PO a summary of open items within 48 hours.',
      '  □  Log all open items from this section into the Workbench clarification queue after ingestion.',
    ]),
  ];
}

// ── Appendix A — Quick Reference ─────────────────────────────────────────────
function appendixA() {
  const rows = [
    ['§3',  'Process Step & SLA Register',         'As-is steps, actors, SLAs',                           'process_step_sla_register.csv'],
    ['§4',  'Success Metrics Register',             'KPIs, baselines, targets, owners',                    'success_metrics_register.csv'],
    ['§5a', 'Agent Interaction Map',                'Agent-to-agent hand-offs, data passed, failure modes', 'agent_interaction_map.csv'],
    ['§5b', 'Workflow State & Context Register',    'State fields, who reads/writes each, retention',       'workflow_state_register.csv'],
    ['§6',  'Agent Roster',                         'One row per agent — role, trust, SLA, boundaries',    'agent_roster.csv'],
    ['§7',  'Volume & SLA Specification',           'Transaction volumes, peak loads, SLAs',                'volume_sla_specification.csv'],
    ['§8a', 'Data Dictionary',                      'All data fields — types, formats, PII, agent access', 'data_dictionary.csv'],
    ['§8b', 'System & Access Matrix',               'Systems, auth methods, agent read/write',             'system_access_matrix.csv'],
    ['§9',  'RASIC Matrix',                         'Human roles AND agent columns, HITL gates',           'rasic_matrix.csv'],
    ['§10a','Guardrail Rules Register',             'Rules, thresholds, severities, per-agent',            'guardrail_rules_register.csv'],
    ['§10b','Data Validation Rules',                'Field-level validation logic, per-agent',             'data_validation_rules.csv'],
    ['§11a','Exception Handling Matrix',            'Exceptions inc. cross-agent failures, per-agent',     'exception_handling_matrix.csv'],
    ['§11b','Test Scenario Register',               'Given/When/Then, inc. cross-agent scenarios',         'test_scenario_register.csv'],
    ['§12a','Stakeholder & Authority Register',     'Names, roles, approval authority',                    'stakeholder_authority_register.csv'],
    ['§12b','Compliance Requirements Checklist',    'Regulations, controls, responsible agents',           'compliance_requirements_checklist.csv'],
    ['§13', 'User Story Backlog',                   'Stories with agent mapping and acceptance criteria',  'user_story_backlog.csv'],
  ];

  const headerRow = new TableRow({
    children: ['Section','Artifact','What It Captures','Suggested Filename'].map(h =>
      new TableCell({
        shading: { type: ShadingType.SOLID, color: NAVY, fill: NAVY },
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 18, color: WHITE })] })],
      })
    ),
    tableHeader: true,
  });

  // Flag new artifacts in purple
  const newArtifacts = new Set(['§5a','§5b','§6']);
  const dataRows = rows.map((r, idx) =>
    new TableRow({
      children: r.map((cell, ci) => {
        const isNew = ci === 0 && newArtifacts.has(cell);
        return new TableCell({
          shading: {
            type: ShadingType.SOLID,
            color: isNew ? PURPLE_BG : (idx % 2 === 0 ? 'F8FAFC' : WHITE),
            fill:  isNew ? PURPLE_BG : (idx % 2 === 0 ? 'F8FAFC' : WHITE),
          },
          children: [new Paragraph({ children: [new TextRun({
            text: cell + (isNew ? ' ★' : ''),
            size: ci === 3 ? 17 : 19,
            color: isNew ? PURPLE : (ci === 3 ? MUTED : BODY_C),
            font: ci === 3 ? 'Courier New' : undefined,
            bold: isNew,
          })] })],
        });
      }),
    })
  );

  return [
    pageBreak(),
    h1('Appendix A — Companion Artifact Quick Reference'),
    body('Upload all completed CSV files to the Workbench alongside the interview transcript or audio recording. The AI extraction agent processes each file independently and maps columns directly to Workbench entity fields.'),
    body('Artifacts marked ★ are new in v2 and are specific to multi-agent workflow design.'),
    body('NAMING CONVENTION: prefix each file with the project code and date — e.g.  ACME-PILOT1_2025-09-01_agent_roster.csv'),
    new Paragraph({ spacing: sp(120, 0) }),
    new Table({
      rows: [headerRow, ...dataRows],
      width: { size: 100, type: WidthType.PERCENTAGE },
      margins: { top: 80, bottom: 80, left: 100, right: 100 },
    }),
    new Paragraph({ spacing: sp(200, 0) }),
    interviewerNote([
      'INGESTION TIPS FOR CSV ARTIFACTS',
      '  · Use the exact column headers shown in each section — the AI agent matches on header names.',
      '  · UTF-8 encoding, comma-delimited, first row = headers, no merged cells.',
      '  · Leave optional cells blank rather than using N/A, TBC, or dashes — blank is unambiguous.',
      '  · Upload one CSV file per artifact type — do not combine multiple artifacts into one file.',
      '  · Include the project code and date in the filename.',
      '  · Cells that contain commas must be wrapped in double quotes.',
      '  · Agent_ID values must match exactly the IDs in the Agent Roster CSV.',
      '  · Interaction_ID values must match exactly the IDs in the Agent Interaction Map CSV.',
      '  · Upload the Agent Roster and Agent Interaction Map first — they are referenced by all other artifacts.',
    ]),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSEMBLE & WRITE
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const doc = new Document({
    creator: 'Agentic SDLC Workbench',
    title:   'Agentic Use Case Discovery — Interview Guide v2',
    description: 'Multi-agent workflow discovery guide with 16 companion CSV artifact specifications.',
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 20 } },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: {
            top:    convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left:   convertInchesToTwip(1.1),
            right:  convertInchesToTwip(1.1),
          },
        },
      },
      children: [
        ...cover(),
        ...interviewerPreamble(),
        ...section1(),
        ...section2(),
        ...section3(),
        ...section4(),
        ...section5(),
        ...section6(),
        ...section7(),
        ...section8(),
        ...section9(),
        ...section10(),
        ...section11(),
        ...section12(),
        ...section13(),
        ...section14(),
        ...appendixA(),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  const outPath = path.join(__dirname, '..', 'Agentic Use Case Discovery — Interview Guide.docx');
  fs.writeFileSync(outPath, buf);
  console.log(`\n✓  Written: ${outPath}`);
  console.log(`   Size:    ${(buf.length / 1024).toFixed(1)} KB`);
  console.log('\n  Sections: 14 interview sections + Appendix A');
  console.log('  Artifacts: 16 companion CSV templates');
  console.log('  New in v2: Sections 5 & 6, expanded Sections 9 & 11, updated RASIC, 3 new CSVs');
}

main().catch(err => { console.error(err); process.exit(1); });
