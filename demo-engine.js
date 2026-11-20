// ============================================================================
// VECTRA // Demo Engine (Full In-Memory + LocalStorage Mock Database & RPCs)
// Activated automatically via ?mode=demo or unconfigured Supabase fallback.
// Mirrors Supabase Schema, RLS Scopes & Server-Side RPC Rules 1:1.
// ============================================================================

import {
  calculateHaversineDistance,
  evaluateGpsIntegrity,
  formatWibDateTime,
  verifyRotatingQrPayload
} from './anti-fraud.js';

const STORAGE_KEY = 'vectra_demo_state_v1';
const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_COMPANY_ID = '11111111-1111-4111-8111-111111111112';

function safeStorageGet(key) {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeStorageSet(key, val) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, val);
  } catch {
    // Keep running in memory when storage is unavailable
  }
}

export function getJakartaDateStr(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function getJakartaYearMonth(offsetMonths = 0) {
  const now = new Date();
  const wibParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(now);
  const map = Object.fromEntries(wibParts.map((p) => [p.type, p.value]));
  const dt = new Date(Date.UTC(Number(map.year), Number(map.month) - 1 + offsetMonths, 1));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1 };
}

function wibIso(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}+07:00`).toISOString();
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00+07:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return getJakartaDateStrFromDate(d);
}

function getJakartaDateStrFromDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function getIsoWeekday(dateStr) {
  const d = new Date(`${dateStr}T12:00:00+07:00`);
  const day = d.getUTCDay();
  return day === 0 ? 7 : day;
}

function buildInitialDemoData() {
  const todayStr = getJakartaDateStr(0);
  const prevYm = getJakartaYearMonth(-1);

  const companies = [
    {
      id: COMPANY_ID,
      name: 'PT Nusantara Ritel Operasional',
      slug: 'nusantara-ritel',
      subscription_plan: 'ENTERPRISE',
      timezone: 'Asia/Jakarta',
      late_penalty_per_minute: 1500,
      is_active: true
    },
    {
      id: SECOND_COMPANY_ID,
      name: 'PT Karya Logistik Mandiri',
      slug: 'karya-logistik',
      subscription_plan: 'GROWTH',
      timezone: 'Asia/Jakarta',
      late_penalty_per_minute: 1200,
      is_active: true
    }
  ];

  const branches = [
    {
      id: '22222222-2222-4222-8222-222222222201',
      company_id: COMPANY_ID,
      name: 'Cabang Pusat Jakarta (Sudirman HQ)',
      code: 'JKT-HQ',
      address: 'Jl. Jend. Sudirman Kav. 52-53, Kebayoran Baru, Jakarta Selatan',
      latitude: -6.2087634,
      longitude: 106.8205543,
      radius_meters: 150,
      qr_secret_key: 'vectra_jkt_hq_totp_secret_9a8f4e21',
      is_active: true
    },
    {
      id: '22222222-2222-4222-8222-222222222202',
      company_id: COMPANY_ID,
      name: 'Cabang Operasional Depok (Margonda Hub)',
      code: 'DPK-01',
      address: 'Jl. Margonda Raya No. 358, Kemiri Muka, Beji, Kota Depok',
      latitude: -6.3726925,
      longitude: 106.8323285,
      radius_meters: 150,
      qr_secret_key: 'vectra_dpk_hub_totp_secret_3c7b1d90',
      is_active: true
    }
  ];

  const shifts = [
    {
      id: '33333333-3333-4333-8333-333333333301',
      company_id: COMPANY_ID,
      name: 'Shift Pagi Operasional',
      code: 'SHF-PG',
      start_time: '08:00:00',
      end_time: '17:00:00',
      grace_period_minutes: 15,
      is_cross_day: false,
      overtime_rate_multiplier: 1.5
    },
    {
      id: '33333333-3333-4333-8333-333333333302',
      company_id: COMPANY_ID,
      name: 'Shift Siang Ritel',
      code: 'SHF-SG',
      start_time: '14:00:00',
      end_time: '22:00:00',
      grace_period_minutes: 15,
      is_cross_day: false,
      overtime_rate_multiplier: 1.5
    },
    {
      id: '33333333-3333-4333-8333-333333333303',
      company_id: COMPANY_ID,
      name: 'Shift Malam Cross-Day',
      code: 'SHF-ML',
      start_time: '22:00:00',
      end_time: '06:00:00',
      grace_period_minutes: 10,
      is_cross_day: true,
      overtime_rate_multiplier: 2.0
    }
  ];

  const jktId = branches[0].id;
  const dpkId = branches[1].id;

  const profiles = [
    { id: '44444444-4444-4444-8444-444444444401', company_id: COMPANY_ID, branch_id: jktId, employee_code: 'EMP-001', full_name: 'Rizky Pratama', email: 'rizky.hrd@nusantararitel.co.id', phone: '0812-8001-1001', role: 'company_admin', department: 'HR & People', position: 'HRD Operations Lead', base_salary: 14500000, daily_allowance: 75000, fixed_deduction: 350000, leave_balance: 12, bound_device_hash: null, is_active: true },
    { id: '44444444-4444-4444-8444-444444444402', company_id: COMPANY_ID, branch_id: jktId, employee_code: 'EMP-002', full_name: 'Hendra Wijaya', email: 'hendra.spv@nusantararitel.co.id', phone: '0812-8001-1002', role: 'supervisor', department: 'Operasional Toko', position: 'Branch Supervisor Jakarta', base_salary: 9800000, daily_allowance: 60000, fixed_deduction: 220000, leave_balance: 11, bound_device_hash: null, is_active: true },
    { id: '44444444-4444-4444-8444-444444444403', company_id: COMPANY_ID, branch_id: dpkId, employee_code: 'EMP-003', full_name: 'Ratna Sari Dewi', email: 'ratna.spv@nusantararitel.co.id', phone: '0812-8001-1003', role: 'supervisor', department: 'Gudang & Logistik', position: 'Branch Supervisor Depok', base_salary: 9500000, daily_allowance: 60000, fixed_deduction: 210000, leave_balance: 10, bound_device_hash: null, is_active: true },
    { id: '44444444-4444-4444-8444-444444444404', company_id: COMPANY_ID, branch_id: jktId, employee_code: 'EMP-004', full_name: 'Dimas Anggara', email: 'dimas.anggara@nusantararitel.co.id', phone: '0813-8001-1004', role: 'employee', department: 'Operasional Toko', position: 'Senior Store Crew', base_salary: 6200000, daily_allowance: 45000, fixed_deduction: 140000, leave_balance: 12, bound_device_hash: null, is_active: true },
    { id: '44444444-4444-4444-8444-444444444405', company_id: COMPANY_ID, branch_id: jktId, employee_code: 'EMP-005', full_name: 'Nadia Kusuma', email: 'nadia.kusuma@nusantararitel.co.id', phone: '0813-8001-1005', role: 'employee', department: 'Kasir & POS', position: 'Lead Cashier', base_salary: 5400000, daily_allowance: 40000, fixed_deduction: 120000, leave_balance: 9, bound_device_hash: 'dev_e210b44318ad', is_active: true },
    { id: '44444444-4444-4444-8444-444444444406', company_id: COMPANY_ID, branch_id: jktId, employee_code: 'EMP-006', full_name: 'Fajar Nugroho', email: 'fajar.nugroho@nusantararitel.co.id', phone: '0813-8001-1006', role: 'employee', department: 'Keamanan & Malam', position: 'Night Shift Lead', base_salary: 5200000, daily_allowance: 45000, fixed_deduction: 120000, leave_balance: 12, bound_device_hash: 'dev_99a3f11200ce', is_active: true },
    { id: '44444444-4444-4444-8444-444444444407', company_id: COMPANY_ID, branch_id: jktId, employee_code: 'EMP-007', full_name: 'Sinta Rahmawati', email: 'sinta.rahmawati@nusantararitel.co.id', phone: '0813-8001-1007', role: 'employee', department: 'Finance & Admin', position: 'Accounting Staff', base_salary: 7100000, daily_allowance: 50000, fixed_deduction: 165000, leave_balance: 11, bound_device_hash: 'dev_42fe0981ba11', is_active: true },
    { id: '44444444-4444-4444-8444-444444444408', company_id: COMPANY_ID, branch_id: jktId, employee_code: 'EMP-008', full_name: 'Bagas Saputra', email: 'bagas.saputra@nusantararitel.co.id', phone: '0813-8001-1008', role: 'employee', department: 'IT & Support', position: 'POS Systems Engineer', base_salary: 7800000, daily_allowance: 50000, fixed_deduction: 180000, leave_balance: 12, bound_device_hash: 'dev_661ab90877cd', is_active: true },
    { id: '44444444-4444-4444-8444-444444444409', company_id: COMPANY_ID, branch_id: jktId, employee_code: 'EMP-009', full_name: 'Putri Maharani', email: 'putri.maharani@nusantararitel.co.id', phone: '0813-8001-1009', role: 'employee', department: 'Kasir & POS', position: 'Cashier Staff', base_salary: 5300000, daily_allowance: 40000, fixed_deduction: 120000, leave_balance: 10, bound_device_hash: 'dev_109f22cd440a', is_active: true },
    { id: '44444444-4444-4444-8444-444444444410', company_id: COMPANY_ID, branch_id: jktId, employee_code: 'EMP-010', full_name: 'Arif Setiawan', email: 'arif.setiawan@nusantararitel.co.id', phone: '0813-8001-1010', role: 'employee', department: 'Gudang & Logistik', position: 'Inventory Dispatcher', base_salary: 5600000, daily_allowance: 45000, fixed_deduction: 125000, leave_balance: 8, bound_device_hash: 'dev_5540de1189fa', is_active: true },
    { id: '44444444-4444-4444-8444-444444444411', company_id: COMPANY_ID, branch_id: dpkId, employee_code: 'EMP-011', full_name: 'Maya Puspita', email: 'maya.puspita@nusantararitel.co.id', phone: '0815-8001-1011', role: 'employee', department: 'Operasional Toko', position: 'Store Crew Depok', base_salary: 5800000, daily_allowance: 45000, fixed_deduction: 130000, leave_balance: 12, bound_device_hash: 'dev_ab2301ff884c', is_active: true },
    { id: '44444444-4444-4444-8444-444444444412', company_id: COMPANY_ID, branch_id: dpkId, employee_code: 'EMP-012', full_name: 'Eko Prasetyo', email: 'eko.prasetyo@nusantararitel.co.id', phone: '0815-8001-1012', role: 'employee', department: 'Gudang & Logistik', position: 'Warehouse Operator', base_salary: 5500000, daily_allowance: 45000, fixed_deduction: 125000, leave_balance: 10, bound_device_hash: 'dev_7721aa09cc12', is_active: true },
    { id: '44444444-4444-4444-8444-444444444413', company_id: COMPANY_ID, branch_id: dpkId, employee_code: 'EMP-013', full_name: 'Dewi Lestari', email: 'dewi.lestari@nusantararitel.co.id', phone: '0815-8001-1013', role: 'employee', department: 'Kasir & POS', position: 'Cashier Depok', base_salary: 5100000, daily_allowance: 40000, fixed_deduction: 115000, leave_balance: 11, bound_device_hash: 'dev_3019be4412aa', is_active: true },
    { id: '44444444-4444-4444-8444-444444444414', company_id: COMPANY_ID, branch_id: dpkId, employee_code: 'EMP-014', full_name: 'Yoga Permana', email: 'yoga.permana@nusantararitel.co.id', phone: '0815-8001-1014', role: 'employee', department: 'Keamanan & Malam', position: 'Night Security Depok', base_salary: 5200000, daily_allowance: 45000, fixed_deduction: 120000, leave_balance: 12, bound_device_hash: 'dev_8800cd2143ef', is_active: true },
    { id: '44444444-4444-4444-8444-444444444415', company_id: COMPANY_ID, branch_id: dpkId, employee_code: 'EMP-015', full_name: 'Tari Wulandari', email: 'tari.wulandari@nusantararitel.co.id', phone: '0815-8001-1015', role: 'employee', department: 'Operasional Toko', position: 'Visual Merchandiser', base_salary: 5900000, daily_allowance: 45000, fixed_deduction: 135000, leave_balance: 9, bound_device_hash: 'dev_4488fe1092bd', is_active: true },
    { id: '44444444-4444-4444-8444-444444444416', company_id: COMPANY_ID, branch_id: dpkId, employee_code: 'EMP-016', full_name: 'Ilham Ramadhan', email: 'ilham.ramadhan@nusantararitel.co.id', phone: '0815-8001-1016', role: 'employee', department: 'Gudang & Logistik', position: 'Field Courier Lead', base_salary: 5700000, daily_allowance: 45000, fixed_deduction: 130000, leave_balance: 12, bound_device_hash: 'dev_5190cc32ab01', is_active: true },
    { id: '44444444-4444-4444-8444-444444444417', company_id: COMPANY_ID, branch_id: jktId, employee_code: 'EMP-017', full_name: 'Citra Ayu', email: 'citra.ayu@nusantararitel.co.id', phone: '0812-8001-1017', role: 'employee', department: 'Finance & Admin', position: 'Payroll Specialist', base_salary: 6900000, daily_allowance: 50000, fixed_deduction: 155000, leave_balance: 12, bound_device_hash: 'dev_2091ef7780ca', is_active: true },
    { id: '44444444-4444-4444-8444-444444444418', company_id: COMPANY_ID, branch_id: dpkId, employee_code: 'EMP-018', full_name: 'Andi Kurniawan', email: 'andi.kurniawan@nusantararitel.co.id', phone: '0815-8001-1018', role: 'employee', department: 'IT & Support', position: 'Branch Tech Support', base_salary: 7200000, daily_allowance: 50000, fixed_deduction: 165000, leave_balance: 10, bound_device_hash: 'dev_9012aa4510de', is_active: true }
  ];

  const schedules = [];
  const attendance_logs = [];
  let seq = 1;

  for (const emp of profiles) {
    const branch = branches.find((b) => b.id === emp.branch_id);
    for (let offset = -29; offset <= 0; offset += 1) {
      const workDate = addDays(todayStr, offset);
      const isoDay = getIsoWeekday(workDate);

      let shiftId = shifts[0].id;
      if (emp.employee_code === 'EMP-006' || emp.employee_code === 'EMP-014') {
        shiftId = shifts[2].id;
      } else if (['EMP-005', 'EMP-009', 'EMP-013', 'EMP-015'].includes(emp.employee_code)) {
        shiftId = shifts[1].id;
      }

      let workMode = 'WFO';
      if ((shiftId === shifts[2].id && isoDay === 2) || (shiftId !== shifts[2].id && isoDay === 7)) {
        workMode = 'OFF';
      } else if (emp.employee_code === 'EMP-008' && (isoDay === 3 || isoDay === 5)) {
        workMode = 'WFH';
      } else if (emp.employee_code === 'EMP-016' && (isoDay === 2 || isoDay === 4)) {
        workMode = 'FIELD';
      }

      const schedId = `66666666-6666-4666-8666-${String(seq).padStart(12, '0')}`;
      seq += 1;
      schedules.push({
        id: schedId,
        company_id: COMPANY_ID,
        employee_id: emp.id,
        shift_id: shiftId,
        work_date: workDate,
        work_mode: workMode
      });

      // Keep EMP-013 absent today (Alpha) & EMP-009 on approved leave today
      if (workMode === 'OFF') continue;
      if (offset === 0 && (emp.employee_code === 'EMP-013' || emp.employee_code === 'EMP-009')) continue;
      // Leave EMP-004 (default demo employee) NOT yet clocked in today so user can immediately test live Clock In!
      if (offset === 0 && emp.employee_code === 'EMP-004') continue;
      // Night shift today starts at 22:00
      if (offset === 0 && shiftId === shifts[2].id) continue;

      let clockInAt;
      let clockOutAt = null;
      let lateMinutes = 0;
      let overtimeMinutes = 0;
      let workDurationMinutes = 0;
      let status = 'ON_TIME';

      if (shiftId === shifts[2].id) {
        clockInAt = wibIso(workDate, '21:54:00');
        overtimeMinutes = Math.abs(offset) % 3 === 0 ? 45 : 15;
        const nextDate = addDays(workDate, 1);
        const outHour = overtimeMinutes >= 45 ? '06:45:00' : '06:15:00';
        clockOutAt = wibIso(nextDate, outHour);
        workDurationMinutes = Math.round((new Date(clockOutAt) - new Date(clockInAt)) / 60000);
      } else if (shiftId === shifts[1].id) {
        if (Math.abs(offset) % 5 === 0 && ['EMP-005', 'EMP-015'].includes(emp.employee_code)) {
          lateMinutes = 22;
          clockInAt = wibIso(workDate, '14:37:00');
          status = 'LATE';
        } else {
          clockInAt = wibIso(workDate, '13:52:00');
        }
        if (offset < 0) {
          overtimeMinutes = 10;
          clockOutAt = wibIso(workDate, '22:10:00');
          workDurationMinutes = Math.round((new Date(clockOutAt) - new Date(clockInAt)) / 60000);
        }
      } else {
        if ((offset === 0 && emp.employee_code === 'EMP-011') || (Math.abs(offset) % 6 === 0 && emp.employee_code === 'EMP-010')) {
          lateMinutes = 18;
          clockInAt = wibIso(workDate, '08:33:00');
          status = 'LATE';
        } else {
          clockInAt = wibIso(workDate, '07:49:00');
          if (workMode === 'WFH') status = 'WFH';
          else if (workMode === 'FIELD') status = 'FIELD';
        }
        if (offset < 0) {
          overtimeMinutes = ['EMP-004', 'EMP-007', 'EMP-016'].includes(emp.employee_code) && Math.abs(offset) % 2 === 0 ? 90 : 0;
          clockOutAt = wibIso(workDate, overtimeMinutes === 90 ? '18:30:00' : '17:00:00');
          workDurationMinutes = Math.round((new Date(clockOutAt) - new Date(clockInAt)) / 60000);
        }
      }

      let isFlagged = false;
      let flagReason = null;
      let lat = branch.latitude + (Math.abs(offset) % 5) * 0.00011;
      let lon = branch.longitude + (Math.abs(offset) % 4) * 0.0001;
      let acc = 14.2;
      let dist = 22 + ((emp.employee_code.charCodeAt(6) + Math.abs(offset)) % 78);
      let notes = workMode === 'FIELD' ? 'Pengiriman & audit stok vendor Jabodetabek' : '';

      // Inject 2 realistic fraud flag cases
      if (emp.employee_code === 'EMP-010' && offset === -1) {
        isFlagged = true;
        flagReason = 'IMPOSSIBLE_TRAVEL_SPEED_412kmh';
        lat = -6.917464;
        lon = 107.619123;
        acc = 42.0;
        dist = 118400;
        notes = 'Anomali koordinat terdeteksi melompat ke Bandung dalam waktu singkat';
      } else if (emp.employee_code === 'EMP-012' && offset === -2) {
        isFlagged = true;
        flagReason = 'MOCK_GPS_ZERO_ACCURACY';
        acc = 0;
        notes = 'Akurasi GPS = 0m mengindikasikan aplikasi Mock Location / Fake GPS';
      }

      attendance_logs.push({
        id: `77777777-7777-4777-8777-${String(seq).padStart(12, '0')}`,
        company_id: COMPANY_ID,
        employee_id: emp.id,
        branch_id: emp.branch_id,
        schedule_id: schedId,
        work_date: workDate,
        work_mode: workMode,
        clock_in_at: clockInAt,
        clock_out_at: clockOutAt,
        clock_in_lat: lat,
        clock_in_lon: lon,
        clock_in_accuracy_m: acc,
        clock_in_distance_m: dist,
        clock_out_lat: clockOutAt ? branch.latitude : null,
        clock_out_lon: clockOutAt ? branch.longitude : null,
        clock_out_accuracy_m: clockOutAt ? 15.0 : null,
        clock_out_distance_m: clockOutAt ? dist : null,
        clock_in_photo_url: `demo://watermark/${emp.employee_code}/${workDate}`,
        clock_out_photo_url: clockOutAt ? `demo://watermark/${emp.employee_code}/${workDate}-out` : null,
        status,
        late_minutes: lateMinutes,
        overtime_minutes: overtimeMinutes,
        work_duration_minutes: workDurationMinutes,
        is_flagged: isFlagged,
        flag_reason: flagReason,
        flag_reviewed_by: null,
        flag_reviewed_at: null,
        device_hash: emp.bound_device_hash || 'dev_unbound_demo',
        verification_method: workMode === 'FIELD' ? 'FIELD_GPS' : Math.abs(offset) % 4 === 0 ? 'KIOSK_QR' : 'GPS_SELFIE',
        notes
      });
    }
  }

  const requests = [
    {
      id: '55555555-5555-4555-8555-555555555501',
      company_id: COMPANY_ID,
      employee_id: '44444444-4444-4444-8444-444444444409',
      target_employee_id: null,
      type: 'LEAVE',
      start_date: todayStr,
      end_date: addDays(todayStr, 1),
      hours_requested: 0,
      reason: 'Cuti tahunan keperluan keluarga di Yogyakarta',
      attachment_url: null,
      status: 'approved',
      supervisor_id: '44444444-4444-4444-8444-444444444402',
      supervisor_action_at: new Date(Date.now() - 172800000).toISOString(),
      approved_by: '44444444-4444-4444-8444-444444444401',
      hr_action_at: new Date(Date.now() - 86400000).toISOString(),
      created_at: new Date(Date.now() - 259200000).toISOString()
    },
    {
      id: '55555555-5555-4555-8555-555555555502',
      company_id: COMPANY_ID,
      employee_id: '44444444-4444-4444-8444-444444444411',
      target_employee_id: null,
      type: 'OVERTIME',
      start_date: todayStr,
      end_date: todayStr,
      hours_requested: 3,
      reason: 'Stock opname akhir periode di Cabang Margonda Depok',
      attachment_url: null,
      status: 'pending_supervisor',
      supervisor_id: null,
      supervisor_action_at: null,
      approved_by: null,
      hr_action_at: null,
      created_at: new Date(Date.now() - 7200000).toISOString()
    },
    {
      id: '55555555-5555-4555-8555-555555555503',
      company_id: COMPANY_ID,
      employee_id: '44444444-4444-4444-8444-444444444405',
      target_employee_id: '44444444-4444-4444-8444-444444444409',
      type: 'SHIFT_SWAP',
      start_date: addDays(todayStr, 2),
      end_date: addDays(todayStr, 2),
      hours_requested: 0,
      reason: 'Tukar shift siang ke shift pagi karena jadwal kontrol klinik',
      attachment_url: null,
      status: 'pending_hr',
      supervisor_id: '44444444-4444-4444-8444-444444444402',
      supervisor_action_at: new Date(Date.now() - 14400000).toISOString(),
      approved_by: null,
      hr_action_at: null,
      created_at: new Date(Date.now() - 28800000).toISOString()
    },
    {
      id: '55555555-5555-4555-8555-555555555504',
      company_id: COMPANY_ID,
      employee_id: '44444444-4444-4444-8444-444444444415',
      target_employee_id: null,
      type: 'SICK',
      start_date: addDays(todayStr, 1),
      end_date: addDays(todayStr, 1),
      hours_requested: 0,
      reason: 'Demam tinggi, surat keterangan dokter klinik terlampir',
      attachment_url: 'demo://attachment/surat-dokter-tari.pdf',
      status: 'pending_supervisor',
      supervisor_id: null,
      supervisor_action_at: null,
      approved_by: null,
      hr_action_at: null,
      created_at: new Date(Date.now() - 3600000).toISOString()
    }
  ];

  const payrolls = profiles.map((emp) => {
    const otMins = ['EMP-006', 'EMP-014'].includes(emp.employee_code) ? 360 : 180;
    const lateMins = ['EMP-004', 'EMP-010'].includes(emp.employee_code) ? 35 : 0;
    const wfoDays = 22;
    const allowances = wfoDays * emp.daily_allowance;
    const otPay = Math.round(((otMins / 60) * 1.5 * (emp.base_salary / 173)) * 100) / 100;
    const lateDed = lateMins * 1500;
    const net = Math.max(0, Math.round((emp.base_salary + allowances + otPay - lateDed - emp.fixed_deduction) * 100) / 100);
    return {
      id: `88888888-8888-4888-8888-${emp.id.slice(-12)}`,
      company_id: COMPANY_ID,
      employee_id: emp.id,
      period_month: prevYm.month,
      period_year: prevYm.year,
      total_present: 24,
      total_wfo_days: wfoDays,
      total_late_minutes: lateMins,
      total_overtime_minutes: otMins,
      total_absent_days: 0,
      base_salary: emp.base_salary,
      allowances_total: allowances,
      overtime_pay: otPay,
      deductions_total: lateDed,
      fixed_deductions: emp.fixed_deduction,
      net_salary: net,
      reference_no: `PAY-${prevYm.year}${String(prevYm.month).padStart(2, '0')}-${emp.employee_code}`,
      status: 'FINALIZED',
      ledger_transaction_id: null,
      ledger_posted_at: null,
      generated_by: '44444444-4444-4444-8444-444444444401',
      generated_at: new Date(Date.now() - 1296000000).toISOString()
    };
  });

  const ledger_batches = [];
  const employee_invites = [];

  return { companies, branches, shifts, profiles, schedules, attendance_logs, requests, payrolls, ledger_batches, employee_invites };
}

