-- ============================================================================
-- VECTRA x KRONOS LEDGER — 16_att_core_tables.sql
-- Attendance, Shift, Anti-Fraud, Leave & Payroll Core Tables, Indexes & Triggers
-- Extension on top of Kronos Ledger migrations 01..15 (non-destructive)
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. VECTRA NAMESPACED TABLES (att_*) LINKED TO public.organizations(id)
-- ----------------------------------------------------------------------------

-- 1.1 Company-level Attendance & Payroll Settings (extends organizations without altering it)
CREATE TABLE IF NOT EXISTS public.att_company_settings (
    company_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
    slug TEXT UNIQUE CHECK (slug IS NULL OR slug ~ '^[a-z0-9-]+$'),
    subscription_plan TEXT NOT NULL DEFAULT 'ENTERPRISE'
        CHECK (subscription_plan IN ('STARTER', 'GROWTH', 'ENTERPRISE', 'TRIAL')),
    timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
    late_penalty_per_minute NUMERIC(12, 2) NOT NULL DEFAULT 1500.00 CHECK (late_penalty_per_minute >= 0),
    salary_expense_account_code TEXT NOT NULL DEFAULT '6102',
    cash_bank_account_code TEXT NOT NULL DEFAULT '1102',
    tax_payable_account_code TEXT NOT NULL DEFAULT '2201',
    payroll_payable_account_code TEXT NOT NULL DEFAULT '2101',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1.2 Operational Branches with Geofence & Rotating QR Secret
CREATE TABLE IF NOT EXISTS public.att_branches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
    code TEXT NOT NULL CHECK (char_length(trim(code)) BETWEEN 2 AND 20),
    address TEXT NOT NULL DEFAULT '',
    latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    radius_meters INTEGER NOT NULL DEFAULT 150 CHECK (radius_meters BETWEEN 20 AND 5000),
    qr_secret_key TEXT NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, code)
);

-- 1.3 Employee Workforce Profiles (1:1 with auth.users, tenant-scoped to organizations)
CREATE TABLE IF NOT EXISTS public.att_profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES public.att_branches(id) ON DELETE SET NULL,
    employee_code TEXT NOT NULL CHECK (char_length(trim(employee_code)) BETWEEN 2 AND 32),
    full_name TEXT NOT NULL CHECK (char_length(trim(full_name)) BETWEEN 2 AND 120),
    email TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'employee'
        CHECK (role IN ('super_admin', 'company_admin', 'supervisor', 'employee')),
    department TEXT NOT NULL DEFAULT 'Operasional',
    position TEXT NOT NULL DEFAULT 'Staff',
    base_salary NUMERIC(14, 2) NOT NULL DEFAULT 0.00 CHECK (base_salary >= 0),
    daily_allowance NUMERIC(14, 2) NOT NULL DEFAULT 0.00 CHECK (daily_allowance >= 0),
    fixed_deduction NUMERIC(14, 2) NOT NULL DEFAULT 0.00 CHECK (fixed_deduction >= 0),
    leave_balance INTEGER NOT NULL DEFAULT 12 CHECK (leave_balance >= 0),
    bound_device_hash TEXT,
    device_bound_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, employee_code)
);

-- 1.4 Shift Templates (supports regular, split, and cross-day overnight shifts)
CREATE TABLE IF NOT EXISTS public.att_shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 100),
    code TEXT NOT NULL DEFAULT 'REG',
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    grace_period_minutes INTEGER NOT NULL DEFAULT 15 CHECK (grace_period_minutes BETWEEN 0 AND 180),
    is_cross_day BOOLEAN NOT NULL DEFAULT false,
    overtime_rate_multiplier NUMERIC(4, 2) NOT NULL DEFAULT 1.50 CHECK (overtime_rate_multiplier >= 1.00),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, code)
);

-- 1.5 Employee Daily Schedules (WFO, WFH, FIELD, OFF)
CREATE TABLE IF NOT EXISTS public.att_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES public.att_profiles(id) ON DELETE CASCADE,
    shift_id UUID NOT NULL REFERENCES public.att_shifts(id) ON DELETE RESTRICT,
    work_date DATE NOT NULL,
    work_mode TEXT NOT NULL DEFAULT 'WFO'
        CHECK (work_mode IN ('WFO', 'WFH', 'FIELD', 'OFF')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (employee_id, work_date, shift_id)
);

