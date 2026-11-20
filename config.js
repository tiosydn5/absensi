// ============================================================================
// VECTRA // Configuration & Dual-Mode Data Client (Supabase Live + ?mode=demo)
// ============================================================================

import { demoEngine, getJakartaDateStr } from './demo-engine.js';
import {
  dataUrlToBlob,
  generateRotatingQrToken,
  verifyRotatingQrPayload
} from './anti-fraud.js';

const SAFE_BRANCH_COLS = 'id, company_id, name, code, address, latitude, longitude, radius_meters, is_active, created_at';

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
    // Ignore storage restriction
  }
}

function safeStorageRemove(key) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  } catch {
    // Ignore storage restriction
  }
}

export const DEFAULT_SUPABASE_PROJECT_ID = 'YOUR-PROJECT-ID';
export const DEFAULT_SUPABASE_URL = 'https://YOUR-PROJECT-ID.supabase.co';
export const DEFAULT_SUPABASE_REST_URL = 'https://YOUR-PROJECT-ID.supabase.co/rest/v1/';
export const DEFAULT_SUPABASE_ANON_KEY = 'YOUR-SUPABASE-ANON-KEY';

function normalizeSupabaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
}

function isAllowedSupabaseUrl(url) {
  try {
    const parsed = new URL(normalizeSupabaseUrl(url));
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function isForbiddenSecretKey(key) {
  const clean = String(key || '').trim();
  if (!clean) return false;
  if (/^sb_secret_/i.test(clean)) return true;
  if (clean.split('.').length === 3 && clean.startsWith('eyJ')) {
    try {
      const b64 = clean.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(b64));
      if (payload && payload.role === 'service_role') return true;
    } catch {
      // Ignore malformed JWT decode
    }
  }
  return false;
}

function deriveRestApiUrl(baseUrl) {
  const clean = normalizeSupabaseUrl(baseUrl);
  if (!clean || clean.includes('YOUR-PROJECT-ID')) return '-';
  return `${clean}/rest/v1/`;
}

function deriveProjectId(baseUrl) {
  const clean = normalizeSupabaseUrl(baseUrl);
  if (!clean || clean.includes('YOUR-PROJECT-ID')) return '';
  try {
    const host = new URL(clean).hostname;
    const part = host.split('.')[0];
    return part || '';
  } catch {
    return '';
  }
}

const storedUrlOverride = normalizeSupabaseUrl(safeStorageGet('vectra_supabase_url'));
const storedKeyOverride = String(safeStorageGet('vectra_supabase_anon_key') || '').trim();
const initialSupabaseUrl = storedUrlOverride || DEFAULT_SUPABASE_URL;
const initialSupabaseKey = (!isForbiddenSecretKey(storedKeyOverride) ? storedKeyOverride : '') || DEFAULT_SUPABASE_ANON_KEY;

export const VECTRA_CONFIG = {
  APP_NAME: 'VECTRA Workforce OS',
  TIMEZONE: 'Asia/Jakarta',
  PROJECT_ID: deriveProjectId(initialSupabaseUrl),
  SUPABASE_URL: initialSupabaseUrl,
  REST_API_URL: deriveRestApiUrl(initialSupabaseUrl),
  SUPABASE_ANON_KEY: initialSupabaseKey,
  BUCKETS: {
    SELFIES: 'attendance-selfies',
    ATTACHMENTS: 'request-attachments'
  }
};

export function hasCustomSupabaseOverride() {
  const url = normalizeSupabaseUrl(safeStorageGet('vectra_supabase_url'));
  const key = String(safeStorageGet('vectra_supabase_anon_key') || '').trim();
  return Boolean(
    url &&
    key &&
    isAllowedSupabaseUrl(url) &&
    !isForbiddenSecretKey(key) &&
    (url !== DEFAULT_SUPABASE_URL || key !== DEFAULT_SUPABASE_ANON_KEY)
  );
}

export function isSupabaseConfigured() {
  return (
    Boolean(VECTRA_CONFIG.SUPABASE_URL) &&
    Boolean(VECTRA_CONFIG.SUPABASE_ANON_KEY) &&
    isAllowedSupabaseUrl(VECTRA_CONFIG.SUPABASE_URL) &&
    !isForbiddenSecretKey(VECTRA_CONFIG.SUPABASE_ANON_KEY) &&
    !VECTRA_CONFIG.SUPABASE_URL.includes('YOUR-PROJECT-ID') &&
    !VECTRA_CONFIG.SUPABASE_ANON_KEY.includes('YOUR-SUPABASE-ANON-KEY')
  );
}

export function isDemoMode() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('mode') === 'demo') return true;
  if (params.get('mode') === 'live' && isSupabaseConfigured()) return false;
  return !isSupabaseConfigured();
}

