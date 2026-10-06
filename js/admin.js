// js/admin.js
// Administrator section ONLY. Every export below is gated on role === 'admin'
// and uses its own DOM ids (admin-*) so it can never collide with, or leak
// into, the shared student/teacher tabs (events.js / attendance.js).
import { supabase } from './supabaseClient.js';
import { $, esc, toast, tableMessage, statusBadge, fmtDateTime } from './ui.js';
import { suppressRealtime, realtimeSuppressed } from './app.js';
import {
  COURSES, YEARS, BLOCKS, courseLabel, yearLabel,
  fillSelect, ensureOption, applyLevelFields, readLevelFields, formatGradeClass
} from './education.js';

let profile = null;
let users = [];
const STATUS_OPTIONS = ['present', 'late', 'absent', 'excused'];

export function initAdmin(p) { profile = p; }

/** Called by the global realtime dispatcher (app.js) when profiles change:
 *  reload + re-render the Manage Users table. Admins only, and the echo of a
 *  local mutation (changeRole/toggleActive/saveUserProfile) is skipped. */
export async function refreshUsersRealtime() {
  if (!requireAdmin() || realtimeSuppressed()) return;
  await loadUsers({ silent: true });
  renderUsers();
}

/** Hard gate: every admin-section renderer returns early unless the user is an admin. */
function requireAdmin() {
  return Boolean(profile && profile.role === 'admin');
}

export async function loadUsers({ silent = false } = {}) {
  const tbody = document.getElementById('users-body');
  if (tbody && !silent) tableMessage(tbody, 5, 'Loading users...', 'loading');
  const { data, error } = await supabase
    .from('profiles').select('*').order('created_at', { ascending: false });
  if (error) {
    if (tbody) tableMessage(tbody, 5, 'Could not load users.', 'error');
    toast('Could not load users: ' + error.message, 'error');
    users = [];
    return;
  }
  users = data || [];
}

function roleBadge(role) {
  const map = {
    admin: 'bg-purple-100 text-purple-700',
    teacher: 'bg-blue-100 text-blue-700',
    student: 'bg-slate-100 text-slate-700'
  };
  return `<span class="px-2.5 py-1 rounded-full text-xs font-semibold ${map[role] || ''}">${esc(role)}</span>`;
}

export function renderUsers() {
  const tbody = document.getElementById('users-body');
  if (!tbody) return;
  const term = (document.getElementById('user-search')?.value || '').toLowerCase().trim();
  const list = users.filter(u =>
    !term ||
    (u.full_name || '').toLowerCase().includes(term) ||
    (u.email || '').toLowerCase().includes(term) ||
    (u.student_no || '').toLowerCase().includes(term));

  if (list.length === 0) {
    tableMessage(tbody, 5, term ? 'No users match your search.' : 'No users found.');
    return;
  }

  tbody.innerHTML = list.map(u => {
    const isSelf = u.id === profile.id;
    const roleOpts = ['student', 'teacher', 'admin'].map(r =>
      `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`).join('');
    return `
      <tr class="hover:bg-slate-50">
        <td class="p-4">
          <div class="font-semibold">${esc(u.full_name || '(no name)')}</div>
          <div class="text-xs text-slate-500">${esc(u.email)}</div>
        </td>
        <td class="p-4 text-sm text-slate-600">
          ${esc(u.student_no || '-')}${u.grade_class ? ` Â· ${esc(u.grade_class)}` : ''}
          ${u.department ? `<div class="text-xs text-slate-400">${esc(u.department)}</div>` : ''}
        </td>
        <td class="p-4">${roleBadge(u.role)}</td>
        <td class="p-4">
          ${u.is_active
            ? '<span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700">Active</span>'
            : '<span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-100 text-rose-700">Inactive</span>'}
        </td>
        <td class="p-4 text-right space-x-1 whitespace-nowrap">
          <select data-role-user="${u.id}" ${isSelf ? 'disabled' : ''} class="text-xs border border-slate-300 rounded px-2 py-1 ${isSelf ? 'opacity-50' : ''}">${roleOpts}</select>
          <button data-edit-user="${u.id}" class="px-2.5 py-1 text-xs bg-indigo-50 text-indigo-600 rounded hover:bg-indigo-100 font-medium">Edit</button>
          <button data-toggle-active="${u.id}" data-active="${u.is_active}" ${isSelf ? 'disabled' : ''}
            class="px-2.5 py-1 text-xs rounded font-medium ${isSelf ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : (u.is_active ? 'bg-amber-50 text-amber-700 hover:bg-amber-100' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100')}">
            ${u.is_active ? 'Deactivate' : 'Activate'}
          </button>
        </td>
      </tr>`;
  }).join('');
}