-- 1.6 Immutable Attendance Audit Logs (NEVER writes directly to accounting ledger)
CREATE TABLE IF NOT EXISTS public.att_attendance_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES public.att_profiles(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES public.att_branches(id) ON DELETE SET NULL,
    schedule_id UUID REFERENCES public.att_schedules(id) ON DELETE SET NULL,
    work_date DATE NOT NULL,
    work_mode TEXT NOT NULL DEFAULT 'WFO'
        CHECK (work_mode IN ('WFO', 'WFH', 'FIELD')),
    clock_in_at TIMESTAMPTZ NOT NULL,
    clock_out_at TIMESTAMPTZ,
    clock_in_lat DOUBLE PRECISION,
    clock_in_lon DOUBLE PRECISION,
    clock_in_accuracy_m DOUBLE PRECISION,
    clock_in_distance_m DOUBLE PRECISION,
    clock_out_lat DOUBLE PRECISION,
    clock_out_lon DOUBLE PRECISION,
    clock_out_accuracy_m DOUBLE PRECISION,
    clock_out_distance_m DOUBLE PRECISION,
    clock_in_photo_url TEXT,
    clock_out_photo_url TEXT,
    status TEXT NOT NULL DEFAULT 'ON_TIME'
        CHECK (status IN ('ON_TIME', 'LATE', 'EARLY_LEAVE', 'ABSENT', 'WFH', 'FIELD')),
    late_minutes INTEGER NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
    overtime_minutes INTEGER NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0),
    work_duration_minutes INTEGER NOT NULL DEFAULT 0 CHECK (work_duration_minutes >= 0),
    is_flagged BOOLEAN NOT NULL DEFAULT false,
    flag_reason TEXT,
    flag_reviewed_by UUID REFERENCES public.att_profiles(id) ON DELETE SET NULL,
    flag_reviewed_at TIMESTAMPTZ,
    device_hash TEXT NOT NULL DEFAULT '',
    verification_method TEXT NOT NULL DEFAULT 'GPS_SELFIE'
        CHECK (verification_method IN ('GPS_SELFIE', 'KIOSK_QR', 'FIELD_GPS', 'OFFLINE_SYNC')),
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_att_logs_employee_schedule
    ON public.att_attendance_logs (employee_id, schedule_id)
    WHERE schedule_id IS NOT NULL;

-- 1.7 Multi-Stage Approval Requests (Leave, Sick, Overtime, Shift Swap, Field Duty)
CREATE TABLE IF NOT EXISTS public.att_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES public.att_profiles(id) ON DELETE CASCADE,
    target_employee_id UUID REFERENCES public.att_profiles(id) ON DELETE SET NULL,
    type TEXT NOT NULL CHECK (type IN ('LEAVE', 'SICK', 'OVERTIME', 'SHIFT_SWAP', 'FIELD_DUTY')),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    hours_requested NUMERIC(5, 2) NOT NULL DEFAULT 0.00 CHECK (hours_requested >= 0),
    reason TEXT NOT NULL CHECK (char_length(trim(reason)) >= 3),
    attachment_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending_supervisor'
        CHECK (status IN ('pending_supervisor', 'pending_hr', 'approved', 'rejected', 'cancelled')),
    supervisor_id UUID REFERENCES public.att_profiles(id) ON DELETE SET NULL,
    supervisor_action_at TIMESTAMPTZ,
    approved_by UUID REFERENCES public.att_profiles(id) ON DELETE SET NULL,
    hr_action_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_date >= start_date)
);

