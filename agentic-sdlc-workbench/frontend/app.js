/**
 * app.js — Agentic SDLC Workbench bootstrap & shared utilities
 */

// ============================================================
// State
// ============================================================
let currentUserId = null;
let currentUserName = null;
let currentProjectId = null;
let currentModule = null;

const MODULE_LOADERS = {
  home: () => import('./modules/home.js'),
  ingest: () => import('./modules/ingest.js'),
  projects: () => import('./modules/projects.js'),
  trust: () => import('./modules/trust.js'),
  change_packets: () => import('./modules/change_packets.js'),
  evidence: () => import('./modules/evidence.js'),
  audit: () => import('./modules/audit.js'),
  baseline: () => import('./modules/baseline.js'),
  library: () => import('./modules/library.js'),
  validation: () => import('./modules/validation.js'),
  design_review: () => import('./modules/design_review.js'),
  testing: () => import('./modules/testing.js'),
  build_export: () => import('./modules/build_export.js'),
  cost_projections: () => import('./modules/cost_projections.js'),
  cost_management: () => import('./modules/cost_management.js'),
  reports: () => import('./modules/reports.js'),
  admin_ai: () => import('./modules/admin_ai.js'),
  admin_best_practices: () => import('./modules/admin_best_practices.js'),
  servicenow_sync: () => import('./modules/servicenow_sync.js'),
  servicenow_assessment: () => import('./modules/servicenow_assessment.js'),
};

// ============================================================
// Bootstrap
// ============================================================
export async function initApp() {
  const storedUserId = localStorage.getItem('asdlc_user_id');
  const storedUserName = localStorage.getItem('asdlc_user_name');

  if (storedUserId && storedUserName) {
    currentUserId = storedUserId;
    currentUserName = storedUserName;
    setUserPill(currentUserName);
    showApp();
    await loadProjects();
    registerSidebarHandlers();
    registerProjectSelectorHandler();
    await navigate('home');
  } else {
    await showUserModal();
  }
}

function showApp() {
  document.getElementById('user-modal').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
}

// ============================================================
// Navigation
// ============================================================
export async function navigate(moduleName) {
  currentModule = moduleName;

  // Update sidebar active state
  document.querySelectorAll('.nav-item').forEach(btn => {
    const active = btn.dataset.module === moduleName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-current', active ? 'page' : 'false');
  });

  const container = document.getElementById('main-content');
  container.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><span>Loading&hellip;</span></div>';

  const loader = MODULE_LOADERS[moduleName];
  if (!loader) {
    container.innerHTML = `<div class="error-state">Unknown module: ${moduleName}</div>`;
    return;
  }

  try {
    const mod = await loader();
    await mod.render(container);
  } catch (err) {
    console.error(`Failed to render module "${moduleName}":`, err);
    container.innerHTML = `<div class="error-state"><strong>Error loading module:</strong> ${err.message}</div>`;
  }
}

// ============================================================
// Sidebar
// ============================================================
function registerSidebarHandlers() {
  document.querySelectorAll('.nav-item[data-module]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.module));
  });

  // Mobile toggle
  const toggle = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  if (toggle && sidebar) {
    toggle.addEventListener('click', () => sidebar.classList.toggle('open'));
    // Close on outside click
    document.addEventListener('click', e => {
      if (sidebar.classList.contains('open') &&
          !sidebar.contains(e.target) &&
          e.target !== toggle) {
        sidebar.classList.remove('open');
      }
    });
  }
}