class DemoEngine {
  constructor() {
    this.state = this.loadState();
    this.currentUserId = safeStorageGet('vectra_demo_user_id') || '44444444-4444-4444-8444-444444444401';
  }

  loadState() {
    try {
      const raw = safeStorageGet(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const valid = parsed
          && Array.isArray(parsed.companies) && parsed.companies.length > 0
          && Array.isArray(parsed.branches) && parsed.branches.length > 0
          && Array.isArray(parsed.shifts) && parsed.shifts.length > 0
          && Array.isArray(parsed.profiles) && parsed.profiles.length > 0
          && Array.isArray(parsed.schedules)
          && Array.isArray(parsed.attendance_logs)
          && Array.isArray(parsed.requests)
          && Array.isArray(parsed.payrolls);
        if (valid) {
          if (!Array.isArray(parsed.ledger_batches)) parsed.ledger_batches = [];
          if (!Array.isArray(parsed.employee_invites)) parsed.employee_invites = [];
          return parsed;
        }
      }
    } catch {
      // Rebuild fresh demo state on parse error
    }
    const fresh = buildInitialDemoData();
    this.saveState(fresh);
    return fresh;
  }

  saveState(nextState = this.state) {
    this.state = nextState;
    safeStorageSet(STORAGE_KEY, JSON.stringify(this.state));
  }