export async function changeRole(userId, role) {
  const { data, error } = await supabase.rpc('admin_set_role', { p_user_id: userId, p_role: role });
  if (error) { toast('Could not change role: ' + error.message, 'error'); return; }
  suppressRealtime(); // ignore this change's realtime echo
  if (data.result !== 'success') { toast(data.message, 'error'); return; }
  toast(data.message, 'success');
  await loadUsers(); renderUsers();
}

export async function toggleActive(userId, currentActive) {
  const { data, error } = await supabase.rpc('admin_set_active',
    { p_user_id: userId, p_active: !currentActive });
  if (error) { toast('Could not update account: ' + error.message, 'error'); return; }
  suppressRealtime(); // ignore this change's realtime echo
  if (data.result !== 'success') { toast(data.message, 'error'); return; }
  toast(data.message, 'success');
  await loadUsers(); renderUsers();
}

/* ---------- edit user profile modal ---------- */
let editId = null;

/**
 * Repopulate + show/hide the level-driven selects in the edit-user modal.
 * Called on every open and on every Educational Level change (delegated from
 * app.js, which owns the single document-level change listener).
 */
export function renderEditUserLevelFields() {
  const levelSel = document.getElementById('modal-user-level');
  const form = document.getElementById('user-form');
  if (!levelSel || !form) return;
  const level = levelSel.value;
  const waiting = level ? 'Select...' : 'Select Educational Level first';

  fillSelect(document.getElementById('modal-user-course'), COURSES[level], { placeholder: waiting });
  fillSelect(document.getElementById('modal-user-year'),   YEARS[level],   { placeholder: waiting });
  fillSelect(document.getElementById('modal-user-block'),  BLOCKS,         { placeholder: 'Select Block...' });

  applyLevelFields(form, level);

  const c = document.getElementById('modal-user-course-label');
  if (c) c.textContent = courseLabel(level);
  const y = document.getElementById('modal-user-year-label');
  if (y) y.textContent = yearLabel(level);
}

export function openEditUser(id) {
  const u = users.find(x => x.id === id);
  if (!u) return;
  editId = id;
  $('#modal-user-name').value = u.full_name || '';
  $('#modal-user-phone').value = u.phone || '';
  $('#modal-user-studentno').value = u.student_no || '';
  $('#modal-user-title').value = u.title || '';

  // Rebuild the option lists for this level BEFORE restoring the values, so
  // ensureOption() has a full list to check against.
  const levelSel = $('#modal-user-level');
  ensureOption(levelSel, u.educational_level);
  levelSel.value = u.educational_level || '';
  renderEditUserLevelFields();

  const courseSel = $('#modal-user-course');
  const yearSel   = $('#modal-user-year');
  const blockSel  = $('#modal-user-block');
  ensureOption(courseSel, u.course);    courseSel.value = u.course || '';
  ensureOption(yearSel,   u.year_level); yearSel.value   = u.year_level || '';
  ensureOption(blockSel,  u.block);      blockSel.value  = u.block || '';
  $('#modal-user-section').value = u.section || '';

  const m = document.getElementById('user-modal');
  m.classList.remove('hidden'); m.classList.add('flex');
}

export function closeEditUser() {
  const m = document.getElementById('user-modal');
  m.classList.add('hidden'); m.classList.remove('flex');
}

export async function saveUserProfile(e) {
  e.preventDefault();
  const edu = readLevelFields(e.target);

  const payload = {
    full_name: $('#modal-user-name').value.trim(),
    phone: $('#modal-user-phone').value.trim(),
    student_no: $('#modal-user-studentno').value.trim() || null,
    title: $('#modal-user-title').value.trim() || null,
    // Choosing "Not set" clears the whole group, because applyLevelFields()
    // disables every dependent control when the level is empty.
    educational_level: edu.educational_level,
    course:            edu.course,
    year_level:        edu.year_level,
    block:             edu.block,
    section:           edu.section,
    // denormalised pair, regenerated from the columns above so the reports in
    // js/reports.js and the Manage Users table stay in step
    department: edu.course || null,
    grade_class: formatGradeClass(edu.educational_level, edu.year_level, edu.block, edu.section) || null
  };
  const { error } = await supabase.from('profiles').update(payload).eq('id', editId);
  if (error) { toast('Could not save user: ' + error.message, 'error'); return; }
  suppressRealtime(); // ignore this change's realtime echo
  toast('User profile updated.', 'success');
  closeEditUser();
  await loadUsers(); renderUsers();
  renderAdminOverview();
}

