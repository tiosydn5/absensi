-- ============================================================================
-- VECTRA x KRONOS LEDGER — 17_att_rls_and_storage.sql
-- Non-Recursive RLS Helpers, Strict Multi-Tenant RLS Policies & Storage Rules
-- Compatible with Kronos Ledger is_org_member() & has_org_role()
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. NON-RECURSIVE RLS HELPER FUNCTIONS (Aligned with Kronos Ledger helpers)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.att_auth_company_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT p.company_id FROM public.att_profiles p WHERE p.id = auth.uid() LIMIT 1),
        (SELECT m.org_id FROM public.organization_members m WHERE m.user_id = auth.uid() ORDER BY m.created_at ASC LIMIT 1)
    );
$$;

CREATE OR REPLACE FUNCTION public.att_auth_branch_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT p.branch_id FROM public.att_profiles p WHERE p.id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.att_auth_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT p.role FROM public.att_profiles p WHERE p.id = auth.uid() LIMIT 1),
        (
            SELECT CASE
                WHEN m.role IN ('owner', 'accountant') THEN 'company_admin'
                ELSE 'employee'
            END
            FROM public.organization_members m
            WHERE m.user_id = auth.uid()
            ORDER BY m.created_at ASC
            LIMIT 1
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.att_is_company_admin(target_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT auth.uid() IS NOT NULL AND (
        public.att_auth_role() = 'super_admin'
        OR (public.att_auth_role() = 'company_admin' AND public.att_auth_company_id() = target_company_id)
        OR public.has_org_role(target_company_id, ARRAY['owner', 'accountant'])
    );
$$;

CREATE OR REPLACE FUNCTION public.att_is_company_member(target_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT auth.uid() IS NOT NULL AND (
        public.att_auth_role() = 'super_admin'
        OR public.att_auth_company_id() = target_company_id
        OR public.is_org_member(target_company_id)
    );
$$;

REVOKE ALL ON FUNCTION public.att_auth_company_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.att_auth_branch_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.att_auth_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.att_is_company_admin(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.att_is_company_member(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.att_auth_company_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.att_auth_branch_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.att_auth_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.att_is_company_admin(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.att_is_company_member(UUID) TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. SENSITIVE COLUMN & ANTI-TAMPERING GUARDS
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.att_protect_profile_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF COALESCE(current_setting('vectra.internal_rpc', true), 'off') = 'on' OR auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;

    -- Prevent any non-super_admin from assigning or escalating to super_admin
    IF NEW.role = 'super_admin'
       AND (TG_OP = 'INSERT' OR OLD.role IS DISTINCT FROM 'super_admin')
       AND public.att_auth_role() IS DISTINCT FROM 'super_admin' THEN
        RAISE EXCEPTION 'Unauthorized privilege escalation to super_admin'
            USING ERRCODE = '42501';
    END IF;

    -- Ensure branch assignment stays strictly inside the same company tenant
    IF NEW.branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.att_branches b
        WHERE b.id = NEW.branch_id
          AND b.company_id = NEW.company_id
    ) THEN
        RAISE EXCEPTION 'Invalid cross-tenant branch assignment'
            USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'INSERT' THEN
        RETURN NEW;
    END IF;

    -- Even company_admin cannot move an existing profile across tenants or change PK
    IF (NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id)
       AND public.att_auth_role() IS DISTINCT FROM 'super_admin' THEN
        RAISE EXCEPTION 'Unauthorized modification of immutable tenant or identity fields'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.att_is_company_admin(OLD.company_id) THEN
        IF NEW.role IS DISTINCT FROM OLD.role
           OR NEW.company_id IS DISTINCT FROM OLD.company_id
           OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
           OR NEW.employee_code IS DISTINCT FROM OLD.employee_code
           OR NEW.base_salary IS DISTINCT FROM OLD.base_salary
           OR NEW.daily_allowance IS DISTINCT FROM OLD.daily_allowance
           OR NEW.fixed_deduction IS DISTINCT FROM OLD.fixed_deduction
           OR NEW.leave_balance IS DISTINCT FROM OLD.leave_balance
           OR NEW.bound_device_hash IS DISTINCT FROM OLD.bound_device_hash
           OR NEW.device_bound_at IS DISTINCT FROM OLD.device_bound_at
           OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
            RAISE EXCEPTION 'Unauthorized modification of protected HR/security profile fields'
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_att_protect_profile_columns ON public.att_profiles;
CREATE TRIGGER trg_att_protect_profile_columns
    BEFORE INSERT OR UPDATE ON public.att_profiles
    FOR EACH ROW EXECUTE FUNCTION public.att_protect_profile_columns();

-- Guard immutable attendance audit columns against direct client UPDATE
CREATE OR REPLACE FUNCTION public.att_protect_attendance_log_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF COALESCE(current_setting('vectra.internal_rpc', true), 'off') = 'on' OR auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
       OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id
       OR NEW.work_date IS DISTINCT FROM OLD.work_date
       OR NEW.work_mode IS DISTINCT FROM OLD.work_mode
       OR NEW.clock_in_at IS DISTINCT FROM OLD.clock_in_at
       OR NEW.clock_out_at IS DISTINCT FROM OLD.clock_out_at
       OR NEW.clock_in_lat IS DISTINCT FROM OLD.clock_in_lat
       OR NEW.clock_in_lon IS DISTINCT FROM OLD.clock_in_lon
       OR NEW.clock_in_accuracy_m IS DISTINCT FROM OLD.clock_in_accuracy_m
       OR NEW.clock_in_distance_m IS DISTINCT FROM OLD.clock_in_distance_m
       OR NEW.clock_out_lat IS DISTINCT FROM OLD.clock_out_lat
       OR NEW.clock_out_lon IS DISTINCT FROM OLD.clock_out_lon
       OR NEW.clock_out_accuracy_m IS DISTINCT FROM OLD.clock_out_accuracy_m
       OR NEW.clock_out_distance_m IS DISTINCT FROM OLD.clock_out_distance_m
       OR NEW.clock_in_photo_url IS DISTINCT FROM OLD.clock_in_photo_url
       OR NEW.clock_out_photo_url IS DISTINCT FROM OLD.clock_out_photo_url
       OR NEW.late_minutes IS DISTINCT FROM OLD.late_minutes
       OR NEW.overtime_minutes IS DISTINCT FROM OLD.overtime_minutes
       OR NEW.work_duration_minutes IS DISTINCT FROM OLD.work_duration_minutes
       OR NEW.device_hash IS DISTINCT FROM OLD.device_hash
       OR NEW.verification_method IS DISTINCT FROM OLD.verification_method THEN
        RAISE EXCEPTION 'Attendance audit timestamps, GPS telemetry, and photo proofs are immutable'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'ABSENT' THEN
        RAISE EXCEPTION 'Flag review can only mark attendance status as ABSENT or leave it unchanged'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_att_protect_attendance_log_columns ON public.att_attendance_logs;
CREATE TRIGGER trg_att_protect_attendance_log_columns
    BEFORE UPDATE ON public.att_attendance_logs
    FOR EACH ROW EXECUTE FUNCTION public.att_protect_attendance_log_columns();

-- Guard att_requests workflow transitions & immutable fields
CREATE OR REPLACE FUNCTION public.att_protect_request_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF COALESCE(current_setting('vectra.internal_rpc', true), 'off') = 'on' OR auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
       OR NEW.target_employee_id IS DISTINCT FROM OLD.target_employee_id
       OR NEW.type IS DISTINCT FROM OLD.type
       OR NEW.start_date IS DISTINCT FROM OLD.start_date
       OR NEW.end_date IS DISTINCT FROM OLD.end_date
       OR NEW.hours_requested IS DISTINCT FROM OLD.hours_requested
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.attachment_url IS DISTINCT FROM OLD.attachment_url THEN
        RAISE EXCEPTION 'Request core fields cannot be altered after submission'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.att_is_company_admin(OLD.company_id) THEN
        IF public.att_auth_role() = 'supervisor' THEN
            IF OLD.status <> 'pending_supervisor'
               OR NEW.status NOT IN ('pending_hr', 'rejected')
               OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
               OR NEW.hr_action_at IS DISTINCT FROM OLD.hr_action_at THEN
                RAISE EXCEPTION 'Supervisor can only advance pending_supervisor requests to pending_hr or rejected'
                    USING ERRCODE = '42501';
            END IF;
        ELSIF OLD.employee_id = auth.uid() THEN
            IF OLD.status NOT IN ('pending_supervisor', 'pending_hr')
               OR NEW.status <> 'cancelled'
               OR NEW.supervisor_id IS DISTINCT FROM OLD.supervisor_id
               OR NEW.supervisor_action_at IS DISTINCT FROM OLD.supervisor_action_at
               OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
               OR NEW.hr_action_at IS DISTINCT FROM OLD.hr_action_at
               OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason THEN
                RAISE EXCEPTION 'Employees can only cancel their own pending requests'
                    USING ERRCODE = '42501';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_att_protect_request_columns ON public.att_requests;
CREATE TRIGGER trg_att_protect_request_columns
    BEFORE UPDATE ON public.att_requests
    FOR EACH ROW EXECUTE FUNCTION public.att_protect_request_columns();

-- ----------------------------------------------------------------------------
-- 3. ENABLE ROW LEVEL SECURITY ON ALL VECTRA TABLES
-- ----------------------------------------------------------------------------

ALTER TABLE public.att_company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.att_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.att_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.att_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.att_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.att_attendance_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.att_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.att_payrolls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.att_payroll_ledger_batches ENABLE ROW LEVEL SECURITY;

-- 3.1 att_company_settings
DROP POLICY IF EXISTS att_company_settings_select ON public.att_company_settings;
CREATE POLICY att_company_settings_select ON public.att_company_settings
    FOR SELECT TO authenticated
    USING (public.att_is_company_member(company_id));

DROP POLICY IF EXISTS att_company_settings_manage ON public.att_company_settings;
CREATE POLICY att_company_settings_manage ON public.att_company_settings
    FOR ALL TO authenticated
    USING (public.att_is_company_admin(company_id))
    WITH CHECK (public.att_is_company_admin(company_id));

-- 3.2 att_branches (Protect qr_secret_key column from direct client SELECT)
REVOKE SELECT ON public.att_branches FROM authenticated;
GRANT SELECT (id, company_id, name, code, address, latitude, longitude, radius_meters, is_active, created_at)
    ON public.att_branches TO authenticated;

DROP POLICY IF EXISTS att_branches_select ON public.att_branches;
CREATE POLICY att_branches_select ON public.att_branches
    FOR SELECT TO authenticated
    USING (public.att_is_company_member(company_id));

DROP POLICY IF EXISTS att_branches_manage ON public.att_branches;
CREATE POLICY att_branches_manage ON public.att_branches
    FOR ALL TO authenticated
    USING (public.att_is_company_admin(company_id))
    WITH CHECK (public.att_is_company_admin(company_id));

-- 3.3 att_profiles
DROP POLICY IF EXISTS att_profiles_select ON public.att_profiles;
CREATE POLICY att_profiles_select ON public.att_profiles
    FOR SELECT TO authenticated
    USING (
        public.att_is_company_admin(company_id)
        OR id = auth.uid()
        OR (
            public.att_is_company_member(company_id)
            AND public.att_auth_role() = 'supervisor'
            AND branch_id = public.att_auth_branch_id()
        )
    );

DROP POLICY IF EXISTS att_profiles_insert ON public.att_profiles;
CREATE POLICY att_profiles_insert ON public.att_profiles
    FOR INSERT TO authenticated
    WITH CHECK (
        public.att_is_company_admin(company_id)
        AND (role <> 'super_admin' OR public.att_auth_role() = 'super_admin')
    );

DROP POLICY IF EXISTS att_profiles_update ON public.att_profiles;
CREATE POLICY att_profiles_update ON public.att_profiles
    FOR UPDATE TO authenticated
    USING (public.att_is_company_admin(company_id) OR id = auth.uid())
    WITH CHECK (
        (public.att_is_company_admin(company_id) OR id = auth.uid())
        AND (role <> 'super_admin' OR public.att_auth_role() = 'super_admin')
    );

DROP POLICY IF EXISTS att_profiles_delete ON public.att_profiles;
CREATE POLICY att_profiles_delete ON public.att_profiles
    FOR DELETE TO authenticated
    USING (public.att_is_company_admin(company_id) AND id <> auth.uid());

-- 3.4 att_shifts
DROP POLICY IF EXISTS att_shifts_select ON public.att_shifts;
CREATE POLICY att_shifts_select ON public.att_shifts
    FOR SELECT TO authenticated
    USING (public.att_is_company_member(company_id));

DROP POLICY IF EXISTS att_shifts_manage ON public.att_shifts;
CREATE POLICY att_shifts_manage ON public.att_shifts
    FOR ALL TO authenticated
    USING (public.att_is_company_admin(company_id))
    WITH CHECK (public.att_is_company_admin(company_id));

-- 3.5 att_schedules
DROP POLICY IF EXISTS att_schedules_select ON public.att_schedules;
CREATE POLICY att_schedules_select ON public.att_schedules
    FOR SELECT TO authenticated
    USING (
        public.att_is_company_admin(company_id)
        OR employee_id = auth.uid()
        OR (
            public.att_is_company_member(company_id)
            AND public.att_auth_role() = 'supervisor'
            AND EXISTS (
                SELECT 1 FROM public.att_profiles p
                WHERE p.id = att_schedules.employee_id
                  AND p.company_id = att_schedules.company_id
                  AND p.branch_id = public.att_auth_branch_id()
            )
        )
    );

DROP POLICY IF EXISTS att_schedules_manage ON public.att_schedules;
CREATE POLICY att_schedules_manage ON public.att_schedules
    FOR ALL TO authenticated
    USING (
        public.att_is_company_admin(company_id)
        OR (
            public.att_is_company_member(company_id)
            AND public.att_auth_role() = 'supervisor'
            AND EXISTS (
                SELECT 1 FROM public.att_profiles p
                WHERE p.id = att_schedules.employee_id
                  AND p.company_id = att_schedules.company_id
                  AND p.branch_id = public.att_auth_branch_id()
            )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.att_shifts s
            WHERE s.id = att_schedules.shift_id
              AND s.company_id = att_schedules.company_id
        )
        AND EXISTS (
            SELECT 1 FROM public.att_profiles p
            WHERE p.id = att_schedules.employee_id
              AND p.company_id = att_schedules.company_id
              AND (
                  public.att_is_company_admin(att_schedules.company_id)
                  OR (
                      public.att_is_company_member(att_schedules.company_id)
                      AND public.att_auth_role() = 'supervisor'
                      AND p.branch_id = public.att_auth_branch_id()
                  )
              )
        )
    );

-- 3.6 att_attendance_logs (Inserts exclusively via SECURITY DEFINER RPCs)
DROP POLICY IF EXISTS att_logs_select ON public.att_attendance_logs;
CREATE POLICY att_logs_select ON public.att_attendance_logs
    FOR SELECT TO authenticated
    USING (
        public.att_is_company_admin(company_id)
        OR employee_id = auth.uid()
        OR (
            public.att_is_company_member(company_id)
            AND public.att_auth_role() = 'supervisor'
            AND branch_id = public.att_auth_branch_id()
        )
    );

DROP POLICY IF EXISTS att_logs_review_update ON public.att_attendance_logs;
CREATE POLICY att_logs_review_update ON public.att_attendance_logs
    FOR UPDATE TO authenticated
    USING (
        public.att_is_company_admin(company_id)
        OR (
            public.att_is_company_member(company_id)
            AND public.att_auth_role() = 'supervisor'
            AND branch_id = public.att_auth_branch_id()
        )
    )
    WITH CHECK (
        public.att_is_company_admin(company_id)
        OR (
            public.att_is_company_member(company_id)
            AND public.att_auth_role() = 'supervisor'
            AND branch_id = public.att_auth_branch_id()
        )
    );

-- 3.7 att_requests
DROP POLICY IF EXISTS att_requests_select ON public.att_requests;
CREATE POLICY att_requests_select ON public.att_requests
    FOR SELECT TO authenticated
    USING (
        public.att_is_company_admin(company_id)
        OR employee_id = auth.uid()
        OR target_employee_id = auth.uid()
        OR (
            public.att_is_company_member(company_id)
            AND public.att_auth_role() = 'supervisor'
            AND EXISTS (
                SELECT 1 FROM public.att_profiles p
                WHERE p.id = att_requests.employee_id
                  AND p.company_id = att_requests.company_id
                  AND p.branch_id = public.att_auth_branch_id()
            )
        )
    );

DROP POLICY IF EXISTS att_requests_insert ON public.att_requests;
CREATE POLICY att_requests_insert ON public.att_requests
    FOR INSERT TO authenticated
    WITH CHECK (
        public.att_is_company_member(company_id)
        AND EXISTS (
            SELECT 1 FROM public.att_profiles p
            WHERE p.id = att_requests.employee_id
              AND p.company_id = att_requests.company_id
        )
        AND (employee_id = auth.uid() OR public.att_is_company_admin(company_id))
    );

DROP POLICY IF EXISTS att_requests_update ON public.att_requests;
CREATE POLICY att_requests_update ON public.att_requests
    FOR UPDATE TO authenticated
    USING (
        public.att_is_company_admin(company_id)
        OR (
            public.att_is_company_member(company_id)
            AND public.att_auth_role() = 'supervisor'
            AND EXISTS (
                SELECT 1 FROM public.att_profiles p
                WHERE p.id = att_requests.employee_id
                  AND p.company_id = att_requests.company_id
                  AND p.branch_id = public.att_auth_branch_id()
            )
        )
        OR (employee_id = auth.uid() AND status IN ('pending_supervisor', 'pending_hr'))
    )
    WITH CHECK (
        public.att_is_company_admin(company_id)
        OR (
            public.att_is_company_member(company_id)
            AND public.att_auth_role() = 'supervisor'
            AND status IN ('pending_hr', 'rejected')
            AND EXISTS (
                SELECT 1 FROM public.att_profiles p
                WHERE p.id = att_requests.employee_id
                  AND p.company_id = att_requests.company_id
                  AND p.branch_id = public.att_auth_branch_id()
            )
        )
        OR (employee_id = auth.uid() AND status = 'cancelled')
    );

-- 3.8 att_payrolls
DROP POLICY IF EXISTS att_payrolls_select ON public.att_payrolls;
CREATE POLICY att_payrolls_select ON public.att_payrolls
    FOR SELECT TO authenticated
    USING (public.att_is_company_admin(company_id) OR employee_id = auth.uid());

DROP POLICY IF EXISTS att_payrolls_manage ON public.att_payrolls;
CREATE POLICY att_payrolls_manage ON public.att_payrolls
    FOR ALL TO authenticated
    USING (public.att_is_company_admin(company_id))
    WITH CHECK (public.att_is_company_admin(company_id));

-- 3.9 att_payroll_ledger_batches (Read-only for admins; written by post_payroll_to_ledger RPC)
DROP POLICY IF EXISTS att_ledger_batches_select ON public.att_payroll_ledger_batches;
CREATE POLICY att_ledger_batches_select ON public.att_payroll_ledger_batches
    FOR SELECT TO authenticated
    USING (public.att_is_company_admin(company_id));

-- 3.10 att_employee_invites (Admin-managed invites; employees claim via SECURITY DEFINER RPC)
CREATE OR REPLACE FUNCTION public.att_protect_invite_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
    IF COALESCE(current_setting('vectra.internal_rpc', true), 'off') = 'on' OR auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.role NOT IN ('company_admin', 'supervisor', 'employee') THEN
        RAISE EXCEPTION 'Unauthorized invite role assignment' USING ERRCODE = '42501';
    END IF;

    IF NEW.branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.att_branches b
        WHERE b.id = NEW.branch_id
          AND b.company_id = NEW.company_id
    ) THEN
        RAISE EXCEPTION 'Invalid cross-tenant branch in employee invite' USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.invite_token := 'VCT-' || upper(encode(gen_random_bytes(12), 'hex'));
        NEW.employee_code := upper(trim(NEW.employee_code));
        NEW.full_name := trim(NEW.full_name);
        NEW.email := lower(trim(NEW.email));
        NEW.invited_by := COALESCE(auth.uid(), NEW.invited_by);
        NEW.accepted_at := NULL;
        NEW.accepted_by := NULL;
        NEW.revoked_at := NULL;
        NEW.expires_at := LEAST(GREATEST(COALESCE(NEW.expires_at, now() + INTERVAL '7 days'), now() + INTERVAL '1 hour'), now() + INTERVAL '30 days');
        RETURN NEW;
    END IF;

    IF OLD.accepted_at IS NOT NULL THEN
        RAISE EXCEPTION 'Accepted invite records are immutable' USING ERRCODE = '42501';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.invite_token IS DISTINCT FROM OLD.invite_token
       OR NEW.email IS DISTINCT FROM OLD.email
       OR NEW.employee_code IS DISTINCT FROM OLD.employee_code
       OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
       OR NEW.accepted_by IS DISTINCT FROM OLD.accepted_by THEN
        RAISE EXCEPTION 'Invite core fields cannot be altered after creation; revoke and re-invite instead'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_att_protect_invite_columns ON public.att_employee_invites;
CREATE TRIGGER trg_att_protect_invite_columns
    BEFORE INSERT OR UPDATE ON public.att_employee_invites
    FOR EACH ROW EXECUTE FUNCTION public.att_protect_invite_columns();

ALTER TABLE public.att_employee_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS att_invites_admin_all ON public.att_employee_invites;
CREATE POLICY att_invites_admin_all ON public.att_employee_invites
    FOR ALL TO authenticated
    USING (public.att_is_company_admin(company_id))
    WITH CHECK (
        public.att_is_company_admin(company_id)
        AND role IN ('company_admin', 'supervisor', 'employee')
    );

-- ----------------------------------------------------------------------------
-- 4. SUPABASE STORAGE BUCKETS & FOLDER-SCOPED RLS POLICIES
-- ----------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
    ('attendance-selfies', 'attendance-selfies', false, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp']),
    ('request-attachments', 'request-attachments', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
ON CONFLICT (id) DO UPDATE
SET file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS att_storage_selfies_insert ON storage.objects;
CREATE POLICY att_storage_selfies_insert ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'attendance-selfies'
        AND (storage.foldername(name))[1] = public.att_auth_company_id()::text
        AND (storage.foldername(name))[2] = auth.uid()::text
    );

DROP POLICY IF EXISTS att_storage_selfies_select ON storage.objects;
CREATE POLICY att_storage_selfies_select ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'attendance-selfies'
        AND (
            public.att_auth_role() = 'super_admin'
            OR (
                (storage.foldername(name))[1] = public.att_auth_company_id()::text
                AND (
                    public.att_auth_role() = 'company_admin'
                    OR (storage.foldername(name))[2] = auth.uid()::text
                    OR (
                        public.att_auth_role() = 'supervisor'
                        AND EXISTS (
                            SELECT 1 FROM public.att_profiles p
                            WHERE p.id::text = (storage.foldername(name))[2]
                              AND p.company_id = public.att_auth_company_id()
                              AND p.branch_id = public.att_auth_branch_id()
                        )
                    )
                )
            )
        )
    );

DROP POLICY IF EXISTS att_storage_attachments_insert ON storage.objects;
CREATE POLICY att_storage_attachments_insert ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'request-attachments'
        AND (storage.foldername(name))[1] = public.att_auth_company_id()::text
        AND (storage.foldername(name))[2] = auth.uid()::text
    );

DROP POLICY IF EXISTS att_storage_attachments_select ON storage.objects;
CREATE POLICY att_storage_attachments_select ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'request-attachments'
        AND (
            public.att_auth_role() = 'super_admin'
            OR (
                (storage.foldername(name))[1] = public.att_auth_company_id()::text
                AND (
                    public.att_auth_role() = 'company_admin'
                    OR (storage.foldername(name))[2] = auth.uid()::text
                    OR (
                        public.att_auth_role() = 'supervisor'
                        AND EXISTS (
                            SELECT 1 FROM public.att_profiles p
                            WHERE p.id::text = (storage.foldername(name))[2]
                              AND p.company_id = public.att_auth_company_id()
                              AND p.branch_id = public.att_auth_branch_id()
                        )
                    )
                )
            )
        )
    );

COMMIT;