  resetDemoState() {
    const fresh = buildInitialDemoData();
    this.saveState(fresh);
    return fresh;
  }

  setSessionByRole(role) {
    const roleMap = {
      company_admin: '44444444-4444-4444-8444-444444444401',
      supervisor: '44444444-4444-4444-8444-444444444402',
      employee: '44444444-4444-4444-8444-444444444404',
      super_admin: '44444444-4444-4444-8444-444444444401'
    };
    const id = roleMap[role] || roleMap.company_admin;
    this.currentUserId = id;
    safeStorageSet('vectra_demo_user_id', id);
    safeStorageSet('vectra_demo_role_override', role);
    return this.getCurrentProfile();
  }

  setCurrentUserById(userId) {
    const found = this.state.profiles.find((p) => p.id === userId);
    if (!found) return null;
    this.currentUserId = found.id;
    safeStorageSet('vectra_demo_user_id', found.id);
    safeStorageSet('vectra_demo_role_override', found.role);
    return { ...found };
  }

  getCurrentProfile() {
    const profile = this.state.profiles.find((p) => p.id === this.currentUserId) || this.state.profiles[0];
    const overrideRole = safeStorageGet('vectra_demo_role_override');
    if (overrideRole === 'super_admin') {
      return { ...profile, role: 'super_admin' };
    }
    return { ...profile };
  }