-- 1.8 Monthly Payroll Ledger (linked to Kronos Ledger transaction once batch-posted)
CREATE TABLE IF NOT EXISTS public.att_payrolls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    employee_id UUID NOT NULL REFERENCES public.att_profiles(id) ON DELETE CASCADE,
    period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    period_year INTEGER NOT NULL CHECK (period_year BETWEEN 2020 AND 2100),
    total_present INTEGER NOT NULL DEFAULT 0 CHECK (total_present >= 0),
    total_wfo_days INTEGER NOT NULL DEFAULT 0 CHECK (total_wfo_days >= 0),
    total_late_minutes INTEGER NOT NULL DEFAULT 0 CHECK (total_late_minutes >= 0),
    total_overtime_minutes INTEGER NOT NULL DEFAULT 0 CHECK (total_overtime_minutes >= 0),
    total_absent_days INTEGER NOT NULL DEFAULT 0 CHECK (total_absent_days >= 0),
    base_salary NUMERIC(14, 2) NOT NULL DEFAULT 0.00 CHECK (base_salary >= 0),
    allowances_total NUMERIC(14, 2) NOT NULL DEFAULT 0.00 CHECK (allowances_total >= 0),
    overtime_pay NUMERIC(14, 2) NOT NULL DEFAULT 0.00 CHECK (overtime_pay >= 0),
    deductions_total NUMERIC(14, 2) NOT NULL DEFAULT 0.00 CHECK (deductions_total >= 0),
    fixed_deductions NUMERIC(14, 2) NOT NULL DEFAULT 0.00 CHECK (fixed_deductions >= 0),
    net_salary NUMERIC(14, 2) NOT NULL DEFAULT 0.00 CHECK (net_salary >= 0),
    reference_no TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'FINALIZED', 'PAID')),
    ledger_transaction_id UUID REFERENCES public.transactions(id) ON DELETE SET NULL,
    ledger_posted_at TIMESTAMPTZ,
    generated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, employee_id, period_month, period_year)
);

-- 1.9 Idempotent Batch Bridge Table (Payroll -> Kronos Ledger transactions)
CREATE TABLE IF NOT EXISTS public.att_payroll_ledger_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    period_year INTEGER NOT NULL CHECK (period_year BETWEEN 2020 AND 2100),
    period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    source_ref TEXT NOT NULL CHECK (char_length(trim(source_ref)) >= 3),
    transaction_id UUID NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
    employees_count INTEGER NOT NULL CHECK (employees_count > 0),
    total_gross_expense NUMERIC(15, 2) NOT NULL CHECK (total_gross_expense > 0),
    total_net_salary NUMERIC(15, 2) NOT NULL CHECK (total_net_salary >= 0),
    total_fixed_deductions NUMERIC(15, 2) NOT NULL DEFAULT 0.00 CHECK (total_fixed_deductions >= 0),
    posted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, period_year, period_month, source_ref)
);

-- 1.10 Employee Onboarding Invites (HRD Admin invites -> Employee activates own Auth password)
CREATE TABLE IF NOT EXISTS public.att_employee_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES public.att_branches(id) ON DELETE SET NULL,
    invite_token TEXT NOT NULL UNIQUE DEFAULT ('VCT-' || upper(encode(gen_random_bytes(12), 'hex'))),
    employee_code TEXT NOT NULL CHECK (char_length(trim(employee_code)) >= 2),
    full_name TEXT NOT NULL CHECK (char_length(trim(full_name)) >= 2),
    email TEXT NOT NULL CHECK (position('@' in trim(email)) > 1),
    phone TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'employee'
        CHECK (role IN ('company_admin', 'supervisor', 'employee')),
    department TEXT NOT NULL DEFAULT 'Operasional',
    position TEXT NOT NULL DEFAULT 'Staff',
    base_salary NUMERIC(14, 2) NOT NULL DEFAULT 5000000.00 CHECK (base_salary >= 0),
    daily_allowance NUMERIC(12, 2) NOT NULL DEFAULT 50000.00 CHECK (daily_allowance >= 0),
    fixed_deduction NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (fixed_deduction >= 0),
    leave_balance INTEGER NOT NULL DEFAULT 12 CHECK (leave_balance >= 0),
    invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
    accepted_at TIMESTAMPTZ,
    accepted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 2. PERFORMANCE INDEXES
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_att_branches_company ON public.att_branches (company_id);