export function saveSupabaseCredentials(url, anonKey) {
  const cleanUrl = normalizeSupabaseUrl(url);
  const cleanKey = String(anonKey || '').trim();
  if (!isAllowedSupabaseUrl(cleanUrl)) {
    throw new Error('URL Supabase harus menggunakan protokol https:// (atau http://localhost untuk pengembangan lokal).');
  }
  if (!cleanKey || cleanKey.includes('YOUR-SUPABASE-ANON-KEY')) {
    throw new Error('Publishable / Anon Key Supabase tidak valid.');
  }
  if (isForbiddenSecretKey(cleanKey)) {
    throw new Error('DITOLAK DEMI KEAMANAN: Jangan pernah memasukkan Secret / Service Role Key ke sisi browser! Gunakan hanya Publishable / Anon Key.');
  }
  safeStorageSet('vectra_supabase_url', cleanUrl);
  safeStorageSet('vectra_supabase_anon_key', cleanKey);
  VECTRA_CONFIG.SUPABASE_URL = cleanUrl;
  VECTRA_CONFIG.REST_API_URL = deriveRestApiUrl(cleanUrl);
  VECTRA_CONFIG.PROJECT_ID = deriveProjectId(cleanUrl);
  VECTRA_CONFIG.SUPABASE_ANON_KEY = cleanKey;
  cachedSupabase = null;
}

export function clearSupabaseCredentials() {
  safeStorageRemove('vectra_supabase_url');
  safeStorageRemove('vectra_supabase_anon_key');
  VECTRA_CONFIG.PROJECT_ID = deriveProjectId(DEFAULT_SUPABASE_URL);
  VECTRA_CONFIG.SUPABASE_URL = DEFAULT_SUPABASE_URL;
  VECTRA_CONFIG.REST_API_URL = deriveRestApiUrl(DEFAULT_SUPABASE_URL);
  VECTRA_CONFIG.SUPABASE_ANON_KEY = DEFAULT_SUPABASE_ANON_KEY;
  cachedSupabase = null;
}

let cachedSupabase = null;

async function waitForSupabaseSdk(timeoutMs = 5000) {
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    return window.supabase;
  }
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      return window.supabase;
    }
  }
  throw new Error('Supabase JS SDK gagal dimuat dari CDN. Periksa koneksi internet Anda atau gunakan Mode Demo (?mode=demo).');
}

async function getSupabaseInstance() {
  if (cachedSupabase) return cachedSupabase;
  if (!isSupabaseConfigured()) {
    throw new Error('Kredensial Supabase Live belum dikonfigurasi. Atur Project URL & Publishable/Anon Key atau gunakan Mode Demo.');
  }
  const sdk = await waitForSupabaseSdk(5000);
  cachedSupabase = sdk.createClient(
    VECTRA_CONFIG.SUPABASE_URL,
    VECTRA_CONFIG.SUPABASE_ANON_KEY
  );
  return cachedSupabase;
}

/**
 * Create unified client adapter consumed by app.js for both Live & Demo modes.
 */