  // ---- Query Helpers ----
  getAllDataForCompany(companyId = COMPANY_ID) {
    return {
      company: this.state.companies.find((c) => c.id === companyId) || this.state.companies[0],
      companies: [...this.state.companies],
      branches: this.state.branches.filter((b) => b.company_id === companyId),
      shifts: this.state.shifts.filter((s) => s.company_id === companyId),
      profiles: this.state.profiles.filter((p) => p.company_id === companyId),
      schedules: this.state.schedules.filter((s) => s.company_id === companyId),
      attendance_logs: this.state.attendance_logs.filter((a) => a.company_id === companyId),
      requests: this.state.requests.filter((r) => r.company_id === companyId),
      payrolls: this.state.payrolls.filter((p) => p.company_id === companyId),
      ledger_batches: (this.state.ledger_batches || []).filter((b) => b.company_id === companyId),
      employee_invites: (this.state.employee_invites || []).filter((i) => i.company_id === companyId)
    };
  }

  // ---- RPC: get_dashboard_kpis ----
  async getDashboardKpis({ companyId = COMPANY_ID, branchId = null, department = null, shiftId = null, startDate = null, endDate = null } = {}) {
    const today = getJakartaDateStr(0);
    const start = startDate || today;
    const end = endDate || today;
    const monthPrefix = today.slice(0, 7);

    const caller = this.getCurrentProfile();
    const effectiveBranch = caller.role === 'supervisor' ? caller.branch_id : branchId;

    const activeEmployees = this.state.profiles.filter((p) =>
      p.company_id === companyId &&
      p.is_active &&
      (!effectiveBranch || p.branch_id === effectiveBranch) &&
      (!department || p.department === department)
    );
    const empMap = new Map(activeEmployees.map((p) => [p.id, p]));
    const schedMap = new Map(this.state.schedules.map((s) => [s.id, s]));

    const logsInRange = this.state.attendance_logs.filter((l) => {
      const emp = empMap.get(l.employee_id);
      if (!emp) return false;
      if (l.work_date < start || l.work_date > end) return false;
      if (shiftId) {
        const sch = schedMap.get(l.schedule_id);
        if (!sch || sch.shift_id !== shiftId) return false;
      }
      return true;
    });

    const presentUnique = new Set(logsInRange.filter((l) => l.status !== 'ABSENT').map((l) => l.employee_id)).size;
    const lateToday = logsInRange.filter((l) => l.status === 'LATE').length;
    const wfhFieldToday = logsInRange.filter((l) => l.work_mode === 'WFH' || l.work_mode === 'FIELD').length;
    const overtimeCount = logsInRange.filter((l) => (l.overtime_minutes || 0) > 0).length;

    const approvedLeaveEmployees = new Set(
      this.state.requests
        .filter((r) => r.company_id === companyId && r.status === 'approved' && (r.type === 'LEAVE' || r.type === 'SICK') && r.start_date <= end && r.end_date >= start && empMap.has(r.employee_id))
        .map((r) => r.employee_id)
    );

    const endCap = end > today ? today : end;
    const absentToday = this.state.schedules.filter((sch) => {
      if (!empMap.has(sch.employee_id)) return false;
      if (sch.work_mode === 'OFF') return false;
      if (sch.work_date < start || sch.work_date > endCap) return false;
      if (shiftId && sch.shift_id !== shiftId) return false;
      const hasLog = this.state.attendance_logs.some((l) => l.employee_id === sch.employee_id && l.work_date === sch.work_date);
      if (hasLog) return false;
      const onLeave = this.state.requests.some(
        (r) => r.employee_id === sch.employee_id && r.status === 'approved' && (r.type === 'LEAVE' || r.type === 'SICK') && sch.work_date >= r.start_date && sch.work_date <= r.end_date
      );
      return !onLeave;
    }).length;

    const pendingApprovals = this.state.requests.filter(
      (r) => r.company_id === companyId && (r.status === 'pending_supervisor' || r.status === 'pending_hr') && empMap.has(r.employee_id)
    ).length;

    const fraudFlagsCount = this.state.attendance_logs.filter(
      (l) => l.company_id === companyId && l.is_flagged && !l.flag_reviewed_at && empMap.has(l.employee_id)
    ).length;

    const monthLogs = this.state.attendance_logs.filter(
      (l) => l.company_id === companyId && l.work_date.startsWith(monthPrefix) && empMap.has(l.employee_id)
    );
    const totalWorkHoursMonth = Math.round((monthLogs.reduce((acc, l) => acc + (l.work_duration_minutes || 0), 0) / 60) * 10) / 10;
    const estOvertimePay = Math.round(
      monthLogs.reduce((acc, l) => {
        const emp = empMap.get(l.employee_id);
        return acc + ((l.overtime_minutes || 0) / 60) * 1.5 * ((emp?.base_salary || 0) / 173);
      }, 0)
    );
    const estPayrollTotal = Math.round(activeEmployees.reduce((acc, e) => acc + (e.base_salary || 0), 0) + estOvertimePay);

    return {
      total_active_employees: activeEmployees.length,
      present_today: presentUnique,
      attendance_rate_pct: activeEmployees.length > 0 ? Math.round((presentUnique / activeEmployees.length) * 1000) / 10 : 0,
      late_today: lateToday,
      absent_today: absentToday,
      currently_overtime: overtimeCount,
      active_leave_today: approvedLeaveEmployees.size,
      wfh_field_today: wfhFieldToday,
      pending_approvals: pendingApprovals,
      fraud_flags_count: fraudFlagsCount,
      total_work_hours_month: totalWorkHoursMonth,
      estimated_overtime_pay: estOvertimePay,
      estimated_payroll_total: estPayrollTotal,
      server_time: new Date().toISOString()
    };
  }

