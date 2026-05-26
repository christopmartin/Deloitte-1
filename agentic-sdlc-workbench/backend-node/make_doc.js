'use strict';
/**
 * Generates Agentic SDLC Workbench — Screen Reference Guide.docx
 * Run: node make_doc.js
 */
const path = require('path');
const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, BorderStyle, ShadingType,
  TableLayoutType, convertInchesToTwip,
} = require('docx');

// ── Colour palette ────────────────────────────────────────────
const NAVY   = '1E3A5F';
const SLATE  = '475569';
const ACCENT = '2563EB';
const LIGHT  = 'EFF6FF';
const WHITE  = 'FFFFFF';
const BORDER = 'CBD5E1';

// ── Helpers ───────────────────────────────────────────────────
function h1(text) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 400, after: 120 },
    shading: { type: ShadingType.SOLID, color: NAVY, fill: NAVY },
    run: { color: WHITE, bold: true, size: 28 },
  });
}

function h2(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 24, color: NAVY })],
    spacing: { before: 300, after: 80 },
    border: { bottom: { color: ACCENT, size: 6, style: BorderStyle.SINGLE } },
  });
}

function h3(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 22, color: SLATE })],
    spacing: { before: 200, after: 60 },
  });
}

function body(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, size: 20, color: '1E293B', ...opts })],
    spacing: { before: 60, after: 60 },
  });
}

function bullet(text, level = 0) {
  return new Paragraph({
    children: [new TextRun({ text, size: 20, color: '1E293B' })],
    bullet: { level },
    spacing: { before: 40, after: 40 },
  });
}

function spacer(lines = 1) {
  return new Paragraph({ text: '', spacing: { before: lines * 80, after: 0 } });
}

function purposeBox(text) {
  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: [new TableCell({
      shading: { type: ShadingType.SOLID, color: LIGHT, fill: LIGHT },
      borders: {
        top:    { color: ACCENT, size: 8,  style: BorderStyle.SINGLE },
        bottom: { color: BORDER, size: 4,  style: BorderStyle.SINGLE },
        left:   { color: ACCENT, size: 8,  style: BorderStyle.SINGLE },
        right:  { color: BORDER, size: 4,  style: BorderStyle.SINGLE },
      },
      margins: { top: 100, bottom: 100, left: 140, right: 140 },
      children: [new Paragraph({
        children: [
          new TextRun({ text: 'Purpose: ', bold: true, size: 20, color: ACCENT }),
          new TextRun({ text, size: 20, color: '1E293B' }),
        ],
      })],
    })]})],
  });
}

function fieldTable(rows) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: ['Field / Element', 'Description'].map(label =>
      new TableCell({
        shading: { type: ShadingType.SOLID, color: NAVY, fill: NAVY },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({
          children: [new TextRun({ text: label, bold: true, color: WHITE, size: 20 })],
        })],
      })
    ),
  });

  const dataRows = rows.map((row, i) => new TableRow({
    children: row.map((cell, ci) => new TableCell({
      shading: { type: ShadingType.SOLID, color: i % 2 === 0 ? WHITE : 'F8FAFC', fill: i % 2 === 0 ? WHITE : 'F8FAFC' },
      margins: { top: 70, bottom: 70, left: 120, right: 120 },
      children: [new Paragraph({
        children: [new TextRun({
          text: cell,
          size: 19,
          bold: ci === 0,
          color: ci === 0 ? NAVY : '334155',
        })],
      })],
    })),
  }));

  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [convertInchesToTwip(2.4), convertInchesToTwip(5.6)],
    rows: [headerRow, ...dataRows],
  });
}

function actionTable(rows) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: ['Action', 'What it does'].map(label =>
      new TableCell({
        shading: { type: ShadingType.SOLID, color: SLATE, fill: SLATE },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({
          children: [new TextRun({ text: label, bold: true, color: WHITE, size: 20 })],
        })],
      })
    ),
  });

  const dataRows = rows.map((row, i) => new TableRow({
    children: row.map((cell, ci) => new TableCell({
      shading: { type: ShadingType.SOLID, color: i % 2 === 0 ? WHITE : 'F1F5F9', fill: i % 2 === 0 ? WHITE : 'F1F5F9' },
      margins: { top: 70, bottom: 70, left: 120, right: 120 },
      children: [new Paragraph({
        children: [new TextRun({
          text: cell,
          size: 19,
          bold: ci === 0,
          color: ci === 0 ? '0F172A' : '334155',
        })],
      })],
    })),
  }));

  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [convertInchesToTwip(2.0), convertInchesToTwip(6.0)],
    rows: [headerRow, ...dataRows],
  });
}