// ============================================================
// Project selector
// ============================================================
async function loadProjects() {
  const select = document.getElementById('project-select');
  try {
    const data = await apiFetch('/projects');
    const projects = Array.isArray(data) ? data : (data.items || data.projects || []);

    while (select.options.length > 1) select.remove(1);

    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.project_id;
      const ver = p.version_string ? ` v${p.version_string}` : (p.version != null ? ` v${p.version}` : '');
      opt.textContent = `${p.client_name ? p.client_name + ' — ' : ''}${p.project_name}${ver}`;
      select.appendChild(opt);
    });

    // Restore previously selected project — only if it still exists
    const storedProject = localStorage.getItem('asdlc_project_id');
    if (storedProject && projects.some(p => p.project_id === storedProject)) {
      select.value = storedProject;
      currentProjectId = storedProject;
    } else if (storedProject) {
      // Stale ID — clear it and default to first project
      localStorage.removeItem('asdlc_project_id');
      if (projects.length > 0) {
        currentProjectId = projects[0].project_id;
        select.value = currentProjectId;
        localStorage.setItem('asdlc_project_id', currentProjectId);
      }
    }
  } catch (err) {
    console.warn('Could not load projects:', err.message);
  }
}

function registerProjectSelectorHandler() {
  const select = document.getElementById('project-select');
  select.addEventListener('change', () => {
    currentProjectId = select.value || null;
    if (currentProjectId) {
      localStorage.setItem('asdlc_project_id', currentProjectId);
    } else {
      localStorage.removeItem('asdlc_project_id');
    }
    // Re-render active module with new project context
    if (currentModule) navigate(currentModule);
  });
}

// ============================================================
// User picker modal
// ============================================================
async function showUserModal() {
  const modal = document.getElementById('user-modal');
  const list = document.getElementById('user-list');
  modal.style.display = 'flex';

  try {
    const data = await apiFetch('/users');
    const users = Array.isArray(data) ? data : (data.items || data.users || []);

    if (users.length === 0) {
      list.innerHTML = '<div class="empty-state"><p>No users found. Check API connection.</p></div>';
      return;
    }

    list.innerHTML = '';
    users.forEach(user => {
      const item = document.createElement('button');
      item.className = 'user-item';
      const initials = getInitials(user.display_name || 'U');
      item.innerHTML = `
        <div class="user-item-avatar">${initials}</div>
        <div class="user-item-info">
          <div class="user-item-name">${escHtml(user.display_name)}</div>
          <div class="user-item-role">${escHtml(user.role || user.email || '')}</div>
        </div>
      `;
      item.addEventListener('click', () => {
        currentUserId = String(user.user_id);
        currentUserName = user.display_name;
        localStorage.setItem('asdlc_user_id', currentUserId);
        localStorage.setItem('asdlc_user_name', currentUserName);
        setUserPill(currentUserName);
        showApp();
        loadProjects().then(() => {
          registerSidebarHandlers();
          registerProjectSelectorHandler();
          navigate('home');
        });
      });
      list.appendChild(item);
    });
  } catch (err) {
    list.innerHTML = `<div class="error-state"><strong>Could not load users:</strong> ${err.message}</div>`;
  }
}

function setUserPill(name) {
  const display = document.getElementById('user-name-display');
  const avatar = document.getElementById('user-avatar');
  if (display) display.textContent = name;
  if (avatar) avatar.textContent = getInitials(name);

  // Make the pill clickable to re-open the user picker (switch user)
  const pill = document.getElementById('user-pill');
  if (pill && !pill.dataset.clickBound) {
    pill.dataset.clickBound = '1';
    pill.style.cursor = 'pointer';
    pill.title = 'Switch user';
    pill.addEventListener('click', () => {
      // Clear stored identity so the picker re-runs the full login flow
      localStorage.removeItem('asdlc_user_id');
      localStorage.removeItem('asdlc_user_name');
      currentUserId = null;
      currentUserName = null;
      showUserModal();
    });
  }
}

// ============================================================
// API Fetch
// ============================================================
export async function apiFetch(path, options = {}) {
  // When the body is FormData, let the browser set Content-Type automatically
  // (it must include the multipart boundary).  For everything else, default to JSON.
  const isFormData = options.body instanceof FormData;
  const headers = isFormData
    ? { ...(options.headers || {}) }
    : { 'Content-Type': 'application/json', ...(options.headers || {}) };

  if (currentUserId) headers['X-User-ID'] = currentUserId;

  // Strip the internal sentinel before passing to fetch
  const { _isFormData, ...fetchOptions } = options;

  const res = await fetch(`/api/v1${path}`, {
    ...fetchOptions,
    headers,
  });

  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      errMsg = body.detail || body.message || errMsg;
    } catch {}
    throw new Error(errMsg);
  }

  // Handle 204 No Content
  if (res.status === 204) return null;

  return res.json();
}

