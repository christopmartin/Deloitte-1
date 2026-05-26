/**
 * modules/change_packets.js — Change Packet Review Console
 */
import { apiFetch, tag, statusTag, formatDate, formatDateTime, el, escHtml, showToast, getCurrentProjectId, navigate, setDrillDown } from '../app.js';

let allPackets = [];
let selectedPacket = null;
let selectedPacketIds = new Set(); // checked CP IDs for mass approval
let showAllStatuses = false;       // when false, hide approved/rejected/sent_back
let filters = { search: '', project: '', source_type: '', risk: '', status: '' };

// Mapping from change-packet entity_type to Design Review scope tab
const CP_ENTITY_SCOPE_MAP = {
  use_case:           'use-cases',
  workflow:           'workflows',
  workflow_step:      'workflows',
  hitl_gate:          'workflows',
  agent_spec:         'agents',
  tool:               'tools',
  guardrail:          'guardrails',
  data_source:        'data-sources',
  test_scenario:      'test-scenarios',
  governance_control: 'governance',
  user_story:         'user-stories',
};

const INACTIVE_STATUSES = new Set(['approved', 'rejected', 'sent_back']);

function injectCPStyles() {
  if (document.getElementById('cp-styles')) return;
  const style = document.createElement('style');
  style.id = 'cp-styles';
  style.textContent = `
.cp-drill-link {
  background: none;
  border: none;
  padding: 0;
  margin-left: 8px;
  color: var(--color-accent);
  font-size: 11px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
  display: inline;
  white-space: nowrap;
}
.cp-drill-link:hover { opacity: .75; }

.cp-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-panel);
}
.cp-list-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--color-text);
  flex: 1;
}
.cp-toggle-btn {
  background: none;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 3px 8px;
  font-size: 11px;
  color: var(--color-text-muted);
  cursor: pointer;
  white-space: nowrap;
}
.cp-toggle-btn.active {
  background: var(--color-accent-light);
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.cp-toggle-btn:hover { opacity: .8; }

.cp-selection-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--color-accent-light);
  border-bottom: 1px solid var(--color-accent);
  font-size: 12px;
  color: var(--color-accent);
}
.cp-selection-bar .cp-sel-count {
  flex: 1;
  font-weight: 600;
}

.cp-row-checkbox {
  margin: 0;
  margin-right: 6px;
  cursor: pointer;
  accent-color: var(--color-accent);
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

/* Release-type modal */
.release-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.45);
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.release-modal-card {
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  width: 420px;
  max-width: 95vw;
  box-shadow: 0 8px 32px rgba(0,0,0,.25);
}
.release-modal-header {
  padding: 18px 24px 12px;
  border-bottom: 1px solid var(--color-border);
}
.release-modal-header h3 {
  margin: 0 0 4px;
  font-size: 15px;
  color: var(--color-text);
}
.release-modal-header p {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-muted);
}
.release-modal-body {
  padding: 16px 24px;
}
.release-type-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}
.release-type-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  cursor: pointer;
  transition: border-color .15s, background .15s;
}
.release-type-option:hover { border-color: var(--color-accent); }
.release-type-option.selected {
  border-color: var(--color-accent);
  background: var(--color-accent-light);
}
.release-type-option input[type=radio] {
  margin-top: 2px;
  accent-color: var(--color-accent);
  cursor: pointer;
}
.release-type-option .rt-label {
  font-weight: 600;
  font-size: 13px;
  color: var(--color-text);
}
.release-type-option .rt-desc {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 2px;
}
.release-notes-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: .5px;
  margin-bottom: 4px;
}
.release-modal-footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 12px 24px 18px;
  border-top: 1px solid var(--color-border);
}
  `;
  document.head.appendChild(style);
}

export async function render(container) {
  container.innerHTML = '';
  injectCPStyles();
  allPackets = [];
  selectedPacket = null;
  selectedPacketIds = new Set();
  showAllStatuses = false;

  container.appendChild(el('div', { className: 'module-header' },
    el('h2', {}, 'Change Packets'),
    el('p', { className: 'purpose-text' }, 'Review, approve, reject, or split AI-generated change packets before they are written to the repository.')
  ));

  const layout = el('div', { className: 'two-pane' });
  const paneLeft = el('div', { className: 'pane-left' });
  const paneRight = el('div', { className: 'pane-right', id: 'cp-detail' });
  paneRight.innerHTML = '<div class="empty-state" style="height:100%"><div class="empty-state-icon">📦</div><h3>Select a packet</h3><p>Click a change packet to review its contents and take action.</p></div>';

  layout.appendChild(paneLeft);
  layout.appendChild(paneRight);
  container.appendChild(layout);

  await buildPacketList(paneLeft, paneRight);
}