/* ---------- School-wide attendance oversight ---------- */
/** Admin-only. RLS (profiles_admin_all / audit_select_admin) scopes what is returned. */
export async function renderAdminOverview() {
  const box = document.getElementById('admin-overview');
  if (!box || !profile || profile.role !== 'admin') return;

  box.innerHTML = '<p class="text-sm text-slate-400">Loading attendance overview...</p>';

  const [eventsRes, attRes] = await Promise.all([
    supabase.from('events').select('id, name, status, start_datetime'),
    supabase.from('attendance').select('event_id, status, recorded_at')
  ]);

  if (eventsRes.error || attRes.error) {
    box.innerHTML = `<p class="text-sm text-rose-600">${
      esc((eventsRes.error || attRes.error).message)}</p>`;
    return;
  }

  const events = eventsRes.data || [];
  const attendance = attRes.data || [];

  // Roll attendance up per event so an admin sees totals across the whole school.
  const byEvent = new Map();
  attendance.forEach(a => {
    if (!byEvent.has(a.event_id)) byEvent.set(a.event_id, { total: 0, present: 0 });
    const bucket = byEvent.get(a.event_id);
    bucket.total += 1;
    if (a.status === 'present' || a.status === 'late') bucket.present += 1;
  });

  if (events.length === 0) {
    box.innerHTML = '<p class="text-sm text-slate-400">No events have been created yet.</p>';
    return;
  }

  const card = (label, val, color) => `
    <div class="bg-slate-50 rounded-lg border border-slate-200 p-3 text-center">
      <div class="text-lg font-bold ${color}">${val}</div>
      <div class="text-[10px] uppercase text-slate-500 font-semibold">${label}</div>
    </div>`;

  const totals = { present: 0, late: 0, absent: 0, excused: 0 };
  attendance.forEach(a => { totals[a.status] = (totals[a.status] || 0) + 1; });

  box.innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
      ${card('Events', events.length, 'text-indigo-600')}
      ${card('Check-ins', attendance.length, 'text-indigo-600')}
      ${card('Present', totals.present, 'text-emerald-600')}
      ${card('Late', totals.late, 'text-amber-600')}
      ${card('Absent', totals.absent, 'text-rose-600')}
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-left border-collapse text-sm min-w-[520px]">
        <thead class="bg-slate-100 text-slate-600 uppercase text-xs">
          <tr>
            <th class="p-3">Event</th>
            <th class="p-3">Status</th>
            <th class="p-3">Date</th>
            <th class="p-3 text-right">Check-ins</th>
            <th class="p-3 text-right">Attended</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-200">
          ${events.map(e => {
            const b = byEvent.get(e.id) || { total: 0, present: 0 };
            return `<tr class="hover:bg-slate-50">
              <td class="p-3 font-medium">${esc(e.name)}</td>
              <td class="p-3">${statusBadge(e.status)}</td>
              <td class="p-3 text-slate-500">${esc(fmtDateTime(e.start_datetime))}</td>
              <td class="p-3 text-right">${b.total}</td>
              <td class="p-3 text-right text-emerald-600 font-semibold">${b.present}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}
/* ============ 2. MANAGE EVENTS (admin only) ============ */

/** Fill the admin-only event filter. Admins may filter across every event. */
export function populateAdminRecordsFilter(events) {
  const sel = document.getElementById('admin-records-event-select');
  if (!sel || !requireAdmin()) return;
  const list = Array.isArray(events) ? events : [];
  const keep = sel.value;
  sel.innerHTML = '<option value="">All events</option>' +
    list.map(e => `<option value="${esc(String(e.id))}">${esc(e.name)} (${esc(e.status)})</option>`).join('');
  if (keep) sel.value = keep;
}

export async function renderAdminEvents() {
  const tbody = document.getElementById('admin-events-body');
  if (!tbody || !requireAdmin()) return;
  tableMessage(tbody, 4, 'Loading events...', 'loading');

  const { data, error } = await supabase
    .from('events')
    .select('id, name, venue, status, start_datetime')
    .order('start_datetime', { ascending: false });

  if (error) {
    tableMessage(tbody, 4, 'Could not load events: ' + error.message, 'error');
    return;
  }
  const rows = data || [];
  if (rows.length === 0) {
    tableMessage(tbody, 4, 'No events yet. Use "Create Event" to add one.');
    return;
  }

  tbody.innerHTML = rows.map(e => `
    <tr class="hover:bg-slate-50 align-top">
      <td class="p-4">
        <div class="font-semibold text-slate-800">${esc(e.name)}</div>
        <div class="text-xs text-slate-500">${esc(e.venue || '-')}</div>
      </td>
      <td class="p-4 text-slate-600 text-sm">${esc(fmtDateTime(e.start_datetime))}</td>
      <td class="p-4">${statusBadge(e.status)}</td>
      <td class="p-4 text-right">
        <div class="inline-flex items-center gap-1 whitespace-nowrap justify-end">
          <button data-admin-act="qr" data-id="${e.id}"
            class="px-2.5 py-1 text-xs bg-purple-50 text-purple-600 rounded hover:bg-purple-100 font-medium">QR</button>
          <button data-admin-act="edit" data-id="${e.id}"
            class="px-2.5 py-1 text-xs bg-indigo-50 text-indigo-600 rounded hover:bg-indigo-100 font-medium">Edit</button>
          ${e.status === 'open'
            ? `<button data-admin-act="close" data-id="${e.id}"
                 class="px-2.5 py-1 text-xs bg-amber-50 text-amber-700 rounded hover:bg-amber-100 font-medium">Close</button>`
            : `<button data-admin-act="open" data-id="${e.id}"
                 class="px-2.5 py-1 text-xs bg-emerald-50 text-emerald-700 rounded hover:bg-emerald-100 font-medium">Open</button>`}
          <button data-admin-act="del" data-id="${e.id}"
            class="px-2.5 py-1 text-xs bg-rose-50 text-rose-600 rounded hover:bg-rose-100 font-medium">Delete</button>
        </div>
      </td>
    </tr>`).join('');
}
/* ====== 3. MANAGE / CORRECT ATTENDANCE RECORDS (admin only) ====== */

export async function renderAdminRecords() {
  const tbody = document.getElementById('admin-records-body');
  if (!tbody || !requireAdmin()) return;
  const eventId = document.getElementById('admin-records-event-select')?.value || '';

  tableMessage(tbody, 5, 'Loading attendance records...', 'loading');

  // Attendance fetch with FK embeds. `attendance` has TWO FKs to profiles
  // (student_id, recorded_by), so the profiles embed MUST name the exact
  // constraint (see sql/01_schema.sql). The events column is `name`.
  let query = supabase
    .from('attendance')
    .select(`
      id,
      status,
      recorded_at,
      student_id,
      event_id,
      profiles:profiles!attendance_student_id_fkey ( full_name ),
      events:events!attendance_event_id_fkey ( name )
    `)
    .order('recorded_at', { ascending: false });
  if (eventId) query = query.eq('event_id', eventId);

  const { data, error } = await query;
  if (error) {
    tableMessage(tbody, 5, 'Could not load records: ' + error.message, 'error');
    return;
  }
  console.log("RAW ATTENDANCE DATA FROM SUPABASE:", JSON.stringify(data, null, 2));
  const rows = data || [];
  renderAdminRecordsSummary(rows);

  const missing = rows.filter(r => !r.student);
  if (missing.length > 0) {
    console.warn(
      `renderAdminRecords: ${missing.length} row(s) returned no student profile. ` +
      'Check RLS on profiles (is_admin / is_active) or missing profile rows (06_backfill_profiles.sql).'
    );
  }

  if (rows.length === 0) {
    tableMessage(tbody, 5, eventId
      ? 'No attendance recorded for this event yet.'
      : 'No attendance records found.');
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const opts = STATUS_OPTIONS.map(s =>
      `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s}</option>`).join('');
    const studentName = r.profiles?.full_name || r.student_id || 'Unknown';
    const studentNo = r.student?.student_no || r.profiles?.student_no || '';
    const gradeClass = r.student?.grade_class || r.profiles?.grade_class || '';
    return `
      <tr class="hover:bg-slate-50 align-top">
        <td class="p-4">
          <div class="font-semibold">${esc(studentName)}</div>
          <div class="text-xs text-slate-500">${esc(studentNo)} ${esc(gradeClass)}</div>
        </td>
        <td class="p-4 text-slate-600">${esc(r.events?.name || '-')}</td>
        <td class="p-4">
          <select data-admin-status="${r.id}"
            class="text-xs border border-slate-300 rounded px-2 py-1 focus:ring-2 focus:ring-indigo-500 focus:outline-none">${opts}</select>
        </td>
        <td class="p-4 text-slate-500 text-sm">${esc(fmtDateTime(r.recorded_at))}</td>
        <td class="p-4 text-right">
          <button data-admin-del-record="${r.id}"
            class="px-2.5 py-1 text-xs bg-rose-50 text-rose-600 rounded hover:bg-rose-100 font-medium whitespace-nowrap">Delete</button>
        </td>
      </tr>`;
  }).join('');
}

function renderAdminRecordsSummary(rows) {
  const box = document.getElementById('admin-records-summary');
  if (!box) return;
  const counts = { present: 0, late: 0, absent: 0, excused: 0 };
  rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const card = (label, val, color) => `
    <div class="bg-white rounded-xl border border-slate-200 p-4 text-center">
      <div class="text-2xl font-bold ${color}">${val}</div>
      <div class="text-xs text-slate-500 uppercase font-semibold">${label}</div>
    </div>`;
  box.innerHTML = `<div class="grid grid-cols-2 sm:grid-cols-5 gap-3">
    ${card('Total', rows.length, 'text-indigo-600')}
    ${card('Present', counts.present, 'text-emerald-600')}
    ${card('Late', counts.late, 'text-amber-600')}
    ${card('Absent', counts.absent, 'text-rose-600')}
    ${card('Excused', counts.excused, 'text-blue-600')}
  </div>`;
}

export async function updateAdminRecordStatus(recordId, status) {
  if (!requireAdmin()) return;
  const { error } = await supabase.from('attendance').update({ status }).eq('id', recordId);
  if (error) { toast('Could not update record: ' + error.message, 'error'); return; }
  suppressRealtime();
  toast('Attendance status updated.', 'success');
  renderAdminRecords();
  renderAdminOverview();
}

export async function deleteAdminRecord(recordId, rowEl = null) {
  if (!requireAdmin()) return;
  if (!confirm('Delete this attendance record? This cannot be undone.')) return;
  // Request the removed row back: RLS can make a DELETE a silent no-op
  // (success, zero rows), so only proceed when Supabase confirms removal.
  const { data, error } = await supabase.from('attendance').delete().eq('id', recordId).select('id');
  if (error) { console.error('deleteAdminRecord', error); toast('Could not delete record: ' + error.message, 'error'); return; }
  if (!data || data.length === 0) {
    console.error('deleteAdminRecord: 0 rows removed for id', recordId);
    toast('Delete blocked — the record still exists. Check your permissions and try again.', 'error');
    return;
  }
  // Remove the deleted row instantly, then re-fetch so counts stay truthful.
  // The realtime echo is suppressed briefly so it can't resurrect the row.
  if (rowEl && rowEl.isConnected) rowEl.remove();
  suppressRealtime();
  toast('Attendance record deleted.', 'success');
  renderAdminRecords();
  renderAdminOverview();
}
/* ====== 4. SYSTEM RECORDS / REPORTS (admin only) ====== */

export async function exportAdminCSV() {
  if (!requireAdmin()) return;
  const eventId = document.getElementById('admin-records-event-select')?.value || '';

  let query = supabase.from('attendance').select(
    'status, method, recorded_at, ' +
    'student:profiles!attendance_student_id_fkey(full_name, student_no, grade_class, email), ' +
    'events!attendance_event_id_fkey(name, venue, start_datetime)'
  ).order('recorded_at', { ascending: false });
  if (eventId) query = query.eq('event_id', eventId);

  const { data, error } = await query;
  if (error) { toast('Export failed: ' + error.message, 'error'); return; }
  if (!data || data.length === 0) { toast('No records to export.', 'warning'); return; }

  const rows = [['Student Name', 'Student No', 'Grade/Class', 'Event', 'Venue', 'Status', 'Method', 'Recorded At']];
  data.forEach(r => rows.push([
    (r.student?.full_name || '').trim() || r.student?.email || '', r.student?.student_no || '', r.student?.grade_class || '',
    r.events?.name || '', r.events?.venue || '', r.status, r.method,
    new Date(r.recorded_at).toLocaleString()
  ]));

  const csv = rows.map(row =>
    row.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `campusqr_admin_report_${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast('Report exported to CSV.', 'success');
}