export function createDataClient() {
  const demo = isDemoMode();

  if (demo) {
    return {
      mode: 'demo',

      async getSessionState() {
        const profile = await this.getSessionProfile();
        return {
          session: profile ? { user: { id: profile.id, email: profile.email } } : null,
          profile
        };
      },

      async getSessionProfile() {
        const params = new URLSearchParams(window.location.search);
        const requestedRole = params.get('role');
        if (requestedRole && ['company_admin', 'supervisor', 'employee', 'super_admin'].includes(requestedRole)) {
          demoEngine.setSessionByRole(requestedRole);
        }
        return demoEngine.getCurrentProfile();
      },

      async signUpWorkspace() {
        throw new Error('Pendaftaran akun Supabase Live hanya tersedia saat Mode Live. Di Demo Sandbox, pilih langsung salah satu tombol Akses Instan.');
      },

      async onboardLiveWorkspace() {
        return demoEngine.getCurrentProfile();
      },

      async signInWithEmail(email) {
        const match = demoEngine.state.profiles.find(
          (p) => p.email.toLowerCase() === String(email || '').trim().toLowerCase()
        );
        if (!match) {
          throw new Error('Email tidak ditemukan di dataset demo. Gunakan tombol Role Switcher cepat.');
        }
        return demoEngine.setCurrentUserById(match.id);
      },

      async signInDemoRole(role) {
        return demoEngine.setSessionByRole(role);
      },

      async switchDemoUser(userId) {
        return demoEngine.setCurrentUserById(userId);
      },

      async signOut() {
        safeStorageRemove('vectra_demo_role_override');
        return true;
      },

      async fetchWorkspaceBundle(companyId) {
        return demoEngine.getAllDataForCompany(companyId);
      },

      async getDashboardKpis(filters) {
        return demoEngine.getDashboardKpis(filters);
      },

      async submitClockIn(payload) {
        const photoUrl = payload.photoDataUrl || `demo://watermark/${Date.now()}`;
        return demoEngine.submitClockIn({
          ...payload,
          photo_url: photoUrl
        });
      },

      async submitClockOut(payload) {
        const photoUrl = payload.photoDataUrl || `demo://watermark/out-${Date.now()}`;
        return demoEngine.submitClockOut({
          ...payload,
          photo_url: photoUrl
        });
      },

      async generateMonthlyPayroll(companyId, month, year) {
        return demoEngine.generateMonthlyPayroll(companyId, month, year);
      },

      async createEmployee(payload) {
        return demoEngine.createEmployee(payload);
      },

      async createEmployeeInvite(payload) {
        return demoEngine.createEmployeeInvite(payload);
      },

      async revokeEmployeeInvite(inviteId) {
        return demoEngine.revokeEmployeeInvite(inviteId);
      },

      async previewEmployeeInvite(token) {
        return demoEngine.previewEmployeeInvite(token);
      },

      async acceptEmployeeInvite(token) {
        return demoEngine.acceptEmployeeInvite(token);
      },

      async signUpWithInvite({ inviteToken }) {
        const res = demoEngine.acceptEmployeeInvite(inviteToken);
        if (!res?.success) throw new Error(res?.message || 'Undangan tidak valid.');
        demoEngine.setCurrentUserById(res.profile.id);
        return { needsEmailConfirmation: false, user: { id: res.profile.id, email: res.profile.email }, session: { user: { id: res.profile.id } }, profile: res.profile };
      },

      async updateEmployee(id, patch) {
        return demoEngine.updateEmployee(id, patch);
      },

      async resetDeviceBinding(employeeId) {
        return demoEngine.resetDeviceBinding(employeeId);
      },

      async saveBranch(payload) {
        return demoEngine.saveBranch(payload);
      },

      async saveShift(payload) {
        return demoEngine.saveShift(payload);
      },

      async assignSchedule(payload) {
        return demoEngine.assignSchedule(payload);
      },

      async createRequest(payload) {
        return demoEngine.createRequest(payload);
      },

      async processRequest(requestId, decision, actorProfile, rejectionReason) {
        return demoEngine.processRequest(requestId, decision, actorProfile, rejectionReason);
      },

      async reviewAttendanceFlag(logId, validMark, actorProfile) {
        return demoEngine.reviewAttendanceFlag(logId, validMark, actorProfile);
      },

      async updatePayrollStatus(payrollId, status) {
        return demoEngine.updatePayrollStatus(payrollId, status);
      },

      async finalizePeriodPayrolls(companyId, month, year) {
        return demoEngine.finalizePeriodPayrolls(companyId, month, year);
      },

      async postPayrollToLedger(companyId, month, year, paymentAccountCode = '1102', sourceRef = null) {
        return demoEngine.postPayrollToLedger(companyId, month, year, paymentAccountCode, sourceRef);
      },

      async getSignedPhotoUrl(photoUrl) {
        return photoUrl;
      },

      async getSignedAttachmentUrl(attachmentUrl) {
        return attachmentUrl;
      },

      async getKioskQrToken(branchId) {
        const br = demoEngine.state.branches.find((b) => b.id === branchId) || demoEngine.state.branches[0];
        if (!br) throw new Error('Cabang tidak ditemukan.');
        return generateRotatingQrToken(br.qr_secret_key, br.code);
      },

      async verifyKioskQrToken(branchId, payload) {
        const br = demoEngine.state.branches.find((b) => b.id === branchId) || demoEngine.state.branches[0];
        if (!br) return { valid: false, reason: 'Cabang tidak ditemukan.' };
        return verifyRotatingQrPayload(payload, br.qr_secret_key, br.code);
      },

      resetDemo() {
        return demoEngine.resetDemoState();
      }
    };
  }

  // ---- LIVE SUPABASE CLIENT ADAPTER ----
  async function provisionLiveWorkspace(sb, user, { fullName, companyName, email }) {
    const { data: existingProfile, error: existingErr } = await sb
      .from('att_profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existingProfile) return existingProfile;

    const cleanFullName = String(fullName || user.user_metadata?.full_name || user.email?.split('@')[0] || 'Admin VECTRA').trim();
    const cleanCompany = String(companyName || user.user_metadata?.company_name || 'Perusahaan Baru VECTRA').trim();

    // Reuse existing Kronos organization if user already owns one, else create a new organization (triggers CoA seeder)
    let org = null;
    const { data: existingOrgs, error: orgListErr } = await sb
      .from('organizations')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(1);
    if (orgListErr) throw orgListErr;
    if (existingOrgs && existingOrgs.length > 0) {
      org = existingOrgs[0];
    } else {
      const { data: newOrg, error: orgErr } = await sb
        .from('organizations')
        .insert({
          name: cleanCompany,
          currency: 'IDR',
          tax_rate: 0.5,
          created_by: user.id
        })
        .select()
        .single();
      if (orgErr) throw orgErr;
      org = newOrg;
    }

    const baseSlug = cleanCompany
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'vectra-org';
    const uniqueSlug = `${baseSlug}-${org.id.slice(0, 6)}`;

    const { error: settingsErr } = await sb
      .from('att_company_settings')
      .upsert({
        company_id: org.id,
        slug: uniqueSlug,
        subscription_plan: 'ENTERPRISE',
        timezone: 'Asia/Jakarta',
        late_penalty_per_minute: 1500
      }, { onConflict: 'company_id' });
    if (settingsErr) throw settingsErr;

    // Ensure at least 1 HQ branch exists (never read qr_secret_key on client)
    let branch = null;
    const { data: branches, error: brListErr } = await sb
      .from('att_branches')
      .select(SAFE_BRANCH_COLS)
      .eq('company_id', org.id)
      .limit(1);
    if (brListErr) throw brListErr;
    if (branches && branches.length > 0) {
      branch = branches[0];
    } else {
      const { data: newBranch, error: brErr } = await sb
        .from('att_branches')
        .insert({
          company_id: org.id,
          name: 'Kantor Pusat (HQ)',
          code: 'HQ-01',
          address: 'Jakarta',
          latitude: -6.2087634,
          longitude: 106.8205543,
          radius_meters: 150,
          is_active: true
        })
        .select(SAFE_BRANCH_COLS)
        .single();
      if (brErr) throw brErr;
      branch = newBranch;
    }

    // Ensure default shifts exist
    const { data: existingShifts, error: shfListErr } = await sb
      .from('att_shifts')
      .select('id')
      .eq('company_id', org.id)
      .limit(1);
    if (shfListErr) throw shfListErr;
    if (!existingShifts || existingShifts.length === 0) {
      const { error: shfErr } = await sb.from('att_shifts').insert([
        {
          company_id: org.id,
          name: 'Shift Pagi Operasional',
          code: 'SHF-PG',
          start_time: '08:00:00',
          end_time: '17:00:00',
          grace_period_minutes: 15,
          is_cross_day: false,
          overtime_rate_multiplier: 1.5
        },
        {
          company_id: org.id,
          name: 'Shift Malam Cross-Day',
          code: 'SHF-ML',
          start_time: '22:00:00',
          end_time: '06:00:00',
          grace_period_minutes: 10,
          is_cross_day: true,
          overtime_rate_multiplier: 2.0
        }
      ]);
      if (shfErr) throw shfErr;
    }

    const { data: createdProfile, error: profInsErr } = await sb
      .from('att_profiles')
      .insert({
        id: user.id,
        company_id: org.id,
        branch_id: branch.id,
        employee_code: 'EMP-001',
        full_name: cleanFullName,
        email: email || user.email || '',
        role: 'company_admin',
        department: 'Management',
        position: 'HRD Admin',
        base_salary: 12000000,
        daily_allowance: 50000,
        fixed_deduction: 250000,
        leave_balance: 12,
        is_active: true
      })
      .select()
      .single();
    if (profInsErr) throw profInsErr;
    return createdProfile;
  }

  return {
    mode: 'live',

    async getSessionState() {
      const sb = await getSupabaseInstance();
      const { data: { session }, error } = await sb.auth.getSession();
      if (error) throw error;
      if (!session) return { session: null, profile: null };
      const { data: profile, error: profErr } = await sb
        .from('att_profiles')
        .select('*')
        .eq('id', session.user.id)
        .maybeSingle();
      if (profErr) throw profErr;
      return { session, profile: profile || null };
    },

    async getSessionProfile() {
      const { session, profile } = await this.getSessionState();
      if (!session) return null;
      return profile;
    },

    async signInWithEmail(email, password, inviteToken = '') {
      const sb = await getSupabaseInstance();
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      let { data: profile, error: profErr } = await sb
        .from('att_profiles')
        .select('*')
        .eq('id', data.user.id)
        .maybeSingle();
      if (profErr) throw profErr;

      const pendingToken = String(inviteToken || data.user?.user_metadata?.invite_token || '').trim();
      if (!profile && pendingToken) {
        const { data: claimRes, error: claimErr } = await sb.rpc('accept_employee_invite', {
          p_invite_token: pendingToken
        });
        if (!claimErr && claimRes?.success && claimRes.profile) {
          profile = claimRes.profile;
        }
      }
      return { user: data.user, session: data.session, profile: profile || null };
    },

    async signUpWorkspace({ fullName, companyName, email, password }) {
      const sb = await getSupabaseInstance();
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
            company_name: companyName
          }
        }
      });
      if (error) throw error;
      if (!data.session || !data.user) {
        return { needsEmailConfirmation: true, user: data.user || null, profile: null };
      }
      const profile = await provisionLiveWorkspace(sb, data.user, { fullName, companyName, email });
      return { needsEmailConfirmation: false, user: data.user, session: data.session, profile };
    },

    async signUpWithInvite({ inviteToken, fullName, email, password }) {
      const sb = await getSupabaseInstance();
      const cleanToken = String(inviteToken || '').trim().toUpperCase();
      const { data, error } = await sb.auth.signUp({
        email: String(email || '').trim().toLowerCase(),
        password,
        options: {
          data: {
            full_name: String(fullName || '').trim(),
            invite_token: cleanToken
          }
        }
      });
      if (error) throw error;
      if (!data.session || !data.user) {
        return { needsEmailConfirmation: true, user: data.user || null, profile: null };
      }
      const res = await this.acceptEmployeeInvite(cleanToken);
      if (!res?.success) {
        throw new Error(res?.message || 'Gagal mengklaim undangan karyawan.');
      }
      return { needsEmailConfirmation: false, user: data.user, session: data.session, profile: res.profile };
    },

    async onboardLiveWorkspace({ fullName, companyName }) {
      const sb = await getSupabaseInstance();
      const { data: { user }, error } = await sb.auth.getUser();
      if (error || !user) throw new Error('Sesi autentikasi tidak ditemukan. Silakan login kembali.');
      return provisionLiveWorkspace(sb, user, { fullName, companyName, email: user.email });
    },

    async signOut() {
      const sb = await getSupabaseInstance();
      const { error } = await sb.auth.signOut();
      if (error) throw error;
      return true;
    },

    async fetchWorkspaceBundle(companyId) {
      const sb = await getSupabaseInstance();
      const thirtyDaysAgo = getJakartaDateStr(-30);
      const [orgRes, orgsRes, setRes, branchRes, shiftRes, profRes, schedRes, attRes, reqRes, payRes, batchRes, invRes] = await Promise.all([
        sb.from('organizations').select('*').eq('id', companyId).maybeSingle(),
        sb.from('organizations').select('*').order('created_at', { ascending: false }),
        sb.from('att_company_settings').select('*').eq('company_id', companyId).maybeSingle(),
        sb.from('att_branches').select(SAFE_BRANCH_COLS).eq('company_id', companyId).order('name'),
        sb.from('att_shifts').select('*').eq('company_id', companyId).order('start_time'),
        sb.from('att_profiles').select('*').eq('company_id', companyId).order('employee_code'),
        sb.from('att_schedules').select('*').eq('company_id', companyId).gte('work_date', thirtyDaysAgo).order('work_date', { ascending: false }),
        sb.from('att_attendance_logs').select('*').eq('company_id', companyId).gte('work_date', thirtyDaysAgo).order('clock_in_at', { ascending: false }),
        sb.from('att_requests').select('*').eq('company_id', companyId).order('created_at', { ascending: false }),
        sb.from('att_payrolls').select('*').eq('company_id', companyId).order('period_year', { ascending: false }).order('period_month', { ascending: false }),
        sb.from('att_payroll_ledger_batches').select('*').eq('company_id', companyId).order('posted_at', { ascending: false }),
        sb.from('att_employee_invites').select('*').eq('company_id', companyId).order('created_at', { ascending: false })
      ]);

      const firstErr = [orgRes, setRes, branchRes, shiftRes, profRes, schedRes, attRes, reqRes, payRes, batchRes].find((r) => r.error)?.error;
      if (firstErr) throw firstErr;

      const mergedCompany = orgRes.data ? { ...orgRes.data, ...(setRes.data || {}) } : null;
      return {
        company: mergedCompany,
        companies: orgsRes.data || (mergedCompany ? [mergedCompany] : []),
        branches: branchRes.data || [],
        shifts: shiftRes.data || [],
        profiles: profRes.data || [],
        schedules: schedRes.data || [],
        attendance_logs: attRes.data || [],
        requests: reqRes.data || [],
        payrolls: payRes.data || [],
        ledger_batches: batchRes.data || [],
        employee_invites: invRes?.error ? [] : (invRes?.data || [])
      };
    },

    async getDashboardKpis({ companyId, branchId = null, department = null, shiftId = null, startDate = null, endDate = null }) {
      const sb = await getSupabaseInstance();
      const { data, error } = await sb.rpc('get_dashboard_kpis', {
        p_company_id: companyId,
        p_branch_id: branchId || null,
        p_department: department || null,
        p_shift_id: shiftId || null,
        p_start_date: startDate || getJakartaDateStr(0),
        p_end_date: endDate || getJakartaDateStr(0)
      });
      if (error) throw error;
      return data;
    },

    async submitClockIn(payload) {
      const sb = await getSupabaseInstance();
      let photoPath = '';
      const uploadBlob = payload.photoBlob instanceof Blob ? payload.photoBlob : dataUrlToBlob(payload.photoDataUrl);
      if (uploadBlob && payload.companyId && payload.employeeId) {
        const fileName = `${payload.companyId}/${payload.employeeId}/in_${Date.now()}.jpg`;
        const { error: upErr } = await sb.storage
          .from(VECTRA_CONFIG.BUCKETS.SELFIES)
          .upload(fileName, uploadBlob, { contentType: 'image/jpeg', upsert: false });
        if (upErr) throw upErr;
        photoPath = fileName;
      }
      const { data, error } = await sb.rpc('submit_clock_in', {
        p_lat: payload.lat,
        p_lon: payload.lon,
        p_accuracy_m: payload.accuracy_m,
        p_device_hash: payload.device_hash,
        p_photo_url: photoPath,
        p_work_mode: payload.work_mode || 'WFO',
        p_verification_method: payload.verification_method || 'GPS_SELFIE',
        p_notes: payload.notes || '',
        p_qr_payload: payload.qr_payload || null
      });
      if (error) throw error;
      return data;
    },

    async submitClockOut(payload) {
      const sb = await getSupabaseInstance();
      let photoPath = '';
      const uploadBlob = payload.photoBlob instanceof Blob ? payload.photoBlob : dataUrlToBlob(payload.photoDataUrl);
      if (uploadBlob && payload.companyId && payload.employeeId) {
        const fileName = `${payload.companyId}/${payload.employeeId}/out_${Date.now()}.jpg`;
        const { error: upErr } = await sb.storage
          .from(VECTRA_CONFIG.BUCKETS.SELFIES)
          .upload(fileName, uploadBlob, { contentType: 'image/jpeg', upsert: false });
        if (upErr) throw upErr;
        photoPath = fileName;
      }
      const { data, error } = await sb.rpc('submit_clock_out', {
        p_lat: payload.lat,
        p_lon: payload.lon,
        p_accuracy_m: payload.accuracy_m,
        p_device_hash: payload.device_hash,
        p_photo_url: photoPath,
        p_notes: payload.notes || ''
      });
      if (error) throw error;
      return data;
    },

    async generateMonthlyPayroll(companyId, month, year) {
      const sb = await getSupabaseInstance();
      const { data, error } = await sb.rpc('generate_monthly_payroll', {
        p_company_id: companyId,
        p_month: month,
        p_year: year
      });
      if (error) throw error;
      return data;
    },

    async createEmployee(payload) {
      return this.createEmployeeInvite(payload);
    },

    async createEmployeeInvite(payload) {
      const sb = await getSupabaseInstance();
      const insertObj = {
        company_id: payload.company_id,
        branch_id: payload.branch_id || null,
        employee_code: String(payload.employee_code || '').trim().toUpperCase(),
        full_name: String(payload.full_name || '').trim(),
        email: String(payload.email || '').trim().toLowerCase(),
        phone: String(payload.phone || '').trim(),
        role: payload.role || 'employee',
        department: String(payload.department || 'Operasional').trim(),
        position: String(payload.position || 'Staff').trim(),
        base_salary: Number(payload.base_salary || 5000000),
        daily_allowance: Number(payload.daily_allowance || 0),
        fixed_deduction: Number(payload.fixed_deduction || 0),
        leave_balance: Number(payload.leave_balance ?? 12)
      };
      const { data, error } = await sb.from('att_employee_invites').insert(insertObj).select().single();
      if (error) {
        if (error.code === '23505') {
          throw new Error('Sudah ada undangan aktif untuk email atau NIK karyawan tersebut. Batalkan undangan lama dulu jika ingin membuat baru.');
        }
        throw error;
      }
      return data;
    },

    async revokeEmployeeInvite(inviteId) {
      const sb = await getSupabaseInstance();
      const { data, error } = await sb
        .from('att_employee_invites')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', inviteId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    async previewEmployeeInvite(token) {
      const sb = await getSupabaseInstance();
      const { data, error } = await sb.rpc('preview_employee_invite', {
        p_invite_token: String(token || '').trim()
      });
      if (error) throw error;
      return data;
    },

    async acceptEmployeeInvite(token) {
      const sb = await getSupabaseInstance();
      const { data, error } = await sb.rpc('accept_employee_invite', {
        p_invite_token: String(token || '').trim()
      });
      if (error) throw error;
      return data;
    },

    async updateEmployee(id, patch) {
      const sb = await getSupabaseInstance();
      const { data, error } = await sb.from('att_profiles').update(patch).eq('id', id).select().single();
      if (error) throw error;
      return data;
    },

    async resetDeviceBinding(employeeId) {
      const sb = await getSupabaseInstance();
      const { data, error } = await sb
        .from('att_profiles')
        .update({ bound_device_hash: null, device_bound_at: null })
        .eq('id', employeeId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    async saveBranch(payload) {
      const sb = await getSupabaseInstance();
      const { qr_secret_key: _dropSecret, ...cleanPayload } = payload || {};
      if (cleanPayload.id) {
        const { data, error } = await sb.from('att_branches').update(cleanPayload).eq('id', cleanPayload.id).select(SAFE_BRANCH_COLS).single();
        if (error) throw error;
        return data;
      }
      const { data, error } = await sb.from('att_branches').insert(cleanPayload).select(SAFE_BRANCH_COLS).single();
      if (error) throw error;
      return data;
    },

    async saveShift(payload) {
      const sb = await getSupabaseInstance();
      if (payload.id) {
        const { data, error } = await sb.from('att_shifts').update(payload).eq('id', payload.id).select().single();
        if (error) throw error;
        return data;
      }
      const { data, error } = await sb.from('att_shifts').insert(payload).select().single();
      if (error) throw error;
      return data;
    },

    async assignSchedule(payload) {
      const sb = await getSupabaseInstance();
      const { data, error } = await sb
        .from('att_schedules')
        .upsert(payload, { onConflict: 'employee_id,work_date,shift_id' })
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    async createRequest(payload) {
      const sb = await getSupabaseInstance();
      let attachmentUrl = payload.attachment_url || null;
      if (payload.attachmentFile && payload.company_id && payload.employee_id) {
        const safeName = String(payload.attachmentFile.name || 'lampiran.bin').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
        const path = `${payload.company_id}/${payload.employee_id}/req_${Date.now()}_${safeName}`;
        const { error: upErr } = await sb.storage.from(VECTRA_CONFIG.BUCKETS.ATTACHMENTS).upload(path, payload.attachmentFile);
        if (upErr) throw upErr;
        attachmentUrl = path;
      }
      const insertObj = {
        company_id: payload.company_id,
        employee_id: payload.employee_id,
        target_employee_id: payload.target_employee_id || null,
        type: payload.type,
        start_date: payload.start_date,
        end_date: payload.end_date,
        hours_requested: Number(payload.hours_requested || 0),
        reason: payload.reason,
        attachment_url: attachmentUrl
      };
      const { data, error } = await sb.from('att_requests').insert(insertObj).select().single();
      if (error) throw error;
      return data;
    },

    async processRequest(requestId, decision, actorProfile, rejectionReason = '') {
      const sb = await getSupabaseInstance();
      const nowIso = new Date().toISOString();
      const patch = {};
      if (decision === 'reject') {
        patch.status = 'rejected';
        patch.rejection_reason = rejectionReason || 'Ditolak oleh pemeriksa.';
        if (actorProfile.role === 'supervisor') {
          patch.supervisor_id = actorProfile.id;
          patch.supervisor_action_at = nowIso;
        } else {
          patch.approved_by = actorProfile.id;
          patch.hr_action_at = nowIso;
        }
      } else if (actorProfile.role === 'supervisor') {
        patch.status = 'pending_hr';
        patch.supervisor_id = actorProfile.id;
        patch.supervisor_action_at = nowIso;
      } else {
        patch.status = 'approved';
        patch.approved_by = actorProfile.id;
        patch.hr_action_at = nowIso;
      }
      const { data, error } = await sb.from('att_requests').update(patch).eq('id', requestId).select().single();
      if (error) throw error;
      return data;
    },

    async reviewAttendanceFlag(logId, validMark, actorProfile) {
      const sb = await getSupabaseInstance();
      const patch = {
        flag_reviewed_by: actorProfile.id,
        flag_reviewed_at: new Date().toISOString(),
        is_flagged: !validMark
      };
      if (!validMark) patch.status = 'ABSENT';
      const { data, error } = await sb.from('att_attendance_logs').update(patch).eq('id', logId).select().single();
      if (error) throw error;
      return data;
    },

    async updatePayrollStatus(payrollId, status) {
      const sb = await getSupabaseInstance();
      const { data, error } = await sb.from('att_payrolls').update({ status }).eq('id', payrollId).select().single();
      if (error) throw error;
      return data;
    },

    async finalizePeriodPayrolls(companyId, month, year) {
      const sb = await getSupabaseInstance();
      const { data, error } = await sb
        .from('att_payrolls')
        .update({ status: 'FINALIZED' })
        .eq('company_id', companyId)
        .eq('period_month', month)
        .eq('period_year', year)
        .eq('status', 'DRAFT')
        .select('id');
      if (error) throw error;
      return { finalized_count: (data || []).length };
    },

    async postPayrollToLedger(companyId, month, year, paymentAccountCode = '1102', sourceRef = null) {
      const sb = await getSupabaseInstance();
      const { data, error } = await sb.rpc('post_payroll_to_ledger', {
        p_company_id: companyId,
        p_month: month,
        p_year: year,
        p_payment_account_code: paymentAccountCode,
        p_source_ref: sourceRef
      });
      if (error) throw error;
      return data;
    },

    async getSignedPhotoUrl(photoPath) {
      if (!photoPath) return null;
      if (photoPath.startsWith('data:') || photoPath.startsWith('demo://')) return photoPath;
      const sb = await getSupabaseInstance();
      const { data, error } = await sb.storage.from(VECTRA_CONFIG.BUCKETS.SELFIES).createSignedUrl(photoPath, 3600);
      if (error) return null;
      return data.signedUrl;
    },

    async getSignedAttachmentUrl(attachmentPath) {
      if (!attachmentPath) return null;
      if (attachmentPath.startsWith('demo://')) return attachmentPath;
      const sb = await getSupabaseInstance();
      const { data, error } = await sb.storage.from(VECTRA_CONFIG.BUCKETS.ATTACHMENTS).createSignedUrl(attachmentPath, 3600);
      if (error) return null;
      return data.signedUrl;
    },

    async getKioskQrToken(branchId) {
      const sb = await getSupabaseInstance();
      const { data, error } = await sb.rpc('get_kiosk_qr_token', { p_branch_id: branchId });
      if (error) throw error;
      return data;
    },

    async verifyKioskQrToken(branchId, payload) {
      const sb = await getSupabaseInstance();
      const { data, error } = await sb.rpc('verify_kiosk_qr_token', {
        p_branch_id: branchId,
        p_qr_payload: payload
      });
      if (error) throw error;
      return data;
    }
  };
}