async function buildPacketList(paneLeft, paneRight) {
  // ── List header with title + "Active / All" toggle ──────────────────
  const listHeader = el('div', { className: 'cp-list-header' });
  const titleSpan = el('span', { className: 'cp-list-title' }, 'Change Packets');
  const toggleBtn = el('button', { className: 'cp-toggle-btn' }, 'Active Only');
  listHeader.appendChild(titleSpan);
  listHeader.appendChild(toggleBtn);
  paneLeft.appendChild(listHeader);

  // ── Selection action bar (hidden until checkboxes are ticked) ────────
  const selectionBar = el('div', { className: 'cp-selection-bar', style: { display: 'none' } });
  const selCount = el('span', { className: 'cp-sel-count' }, '0 selected');
  const approveSelBtn = el('button', { className: 'btn btn-success btn-sm' }, '✓ Approve Selected');
  selectionBar.appendChild(selCount);
  selectionBar.appendChild(approveSelBtn);
  paneLeft.appendChild(selectionBar);

  // ── Filter bar ────────────────────────────────────────────────────────
  const filterBar = el('div', { className: 'filter-bar' });
  const searchInput = el('input', { type: 'text', className: 'filter-input', placeholder: 'Search packets…' });
  const projectSel = el('select', { className: 'filter-select' });
  projectSel.innerHTML = '<option value="">All Applications</option>';
  const sourceSel = el('select', { className: 'filter-select' });
  sourceSel.innerHTML = '<option value="">All Sources</option><option>agent</option><option>manual</option><option>import</option>';
  const riskSel = el('select', { className: 'filter-select' });
  riskSel.innerHTML = '<option value="">All Risks</option><option>low</option><option>medium</option><option>high</option><option>critical</option>';
  const statusSel = el('select', { className: 'filter-select' });
  statusSel.innerHTML = '<option value="">All Statuses</option><option>pending</option><option>approved</option><option>rejected</option><option>in_review</option>';

  filterBar.appendChild(searchInput);
  filterBar.appendChild(projectSel);
  filterBar.appendChild(sourceSel);
  filterBar.appendChild(riskSel);
  filterBar.appendChild(statusSel);
  paneLeft.appendChild(filterBar);

  const listBody = el('div', { className: 'pane-body' });
  listBody.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
  paneLeft.appendChild(listBody);

  // ── Helper to update selection bar ───────────────────────────────────
  function updateSelectionBar() {
    const n = selectedPacketIds.size;
    if (n === 0) {
      selectionBar.style.display = 'none';
    } else {
      selectionBar.style.display = 'flex';
      selCount.textContent = `${n} packet${n !== 1 ? 's' : ''} selected`;
      approveSelBtn.textContent = `✓ Approve Selected (${n})`;
    }
  }

  // ── Toggle: Active Only / Show All ───────────────────────────────────
  toggleBtn.addEventListener('click', () => {
    showAllStatuses = !showAllStatuses;
    toggleBtn.textContent = showAllStatuses ? 'Show Active Only' : 'Active Only';
    toggleBtn.classList.toggle('active', showAllStatuses);
    selectedPacketIds.clear();
    updateSelectionBar();
    refreshPacketList(listBody, paneRight, updateSelectionBar);
  });

  // ── Approve Selected → release-type modal ────────────────────────────
  approveSelBtn.addEventListener('click', () => {
    const projectId = filters.project || getCurrentProjectId();
    if (!projectId) {
      showToast('Select an application before approving.', 'warn');
      return;
    }
    showReleaseTypeModal(
      projectId,
      Array.from(selectedPacketIds),
      listBody,
      paneRight,
      updateSelectionBar
    );
  });

  // ── Filter change handlers ────────────────────────────────────────────
  const refreshFn = () => {
    selectedPacketIds.clear();
    updateSelectionBar();
    refreshPacketList(listBody, paneRight, updateSelectionBar);
  };
  [projectSel, sourceSel, riskSel, statusSel].forEach(el_ => {
    el_.addEventListener('change', () => {
      filters.project     = projectSel.value;
      filters.source_type = sourceSel.value;
      filters.risk        = riskSel.value;
      filters.status      = statusSel.value;
      refreshFn();
    });
  });
  searchInput.addEventListener('input', () => {
    filters.search = searchInput.value.toLowerCase();
    refreshFn();
  });

  // ── Load data ─────────────────────────────────────────────────────────
  try {
    const projData = await apiFetch('/projects');
    const projects = Array.isArray(projData) ? projData : (projData.items || []);
    projects.forEach(p => projectSel.appendChild(el('option', { value: p.project_id }, p.project_name)));

    const params = new URLSearchParams();
    const activeId = getCurrentProjectId();
    if (activeId) {
      params.set('project_id', activeId);
      projectSel.value = activeId;
      filters.project = activeId;
    }

    const data = await apiFetch(`/change-packets?${params}`);
    allPackets = Array.isArray(data) ? data : (data.items || data.packets || []);
    refreshPacketList(listBody, paneRight, updateSelectionBar);
  } catch (err) {
    listBody.innerHTML = `<div class="error-state"><strong>Error:</strong> ${escHtml(err.message)}</div>`;
  }
}

