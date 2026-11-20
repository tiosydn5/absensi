// ============================================================================
// VECTRA // Main Application Controller (Command Center + Mobile Portal)
// ============================================================================

import { createDataClient, isDemoMode } from './config.js';
import {
  calculateHaversineDistance,
  captureWatermarkedPhoto,
  drawQrCodeToCanvas,
  formatWibDateTime,
  generateDeviceFingerprint,
  OfflineQueue,
  renderDemoCameraFrame,
  startLiveCamera,
  stopCameraStream
} from './anti-fraud.js';
import { getJakartaDateStr, getJakartaYearMonth } from './demo-engine.js';

const PAGE_SIZE = 10;

const state = {
  client: null,
  profile: null,
  deviceHash: '',
  viewShell: 'admin', // 'admin' | 'portal'
  activeModule: 'overview',
  portalTab: 'absen',
  bundle: null,
  kpis: null,
  loading: false,
  error: null,
  filters: {
    branchId: '',
    department: '',
    shiftId: '',
    startDate: getJakartaDateStr(-7),
    endDate: getJakartaDateStr(0)
  },
  attendanceFilter: { search: '', status: 'ALL', page: 1, pageSize: 10 },
  employeeFilter: { search: '', page: 1, pageSize: 10 },
  approvalFilter: { status: 'ALL' },
  payrollPeriod: getJakartaYearMonth(0),
  lastRefreshedAt: new Date().toISOString(),
  gps: {
    lat: null,
    lon: null,
    accuracy: null,
    preset: 'auto', // 'auto' | 'jkt_in' | 'dpk_in' | 'out_radius' | 'fake_zero'
    error: null,
    simulateDeviceMismatch: false,
    simulateOffline: false
  },
  offlineItems: [],
  activeCameraStream: null,
  kioskTimer: null,
  lastModalTrigger: null
};

function isEffectivelyOffline() {
  if (state.client?.mode === 'demo') return state.gps.simulateOffline;
  return !navigator.onLine || state.gps.simulateOffline;
}

// ----------------------------------------------------------------------------
// UTILITIES (XSS Escape, Rupiah & WIB Formatters, Toast & Accessible Modal)
// ----------------------------------------------------------------------------

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRupiah(amount) {
  const raw = Number(amount);
  const num = Number.isFinite(raw) ? Math.round(raw) : 0;
  return 'Rp ' + num.toLocaleString('id-ID');
}

function downloadCsv(filename, headers, rows) {
  const sanitizeCsvValue = (v) => {
    const str = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(str) && !/^-\d+(\.\d+)?$/.test(str)) {
      return `'${str}`;
    }
    return str;
  };
  const escapeCell = (v) => `"${sanitizeCsvValue(v).replace(/"/g, '""')}"`;
  const csv = [headers.map(escapeCell).join(','), ...rows.map((r) => r.map(escapeCell).join(','))].join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatWibTime(iso) {
  if (!iso) return '-';
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(iso)) + ' WIB';
}

function formatWibDate(dateOrIso) {
  if (!dateOrIso) return '-';
  const d = dateOrIso.length === 10 ? new Date(`${dateOrIso}T12:00:00+07:00`) : new Date(dateOrIso);
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(d);
}

function formatMins(mins) {
  const m = Number(mins || 0);
  if (m <= 0) return '0m';
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return h > 0 ? `${h}j ${rem}m` : `${rem}m`;
}

function getGreetingWib() {
  const hourStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    hour12: false
  }).format(new Date());
  const hr = Number(hourStr);
  if (hr < 11) return 'Selamat Pagi';
  if (hr < 15) return 'Selamat Siang';
  if (hr < 18) return 'Selamat Sore';
  return 'Selamat Malam';
}

function roleLabel(role) {
  const map = {
    super_admin: 'Super Admin',
    company_admin: 'HRD Admin',
    supervisor: 'Supervisor Cabang',
    employee: 'Karyawan'
  };
  return map[role] || role;
}

function initials(name) {
  return String(name || 'V')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0].toUpperCase())
    .join('');
}

function monthNameId(month) {
  const names = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
  ];
  return names[(Number(month) - 1) % 12] || String(month);
}

function statusPill(status, isFlagged = false) {
  if (isFlagged) {
    return '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-[#FEE2E2] text-[#991B1B] border border-[#FCA5A5]">FLAG FRAUD</span>';
  }
  const styles = {
    ON_TIME: 'bg-[#ECFCCB] text-[#3F6212] border-[#BEF264]',
    WFH: 'bg-[#E0F2FE] text-[#075985] border-[#7DD3FC]',
    FIELD: 'bg-[#FEF3C7] text-[#92400E] border-[#FCD34D]',
    LATE: 'bg-[#FEF3C7] text-[#92400E] border-[#F59E0B]',
    EARLY_LEAVE: 'bg-[#FEF3C7] text-[#92400E] border-[#F59E0B]',
    ABSENT: 'bg-[#FEE2E2] text-[#991B1B] border-[#FCA5A5]',
    pending_supervisor: 'bg-[#FEF3C7] text-[#92400E] border-[#F59E0B]',
    pending_hr: 'bg-[#E0F2FE] text-[#075985] border-[#7DD3FC]',
    approved: 'bg-[#ECFCCB] text-[#3F6212] border-[#BEF264]',
    rejected: 'bg-[#FEE2E2] text-[#991B1B] border-[#FCA5A5]',
    cancelled: 'bg-[#F3F4F6] text-[#374151] border-[#D1D5DB]',
    DRAFT: 'bg-[#FEF3C7] text-[#92400E] border-[#F59E0B]',
    FINALIZED: 'bg-[#E0F2FE] text-[#075985] border-[#7DD3FC]',
    PAID: 'bg-[#ECFCCB] text-[#3F6212] border-[#BEF264]'
  };
  const labels = {
    ON_TIME: 'Tepat Waktu',
    LATE: 'Terlambat',
    EARLY_LEAVE: 'Pulang Cepat',
    ABSENT: 'Alpha / Fraud',
    WFH: 'WFH',
    FIELD: 'Dinas Luar',
    pending_supervisor: 'Menunggu Supervisor',
    pending_hr: 'Menunggu HRD',
    approved: 'Disetujui',
    rejected: 'Ditolak',
    cancelled: 'Dibatalkan',
    DRAFT: 'Draft',
    FINALIZED: 'Final',
    PAID: 'Dibayar'
  };
  const cls = styles[status] || 'bg-[#F3F4F6] text-[#374151] border-[#D1D5DB]';
  return `<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border ${cls}">${esc(labels[status] || status)}</span>`;
}