CREATE INDEX IF NOT EXISTS idx_att_profiles_company ON public.att_profiles (company_id);
CREATE INDEX IF NOT EXISTS idx_att_profiles_branch ON public.att_profiles (branch_id);
CREATE INDEX IF NOT EXISTS idx_att_profiles_company_active ON public.att_profiles (company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_att_profiles_email_lower ON public.att_profiles (LOWER(email));

CREATE INDEX IF NOT EXISTS idx_att_shifts_company ON public.att_shifts (company_id);

CREATE INDEX IF NOT EXISTS idx_att_schedules_company_date ON public.att_schedules (company_id, work_date);
CREATE INDEX IF NOT EXISTS idx_att_schedules_employee_date ON public.att_schedules (employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_att_schedules_shift ON public.att_schedules (shift_id);

CREATE INDEX IF NOT EXISTS idx_att_logs_company_date ON public.att_attendance_logs (company_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_att_logs_branch_date ON public.att_attendance_logs (company_id, branch_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_att_logs_employee_date ON public.att_attendance_logs (employee_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_att_logs_schedule ON public.att_attendance_logs (schedule_id);
CREATE INDEX IF NOT EXISTS idx_att_logs_flagged_unresolved ON public.att_attendance_logs (company_id, work_date DESC)
    WHERE is_flagged = true AND flag_reviewed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_att_logs_open_sessions ON public.att_attendance_logs (employee_id, clock_in_at DESC)
    WHERE clock_out_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_att_requests_company_status ON public.att_requests (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_att_requests_employee ON public.att_requests (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_att_requests_target ON public.att_requests (target_employee_id);

CREATE INDEX IF NOT EXISTS idx_att_payrolls_company_period ON public.att_payrolls (company_id, period_year DESC, period_month DESC);
CREATE INDEX IF NOT EXISTS idx_att_payrolls_employee ON public.att_payrolls (employee_id, period_year DESC, period_month DESC);
CREATE INDEX IF NOT EXISTS idx_att_payrolls_ledger_tx ON public.att_payrolls (ledger_transaction_id) WHERE ledger_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_att_ledger_batches_company ON public.att_payroll_ledger_batches (company_id, period_year DESC, period_month DESC);

CREATE INDEX IF NOT EXISTS idx_att_invites_company ON public.att_employee_invites (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_att_invites_token ON public.att_employee_invites (invite_token);
CREATE UNIQUE INDEX IF NOT EXISTS uq_att_invites_pending_email ON public.att_employee_invites (company_id, LOWER(email))
    WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_att_invites_pending_code ON public.att_employee_invites (company_id, employee_code)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ----------------------------------------------------------------------------
-- 3. INTERNAL TRIGGERS (Timestamps, Sensitive Column Guard, Leave Balance)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.att_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_att_company_settings_updated_at ON public.att_company_settings;
CREATE TRIGGER trg_att_company_settings_updated_at
    BEFORE UPDATE ON public.att_company_settings
    FOR EACH ROW EXECUTE FUNCTION public.att_set_updated_at();

DROP TRIGGER IF EXISTS trg_att_profiles_updated_at ON public.att_profiles;
CREATE TRIGGER trg_att_profiles_updated_at
    BEFORE UPDATE ON public.att_profiles
    FOR EACH ROW EXECUTE FUNCTION public.att_set_updated_at();

-- Automatically deduct leave_balance when an att_requests LEAVE row reaches 'approved'
CREATE OR REPLACE FUNCTION public.att_handle_approved_leave_deduction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_days INTEGER;
BEGIN
    IF NEW.type = 'LEAVE' AND NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
        v_days := (NEW.end_date - NEW.start_date) + 1;
        IF v_days > 0 THEN
            PERFORM set_config('vectra.internal_rpc', 'on', true);
            UPDATE public.att_profiles
               SET leave_balance = GREATEST(0, leave_balance - v_days)
             WHERE id = NEW.employee_id;
            PERFORM set_config('vectra.internal_rpc', 'off', true);
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_att_requests_leave_deduction ON public.att_requests;
CREATE TRIGGER trg_att_requests_leave_deduction
    AFTER UPDATE ON public.att_requests
    FOR EACH ROW EXECUTE FUNCTION public.att_handle_approved_leave_deduction();

COMMIT;