// ============================================================
// Getters
// ============================================================
export function getCurrentProjectId() { return currentProjectId; }
export function getCurrentUserId() { return currentUserId; }

export function setCurrentProject(projectId) {
  currentProjectId = projectId;
  const select = document.getElementById('project-select');
  if (select) select.value = projectId;
  if (projectId) localStorage.setItem('asdlc_project_id', projectId);
  else localStorage.removeItem('asdlc_project_id');
}

// ============================================================
// Drill-down state (for inter-module navigation with anchor)
// ============================================================
let _pendingDrillDown = null;
export function setDrillDown(scope, anchor) { _pendingDrillDown = { scope, anchor }; }
export function consumeDrillDown() { const d = _pendingDrillDown; _pendingDrillDown = null; return d; }

// ============================================================
// Shared Render Helpers
// ============================================================

/**
 * Build a tag/chip span element.
 * @param {string} text
 * @param {'default'|'ok'|'warn'|'danger'|'accent'|'info'|'purple'|'muted'} variant
 */
export function tag(text, variant = 'default') {
  const span = document.createElement('span');
  span.className = variant === 'default' ? 'tag' : `tag tag-${variant}`;
  span.textContent = text;
  return span;
}

const STATUS_MAP = {
  // Generic
  active: 'ok', approved: 'ok', locked: 'ok', published: 'ok', resolved: 'ok',
  pass: 'ok', passed: 'ok', complete: 'ok', completed: 'ok',
  pending: 'warn', draft: 'warn', in_review: 'warn', review: 'warn',
  open: 'warn', in_progress: 'warn',
  failed: 'danger', rejected: 'danger', error: 'danger', invalid: 'danger',
  critical: 'danger', high: 'danger',
  medium: 'warn', low: 'accent',
  info: 'info', archived: 'muted', inactive: 'muted',
  override: 'purple', manual: 'purple',
};

export function statusTag(status) {
  if (!status) return tag('—', 'muted');
  const variant = STATUS_MAP[String(status).toLowerCase()] || 'muted';
  return tag(String(status).replace(/_/g, ' '), variant);
}

export function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-CA'); // YYYY-MM-DD
  } catch { return iso; }
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-CA') + ' ' +
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

/**
 * Minimal DOM builder.
 * el('div', { className: 'foo', id: 'bar' }, child1, 'text')
 */
export function el(tagName, attrs = {}, ...children) {
  const node = document.createElement(tagName);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') node.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        node.setAttribute(k, v);
      }
    }
  }
  for (const child of children) {
    if (child == null) continue;
    if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
  return node;
}

/**
 * Render a styled table.
 * @param {Array<{key:string,label:string,render?:fn}>} columns
 * @param {Array<object>} rows
 * @param {function} [onRowClick]
 */
export function renderTable(columns, rows, onRowClick) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';

  if (!rows || rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<p>No records found.</p>';
    wrap.appendChild(empty);
    return wrap;
  }

  const table = document.createElement('table');
  table.className = 'wf-table';

  // Head
  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  columns.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.label;
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  rows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    if (onRowClick) {
      tr.classList.add('clickable');
      tr.addEventListener('click', () => onRowClick(row, tr, idx));
    }
    columns.forEach(col => {
      const td = document.createElement('td');
      if (col.render) {
        const rendered = col.render(row[col.key], row);
        if (rendered instanceof Node) td.appendChild(rendered);
        else td.textContent = rendered ?? '—';
      } else {
        td.textContent = row[col.key] ?? '—';
      }
      if (col.className) td.className = col.className;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// ============================================================
// Toast
// ============================================================
export function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity .3s';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ============================================================
// Utility: HTML escape
// ============================================================
export function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getInitials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ============================================================
// Boot
// ============================================================
document.addEventListener('DOMContentLoaded', () => initApp());