function showToast(message, type = 'info') {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const palette = {
    success: 'bg-[#111815] text-[#ECFCCB] border-[#84CC16]',
    error: 'bg-[#991B1B] text-[#FFFFFF] border-[#FCA5A5]',
    warning: 'bg-[#FEF3C7] text-[#92400E] border-[#F59E0B]',
    info: 'bg-[#111815] text-[#FFFFFF] border-[#374151]'
  };
  const toast = document.createElement('div');
  toast.className = `pointer-events-auto p-3.5 rounded border text-xs font-medium shadow-sm flex items-start justify-between gap-3 ${palette[type] || palette.info}`;
  toast.innerHTML = `<span>${esc(message)}</span><button type="button" class="text-xs font-bold opacity-80 hover:opacity-100 px-1" aria-label="Tutup notifikasi">&times;</button>`;
  toast.querySelector('button').addEventListener('click', () => toast.remove());
  region.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

let activeModalCleanup = null;

function closeModal() {
  if (state.activeCameraStream) {
    stopCameraStream(state.activeCameraStream);
    state.activeCameraStream = null;
  }
  if (state.kioskTimer) {
    clearInterval(state.kioskTimer);
    state.kioskTimer = null;
  }
  if (activeModalCleanup) {
    activeModalCleanup();
    activeModalCleanup = null;
  }
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
  if (state.lastModalTrigger && typeof state.lastModalTrigger.focus === 'function') {
    state.lastModalTrigger.focus();
    state.lastModalTrigger = null;
  }
}

function openModal({ title, subtitle = '', bodyHtml, maxWidth = 'max-w-2xl', onMount = null }) {
  closeModal();
  state.lastModalTrigger = document.activeElement;
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div id="modal-backdrop" class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 overflow-y-auto">
      <div role="dialog" aria-modal="true" aria-labelledby="modal-title" class="bg-[#FFFFFF] border border-[#111815] rounded-md w-full ${maxWidth} max-h-[90vh] flex flex-col overflow-hidden">
        <div class="px-5 py-4 border-b border-[#E2E4E3] flex items-start justify-between gap-4 bg-[#F4F5F4]">
          <div>
            <h2 id="modal-title" class="text-base font-bold text-[#111815]">${esc(title)}</h2>
            ${subtitle ? `<p class="text-xs text-[#525856] mt-0.5">${esc(subtitle)}</p>` : ''}
          </div>
          <button type="button" id="modal-close-btn" aria-label="Tutup dialog" class="tap-target flex items-center justify-center rounded border border-[#B5BCB8] bg-[#FFFFFF] text-[#111815] hover:border-[#111815] px-2.5 text-sm font-semibold">
            Tutup
          </button>
        </div>
        <div id="modal-body" class="p-5 overflow-y-auto space-y-4">
          ${bodyHtml}
        </div>
      </div>
    </div>
  `;

  const dialog = root.querySelector('[role="dialog"]');
  const closeBtn = document.getElementById('modal-close-btn');
  const backdrop = document.getElementById('modal-backdrop');

  closeBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  const focusable = () =>
    dialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal();
      return;
    }
    if (e.key === 'Tab') {
      const nodes = focusable();
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  document.addEventListener('keydown', onKeyDown);
  activeModalCleanup = () => document.removeEventListener('keydown', onKeyDown);

  if (onMount) onMount(dialog);
  const firstNode = focusable()[0];
  if (firstNode) firstNode.focus();
}

// ----------------------------------------------------------------------------
// DATA LOADING & OFFLINE SYNC
// ----------------------------------------------------------------------------

async function refreshWorkspaceData() {
  state.loading = true;
  state.error = null;
  renderActiveSurface();

  try {
    const profile = state.profile;
    const bundle = await state.client.fetchWorkspaceBundle(profile.company_id);

    // Enforce supervisor branch scope in UI filters if supervisor
    if (profile.role === 'supervisor' && profile.branch_id) {
      state.filters.branchId = profile.branch_id;
    }

    const kpis = profile.role === 'employee'
      ? null
      : await state.client.getDashboardKpis({
          companyId: profile.company_id,
          branchId: state.filters.branchId || null,
          department: state.filters.department || null,
          shiftId: state.filters.shiftId || null,
          startDate: state.filters.startDate,
          endDate: state.filters.endDate
        });

    state.bundle = bundle;
    state.kpis = kpis;
    state.lastRefreshedAt = new Date().toISOString();
    state.offlineItems = await OfflineQueue.getAll();
  } catch (err) {
    state.error = err.message || 'Gagal memuat data workspace.';
  } finally {
    state.loading = false;
    updateShellChrome();
    renderActiveSurface();
  }
}

async function syncOfflineQueue() {
  const items = await OfflineQueue.getAll();
  if (!items.length) {
    showToast('Tidak ada antrean absensi offline.', 'info');
    return;
  }
  if (isEffectivelyOffline()) {
    showToast('Perangkat masih offline. Nyalakan koneksi untuk menyinkronkan antrean.', 'warning');
    return;
  }

  let synced = 0;
  let lastFailMsg = '';
  for (const item of items) {
    try {
      const res = item.action === 'out'
        ? await state.client.submitClockOut(item.payload)
        : await state.client.submitClockIn(item.payload);
      if (res && res.success) {
        await OfflineQueue.remove(item.localId);
        synced += 1;
      } else if (res && !res.success) {
        lastFailMsg = res.message || res.code || '';
      }
    } catch (err) {
      lastFailMsg = err.message || '';
    }
  }
  state.offlineItems = await OfflineQueue.getAll();
  updateShellChrome();
  if (synced > 0) {
    showToast(`${synced} absensi antrean offline berhasil disinkronkan.`, 'success');
    await refreshWorkspaceData();
  } else {
    showToast(lastFailMsg ? `Sinkronisasi gagal: ${lastFailMsg}` : 'Sinkronisasi gagal. Periksa pesan atau coba ulang.', 'error');
  }
}

// ----------------------------------------------------------------------------
// SHELL CHROME & FILTER SYNC
// ----------------------------------------------------------------------------

function updateShellChrome() {
  if (!state.profile || !state.bundle) return;
  const { profile, bundle, kpis } = state;

  document.getElementById('sidebar-company-name').textContent = bundle.company?.name || 'VECTRA Enterprise';
  const modeBadge = document.getElementById('sidebar-mode-badge');
  modeBadge.innerHTML = state.client.mode === 'demo'
    ? '<span class="w-2 h-2 rounded-full bg-[#84CC16]" aria-hidden="true"></span><span>DEMO SANDBOX</span>'
    : '<span class="w-2 h-2 rounded-full bg-[#84CC16]" aria-hidden="true"></span><span>SUPABASE LIVE</span>';

  const activeBranch = bundle.branches.find((b) => b.id === profile.branch_id);
  document.getElementById('sidebar-branch-pill').textContent =
    profile.role === 'supervisor' && activeBranch ? activeBranch.code : `${bundle.branches.length} Cabang`;

  document.getElementById('topbar-avatar').textContent = initials(profile.full_name);
  document.getElementById('topbar-user-name').textContent = profile.full_name;
  document.getElementById('topbar-user-role').textContent = roleLabel(profile.role);

  document.getElementById('hero-greeting').textContent = `Halo, ${profile.full_name}`;
  const todayLogsCount = bundle.attendance_logs.filter((l) => l.work_date === getJakartaDateStr(0)).length;
  document.getElementById('hero-shift-status').textContent =
    `${bundle.company?.name || ''} | ${todayLogsCount} check-in tercatat hari ini`;

  // Role-specific visibility
  const addEmpBtn = document.getElementById('hero-add-emp-btn');
  addEmpBtn.classList.toggle('hidden', !['company_admin', 'super_admin'].includes(profile.role));
  document.getElementById('nav-group-platform').classList.toggle('hidden', profile.role !== 'super_admin');
  document.getElementById('reset-demo-btn').classList.toggle('hidden', state.client.mode !== 'demo');

  const roleWrap = document.getElementById('demo-role-switcher-wrap');
  const sideRoleWrap = document.getElementById('sidebar-demo-role-wrap');
  const isDemo = state.client.mode === 'demo';
  roleWrap.style.display = isDemo ? '' : 'none';
  if (sideRoleWrap) sideRoleWrap.style.display = isDemo ? '' : 'none';
  if (isDemo) {
    document.getElementById('demo-role-select').value = profile.role;
    const sideSel = document.getElementById('sidebar-demo-role-select');
    if (sideSel) sideSel.value = profile.role;
  }

  // Sidebar & Notification Badges
  const fraudCount = kpis?.fraud_flags_count || 0;
  const pendingCount = kpis?.pending_approvals || 0;
  const totalAlerts = fraudCount + pendingCount;

  const fraudBadge = document.getElementById('nav-badge-fraud');
  fraudBadge.textContent = String(fraudCount);
  fraudBadge.classList.toggle('hidden', fraudCount === 0);

  const appBadge = document.getElementById('nav-badge-approvals');
  appBadge.textContent = String(pendingCount);
  appBadge.classList.toggle('hidden', pendingCount === 0);

  const notifBadge = document.getElementById('notif-badge');
  notifBadge.textContent = String(totalAlerts);
  notifBadge.classList.toggle('hidden', totalAlerts === 0);

  // Offline Queue status
  const syncDot = document.getElementById('sync-dot');
  const syncLabel = document.getElementById('sync-label');
  const qLen = state.offlineItems.length;
  if (isEffectivelyOffline()) {
    syncDot.className = 'w-2 h-2 rounded-full bg-[#DC2626]';
    syncLabel.textContent = qLen > 0 ? `Offline (${qLen})` : 'Offline';
  } else if (qLen > 0) {
    syncDot.className = 'w-2 h-2 rounded-full bg-[#D97706]';
    syncLabel.textContent = `Sync (${qLen})`;
  } else {
    syncDot.className = 'w-2 h-2 rounded-full bg-[#65A30D]';
    syncLabel.textContent = 'Sinkron';
  }

  // Populate Filter Dropdowns
  const branchSel = document.getElementById('filter-branch');
  branchSel.innerHTML = '<option value="">Semua Cabang</option>' +
    bundle.branches.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  branchSel.value = state.filters.branchId;
  branchSel.disabled = profile.role === 'supervisor';

  const depts = [...new Set(bundle.profiles.map((p) => p.department).filter(Boolean))].sort();
  const deptSel = document.getElementById('filter-dept');
  deptSel.innerHTML = '<option value="">Semua Divisi</option>' +
    depts.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  deptSel.value = state.filters.department;

  const shiftSel = document.getElementById('filter-shift');
  shiftSel.innerHTML = '<option value="">Semua Shift</option>' +
    bundle.shifts.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.start_time.slice(0, 5))}-${esc(s.end_time.slice(0, 5))})</option>`).join('');
  shiftSel.value = state.filters.shiftId;

  document.getElementById('filter-start-date').value = state.filters.startDate;
  document.getElementById('filter-end-date').value = state.filters.endDate;

  // Sidebar active item state
  document.querySelectorAll('#app-sidebar [data-nav]').forEach((btn) => {
    const isActive = btn.getAttribute('data-nav') === state.activeModule && !(state.activeModule === 'attendance' && state.attendanceFilter.status === 'FLAGGED');
    if (isActive) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  const fraudNavBtn = document.getElementById('sidebar-fraud-btn');
  if (fraudNavBtn) {
    if (state.activeModule === 'attendance' && state.attendanceFilter.status === 'FLAGGED') {
      fraudNavBtn.setAttribute('aria-current', 'page');
    } else {
      fraudNavBtn.removeAttribute('aria-current');
    }
  }

  // Portal header
  document.getElementById('portal-company-name').textContent = bundle.company?.name || 'VECTRA';
  document.getElementById('portal-user-title').textContent = `${profile.full_name} (${profile.employee_code})`;
  const backAdminBtn = document.getElementById('portal-back-admin-btn');
  backAdminBtn.classList.toggle('hidden', profile.role === 'employee');

  // Toggle shells
  const adminShell = document.getElementById('admin-shell');
  const portalShell = document.getElementById('employee-portal');
  if (state.viewShell === 'portal') {
    adminShell.classList.add('hidden');
    adminShell.classList.remove('lg:flex');
    portalShell.classList.remove('hidden');
  } else {
    portalShell.classList.add('hidden');
    adminShell.classList.remove('hidden');
    adminShell.classList.add('lg:flex');
  }

  // Filter bar only relevant on operational admin modules
  const filterBar = document.getElementById('global-filter-bar');
  filterBar.classList.toggle('hidden', !['overview', 'attendance', 'schedules', 'approvals'].includes(state.activeModule));
}

function getScopedEmployees() {
  const { bundle, filters, profile } = state;
  const effBranch = profile.role === 'supervisor' ? profile.branch_id : filters.branchId;
  return bundle.profiles.filter((p) => {
    if (effBranch && p.branch_id !== effBranch) return false;
    if (filters.department && p.department !== filters.department) return false;
    return true;
  });
}

function getScopedLogs() {
  const { bundle, filters } = state;
  const empIds = new Set(getScopedEmployees().map((e) => e.id));
  const schedMap = new Map(bundle.schedules.map((s) => [s.id, s]));
  return bundle.attendance_logs.filter((l) => {
    if (!empIds.has(l.employee_id)) return false;
    if (filters.startDate && l.work_date < filters.startDate) return false;
    if (filters.endDate && l.work_date > filters.endDate) return false;
    if (filters.shiftId) {
      const sch = schedMap.get(l.schedule_id);
      if (!sch || sch.shift_id !== filters.shiftId) return false;
    }
    return true;
  });
}

// ----------------------------------------------------------------------------
// RENDERING ROUTER
// ----------------------------------------------------------------------------

function renderActiveSurface() {
  if (state.viewShell === 'portal') {
    renderEmployeePortal();
    return;
  }

  const container = document.getElementById('main-view');
  if (state.loading) {
    container.innerHTML = `
      <div class="cmd-card p-8 text-center space-y-2" role="status">
        <p class="text-sm font-semibold text-[#111815]">Memuat data modul...</p>
        <p class="text-xs text-[#525856]">Menyinkronkan log absensi, jadwal shift, dan ringkasan KPI.</p>
      </div>`;
    return;
  }

  if (state.error) {
    container.innerHTML = `
      <div class="cmd-card p-6 border-[#DC2626] bg-[#FEE2E2] space-y-3" role="alert">
        <h2 class="text-sm font-bold text-[#991B1B]">Gagal Memuat Data Operasional</h2>
        <p class="text-xs text-[#991B1B]">${esc(state.error)}</p>
        <button type="button" id="retry-load-btn" class="btn-obsidian text-xs">Muat Ulang Data</button>
      </div>`;
    document.getElementById('retry-load-btn')?.addEventListener('click', refreshWorkspaceData);
    return;
  }

  const renderers = {
    overview: renderOverviewModule,
    attendance: renderAttendanceModule,
    schedules: renderSchedulesModule,
    approvals: renderApprovalsModule,
    employees: renderEmployeesModule,
    branches: renderBranchesModule,
    payroll: renderPayrollModule,
    tenants: renderTenantsModule
  };

  const fn = renderers[state.activeModule] || renderOverviewModule;
  fn(container);
}

// ----------------------------------------------------------------------------
// MODULE 1: COMMAND OVERVIEW (12 LIVE KPI CARDS + OPERATIONAL PRIORITY PANEL)
// ----------------------------------------------------------------------------

function renderOverviewModule(container) {
  const k = state.kpis || {};
  const kpiCards = [
    { label: 'Total Karyawan Aktif', val: k.total_active_employees ?? 0, sub: 'Karyawan terdaftar', tone: 'neutral', nav: 'employees', icon: 'M9 6a3 3 0 11-6 0 3 3 0 016 0zm8 0a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM1 16a5 5 0 0110 0v1H1v-1z' },
    { label: 'Hadir Hari Ini (%)', val: `${k.present_today ?? 0} (${k.attendance_rate_pct ?? 0}%)`, sub: 'Check-in valid terverifikasi', tone: 'lime', nav: 'attendance', icon: 'M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0z' },
    { label: 'Terlambat Hari Ini', val: k.late_today ?? 0, sub: 'Melewati batas grace period', tone: k.late_today > 0 ? 'warn' : 'neutral', nav: 'attendance', attStatus: 'LATE', icon: 'M10 2a8 8 0 100 16 8 8 0 000-16zm1 4H9v5l4.2 2.5 1-1.7-3.2-1.8V6z' },
    { label: 'Tanpa Keterangan (Alpha)', val: k.absent_today ?? 0, sub: 'Jadwal aktif tanpa log/izin', tone: k.absent_today > 0 ? 'danger' : 'neutral', nav: 'schedules', icon: 'M10 2a8 8 0 100 16 8 8 0 000-16zm3.7 10.3l-1.4 1.4L10 11.4l-2.3 2.3-1.4-1.4L8.6 10 6.3 7.7l1.4-1.4L10 8.6l2.3-2.3 1.4 1.4L11.4 10l2.3 2.3z' },
    { label: 'Sedang Lembur', val: k.currently_overtime ?? 0, sub: 'Melebihi jam selesai shift', tone: 'info', nav: 'attendance', icon: 'M11 2v6h5l-7 10v-6H4l7-10z' },
    { label: 'Cuti / Izin Aktif', val: k.active_leave_today ?? 0, sub: 'Disetujui dalam rentang', tone: 'info', nav: 'approvals', icon: 'M6 2v2H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-2V2h-2v2H8V2H6z' },
    { label: 'WFH / Dinas Luar', val: k.wfh_field_today ?? 0, sub: 'Mode kerja non-kantor', tone: 'info', nav: 'attendance', icon: 'M10 2a6 6 0 00-6 6c0 4.5 6 10 6 10s6-5.5 6-10a6 6 0 00-6-6zm0 8a2 2 0 110-4 2 2 0 010 4z' },
    { label: 'Pending Approvals', val: k.pending_approvals ?? 0, sub: 'Menunggu Supervisor / HRD', tone: k.pending_approvals > 0 ? 'warn' : 'neutral', nav: 'approvals', icon: 'M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V7.4a2 2 0 00-.6-1.4l-2.4-2.4A2 2 0 0013.6 3H4z' },
    { label: 'Fraud / GPS Anomaly Flag', val: k.fraud_flags_count ?? 0, sub: 'Butuh audit foto & koordinat', tone: k.fraud_flags_count > 0 ? 'danger' : 'lime', nav: 'attendance', attStatus: 'FLAGGED', icon: 'M10 2L2 5v5c0 4.4 3.4 8.3 8 9 4.6-.7 8-4.6 8-9V5l-8-3zm1 9H9V6h2v5zm0 3H9v-2h2v2z' },
    { label: 'Total Jam Kerja Bulan Ini', val: `${k.total_work_hours_month ?? 0} Jam`, sub: 'Akumulasi durasi kerja sah', tone: 'neutral', nav: 'attendance', icon: 'M3 4a1 1 0 011-1h12a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm4 3v6h2V7H7zm4 2v4h2V9h-2z' },
    { label: 'Estimasi Lembur Berjalan', val: formatRupiah(k.estimated_overtime_pay ?? 0), sub: 'Tarif 1.5x basis 1/173', tone: 'lime', nav: 'payroll', icon: 'M3 4a2 2 0 00-2 2v8a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2H3zm7 3a3 3 0 110 6 3 3 0 010-6z' },
    { label: 'Estimasi Payroll Bulan Ini', val: formatRupiah(k.estimated_payroll_total ?? 0), sub: 'Gaji pokok + lembur berjalan', tone: 'neutral', nav: 'payroll', icon: 'M4 3h12a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1zm2 4v2h8V7H6zm0 4v2h5v-2H6z' }
  ];

  const toneIconBox = {
    lime: 'bg-[#84CC16] text-[#111815]',
    warn: 'bg-[#FFFBEB] text-[#B45309] border border-[#F59E0B]',
    danger: 'bg-[#FEF2F2] text-[#DC2626] border border-[#FCA5A5]',
    info: 'bg-[#F0F9FF] text-[#0284C7] border border-[#BAE6FD]',
    neutral: 'bg-[#F4F5F4] text-[#111815] border border-[#E2E4E3]'
  };

  const empMap = new Map(state.bundle.profiles.map((p) => [p.id, p]));
  const branchMap = new Map(state.bundle.branches.map((b) => [b.id, b]));
  const scopedEmpIds = new Set(getScopedEmployees().map((e) => e.id));
  const flaggedLogs = getScopedLogs().filter((l) => l.is_flagged && !l.flag_reviewed_at);
  const pendingReqs = state.bundle.requests.filter(
    (r) => scopedEmpIds.has(r.employee_id) && (r.status === 'pending_supervisor' || r.status === 'pending_hr')
  );
  const recentLogs = getScopedLogs().slice(0, 6);
  const visibleBranches = state.profile.role === 'supervisor' && state.profile.branch_id
    ? state.bundle.branches.filter((b) => b.id === state.profile.branch_id)
    : state.bundle.branches;

  container.innerHTML = `
    <!-- 12 KPI Cards Grid (4x3 Desktop, 2x6 Tablet, 1x12 Mobile) -->
    <section aria-label="12 Indikator Kinerja Operasional">
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        ${kpiCards.map((c) => `
          <button type="button" data-kpi-nav="${esc(c.nav)}" data-kpi-status="${esc(c.attStatus || '')}" class="bg-[#FFFFFF] border border-[#E2E4E3] rounded-lg p-4 text-left hover:border-[#111815] transition-colors flex flex-col justify-between gap-3 min-h-[112px]">
            <div class="flex items-start justify-between gap-2 w-full">
              <span class="text-xs font-medium text-[#525856]">${esc(c.label)}</span>
              <span class="w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${toneIconBox[c.tone]}" aria-hidden="true">
                <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path d="${c.icon}"/></svg>
              </span>
            </div>
            <div>
              <div class="kpi-value text-xl xl:text-2xl font-bold text-[#111815] tabular-nums leading-tight">${esc(c.val)}</div>
              <div class="text-[11px] text-[#525856] mt-0.5">${esc(c.sub)}</div>
            </div>
          </button>
        `).join('')}
      </div>
    </section>

    <!-- Operational Action Panels -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-5">
      <!-- Left: Anti-Fraud & Approval Priority Queue -->
      <section class="lg:col-span-5 cmd-card p-5 space-y-4">
        <div class="flex items-center justify-between border-b border-[#E2E4E3] pb-3">
          <div>
            <h2 class="text-sm font-bold text-[#111815]">Antrean Audit &amp; Approval Prioritas</h2>
            <p class="text-xs text-[#525856]">Anomali GPS yang belum ditinjau dan persetujuan tertunda</p>
          </div>
          <button type="button" data-jump-nav="attendance" class="text-xs font-semibold text-[#3F6212] hover:underline py-1">Lihat Semua</button>
        </div>

        <div class="space-y-2.5">
          ${flaggedLogs.length === 0 && pendingReqs.length === 0
            ? `<div class="p-4 rounded bg-[#F4F5F4] border border-[#E2E4E3] text-xs text-[#4B5563]">Semua anomali GPS dan pengajuan tim sudah diproses.</div>`
            : ''}

          ${flaggedLogs.slice(0, 3).map((l) => {
            const emp = empMap.get(l.employee_id);
            return `
              <div class="p-3 rounded border border-[#FCA5A5] bg-[#FEF2F2] flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-bold text-[#991B1B] truncate">${esc(emp?.full_name || 'Karyawan')}</span>
                    <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#DC2626] text-[#FFFFFF]">FRAUD</span>
                  </div>
                  <p class="text-[11px] text-[#7F1D1D] mt-0.5 truncate">${esc(l.flag_reason || 'Anomali GPS')}</p>
                </div>
                <button type="button" data-audit-log="${esc(l.id)}" class="btn-outline text-xs px-3 shrink-0">Audit</button>
              </div>`;
          }).join('')}

          ${pendingReqs.slice(0, 3).map((r) => {
            const emp = empMap.get(r.employee_id);
            return `
              <div class="p-3 rounded border border-[#E2E4E3] bg-[#F4F5F4] flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-semibold text-[#111815] truncate">${esc(emp?.full_name || 'Karyawan')}</span>
                    ${statusPill(r.status)}
                  </div>
                  <p class="text-[11px] text-[#4B5563] mt-0.5 truncate">${esc(r.type)}: ${esc(r.reason)}</p>
                </div>
                <button type="button" data-jump-nav="approvals" class="btn-obsidian text-xs px-3 shrink-0">Tinjau</button>
              </div>`;
          }).join('')}
        </div>
      </section>

      <!-- Right: Live Branch Breakdown & Recent Logs -->
      <section class="lg:col-span-7 cmd-card p-5 space-y-4">
        <div class="flex items-center justify-between border-b border-[#E2E4E3] pb-3">
          <div>
            <h2 class="text-sm font-bold text-[#111815]">Aktivitas Check-In Terakhir &amp; Ringkasan Cabang</h2>
            <p class="text-xs text-[#525856]">Berdasarkan filter tanggal ${esc(state.filters.startDate)} s.d. ${esc(state.filters.endDate)}</p>
          </div>
          <button type="button" data-jump-nav="branches" class="text-xs font-semibold text-[#3F6212] hover:underline py-1">Kelola Cabang</button>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${visibleBranches.map((b) => {
            const bEmps = state.bundle.profiles.filter((p) => p.branch_id === b.id && p.is_active);
            const bTodayLogs = state.bundle.attendance_logs.filter((l) => l.branch_id === b.id && l.work_date === getJakartaDateStr(0));
            return `
              <div class="p-3.5 rounded border border-[#E2E4E3] bg-[#F4F5F4]">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs font-bold text-[#111815]">${esc(b.name)}</span>
                  <span class="text-[11px] font-semibold px-2 py-0.5 rounded bg-[#111815] text-[#84CC16] tabular-nums">${esc(b.radius_meters)}m</span>
                </div>
                <div class="mt-2 flex items-center justify-between text-xs text-[#4B5563] tabular-nums">
                  <span>Hadir Hari Ini: <strong class="text-[#111815]">${bTodayLogs.length}/${bEmps.length}</strong></span>
                  <span class="coord-val text-[11px]">${Number(b.latitude || 0).toFixed(4)}, ${Number(b.longitude || 0).toFixed(4)}</span>
                </div>
              </div>`;
          }).join('')}
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse text-xs">
            <thead>
              <tr class="border-b border-[#E2E4E3] text-[#525856]">
                <th class="py-2 pr-3 font-semibold">Karyawan</th>
                <th class="py-2 pr-3 font-semibold">Cabang</th>
                <th class="py-2 pr-3 font-semibold">Masuk</th>
                <th class="py-2 pr-3 font-semibold">Jarak</th>
                <th class="py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[#E2E4E3]">
              ${recentLogs.length === 0
                ? '<tr><td colspan="5" class="py-6 text-center text-[#525856]">Tidak ada log absensi pada filter tanggal yang dipilih.</td></tr>'
                : recentLogs.map((l) => {
                    const emp = empMap.get(l.employee_id);
                    const br = branchMap.get(l.branch_id);
                    return `
                      <tr class="hover:bg-[#F4F5F4]">
                        <td class="py-2.5 pr-3 font-medium text-[#111815]">${esc(emp?.full_name || '-')}</td>
                        <td class="py-2.5 pr-3 text-[#4B5563]">${esc(br?.code || '-')}</td>
                        <td class="py-2.5 pr-3 tabular-nums">${esc(formatWibTime(l.clock_in_at))}</td>
                        <td class="py-2.5 pr-3 tabular-nums">${l.clock_in_distance_m != null ? `${Math.round(l.clock_in_distance_m)}m` : '-'}</td>
                        <td class="py-2.5">${statusPill(l.status, l.is_flagged)}</td>
                      </tr>`;
                  }).join('')}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;

  container.querySelectorAll('[data-kpi-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-kpi-nav');
      const attStatus = btn.getAttribute('data-kpi-status');
      if (target === 'attendance' && attStatus) {
        state.attendanceFilter.status = attStatus;
        state.attendanceFilter.page = 1;
      }
      navigateToModule(target);
    });
  });

  container.querySelectorAll('[data-jump-nav]').forEach((btn) => {
    btn.addEventListener('click', () => navigateToModule(btn.getAttribute('data-jump-nav')));
  });

  container.querySelectorAll('[data-audit-log]').forEach((btn) => {
    btn.addEventListener('click', () => openAuditModal(btn.getAttribute('data-audit-log')));
  });
}

// ----------------------------------------------------------------------------
// MODULE 2: ATTENDANCE & ANTI-FRAUD AUDIT TABLE
// ----------------------------------------------------------------------------

function renderAttendanceModule(container) {
  const empMap = new Map(state.bundle.profiles.map((p) => [p.id, p]));
  const branchMap = new Map(state.bundle.branches.map((b) => [b.id, b]));
  const schedMap = new Map(state.bundle.schedules.map((s) => [s.id, s]));
  const shiftMap = new Map(state.bundle.shifts.map((s) => [s.id, s]));

  const q = state.attendanceFilter.search.trim().toLowerCase();
  const statusFilter = state.attendanceFilter.status;
  const pageSize = state.attendanceFilter.pageSize || PAGE_SIZE;

  const filtered = getScopedLogs().filter((l) => {
    if (statusFilter === 'FLAGGED' && !l.is_flagged) return false;
    if (statusFilter !== 'ALL' && statusFilter !== 'FLAGGED' && l.status !== statusFilter) return false;
    if (q) {
      const emp = empMap.get(l.employee_id);
      const hay = `${emp?.full_name || ''} ${emp?.employee_code || ''} ${l.flag_reason || ''} ${l.notes || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(state.attendanceFilter.page, totalPages);
  state.attendanceFilter.page = page;
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  container.innerHTML = `
    <section class="bg-[#FFFFFF] border border-[#E2E4E3] rounded-lg overflow-hidden">
      <!-- Card Header & Toolbar -->
      <div class="p-4 sm:p-5 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div>
          <h2 class="text-base font-bold text-[#111815]">Log Kehadiran &amp; Audit Anti-Fraud</h2>
          <p class="text-[11px] text-[#525856] tabular-nums">Last refreshed: ${esc(formatWibDateTime(state.lastRefreshedAt))}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="w-full sm:w-52">
            <label for="att-search" class="sr-only">Cari kolom</label>
            <input id="att-search" type="search" value="${esc(state.attendanceFilter.search)}" placeholder="Cari kolom..." class="cmd-input w-full text-xs">
          </div>
          <div>
            <label for="att-status-filter" class="sr-only">Filter status absensi</label>
            <select id="att-status-filter" class="cmd-input text-xs w-full sm:w-52">
              <option value="ALL">Semua Status (${getScopedLogs().length})</option>
              <option value="FLAGGED">Anomali / Flag Fraud</option>
              <option value="ON_TIME">Tepat Waktu</option>
              <option value="LATE">Terlambat</option>
              <option value="WFH">WFH</option>
              <option value="FIELD">Dinas Luar</option>
              <option value="ABSENT">Alpha / Ditolak</option>
            </select>
          </div>
          <button type="button" id="att-kiosk-btn" class="btn-lime text-xs px-3">QR Kiosk 15s</button>
          <button type="button" id="att-refresh-btn" class="btn-outline text-xs px-3">Refresh</button>
          <button type="button" id="att-csv-btn" class="btn-outline text-xs px-3">Export CSV</button>
          <button type="button" id="att-print-btn" class="btn-outline text-xs px-3">Print</button>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-xs sm:text-sm">
          <thead>
            <tr class="bg-[#F9FAFA] text-[11px] uppercase tracking-wider text-[#525856] border-y border-[#E2E4E3]">
              <th class="py-3 px-4 font-semibold">Tanggal &amp; Shift</th>
              <th class="py-3 px-4 font-semibold">Karyawan</th>
              <th class="py-3 px-4 font-semibold">Mode &amp; Metode</th>
              <th class="py-3 px-4 font-semibold">Clock In / Out</th>
              <th class="py-3 px-4 font-semibold">Jarak / Akurasi</th>
              <th class="py-3 px-4 font-semibold">Telat / Lembur</th>
              <th class="py-3 px-4 font-semibold">Status</th>
              <th class="py-3 px-4 font-semibold text-right">Aksi</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[#E2E4E3]">
            ${pageRows.length === 0
              ? `<tr><td colspan="8" class="p-8 text-center text-xs text-[#525856]">Tidak ada log absensi cocok dengan kriteria pencarian.</td></tr>`
              : pageRows.map((l) => {
                  const emp = empMap.get(l.employee_id);
                  const br = branchMap.get(l.branch_id);
                  const sch = schedMap.get(l.schedule_id);
                  const shf = sch ? shiftMap.get(sch.shift_id) : null;
                  return `
                    <tr class="hover:bg-[#F9FAFA] ${l.is_flagged ? 'bg-[#FEF2F2]/70' : ''}">
                      <td class="py-3 px-4 tabular-nums">
                        <div class="font-semibold text-[#111815] text-xs">${esc(formatWibDate(l.work_date))}</div>
                        <div class="text-[11px] text-[#525856]">${esc(shf?.name || 'Jadwal Reguler')} ${shf?.is_cross_day ? '(Cross-Day)' : ''}</div>
                      </td>
                      <td class="py-3 px-4">
                        <div class="font-semibold text-[#111815] text-xs">${esc(emp?.full_name || '-')}</div>
                        <div class="text-[11px] text-[#525856] tabular-nums">${esc(emp?.employee_code || '')} | ${esc(br?.code || '-')}</div>
                      </td>
                      <td class="py-3 px-4">
                        <div class="font-medium text-[#111815] text-xs">${esc(l.work_mode)}</div>
                        <div class="text-[11px] text-[#525856]">${esc(l.verification_method)}</div>
                      </td>
                      <td class="py-3 px-4 tabular-nums text-xs">
                        <div>In: <strong>${esc(formatWibTime(l.clock_in_at))}</strong></div>
                        <div class="text-[11px] text-[#525856]">Out: ${l.clock_out_at ? esc(formatWibTime(l.clock_out_at)) : 'Aktif'}</div>
                      </td>
                      <td class="py-3 px-4 tabular-nums text-xs">
                        <div>${l.clock_in_distance_m != null ? `${Math.round(l.clock_in_distance_m)}m` : '-'}</div>
                        <div class="text-[11px] ${Number(l.clock_in_accuracy_m) === 0 ? 'text-[#DC2626] font-bold' : 'text-[#525856]'}">Akurasi: ${l.clock_in_accuracy_m != null ? `${Math.round(l.clock_in_accuracy_m)}m` : '-'}</div>
                      </td>
                      <td class="py-3 px-4 tabular-nums text-xs">
                        <div>Telat: <span class="${l.late_minutes > 0 ? 'text-[#B45309] font-semibold' : ''}">${l.late_minutes}m</span></div>
                        <div class="text-[11px] text-[#525856]">Lembur: ${formatMins(l.overtime_minutes)}</div>
                      </td>
                      <td class="py-3 px-4 space-y-1">
                        <div>${statusPill(l.status, l.is_flagged)}</div>
                        ${l.flag_reason ? `<div class="text-[10px] font-semibold text-[#991B1B] max-w-[160px] truncate" title="${esc(l.flag_reason)}">${esc(l.flag_reason)}</div>` : ''}
                      </td>
                      <td class="py-3 px-4 text-right">
                        <button type="button" data-audit-log="${esc(l.id)}" class="btn-outline text-xs px-3">Audit</button>
                      </td>
                    </tr>`;
                }).join('')}
          </tbody>
        </table>
      </div>

      <!-- Footer Pagination -->
      <div class="px-4 py-3 bg-[#F9FAFA] border-t border-[#E2E4E3] flex flex-wrap items-center justify-between gap-3 text-xs">
        <span class="text-[#525856] tabular-nums font-medium">${filtered.length} records &bull; Page ${page} of ${totalPages}</span>
        <div class="flex items-center gap-2">
          <button type="button" id="att-prev-btn" class="btn-outline text-xs px-3" ${page <= 1 ? 'disabled' : ''}>Prev</button>
          <label for="att-page-size" class="sr-only">Jumlah baris per halaman</label>
          <select id="att-page-size" class="cmd-input text-xs py-1 px-2 tabular-nums">
            <option value="10" ${pageSize === 10 ? 'selected' : ''}>10 / hal</option>
            <option value="25" ${pageSize === 25 ? 'selected' : ''}>25 / hal</option>
            <option value="50" ${pageSize === 50 ? 'selected' : ''}>50 / hal</option>
          </select>
          <button type="button" id="att-next-btn" class="btn-outline text-xs px-3" ${page >= totalPages ? 'disabled' : ''}>Next</button>
        </div>
      </div>
    </section>
  `;

  document.getElementById('att-status-filter').value = statusFilter;
  document.getElementById('att-search').addEventListener('input', (e) => {
    const cursor = e.target.selectionStart ?? e.target.value.length;
    state.attendanceFilter.search = e.target.value;
    state.attendanceFilter.page = 1;
    renderAttendanceModule(container);
    const input = document.getElementById('att-search');
    if (input) {
      input.focus();
      input.setSelectionRange(cursor, cursor);
    }
  });
  document.getElementById('att-status-filter').addEventListener('change', (e) => {
    state.attendanceFilter.status = e.target.value;
    state.attendanceFilter.page = 1;
    renderAttendanceModule(container);
  });
  document.getElementById('att-page-size').addEventListener('change', (e) => {
    state.attendanceFilter.pageSize = Number(e.target.value) || 10;
    state.attendanceFilter.page = 1;
    renderAttendanceModule(container);
  });
  document.getElementById('att-prev-btn').addEventListener('click', () => {
    if (state.attendanceFilter.page > 1) {
      state.attendanceFilter.page -= 1;
      renderAttendanceModule(container);
    }
  });
  document.getElementById('att-next-btn').addEventListener('click', () => {
    if (state.attendanceFilter.page < totalPages) {
      state.attendanceFilter.page += 1;
      renderAttendanceModule(container);
    }
  });
  document.getElementById('att-kiosk-btn').addEventListener('click', openKioskQrModal);
  document.getElementById('att-refresh-btn').addEventListener('click', refreshWorkspaceData);
  document.getElementById('att-csv-btn').addEventListener('click', () => {
    downloadCsv(
      `vectra-absensi-${state.filters.startDate}-${state.filters.endDate}.csv`,
      ['Tanggal', 'NIK', 'Nama', 'Cabang', 'Mode', 'Clock In', 'Clock Out', 'Jarak (m)', 'Akurasi (m)', 'Telat (m)', 'Lembur (m)', 'Status', 'Flag'],
      filtered.map((l) => {
        const emp = empMap.get(l.employee_id);
        const br = branchMap.get(l.branch_id);
        return [
          l.work_date, emp?.employee_code || '', emp?.full_name || '', br?.code || '', l.work_mode,
          formatWibTime(l.clock_in_at), l.clock_out_at ? formatWibTime(l.clock_out_at) : 'Aktif',
          l.clock_in_distance_m ?? '', l.clock_in_accuracy_m ?? '', l.late_minutes, l.overtime_minutes,
          l.status, l.flag_reason || ''
        ];
      })
    );
    showToast('File CSV rekap absensi berhasil diunduh.', 'success');
  });
  document.getElementById('att-print-btn').addEventListener('click', () => printAttendanceReport(filtered));
  container.querySelectorAll('[data-audit-log]').forEach((btn) => {
    btn.addEventListener('click', () => openAuditModal(btn.getAttribute('data-audit-log')));
  });
}

// ----------------------------------------------------------------------------
// MODULE 3: SCHEDULES & CROSS-DAY SHIFTS
// ----------------------------------------------------------------------------

function renderSchedulesModule(container) {
  const { shifts, schedules } = state.bundle;
  const scopedEmps = getScopedEmployees();
  const empMap = new Map(scopedEmps.map((e) => [e.id, e]));
  const shiftMap = new Map(shifts.map((s) => [s.id, s]));

  const filteredSchedules = schedules
    .filter((s) => empMap.has(s.employee_id) && (!state.filters.startDate || s.work_date >= state.filters.startDate) && (!state.filters.endDate || s.work_date <= state.filters.endDate))
    .slice(0, 40);

  container.innerHTML = `
    <div class="space-y-5">
      <!-- Master Shifts -->
      <section class="cmd-card p-5 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E4E3] pb-3">
          <div>
            <h2 class="text-base font-bold text-[#111815]">Template Shift &amp; Pengaturan Cross-Day</h2>
            <p class="text-xs text-[#525856]">Mendukung shift reguler, split shift, dan shift malam lintas hari (H+1).</p>
          </div>
          ${['company_admin', 'super_admin'].includes(state.profile.role)
            ? '<button type="button" id="add-shift-btn" class="btn-obsidian text-xs">+ Template Shift</button>'
            : ''}
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          ${shifts.map((s) => `
            <div class="p-4 rounded border border-[#E2E4E3] bg-[#F4F5F4] space-y-2">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <span class="text-[11px] font-bold text-[#525856] tabular-nums">${esc(s.code)}</span>
                  <h3 class="text-sm font-bold text-[#111815]">${esc(s.name)}</h3>
                </div>
                ${s.is_cross_day ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-[#111815] text-[#84CC16]">CROSS-DAY</span>' : ''}
              </div>
              <div class="text-xs text-[#111815] font-semibold tabular-nums">
                ${esc(s.start_time.slice(0, 5))} WIB - ${esc(s.end_time.slice(0, 5))} WIB ${s.is_cross_day ? '(+1 Hari)' : ''}
              </div>
              <div class="text-[11px] text-[#4B5563] tabular-nums">
                Toleransi Telat: ${s.grace_period_minutes} menit | Multiplier Lembur: ${s.overtime_rate_multiplier}x
              </div>
            </div>
          `).join('')}
        </div>
      </section>

      <!-- Employee Schedule Assignment Table -->
      <section class="cmd-card p-5 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E4E3] pb-3">
          <div>
            <h2 class="text-base font-bold text-[#111815]">Roster Penjadwalan Karyawan</h2>
            <p class="text-xs text-[#525856]">Menampilkan hingga 40 jadwal aktif dalam rentang tanggal filter.</p>
          </div>
          <button type="button" id="assign-schedule-btn" class="btn-lime text-xs">+ Tetapkan Jadwal Shift</button>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse text-xs">
            <thead>
              <tr class="border-b border-[#E2E4E3] bg-[#F4F5F4] text-[#525856]">
                <th class="p-3 font-semibold">Tanggal Kerja</th>
                <th class="p-3 font-semibold">Karyawan</th>
                <th class="p-3 font-semibold">Divisi</th>
                <th class="p-3 font-semibold">Shift</th>
                <th class="p-3 font-semibold">Mode Kerja</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[#E2E4E3]">
              ${filteredSchedules.length === 0
                ? '<tr><td colspan="5" class="p-6 text-center text-[#525856]">Belum ada jadwal pada rentang tanggal ini. Gunakan tombol "+ Tetapkan Jadwal Shift".</td></tr>'
                : filteredSchedules.map((sch) => {
                    const emp = empMap.get(sch.employee_id);
                    const shf = shiftMap.get(sch.shift_id);
                    return `
                      <tr class="hover:bg-[#F4F5F4]">
                        <td class="p-3 font-semibold tabular-nums">${esc(formatWibDate(sch.work_date))}</td>
                        <td class="p-3 font-medium">${esc(emp?.full_name || '-')} <span class="text-[#525856]">(${esc(emp?.employee_code || '')})</span></td>
                        <td class="p-3 text-[#4B5563]">${esc(emp?.department || '-')}</td>
                        <td class="p-3 tabular-nums">${esc(shf?.name || '-')} (${esc(shf?.start_time?.slice(0, 5) || '')}-${esc(shf?.end_time?.slice(0, 5) || '')})</td>
                        <td class="p-3"><span class="px-2 py-0.5 rounded border border-[#E2E4E3] bg-[#FFFFFF] font-semibold text-[11px]">${esc(sch.work_mode)}</span></td>
                      </tr>`;
                  }).join('')}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;

  document.getElementById('add-shift-btn')?.addEventListener('click', openCreateShiftModal);
  document.getElementById('assign-schedule-btn')?.addEventListener('click', openAssignScheduleModal);
}

// ----------------------------------------------------------------------------
// MODULE 4: APPROVALS & LEAVE WORKFLOW (2-STAGE SUPERVISOR -> HRD)
// ----------------------------------------------------------------------------

function renderApprovalsModule(container) {
  const empMap = new Map(state.bundle.profiles.map((p) => [p.id, p]));
  const scopedIds = new Set(getScopedEmployees().map((e) => e.id));
  const statusFilter = state.approvalFilter.status;

  const list = state.bundle.requests.filter((r) => {
    if (!scopedIds.has(r.employee_id)) return false;
    if (statusFilter !== 'ALL' && r.status !== statusFilter) return false;
    return true;
  });

  container.innerHTML = `
    <section class="cmd-card p-5 space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E4E3] pb-4">
        <div>
          <h2 class="text-base font-bold text-[#111815]">Workflow Approval 2 Tahap (Supervisor &rarr; HRD)</h2>
          <p class="text-xs text-[#525856]">Persetujuan akhir Cuti Tahunan otomatis memotong sisa saldo cuti karyawan.</p>
        </div>
        <button type="button" id="new-request-btn" class="btn-lime text-xs">+ Buat Pengajuan Baru</button>
      </div>

      <div class="flex flex-wrap gap-2">
        ${[
          ['ALL', 'Semua'],
          ['pending_supervisor', 'Tahap 1: Supervisor'],
          ['pending_hr', 'Tahap 2: HRD'],
          ['approved', 'Disetujui'],
          ['rejected', 'Ditolak']
        ].map(([val, lbl]) => `
          <button type="button" data-req-filter="${val}" class="min-h-[44px] px-3.5 rounded text-xs font-semibold border ${statusFilter === val ? 'bg-[#111815] text-[#FFFFFF] border-[#111815]' : 'bg-[#FFFFFF] text-[#111815] border-[#B5BCB8] hover:bg-[#F4F5F4]'}">${lbl}</button>
        `).join('')}
      </div>

      <div class="space-y-3">
        ${list.length === 0
          ? `<div class="p-8 text-center rounded bg-[#F4F5F4] border border-[#E2E4E3] text-xs text-[#525856]">Tidak ada pengajuan dengan status terpilih.</div>`
          : list.map((r) => {
              const emp = empMap.get(r.employee_id);
              const target = r.target_employee_id ? empMap.get(r.target_employee_id) : null;
              const canSupervisorAct = state.profile.role === 'supervisor' && r.status === 'pending_supervisor';
              const canHrAct = ['company_admin', 'super_admin'].includes(state.profile.role) && ['pending_supervisor', 'pending_hr'].includes(r.status);
              return `
                <article class="p-4 rounded border border-[#E2E4E3] bg-[#FFFFFF] flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div class="space-y-1.5">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="px-2 py-0.5 rounded bg-[#111815] text-[#84CC16] text-[10px] font-bold">${esc(r.type)}</span>
                      <span class="text-sm font-bold text-[#111815]">${esc(emp?.full_name || '-')}</span>
                      <span class="text-xs text-[#525856] tabular-nums">(${esc(emp?.employee_code || '')} | Sisa Cuti: ${emp?.leave_balance ?? 0} hari)</span>
                      ${statusPill(r.status)}
                    </div>
                    <p class="text-xs text-[#111815]">${esc(r.reason)}</p>
                    <div class="text-[11px] text-[#525856] tabular-nums flex flex-wrap gap-3">
                      <span>Tanggal: <strong>${esc(formatWibDate(r.start_date))}</strong> s.d. <strong>${esc(formatWibDate(r.end_date))}</strong></span>
                      ${r.hours_requested > 0 ? `<span>Durasi Lembur: <strong>${r.hours_requested} jam</strong></span>` : ''}
                      ${target ? `<span>Pengganti Shift: <strong>${esc(target.full_name)}</strong></span>` : ''}
                    </div>
                    ${r.rejection_reason ? `<p class="text-[11px] text-[#991B1B] font-medium">Alasan Penolakan: ${esc(r.rejection_reason)}</p>` : ''}
                  </div>

                  ${(canSupervisorAct || canHrAct) ? `
                    <div class="flex gap-2 shrink-0">
                      <button type="button" data-req-approve="${esc(r.id)}" class="btn-lime text-xs px-4">
                        ${state.profile.role === 'supervisor' ? 'Setujui (Ke HRD)' : 'Setujui Final'}
                      </button>
                      <button type="button" data-req-reject="${esc(r.id)}" class="btn-danger text-xs px-4">Tolak</button>
                    </div>` : ''}
                </article>`;
            }).join('')}
      </div>
    </section>
  `;

  container.querySelectorAll('[data-req-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.approvalFilter.status = btn.getAttribute('data-req-filter');
      renderApprovalsModule(container);
    });
  });

  document.getElementById('new-request-btn').addEventListener('click', openCreateRequestModal);

  container.querySelectorAll('[data-req-approve]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await state.client.processRequest(btn.getAttribute('data-req-approve'), 'approve', state.profile);
        showToast('Pengajuan berhasil diproses.', 'success');
        await refreshWorkspaceData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  container.querySelectorAll('[data-req-reject]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openRejectRequestModal(btn.getAttribute('data-req-reject'));
    });
  });
}

function openRejectRequestModal(requestId) {
  openModal({
    title: 'Tolak Pengajuan Karyawan',
    subtitle: 'Masukkan alasan penolakan yang akan tercatat di riwayat pengajuan.',
    maxWidth: 'max-w-md',
    bodyHtml: `
      <form id="reject-req-form" class="space-y-3">
        <div>
          <label for="reject-reason-input" class="block text-xs font-semibold mb-1">Alasan Penolakan</label>
          <textarea id="reject-reason-input" rows="3" required minlength="3" placeholder="Contoh: Jadwal bentrok dengan operasional cabang." class="cmd-input w-full text-xs"></textarea>
        </div>
        <div class="flex justify-end gap-2 pt-2 border-t border-[#E2E4E3]">
          <button type="button" id="reject-cancel-btn" class="btn-outline text-xs">Batal</button>
          <button type="submit" id="reject-submit-btn" class="btn-danger text-xs">Tolak Pengajuan</button>
        </div>
      </form>
    `,
    onMount: () => {
      document.getElementById('reject-cancel-btn').addEventListener('click', closeModal);
      document.getElementById('reject-req-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const reason = document.getElementById('reject-reason-input').value.trim();
        const btn = document.getElementById('reject-submit-btn');
        btn.disabled = true;
        try {
          await state.client.processRequest(requestId, 'reject', state.profile, reason || 'Ditolak');
          showToast('Pengajuan telah ditolak.', 'warning');
          closeModal();
          await refreshWorkspaceData();
        } catch (err) {
          showToast(err.message, 'error');
          btn.disabled = false;
        }
      });
    }
  });
}

// ----------------------------------------------------------------------------
// MODULE 5: EMPLOYEES & DEVICE BINDING DIRECTORY
// ----------------------------------------------------------------------------

function buildInviteShareUrl(token) {
  const base = `${window.location.origin}${window.location.pathname.replace(/app\.html.*$/, 'index.html')}`;
  const modeQ = state.client?.mode === 'demo' ? '&mode=demo' : '';
  return `${base}?invite=${encodeURIComponent(token)}${modeQ}`;
}

async function copyTextWithFeedback(text, label = 'Teks') {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'true');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    showToast(`${label} berhasil disalin ke clipboard.`, 'success');
  } catch {
    showToast(`Salin manual: ${text}`, 'info');
  }
}

function renderEmployeesModule(container) {
  const branchMap = new Map(state.bundle.branches.map((b) => [b.id, b]));
  const q = state.employeeFilter.search.trim().toLowerCase();
  const pageSize = state.employeeFilter.pageSize || PAGE_SIZE;
  const scoped = getScopedEmployees().filter((e) => {
    if (!q) return true;
    return `${e.full_name} ${e.employee_code} ${e.email} ${e.department} ${e.position}`.toLowerCase().includes(q);
  });

  const totalPages = Math.max(1, Math.ceil(scoped.length / pageSize));
  const page = Math.min(state.employeeFilter.page, totalPages);
  state.employeeFilter.page = page;
  const rows = scoped.slice((page - 1) * pageSize, page * pageSize);
  const isAdmin = ['company_admin', 'super_admin'].includes(state.profile.role);
  const isLive = state.client.mode === 'live';
  const invites = state.bundle.employee_invites || [];

  container.innerHTML = `
    <div class="space-y-5">
      <section class="bg-[#FFFFFF] border border-[#E2E4E3] rounded-lg overflow-hidden">
        <div class="p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h2 class="text-base font-bold text-[#111815]">Master Karyawan &amp; Device Binding</h2>
            <p class="text-[11px] text-[#525856] tabular-nums">Last refreshed: ${esc(formatWibDateTime(state.lastRefreshedAt))}</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <div class="w-full sm:w-56">
              <label for="emp-search" class="sr-only">Cari kolom karyawan</label>
              <input id="emp-search" type="search" value="${esc(state.employeeFilter.search)}" placeholder="Cari kolom NIK, nama, divisi..." class="cmd-input w-full text-xs">
            </div>
            ${isAdmin ? (isLive
              ? '<button type="button" id="emp-add-btn" class="btn-lime text-xs">+ Undang Karyawan</button>'
              : '<button type="button" id="emp-add-btn" class="btn-lime text-xs">+ Tambah</button><button type="button" id="emp-invite-btn" class="btn-obsidian text-xs">+ Link Undangan</button>'
            ) : ''}
            <button type="button" id="emp-refresh-btn" class="btn-outline text-xs px-3">Refresh</button>
            <button type="button" id="emp-csv-btn" class="btn-outline text-xs px-3">Export CSV</button>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse text-xs sm:text-sm">
            <thead>
              <tr class="bg-[#F9FAFA] text-[11px] uppercase tracking-wider text-[#525856] border-y border-[#E2E4E3]">
                <th class="py-3 px-4 font-semibold">NIK &amp; Nama</th>
                <th class="py-3 px-4 font-semibold">Cabang &amp; Divisi</th>
                <th class="py-3 px-4 font-semibold">Peran</th>
                <th class="py-3 px-4 font-semibold">Gaji Pokok</th>
                <th class="py-3 px-4 font-semibold">Sisa Cuti</th>
                <th class="py-3 px-4 font-semibold">Device Hash</th>
                <th class="py-3 px-4 font-semibold text-right">Aksi</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[#E2E4E3]">
              ${rows.length === 0
                ? '<tr><td colspan="7" class="p-8 text-center text-xs text-[#525856]">Tidak ada karyawan cocok dengan pencarian.</td></tr>'
                : rows.map((e) => {
                    const br = branchMap.get(e.branch_id);
                    return `
                      <tr class="hover:bg-[#F9FAFA] ${!e.is_active ? 'opacity-60' : ''}">
                        <td class="py-3 px-4">
                          <div class="font-bold text-[#111815] text-xs">${esc(e.full_name)}</div>
                          <div class="text-[11px] text-[#525856] tabular-nums">${esc(e.employee_code)} | ${esc(e.email)}</div>
                        </td>
                        <td class="py-3 px-4 text-xs">
                          <div class="font-medium">${esc(br?.code || '-')}</div>
                          <div class="text-[11px] text-[#525856]">${esc(e.department)} | ${esc(e.position)}</div>
                        </td>
                        <td class="py-3 px-4 text-xs font-semibold">${esc(roleLabel(e.role))}</td>
                        <td class="py-3 px-4 text-xs tabular-nums font-medium">${esc(formatRupiah(e.base_salary))}</td>
                        <td class="py-3 px-4 text-xs tabular-nums">${e.leave_balance} hari</td>
                        <td class="py-3 px-4 tabular-nums">
                          ${e.bound_device_hash
                            ? `<span class="px-2 py-0.5 rounded-md bg-[#ECFCCB] text-[#3F6212] border border-[#BEF264] text-[10px] font-semibold">${esc(e.bound_device_hash)}</span>`
                            : '<span class="text-[11px] text-[#525856]">Belum terikat</span>'}
                        </td>
                        <td class="py-3 px-4 text-right space-x-1 whitespace-nowrap">
                          ${isAdmin ? `
                            <button type="button" data-emp-edit="${esc(e.id)}" class="btn-outline text-xs px-2.5">Edit</button>
                            <button type="button" data-emp-reset-dev="${esc(e.id)}" class="btn-outline text-xs px-2.5" ${!e.bound_device_hash ? 'disabled' : ''}>Reset Device</button>
                          ` : '<span class="text-[11px] text-[#525856]">Hanya Baca</span>'}
                        </td>
                      </tr>`;
                  }).join('')}
            </tbody>
          </table>
        </div>

        <div class="px-4 py-3 bg-[#F9FAFA] border-t border-[#E2E4E3] flex flex-wrap items-center justify-between gap-3 text-xs">
          <span class="text-[#525856] tabular-nums font-medium">${scoped.length} records &bull; Page ${page} of ${totalPages}</span>
          <div class="flex items-center gap-2">
            <button type="button" id="emp-prev-btn" class="btn-outline text-xs px-3" ${page <= 1 ? 'disabled' : ''}>Prev</button>
            <label for="emp-page-size" class="sr-only">Baris per halaman</label>
            <select id="emp-page-size" class="cmd-input text-xs py-1 px-2 tabular-nums">
              <option value="10" ${pageSize === 10 ? 'selected' : ''}>10 / hal</option>
              <option value="25" ${pageSize === 25 ? 'selected' : ''}>25 / hal</option>
              <option value="50" ${pageSize === 50 ? 'selected' : ''}>50 / hal</option>
            </select>
            <button type="button" id="emp-next-btn" class="btn-outline text-xs px-3" ${page >= totalPages ? 'disabled' : ''}>Next</button>
          </div>
        </div>
      </section>

      ${isAdmin && (isLive || invites.length > 0) ? `
        <section class="bg-[#FFFFFF] border border-[#E2E4E3] rounded-lg overflow-hidden">
          <div class="p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E4E3]">
            <div>
              <h3 class="text-sm font-bold text-[#111815]">Daftar Undangan Karyawan (Self-Onboarding Link)</h3>
              <p class="text-[11px] text-[#525856]">Bagikan link unik ke karyawan baru agar mereka membuat kata sandi dan mengaktifkan akunnya sendiri.</p>
            </div>
            <button type="button" id="inv-section-add-btn" class="btn-obsidian text-xs">+ Buat Undangan Baru</button>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse text-xs">
              <thead>
                <tr class="bg-[#F9FAFA] text-[11px] uppercase tracking-wider text-[#525856] border-b border-[#E2E4E3]">
                  <th class="py-2.5 px-4 font-semibold">Karyawan &amp; Email</th>
                  <th class="py-2.5 px-4 font-semibold">Cabang &amp; Role</th>
                  <th class="py-2.5 px-4 font-semibold">Kode Token</th>
                  <th class="py-2.5 px-4 font-semibold">Status</th>
                  <th class="py-2.5 px-4 font-semibold text-right">Aksi</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[#E2E4E3]">
                ${invites.length === 0
                  ? '<tr><td colspan="5" class="p-5 text-center text-xs text-[#525856]">Belum ada undangan karyawan. Klik "+ Undang Karyawan" untuk mengundang tim Anda.</td></tr>'
                  : invites.map((inv) => {
                      const br = branchMap.get(inv.branch_id);
                      const isExpired = !inv.accepted_at && !inv.revoked_at && new Date(inv.expires_at).getTime() <= Date.now();
                      const isPending = !inv.accepted_at && !inv.revoked_at && !isExpired;
                      const badge = inv.accepted_at
                        ? '<span class="px-2 py-0.5 rounded bg-[#ECFCCB] text-[#3F6212] border border-[#BEF264] text-[10px] font-semibold">Sudah Bergabung</span>'
                        : inv.revoked_at
                          ? '<span class="px-2 py-0.5 rounded bg-[#F3F4F6] text-[#4B5563] border border-[#D1D5DB] text-[10px] font-semibold">Dibatalkan</span>'
                          : isExpired
                            ? '<span class="px-2 py-0.5 rounded bg-[#FEE2E2] text-[#991B1B] border border-[#FCA5A5] text-[10px] font-semibold">Kedaluwarsa</span>'
                            : '<span class="px-2 py-0.5 rounded bg-[#FEF3C7] text-[#92400E] border border-[#F59E0B] text-[10px] font-semibold">Menunggu Aktivasi</span>';
                      return `
                        <tr class="hover:bg-[#F9FAFA]">
                          <td class="py-2.5 px-4">
                            <div class="font-bold text-[#111815]">${esc(inv.full_name)} (${esc(inv.employee_code)})</div>
                            <div class="text-[11px] text-[#525856]">${esc(inv.email)}</div>
                          </td>
                          <td class="py-2.5 px-4">${esc(br?.code || '-')} | ${esc(roleLabel(inv.role))}</td>
                          <td class="py-2.5 px-4 font-mono text-[11px]">${esc(inv.invite_token)}</td>
                          <td class="py-2.5 px-4">${badge}</td>
                          <td class="py-2.5 px-4 text-right space-x-1 whitespace-nowrap">
                            ${isPending ? `
                              <button type="button" data-inv-copy="${esc(inv.invite_token)}" class="btn-outline text-xs px-2.5">Salin Link</button>
                              <button type="button" data-inv-revoke="${esc(inv.id)}" class="btn-danger text-xs px-2.5">Batalkan</button>
                            ` : '<span class="text-[11px] text-[#525856]">-</span>'}
                          </td>
                        </tr>`;
                    }).join('')}
              </tbody>
            </table>
          </div>
        </section>
      ` : ''}
    </div>
  `;

  document.getElementById('emp-add-btn')?.addEventListener('click', () => openEmployeeModal(null, isLive ? 'invite' : 'direct'));
  document.getElementById('emp-invite-btn')?.addEventListener('click', () => openEmployeeModal(null, 'invite'));
  document.getElementById('inv-section-add-btn')?.addEventListener('click', () => openEmployeeModal(null, 'invite'));
  document.getElementById('emp-refresh-btn').addEventListener('click', refreshWorkspaceData);
  document.getElementById('emp-csv-btn').addEventListener('click', () => {
    downloadCsv(
      'vectra-master-karyawan.csv',
      ['NIK', 'Nama Lengkap', 'Email', 'Cabang', 'Divisi', 'Jabatan', 'Peran', 'Gaji Pokok', 'Tunjangan Harian', 'Sisa Cuti', 'Device Hash'],
      scoped.map((e) => [
        e.employee_code, e.full_name, e.email, branchMap.get(e.branch_id)?.code || '',
        e.department, e.position, e.role, e.base_salary, e.daily_allowance, e.leave_balance, e.bound_device_hash || ''
      ])
    );
    showToast('Data master karyawan berhasil diekspor ke CSV.', 'success');
  });
  document.getElementById('emp-search').addEventListener('input', (e) => {
    const cursor = e.target.selectionStart ?? e.target.value.length;
    state.employeeFilter.search = e.target.value;
    state.employeeFilter.page = 1;
    renderEmployeesModule(container);
    const inp = document.getElementById('emp-search');
    if (inp) {
      inp.focus();
      inp.setSelectionRange(cursor, cursor);
    }
  });
  document.getElementById('emp-page-size').addEventListener('change', (e) => {
    state.employeeFilter.pageSize = Number(e.target.value) || 10;
    state.employeeFilter.page = 1;
    renderEmployeesModule(container);
  });
  document.getElementById('emp-prev-btn').addEventListener('click', () => {
    if (state.employeeFilter.page > 1) {
      state.employeeFilter.page -= 1;
      renderEmployeesModule(container);
    }
  });
  document.getElementById('emp-next-btn').addEventListener('click', () => {
    if (state.employeeFilter.page < totalPages) {
      state.employeeFilter.page += 1;
      renderEmployeesModule(container);
    }
  });
  container.querySelectorAll('[data-emp-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const emp = state.bundle.profiles.find((p) => p.id === btn.getAttribute('data-emp-edit'));
      if (emp) openEmployeeModal(emp);
    });
  });
  container.querySelectorAll('[data-emp-reset-dev]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await state.client.resetDeviceBinding(btn.getAttribute('data-emp-reset-dev'));
        showToast('Device binding berhasil direset. Karyawan dapat mengikat perangkat baru saat login/absen.', 'success');
        await refreshWorkspaceData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
  container.querySelectorAll('[data-inv-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const token = btn.getAttribute('data-inv-copy');
      copyTextWithFeedback(buildInviteShareUrl(token), 'Link undangan');
    });
  });
  container.querySelectorAll('[data-inv-revoke]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await state.client.revokeEmployeeInvite(btn.getAttribute('data-inv-revoke'));
        showToast('Undangan karyawan dibatalkan.', 'warning');
        await refreshWorkspaceData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

// ----------------------------------------------------------------------------
// MODULE 6: BRANCHES & GEOFENCE MANAGER
// ----------------------------------------------------------------------------

function renderBranchesModule(container) {
  const isAdmin = ['company_admin', 'super_admin'].includes(state.profile.role);

  container.innerHTML = `
    <section class="space-y-4">
      <div class="cmd-card p-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="text-base font-bold text-[#111815]">Cabang Operasional, Radius Geofence &amp; Secret QR</h2>
          <p class="text-xs text-[#525856]">Titik pusat koordinat WGS84 digunakan oleh PostgreSQL RPC untuk validasi Haversine.</p>
        </div>
        ${isAdmin ? '<button type="button" id="branch-add-btn" class="btn-lime text-xs">+ Cabang Baru</button>' : ''}
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
        ${state.bundle.branches.map((b) => {
          const staffCount = state.bundle.profiles.filter((p) => p.branch_id === b.id && p.is_active).length;
          return `
            <article class="cmd-card p-5 space-y-4">
              <div class="flex items-start justify-between gap-3 border-b border-[#E2E4E3] pb-3">
                <div>
                  <span class="text-[11px] font-bold text-[#3F6212] bg-[#ECFCCB] px-2 py-0.5 rounded">${esc(b.code)}</span>
                  <h3 class="text-base font-bold text-[#111815] mt-1">${esc(b.name)}</h3>
                  <p class="text-xs text-[#525856] mt-0.5">${esc(b.address)}</p>
                </div>
                <span class="text-xs font-bold px-2.5 py-1 rounded bg-[#111815] text-[#FFFFFF] tabular-nums shrink-0">${b.radius_meters} m</span>
              </div>

              <dl class="grid grid-cols-2 gap-3 text-xs tabular-nums">
                <div class="p-3 rounded bg-[#F4F5F4] border border-[#E2E4E3]">
                  <dt class="text-[#525856] text-[11px]">Latitude / Longitude</dt>
                  <dd class="font-semibold text-[#111815] mt-0.5">${Number(b.latitude || 0).toFixed(6)}, ${Number(b.longitude || 0).toFixed(6)}</dd>
                </div>
                <div class="p-3 rounded bg-[#F4F5F4] border border-[#E2E4E3]">
                  <dt class="text-[#525856] text-[11px]">Karyawan Aktif</dt>
                  <dd class="font-semibold text-[#111815] mt-0.5">${staffCount} orang</dd>
                </div>
              </dl>

              <div class="flex flex-wrap gap-2 pt-1">
                <button type="button" data-branch-kiosk="${esc(b.id)}" class="btn-obsidian text-xs flex-1">Buka QR Kiosk 15s</button>
                ${isAdmin ? `<button type="button" data-branch-edit="${esc(b.id)}" class="btn-outline text-xs flex-1">Edit Koordinat &amp; Radius</button>` : ''}
              </div>
            </article>`;
        }).join('')}
      </div>
    </section>
  `;

  document.getElementById('branch-add-btn')?.addEventListener('click', () => openBranchModal(null));
  container.querySelectorAll('[data-branch-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const br = state.bundle.branches.find((b) => b.id === btn.getAttribute('data-branch-edit'));
      if (br) openBranchModal(br);
    });
  });
  container.querySelectorAll('[data-branch-kiosk]').forEach((btn) => {
    btn.addEventListener('click', () => openKioskQrModal(btn.getAttribute('data-branch-kiosk')));
  });
}

// ----------------------------------------------------------------------------
// MODULE 7: PAYROLL & PRINTABLE SLIP GAJI
// ----------------------------------------------------------------------------

function renderPayrollModule(container) {
  const { month, year } = state.payrollPeriod;
  const empMap = new Map(state.bundle.profiles.map((p) => [p.id, p]));
  const rows = state.bundle.payrolls.filter((p) => p.period_month === month && p.period_year === year);
  const draftCount = rows.filter((r) => r.status === 'DRAFT').length;
  const finalizedUnposted = rows.filter((r) => r.status === 'FINALIZED' && !r.ledger_transaction_id);
  const otherFinalized = rows.length === 0
    ? state.bundle.payrolls.find((p) => p.status === 'FINALIZED' && !p.ledger_transaction_id)
    : null;
  const batches = (state.bundle.ledger_batches || []).filter((b) => b.period_month === month && b.period_year === year);
  const totalNet = rows.reduce((acc, r) => acc + Number(r.net_salary || 0), 0);
  const isAdmin = ['company_admin', 'super_admin'].includes(state.profile.role);

  container.innerHTML = `
    <div class="space-y-5">
      ${otherFinalized ? `
        <div class="p-3.5 rounded-lg border border-[#BAE6FD] bg-[#F0F9FF] flex flex-wrap items-center justify-between gap-3 text-xs">
          <span class="text-[#075985]">Terdapat slip payroll <strong>FINALIZED</strong> periode <strong>${monthNameId(otherFinalized.period_month)} ${otherFinalized.period_year}</strong> yang siap diposting ke Kronos Ledger.</span>
          <button type="button" id="pay-jump-finalized-btn" class="btn-obsidian text-xs px-3">Buka Periode ${monthNameId(otherFinalized.period_month)} ${otherFinalized.period_year}</button>
        </div>` : ''}
      <section class="bg-[#FFFFFF] border border-[#E2E4E3] rounded-lg overflow-hidden">
        <div class="p-4 sm:p-5 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div>
            <h2 class="text-base font-bold text-[#111815]">Payroll Engine &amp; Integrasi Kronos Ledger</h2>
            <p class="text-[11px] text-[#525856] tabular-nums">Last refreshed: ${esc(formatWibDateTime(state.lastRefreshedAt))} &bull; Basis 1/173 (1.5x / 2.0x)</p>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <label for="pay-month" class="sr-only">Bulan Payroll</label>
            <select id="pay-month" class="cmd-input text-xs">
              ${Array.from({ length: 12 }, (_, idx) => `<option value="${idx + 1}">${monthNameId(idx + 1)}</option>`).join('')}
            </select>
            <label for="pay-year" class="sr-only">Tahun Payroll</label>
            <input id="pay-year" type="number" min="2024" max="2030" value="${year}" class="cmd-input text-xs w-24 tabular-nums">
            ${isAdmin ? '<button type="button" id="pay-generate-btn" class="btn-lime text-xs">Generate Payroll</button>' : ''}
            ${isAdmin && draftCount > 0 ? `<button type="button" id="pay-finalize-all-btn" class="btn-outline text-xs">Finalisasi Draft (${draftCount})</button>` : ''}
            ${isAdmin ? `<button type="button" id="pay-post-ledger-btn" class="btn-obsidian text-xs" ${finalizedUnposted.length === 0 ? 'disabled' : ''}>Post ke Kronos Ledger (${finalizedUnposted.length})</button>` : ''}
            <button type="button" id="pay-csv-btn" class="btn-outline text-xs px-3" ${rows.length === 0 ? 'disabled' : ''}>Export CSV</button>
          </div>
        </div>

        <div class="px-4 sm:px-5 pb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div class="p-3.5 rounded-lg bg-[#F9FAFA] border border-[#E2E4E3]">
            <div class="text-[11px] text-[#525856]">Periode Aktif</div>
            <div class="text-sm font-bold text-[#111815] tabular-nums">${monthNameId(month)} ${year}</div>
          </div>
          <div class="p-3.5 rounded-lg bg-[#F9FAFA] border border-[#E2E4E3]">
            <div class="text-[11px] text-[#525856]">Slip Terbit / Siap Posting</div>
            <div class="text-sm font-bold text-[#111815] tabular-nums">${rows.length} Slip (${finalizedUnposted.length} Finalized)</div>
          </div>
          <div class="p-3.5 rounded-lg bg-[#F9FAFA] border border-[#E2E4E3]">
            <div class="text-[11px] text-[#525856]">Status Bridge Kronos</div>
            <div class="text-sm font-bold ${batches.length > 0 ? 'text-[#3F6212]' : 'text-[#B45309]'} tabular-nums">${batches.length > 0 ? `${batches.length} Batch Terposting` : 'Belum Diposting'}</div>
          </div>
          <div class="p-3.5 rounded-lg bg-[#111815] text-[#FFFFFF] border border-[#26332D]">
            <div class="text-[11px] text-[#D1D5DB]">Total Kewajiban Net Payout</div>
            <div class="text-sm font-bold text-[#84CC16] tabular-nums">${esc(formatRupiah(totalNet))}</div>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse text-xs sm:text-sm">
            <thead>
              <tr class="bg-[#F9FAFA] text-[11px] uppercase tracking-wider text-[#525856] border-y border-[#E2E4E3]">
                <th class="py-3 px-4 font-semibold">Karyawan</th>
                <th class="py-3 px-4 font-semibold">Hadir / WFO</th>
                <th class="py-3 px-4 font-semibold">Gaji Pokok</th>
                <th class="py-3 px-4 font-semibold">Tunj. Fisik</th>
                <th class="py-3 px-4 font-semibold">Upah Lembur</th>
                <th class="py-3 px-4 font-semibold">Potongan</th>
                <th class="py-3 px-4 font-semibold">Take Home Pay</th>
                <th class="py-3 px-4 font-semibold">Status &amp; Ledger</th>
                <th class="py-3 px-4 font-semibold text-right">Aksi</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[#E2E4E3]">
              ${rows.length === 0
                ? `<tr><td colspan="9" class="p-8 text-center text-xs text-[#525856]">Belum ada data payroll untuk ${monthNameId(month)} ${year}. Klik "Generate Payroll" untuk menghitung dari log absensi valid.</td></tr>`
                : rows.map((p) => {
                    const emp = empMap.get(p.employee_id);
                    const totalDed = Number(p.deductions_total || 0) + Number(p.fixed_deductions || 0);
                    return `
                      <tr class="hover:bg-[#F9FAFA]">
                        <td class="py-3 px-4">
                          <div class="font-bold text-[#111815] text-xs">${esc(emp?.full_name || '-')}</div>
                          <div class="text-[11px] text-[#525856] tabular-nums">${esc(p.reference_no)}</div>
                        </td>
                        <td class="py-3 px-4 tabular-nums text-xs">
                          <div>${p.total_present} hari (${p.total_wfo_days} WFO)</div>
                          <div class="text-[11px] text-[#525856]">Telat ${p.total_late_minutes}m | OT ${formatMins(p.total_overtime_minutes)}</div>
                        </td>
                        <td class="py-3 px-4 tabular-nums text-xs">${esc(formatRupiah(p.base_salary))}</td>
                        <td class="py-3 px-4 tabular-nums text-xs">${esc(formatRupiah(p.allowances_total))}</td>
                        <td class="py-3 px-4 tabular-nums text-xs text-[#3F6212] font-medium">${esc(formatRupiah(p.overtime_pay))}</td>
                        <td class="py-3 px-4 tabular-nums text-xs text-[#DC2626]">-${esc(formatRupiah(totalDed))}</td>
                        <td class="py-3 px-4 tabular-nums text-xs font-bold text-[#111815]">${esc(formatRupiah(p.net_salary))}</td>
                        <td class="py-3 px-4 space-y-1">
                          <div>${statusPill(p.status)}</div>
                          ${p.ledger_transaction_id ? `<div class="text-[10px] font-mono text-[#3F6212]">LEDGER: ${esc(String(p.ledger_transaction_id).slice(0, 14))}</div>` : ''}
                        </td>
                        <td class="py-3 px-4 text-right space-x-1 whitespace-nowrap">
                          <button type="button" data-slip-open="${esc(p.id)}" class="btn-obsidian text-xs px-2.5">Slip Gaji</button>
                          ${isAdmin && p.status === 'DRAFT' ? `<button type="button" data-pay-status="${esc(p.id)}:FINALIZED" class="btn-outline text-xs px-2.5">Finalisasi</button>` : ''}
                          ${isAdmin && p.status === 'FINALIZED' && !p.ledger_transaction_id ? `<button type="button" data-pay-status="${esc(p.id)}:PAID" class="btn-lime text-xs px-2.5">Bayar</button>` : ''}
                        </td>
                      </tr>`;
                  }).join('')}
            </tbody>
          </table>
        </div>
      </section>

      <!-- Kronos Ledger Posted Batch Audit Trail -->
      <section class="bg-[#FFFFFF] border border-[#E2E4E3] rounded-lg overflow-hidden">
        <div class="p-4 sm:p-5 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 class="text-sm font-bold text-[#111815]">Audit Batch Posting ke Kronos Ledger (Idempotent)</h3>
            <p class="text-xs text-[#525856]">Setiap periode hanya memposting 1 jurnal ringkasan double-entry (DR 6102 Beban Gaji vs CR 1102/1101/2101 &amp; CR 2201 Utang Pajak).</p>
          </div>
          <span class="text-[11px] font-mono text-[#525856]">UNIQUE (company_id, period_year, period_month, source_ref)</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse text-xs">
            <thead>
              <tr class="bg-[#F9FAFA] text-[11px] uppercase tracking-wider text-[#525856] border-y border-[#E2E4E3]">
                <th class="py-3 px-4 font-semibold">Source Ref</th>
                <th class="py-3 px-4 font-semibold">Transaction ID</th>
                <th class="py-3 px-4 font-semibold">Karyawan</th>
                <th class="py-3 px-4 font-semibold">DR 6102 Beban Gaji</th>
                <th class="py-3 px-4 font-semibold">CR Kas/Bank/Utang</th>
                <th class="py-3 px-4 font-semibold">CR 2201 Pajak/Tetap</th>
                <th class="py-3 px-4 font-semibold">Waktu Posting</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[#E2E4E3] tabular-nums">
              ${(state.bundle.ledger_batches || []).length === 0
                ? '<tr><td colspan="7" class="p-5 text-center text-[#525856]">Belum ada batch payroll yang diposting ke Kronos Ledger. Finalisasi slip lalu klik "Post ke Kronos Ledger".</td></tr>'
                : (state.bundle.ledger_batches || []).map((b) => `
                  <tr class="hover:bg-[#F9FAFA]">
                    <td class="py-3 px-4 font-mono font-bold text-[#111815]">${esc(b.source_ref)}</td>
                    <td class="py-3 px-4 font-mono text-[#3F6212]">${esc(b.transaction_id)}</td>
                    <td class="py-3 px-4">${b.employees_count} org</td>
                    <td class="py-3 px-4 font-semibold">${esc(formatRupiah(b.total_gross_expense))}</td>
                    <td class="py-3 px-4">${esc(formatRupiah(b.total_net_salary))} (${esc(b.payment_account_code || '1102')})</td>
                    <td class="py-3 px-4">${esc(formatRupiah(b.total_fixed_deductions))}</td>
                    <td class="py-3 px-4 text-[#525856]">${esc(formatWibDateTime(b.posted_at))}</td>
                  </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;

  document.getElementById('pay-jump-finalized-btn')?.addEventListener('click', () => {
    if (!otherFinalized) return;
    state.payrollPeriod.month = otherFinalized.period_month;
    state.payrollPeriod.year = otherFinalized.period_year;
    renderPayrollModule(container);
  });
  document.getElementById('pay-month').value = String(month);
  document.getElementById('pay-month').addEventListener('change', (e) => {
    state.payrollPeriod.month = Number(e.target.value);
    renderPayrollModule(container);
  });
  document.getElementById('pay-year').addEventListener('change', (e) => {
    state.payrollPeriod.year = Number(e.target.value) || year;
    renderPayrollModule(container);
  });

  document.getElementById('pay-generate-btn')?.addEventListener('click', async () => {
    try {
      const res = await state.client.generateMonthlyPayroll(
        state.profile.company_id,
        state.payrollPeriod.month,
        state.payrollPeriod.year
      );
      showToast(`Payroll ${monthNameId(state.payrollPeriod.month)} ${state.payrollPeriod.year} selesai dihitung untuk ${res.employees_processed} karyawan.`, 'success');
      await refreshWorkspaceData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('pay-finalize-all-btn')?.addEventListener('click', async () => {
    try {
      const res = await state.client.finalizePeriodPayrolls(state.profile.company_id, month, year);
      showToast(`${res.finalized_count} slip payroll diubah ke status FINALIZED dan siap diposting ke Kronos Ledger.`, 'success');
      await refreshWorkspaceData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('pay-post-ledger-btn')?.addEventListener('click', () => {
    openPostLedgerModal(finalizedUnposted, month, year);
  });

  document.getElementById('pay-csv-btn')?.addEventListener('click', () => {
    downloadCsv(
      `vectra-payroll-${year}-${String(month).padStart(2, '0')}.csv`,
      ['Referensi', 'NIK', 'Nama', 'Hadir', 'WFO', 'Telat (m)', 'Lembur (m)', 'Gaji Pokok', 'Tunjangan', 'Lembur', 'Potongan Telat/Alpha', 'Potongan Tetap', 'Net Salary', 'Status', 'Ledger TX'],
      rows.map((p) => {
        const emp = empMap.get(p.employee_id);
        return [
          p.reference_no, emp?.employee_code || '', emp?.full_name || '',
          p.total_present, p.total_wfo_days, p.total_late_minutes, p.total_overtime_minutes,
          p.base_salary, p.allowances_total, p.overtime_pay, p.deductions_total, p.fixed_deductions,
          p.net_salary, p.status, p.ledger_transaction_id || ''
        ];
      })
    );
    showToast('Rekap payroll CSV berhasil diunduh.', 'success');
  });

  container.querySelectorAll('[data-slip-open]').forEach((btn) => {
    btn.addEventListener('click', () => openPayslipModal(btn.getAttribute('data-slip-open')));
  });

  container.querySelectorAll('[data-pay-status]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const [id, nextStatus] = btn.getAttribute('data-pay-status').split(':');
      try {
        await state.client.updatePayrollStatus(id, nextStatus);
        showToast(`Status payroll diperbarui menjadi ${nextStatus}.`, 'success');
        await refreshWorkspaceData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

function openPostLedgerModal(finalizedRows, month, year) {
  const totalNet = Math.round(finalizedRows.reduce((acc, p) => acc + Number(p.net_salary || 0), 0) * 100) / 100;
  const totalTax = Math.round(finalizedRows.reduce((acc, p) => acc + Number(p.fixed_deductions || 0), 0) * 100) / 100;
  const totalGross = Math.round((totalNet + totalTax) * 100) / 100;
  const defaultRef = `PAYROLL-${year}${String(month).padStart(2, '0')}-BATCH`;

  openModal({
    title: `Post Batch Payroll ke Kronos Ledger (${monthNameId(month)} ${year})`,
    subtitle: `Membuat 1 jurnal double-entry ringkasan untuk ${finalizedRows.length} slip berstatus FINALIZED.`,
    maxWidth: 'max-w-xl',
    bodyHtml: `
      <form id="ledger-post-form" class="space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label for="lp-account" class="block text-xs font-semibold mb-1">Akun Kredit Pembayaran / Akrual</label>
            <select id="lp-account" class="cmd-input w-full text-xs">
              <option value="1102">1102 - Bank BCA (Bayar Langsung -> PAID)</option>
              <option value="1101">1101 - Kas Tunai (Bayar Langsung -> PAID)</option>
              <option value="2101">2101 - Utang Usaha / Gaji (Akrual -> FINALIZED)</option>
            </select>
          </div>
          <div>
            <label for="lp-ref" class="block text-xs font-semibold mb-1">Source Reference (Idempotency Key)</label>
            <input id="lp-ref" type="text" required value="${esc(defaultRef)}" class="cmd-input w-full text-xs font-mono">
          </div>
        </div>

        <div class="border border-[#E2E4E3] rounded overflow-hidden">
          <table class="w-full text-left border-collapse text-xs tabular-nums">
            <thead>
              <tr class="bg-[#F4F5F4] border-b border-[#E2E4E3] text-[#525856]">
                <th class="p-2.5 font-semibold">Akun CoA Kronos</th>
                <th class="p-2.5 font-semibold text-right">Debit</th>
                <th class="p-2.5 font-semibold text-right">Kredit</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[#E2E4E3]">
              <tr>
                <td class="p-2.5 font-medium">6102 - Beban Gaji</td>
                <td class="p-2.5 text-right font-semibold">${esc(formatRupiah(totalGross))}</td>
                <td class="p-2.5 text-right">-</td>
              </tr>
              <tr>
                <td id="lp-pay-label" class="p-2.5 font-medium">1102 - Bank BCA</td>
                <td class="p-2.5 text-right">-</td>
                <td class="p-2.5 text-right font-semibold">${esc(formatRupiah(totalNet))}</td>
              </tr>
              ${totalTax > 0 ? `
                <tr>
                  <td class="p-2.5 font-medium">2201 - Utang Pajak PPN/PPh &amp; Potongan Tetap</td>
                  <td class="p-2.5 text-right">-</td>
                  <td class="p-2.5 text-right font-semibold">${esc(formatRupiah(totalTax))}</td>
                </tr>` : ''}
              <tr class="bg-[#111815] text-[#FFFFFF] font-bold">
                <td class="p-2.5">TOTAL BALANCED JOURNAL</td>
                <td class="p-2.5 text-right text-[#84CC16]">${esc(formatRupiah(totalGross))}</td>
                <td class="p-2.5 text-right text-[#84CC16]">${esc(formatRupiah(totalNet + totalTax))}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="flex justify-end gap-2 pt-2 border-t border-[#E2E4E3]">
          <button type="button" id="lp-cancel" class="btn-outline text-xs">Batal</button>
          <button type="submit" id="lp-submit" class="btn-lime text-xs">Eksekusi Posting Jurnal</button>
        </div>
      </form>
    `,
    onMount: () => {
      const accSel = document.getElementById('lp-account');
      const payLbl = document.getElementById('lp-pay-label');
      accSel.addEventListener('change', () => {
        const names = { '1102': '1102 - Bank BCA', '1101': '1101 - Kas Tunai', '2101': '2101 - Utang Usaha / Gaji' };
        payLbl.textContent = names[accSel.value] || accSel.value;
      });
      document.getElementById('lp-cancel').addEventListener('click', closeModal);
      document.getElementById('ledger-post-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('lp-submit');
        btn.disabled = true;
        btn.textContent = 'Memposting ke Kronos Ledger...';
        try {
          const res = await state.client.postPayrollToLedger(
            state.profile.company_id,
            month,
            year,
            accSel.value,
            document.getElementById('lp-ref').value
          );
          if (!res.success) {
            showToast(res.message || 'Gagal memposting batch payroll.', 'error');
            btn.disabled = false;
            btn.textContent = 'Eksekusi Posting Jurnal';
            return;
          }
          closeModal();
          if (res.already_posted) {
            showToast(res.message, 'warning');
          } else {
            showToast(`Jurnal batch ${res.source_ref} berhasil diposting ke Kronos Ledger (${res.transaction_id}).`, 'success');
          }
          await refreshWorkspaceData();
        } catch (err) {
          showToast(err.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Eksekusi Posting Jurnal';
        }
      });
    }
  });
}

// ----------------------------------------------------------------------------
// MODULE 8: SUPER ADMIN TENANT DIRECTORY
// ----------------------------------------------------------------------------

function renderTenantsModule(container) {
  const companies = state.bundle.companies || [];
  container.innerHTML = `
    <section class="cmd-card p-5 space-y-4">
      <div class="border-b border-[#E2E4E3] pb-3">
        <h2 class="text-base font-bold text-[#111815]">Manajemen Tenant Multi-Perusahaan (Super Admin)</h2>
        <p class="text-xs text-[#525856]">Setiap perusahaan terisolasi ketat oleh Row Level Security berdasarkan company_id.</p>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-xs">
          <thead>
            <tr class="border-b border-[#E2E4E3] bg-[#F4F5F4] text-[#525856]">
              <th class="p-3 font-semibold">Nama Perusahaan</th>
              <th class="p-3 font-semibold">Slug Tenant</th>
              <th class="p-3 font-semibold">Paket Langganan</th>
              <th class="p-3 font-semibold">Zona Waktu</th>
              <th class="p-3 font-semibold">Penalti Telat / Menit</th>
              <th class="p-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[#E2E4E3]">
            ${companies.map((c) => `
              <tr>
                <td class="p-3 font-bold text-[#111815]">${esc(c.name)}</td>
                <td class="p-3 font-mono">${esc(c.slug)}</td>
                <td class="p-3 font-semibold">${esc(c.subscription_plan)}</td>
                <td class="p-3">${esc(c.timezone)}</td>
                <td class="p-3 tabular-nums">${esc(formatRupiah(c.late_penalty_per_minute))}</td>
                <td class="p-3">${c.is_active ? '<span class="px-2 py-0.5 rounded bg-[#ECFCCB] text-[#3F6212] text-[11px] font-semibold">Aktif</span>' : 'Nonaktif'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

// ----------------------------------------------------------------------------
// MOBILE-FIRST EMPLOYEE PORTAL
// ----------------------------------------------------------------------------

function resolveActiveGps() {
  const { gps, profile, bundle } = state;
  const branch = bundle.branches.find((b) => b.id === profile.branch_id) || bundle.branches[0];
  const jkt = bundle.branches[0];
  const dpk = bundle.branches[1] || jkt;

  if (gps.preset === 'jkt_in' && jkt) {
    return { lat: jkt.latitude + 0.00025, lon: jkt.longitude + 0.0002, accuracy: 12, source: 'Simulasi Dalam Radius Jakarta' };
  }
  if (gps.preset === 'dpk_in' && dpk) {
    return { lat: dpk.latitude + 0.00035, lon: dpk.longitude + 0.00025, accuracy: 15, source: 'Simulasi Dalam Radius Depok' };
  }
  if (gps.preset === 'out_radius' && branch) {
    return { lat: branch.latitude + 0.0042, lon: branch.longitude + 0.0031, accuracy: 18, source: 'Simulasi Luar Radius (~580m)' };
  }
  if (gps.preset === 'fake_zero' && branch) {
    return { lat: branch.latitude, lon: branch.longitude, accuracy: 0, source: 'Simulasi Fake GPS (Akurasi 0m)' };
  }

  if (gps.lat !== null && gps.lon !== null) {
    return { lat: gps.lat, lon: gps.lon, accuracy: gps.accuracy ?? 18, source: 'GPS Browser Nyata' };
  }
  // If browser geolocation hasn't returned yet or was denied in demo mode
  if (state.client.mode === 'demo' && branch) {
    return { lat: branch.latitude + 0.00022, lon: branch.longitude + 0.00018, accuracy: 14, source: 'Koordinat Default Demo (Jakarta/Depok)' };
  }
  return { lat: null, lon: null, accuracy: null, source: gps.error || 'Menunggu sinyal GPS...' };
}

function requestBrowserGeolocation() {
  if (!navigator.geolocation) {
    state.gps.error = 'Browser tidak mendukung Geolocation API.';
    renderEmployeePortal();
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.gps.lat = pos.coords.latitude;
      state.gps.lon = pos.coords.longitude;
      state.gps.accuracy = pos.coords.accuracy;
      state.gps.error = null;
      if (state.viewShell === 'portal') renderEmployeePortal();
    },
    (err) => {
      state.gps.error = `Izin GPS ditolak atau tidak tersedia (${err.message}).`;
      if (state.viewShell === 'portal') renderEmployeePortal();
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
  );
}

function renderEmployeePortal() {
  const container = document.getElementById('portal-content');
  if (!state.bundle || !state.profile) return;

  document.querySelectorAll('.portal-tab-btn').forEach((btn) => {
    const active = btn.getAttribute('data-portal-tab') === state.portalTab;
    btn.className = `portal-tab-btn min-h-[58px] flex flex-col items-center justify-center gap-0.5 text-xs ${
      active ? 'font-bold text-[#111815] border-t-[3px] border-[#84CC16] bg-[#F9FAFA]' : 'font-medium text-[#525856]'
    }`;
  });

  const { profile, bundle } = state;
  const branch = bundle.branches.find((b) => b.id === profile.branch_id) || bundle.branches[0];
  const todayStr = getJakartaDateStr(0);

  if (state.portalTab === 'absen') {
    const openLog = bundle.attendance_logs.find((l) => l.employee_id === profile.id && !l.clock_out_at);
    const activeSched = openLog?.schedule_id
      ? bundle.schedules.find((s) => s.id === openLog.schedule_id)
      : bundle.schedules.find((s) => s.employee_id === profile.id && s.work_date === todayStr);
    const shift = activeSched ? bundle.shifts.find((s) => s.id === activeSched.shift_id) : bundle.shifts[0];
    const gpsReading = resolveActiveGps();
    const distanceM = branch && gpsReading.lat !== null
      ? calculateHaversineDistance(gpsReading.lat, gpsReading.lon, branch.latitude, branch.longitude)
      : null;
    const withinRadius = distanceM !== null && branch ? distanceM <= branch.radius_meters : false;

    const myLogs = bundle.attendance_logs.filter((l) => l.employee_id === profile.id).slice(0, 5);
    const demoEmployees = bundle.profiles.filter((p) => p.role === 'employee');

    container.innerHTML = `
      <!-- Live Clock & Assigned Shift -->
      <section class="cmd-card p-4 bg-[#111815] text-[#FFFFFF] border-[#27352F] space-y-3">
        <div class="flex items-center justify-between gap-2 text-xs text-[#D1D5DB]">
          <span>${esc(branch?.name || 'Cabang')}</span>
          <span class="px-2 py-0.5 rounded bg-[#1F2D27] text-[#84CC16] font-semibold">Sisa Cuti: ${profile.leave_balance} hari</span>
        </div>
        <div>
          <time id="portal-live-clock" class="text-2xl sm:text-3xl font-bold tracking-tight tabular-nums block text-[#FFFFFF]">${esc(formatWibDateTime(new Date()))}</time>
          <p class="text-xs text-[#D1D5DB] mt-1">
            Jadwal Hari Ini: <strong class="text-[#FFFFFF]">${esc(shift?.name || 'Shift Pagi')}</strong>
            (${esc(shift?.start_time?.slice(0, 5) || '08:00')} - ${esc(shift?.end_time?.slice(0, 5) || '17:00')} WIB)
            ${shift?.is_cross_day ? '<span class="ml-1 px-1.5 py-0.5 rounded bg-[#84CC16] text-[#111815] text-[10px] font-bold">Cross-Day</span>' : ''}
          </p>
        </div>
      </section>

      ${state.offlineItems.length > 0 ? `
        <section class="cmd-card p-3.5 bg-[#FEF3C7] border-[#F59E0B] flex items-center justify-between gap-3">
          <div class="text-xs text-[#92400E]">
            <strong>${state.offlineItems.length} Absensi Tersimpan Offline</strong> di IndexedDB.
          </div>
          <button type="button" id="portal-sync-offline-btn" class="btn-obsidian text-xs px-3">Sinkronkan</button>
        </section>
      ` : ''}

      <!-- Live Geofence Radar Status -->
      <section class="cmd-card p-4 space-y-3">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-sm font-bold text-[#111815]">Status GPS &amp; Geofence</h2>
          <button type="button" id="portal-refresh-gps" class="text-xs font-semibold text-[#3F6212] underline py-1 px-2">Perbarui GPS</button>
        </div>

        <div class="p-3 rounded border ${withinRadius ? 'bg-[#ECFCCB] border-[#A3E635] text-[#3F6212]' : 'bg-[#FEE2E2] border-[#FCA5A5] text-[#991B1B]'}">
          <div class="flex items-center justify-between gap-2 text-xs font-bold tabular-nums">
            <span>${withinRadius ? 'DALAM RADIUS KANTOR' : 'DI LUAR RADIUS KANTOR'}</span>
            <span>${distanceM !== null ? `${Math.round(distanceM)} m / ${branch?.radius_meters ?? 150} m` : 'GPS Belum Siap'}</span>
          </div>
          <div class="text-[11px] mt-1 tabular-nums">
            Koordinat: ${gpsReading.lat !== null ? `${gpsReading.lat.toFixed(6)}, ${gpsReading.lon.toFixed(6)}` : '-'} | Akurasi: ${gpsReading.accuracy !== null ? `${Math.round(gpsReading.accuracy)}m` : '-'}
          </div>
          <div class="text-[11px] mt-0.5 opacity-90">${esc(gpsReading.source)} | Device: <span class="font-mono">${esc(profile.bound_device_hash || `Akan mengikat ${state.deviceHash}`)}</span></div>
        </div>

        ${state.client.mode === 'demo' ? `
          <div class="p-3 rounded bg-[#F4F5F4] border border-[#E2E4E3] space-y-2.5">
            <div class="text-[11px] font-bold text-[#111815]">Simulator Anti-Fraud &amp; Penguji Demo</div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label for="portal-demo-emp" class="block text-[11px] font-medium text-[#525856] mb-1">Akun Karyawan Demo</label>
                <select id="portal-demo-emp" class="cmd-input w-full text-xs">
                  ${demoEmployees.map((e) => `<option value="${esc(e.id)}" ${e.id === profile.id ? 'selected' : ''}>${esc(e.full_name)} (${esc(e.employee_code)})</option>`).join('')}
                </select>
              </div>
              <div>
                <label for="portal-gps-preset" class="block text-[11px] font-medium text-[#525856] mb-1">Preset GPS Uji</label>
                <select id="portal-gps-preset" class="cmd-input w-full text-xs">
                  <option value="auto" ${state.gps.preset === 'auto' ? 'selected' : ''}>GPS Nyata / Default Cabang</option>
                  <option value="jkt_in" ${state.gps.preset === 'jkt_in' ? 'selected' : ''}>Dalam Radius Jakarta (~34m)</option>
                  <option value="dpk_in" ${state.gps.preset === 'dpk_in' ? 'selected' : ''}>Dalam Radius Depok (~47m)</option>
                  <option value="out_radius" ${state.gps.preset === 'out_radius' ? 'selected' : ''}>Luar Radius (~580m)</option>
                  <option value="fake_zero" ${state.gps.preset === 'fake_zero' ? 'selected' : ''}>Fake GPS (Akurasi 0m)</option>
                </select>
              </div>
            </div>
            <div class="flex flex-wrap gap-4 text-xs pt-1">
              <label class="inline-flex items-center gap-2 min-h-[44px]">
                <input type="checkbox" id="sim-dev-mismatch" ${state.gps.simulateDeviceMismatch ? 'checked' : ''} class="w-4 h-4">
                <span>Simulasi Device Berbeda</span>
              </label>
              <label class="inline-flex items-center gap-2 min-h-[44px]">
                <input type="checkbox" id="sim-offline-mode" ${state.gps.simulateOffline ? 'checked' : ''} class="w-4 h-4">
                <span>Simulasi Offline (IndexedDB)</span>
              </label>
            </div>
          </div>
        ` : ''}

        <!-- Work Mode & Attendance Action Form -->
        <form id="portal-clock-form" class="space-y-3">
          ${!openLog ? `
            <div class="grid grid-cols-2 gap-2.5">
              <div>
                <label for="portal-work-mode" class="block text-xs font-semibold text-[#111815] mb-1">Mode Kerja</label>
                <select id="portal-work-mode" class="cmd-input w-full text-xs">
                  <option value="WFO">WFO (Kantor Cabang)</option>
                  <option value="WFH">WFH (Remote)</option>
                  <option value="FIELD">Dinas Luar (Lapangan)</option>
                </select>
              </div>
              <div>
                <label for="portal-method" class="block text-xs font-semibold text-[#111815] mb-1">Metode Verifikasi</label>
                <select id="portal-method" class="cmd-input w-full text-xs">
                  <option value="GPS_SELFIE">Kamera Live + GPS</option>
                  <option value="KIOSK_QR">Scan Token QR Kiosk</option>
                </select>
              </div>
            </div>
            <div id="portal-qr-wrap" class="hidden space-y-1">
              <label for="portal-qr-token" class="block text-xs font-semibold text-[#111815]">Token QR Kiosk (Format VECTRA|...)</label>
              <div class="flex gap-2">
                <input id="portal-qr-token" type="text" placeholder="Tempel payload QR dari layar Kiosk" class="cmd-input flex-1 text-xs font-mono">
                ${state.client.mode === 'demo' ? '<button type="button" id="portal-autofill-qr" class="btn-outline text-xs px-3 shrink-0">Ambil Token Cabang</button>' : ''}
              </div>
            </div>
          ` : `
            <div class="p-3 rounded bg-[#ECFCCB] border border-[#BEF264] text-xs text-[#3F6212]">
              Sesi aktif sejak <strong>${esc(formatWibTime(openLog.clock_in_at))}</strong> (${esc(openLog.work_mode)}). Tekan Clock Out saat selesai bekerja.
            </div>
          `}

          <div>
            <label for="portal-notes" class="block text-xs font-semibold text-[#111815] mb-1">Catatan Kehadiran / Lokasi Dinas Luar</label>
            <input id="portal-notes" type="text" placeholder="Opsional untuk WFO, wajib untuk Dinas Luar" class="cmd-input w-full text-xs">
          </div>

          <button
            type="submit"
            id="portal-clock-submit"
            class="w-full min-h-[52px] rounded font-bold text-sm ${openLog ? 'btn-danger' : 'btn-lime'}"
          >
            ${openLog ? 'CLOCK OUT &amp; AKHIRI SHIFT' : 'CLOCK IN SEKARANG (KAMERA LIVE)'}
          </button>
          <p id="portal-lock-hint" class="hidden text-xs font-semibold text-[#991B1B] text-center">
            Tombol WFO terkunci karena Anda berada di luar radius cabang (${branch?.radius_meters ?? 150}m). Pilih mode Dinas Luar atau WFH.
          </p>
        </form>
      </section>

      <!-- Recent Personal History -->
      <section class="cmd-card p-4 space-y-3">
        <h2 class="text-sm font-bold text-[#111815]">Riwayat Absensi Terakhir</h2>
        <div class="divide-y divide-[#E2E4E3]">
          ${myLogs.length === 0
            ? '<p class="text-xs text-[#525856] py-3">Belum ada catatan kehadiran.</p>'
            : myLogs.map((l) => `
              <div class="py-2.5 flex items-center justify-between gap-2 text-xs">
                <div>
                  <div class="font-semibold text-[#111815] tabular-nums">${esc(formatWibDate(l.work_date))} (${esc(l.work_mode)})</div>
                  <div class="text-[11px] text-[#525856] tabular-nums">In ${esc(formatWibTime(l.clock_in_at))} | Out ${l.clock_out_at ? esc(formatWibTime(l.clock_out_at)) : 'Aktif'}</div>
                </div>
                <div class="text-right space-y-1">
                  ${statusPill(l.status, l.is_flagged)}
                  ${l.clock_in_distance_m != null ? `<div class="text-[11px] text-[#525856] tabular-nums">${Math.round(l.clock_in_distance_m)}m</div>` : ''}
                </div>
              </div>`).join('')}
        </div>
      </section>
    `;

    // Bind portal absen events
    document.getElementById('portal-refresh-gps').addEventListener('click', requestBrowserGeolocation);
    document.getElementById('portal-sync-offline-btn')?.addEventListener('click', syncOfflineQueue);

    document.getElementById('portal-demo-emp')?.addEventListener('change', async (e) => {
      const updated = await state.client.switchDemoUser(e.target.value);
      if (updated) {
        state.profile = updated;
        await refreshWorkspaceData();
      }
    });
    document.getElementById('portal-gps-preset')?.addEventListener('change', (e) => {
      state.gps.preset = e.target.value;
      renderEmployeePortal();
    });
    document.getElementById('sim-dev-mismatch')?.addEventListener('change', (e) => {
      state.gps.simulateDeviceMismatch = e.target.checked;
    });
    document.getElementById('sim-offline-mode')?.addEventListener('change', async (e) => {
      state.gps.simulateOffline = e.target.checked;
      updateShellChrome();
      if (!isEffectivelyOffline() && state.offlineItems.length > 0) {
        await syncOfflineQueue();
      }
    });

    const modeSelect = document.getElementById('portal-work-mode');
    const clockBtn = document.getElementById('portal-clock-submit');
    const lockHint = document.getElementById('portal-lock-hint');
    const updateWfoLock = () => {
      if (openLog || !modeSelect) return;
      const isWfoLocked = modeSelect.value === 'WFO' && !withinRadius;
      clockBtn.disabled = isWfoLocked;
      lockHint.classList.toggle('hidden', !isWfoLocked);
    };
    updateWfoLock();
    modeSelect?.addEventListener('change', updateWfoLock);

    const methodSelect = document.getElementById('portal-method');
    const qrWrap = document.getElementById('portal-qr-wrap');
    methodSelect?.addEventListener('change', () => {
      qrWrap.classList.toggle('hidden', methodSelect.value !== 'KIOSK_QR');
    });

    document.getElementById('portal-autofill-qr')?.addEventListener('click', async () => {
      if (!branch || state.client.mode !== 'demo') return;
      const qr = await state.client.getKioskQrToken(branch.id);
      document.getElementById('portal-qr-token').value = qr.payload;
    });

    document.getElementById('portal-clock-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const workMode = modeSelect ? modeSelect.value : openLog.work_mode;
      const method = methodSelect ? methodSelect.value : 'GPS_SELFIE';
      const notes = document.getElementById('portal-notes').value.trim();
      let qrPayload = null;

      if (!openLog && workMode === 'FIELD' && notes.length < 5) {
        showToast('Mode Dinas Luar wajib mengisi keterangan tugas minimal 5 karakter.', 'error');
        return;
      }

      if (!openLog && method === 'KIOSK_QR') {
        if (!branch) {
          showToast('Cabang karyawan belum diatur untuk metode QR Kiosk.', 'error');
          return;
        }
        const scanned = document.getElementById('portal-qr-token').value.trim();
        if (!scanned) {
          showToast('Masukkan token QR Kiosk dari layar cabang.', 'error');
          return;
        }
        if (state.client.mode === 'demo') {
          const check = await state.client.verifyKioskQrToken(branch.id, scanned);
          if (!check.valid) {
            showToast(`Verifikasi QR Kiosk gagal: ${check.reason}`, 'error');
            return;
          }
        }
        qrPayload = scanned;
      }

      openLiveCameraClockModal({
        action: openLog ? 'out' : 'in',
        workMode,
        method,
        notes,
        gpsReading,
        branch,
        distanceM,
        qrPayload
      });
    });
    return;
  }

  if (state.portalTab === 'jadwal') {
    const shiftMap = new Map(bundle.shifts.map((s) => [s.id, s]));
    const myScheds = bundle.schedules
      .filter((s) => s.employee_id === profile.id && s.work_date >= getJakartaDateStr(-3))
      .sort((a, b) => a.work_date.localeCompare(b.work_date))
      .slice(0, 14);

    container.innerHTML = `
      <section class="cmd-card p-4 space-y-3">
        <h2 class="text-base font-bold text-[#111815]">Jadwal Shift Pribadi</h2>
        <div class="divide-y divide-[#E2E4E3]">
          ${myScheds.length === 0
            ? '<p class="text-xs text-[#525856] py-4">Belum ada jadwal shift ditetapkan.</p>'
            : myScheds.map((sch) => {
                const shf = shiftMap.get(sch.shift_id);
                return `
                  <div class="py-3 flex items-center justify-between gap-2 text-xs">
                    <div>
                      <div class="font-bold text-[#111815] tabular-nums">${esc(formatWibDate(sch.work_date))} ${sch.work_date === todayStr ? '(Hari Ini)' : ''}</div>
                      <div class="text-[#4B5563] tabular-nums">${esc(shf?.name || '-')} | ${esc(shf?.start_time?.slice(0, 5) || '')}-${esc(shf?.end_time?.slice(0, 5) || '')} ${shf?.is_cross_day ? '(Cross-Day)' : ''}</div>
                    </div>
                    <span class="px-2.5 py-1 rounded border border-[#E2E4E3] bg-[#F4F5F4] font-semibold">${esc(sch.work_mode)}</span>
                  </div>`;
              }).join('')}
        </div>
      </section>
    `;
    return;
  }

  if (state.portalTab === 'pengajuan') {
    const myReqs = bundle.requests.filter((r) => r.employee_id === profile.id);
    const colleagues = bundle.profiles.filter((p) => p.id !== profile.id && p.branch_id === profile.branch_id);

    container.innerHTML = `
      <section class="cmd-card p-4 space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="text-base font-bold text-[#111815]">Pengajuan Cuti, Izin &amp; Lembur</h2>
          <span class="px-2.5 py-1 rounded bg-[#ECFCCB] text-[#3F6212] text-xs font-bold tabular-nums">Kuota Cuti: ${profile.leave_balance} hari</span>
        </div>

        <form id="portal-req-form" class="space-y-3 border-b border-[#E2E4E3] pb-4">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label for="preq-type" class="block text-xs font-semibold mb-1">Jenis Pengajuan</label>
              <select id="preq-type" class="cmd-input w-full text-xs">
                <option value="LEAVE">Cuti Tahunan</option>
                <option value="SICK">Izin Sakit (Lampiran Dokter)</option>
                <option value="OVERTIME">Lembur</option>
                <option value="SHIFT_SWAP">Tukar Shift</option>
              </select>
            </div>
            <div id="preq-hours-wrap" class="hidden">
              <label for="preq-hours" class="block text-xs font-semibold mb-1">Durasi Jam Lembur</label>
              <input id="preq-hours" type="number" step="0.5" min="0.5" max="12" value="2" class="cmd-input w-full text-xs">
            </div>
            <div id="preq-swap-wrap" class="hidden">
              <label for="preq-target" class="block text-xs font-semibold mb-1">Rekan Tukar Shift</label>
              <select id="preq-target" class="cmd-input w-full text-xs">
                ${colleagues.length
                  ? colleagues.map((c) => `<option value="${esc(c.id)}">${esc(c.full_name)}</option>`).join('')
                  : '<option value="">-- Tidak ada rekan di cabang --</option>'}
              </select>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="preq-start" class="block text-xs font-semibold mb-1">Tanggal Mulai</label>
              <input id="preq-start" type="date" value="${todayStr}" required class="cmd-input w-full text-xs tabular-nums">
            </div>
            <div>
              <label for="preq-end" class="block text-xs font-semibold mb-1">Tanggal Selesai</label>
              <input id="preq-end" type="date" value="${todayStr}" required class="cmd-input w-full text-xs tabular-nums">
            </div>
          </div>
          <div id="preq-file-wrap" class="hidden">
            <label for="preq-file" class="block text-xs font-semibold mb-1">Lampiran Surat Dokter (Wajib untuk Sakit)</label>
            <input id="preq-file" type="file" accept="image/*,.pdf" class="cmd-input w-full text-xs pt-2">
          </div>
          <div>
            <label for="preq-reason" class="block text-xs font-semibold mb-1">Alasan Pengajuan</label>
            <textarea id="preq-reason" rows="2" required minlength="5" placeholder="Jelaskan keperluan pengajuan Anda..." class="cmd-input w-full text-xs"></textarea>
          </div>
          <button type="submit" class="btn-obsidian w-full text-xs">Kirim Pengajuan ke Supervisor</button>
        </form>

        <div class="space-y-2.5">
          <h3 class="text-xs font-bold text-[#525856] uppercase">Status Pengajuan Saya</h3>
          ${myReqs.length === 0
            ? '<p class="text-xs text-[#525856]">Belum ada riwayat pengajuan.</p>'
            : myReqs.map((r) => `
              <div class="p-3 rounded border border-[#E2E4E3] bg-[#F4F5F4] space-y-1 text-xs">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-bold">${esc(r.type)} | ${esc(formatWibDate(r.start_date))}</span>
                  ${statusPill(r.status)}
                </div>
                <p class="text-[#4B5563]">${esc(r.reason)}</p>
              </div>`).join('')}
        </div>
      </section>
    `;

    const typeSel = document.getElementById('preq-type');
    const toggleFields = () => {
      document.getElementById('preq-hours-wrap').classList.toggle('hidden', typeSel.value !== 'OVERTIME');
      document.getElementById('preq-swap-wrap').classList.toggle('hidden', typeSel.value !== 'SHIFT_SWAP');
      document.getElementById('preq-file-wrap').classList.toggle('hidden', typeSel.value !== 'SICK');
    };
    typeSel.addEventListener('change', toggleFields);

    document.getElementById('portal-req-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const type = typeSel.value;
      const startDate = document.getElementById('preq-start').value;
      const endDate = document.getElementById('preq-end').value;
      if (endDate < startDate) {
        showToast('Tanggal selesai tidak boleh lebih awal dari tanggal mulai.', 'error');
        return;
      }
      const targetVal = document.getElementById('preq-target').value;
      if (type === 'SHIFT_SWAP' && !targetVal) {
        showToast('Rekan tukar shift di cabang yang sama belum tersedia.', 'error');
        return;
      }
      const fileInput = document.getElementById('preq-file');
      if (type === 'SICK' && (!fileInput.files || fileInput.files.length === 0) && state.client.mode === 'live') {
        showToast('Pengajuan sakit wajib melampirkan surat keterangan dokter.', 'error');
        return;
      }
      try {
        await state.client.createRequest({
          company_id: profile.company_id,
          employee_id: profile.id,
          target_employee_id: type === 'SHIFT_SWAP' ? (targetVal || null) : null,
          type,
          start_date: startDate,
          end_date: endDate,
          hours_requested: type === 'OVERTIME' ? Number(document.getElementById('preq-hours').value) : 0,
          reason: document.getElementById('preq-reason').value,
          attachmentFile: fileInput.files?.[0] || null,
          attachment_url: fileInput.files?.[0] ? `demo://attachment/${fileInput.files[0].name}` : null
        });
        showToast('Pengajuan berhasil dikirim ke antrean Supervisor.', 'success');
        await refreshWorkspaceData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
    return;
  }

  // Tab: Slip Gaji
  const mySlips = bundle.payrolls.filter((p) => p.employee_id === profile.id);
  container.innerHTML = `
    <section class="cmd-card p-4 space-y-3">
      <h2 class="text-base font-bold text-[#111815]">Slip Gaji Saya</h2>
      ${mySlips.length === 0
        ? '<p class="text-xs text-[#525856] py-4">Belum ada slip gaji yang diterbitkan oleh HRD.</p>'
        : mySlips.map((p) => `
          <article class="p-4 rounded border border-[#E2E4E3] bg-[#F4F5F4] flex items-center justify-between gap-3">
            <div>
              <div class="text-sm font-bold text-[#111815]">${monthNameId(p.period_month)} ${p.period_year}</div>
              <div class="text-xs text-[#525856] tabular-nums">${esc(p.reference_no)} | Hadir ${p.total_present} hari</div>
              <div class="text-sm font-bold text-[#3F6212] mt-1 tabular-nums">${esc(formatRupiah(p.net_salary))}</div>
            </div>
            <div class="text-right space-y-2">
              <div>${statusPill(p.status)}</div>
              <button type="button" data-slip-open="${esc(p.id)}" class="btn-obsidian text-xs px-3">Lihat &amp; Cetak</button>
            </div>
          </article>`).join('')}
    </section>
  `;
  container.querySelectorAll('[data-slip-open]').forEach((btn) => {
    btn.addEventListener('click', () => openPayslipModal(btn.getAttribute('data-slip-open')));
  });
}

// ----------------------------------------------------------------------------
// INTERACTIVE MODALS (AUDIT TRAIL, KIOSK QR, LIVE CAMERA, CRUD, PAYSLIP PRINT)
// ----------------------------------------------------------------------------

async function openAuditModal(logId) {
  const log = state.bundle.attendance_logs.find((l) => l.id === logId);
  if (!log) return;
  const emp = state.bundle.profiles.find((p) => p.id === log.employee_id);
  const branch = state.bundle.branches.find((b) => b.id === log.branch_id);

  openModal({
    title: `Audit Trail Kehadiran: ${emp?.full_name || 'Karyawan'}`,
    subtitle: `${emp?.employee_code || ''} | ${branch?.name || ''} | ${formatWibDate(log.work_date)}`,
    maxWidth: 'max-w-3xl',
    bodyHtml: `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div class="space-y-2">
          <h3 class="text-xs font-bold uppercase text-[#525856]">Bukti Kamera + Watermark Metadata</h3>
          <div id="audit-photo-box" class="border border-[#E2E4E3] rounded bg-[#111815] overflow-hidden aspect-[4/3] flex items-center justify-center">
            <canvas id="audit-photo-canvas" width="800" height="600" class="w-full h-full object-cover"></canvas>
          </div>
          <p class="text-[11px] text-[#525856]">Device Hash: <code class="font-semibold text-[#111815]">${esc(log.device_hash || '-')}</code> | Metode: ${esc(log.verification_method)}</p>
        </div>

        <div class="space-y-3">
          <h3 class="text-xs font-bold uppercase text-[#525856]">Radar Geofence &amp; Koordinat</h3>
          <div class="border border-[#E2E4E3] rounded bg-[#F4F5F4] overflow-hidden">
            <canvas id="audit-radar-canvas" width="420" height="250" class="w-full h-auto block"></canvas>
          </div>
          <dl class="grid grid-cols-2 gap-2 text-xs tabular-nums">
            <div class="p-2.5 rounded bg-[#F4F5F4] border border-[#E2E4E3]">
              <dt class="text-[11px] text-[#525856]">Jarak dari Cabang</dt>
              <dd class="font-bold text-[#111815]">${log.clock_in_distance_m != null ? `${Math.round(log.clock_in_distance_m)} m` : '-'}</dd>
            </div>
            <div class="p-2.5 rounded bg-[#F4F5F4] border border-[#E2E4E3]">
              <dt class="text-[11px] text-[#525856]">Akurasi GPS</dt>
              <dd class="font-bold ${Number(log.clock_in_accuracy_m) === 0 ? 'text-[#991B1B]' : 'text-[#111815]'}">${log.clock_in_accuracy_m ?? '-'} m</dd>
            </div>
          </dl>
          ${log.flag_reason ? `
            <div class="p-3 rounded bg-[#FEE2E2] border border-[#FCA5A5] text-xs text-[#991B1B]">
              <strong>Flag Terdeteksi:</strong> ${esc(log.flag_reason)}
              <div class="mt-1 text-[11px]">${esc(log.notes)}</div>
            </div>` : ''}
          ${log.is_flagged && ['company_admin', 'supervisor', 'super_admin'].includes(state.profile.role) ? `
            <div class="flex gap-2 pt-2">
              <button type="button" id="audit-mark-valid" class="btn-lime text-xs flex-1">Verifikasi Sah (Valid)</button>
              <button type="button" id="audit-confirm-fraud" class="btn-danger text-xs flex-1">Konfirmasi Fraud (Alpha)</button>
            </div>` : ''}
        </div>
      </div>
    `,
    onMount: async () => {
      const photoCanvas = document.getElementById('audit-photo-canvas');
      const signed = await state.client.getSignedPhotoUrl(log.clock_in_photo_url);
      const isSafeImgUrl = signed && (
        /^data:image\/(jpeg|png|webp);base64,/i.test(signed) ||
        /^https?:\/\//i.test(signed)
      );
      if (isSafeImgUrl) {
        const img = new Image();
        img.onload = () => photoCanvas.getContext('2d').drawImage(img, 0, 0, 800, 600);
        img.src = signed;
      } else {
        // Render crisp watermarked canvas evidence for seeded logs
        const temp = document.createElement('canvas');
        temp.width = 800;
        temp.height = 600;
        renderDemoCameraFrame(temp, emp?.full_name || 'Karyawan', branch?.name || 'Cabang');
        const stamped = await captureWatermarkedPhoto(temp, {
          employeeCode: emp?.employee_code,
          fullName: emp?.full_name,
          branchName: branch?.name,
          lat: log.clock_in_lat,
          lon: log.clock_in_lon,
          distanceMeters: log.clock_in_distance_m,
          accuracy: log.clock_in_accuracy_m,
          workMode: log.work_mode,
          serverTimeLabel: formatWibDateTime(log.clock_in_at),
          deviceHash: log.device_hash,
          method: log.verification_method
        });
        const img = new Image();
        img.onload = () => photoCanvas.getContext('2d').drawImage(img, 0, 0, 800, 600);
        img.src = stamped.dataUrl;
      }

      // Draw Geofence Radar Map
      const radar = document.getElementById('audit-radar-canvas');
      const ctx = radar.getContext('2d');
      const w = radar.width;
      const h = radar.height;
      const cx = w / 2;
      const cy = h / 2;
      ctx.fillStyle = '#F4F5F4';
      ctx.fillRect(0, 0, w, h);

      // Radius ring
      const radiusPx = 76;
      ctx.fillStyle = 'rgba(132, 204, 22, 0.16)';
      ctx.strokeStyle = '#65A30D';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Center Branch HQ pin
      ctx.fillStyle = '#111815';
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '600 11px Poppins, sans-serif';
      ctx.fillText(`HQ (${branch?.radius_meters || 150}m)`, cx + 10, cy + 4);

      // Clock-in point plotted proportionally
      if (branch && log.clock_in_lat != null) {
        const dist = log.clock_in_distance_m ?? 0;
        const maxScale = Math.max(branch.radius_meters * 1.4, dist);
        const pxDist = Math.min(98, (dist / maxScale) * radiusPx);
        const bearing = Math.atan2(log.clock_in_lon - branch.longitude, log.clock_in_lat - branch.latitude);
        const px = cx + Math.sin(bearing) * pxDist;
        const py = cy - Math.cos(bearing) * pxDist;

        ctx.strokeStyle = log.is_flagged ? '#DC2626' : '#3F6212';
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(px, py);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = log.is_flagged ? '#DC2626' : '#65A30D';
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#111815';
        ctx.fillText(`Check-In (${Math.round(dist)}m)`, Math.min(w - 115, Math.max(8, px + 9)), Math.max(16, py - 6));
      }

      document.getElementById('audit-mark-valid')?.addEventListener('click', async () => {
        try {
          await state.client.reviewAttendanceFlag(log.id, true, state.profile);
          showToast('Log kehadiran diverifikasi sah.', 'success');
          closeModal();
          await refreshWorkspaceData();
        } catch (err) {
          showToast(err.message || 'Gagal memverifikasi log.', 'error');
        }
      });

      document.getElementById('audit-confirm-fraud')?.addEventListener('click', async () => {
        try {
          await state.client.reviewAttendanceFlag(log.id, false, state.profile);
          showToast('Log ditandai sebagai Fraud/Alpha dan dikecualikan dari payroll.', 'warning');
          closeModal();
          await refreshWorkspaceData();
        } catch (err) {
          showToast(err.message || 'Gagal menandai log fraud.', 'error');
        }
      });
    }
  });
}

function openKioskQrModal(initialBranchId = null) {
  const branches = state.bundle.branches;
  if (!branches.length) {
    showToast('Buat minimal 1 cabang operasional terlebih dahulu untuk menampilkan Kiosk QR.', 'warning');
    return;
  }
  const selectedId = typeof initialBranchId === 'string' && initialBranchId ? initialBranchId : branches[0].id;

  openModal({
    title: 'Dynamic Rotating QR Kiosk (Rotasi 15 Detik)',
    subtitle: 'QR token terenkripsi otomatis berputar setiap 15 detik untuk mencegah penyalahgunaan foto QR.',
    maxWidth: 'max-w-lg',
    bodyHtml: `
      <div class="space-y-4">
        <div>
          <label for="kiosk-branch-sel" class="block text-xs font-semibold mb-1">Pilih Cabang Kiosk</label>
          <select id="kiosk-branch-sel" class="cmd-input w-full text-xs">
            ${branches.map((b) => `<option value="${esc(b.id)}" ${b.id === selectedId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
          </select>
        </div>

        <div class="p-5 rounded border border-[#111815] bg-[#FFFFFF] flex flex-col items-center gap-3">
          <canvas id="kiosk-qr-canvas" width="240" height="240" class="border border-[#E2E4E3]"></canvas>
          <div class="w-full bg-[#E2E4E3] h-2 rounded overflow-hidden">
            <div id="kiosk-progress" class="h-full bg-[#65A30D] transition-all duration-300" style="width:100%"></div>
          </div>
          <div class="flex items-center justify-between w-full text-xs tabular-nums">
            <span id="kiosk-token-code" class="font-mono font-bold text-[#111815]">Memuat token...</span>
            <span id="kiosk-countdown" class="font-semibold text-[#3F6212]">15s</span>
          </div>
          <div id="kiosk-payload-raw" class="w-full p-2 rounded bg-[#F4F5F4] border border-[#E2E4E3] font-mono text-[11px] text-center break-all select-all"></div>
        </div>

        <div class="flex gap-2">
          <button type="button" id="kiosk-test-btn" class="btn-lime text-xs flex-1">Uji Validasi Token Sekarang</button>
        </div>
        <p id="kiosk-test-res" class="text-xs font-semibold text-center"></p>
      </div>
    `,
    onMount: () => {
      const sel = document.getElementById('kiosk-branch-sel');
      const canvas = document.getElementById('kiosk-qr-canvas');
      const codeEl = document.getElementById('kiosk-token-code');
      const countEl = document.getElementById('kiosk-countdown');
      const progEl = document.getElementById('kiosk-progress');
      const rawEl = document.getElementById('kiosk-payload-raw');
      let lastSlice = -1;
      let latestPayload = '';
      let loadingSlice = false;

      const tick = async () => {
        const nowMs = Date.now();
        const slice = Math.floor(nowMs / 15000);
        const expiresInSec = 15 - (Math.floor(nowMs / 1000) % 15);
        countEl.textContent = `Berlaku ${expiresInSec}s`;
        progEl.style.width = `${Math.round((expiresInSec / 15) * 100)}%`;

        if (slice !== lastSlice && !loadingSlice) {
          loadingSlice = true;
          try {
            const br = branches.find((b) => b.id === sel.value) || branches[0];
            const qr = await state.client.getKioskQrToken(br.id);
            lastSlice = qr.slice ?? slice;
            latestPayload = qr.payload;
            codeEl.textContent = `TOKEN: ${qr.token}`;
            rawEl.textContent = qr.payload;
            drawQrCodeToCanvas(canvas, qr.payload);
          } catch (err) {
            codeEl.textContent = 'Gagal memuat token';
            rawEl.textContent = err.message || 'Tidak berwenang mengakses token kiosk cabang ini.';
          } finally {
            loadingSlice = false;
          }
        }
      };

      sel.addEventListener('change', () => {
        lastSlice = -1;
        tick();
      });

      document.getElementById('kiosk-test-btn').addEventListener('click', async () => {
        const br = branches.find((b) => b.id === sel.value) || branches[0];
        const out = document.getElementById('kiosk-test-res');
        try {
          const res = await state.client.verifyKioskQrToken(br.id, latestPayload);
          out.textContent = res.valid
            ? `VALID: Token slice #${res.slice} (${res.token}) cocok dengan secret cabang ${br.code}.`
            : `GAGAL: ${res.reason}`;
          out.className = `text-xs font-semibold text-center ${res.valid ? 'text-[#3F6212]' : 'text-[#991B1B]'}`;
        } catch (err) {
          out.textContent = `GAGAL: ${err.message}`;
          out.className = 'text-xs font-semibold text-center text-[#991B1B]';
        }
      });

      tick();
      state.kioskTimer = setInterval(tick, 1000);
    }
  });
}

function openLiveCameraClockModal({ action, workMode, method, notes, gpsReading, branch, distanceM, qrPayload = null }) {
  const isClockOut = action === 'out';
  const isDemo = state.client.mode === 'demo';
  let useSimulatedFrame = false;
  let capturedResult = null;

  openModal({
    title: isClockOut ? 'Verifikasi Kamera Live Clock Out' : 'Verifikasi Kamera Live Clock In',
    subtitle: `${state.profile.full_name} | Mode ${workMode} | Watermark server WIB otomatis dibakar pada gambar`,
    maxWidth: 'max-w-lg',
    bodyHtml: `
      <div class="space-y-4">
        <div id="cam-stage" class="relative border border-[#111815] rounded bg-[#111815] overflow-hidden aspect-[4/3] flex items-center justify-center">
          <video id="live-cam-video" playsinline muted class="w-full h-full object-cover"></video>
          <canvas id="live-cam-fallback" width="800" height="600" class="hidden w-full h-full object-cover"></canvas>
          <img id="captured-preview-img" alt="Pratinjau foto watermark absensi" width="800" height="600" class="hidden w-full h-full object-cover">
        </div>

        <div id="cam-status-msg" class="text-xs text-[#4B5563]">Mengaktifkan kamera depan...</div>

        <div class="flex flex-wrap gap-2">
          <button type="button" id="cam-capture-btn" class="btn-obsidian text-xs flex-1">Ambil Foto &amp; Bakar Watermark</button>
          <button type="button" id="cam-retake-btn" class="hidden btn-outline text-xs">Ambil Ulang</button>
          <button type="button" id="cam-submit-btn" class="hidden btn-lime text-xs flex-1">Kirim Absensi Sekarang</button>
        </div>

        <div id="cam-fallback-row" class="hidden pt-2 border-t border-[#E2E4E3] flex items-center justify-between gap-2">
          <span class="text-[11px] text-[#92400E]">Webcam fisik tidak terdeteksi / ditolak.</span>
          ${isDemo
            ? '<button type="button" id="cam-sim-btn" class="btn-outline text-xs px-3">Gunakan Frame Simulasi</button>'
            : '<button type="button" id="cam-retry-btn" class="btn-outline text-xs px-3">Coba Buka Kamera Lagi</button>'}
        </div>
      </div>
    `,
    onMount: async () => {
      const videoEl = document.getElementById('live-cam-video');
      const fallbackCanvas = document.getElementById('live-cam-fallback');
      const previewImg = document.getElementById('captured-preview-img');
      const statusEl = document.getElementById('cam-status-msg');
      const captureBtn = document.getElementById('cam-capture-btn');
      const retakeBtn = document.getElementById('cam-retake-btn');
      const submitBtn = document.getElementById('cam-submit-btn');
      const fallbackRow = document.getElementById('cam-fallback-row');

      const activateSimulationFallback = (reasonText) => {
        if (!isDemo) return;
        useSimulatedFrame = true;
        videoEl.classList.add('hidden');
        fallbackCanvas.classList.remove('hidden');
        renderDemoCameraFrame(fallbackCanvas, state.profile.full_name, branch?.name || 'Cabang');
        captureBtn.disabled = false;
        statusEl.textContent = reasonText || 'Mode pratinjau simulasi aktif. Tekan Ambil Foto untuk membakar watermark.';
      };

      const initCamera = async () => {
        try {
          state.activeCameraStream = await startLiveCamera(videoEl);
          fallbackRow.classList.add('hidden');
          captureBtn.disabled = false;
          statusEl.textContent = 'Kamera aktif. Arahkan wajah ke bingkai lalu tekan Ambil Foto.';
        } catch (err) {
          fallbackRow.classList.remove('hidden');
          if (isDemo) {
            activateSimulationFallback(`Kamera fisik tidak tersedia (${err.message}). Fallback simulasi bersih diaktifkan otomatis.`);
          } else {
            statusEl.textContent = `Kamera fisik wajib diizinkan untuk absensi Live (${err.message}). Berikan izin kamera lalu klik Coba Buka Kamera Lagi.`;
            captureBtn.disabled = true;
          }
        }
      };

      await initCamera();

      document.getElementById('cam-sim-btn')?.addEventListener('click', () => {
        activateSimulationFallback('Mode pratinjau simulasi aktif. Tekan Ambil Foto untuk membakar watermark.');
      });
      document.getElementById('cam-retry-btn')?.addEventListener('click', initCamera);

      captureBtn.addEventListener('click', async () => {
        const source = useSimulatedFrame ? fallbackCanvas : videoEl;
        capturedResult = await captureWatermarkedPhoto(source, {
          employeeCode: state.profile.employee_code,
          fullName: state.profile.full_name,
          branchName: branch?.name || 'Cabang',
          lat: gpsReading.lat,
          lon: gpsReading.lon,
          distanceMeters: distanceM,
          accuracy: gpsReading.accuracy,
          workMode,
          serverTimeLabel: formatWibDateTime(new Date()),
          deviceHash: state.gps.simulateDeviceMismatch ? 'dev_spoofed_foreign' : state.deviceHash,
          method
        });

        previewImg.src = capturedResult.dataUrl;
        previewImg.classList.remove('hidden');
        videoEl.classList.add('hidden');
        fallbackCanvas.classList.add('hidden');
        captureBtn.classList.add('hidden');
        retakeBtn.classList.remove('hidden');
        submitBtn.classList.remove('hidden');
        statusEl.textContent = 'Watermark metadata permanen berhasil dicetak ke gambar. Siap dikirim.';
      });

      retakeBtn.addEventListener('click', () => {
        capturedResult = null;
        previewImg.classList.add('hidden');
        if (useSimulatedFrame) fallbackCanvas.classList.remove('hidden');
        else videoEl.classList.remove('hidden');
        captureBtn.classList.remove('hidden');
        retakeBtn.classList.add('hidden');
        submitBtn.classList.add('hidden');
      });

      submitBtn.addEventListener('click', async () => {
        if (!capturedResult) return;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Memproses Server RPC...';

        const deviceToSend = state.gps.simulateDeviceMismatch ? 'dev_foreign_unrecognized' : state.deviceHash;
        const payload = {
          companyId: state.profile.company_id,
          employeeId: state.profile.id,
          lat: gpsReading.lat,
          lon: gpsReading.lon,
          accuracy_m: gpsReading.accuracy,
          device_hash: deviceToSend,
          photoDataUrl: capturedResult.dataUrl,
          photoBlob: capturedResult.blob,
          work_mode: workMode,
          verification_method: method,
          notes,
          qr_payload: qrPayload || null
        };

        if (isEffectivelyOffline()) {
          payload.verification_method = 'OFFLINE_SYNC';
          await OfflineQueue.enqueue({ action, payload });
          state.offlineItems = await OfflineQueue.getAll();
          closeModal();
          updateShellChrome();
          showToast('Koneksi offline: absensi diamankan ke antrean IndexedDB lokal.', 'warning');
          renderEmployeePortal();
          return;
        }

        try {
          const res = isClockOut
            ? await state.client.submitClockOut(payload)
            : await state.client.submitClockIn(payload);

          if (!res.success) {
            showToast(res.message || 'Absensi ditolak oleh server.', 'error');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Kirim Absensi Sekarang';
            return;
          }

          closeModal();
          if (res.is_flagged) {
            showToast(`Absensi tercatat namun ditandai ANOMALI (${res.flag_reason}) untuk audit HRD.`, 'warning');
          } else {
            showToast(isClockOut ? 'Clock Out berhasil dicatat!' : `Clock In berhasil! Status: ${res.status}`, 'success');
          }
          await refreshWorkspaceData();
        } catch (err) {
          showToast(err.message || 'Gagal menghubungi server RPC.', 'error');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Kirim Absensi Sekarang';
        }
      });
    }
  });
}

function openInviteCreatedModal(invite) {
  const shareUrl = buildInviteShareUrl(invite.invite_token);
  const companyName = state.bundle.company?.name || 'Perusahaan Anda';
  const waMsg = [
    `Halo *${invite.full_name}*,`,
    `Anda diundang bergabung ke workspace absensi *${companyName}* di VECTRA (${invite.employee_code} — ${invite.position}).`,
    `Silakan buka link di bawah ini untuk membuat kata sandi akun Anda:`,
    shareUrl,
    ``,
    `Kode Undangan: *${invite.invite_token}* (Gunakan email: ${invite.email})`
  ].join('\n');

  openModal({
    title: 'Link Undangan Karyawan Siap Dibagikan!',
    subtitle: `Berlaku 7 hari untuk ${invite.full_name} (${invite.email}).`,
    maxWidth: 'max-w-lg',
    bodyHtml: `
      <div class="space-y-4 text-xs">
        <div class="p-3.5 rounded border border-[#BEF264] bg-[#ECFCCB] text-[#3F6212] space-y-1">
          <div class="font-bold">Cara Aktivasi Karyawan:</div>
          <p>Karyawan cukup klik link undangan di bawah, lalu membuat kata sandi akunnya sendiri. Data NIK, cabang, role, dan gaji sudah otomatis terpasang sesuai isian Anda.</p>
        </div>

        <div>
          <label for="inv-res-url" class="block font-semibold text-[#111815] mb-1">Link Undangan Aktivasi</label>
          <input id="inv-res-url" type="text" readonly value="${esc(shareUrl)}" class="cmd-input w-full text-xs font-mono bg-[#F4F5F4]">
        </div>

        <div>
          <label for="inv-res-token" class="block font-semibold text-[#111815] mb-1">Kode Token Undangan</label>
          <input id="inv-res-token" type="text" readonly value="${esc(invite.invite_token)}" class="cmd-input w-full text-xs font-mono font-bold bg-[#F4F5F4]">
        </div>

        <div class="flex flex-wrap gap-2 pt-2 border-t border-[#E2E4E3]">
          <button type="button" id="inv-copy-url-btn" class="btn-lime text-xs flex-1">Salin Link Undangan</button>
          <button type="button" id="inv-copy-wa-btn" class="btn-obsidian text-xs flex-1">Salin Pesan WhatsApp</button>
          <button type="button" id="inv-done-btn" class="btn-outline text-xs">Selesai</button>
        </div>
      </div>
    `,
    onMount: () => {
      document.getElementById('inv-copy-url-btn').addEventListener('click', () => copyTextWithFeedback(shareUrl, 'Link undangan'));
      document.getElementById('inv-copy-wa-btn').addEventListener('click', () => copyTextWithFeedback(waMsg, 'Template pesan WhatsApp'));
      document.getElementById('inv-done-btn').addEventListener('click', closeModal);
    }
  });
}

function openEmployeeModal(existingEmp = null, createMode = null) {
  const isEdit = Boolean(existingEmp);
  const mode = createMode || (state.client.mode === 'live' ? 'invite' : 'direct');
  const isInvite = !isEdit && mode === 'invite';
  const branches = state.bundle.branches;

  openModal({
    title: isEdit ? `Edit Karyawan: ${existingEmp.full_name}` : (isInvite ? 'Undang Karyawan Baru (Link Aktivasi)' : 'Tambah Karyawan Baru'),
    subtitle: isInvite
      ? 'HRD mengatur NIK, cabang, role & gaji — karyawan membuat kata sandi akunnya sendiri lewat link undangan.'
      : 'Kelola profil kerja, cabang penugasan, gaji pokok, dan kuota cuti.',
    bodyHtml: `
      ${isInvite ? `
        <div class="p-3 rounded border border-[#BAE6FD] bg-[#F0F9FF] text-xs text-[#075985]">
          <strong>Self-Onboarding Aman:</strong> Setelah disimpan, Anda langsung mendapatkan <strong>Link Undangan Unik</strong> untuk dikirim ke karyawan (via WhatsApp/Email) agar mereka mendaftar &amp; membuat password sendiri.
        </div>` : ''}
      <form id="emp-form" class="space-y-3">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label for="f-emp-code" class="block text-xs font-semibold mb-1">NIK / Kode Karyawan</label>
            <input id="f-emp-code" type="text" required value="${esc(existingEmp?.employee_code || '')}" placeholder="EMP-019" class="cmd-input w-full text-xs">
          </div>
          <div>
            <label for="f-emp-name" class="block text-xs font-semibold mb-1">Nama Lengkap</label>
            <input id="f-emp-name" type="text" required value="${esc(existingEmp?.full_name || '')}" placeholder="Nama Lengkap" class="cmd-input w-full text-xs">
          </div>
          <div>
            <label for="f-emp-email" class="block text-xs font-semibold mb-1">Email Karyawan</label>
            <input id="f-emp-email" type="email" required value="${esc(existingEmp?.email || '')}" placeholder="nama@perusahaan.co.id" class="cmd-input w-full text-xs">
          </div>
          <div>
            <label for="f-emp-branch" class="block text-xs font-semibold mb-1">Cabang Penugasan</label>
            <select id="f-emp-branch" class="cmd-input w-full text-xs">
              ${branches.map((b) => `<option value="${esc(b.id)}" ${existingEmp?.branch_id === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label for="f-emp-role" class="block text-xs font-semibold mb-1">Role Akses</label>
            <select id="f-emp-role" class="cmd-input w-full text-xs">
              <option value="employee" ${existingEmp?.role === 'employee' ? 'selected' : ''}>Karyawan</option>
              <option value="supervisor" ${existingEmp?.role === 'supervisor' ? 'selected' : ''}>Supervisor Cabang</option>
              <option value="company_admin" ${existingEmp?.role === 'company_admin' ? 'selected' : ''}>HRD Admin</option>
            </select>
          </div>
          <div>
            <label for="f-emp-dept" class="block text-xs font-semibold mb-1">Divisi / Departemen</label>
            <input id="f-emp-dept" type="text" required value="${esc(existingEmp?.department || 'Operasional Toko')}" class="cmd-input w-full text-xs">
          </div>
          <div>
            <label for="f-emp-pos" class="block text-xs font-semibold mb-1">Jabatan</label>
            <input id="f-emp-pos" type="text" required value="${esc(existingEmp?.position || 'Staff')}" class="cmd-input w-full text-xs">
          </div>
          <div>
            <label for="f-emp-leave" class="block text-xs font-semibold mb-1">Saldo Cuti (Hari)</label>
            <input id="f-emp-leave" type="number" min="0" max="60" value="${existingEmp?.leave_balance ?? 12}" class="cmd-input w-full text-xs tabular-nums">
          </div>
          <div>
            <label for="f-emp-sal" class="block text-xs font-semibold mb-1">Gaji Pokok (Rp)</label>
            <input id="f-emp-sal" type="number" min="0" step="50000" required value="${existingEmp?.base_salary ?? 5500000}" class="cmd-input w-full text-xs tabular-nums">
          </div>
          <div>
            <label for="f-emp-allow" class="block text-xs font-semibold mb-1">Tunjangan Hadir Fisik/Hari (Rp)</label>
            <input id="f-emp-allow" type="number" min="0" step="5000" required value="${existingEmp?.daily_allowance ?? 45000}" class="cmd-input w-full text-xs tabular-nums">
          </div>
        </div>
        <div class="flex justify-end gap-2 pt-3 border-t border-[#E2E4E3]">
          <button type="button" id="emp-cancel-btn" class="btn-outline text-xs">Batal</button>
          <button type="submit" id="emp-submit-btn" class="btn-lime text-xs">${isEdit ? 'Simpan Perubahan' : (isInvite ? 'Buat Link Undangan' : 'Simpan Karyawan')}</button>
        </div>
      </form>
    `,
    onMount: () => {
      document.getElementById('emp-cancel-btn').addEventListener('click', closeModal);
      document.getElementById('emp-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = {
          company_id: state.profile.company_id,
          employee_code: document.getElementById('f-emp-code').value,
          full_name: document.getElementById('f-emp-name').value,
          email: document.getElementById('f-emp-email').value,
          branch_id: document.getElementById('f-emp-branch').value,
          role: document.getElementById('f-emp-role').value,
          department: document.getElementById('f-emp-dept').value,
          position: document.getElementById('f-emp-pos').value,
          leave_balance: Number(document.getElementById('f-emp-leave').value),
          base_salary: Number(document.getElementById('f-emp-sal').value),
          daily_allowance: Number(document.getElementById('f-emp-allow').value)
        };
        try {
          if (isEdit) {
            await state.client.updateEmployee(existingEmp.id, payload);
            showToast('Data karyawan diperbarui.', 'success');
            closeModal();
            await refreshWorkspaceData();
          } else if (isInvite) {
            const invite = await state.client.createEmployeeInvite(payload);
            showToast('Link undangan karyawan berhasil dibuat.', 'success');
            closeModal();
            await refreshWorkspaceData();
            openInviteCreatedModal(invite);
          } else {
            await state.client.createEmployee(payload);
            showToast('Karyawan baru berhasil ditambahkan.', 'success');
            closeModal();
            await refreshWorkspaceData();
          }
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }
  });
}

function openBranchModal(existing = null) {
  const isEdit = Boolean(existing);
  openModal({
    title: isEdit ? `Edit Cabang: ${existing.name}` : 'Tambah Cabang & Geofence Baru',
    subtitle: 'Atur titik koordinat pusat dan radius maksimum (meter) untuk absensi WFO.',
    bodyHtml: `
      <form id="branch-form" class="space-y-3">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label for="f-br-code" class="block text-xs font-semibold mb-1">Kode Cabang</label>
            <input id="f-br-code" type="text" required value="${esc(existing?.code || '')}" placeholder="BDG-01" class="cmd-input w-full text-xs">
          </div>
          <div>
            <label for="f-br-name" class="block text-xs font-semibold mb-1">Nama Cabang</label>
            <input id="f-br-name" type="text" required value="${esc(existing?.name || '')}" placeholder="Cabang Bandung Dago" class="cmd-input w-full text-xs">
          </div>
        </div>
        <div>
          <label for="f-br-addr" class="block text-xs font-semibold mb-1">Alamat Lengkap</label>
          <input id="f-br-addr" type="text" value="${esc(existing?.address || '')}" class="cmd-input w-full text-xs">
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label for="f-br-lat" class="block text-xs font-semibold mb-1">Latitude</label>
            <input id="f-br-lat" type="number" step="0.0000001" required value="${existing?.latitude ?? -6.2087634}" class="cmd-input w-full text-xs tabular-nums">
          </div>
          <div>
            <label for="f-br-lon" class="block text-xs font-semibold mb-1">Longitude</label>
            <input id="f-br-lon" type="number" step="0.0000001" required value="${existing?.longitude ?? 106.8205543}" class="cmd-input w-full text-xs tabular-nums">
          </div>
          <div>
            <label for="f-br-rad" class="block text-xs font-semibold mb-1">Radius (Meter)</label>
            <input id="f-br-rad" type="number" min="20" max="5000" required value="${existing?.radius_meters ?? 150}" class="cmd-input w-full text-xs tabular-nums">
          </div>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-[#E2E4E3]">
          <button type="button" id="br-use-gps" class="btn-outline text-xs">Ambil Koordinat Browser</button>
          <div class="flex gap-2">
            <button type="button" id="br-cancel" class="btn-outline text-xs">Batal</button>
            <button type="submit" class="btn-lime text-xs">Simpan Cabang</button>
          </div>
        </div>
      </form>
    `,
    onMount: () => {
      document.getElementById('br-cancel').addEventListener('click', closeModal);
      document.getElementById('br-use-gps').addEventListener('click', () => {
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition((pos) => {
          document.getElementById('f-br-lat').value = pos.coords.latitude.toFixed(7);
          document.getElementById('f-br-lon').value = pos.coords.longitude.toFixed(7);
        });
      });
      document.getElementById('branch-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await state.client.saveBranch({
            id: existing?.id,
            company_id: state.profile.company_id,
            code: document.getElementById('f-br-code').value,
            name: document.getElementById('f-br-name').value,
            address: document.getElementById('f-br-addr').value,
            latitude: Number(document.getElementById('f-br-lat').value),
            longitude: Number(document.getElementById('f-br-lon').value),
            radius_meters: Number(document.getElementById('f-br-rad').value)
          });
          showToast('Konfigurasi cabang berhasil disimpan.', 'success');
          closeModal();
          await refreshWorkspaceData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }
  });
}

function openCreateShiftModal() {
  openModal({
    title: 'Tambah Template Shift Baru',
    subtitle: 'Aktifkan Cross-Day apabila jam selesai berada di hari berikutnya (H+1).',
    maxWidth: 'max-w-lg',
    bodyHtml: `
      <form id="shift-form" class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label for="f-shf-code" class="block text-xs font-semibold mb-1">Kode Shift</label>
            <input id="f-shf-code" type="text" required placeholder="SHF-SPL" class="cmd-input w-full text-xs">
          </div>
          <div>
            <label for="f-shf-name" class="block text-xs font-semibold mb-1">Nama Shift</label>
            <input id="f-shf-name" type="text" required placeholder="Shift Malam Operasional" class="cmd-input w-full text-xs">
          </div>
          <div>
            <label for="f-shf-start" class="block text-xs font-semibold mb-1">Jam Masuk</label>
            <input id="f-shf-start" type="time" required value="09:00" class="cmd-input w-full text-xs">
          </div>
          <div>
            <label for="f-shf-end" class="block text-xs font-semibold mb-1">Jam Pulang</label>
            <input id="f-shf-end" type="time" required value="18:00" class="cmd-input w-full text-xs">
          </div>
          <div>
            <label for="f-shf-grace" class="block text-xs font-semibold mb-1">Toleransi Telat (Menit)</label>
            <input id="f-shf-grace" type="number" min="0" max="120" value="15" class="cmd-input w-full text-xs">
          </div>
          <div>
            <label for="f-shf-mult" class="block text-xs font-semibold mb-1">Pengali Lembur</label>
            <input id="f-shf-mult" type="number" step="0.1" min="1" max="4" value="1.5" class="cmd-input w-full text-xs">
          </div>
        </div>
        <label class="inline-flex items-center gap-2 text-xs font-medium min-h-[44px]">
          <input id="f-shf-cross" type="checkbox" class="w-4 h-4">
          <span>Shift Lintas Hari (Cross-Day H+1, contoh: 22:00 - 06:00)</span>
        </label>
        <div class="flex justify-end gap-2 pt-3 border-t border-[#E2E4E3]">
          <button type="button" id="shf-cancel" class="btn-outline text-xs">Batal</button>
          <button type="submit" class="btn-lime text-xs">Simpan Shift</button>
        </div>
      </form>
    `,
    onMount: () => {
      document.getElementById('shf-cancel').addEventListener('click', closeModal);
      document.getElementById('shift-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await state.client.saveShift({
            company_id: state.profile.company_id,
            code: document.getElementById('f-shf-code').value,
            name: document.getElementById('f-shf-name').value,
            start_time: document.getElementById('f-shf-start').value,
            end_time: document.getElementById('f-shf-end').value,
            grace_period_minutes: Number(document.getElementById('f-shf-grace').value),
            overtime_rate_multiplier: Number(document.getElementById('f-shf-mult').value),
            is_cross_day: document.getElementById('f-shf-cross').checked
          });
          showToast('Template shift berhasil dibuat.', 'success');
          closeModal();
          await refreshWorkspaceData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }
  });
}

function openAssignScheduleModal() {
  const emps = getScopedEmployees();
  const shifts = state.bundle.shifts;
  openModal({
    title: 'Tetapkan Jadwal Shift Karyawan',
    maxWidth: 'max-w-md',
    bodyHtml: `
      <form id="assign-sch-form" class="space-y-3">
        <div>
          <label for="asch-emp" class="block text-xs font-semibold mb-1">Karyawan</label>
          <select id="asch-emp" class="cmd-input w-full text-xs">
            ${emps.map((e) => `<option value="${esc(e.id)}">${esc(e.full_name)} (${esc(e.employee_code)})</option>`).join('')}
          </select>
        </div>
        <div>
          <label for="asch-shift" class="block text-xs font-semibold mb-1">Shift</label>
          <select id="asch-shift" class="cmd-input w-full text-xs">
            ${shifts.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.start_time.slice(0, 5))}-${esc(s.end_time.slice(0, 5))})</option>`).join('')}
          </select>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label for="asch-date" class="block text-xs font-semibold mb-1">Tanggal</label>
            <input id="asch-date" type="date" required value="${getJakartaDateStr(0)}" class="cmd-input w-full text-xs tabular-nums">
          </div>
          <div>
            <label for="asch-mode" class="block text-xs font-semibold mb-1">Mode Kerja</label>
            <select id="asch-mode" class="cmd-input w-full text-xs">
              <option value="WFO">WFO</option>
              <option value="WFH">WFH</option>
              <option value="FIELD">Dinas Luar (FIELD)</option>
              <option value="OFF">Libur (OFF)</option>
            </select>
          </div>
        </div>
        <div class="flex justify-end gap-2 pt-3 border-t border-[#E2E4E3]">
          <button type="button" id="asch-cancel" class="btn-outline text-xs">Batal</button>
          <button type="submit" class="btn-lime text-xs">Simpan Jadwal</button>
        </div>
      </form>
    `,
    onMount: () => {
      document.getElementById('asch-cancel').addEventListener('click', closeModal);
      document.getElementById('assign-sch-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await state.client.assignSchedule({
            company_id: state.profile.company_id,
            employee_id: document.getElementById('asch-emp').value,
            shift_id: document.getElementById('asch-shift').value,
            work_date: document.getElementById('asch-date').value,
            work_mode: document.getElementById('asch-mode').value
          });
          showToast('Jadwal karyawan berhasil disimpan.', 'success');
          closeModal();
          await refreshWorkspaceData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }
  });
}

function openCreateRequestModal() {
  const emps = getScopedEmployees();
  const today = getJakartaDateStr(0);
  openModal({
    title: 'Buat Pengajuan Cuti / Sakit / Lembur',
    maxWidth: 'max-w-lg',
    bodyHtml: `
      <form id="adm-req-form" class="space-y-3">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label for="areq-emp" class="block text-xs font-semibold mb-1">Karyawan</label>
            <select id="areq-emp" class="cmd-input w-full text-xs">
              ${emps.map((e) => `<option value="${esc(e.id)}">${esc(e.full_name)} (${esc(e.employee_code)})</option>`).join('')}
            </select>
          </div>
          <div>
            <label for="areq-type" class="block text-xs font-semibold mb-1">Jenis Pengajuan</label>
            <select id="areq-type" class="cmd-input w-full text-xs">
              <option value="LEAVE">Cuti Tahunan</option>
              <option value="SICK">Izin Sakit</option>
              <option value="OVERTIME">Lembur</option>
              <option value="SHIFT_SWAP">Tukar Shift</option>
            </select>
          </div>
          <div>
            <label for="areq-start" class="block text-xs font-semibold mb-1">Tanggal Mulai</label>
            <input id="areq-start" type="date" required value="${today}" class="cmd-input w-full text-xs">
          </div>
          <div>
            <label for="areq-end" class="block text-xs font-semibold mb-1">Tanggal Selesai</label>
            <input id="areq-end" type="date" required value="${today}" class="cmd-input w-full text-xs">
          </div>
          <div id="areq-hours-wrap" class="hidden sm:col-span-2">
            <label for="areq-hours" class="block text-xs font-semibold mb-1">Durasi Jam Lembur</label>
            <input id="areq-hours" type="number" step="0.5" min="0.5" max="12" value="2" class="cmd-input w-full text-xs">
          </div>
          <div id="areq-swap-wrap" class="hidden sm:col-span-2">
            <label for="areq-target" class="block text-xs font-semibold mb-1">Rekan Tukar Shift</label>
            <select id="areq-target" class="cmd-input w-full text-xs">
              ${emps.map((e) => `<option value="${esc(e.id)}">${esc(e.full_name)} (${esc(e.employee_code)})</option>`).join('')}
            </select>
          </div>
        </div>
        <div>
          <label for="areq-reason" class="block text-xs font-semibold mb-1">Alasan Pengajuan</label>
          <textarea id="areq-reason" rows="2" required minlength="5" class="cmd-input w-full text-xs" placeholder="Keterangan pengajuan..."></textarea>
        </div>
        <div class="flex justify-end gap-2 pt-3 border-t border-[#E2E4E3]">
          <button type="button" id="areq-cancel" class="btn-outline text-xs">Batal</button>
          <button type="submit" class="btn-lime text-xs">Kirim Pengajuan</button>
        </div>
      </form>
    `,
    onMount: () => {
      const typeSel = document.getElementById('areq-type');
      const toggleFields = () => {
        document.getElementById('areq-hours-wrap').classList.toggle('hidden', typeSel.value !== 'OVERTIME');
        document.getElementById('areq-swap-wrap').classList.toggle('hidden', typeSel.value !== 'SHIFT_SWAP');
      };
      typeSel.addEventListener('change', toggleFields);
      document.getElementById('areq-cancel').addEventListener('click', closeModal);
      document.getElementById('adm-req-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const empId = document.getElementById('areq-emp').value;
        const type = typeSel.value;
        const startDate = document.getElementById('areq-start').value;
        const endDate = document.getElementById('areq-end').value;
        const targetId = type === 'SHIFT_SWAP' ? document.getElementById('areq-target').value : null;
        if (endDate < startDate) {
          showToast('Tanggal selesai tidak boleh lebih awal dari tanggal mulai.', 'error');
          return;
        }
        if (type === 'SHIFT_SWAP' && targetId === empId) {
          showToast('Rekan tukar shift harus berbeda dari karyawan pemohon.', 'error');
          return;
        }
        try {
          await state.client.createRequest({
            company_id: state.profile.company_id,
            employee_id: empId,
            target_employee_id: targetId || null,
            type,
            start_date: startDate,
            end_date: endDate,
            hours_requested: type === 'OVERTIME' ? Number(document.getElementById('areq-hours').value) : 0,
            reason: document.getElementById('areq-reason').value
          });
          showToast('Pengajuan berhasil dibuat.', 'success');
          closeModal();
          await refreshWorkspaceData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }
  });
}

function buildPayslipMarkup(pay, emp, branch, company) {
  const grossEarnings = Number(pay.base_salary) + Number(pay.allowances_total) + Number(pay.overtime_pay);
  const totalDeductions = Number(pay.deductions_total) + Number(pay.fixed_deductions);

  return `
    <div class="print-slip-box bg-[#FFFFFF] border border-[#111815] p-6 space-y-5 text-xs text-[#111815]">
      <div class="flex flex-wrap items-start justify-between gap-4 border-b-2 border-[#111815] pb-4">
        <div>
          <div class="text-base font-bold uppercase tracking-tight">${esc(company?.name || 'PT Nusantara Ritel Operasional')}</div>
          <div class="text-xs text-[#4B5563]">${esc(branch?.name || '-')} | ${esc(branch?.address || '')}</div>
        </div>
        <div class="text-right tabular-nums">
          <div class="text-sm font-bold uppercase">SLIP GAJI KARYAWAN</div>
          <div class="text-xs">Periode: <strong>${monthNameId(pay.period_month)} ${pay.period_year}</strong></div>
          <div class="text-[11px] text-[#4B5563]">Ref Audit: ${esc(pay.reference_no)}</div>
        </div>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-[#F4F5F4] p-3 border border-[#E2E4E3] tabular-nums">
        <div><span class="text-[#525856] block text-[11px]">NIK</span><strong>${esc(emp?.employee_code || '-')}</strong></div>
        <div><span class="text-[#525856] block text-[11px]">Nama Karyawan</span><strong>${esc(emp?.full_name || '-')}</strong></div>
        <div><span class="text-[#525856] block text-[11px]">Divisi / Jabatan</span><strong>${esc(emp?.department || '')} / ${esc(emp?.position || '')}</strong></div>
        <div><span class="text-[#525856] block text-[11px]">Status Pembayaran</span><strong>${esc(pay.status)}</strong></div>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 border border-[#E2E4E3] p-3 text-center tabular-nums">
        <div><span class="text-[#525856] block text-[10px]">Total Hadir</span><strong>${pay.total_present} hari</strong></div>
        <div><span class="text-[#525856] block text-[10px]">Hadir Fisik WFO</span><strong>${pay.total_wfo_days} hari</strong></div>
        <div><span class="text-[#525856] block text-[10px]">Total Telat</span><strong>${pay.total_late_minutes} menit</strong></div>
        <div><span class="text-[#525856] block text-[10px]">Total Lembur</span><strong>${formatMins(pay.total_overtime_minutes)}</strong></div>
        <div><span class="text-[#525856] block text-[10px]">Alpha</span><strong>${pay.total_absent_days} hari</strong></div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <table class="print-table w-full border-collapse border border-[#E2E4E3]">
          <thead>
            <tr class="bg-[#F4F5F4]"><th class="p-2 border border-[#E2E4E3] text-left">Penerimaan</th><th class="p-2 border border-[#E2E4E3] text-right">Nominal</th></tr>
          </thead>
          <tbody class="tabular-nums">
            <tr><td class="p-2 border border-[#E2E4E3]">Gaji Pokok</td><td class="p-2 border border-[#E2E4E3] text-right">${esc(formatRupiah(pay.base_salary))}</td></tr>
            <tr><td class="p-2 border border-[#E2E4E3]">Tunjangan Kehadiran Fisik (${pay.total_wfo_days} WFO)</td><td class="p-2 border border-[#E2E4E3] text-right">${esc(formatRupiah(pay.allowances_total))}</td></tr>
            <tr><td class="p-2 border border-[#E2E4E3]">Upah Lembur (Basis 1/173)</td><td class="p-2 border border-[#E2E4E3] text-right">${esc(formatRupiah(pay.overtime_pay))}</td></tr>
            <tr class="font-bold bg-[#F4F5F4]"><td class="p-2 border border-[#E2E4E3]">Total Penerimaan Bruto</td><td class="p-2 border border-[#E2E4E3] text-right">${esc(formatRupiah(grossEarnings))}</td></tr>
          </tbody>
        </table>

        <table class="print-table w-full border-collapse border border-[#E2E4E3]">
          <thead>
            <tr class="bg-[#F4F5F4]"><th class="p-2 border border-[#E2E4E3] text-left">Potongan</th><th class="p-2 border border-[#E2E4E3] text-right">Nominal</th></tr>
          </thead>
          <tbody class="tabular-nums">
            <tr><td class="p-2 border border-[#E2E4E3]">Potongan Keterlambatan &amp; Alpha</td><td class="p-2 border border-[#E2E4E3] text-right">${esc(formatRupiah(pay.deductions_total))}</td></tr>
            <tr><td class="p-2 border border-[#E2E4E3]">Potongan Tetap (BPJS / Pajak)</td><td class="p-2 border border-[#E2E4E3] text-right">${esc(formatRupiah(pay.fixed_deductions))}</td></tr>
            <tr class="font-bold bg-[#F4F5F4]"><td class="p-2 border border-[#E2E4E3]">Total Potongan</td><td class="p-2 border border-[#E2E4E3] text-right">${esc(formatRupiah(totalDeductions))}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="p-4 bg-[#111815] text-[#FFFFFF] flex items-center justify-between gap-4 tabular-nums">
        <span class="text-xs font-semibold uppercase tracking-wide">Take Home Pay (Gaji Bersih Diterima)</span>
        <span class="text-lg font-bold text-[#84CC16]">${esc(formatRupiah(pay.net_salary))}</span>
      </div>

      <div class="flex justify-between text-[11px] text-[#525856] pt-2">
        <span>Dokumen dihasilkan otomatis oleh VECTRA Payroll OS</span>
        <span class="tabular-nums">Dicetak: ${esc(formatWibDateTime(new Date()))}</span>
      </div>
    </div>
  `;
}

function openPayslipModal(payrollId) {
  const pay = state.bundle.payrolls.find((p) => p.id === payrollId);
  if (!pay) return;
  const emp = state.bundle.profiles.find((p) => p.id === pay.employee_id);
  const branch = state.bundle.branches.find((b) => b.id === emp?.branch_id);
  const markup = buildPayslipMarkup(pay, emp, branch, state.bundle.company);

  openModal({
    title: `Pratinjau Slip Gaji Formal: ${emp?.full_name || ''}`,
    subtitle: `${pay.reference_no} | Periode ${monthNameId(pay.period_month)} ${pay.period_year}`,
    maxWidth: 'max-w-3xl',
    bodyHtml: `
      <div id="slip-preview-container">${markup}</div>
      <div class="flex flex-wrap items-center justify-between gap-2 pt-2">
        <div class="flex items-center gap-2 text-xs">
          <label for="slip-paper-size" class="font-semibold text-[#525856]">Ukuran Cetak:</label>
          <select id="slip-paper-size" class="cmd-input text-xs py-1 px-2">
            <option value="a4">A4 Portrait (Standar)</option>
            <option value="a5">A5 Ringkas</option>
          </select>
        </div>
        <div class="flex gap-2">
          <button type="button" id="slip-close-btn" class="btn-outline text-xs">Tutup</button>
          <button type="button" id="slip-print-btn" class="btn-lime text-xs">Cetak / Simpan PDF</button>
        </div>
      </div>
    `,
    onMount: () => {
      document.getElementById('slip-close-btn').addEventListener('click', closeModal);
      document.getElementById('slip-print-btn').addEventListener('click', () => {
        const size = document.getElementById('slip-paper-size').value;
        const printSheet = document.getElementById('print-sheet');
        printSheet.innerHTML = markup;
        const box = printSheet.querySelector('.print-slip-box');
        if (box && size === 'a5') box.classList.add('print-a5');
        window.print();
      });
    }
  });
}

function printAttendanceReport(logs) {
  const empMap = new Map(state.bundle.profiles.map((p) => [p.id, p]));
  const branchMap = new Map(state.bundle.branches.map((b) => [b.id, b]));
  const printSheet = document.getElementById('print-sheet');

  printSheet.innerHTML = `
    <div class="space-y-4">
      <div class="border-b-2 border-[#111815] pb-3 flex justify-between items-end">
        <div>
          <h1 class="text-base font-bold uppercase">${esc(state.bundle.company?.name || 'VECTRA')}</h1>
          <p class="text-xs">Laporan Rekapitulasi Kehadiran &amp; Audit Absensi</p>
        </div>
        <div class="text-right text-xs tabular-nums">
          <div>Periode: ${esc(state.filters.startDate)} s.d. ${esc(state.filters.endDate)}</div>
          <div>Total Baris: ${logs.length} | Dicetak: ${esc(formatWibDateTime(new Date()))}</div>
        </div>
      </div>

      <table class="print-table">
        <thead>
          <tr>
            <th>Tanggal</th>
            <th>NIK</th>
            <th>Nama Karyawan</th>
            <th>Cabang</th>
            <th>Mode</th>
            <th>Clock In</th>
            <th>Clock Out</th>
            <th>Jarak</th>
            <th>Telat</th>
            <th>Lembur</th>
            <th>Status / Audit</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map((l) => {
            const emp = empMap.get(l.employee_id);
            const br = branchMap.get(l.branch_id);
            return `
              <tr>
                <td>${esc(l.work_date)}</td>
                <td>${esc(emp?.employee_code || '-')}</td>
                <td>${esc(emp?.full_name || '-')}</td>
                <td>${esc(br?.code || '-')}</td>
                <td>${esc(l.work_mode)}</td>
                <td>${esc(formatWibTime(l.clock_in_at))}</td>
                <td>${l.clock_out_at ? esc(formatWibTime(l.clock_out_at)) : 'Aktif'}</td>
                <td>${l.clock_in_distance_m != null ? `${Math.round(l.clock_in_distance_m)}m` : '-'}</td>
                <td>${l.late_minutes}m</td>
                <td>${formatMins(l.overtime_minutes)}</td>
                <td>${l.is_flagged ? `FLAG: ${esc(l.flag_reason)}` : esc(l.status)}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
  window.print();
}

// ----------------------------------------------------------------------------
// NAVIGATION & GLOBAL EVENT WIRING
// ----------------------------------------------------------------------------

function navigateToModule(moduleName) {
  state.activeModule = moduleName;
  closeMobileDrawer();
  updateShellChrome();
  renderActiveSurface();
}

function closeMobileDrawer() {
  const sidebar = document.getElementById('app-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar.classList.add('-translate-x-full');
  backdrop.classList.add('hidden');
}

function openMobileDrawer() {
  const sidebar = document.getElementById('app-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar.classList.remove('-translate-x-full');
  backdrop.classList.remove('hidden');
  document.getElementById('mobile-sidebar-close')?.focus();
}

function bindShellListeners() {
  // Sidebar navigation
  document.querySelectorAll('#app-sidebar [data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-nav');
      if (target === 'attendance' && state.attendanceFilter.status === 'FLAGGED') {
        state.attendanceFilter.status = 'ALL';
      }
      navigateToModule(target);
    });
  });

  // Dedicated Sidebar Action Shortcuts (Kiosk QR, Fraud Audit, Ledger Sync)
  document.getElementById('sidebar-kiosk-btn')?.addEventListener('click', () => {
    closeMobileDrawer();
    openKioskQrModal();
  });
  document.getElementById('sidebar-fraud-btn')?.addEventListener('click', () => {
    state.attendanceFilter.status = 'FLAGGED';
    state.attendanceFilter.page = 1;
    navigateToModule('attendance');
  });
  document.getElementById('sidebar-ledger-btn')?.addEventListener('click', () => {
    navigateToModule('payroll');
  });

  // Collapse sidebar
  const collapseBtn = document.getElementById('sidebar-collapse-btn');
  collapseBtn.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('sidebar-collapsed');
    collapseBtn.setAttribute('aria-expanded', String(!collapsed));
  });

  // Mobile drawer
  document.getElementById('mobile-menu-btn').addEventListener('click', openMobileDrawer);
  document.getElementById('mobile-sidebar-close').addEventListener('click', () => {
    closeMobileDrawer();
    document.getElementById('mobile-menu-btn').focus();
  });
  document.getElementById('sidebar-backdrop').addEventListener('click', closeMobileDrawer);

  // Global Command Search
  const gSearch = document.getElementById('global-search-input');
  const gResults = document.getElementById('global-search-results');
  gSearch.addEventListener('input', () => {
    const q = gSearch.value.trim().toLowerCase();
    if (!q || !state.bundle) {
      gResults.classList.add('hidden');
      return;
    }
    const matches = state.bundle.profiles
      .filter((p) => `${p.full_name} ${p.employee_code} ${p.department}`.toLowerCase().includes(q))
      .slice(0, 6);
    if (!matches.length) {
      gResults.innerHTML = '<div class="p-3 text-xs text-[#525856]">Tidak ditemukan karyawan cocok.</div>';
    } else {
      gResults.innerHTML = matches.map((m) => `
        <button type="button" data-search-pick="${esc(m.full_name)}" class="w-full text-left p-3 hover:bg-[#F4F5F4] flex items-center justify-between gap-2 text-xs">
          <span><strong>${esc(m.full_name)}</strong> (${esc(m.employee_code)})</span>
          <span class="text-[#525856]">${esc(m.department)}</span>
        </button>
      `).join('');
      gResults.querySelectorAll('[data-search-pick]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.employeeFilter.search = btn.getAttribute('data-search-pick');
          state.employeeFilter.page = 1;
          gResults.classList.add('hidden');
          navigateToModule('employees');
        });
      });
    }
    gResults.classList.remove('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!gSearch.contains(e.target) && !gResults.contains(e.target)) {
      gResults.classList.add('hidden');
    }
  });

  // Demo Role Switcher (Topbar & Mobile Sidebar Drawer)
  const onRoleSwitch = async (e) => {
    const role = e.target.value;
    closeMobileDrawer();
    state.profile = await state.client.signInDemoRole(role);
    state.viewShell = role === 'employee' ? 'portal' : 'admin';
    state.activeModule = 'overview';
    state.filters.branchId = '';
    await refreshWorkspaceData();
  };
  document.getElementById('demo-role-select').addEventListener('change', onRoleSwitch);
  document.getElementById('sidebar-demo-role-select')?.addEventListener('change', onRoleSwitch);

  // Switch between Admin Command Center and Employee Mobile Portal
  const goPortal = () => {
    state.viewShell = 'portal';
    closeMobileDrawer();
    requestBrowserGeolocation();
    updateShellChrome();
    renderActiveSurface();
  };
  document.getElementById('switch-to-portal-btn').addEventListener('click', goPortal);
  document.getElementById('sidebar-switch-portal-btn')?.addEventListener('click', goPortal);

  document.getElementById('portal-back-admin-btn').addEventListener('click', () => {
    state.viewShell = 'admin';
    updateShellChrome();
    renderActiveSurface();
  });

  // Portal bottom tabs
  document.querySelectorAll('.portal-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.portalTab = btn.getAttribute('data-portal-tab');
      renderEmployeePortal();
    });
  });

  // Sync & Notification popover
  document.getElementById('sync-btn').addEventListener('click', async () => {
    if (state.offlineItems.length > 0) await syncOfflineQueue();
    else {
      await refreshWorkspaceData();
      showToast('Data workspace berhasil disinkronkan.', 'success');
    }
  });

  const notifBtn = document.getElementById('notif-btn');
  const notifPop = document.getElementById('notif-popover');
  const renderNotifItems = () => {
    const list = document.getElementById('notif-list');
    const scopedEmps = state.bundle ? getScopedEmployees() : [];
    const scopedEmpIds = new Set(scopedEmps.map((p) => p.id));
    const flagged = (state.bundle?.attendance_logs || []).filter(
      (l) => l.is_flagged && !l.flag_reviewed_at && scopedEmpIds.has(l.employee_id)
    );
    const pending = (state.bundle?.requests || []).filter(
      (r) => ['pending_supervisor', 'pending_hr'].includes(r.status) && scopedEmpIds.has(r.employee_id)
    );
    const empMap = new Map((state.bundle?.profiles || []).map((p) => [p.id, p]));

    if (!flagged.length && !pending.length) {
      list.innerHTML = '<p class="text-[#525856] py-2">Tidak ada notifikasi tertunda.</p>';
      return;
    }

    list.innerHTML = [
      ...flagged.map((f) => `<button type="button" data-n-audit="${esc(f.id)}" class="w-full text-left p-2 rounded bg-[#FEE2E2] text-[#991B1B] font-medium hover:underline">FRAUD: ${esc(empMap.get(f.employee_id)?.full_name || '-')} (${esc(f.flag_reason)})</button>`),
      ...pending.map((r) => `<button type="button" data-n-req="1" class="w-full text-left p-2 rounded bg-[#FEF3C7] text-[#92400E] font-medium hover:underline">APPROVAL: ${esc(empMap.get(r.employee_id)?.full_name || '-')} (${esc(r.type)})</button>`)
    ].join('');

    list.querySelectorAll('[data-n-audit]').forEach((b) => {
      b.addEventListener('click', () => {
        notifPop.classList.add('hidden');
        openAuditModal(b.getAttribute('data-n-audit'));
      });
    });
    list.querySelectorAll('[data-n-req]').forEach((b) => {
      b.addEventListener('click', () => {
        notifPop.classList.add('hidden');
        navigateToModule('approvals');
      });
    });
  };

  notifBtn.addEventListener('click', () => {
    renderNotifItems();
    const open = notifPop.classList.toggle('hidden');
    notifBtn.setAttribute('aria-expanded', String(!open));
  });
  document.getElementById('notif-close-btn').addEventListener('click', () => {
    notifPop.classList.add('hidden');
    notifBtn.setAttribute('aria-expanded', 'false');
  });

  // Hero quick actions
  document.getElementById('hero-add-emp-btn').addEventListener('click', () => openEmployeeModal(null));
  document.getElementById('hero-kiosk-btn').addEventListener('click', () => openKioskQrModal());

  // Multi-criteria Filter Bar
  document.getElementById('filter-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    state.filters.branchId = document.getElementById('filter-branch').value;
    state.filters.department = document.getElementById('filter-dept').value;
    state.filters.shiftId = document.getElementById('filter-shift').value;
    state.filters.startDate = document.getElementById('filter-start-date').value;
    state.filters.endDate = document.getElementById('filter-end-date').value;
    state.attendanceFilter.page = 1;
    await refreshWorkspaceData();
  });

  document.getElementById('filter-reset-btn').addEventListener('click', async () => {
    state.filters = {
      branchId: state.profile.role === 'supervisor' ? state.profile.branch_id : '',
      department: '',
      shiftId: '',
      startDate: getJakartaDateStr(-7),
      endDate: getJakartaDateStr(0)
    };
    state.attendanceFilter = {
      search: '',
      status: 'ALL',
      page: 1,
      pageSize: state.attendanceFilter.pageSize || PAGE_SIZE
    };
    await refreshWorkspaceData();
  });

  // Reset Demo Data
  document.getElementById('reset-demo-btn').addEventListener('click', async () => {
    state.client.resetDemo();
    showToast('Dataset simulasi demo dikembalikan ke kondisi awal.', 'success');
    await refreshWorkspaceData();
  });

  // Logout
  const handleLogout = async () => {
    await state.client.signOut();
    window.location.href = 'index.html';
  };
  document.getElementById('admin-logout-btn').addEventListener('click', handleLogout);
  document.getElementById('portal-logout-btn').addEventListener('click', handleLogout);

  // Live online/offline listener with automatic IndexedDB queue synchronization
  window.addEventListener('online', async () => {
    updateShellChrome();
    state.offlineItems = await OfflineQueue.getAll();
    if (state.offlineItems.length > 0 && !state.gps.simulateOffline) {
      showToast('Koneksi kembali aktif. Menyinkronkan antrean absensi offline...', 'info');
      await syncOfflineQueue();
    }
  });
  window.addEventListener('offline', () => {
    updateShellChrome();
    showToast('Koneksi terputus. Absensi baru akan disimpan sementara ke IndexedDB lokal.', 'warning');
  });
}

// ----------------------------------------------------------------------------
// APPLICATION BOOTSTRAP
// ----------------------------------------------------------------------------

function updateLiveClocks() {
  const text = formatWibDateTime(new Date());
  const heroClock = document.getElementById('hero-live-clock');
  if (heroClock) heroClock.textContent = text;
  const portalClock = document.getElementById('portal-live-clock');
  if (portalClock) portalClock.textContent = text;
}

let liveClockTimer = null;

function renderOnboardingScreen(bootEl, session, prefillInviteToken = '') {
  const userEmail = session?.user?.email || '';
  const defaultName = session?.user?.user_metadata?.full_name || userEmail.split('@')[0] || '';
  const defaultCompany = session?.user?.user_metadata?.company_name || '';

  bootEl.classList.remove('hidden');
  bootEl.innerHTML = `
    <div class="cmd-card p-6 max-w-md w-full space-y-4 text-left border-[#111815]">
      <div class="space-y-1">
        <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#ECFCCB] text-[#3F6212] border border-[#BEF264] text-[10px] font-bold uppercase">Sesi Terverifikasi</span>
        <h1 class="text-base font-bold text-[#111815]">Aktivasi Workspace VECTRA</h1>
        <p class="text-xs text-[#525856]">
          Akun <strong>${esc(userEmail)}</strong> sudah masuk, namun belum terhubung ke perusahaan di tabel <code>att_profiles</code>. Gabung pakai kode undangan HRD atau buat workspace perusahaan baru.
        </p>
      </div>

      <form id="ob-invite-form" class="p-3.5 rounded border border-[#E2E4E3] bg-[#F4F5F4] space-y-2.5">
        <div class="text-xs font-bold text-[#111815]">Punya Kode Undangan Karyawan dari HRD?</div>
        <div class="flex gap-2">
          <input id="ob-inv-token" type="text" value="${esc(prefillInviteToken)}" placeholder="VCT-XXXXXXXXXXXXXXXX" class="cmd-input flex-1 text-xs font-mono uppercase">
          <button type="submit" id="ob-inv-btn" class="btn-obsidian text-xs">Gabung</button>
        </div>
        <div id="ob-inv-error" class="hidden text-xs text-[#991B1B] font-medium"></div>
      </form>

      <div class="relative flex items-center py-0.5">
        <div class="flex-grow border-t border-[#E2E4E3]"></div>
        <span class="shrink mx-3 text-[11px] text-[#525856] font-medium">atau buat perusahaan baru</span>
        <div class="flex-grow border-t border-[#E2E4E3]"></div>
      </div>

      <form id="onboard-form" class="space-y-3">
        <div>
          <label for="ob-name" class="block text-xs font-semibold text-[#111815] mb-1">Nama Lengkap</label>
          <input id="ob-name" type="text" required value="${esc(defaultName)}" placeholder="Nama HRD / Pemilik" class="cmd-input w-full text-xs">
        </div>
        <div>
          <label for="ob-company" class="block text-xs font-semibold text-[#111815] mb-1">Nama Perusahaan</label>
          <input id="ob-company" type="text" required value="${esc(defaultCompany)}" placeholder="PT Nusantara Ritel Operasional" class="cmd-input w-full text-xs">
        </div>
        <div id="ob-error" class="hidden p-2.5 rounded border border-[#FCA5A5] bg-[#FEF2F2] text-xs text-[#991B1B]"></div>
        <button type="submit" id="ob-submit-btn" class="btn-lime w-full text-xs">Buat Workspace Perusahaan &amp; Masuk</button>
      </form>

      <div class="flex flex-wrap gap-2 pt-2 border-t border-[#E2E4E3]">
        <a href="app.html?mode=demo&amp;role=company_admin" class="btn-obsidian text-xs flex-1">Buka Mode Demo</a>
        <button type="button" id="ob-logout-btn" class="btn-outline text-xs flex-1">Keluar Sesi</button>
      </div>
    </div>
  `;

  document.getElementById('ob-logout-btn')?.addEventListener('click', async () => {
    await state.client.signOut();
    window.location.href = 'index.html';
  });

  document.getElementById('ob-invite-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = document.getElementById('ob-inv-token').value.trim().toUpperCase();
    const btn = document.getElementById('ob-inv-btn');
    const errBox = document.getElementById('ob-inv-error');
    if (!token) return;
    errBox.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Memproses...';
    try {
      const res = await state.client.acceptEmployeeInvite(token);
      if (!res?.success) {
        throw new Error(res?.message || 'Gagal memproses kode undangan.');
      }
      try { sessionStorage.removeItem('vectra_pending_invite'); } catch {}
      window.location.reload();
    } catch (err) {
      errBox.textContent = err?.message || 'Kode undangan gagal diproses.';
      errBox.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Gabung';
    }
  });

  document.getElementById('onboard-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('ob-submit-btn');
    const errBox = document.getElementById('ob-error');
    const fullName = document.getElementById('ob-name').value.trim();
    const companyName = document.getElementById('ob-company').value.trim();

    errBox.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Menginisialisasi workspace...';
    try {
      await state.client.onboardLiveWorkspace({ fullName, companyName });
      window.location.reload();
    } catch (err) {
      errBox.textContent = err?.message || 'Gagal mengaktifkan workspace.';
      errBox.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Buat Workspace Perusahaan & Masuk';
    }
  });
}

async function boot() {
  window.__VECTRA_APP_BOOTED__ = true;
  const bootEl = document.getElementById('boot-loading');
  let bootSucceeded = false;

  try {
    state.client = createDataClient();
    try {
      state.deviceHash = await generateDeviceFingerprint();
    } catch {
      state.deviceHash = 'dev_fallback_0001';
    }

    const sessionState = await state.client.getSessionState();
    const { session } = sessionState;
    let { profile } = sessionState;
    if (!session) {
      window.location.href = isDemoMode() ? 'app.html?mode=demo&role=company_admin' : 'index.html';
      return;
    }

    if (!profile && !isDemoMode()) {
      let pendingInvite = session.user?.user_metadata?.invite_token || '';
      if (!pendingInvite) {
        try { pendingInvite = sessionStorage.getItem('vectra_pending_invite') || ''; } catch {}
      }
      if (pendingInvite && typeof state.client.acceptEmployeeInvite === 'function') {
        try {
          const claimRes = await state.client.acceptEmployeeInvite(pendingInvite);
          if (claimRes?.success && claimRes.profile) {
            profile = claimRes.profile;
            try { sessionStorage.removeItem('vectra_pending_invite'); } catch {}
          }
        } catch {
          // Fall through to manual onboarding screen with prefilled token
        }
      }
      if (!profile) {
        renderOnboardingScreen(bootEl, session, pendingInvite);
        return;
      }
    }

    if (!profile) {
      window.location.href = 'app.html?mode=demo&role=company_admin';
      return;
    }

    state.profile = profile;
    state.viewShell = profile.role === 'employee' ? 'portal' : 'admin';

    bindShellListeners();

    if (state.viewShell === 'portal') {
      requestBrowserGeolocation();
    }

    await refreshWorkspaceData();
    updateLiveClocks();
    if (liveClockTimer) clearInterval(liveClockTimer);
    liveClockTimer = setInterval(updateLiveClocks, 1000);

    bootSucceeded = true;
  } catch (err) {
    if (bootEl) {
      bootEl.classList.remove('hidden');
      bootEl.innerHTML = `
        <div class="cmd-card p-6 max-w-md w-full space-y-3 border-[#DC2626] text-left">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full bg-[#DC2626]" aria-hidden="true"></span>
            <h1 class="text-sm font-bold text-[#991B1B]">Gagal Menginisialisasi VECTRA</h1>
          </div>
          <p class="text-xs text-[#4B5563] leading-relaxed">${esc(err?.message || 'Terjadi kesalahan tidak terduga saat memuat workspace.')}</p>
          <div class="flex flex-wrap gap-2 pt-1">
            <a href="app.html?mode=demo&amp;role=company_admin" class="btn-lime text-xs flex-1">Buka Mode Demo</a>
            <a href="index.html" class="btn-obsidian text-xs flex-1">Kembali ke Login</a>
            <button type="button" id="boot-retry-btn" class="btn-outline text-xs">Muat Ulang</button>
          </div>
        </div>`;
      document.getElementById('boot-retry-btn')?.addEventListener('click', () => window.location.reload());
    }
  } finally {
    if (bootSucceeded && bootEl) {
      bootEl.classList.add('hidden');
    }
  }
}

boot();