  // ---- RPC: submit_clock_in ----
  async submitClockIn({ lat, lon, accuracy_m, device_hash, photo_url, work_mode = 'WFO', verification_method = 'GPS_SELFIE', notes = '', qr_payload = null }) {
    const now = new Date();
    const todayStr = getJakartaDateStr(0);
    const profileIdx = this.state.profiles.findIndex((p) => p.id === this.currentUserId);
    if (profileIdx === -1) {
      return { success: false, code: 'INACTIVE_PROFILE', message: 'Profil karyawan tidak ditemukan.' };
    }
    const profile = this.state.profiles[profileIdx];

    if (!device_hash || device_hash.length < 8) {
      return { success: false, code: 'INVALID_DEVICE', message: 'Device fingerprint hash tidak valid.' };
    }

    if (!photo_url || !String(photo_url).trim()) {
      return { success: false, code: 'PHOTO_REQUIRED', message: 'Bukti foto kamera live wajib dilampirkan.' };
    }

    if (!profile.bound_device_hash) {
      profile.bound_device_hash = device_hash;
      profile.device_bound_at = now.toISOString();
    } else if (profile.bound_device_hash !== device_hash) {
      return {
        success: false,
        code: 'DEVICE_MISMATCH',
        message: 'Perangkat berbeda terdeteksi! Akses absensi diblokir sampai HRD melakukan reset Device Binding.'
      };
    }

    const openLog = this.state.attendance_logs.find((l) => l.employee_id === profile.id && !l.clock_out_at);
    if (openLog) {
      return { success: false, code: 'ALREADY_CLOCKED_IN', message: 'Anda masih memiliki sesi aktif yang belum Clock Out.' };
    }

    const branch = this.state.branches.find((b) => b.id === profile.branch_id);
    if (verification_method === 'KIOSK_QR') {
      if (!branch) {
        return { success: false, code: 'BRANCH_REQUIRED', message: 'Cabang belum terdaftar untuk verifikasi QR Kiosk.' };
      }
      const qrCheck = await verifyRotatingQrPayload(qr_payload, branch.qr_secret_key, branch.code, now.getTime());
      if (!qrCheck.valid) {
        return { success: false, code: 'KIOSK_QR_INVALID', message: qrCheck.reason || 'Token QR Kiosk tidak valid atau kedaluwarsa.' };
      }
    }

    const distanceM = branch ? calculateHaversineDistance(lat, lon, branch.latitude, branch.longitude) : null;

    if (work_mode === 'WFO' && branch) {
      if (distanceM === null) {
        return { success: false, code: 'GPS_REQUIRED', message: 'Koordinat GPS wajib tersedia untuk absensi WFO.' };
      }
      if (distanceM > branch.radius_meters) {
        return {
          success: false,
          code: 'OUT_OF_GEOFENCE',
          distance_m: distanceM,
          radius_meters: branch.radius_meters,
          message: `Anda berada ${Math.round(distanceM)}m dari ${branch.name} (maksimal ${branch.radius_meters}m). Pilih mode Dinas Luar jika bertugas di lapangan.`
        };
      }
    }

    if (work_mode === 'FIELD' && String(notes || '').trim().length < 5) {
      return { success: false, code: 'FIELD_NOTES_REQUIRED', message: 'Mode Dinas Luar wajib menyertakan keterangan tugas minimal 5 karakter.' };
    }

    const prevLog = [...this.state.attendance_logs]
      .filter((l) => l.employee_id === profile.id)
      .sort((a, b) => new Date(b.clock_out_at || b.clock_in_at) - new Date(a.clock_out_at || a.clock_in_at))[0];

    const integrity = evaluateGpsIntegrity({ lat, lon, accuracy: accuracy_m }, prevLog, now);

    // Resolve schedule (today or yesterday cross-day within shift end window, ascending date order)
    const yesterdayStr = getJakartaDateStr(-1);
    const wibTimeStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(now);
    const matchedSchedule = [...this.state.schedules]
      .sort((a, b) => a.work_date.localeCompare(b.work_date))
      .find((sch) => {
        if (sch.employee_id !== profile.id || sch.work_mode === 'OFF') return false;
        const alreadyUsed = this.state.attendance_logs.some((l) => l.employee_id === profile.id && l.schedule_id === sch.id);
        if (alreadyUsed) return false;
        if (sch.work_date === todayStr) return true;
        if (sch.work_date === yesterdayStr) {
          const shift = this.state.shifts.find((s) => s.id === sch.shift_id);
          return Boolean(shift?.is_cross_day && wibTimeStr <= shift.end_time);
        }
        return false;
      });

    let lateMinutes = 0;
    if (matchedSchedule) {
      const shift = this.state.shifts.find((s) => s.id === matchedSchedule.shift_id);
      if (shift) {
        const shiftStart = new Date(`${matchedSchedule.work_date}T${shift.start_time}+07:00`);
        const graceCutoff = new Date(shiftStart.getTime() + (shift.grace_period_minutes || 0) * 60000);
        if (now > graceCutoff) {
          lateMinutes = Math.max(1, Math.floor((now.getTime() - graceCutoff.getTime()) / 60000));
        }
      }
    }

    let status = 'ON_TIME';
    if (work_mode === 'WFH') status = 'WFH';
    else if (work_mode === 'FIELD') status = 'FIELD';
    else if (lateMinutes > 0) status = 'LATE';

    const logId = `log_demo_${Date.now()}`;
    const newLog = {
      id: logId,
      company_id: profile.company_id,
      employee_id: profile.id,
      branch_id: profile.branch_id,
      schedule_id: matchedSchedule?.id || null,
      work_date: matchedSchedule?.work_date || todayStr,
      work_mode,
      clock_in_at: now.toISOString(),
      clock_out_at: null,
      clock_in_lat: lat,
      clock_in_lon: lon,
      clock_in_accuracy_m: accuracy_m,
      clock_in_distance_m: distanceM,
      clock_out_lat: null,
      clock_out_lon: null,
      clock_out_accuracy_m: null,
      clock_out_distance_m: null,
      clock_in_photo_url: photo_url,
      clock_out_photo_url: null,
      status,
      late_minutes: lateMinutes,
      overtime_minutes: 0,
      work_duration_minutes: 0,
      is_flagged: integrity.isFlagged,
      flag_reason: integrity.reasons.length ? integrity.reasons.join(', ') : null,
      flag_reviewed_by: null,
      flag_reviewed_at: null,
      device_hash,
      verification_method,
      notes: notes || ''
    };

    this.state.attendance_logs.unshift(newLog);
    this.saveState();

    return {
      success: true,
      log_id: logId,
      server_time: now.toISOString(),
      work_date: newLog.work_date,
      status,
      late_minutes: lateMinutes,
      distance_m: distanceM,
      is_flagged: newLog.is_flagged,
      flag_reason: newLog.flag_reason
    };
  }