function refreshPacketList(listBody, paneRight, updateSelectionBar) {
  listBody.innerHTML = '';

  let filtered = allPackets.filter(p => {
    // Active-only mode: hide approved / rejected / sent_back unless user overrides
    if (!showAllStatuses && !filters.status && INACTIVE_STATUSES.has(p.status)) return false;
    if (filters.search && !JSON.stringify(p).toLowerCase().includes(filters.search)) return false;
    if (filters.project && String(p.project_id) !== filters.project) return false;
    if (filters.source_type && p.source_type !== filters.source_type) return false;
    if (filters.risk && p.risk_level !== filters.risk) return false;
    if (filters.status && p.status !== filters.status) return false;
    return true;
  });

  if (filtered.length === 0) {
    const msg = !showAllStatuses
      ? 'No active change packets. <button id="cp-show-all-link" style="background:none;border:none;color:var(--color-accent);cursor:pointer;text-decoration:underline;font-size:inherit;">Show all including approved</button>'
      : 'No change packets match the filters.';
    listBody.innerHTML = `<div class="empty-state"><p>${msg}</p></div>`;
    const showAllLink = listBody.querySelector('#cp-show-all-link');
    if (showAllLink) {
      showAllLink.addEventListener('click', () => {
        showAllStatuses = true;
        const toggleBtn = document.querySelector('.cp-toggle-btn');
        if (toggleBtn) { toggleBtn.textContent = 'Show Active Only'; toggleBtn.classList.add('active'); }
        refreshPacketList(listBody, paneRight, updateSelectionBar);
      });
    }
    return;
  }

  // Prune selectedPacketIds to only visible packets
  const visibleIds = new Set(filtered.map(p => p.change_packet_id));
  for (const id of [...selectedPacketIds]) {
    if (!visibleIds.has(id)) selectedPacketIds.delete(id);
  }
  updateSelectionBar();

  const list = el('div', { style: { display: 'flex', flexDirection: 'column' } });
  filtered.forEach(p => {
    const row = el('div', {
      style: {
        padding: '10px 14px',
        borderBottom: '1px solid var(--color-border)',
        cursor: 'pointer',
        transition: 'background var(--transition)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
      }
    });

    // Checkbox — only show for pending/in_review packets
    const canCheck = !INACTIVE_STATUSES.has(p.status);
    const checkbox = el('input', {
      type: 'checkbox',
      className: 'cp-row-checkbox',
      style: { marginTop: '2px', visibility: canCheck ? 'visible' : 'hidden' },
    });
    checkbox.checked = selectedPacketIds.has(p.change_packet_id);
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      if (checkbox.checked) {
        selectedPacketIds.add(p.change_packet_id);
      } else {
        selectedPacketIds.delete(p.change_packet_id);
      }
      updateSelectionBar();
    });

    // Row content
    const rowContent = el('div', { style: { flex: '1', minWidth: 0 } });

    row.addEventListener('mouseenter', () => row.style.background = 'var(--color-bg)');
    row.addEventListener('mouseleave', () => {
      if (selectedPacket?.change_packet_id !== p.change_packet_id) row.style.background = '';
    });
    if (selectedPacket?.change_packet_id === p.change_packet_id) row.style.background = 'var(--color-accent-light)';

    const top = el('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '4px' } });
    top.appendChild(el('span', { style: { fontFamily: 'monospace', fontSize: '12px', color: 'var(--color-accent)', fontWeight: '600' } }, p.packet_code || `CP-${p.change_packet_id}`));
    top.appendChild(statusTag(p.status));
    rowContent.appendChild(top);

    const summary = el('div', { style: { fontSize: '13px', color: 'var(--color-text)', marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.summary || p.title || '—');
    rowContent.appendChild(summary);

    const bottom = el('div', { style: { display: 'flex', gap: '6px' } });
    bottom.appendChild(riskTag(p.risk_level));
    if (p.source_type) bottom.appendChild(tag(p.source_type, 'muted'));
    rowContent.appendChild(bottom);

    row.appendChild(checkbox);
    row.appendChild(rowContent);

    row.addEventListener('click', (e) => {
      if (e.target === checkbox) return; // checkbox click handled separately
      selectedPacket = p;
      document.querySelectorAll('.cp-row-selected').forEach(r => {
        r.classList.remove('cp-row-selected');
        r.style.background = '';
      });
      row.classList.add('cp-row-selected');
      row.style.background = 'var(--color-accent-light)';
      loadPacketDetail(p, paneRight);
    });

    list.appendChild(row);
  });

  listBody.appendChild(list);
}

// ── Release-type modal ────────────────────────────────────────────────────────

function showReleaseTypeModal(projectId, cpIds, listBody, paneRight, updateSelectionBar) {
  const overlay = el('div', { className: 'release-modal-overlay' });

  const card = el('div', { className: 'release-modal-card' });

  // Header
  card.appendChild(el('div', { className: 'release-modal-header' },
    el('h3', {}, `Approve ${cpIds.length} Change Packet${cpIds.length !== 1 ? 's' : ''}`),
    el('p', {}, 'Choose a release type. This determines how the application version number increments.')
  ));

  // Body
  const body = el('div', { className: 'release-modal-body' });

  const RELEASE_TYPES = [
    { value: 'patch', label: 'Patch  (x.y.+1)', desc: 'Bug fixes, small corrections, config tweaks — no new capabilities' },
    { value: 'minor', label: 'Minor  (x.+1.0)', desc: 'New features or enhancements that are backward-compatible' },
    { value: 'major', label: 'Major  (+1.0.0)', desc: 'Breaking changes, architectural shifts, major scope additions' },
  ];

  let selectedType = 'patch';

  const group = el('div', { className: 'release-type-group' });
  const optionEls = [];

  RELEASE_TYPES.forEach(rt => {
    const optEl = el('div', { className: `release-type-option${rt.value === selectedType ? ' selected' : ''}` });
    const radio = el('input', { type: 'radio', name: 'release_type', value: rt.value });
    radio.checked = rt.value === selectedType;
    const textBlock = el('div', {},
      el('div', { className: 'rt-label' }, rt.label),
      el('div', { className: 'rt-desc' }, rt.desc)
    );
    optEl.appendChild(radio);
    optEl.appendChild(textBlock);
    optEl.addEventListener('click', () => {
      selectedType = rt.value;
      radio.checked = true;
      optionEls.forEach(o => o.classList.remove('selected'));
      optEl.classList.add('selected');
    });
    group.appendChild(optEl);
    optionEls.push(optEl);
  });
  body.appendChild(group);

  // Optional notes
  body.appendChild(el('div', { className: 'release-notes-label' }, 'Release Notes (optional)'));
  const notesArea = el('textarea', {
    className: 'form-input',
    placeholder: 'e.g. "Invoice lookup agent — initial go-live release"',
    style: { width: '100%', minHeight: '64px', resize: 'vertical', fontFamily: 'inherit', fontSize: '12px' }
  });
  body.appendChild(notesArea);

  card.appendChild(body);

  // Footer
  const footer = el('div', { className: 'release-modal-footer' });
  const cancelBtn = el('button', { className: 'btn btn-ghost' }, 'Cancel');
  const confirmBtn = el('button', { className: 'btn btn-success' }, '✓ Approve & Create Release');

  cancelBtn.addEventListener('click', () => overlay.remove());

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Approving…';
    try {
      const result = await apiFetch(`/projects/${projectId}/mass-approve`, {
        method: 'POST',
        body: JSON.stringify({
          change_packet_ids: cpIds,
          release_type: selectedType,
          notes: notesArea.value.trim() || null,
        }),
      });
      overlay.remove();

      // Update local packet statuses
      cpIds.forEach(id => {
        const idx = allPackets.findIndex(p => p.change_packet_id === id);
        if (idx >= 0) allPackets[idx].status = 'approved';
      });
      selectedPacketIds.clear();
      updateSelectionBar();

      const prev = result.previous_version_string || '?';
      const next = result.version_string || '?';
      showToast(`✓ ${result.approved_count} packet${result.approved_count !== 1 ? 's' : ''} approved — v${prev} → v${next}`, 'success', 5000);

      // Refresh project selector version display
      try {
        const projData = await apiFetch('/projects');
        const projects = Array.isArray(projData) ? projData : (projData.items || []);
        const select = document.getElementById('project-select');
        if (select) {
          projects.forEach(p => {
            const opt = [...select.options].find(o => o.value === p.project_id);
            if (opt) {
              const ver = p.version_string ? ` v${p.version_string}` : (p.version != null ? ` v${p.version}` : '');
              opt.textContent = `${p.client_name ? p.client_name + ' — ' : ''}${p.project_name}${ver}`;
            }
          });
        }
      } catch {}

      // Refresh list (approved packets fall off when in active-only mode)
      refreshPacketList(listBody, paneRight, updateSelectionBar);
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
      confirmBtn.disabled = false;
      confirmBtn.textContent = '✓ Approve & Create Release';
    }
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(confirmBtn);
  card.appendChild(footer);

  overlay.appendChild(card);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function riskTag(risk) {
  const variantMap = { low: 'ok', medium: 'warn', high: 'danger', critical: 'danger' };
  return tag(risk || 'unknown', variantMap[risk] || 'muted');
}

async function loadPacketDetail(packet, pane) {
  pane.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
  try {
    const full = await apiFetch(`/change-packets/${packet.change_packet_id}`);
    renderDetail(full, pane);
  } catch (err) {
    renderDetail(packet, pane);
  }
}

function renderDetail(p, pane) {
  pane.innerHTML = '';

  const header = el('div', { className: 'pane-header' },
    el('span', { className: 'pane-title' },
      el('span', { style: { fontFamily: 'monospace', color: 'var(--color-accent)', marginRight: '8px' } }, p.packet_code || `CP-${p.change_packet_id}`),
      p.summary || p.title || 'Change Packet'
    ),
    statusTag(p.status)
  );
  pane.appendChild(header);

  const body = el('div', { className: 'pane-body' });

  // Meta table
  const metaSection = el('div', { className: 'detail-section' });
  metaSection.appendChild(el('h4', {}, 'Metadata'));
  const metaGrid = el('div', { className: 'meta-grid' });

  const conflictLabel = p.conflict_classification
    ? p.conflict_classification.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : null;

  const baselineImpactTag = p.baseline_impacting != null
    ? (p.baseline_impacting
        ? el('span', { className: 'tag tag-warn' }, 'Yes — baseline impacted')
        : el('span', { className: 'tag tag-muted' }, 'No'))
    : null;

  const metas = [
    ['Risk Level', riskTag(p.risk_level)],
    ...(conflictLabel ? [['Conflict Type', el('span', { className: 'tag tag-info' }, conflictLabel)]] : []),
    ['Validation', statusTag(p.validation_status || '—')],
    ...(baselineImpactTag ? [['Baseline Impact', baselineImpactTag]] : []),
    ...(p.recommended_action ? [['Recommended Action', p.recommended_action]] : []),
    ...(p.source_title ? [['Source', p.source_title]] : [['Source ID', p.source_id || '—']]),
    ['Source Type', p.source_type || '—'],
    ['Created', formatDateTime(p.created_at)],
    ['Updated', formatDateTime(p.updated_at)],
    ['Items', p.items?.length ?? p.change_packet_items?.length ?? '—'],
  ];
  metas.forEach(([k, v]) => {
    const item = el('div', { className: 'meta-item' }, el('div', { className: 'meta-key' }, k));
    const val = el('div', { className: 'meta-val' });
    if (v instanceof Node) val.appendChild(v);
    else val.textContent = String(v);
    item.appendChild(val);
    metaGrid.appendChild(item);
  });
  metaSection.appendChild(metaGrid);
  body.appendChild(metaSection);

  // Rationale
  if (p.rationale) {
    const ratSection = el('div', { className: 'detail-section' });
    ratSection.appendChild(el('h4', {}, 'Rationale'));
    ratSection.appendChild(el('p', { style: { fontSize: '13px', color: 'var(--color-text)', lineHeight: '1.6' } }, p.rationale));
    body.appendChild(ratSection);
  }

  // Diff rows
  const items = p.items || p.change_packet_items || [];
  if (items.length > 0) {
    const diffSection = el('div', { className: 'detail-section' });
    diffSection.appendChild(el('h4', {}, `Changes (${items.length} field${items.length !== 1 ? 's' : ''})`));

    items.forEach(item => {
      const row = el('div', { className: 'diff-row' });
      const field = el('div', { className: 'diff-field' });
      const pathLabel = el('span', { className: 'field-path' }, item.field_path || item.field || '—');
      field.appendChild(pathLabel);

      if (item.entity_type) {
        const drScope = CP_ENTITY_SCOPE_MAP[item.entity_type] || null;
        field.appendChild(el('span', {
          style: { fontSize: '10px', fontFamily: 'monospace', color: 'var(--color-text-muted)', marginLeft: '6px' }
        }, item.entity_type));

        if (drScope) {
          const drBtn = el('button', { className: 'cp-drill-link' }, 'View in Design Review →');
          drBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const anchor = item.entity_id ? `dr-entity-${item.entity_id}` : '';
            setDrillDown(drScope, anchor);
            navigate('design_review');
          });
          field.appendChild(drBtn);
        }
      }

      row.appendChild(field);
      row.appendChild(el('span', { className: 'diff-old' }, item.old_value ?? 'null'));
      row.appendChild(el('span', { className: 'diff-arrow' }, '→'));
      row.appendChild(el('span', { className: item.new_value != null ? 'diff-new' : 'diff-new empty' },
        item.new_value ?? '(removed)'
      ));
      diffSection.appendChild(row);
    });

    body.appendChild(diffSection);
  }

  // Action buttons
  const actionSection = el('div', { className: 'detail-section' });
  actionSection.appendChild(el('h4', {}, 'Actions'));
  const confirmArea = el('div', { style: { marginTop: '8px' } });
  const btnGroup = el('div', { className: 'btn-group' });

  const makeActionBtn = (label, cls, action) => {
    const btn = el('button', { className: `btn ${cls}` }, label);
    btn.addEventListener('click', () => {
      confirmArea.innerHTML = '';
      const confirm = el('div', { className: 'confirm-inline' },
        el('span', {}, `Confirm: ${label} packet ${p.packet_code || p.change_packet_id}?`),
        el('div', { className: 'btn-group' },
          buildConfirmBtn(`Yes, ${label}`, cls, async () => {
            btn.disabled = true;
            try {
              await apiFetch(`/change-packets/${p.change_packet_id}/${action}`, { method: 'POST' });
              showToast(`Packet ${action}d.`, 'success');
              const idx = allPackets.findIndex(x => x.change_packet_id === p.change_packet_id);
              const newStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : p.status;
              if (idx >= 0) allPackets[idx].status = newStatus;
              p.status = newStatus;
              const statusEl = pane.querySelector('.pane-header .tag');
              if (statusEl) { statusEl.replaceWith(statusTag(newStatus)); }
              confirmArea.innerHTML = '';
            } catch (err) {
              showToast(`Error: ${err.message}`, 'error');
            } finally { btn.disabled = false; }
          }),
          buildCancelBtn(() => { confirmArea.innerHTML = ''; })
        )
      );
      confirmArea.appendChild(confirm);
    });
    return btn;
  };

  if (p.status !== 'approved') btnGroup.appendChild(makeActionBtn('Approve', 'btn-success', 'approve'));
  if (p.status !== 'rejected') btnGroup.appendChild(makeActionBtn('Reject', 'btn-danger', 'reject'));
  btnGroup.appendChild(makeActionBtn('Send Back', 'btn-ghost', 'send-back'));

  const splitBtn = el('button', { className: 'btn btn-ghost' }, 'Split');
  splitBtn.addEventListener('click', async () => {
    try {
      await apiFetch(`/change-packets/${p.change_packet_id}/split`, { method: 'POST' });
      showToast('Split request submitted.', 'success');
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  });
  btnGroup.appendChild(splitBtn);

  actionSection.appendChild(btnGroup);
  actionSection.appendChild(confirmArea);
  body.appendChild(actionSection);

  pane.appendChild(body);
}

function buildConfirmBtn(label, cls, onClick) {
  const btn = el('button', { className: `btn btn-sm ${cls}` }, label);
  btn.addEventListener('click', onClick);
  return btn;
}

function buildCancelBtn(onClick) {
  const btn = el('button', { className: 'btn btn-sm btn-ghost' }, 'Cancel');
  btn.addEventListener('click', onClick);
  return btn;
}
