// ─────────────────────────────────────────────────────────────────────────────
// SAMPLE Fluent source — stands in for the real `now-sdk init --from <sys_app>`
// + `now-sdk transform` output of the ServiceNow app `x_dnllp_airport_ca`.
// Used to exercise the inbound round-trip pipeline WITHOUT instance credentials.
// Each construct carries a provenance header (source_table / source_sys_id /
// source_scope) so the extractor can attach Level-2 identity to each design record.
// The sys_ids below are FAKE but stable, so re-ingesting coalesces (no duplicates).
// ─────────────────────────────────────────────────────────────────────────────
import { Table, StringColumn, ChoiceColumn, ReferenceColumn, DateTimeColumn } from '@servicenow/sdk/core'
import { BusinessRule, ClientScript, Form, CatalogItem } from '@servicenow/sdk/core'

// ─── DESIGN RECORD ───
// source_table:  sys_db_object
// source_sys_id: a1b2c3d4flight000000000000000001
// source_scope:  x_dnllp_airport_ca
export const x_dnllp_airport_ca_flight = Table({
  name: 'x_dnllp_airport_ca_flight',
  label: 'Flight',
  extends: 'task',
  schema: {
    flight_number: StringColumn({ label: 'Flight Number', mandatory: true }),
    gate: ReferenceColumn({ label: 'Gate', referenceTable: 'x_dnllp_airport_ca_gate' }),
    scheduled_departure: DateTimeColumn({ label: 'Scheduled Departure' }),
    status: ChoiceColumn({
      label: 'Status',
      choices: {
        scheduled: 'Scheduled',
        boarding: 'Boarding',
        departed: 'Departed',
        delayed: 'Delayed',
        cancelled: 'Cancelled',
      },
    }),
  },
  audit: true,
})

// ─── DESIGN RECORD ───
// source_table:  sys_ui_form
// source_sys_id: a1b2c3d4form0000000000000000001
// source_scope:  x_dnllp_airport_ca
export const flight_default_form = Form({
  table: 'x_dnllp_airport_ca_flight',
  view: 'Default view',
  sections: [
    { label: 'Flight Details', fields: ['flight_number', 'status', 'gate', 'scheduled_departure'] },
  ],
})

// ─── DESIGN RECORD ───
// source_table:  sys_script
// source_sys_id: a1b2c3d4br000000000000000000001
// source_scope:  x_dnllp_airport_ca
// Plain English: when a flight becomes delayed, notify the assigned gate agent.
export const notify_gate_agent_on_delay = BusinessRule({
  name: 'Notify gate agent on delay',
  table: 'x_dnllp_airport_ca_flight',
  when: 'after',
  action: ['update'],
  order: 100,
  condition: 'current.status.changesTo("delayed")',
  script: notifyGateAgent,
})

// ─── DESIGN RECORD ───
// source_table:  sys_script_client
// source_sys_id: a1b2c3d4cs000000000000000000001
// source_scope:  x_dnllp_airport_ca
// Plain English: require a cancellation reason when status is set to Cancelled.
export const require_cancellation_reason = ClientScript({
  name: 'Require cancellation reason',
  table: 'x_dnllp_airport_ca_flight',
  type: 'onChange',
  field: 'status',
  script: requireCancellationReason,
})

// ─── DESIGN RECORD ───
// source_table:  sc_cat_item
// source_sys_id: a1b2c3d4cat00000000000000000001
// source_scope:  x_dnllp_airport_ca
export const report_gate_issue = CatalogItem({
  name: 'Report a Gate Issue',
  short_description: 'Report a problem at a gate (cleaning, equipment, or safety).',
  category: 'Airport Operations',
  variables: {
    gate: { label: 'Gate', type: 'reference', mandatory: true },
    issue_type: { label: 'Issue Type', type: 'choice', choices: ['Cleaning', 'Equipment', 'Safety'], mandatory: true },
    details: { label: 'Details', type: 'multi_line_text' },
  },
})