  // ---- RPC: submit_clock_out ----
  async submitClockOut({ lat, lon, accuracy_m, device_hash, photo_url, notes = '' }) {
    const now = new Date();
    const profile = this.getCurrentProfile();

    if (profile.bound_device_hash && profile.bound_device_hash !== device_hash) {
      return { success: false, code: 'DEVICE_MISMATCH', message: 'Device fingerprint tidak cocok saat Clock Out.' };
    }

    const logIdx = this.state.attendance_logs.findIndex((l) => l.employee_id === profile.id && !l.clock_out_at);
    if (logIdx === -1) {
      return { success: false, code: 'NO_OPEN_SESSION', message: 'Tidak ada sesi Clock In aktif.' };
    }

    const log = this.state.attendance_logs[logIdx];
    const branch = this.state.branches.find((b) => b.id === log.branch_id);
    const distanceM = branch ? calculateHaversineDistance(lat, lon, branch.latitude, branch.longitude) : null;

    const integrity = evaluateGpsIntegrity({ lat, lon, accuracy: accuracy_m }, log, now);
    const durationMins = Math.max(0, Math.floor((now.getTime() - new Date(log.clock_in_at).getTime()) / 60000));
    let overtimeMins = 0;
    let nextStatus = log.status;

    if (log.schedule_id) {
      const sch = this.state.schedules.find((s) => s.id === log.schedule_id);
      const shift = sch ? this.state.shifts.find((s) => s.id === sch.shift_id) : null;
      if (shift) {
        const endDate = shift.is_cross_day || shift.end_time <= shift.start_time ? addDays(log.work_date, 1) : log.work_date;
        const shiftEndTs = new Date(`${endDate}T${shift.end_time}+07:00`);
        if (now > shiftEndTs) {
          overtimeMins = Math.floor((now.getTime() - shiftEndTs.getTime()) / 60000);
        } else if (now.getTime() < shiftEndTs.getTime() - 15 * 60000 && log.status === 'ON_TIME') {
          nextStatus = 'EARLY_LEAVE';
        }
      }
    } else if (durationMins > 480) {
      overtimeMins = durationMins - 480;
    }

    const existingFlags = log.flag_reason ? log.flag_reason.split(', ') : [];
    const combinedFlags = [...new Set([...existingFlags, ...integrity.reasons])];

    this.state.attendance_logs[logIdx] = {
      ...log,
      clock_out_at: now.toISOString(),
      clock_out_lat: lat,
      clock_out_lon: lon,
      clock_out_accuracy_m: accuracy_m,
      clock_out_distance_m: distanceM,
      clock_out_photo_url: photo_url,
      work_duration_minutes: durationMins,
      overtime_minutes: overtimeMins,
      status: nextStatus,
      is_flagged: log.is_flagged || integrity.isFlagged,
      flag_reason: combinedFlags.length ? combinedFlags.join(', ') : null,
      notes: notes ? `${log.notes ? `${log.notes} | ` : ''}Out: ${notes}` : log.notes
    };

    this.saveState();

    return {
      success: true,
      log_id: log.id,
      server_time: now.toISOString(),
      work_duration_minutes: durationMins,
      overtime_minutes: overtimeMins,
      status: nextStatus,
      distance_m: distanceM,
      is_flagged: this.state.attendance_logs[logIdx].is_flagged
    };
  }

  // ---- RPC: generate_monthly_payroll ----
  async generateMonthlyPayroll(companyId, month, year) {
    const company = this.state.companies.find((c) => c.id === companyId) || this.state.companies[0];
    const ymPrefix = `${year}-${String(month).padStart(2, '0')}`;
    const todayStr = getJakartaDateStr(0);
    const activeEmps = this.state.profiles.filter((p) => p.company_id === companyId && p.is_active);
    let processed = 0;
    let totalPayout = 0;

    for (const emp of activeEmps) {
      const existingLocked = this.state.payrolls.find(
        (p) => p.company_id === companyId && p.employee_id === emp.id && p.period_month === month && p.period_year === year && (p.status === 'PAID' || p.status === 'FINALIZED' || p.ledger_transaction_id)
      );
      if (existingLocked) {
        processed += 1;
        totalPayout += Number(existingLocked.net_salary || 0);
        continue;
      }

      const empLogs = this.state.attendance_logs.filter(
        (l) => l.company_id === companyId && l.employee_id === emp.id && l.work_date.startsWith(ymPrefix) && l.status !== 'ABSENT' && (!l.is_flagged || l.flag_reviewed_at)
      );

      const presentDates = new Set(empLogs.map((l) => l.work_date));
      const wfoDates = new Set(empLogs.filter((l) => l.work_mode === 'WFO').map((l) => l.work_date));
      const lateMins = empLogs.reduce((acc, l) => acc + (l.late_minutes || 0), 0);
      const otMins = empLogs.reduce((acc, l) => acc + (l.overtime_minutes || 0), 0);

      const scheduledDates = new Set(
        this.state.schedules
          .filter((s) => s.employee_id === emp.id && s.work_date.startsWith(ymPrefix) && s.work_date <= todayStr && s.work_mode !== 'OFF')
          .map((s) => s.work_date)
      );
      const absentDays = Math.max(0, scheduledDates.size - presentDates.size);

      const hourlyRate = emp.base_salary / 173;
      const otHours = otMins / 60;
      const otPay = otHours <= 20
        ? Math.round(otHours * 1.5 * hourlyRate * 100) / 100
        : Math.round(((20 * 1.5) + (otHours - 20) * 2.0) * hourlyRate * 100) / 100;
      const allowances = wfoDates.size * emp.daily_allowance;
      const deductions = Math.round(((lateMins * (company.late_penalty_per_minute || 1500)) + (absentDays * (emp.base_salary / 22))) * 100) / 100;
      const netSalary = Math.max(0, Math.round((emp.base_salary + allowances + otPay - deductions - (emp.fixed_deduction || 0)) * 100) / 100);

      const row = {
        id: `pay_${year}${month}_${emp.employee_code}`,
        company_id: companyId,
        employee_id: emp.id,
        period_month: month,
        period_year: year,
        total_present: presentDates.size,
        total_wfo_days: wfoDates.size,
        total_late_minutes: lateMins,
        total_overtime_minutes: otMins,
        total_absent_days: absentDays,
        base_salary: emp.base_salary,
        allowances_total: allowances,
        overtime_pay: otPay,
        deductions_total: deductions,
        fixed_deductions: emp.fixed_deduction || 0,
        net_salary: netSalary,
        reference_no: `PAY-${year}${String(month).padStart(2, '0')}-${emp.employee_code}`,
        status: 'DRAFT',
        generated_by: this.currentUserId,
        generated_at: new Date().toISOString()
      };

      const idx = this.state.payrolls.findIndex(
        (p) => p.company_id === companyId && p.employee_id === emp.id && p.period_month === month && p.period_year === year
      );
      if (idx >= 0) this.state.payrolls[idx] = row;
      else this.state.payrolls.unshift(row);

      processed += 1;
      totalPayout += netSalary;
    }

    this.saveState();
    return {
      success: true,
      period_month: month,
      period_year: year,
      employees_processed: processed,
      total_net_payout: totalPayout,
      generated_at: new Date().toISOString()
    };
  }

  // ---- CRUD Mutations ----
  createEmployee(payload) {
    const id = `emp_demo_${Date.now()}`;
    const newEmp = {
      id,
      company_id: COMPANY_ID,
      branch_id: payload.branch_id,
      employee_code: payload.employee_code.trim().toUpperCase(),
      full_name: payload.full_name.trim(),
      email: payload.email.trim(),
      phone: payload.phone?.trim() || '',
      role: payload.role || 'employee',
      department: payload.department || 'Operasional Toko',
      position: payload.position || 'Staff',
      base_salary: Number(payload.base_salary || 5000000),
      daily_allowance: Number(payload.daily_allowance || 40000),
      fixed_deduction: Number(payload.fixed_deduction || 100000),
      leave_balance: Number(payload.leave_balance ?? 12),
      bound_device_hash: null,
      device_bound_at: null,
      is_active: true
    };
    this.state.profiles.unshift(newEmp);
    this.saveState();
    return newEmp;
  }