// ── Module definitions ────────────────────────────────────────
const modules = [

  // ── 1. Dashboard ─────────────────────────────────────────────
  {
    title: '1. Dashboard (Home)',
    purpose: 'The first screen after signing in. Shows the health of the whole repository at a glance — open work, recent changes, and items needing attention.',
    sections: [
      {
        heading: 'KPI Cards (top row)',
        type: 'fields',
        rows: [
          ['Open Change Packets', 'How many AI-proposed changes are waiting for a human to approve or reject.'],
          ['Active Projects',     'Number of projects currently in progress.'],
          ['Validation Exceptions','Problems detected by the system that need a human to resolve.'],
          ['Evidence Sources',    'How many data sources are connected and feeding information into the system.'],
        ],
      },
      {
        heading: 'Recent Repository Changes',
        type: 'fields',
        rows: [
          ['Time',    'Exact date and time the change was recorded.'],
          ['Project', 'Which project the change belongs to.'],
          ['Field',   'The specific data field that was changed.'],
          ['Change',  'A short description of what changed.'],
          ['Source',  'What triggered the change — an agent name, an import, or a manual edit.'],
          ['Status',  'Whether the change has been approved, is still pending, etc.'],
        ],
      },
      {
        heading: 'Missing Owners (side panel)',
        type: 'body',
        text: 'Lists records that have no responsible person assigned. Unowned records cannot be validated or approved, so they need attention.',
      },
      {
        heading: 'Reusable Records to Review (side panel)',
        type: 'body',
        text: 'Records that were flagged as potentially reusable across projects but have not yet been reviewed to confirm they are good enough to share.',
      },
    ],
  },

  // ── 2. Projects ───────────────────────────────────────────────
  {
    title: '2. Projects',
    purpose: 'Create and manage projects — the containers that hold all design work, change history, and team assignments. Each project belongs to a client and moves through lifecycle stages.',
    sections: [
      {
        heading: 'Project List (left panel) — filter fields',
        type: 'fields',
        rows: [
          ['Search',  'Type any text to filter projects by name or client.'],
          ['Client',  'Dropdown to show only projects belonging to a chosen client.'],
          ['Client (column)',  'Which organisation the project belongs to.'],
          ['Project (column)', 'The project name.'],
          ['Stage (column)',   'Where in the lifecycle it sits: draft → build → pilot → production.'],
        ],
      },
      {
        heading: 'Project Detail — Identity fields (editable)',
        type: 'fields',
        rows: [
          ['Project ID',   'System-generated unique identifier. Read-only — never changes.'],
          ['Client',       'The client organisation name.'],
          ['Project Name', 'The display name for this project.'],
          ['Stage',        'Current lifecycle stage: draft, build, pilot, or production.'],
          ['Created',      'Date the project was first created.'],
          ['Owner',        'The person responsible for this project.'],
          ['Description',  'Free-text notes about what this project is for.'],
        ],
      },
      {
        heading: 'Reuse Scope section',
        type: 'body',
        text: 'Shows which records from this project can be shared with other projects.',
      },
      {
        heading: 'Reuse Scope — columns',
        type: 'fields',
        rows: [
          ['Type',       'What kind of record (use case, workflow, tool, knowledge article, etc.).'],
          ['Name',       "The record's name."],
          ['Visibility', 'Scope of sharing: PROJECT (private to this project), CLIENT (shared within the same client organisation), ALL_CLIENTS (shared globally across all clients).'],
        ],
      },
      {
        heading: 'Team Members section',
        type: 'fields',
        rows: [
          ['Name',         "Person's display name."],
          ['Role',         'Their function: methodology_owner, reviewer, functional_owner, technical, or governance.'],
          ['Email',        'Contact email address.'],
          ['+ Add Member', 'Opens an inline form to add a new team member by user ID and role.'],
        ],
      },
      {
        heading: 'Enabled Agents section',
        type: 'body',
        text: 'Checkboxes showing which AI agents are active for this project. Individual trust levels are managed in the Agent Trust Console.',
      },
      {
        heading: 'Actions',
        type: 'actions',
        rows: [
          ['Save Changes', 'Write edits to the identity fields to the database.'],
          ['Discard',      'Abandon any unsaved edits and revert to the last saved state.'],
          ['+ New Project','Opens a blank form in the right panel to create a new project.'],
        ],
      },
    ],
  },

  // ── 3. Agent Trust ────────────────────────────────────────────
  {
    title: '3. Agent Trust & Permission Console',
    purpose: 'Control how much the AI agents are trusted and what they are allowed to do, on a per-project basis. Every agent has a trust dial from 1 (minimal autonomy) to 5 (full autonomy). Changes here directly affect what agents will and will not do without asking for human approval.',
    sections: [
      {
        heading: 'Toolbar',
        type: 'fields',
        rows: [
          ['Project selector',    'Choose which project\'s agent settings you are viewing and editing.'],
          ['Reset to Defaults',   'Revert all dials to the global catalog defaults. Does not save — you must still click Save Changes.'],
          ['Save Changes',        'Write all pending trust-level and enabled/disabled changes to the database.'],
        ],
      },
      {
        heading: 'Trust Table — columns',
        type: 'fields',
        rows: [
          ['Agent',                'The agent\'s display name and its internal system ID.'],
          ['Trust Level',          'A row of 5 clickable dots. Click any dot to set the level. 1 = human must approve everything the agent does. 5 = agent acts freely without approval. Levels 2–4 are graduated steps in between.'],
          ['Allowed Behaviors',    'Tags showing what this agent is permitted to do — for example: read, propose, write, approve.'],
          ['Approval Expectation', 'Whether a human must approve before the agent acts (manual) or the agent can act and then notify (automatic).'],
          ['Enabled',              'Toggle switch. When off, the agent is completely inactive for this project.'],
          ['Override',             'Shows "project override" when this project\'s settings differ from the global catalog defaults. Shows "catalog" when using the defaults.'],
        ],
      },
    ],
  },

  // ── 4. Change Packets ─────────────────────────────────────────
  {
    title: '4. Change Packets',
    purpose: 'The review and approval queue for all AI-proposed changes. Nothing gets written to the repository without passing through here first. A change packet bundles one or more related field changes together so they can be reviewed and approved or rejected as a unit.',
    sections: [
      {
        heading: 'Filters',
        type: 'fields',
        rows: [
          ['Search',      'Free-text search across all packet fields.'],
          ['Project',     'Show only packets from a chosen project.'],
          ['Source',      'Who created it: agent (AI-generated), manual (human-created), import (uploaded from an external system).'],
          ['Risk',        'Filter by assessed risk level: low, medium, high, critical.'],
          ['Status',      'Filter by approval state: pending, approved, rejected, in_review.'],
        ],
      },
      {
        heading: 'Packet List — each card shows',
        type: 'fields',
        rows: [
          ['Packet code',  'Short reference identifier, e.g. CP-2041.'],
          ['Status tag',   'Current approval state of this packet.'],
          ['Summary',      'One-sentence description of what the packet proposes to change.'],
          ['Risk tag',     'Colour-coded risk level.'],
          ['Source tag',   'Where the packet came from.'],
        ],
      },
      {
        heading: 'Packet Detail — Metadata',
        type: 'fields',
        rows: [
          ['Risk Level',   'Assessed risk of applying these changes.'],
          ['Source Type',  'agent, manual, or import.'],
          ['Source ID',    'Reference to the evidence source or event that triggered this packet.'],
          ['Created',      'When the packet was first created.'],
          ['Updated',      'When it was last modified.'],
          ['Items',        'How many individual field changes are bundled inside this packet.'],
        ],
      },
      {
        heading: 'Packet Detail — Rationale',
        type: 'body',
        text: "The AI agent's explanation for why these changes are being proposed. Read this before approving or rejecting.",
      },
      {
        heading: 'Packet Detail — Changes (diff rows)',
        type: 'fields',
        rows: [
          ['Field path',  'The exact field being changed, e.g. workflow_step.sla_target.'],
          ['Old value',   'The current value before the change (shown in red).'],
          ['→',           'Arrow separating old from new.'],
          ['New value',   'What the AI is proposing to replace it with (shown in green).'],
        ],
      },
      {
        heading: 'Actions',
        type: 'actions',
        rows: [
          ['Approve',    'Accept all changes in this packet. Status moves to "approved" and changes are ready to be committed to the repository.'],
          ['Reject',     'Decline the changes. Status moves to "rejected". The agent will be notified.'],
          ['Send Back',  'Return the packet to the agent for rework. Status moves to "sent_back".'],
          ['Split',      'Break this packet into two smaller packets so that acceptable changes can be approved separately from problematic ones.'],
        ],
      },
    ],
  },

  // ── 5. Evidence Sources ───────────────────────────────────────
  {
    title: '5. Evidence Sources',
    purpose: 'View the raw inputs that agents used when generating change packets — documents, reports, workshop transcripts, and live signals. Lets you trace any proposed change back to its original source and assess how reliable it is.',
    sections: [
      {
        heading: 'Filters',
        type: 'fields',
        rows: [
          ['Search', 'Free-text search across all source fields.'],
          ['Type',   'Filter by source category: document, transcript, report, production_signal, api, webhook, manual, etc.'],
          ['Status', 'Filter by processing state: active, pending, failed, archived.'],
        ],
      },
      {
        heading: 'Source List — columns',
        type: 'fields',
        rows: [
          ['Name',        'The source\'s descriptive title, e.g. "Workshop transcript T-118".'],
          ['Type',        'Category tag.'],
          ['Status',      'Current processing state.'],
          ['Source Date', 'When the original document or signal was created or captured.'],
        ],
      },
      {
        heading: 'Source Detail — Source Information',
        type: 'fields',
        rows: [
          ['ID',              'System-generated unique identifier.'],
          ['Type',            'Document category.'],
          ['Status',          'Processing state: validated, pending, partial, failed.'],
          ['Created',         'When this source was registered in the system.'],
          ['Source Date',     'The date of the original document or signal.'],
          ['Confidence',      'How certain the system is about the quality of extracted content, shown as a percentage. Higher is better.'],
          ['Records Linked',  'How many repository fields were populated using data from this source.'],
          ['Owner',           'Who is responsible for maintaining this source.'],
          ['URL',             'If the source is a web resource, a clickable link to it.'],
        ],
      },
      {
        heading: 'Actions',
        type: 'actions',
        rows: [
          ['Re-run Extraction', 'Re-process this source to pick up any newly added fields or to refresh confidence scores.'],
        ],
      },
      {
        heading: 'Linked Repository Fields — columns',
        type: 'fields',
        rows: [
          ['Record',         'Which entity (table/type) the field belongs to.'],
          ['Field',          'The specific field path, e.g. workflow_step.description.'],
          ['Value Snippet',  'A preview of the content that was extracted from this source.'],
          ['Confidence',     'Extraction confidence for this specific field, shown as a percentage.'],
        ],
      },
    ],
  },

  // ── 6. Audit Log ─────────────────────────────────────────────
  {
    title: '6. Audit Log',
    purpose: 'A searchable, immutable history of every change ever written to the repository. Used for compliance, debugging, and answering the question "who changed this, and when?"',
    sections: [
      {
        heading: 'Search bar',
        type: 'fields',
        rows: [
          ['Record ID',        'Paste the ID of any record to see its full change history.'],
          ['Table / Type',     'Filter to a specific type of record, e.g. asdlc_workflow_step.'],
          ['Field Path',       'Optionally narrow results to changes on a specific field within the record.'],
        ],
      },
      {
        heading: 'Record Summary (left panel)',
        type: 'fields',
        rows: [
          ['Table',           'The database entity type where this record lives.'],
          ['Record ID',       'The record you searched for.'],
          ['Total Changes',   'Count of all recorded change events.'],
          ['Distinct Fields', 'How many different fields were touched across all changes.'],
          ['Contributors',    'How many different users made changes to this record.'],
          ['First Change',    'The earliest change event in the history.'],
          ['Last Change',     'The most recent change event.'],
          ['Last Operation',  'INSERT (record was created), UPDATE (record was modified), or DELETE (record was removed).'],
        ],
      },
      {
        heading: 'Change Timeline (right panel) — each entry shows',
        type: 'fields',
        rows: [
          ['Time',               'Exact date and time of the change.'],
          ['Operation tag',      'INSERT, UPDATE, or DELETE.'],
          ['Field path',         'Which field changed.'],
          ['Old value → New value', 'The before and after content of the change.'],
          ['by [user]',          'Who made the change. Shows "system" if automated.'],
          ['Change packet code', 'If this change was applied via a change packet, its code is shown as a tag.'],
        ],
      },
    ],
  },

  // ── 7. Baselines ─────────────────────────────────────────────
  {
    title: '7. Baselines',
    purpose: 'Freeze a snapshot of the project at a milestone. Locked baselines become the permanent record for that lifecycle phase — they can never be modified after locking, only compared against newer work.',
    sections: [
      {
        heading: 'Project selector',
        type: 'body',
        text: 'Choose which project\'s baselines to view. The lifecycle rail and all detail panels update to show that project\'s baselines.',
      },
      {
        heading: 'Lifecycle Rail',
        type: 'body',
        text: 'A visual timeline of all baselines for the selected project, ordered from earliest (left) to latest (right). Each node represents one baseline. Click any node to view its detail below.',
      },
      {
        heading: 'Rail — node indicators',
        type: 'fields',
        rows: [
          ['Stage label',     'The lifecycle stage of this baseline: draft, build, pilot, or production.'],
          ['Version name',    'The baseline\'s display name, e.g. "Draft Design v1".'],
          ['🔒 icon',          'Indicates the baseline is locked and cannot be changed.'],
          ['Date below node', 'The date this baseline was locked (or created, if still a draft).'],
        ],
      },
      {
        heading: 'Baseline Detail — header and metadata',
        type: 'fields',
        rows: [
          ['Baseline name',  'The display name given when this baseline was created.'],
          ['Status tag',     'draft (still editable) or approved (locked permanently).'],
          ['Stage',          'Lifecycle phase: draft, build, pilot, or production.'],
          ['Records',        'How many repository records are captured in this snapshot.'],
          ['Open CPs',       'How many change packets were still open at the time of locking.'],
          ['Owner',          'Who created or is responsible for this baseline.'],
          ['Created',        'When this baseline was created.'],
          ['Locked',         'The date and time it was locked. Blank if still a draft.'],
        ],
      },
      {
        heading: 'Actions',
        type: 'actions',
        rows: [
          ['Lock Current', 'Permanently lock this baseline. A confirmation dialog appears first. Once locked, the button is replaced with a 🔒 Locked badge and the baseline can never be edited again.'],
        ],
      },
      {
        heading: 'Comparison Panel',
        type: 'fields',
        rows: [
          ['Comparing vs [name]', 'Shows which earlier baseline is being compared against.'],
          ['Field path',          'A field that differs between the two baselines.'],
          ['Old value → New value','The content in the earlier baseline vs the selected baseline.'],
        ],
      },
    ],
  },

  // ── 8. Library ───────────────────────────────────────────────
  {
    title: '8. Reusable Pattern Library',
    purpose: 'A catalogue of design patterns, templates, standards, and best practices that can be reused across multiple projects — saving time and ensuring consistency. Items here have been approved for sharing beyond a single project.',
    sections: [
      {
        heading: 'Filters',
        type: 'fields',
        rows: [
          ['Search',  'Free-text search across all library items.'],
          ['Scope',   'PROGRAM (shared across a programme), ORGANIZATION (company-wide), GLOBAL (all clients).'],
          ['Type',    'use_case, workflow, tool, knowledge_article, pattern, standard, template, etc.'],
          ['Status',  'active (ready to use), draft (in progress), in_review, or archived (retired).'],
        ],
      },
      {
        heading: 'Library Table — columns',
        type: 'fields',
        rows: [
          ['ID',           'Short system identifier.'],
          ['Type',         'What kind of record this is.'],
          ['Name',         "The item's display name, with a brief description below in smaller text."],
          ['Scope',        'How broadly it is shared: PROGRAM, ORGANIZATION, or GLOBAL.'],
          ['Owner',        'Who is responsible for maintaining this item.'],
          ['Status',       'Whether it is ready to use (active), in progress (draft), under review, or retired (archived).'],
          ['Last Review',  'When someone last reviewed this item for accuracy and relevance.'],
          ['Next Review',  'When it is due to be reviewed again. Shown in red if overdue.'],
          ['View button',  'Opens a detail card with the full content of the item.'],
        ],
      },
      {
        heading: 'Item Detail Card (popup)',
        type: 'fields',
        rows: [
          ['Type and Scope tags', 'Quick-read labels for the record type and sharing scope.'],
          ['Name',                "The item's title."],
          ['Status tag',          'Current state.'],
          ['ID, Owner, Created',  'Key metadata.'],
          ['Last / Next Review',  'Review schedule dates.'],
          ['Description',         'What this pattern is and when to use it.'],
          ['Content',             'The actual template, standard text, or pattern detail.'],
        ],
      },
    ],
  },

  // ── 9. Validation ────────────────────────────────────────────
  {
    title: '9. Validation & Exception Queue',
    purpose: 'Catches problems automatically — missing required fields, data that does not match the required format, violated business rules, and records that are overdue for review. Each detected problem becomes an exception that a human must resolve or dismiss.',
    sections: [
      {
        heading: 'Project selector',
        type: 'body',
        text: 'Filter the exception list to a specific project, or leave blank to see all exceptions across all projects.',
      },
      {
        heading: 'KPI Cards',
        type: 'fields',
        rows: [
          ['Total Open',        'Exceptions still waiting for someone to take action.'],
          ['Critical',          'Highest-severity exceptions needing immediate attention.'],
          ['Missing Owners',    'Records that have no responsible person assigned to them.'],
          ['Schema Violations', 'Data that does not match the required format or valid values.'],
          ['Rule Failures',     'Business rules that were violated, e.g. a workflow step with no human approval gate.'],
          ['Stale Reviews',     'Records that have not been reviewed within the required time window.'],
          ['Resolved Today',    'Exceptions closed today — tracks your daily progress.'],
        ],
      },
      {
        heading: 'Exception List — filters',
        type: 'fields',
        rows: [
          ['Search', 'Free-text search across exception details.'],
          ['Type',   'missing_owner, invalid_value, schema_violation, rule_failure, or stale_review.'],
        ],
      },
      {
        heading: 'Exception List — each card shows',
        type: 'fields',
        rows: [
          ['Exception ID',  'Short reference code auto-generated from the record ID.'],
          ['Status tag',    'open, in_progress, or resolved.'],
          ['Type tag',      'Category of the problem.'],
          ['Description',   'What the problem is.'],
        ],
      },
      {
        heading: 'Exception Detail — fields',
        type: 'fields',
        rows: [
          ['Type',          'Problem category.'],
          ['Status',        'Current state.'],
          ['Record',        'The ID of the record with the problem.'],
          ['Entity Type',   'What kind of record it is (workflow_step, use_case, etc.).'],
          ['Severity',      'low, med, high, or critical.'],
          ['Detected',      'When this exception was first detected.'],
          ['Description',   'Full explanation of the problem.'],
          ['Resolution',    'Notes about how it was fixed. Appears after the exception is resolved.'],
        ],
      },
      {
        heading: 'Actions',
        type: 'actions',
        rows: [
          ['Resolve', 'Mark this exception as fixed. Sets status to "resolved".'],
          ['Assign',  'Type a user ID into the input field and click Assign to route this exception to a specific person for action.'],
        ],
      },
    ],
  },

  // ── 10. Reports ──────────────────────────────────────────────
  {
    title: '10. Reports & Export',
    purpose: 'Generate formal output documents for stakeholders — clients, executives, auditors — and ingest corrected data files back into the system for review.',
    sections: [
      {
        heading: 'Report Type (select one)',
        type: 'fields',
        rows: [
          ['Requirements Summary',  'All requirements grouped by type and status.'],
          ['Change Log',            'Full audit trail of all changes for a baseline period.'],
          ['Validation Report',     'Open exceptions and compliance status.'],
          ['Baseline Snapshot',     'Point-in-time project scope view at a locked milestone.'],
          ['Agent Activity',        'What the AI agents did, trust events, and human overrides.'],
          ['Traceability Matrix',   'Links requirements end-to-end through the system.'],
        ],
      },
      {
        heading: 'Scope',
        type: 'fields',
        rows: [
          ['Project',   'Which project to report on. Required.'],
          ['Baseline',  'Optionally scope the report to a specific locked baseline. Defaults to the latest baseline.'],
        ],
      },
      {
        heading: 'Include Sections (checkboxes)',
        type: 'fields',
        rows: [
          ['Executive Summary',   'High-level overview suitable for non-technical readers.'],
          ['Change Log',          'Detailed list of every change in the reporting period.'],
          ['Validation Status',   'Summary of exceptions and their resolution status.'],
          ['Traceability',        'Requirement-to-delivery linkage table.'],
          ['Agent Activity',      'Log of what agents did and what required human override.'],
          ['Open Items',          'Outstanding decisions, risks, and unresolved exceptions.'],
        ],
      },
      {
        heading: 'Audience',
        type: 'fields',
        rows: [
          ['Internal Team', 'Full technical detail for the project team.'],
          ['Client',        'Business-friendly language, less internal jargon.'],
          ['Executive',     'High-level summary only — metrics and key decisions.'],
          ['Regulator',     'Formal compliance-oriented layout with full audit trail.'],
        ],
      },
      {
        heading: 'Output Format',
        type: 'fields',
        rows: [
          ['PDF',            'Print-ready document.'],
          ['Excel (XLSX)',   'Spreadsheet format, useful for filtering and analysis.'],
          ['Markdown',       'Plain text with formatting — useful for pasting into wikis or documentation systems.'],
          ['JSON',           'Machine-readable structured data — for integration with other tools.'],
        ],
      },
      {
        heading: 'Actions',
        type: 'actions',
        rows: [
          ['Preview',          'Generates a draft view of the report (opens in a new tab).'],
          ['Generate Report',  'Creates the report and adds it to the Recent Exports list below.'],
        ],
      },
      {
        heading: 'Ingest Corrections panel',
        type: 'body',
        text: 'A drag-and-drop zone for uploading corrected data files (XLSX, CSV, or JSON). Ingested corrections are not written directly to the repository — they are first converted into Change Packets and must go through the standard approval queue.',
      },
      {
        heading: 'Recent Exports — columns',
        type: 'fields',
        rows: [
          ['Date',    'When the report was generated.'],
          ['Title',   'Auto-generated name: report type plus date.'],
          ['Type',    'Which report template was used.'],
          ['Format',  'PDF, XLSX, Markdown, or JSON.'],
          ['Status',  'generating (in progress), ready (available to download), or failed.'],
          ['↓',       'Download button — click to save the file once it is ready.'],
        ],
      },
    ],
  },
];

// ── Build document ─────────────────────────────────────────────
function buildModule(mod) {
  const children = [
    spacer(),
    h1(mod.title),
    spacer(0.5),
    purposeBox(mod.purpose),
    spacer(),
  ];

  for (const section of mod.sections) {
    children.push(h2(section.heading));
    if (section.type === 'body') {
      children.push(body(section.text));
    } else if (section.type === 'fields') {
      children.push(fieldTable(section.rows));
    } else if (section.type === 'actions') {
      children.push(actionTable(section.rows));
    }
    children.push(spacer(0.5));
  }

  return children;
}

const docChildren = [
  // Cover
  new Paragraph({
    children: [new TextRun({ text: 'Agentic SDLC Workbench', bold: true, size: 48, color: NAVY })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 800, after: 200 },
  }),
  new Paragraph({
    children: [new TextRun({ text: 'Screen Reference Guide', size: 32, color: SLATE })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 200 },
  }),
  new Paragraph({
    children: [new TextRun({ text: 'Functions, fields, and plain-language descriptions for all 10 modules', size: 22, color: SLATE, italics: true })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 600 },
  }),
  new Paragraph({ text: '', pageBreakBefore: true }),

  // Modules
  ...modules.flatMap(buildModule),
];

const doc = new Document({
  creator: 'Agentic SDLC Workbench',
  title: 'Screen Reference Guide',
  description: 'Functions and field descriptions for all 10 workbench modules',
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 20 } },
    },
  },
  sections: [{ children: docChildren }],
});

const outPath = path.join(__dirname, '..', '..', 'Agentic SDLC Workbench — Screen Reference Guide.docx');
Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(outPath, buf);
  console.log('Written to:', outPath);
});