  createEmployeeInvite(payload) {
    if (!Array.isArray(this.state.employee_invites)) this.state.employee_invites = [];
    const code = String(payload.employee_code || '').trim().toUpperCase();
    const fullName = String(payload.full_name || '').trim();
    const email = String(payload.email || '').trim().toLowerCase();
    if (code.length < 2 || fullName.length < 2 || !email.includes('@')) {
      throw new Error('Lengkapi NIK, nama lengkap, dan email yang valid.');
    }
    const existingPending = this.state.employee_invites.find(
      (i) => i.company_id === COMPANY_ID && !i.accepted_at && !i.revoked_at
        && (i.email.toLowerCase() === email || i.employee_code === code)
    );
    if (existingPending) {
      throw new Error('Sudah ada undangan aktif untuk email atau NIK tersebut. Batalkan undangan lama dulu jika ingin mengirim ulang.');
    }
    const rand = new Uint8Array(12);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(rand);
    } else {
      for (let i = 0; i < rand.length; i += 1) rand[i] = Math.floor(Math.random() * 256);
    }
    const hex = Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const invite = {
      id: `inv_demo_${Date.now()}`,
      company_id: payload.company_id || COMPANY_ID,
      branch_id: payload.branch_id || null,
      invite_token: `VCT-${hex}`,
      employee_code: code,
      full_name: fullName,
      email,
      phone: String(payload.phone || '').trim(),
      role: ['company_admin', 'supervisor', 'employee'].includes(payload.role) ? payload.role : 'employee',
      department: payload.department || 'Operasional Toko',
      position: payload.position || 'Staff',
      base_salary: Number(payload.base_salary || 5000000),
      daily_allowance: Number(payload.daily_allowance || 40000),
      fixed_deduction: Number(payload.fixed_deduction || 100000),
      leave_balance: Number(payload.leave_balance ?? 12),
      invited_by: this.currentUserId,
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      accepted_at: null,
      accepted_by: null,
      revoked_at: null,
      created_at: new Date().toISOString()
    };
    this.state.employee_invites.unshift(invite);
    this.saveState();
    return invite;
  }

  revokeEmployeeInvite(inviteId) {
    if (!Array.isArray(this.state.employee_invites)) this.state.employee_invites = [];
    const idx = this.state.employee_invites.findIndex((i) => i.id === inviteId);
    if (idx === -1) throw new Error('Undangan tidak ditemukan.');
    if (this.state.employee_invites[idx].accepted_at) {
      throw new Error('Undangan yang sudah diklaim tidak dapat dibatalkan.');
    }
    this.state.employee_invites[idx].revoked_at = new Date().toISOString();
    this.saveState();
    return this.state.employee_invites[idx];
  }

  previewEmployeeInvite(inviteToken) {
    const token = String(inviteToken || '').trim().toUpperCase();
    const inv = (this.state.employee_invites || []).find((i) => i.invite_token.toUpperCase() === token);
    if (!inv) return { valid: false, reason: 'Kode undangan tidak ditemukan.' };
    if (inv.revoked_at) return { valid: false, reason: 'Undangan telah dibatalkan oleh HRD Admin.' };
    if (inv.accepted_at) return { valid: false, reason: 'Undangan sudah digunakan.' };
    if (new Date(inv.expires_at).getTime() <= Date.now()) return { valid: false, reason: 'Undangan kedaluwarsa.' };
    const company = this.state.companies.find((c) => c.id === inv.company_id);
    const branch = this.state.branches.find((b) => b.id === inv.branch_id);
    return {
      valid: true,
      company_name: company?.name || 'PT Nusantara Ritel Operasional',
      branch_name: branch?.name || 'Kantor Pusat',
      employee_code: inv.employee_code,
      full_name: inv.full_name,
      email: inv.email,
      department: inv.department,
      position: inv.position,
      role: inv.role,
      expires_at: inv.expires_at
    };
  }

  acceptEmployeeInvite(inviteToken) {
    const token = String(inviteToken || '').trim().toUpperCase();
    const idx = (this.state.employee_invites || []).findIndex((i) => i.invite_token.toUpperCase() === token);
    if (idx === -1) return { success: false, code: 'INVITE_NOT_FOUND', message: 'Kode undangan tidak ditemukan.' };
    const inv = this.state.employee_invites[idx];
    if (inv.revoked_at) return { success: false, code: 'INVITE_REVOKED', message: 'Undangan telah dibatalkan.' };
    if (inv.accepted_at) return { success: false, code: 'INVITE_USED', message: 'Undangan sudah digunakan.' };
    if (new Date(inv.expires_at).getTime() <= Date.now()) return { success: false, code: 'INVITE_EXPIRED', message: 'Undangan kedaluwarsa.' };

    const created = this.createEmployee(inv);
    this.state.employee_invites[idx].accepted_at = new Date().toISOString();
    this.state.employee_invites[idx].accepted_by = created.id;
    this.saveState();
    return { success: true, already_member: false, profile: created };
  }

  updateEmployee(id, patch) {
    const idx = this.state.profiles.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error('Karyawan tidak ditemukan.');
    this.state.profiles[idx] = { ...this.state.profiles[idx], ...patch };
    this.saveState();
    return this.state.profiles[idx];
  }

  resetDeviceBinding(employeeId) {
    return this.updateEmployee(employeeId, { bound_device_hash: null, device_bound_at: null });
  }

  saveBranch(payload) {
    if (payload.id) {
      const idx = this.state.branches.findIndex((b) => b.id === payload.id);
      if (idx >= 0) {
        this.state.branches[idx] = { ...this.state.branches[idx], ...payload };
        this.saveState();
        return this.state.branches[idx];
      }
    }
    const created = {
      id: `br_demo_${Date.now()}`,
      company_id: COMPANY_ID,
      name: payload.name,
      code: payload.code.toUpperCase(),
      address: payload.address || '',
      latitude: Number(payload.latitude),
      longitude: Number(payload.longitude),
      radius_meters: Number(payload.radius_meters || 150),
      qr_secret_key: payload.qr_secret_key || `vectra_${Math.random().toString(36).slice(2, 12)}`,
      is_active: true
    };
    this.state.branches.push(created);
    this.saveState();
    return created;
  }

  saveShift(payload) {
    if (payload.id) {
      const idx = this.state.shifts.findIndex((s) => s.id === payload.id);
      if (idx >= 0) {
        this.state.shifts[idx] = { ...this.state.shifts[idx], ...payload };
        this.saveState();
        return this.state.shifts[idx];
      }
    }
    const created = {
      id: `shf_demo_${Date.now()}`,
      company_id: COMPANY_ID,
      name: payload.name,
      code: payload.code.toUpperCase(),
      start_time: payload.start_time.length === 5 ? `${payload.start_time}:00` : payload.start_time,
      end_time: payload.end_time.length === 5 ? `${payload.end_time}:00` : payload.end_time,
      grace_period_minutes: Number(payload.grace_period_minutes ?? 15),
      is_cross_day: Boolean(payload.is_cross_day),
      overtime_rate_multiplier: Number(payload.overtime_rate_multiplier ?? 1.5)
    };
    this.state.shifts.push(created);
    this.saveState();
    return created;
  }

  assignSchedule({ employee_id, shift_id, work_date, work_mode }) {
    const idx = this.state.schedules.findIndex(
      (s) => s.employee_id === employee_id && s.work_date === work_date && s.shift_id === shift_id
    );
    if (idx >= 0) {
      this.state.schedules[idx].work_mode = work_mode;
      this.saveState();
      return this.state.schedules[idx];
    }
    const created = {
      id: `sch_demo_${Date.now()}`,
      company_id: COMPANY_ID,
      employee_id,
      shift_id,
      work_date,
      work_mode
    };
    this.state.schedules.unshift(created);
    this.saveState();
    return created;
  }

  createRequest(payload) {
    const profile = this.getCurrentProfile();
    const startDate = String(payload.start_date || '').trim();
    const endDate = String(payload.end_date || '').trim();
    const reason = String(payload.reason || '').trim();
    if (!startDate || !endDate || endDate < startDate) {
      throw new Error('Tanggal selesai tidak boleh lebih awal dari tanggal mulai.');
    }
    if (reason.length < 3) {
      throw new Error('Alasan pengajuan minimal 3 karakter.');
    }
    const created = {
      id: `req_demo_${Date.now()}`,
      company_id: profile.company_id,
      employee_id: payload.employee_id || profile.id,
      target_employee_id: payload.target_employee_id || null,
      type: payload.type,
      start_date: startDate,
      end_date: endDate,
      hours_requested: Math.max(0, Number(payload.hours_requested || 0)),
      reason,
      attachment_url: payload.attachment_url || null,
      status: profile.role === 'supervisor' ? 'pending_hr' : 'pending_supervisor',
      supervisor_id: null,
      supervisor_action_at: null,
      approved_by: null,
      hr_action_at: null,
      rejection_reason: null,
      created_at: new Date().toISOString()
    };
    this.state.requests.unshift(created);
    this.saveState();
    return created;
  }

  processRequest(requestId, decision, actorProfile, rejectionReason = '') {
    const idx = this.state.requests.findIndex((r) => r.id === requestId);
    if (idx === -1) throw new Error('Pengajuan tidak ditemukan.');
    if (!actorProfile || !['supervisor', 'company_admin', 'super_admin'].includes(actorProfile.role)) {
      throw new Error('Anda tidak memiliki wewenang memproses pengajuan.');
    }
    const req = { ...this.state.requests[idx] };
    const requester = this.state.profiles.find((p) => p.id === req.employee_id);
    if (actorProfile.role === 'supervisor') {
      if (requester && requester.branch_id !== actorProfile.branch_id) {
        throw new Error('Supervisor hanya berwenang memproses pengajuan karyawan di cabangnya sendiri.');
      }
      if (req.status !== 'pending_supervisor') {
        throw new Error('Pengajuan sudah diproses dari tahap Supervisor.');
      }
    }
    const nowIso = new Date().toISOString();

    if (decision === 'reject') {
      req.status = 'rejected';
      req.rejection_reason = rejectionReason || 'Ditolak oleh pemeriksa.';
      if (actorProfile.role === 'supervisor') {
        req.supervisor_id = actorProfile.id;
        req.supervisor_action_at = nowIso;
      } else {
        req.approved_by = actorProfile.id;
        req.hr_action_at = nowIso;
      }
    } else if (decision === 'approve') {
      if (req.status === 'pending_supervisor' && actorProfile.role === 'supervisor') {
        req.status = 'pending_hr';
        req.supervisor_id = actorProfile.id;
        req.supervisor_action_at = nowIso;
      } else if (actorProfile.role === 'company_admin' || actorProfile.role === 'super_admin') {
        if (req.type === 'LEAVE' && req.status !== 'approved') {
          const days = Math.max(1, Math.round((new Date(req.end_date) - new Date(req.start_date)) / 86400000) + 1);
          const empIdx = this.state.profiles.findIndex((p) => p.id === req.employee_id);
          if (empIdx >= 0) {
            this.state.profiles[empIdx].leave_balance = Math.max(0, this.state.profiles[empIdx].leave_balance - days);
          }
        }
        req.status = 'approved';
        req.approved_by = actorProfile.id;
        req.hr_action_at = nowIso;
      }
    }

    this.state.requests[idx] = req;
    this.saveState();
    return req;
  }

  reviewAttendanceFlag(logId, validMark, actorProfile) {
    if (!actorProfile || !['supervisor', 'company_admin', 'super_admin'].includes(actorProfile.role)) {
      throw new Error('Hanya Supervisor atau HRD Admin yang berwenang melakukan audit absensi.');
    }
    const idx = this.state.attendance_logs.findIndex((l) => l.id === logId);
    if (idx === -1) throw new Error('Log absensi tidak ditemukan.');
    const log = { ...this.state.attendance_logs[idx] };
    if (actorProfile.role === 'supervisor' && log.branch_id !== actorProfile.branch_id) {
      throw new Error('Supervisor hanya berwenang mengaudit log absensi di cabangnya sendiri.');
    }
    log.flag_reviewed_by = actorProfile.id;
    log.flag_reviewed_at = new Date().toISOString();
    if (validMark) {
      log.is_flagged = false;
      log.notes = `${log.notes ? `${log.notes} | ` : ''}Diverifikasi valid oleh ${actorProfile.full_name} (${formatWibDateTime()})`;
    } else {
      log.is_flagged = true;
      log.status = 'ABSENT';
      log.notes = `${log.notes ? `${log.notes} | ` : ''}Dikonfirmasi Fraud oleh ${actorProfile.full_name}`;
    }
    this.state.attendance_logs[idx] = log;
    this.saveState();
    return log;
  }

  updatePayrollStatus(payrollId, status) {
    const idx = this.state.payrolls.findIndex((p) => p.id === payrollId);
    if (idx === -1) throw new Error('Slip gaji tidak ditemukan.');
    this.state.payrolls[idx].status = status;
    this.saveState();
    return this.state.payrolls[idx];
  }

  finalizePeriodPayrolls(companyId, month, year) {
    let count = 0;
    for (const p of this.state.payrolls) {
      if (p.company_id === companyId && p.period_month === month && p.period_year === year && p.status === 'DRAFT') {
        p.status = 'FINALIZED';
        count += 1;
      }
    }
    this.saveState();
    return { finalized_count: count };
  }

  async postPayrollToLedger(companyId, month, year, paymentAccountCode = '1102', sourceRef = null) {
    const ref = (sourceRef && sourceRef.trim())
      ? sourceRef.trim()
      : `PAYROLL-${year}${String(month).padStart(2, '0')}-BATCH`;

    if (!Array.isArray(this.state.ledger_batches)) this.state.ledger_batches = [];

    // Idempotency guard matching UNIQUE (company_id, period_year, period_month, source_ref)
    const existing = this.state.ledger_batches.find(
      (b) => b.company_id === companyId && b.period_year === year && b.period_month === month && b.source_ref === ref
    );
    if (existing) {
      return {
        success: true,
        already_posted: true,
        ...existing,
        message: `Batch ${ref} sudah pernah diposting ke Kronos Ledger (idempotent guard aktif).`
      };
    }

    const targets = this.state.payrolls.filter(
      (p) => p.company_id === companyId && p.period_month === month && p.period_year === year && p.status === 'FINALIZED' && !p.ledger_transaction_id
    );
    if (!targets.length) {
      return {
        success: false,
        code: 'NO_FINALIZED_PAYROLL',
        message: `Tidak ada slip payroll berstatus FINALIZED untuk periode ${String(month).padStart(2, '0')}/${year} yang belum diposting.`
      };
    }

    const totalNet = Math.round(targets.reduce((acc, p) => acc + Number(p.net_salary || 0), 0) * 100) / 100;
    const totalTax = Math.round(targets.reduce((acc, p) => acc + Number(p.fixed_deductions || 0), 0) * 100) / 100;
    const totalGrossExpense = Math.round((totalNet + totalTax) * 100) / 100;
    const nowIso = new Date().toISOString();
    const txId = `tx_kronos_${Date.now()}`;
    const markPaid = String(paymentAccountCode).startsWith('11');

    const batch = {
      id: `batch_${Date.now()}`,
      company_id: companyId,
      period_year: year,
      period_month: month,
      source_ref: ref,
      transaction_id: txId,
      employees_count: targets.length,
      total_gross_expense: totalGrossExpense,
      total_net_salary: totalNet,
      total_fixed_deductions: totalTax,
      payment_account_code: paymentAccountCode,
      posted_by: this.currentUserId,
      posted_at: nowIso
    };

    this.state.ledger_batches.unshift(batch);
    for (const p of targets) {
      p.ledger_transaction_id = txId;
      p.ledger_posted_at = nowIso;
      if (markPaid) p.status = 'PAID';
    }
    this.saveState();

    return {
      success: true,
      already_posted: false,
      marked_paid: markPaid,
      ...batch
    };
  }
}

export const demoEngine = new DemoEngine();
