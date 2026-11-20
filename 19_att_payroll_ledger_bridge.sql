-- ============================================================================
-- VECTRA x KRONOS LEDGER — 19_att_payroll_ledger_bridge.sql
-- Monthly Payroll Generator & Idempotent Batch Bridge to Kronos Ledger
-- Raw attendance logs NEVER touch accounting; ONLY FINALIZED payroll batches post.
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. RPC: generate_monthly_payroll
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.generate_monthly_payroll(
    p_company_id UUID,
    p_month INTEGER,
    p_year INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_settings public.att_company_settings%ROWTYPE;
    v_period_start DATE;
    v_period_end DATE;
    v_emp RECORD;
    v_agg RECORD;
    v_scheduled_days INTEGER;
    v_absent_days INTEGER;
    v_hourly_rate NUMERIC(14, 4);
    v_ot_hours NUMERIC(10, 4);
    v_ot_pay NUMERIC(14, 2);
    v_allowances NUMERIC(14, 2);
    v_deductions NUMERIC(14, 2);
    v_net NUMERIC(14, 2);
    v_ref TEXT;
    v_processed INTEGER := 0;
    v_total_payout NUMERIC(16, 2) := 0;
BEGIN
    IF NOT public.att_is_company_admin(p_company_id) THEN
        RAISE EXCEPTION 'Hanya HRD Admin, Owner, atau Accountant yang berhak generate payroll.'
            USING ERRCODE = '42501';
    END IF;

    IF p_month IS NULL OR p_month < 1 OR p_month > 12 OR p_year IS NULL OR p_year < 2020 OR p_year > 2100 THEN
        RAISE EXCEPTION 'Periode payroll tidak valid (%/%).', p_month, p_year
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_company_id) THEN
        RAISE EXCEPTION 'Organisasi % tidak ditemukan.', p_company_id;
    END IF;

    SELECT * INTO v_settings FROM public.att_company_settings WHERE company_id = p_company_id;

    v_period_start := make_date(p_year, p_month, 1);
    v_period_end := (v_period_start + INTERVAL '1 month - 1 day')::date;

    FOR v_emp IN
        SELECT * FROM public.att_profiles
        WHERE company_id = p_company_id AND is_active = true
    LOOP
        SELECT
            COUNT(DISTINCT work_date)::INTEGER AS present_days,
            COUNT(DISTINCT work_date) FILTER (WHERE work_mode = 'WFO')::INTEGER AS wfo_days,
            COALESCE(SUM(late_minutes), 0)::INTEGER AS late_mins,
            COALESCE(SUM(overtime_minutes), 0)::INTEGER AS ot_mins
          INTO v_agg
          FROM public.att_attendance_logs
         WHERE company_id = p_company_id
           AND employee_id = v_emp.id
           AND work_date BETWEEN v_period_start AND v_period_end
           AND status <> 'ABSENT'
           AND (is_flagged = false OR flag_reviewed_at IS NOT NULL);

        SELECT COUNT(DISTINCT work_date)::INTEGER
          INTO v_scheduled_days
          FROM public.att_schedules
         WHERE company_id = p_company_id
           AND employee_id = v_emp.id
           AND work_date BETWEEN v_period_start AND LEAST(v_period_end, (now() AT TIME ZONE COALESCE(v_settings.timezone, 'Asia/Jakarta'))::date)
           AND work_mode <> 'OFF';

        v_absent_days := GREATEST(0, COALESCE(v_scheduled_days, 0) - COALESCE(v_agg.present_days, 0));

        -- Standard Indonesian Depnaker 1/173 divisor
        v_hourly_rate := v_emp.base_salary / 173.0;
        v_ot_hours := COALESCE(v_agg.ot_mins, 0) / 60.0;

        IF v_ot_hours <= 20 THEN
            v_ot_pay := ROUND((v_ot_hours * 1.5 * v_hourly_rate)::numeric, 2);
        ELSE
            v_ot_pay := ROUND((((20.0 * 1.5) + ((v_ot_hours - 20.0) * 2.0)) * v_hourly_rate)::numeric, 2);
        END IF;

        v_allowances := ROUND((COALESCE(v_agg.wfo_days, 0) * v_emp.daily_allowance)::numeric, 2);
        v_deductions := ROUND((
            (COALESCE(v_agg.late_mins, 0) * COALESCE(v_settings.late_penalty_per_minute, 1500.00))
            + (v_absent_days * (v_emp.base_salary / 22.0))
        )::numeric, 2);

        v_net := GREATEST(0, ROUND((v_emp.base_salary + v_allowances + v_ot_pay - v_deductions - v_emp.fixed_deduction)::numeric, 2));
        v_ref := format('PAY-%s%s-%s', p_year, LPAD(p_month::text, 2, '0'), v_emp.employee_code);

        INSERT INTO public.att_payrolls (
            company_id, employee_id, period_month, period_year,
            total_present, total_wfo_days, total_late_minutes, total_overtime_minutes, total_absent_days,
            base_salary, allowances_total, overtime_pay, deductions_total, fixed_deductions,
            net_salary, reference_no, status, generated_by, generated_at
        )
        VALUES (
            p_company_id, v_emp.id, p_month, p_year,
            COALESCE(v_agg.present_days, 0), COALESCE(v_agg.wfo_days, 0), COALESCE(v_agg.late_mins, 0), COALESCE(v_agg.ot_mins, 0), v_absent_days,
            v_emp.base_salary, v_allowances, v_ot_pay, v_deductions, v_emp.fixed_deduction,
            v_net, v_ref, 'DRAFT', auth.uid(), now()
        )
        ON CONFLICT (company_id, employee_id, period_month, period_year) DO UPDATE
        SET total_present = EXCLUDED.total_present,
            total_wfo_days = EXCLUDED.total_wfo_days,
            total_late_minutes = EXCLUDED.total_late_minutes,
            total_overtime_minutes = EXCLUDED.total_overtime_minutes,
            total_absent_days = EXCLUDED.total_absent_days,
            base_salary = EXCLUDED.base_salary,
            allowances_total = EXCLUDED.allowances_total,
            overtime_pay = EXCLUDED.overtime_pay,
            deductions_total = EXCLUDED.deductions_total,
            fixed_deductions = EXCLUDED.fixed_deductions,
            net_salary = EXCLUDED.net_salary,
            reference_no = EXCLUDED.reference_no,
            generated_by = EXCLUDED.generated_by,
            generated_at = now()
        WHERE public.att_payrolls.status = 'DRAFT'
          AND public.att_payrolls.ledger_transaction_id IS NULL;
    END LOOP;

    SELECT
        COUNT(*)::INTEGER,
        ROUND(COALESCE(SUM(net_salary), 0)::numeric, 2)
      INTO v_processed, v_total_payout
      FROM public.att_payrolls
     WHERE company_id = p_company_id
       AND period_month = p_month
       AND period_year = p_year;

    RETURN jsonb_build_object(
        'success', true,
        'period_month', p_month,
        'period_year', p_year,
        'employees_processed', v_processed,
        'total_net_payout', v_total_payout,
        'generated_at', now()
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. RPC: post_payroll_to_ledger (Batch, FINALIZED-only, Idempotent)
-- Posts one balanced summary journal entry to Kronos Ledger per period batch:
--   DR 6102 Beban Gaji              = SUM(net_salary + fixed_deductions)
--   CR 1102 Bank BCA (or 1101/2101) = SUM(net_salary)
--   CR 2201 Utang Pajak PPN/PPh     = SUM(fixed_deductions) [if > 0]
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.post_payroll_to_ledger(
    p_company_id UUID,
    p_month INTEGER,
    p_year INTEGER,
    p_payment_account_code TEXT DEFAULT '1102',
    p_source_ref TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_now TIMESTAMPTZ := now();
    v_settings public.att_company_settings%ROWTYPE;
    v_source_ref TEXT;
    v_explicit_pay_code TEXT;
    v_existing public.att_payroll_ledger_batches%ROWTYPE;
    v_emp_count INTEGER := 0;
    v_total_net NUMERIC(15, 2) := 0.00;
    v_total_tax_ded NUMERIC(15, 2) := 0.00;
    v_total_gross_expense NUMERIC(15, 2) := 0.00;
    v_exp_acc_id UUID;
    v_pay_acc_id UUID;
    v_tax_acc_id UUID;
    v_exp_code TEXT;
    v_pay_code TEXT;
    v_tax_code TEXT;
    v_lines JSONB := '[]'::JSONB;
    v_tx_id UUID;
    v_tx_date DATE;
    v_mark_paid BOOLEAN := false;
BEGIN
    IF NOT public.att_is_company_admin(p_company_id) THEN
        RAISE EXCEPTION 'Hanya HRD Admin, Owner, atau Accountant yang berhak memposting payroll ke Kronos Ledger.'
            USING ERRCODE = '42501';
    END IF;

    IF p_month IS NULL OR p_month < 1 OR p_month > 12 OR p_year IS NULL OR p_year < 2020 OR p_year > 2100 THEN
        RAISE EXCEPTION 'Periode payroll tidak valid (%/%).', p_month, p_year
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_settings FROM public.att_company_settings WHERE company_id = p_company_id;
    v_source_ref := COALESCE(
        NULLIF(trim(p_source_ref), ''),
        format('PAYROLL-%s%s-BATCH', p_year, LPAD(p_month::text, 2, '0'))
    );

    -- Serialize concurrent batch postings for the same company/period/source_ref
    PERFORM pg_advisory_xact_lock(hashtext(p_company_id::text || ':' || p_year::text || ':' || p_month::text || ':' || v_source_ref));

    -- Idempotency check (also protected by UNIQUE (company_id, period_year, period_month, source_ref))
    SELECT * INTO v_existing
      FROM public.att_payroll_ledger_batches
     WHERE company_id = p_company_id
       AND period_year = p_year
       AND period_month = p_month
       AND source_ref = v_source_ref;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'success', true,
            'already_posted', true,
            'batch_id', v_existing.id,
            'transaction_id', v_existing.transaction_id,
            'source_ref', v_existing.source_ref,
            'employees_count', v_existing.employees_count,
            'total_gross_expense', v_existing.total_gross_expense,
            'total_net_salary', v_existing.total_net_salary,
            'total_fixed_deductions', v_existing.total_fixed_deductions,
            'posted_at', v_existing.posted_at,
            'message', format('Batch %s sudah pernah diposting ke Kronos Ledger (idempotent guard aktif).', v_existing.source_ref)
        );
    END IF;

    -- Aggregate strictly FINALIZED payrolls that have not yet been posted
    SELECT
        COUNT(*)::INTEGER,
        ROUND(COALESCE(SUM(net_salary), 0)::numeric, 2),
        ROUND(COALESCE(SUM(fixed_deductions), 0)::numeric, 2)
      INTO v_emp_count, v_total_net, v_total_tax_ded
      FROM public.att_payrolls
     WHERE company_id = p_company_id
       AND period_month = p_month
       AND period_year = p_year
       AND status = 'FINALIZED'
       AND ledger_transaction_id IS NULL;

    IF v_emp_count = 0 THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'NO_FINALIZED_PAYROLL',
            'message', format('Tidak ditemukan slip payroll berstatus FINALIZED untuk periode %s/%s yang belum diposting.', LPAD(p_month::text, 2, '0'), p_year)
        );
    END IF;

    v_total_gross_expense := ROUND((v_total_net + v_total_tax_ded)::numeric, 2);
    IF v_total_gross_expense <= 0 THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'ZERO_AMOUNT',
            'message', 'Total beban payroll bernilai nol, tidak dapat membuat jurnal akuntansi.'
        );
    END IF;

    -- Resolve Kronos Ledger Chart of Accounts (06_org_onboarding_and_coa_seeder.sql)
    v_exp_code := COALESCE(NULLIF(trim(v_settings.salary_expense_account_code), ''), '6102');
    v_explicit_pay_code := NULLIF(trim(COALESCE(p_payment_account_code, '')), '');
    v_pay_code := COALESCE(v_explicit_pay_code, COALESCE(NULLIF(trim(v_settings.cash_bank_account_code), ''), '1102'));
    v_tax_code := COALESCE(NULLIF(trim(v_settings.tax_payable_account_code), ''), '2201');

    SELECT id INTO v_exp_acc_id FROM public.accounts WHERE org_id = p_company_id AND code = v_exp_code LIMIT 1;
    IF v_exp_acc_id IS NULL THEN
        SELECT id INTO v_exp_acc_id FROM public.accounts WHERE org_id = p_company_id AND category = 'EXPENSE' ORDER BY code LIMIT 1;
    END IF;

    SELECT id INTO v_pay_acc_id FROM public.accounts WHERE org_id = p_company_id AND code = v_pay_code LIMIT 1;
    IF v_pay_acc_id IS NULL AND v_explicit_pay_code IS NULL THEN
        SELECT id INTO v_pay_acc_id FROM public.accounts WHERE org_id = p_company_id AND code = '1101' LIMIT 1;
        IF v_pay_acc_id IS NOT NULL THEN
            v_pay_code := '1101';
        END IF;
    END IF;

    SELECT id INTO v_tax_acc_id FROM public.accounts WHERE org_id = p_company_id AND code = v_tax_code LIMIT 1;

    IF v_exp_acc_id IS NULL OR v_pay_acc_id IS NULL THEN
        RAISE EXCEPTION 'Akun CoA Kronos Ledger tidak lengkap (butuh akun Beban Gaji % dan akun pembayaran % untuk org %).',
            v_exp_code, v_pay_code, p_company_id
            USING ERRCODE = 'P0002';
    END IF;

    -- Build balanced double-entry journal lines
    v_lines := jsonb_build_array(
        jsonb_build_object('account_id', v_exp_acc_id, 'debit', v_total_gross_expense, 'credit', 0)
    );

    IF v_total_net > 0 THEN
        v_lines := v_lines || jsonb_build_array(
            jsonb_build_object('account_id', v_pay_acc_id, 'debit', 0, 'credit', v_total_net)
        );
    END IF;

    IF v_total_tax_ded > 0 THEN
        IF v_tax_acc_id IS NOT NULL THEN
            v_lines := v_lines || jsonb_build_array(
                jsonb_build_object('account_id', v_tax_acc_id, 'debit', 0, 'credit', v_total_tax_ded)
            );
        ELSE
            -- Fallback if 2201 removed: credit full gross to payment account to preserve double-entry balance
            v_lines := jsonb_build_array(
                jsonb_build_object('account_id', v_exp_acc_id, 'debit', v_total_gross_expense, 'credit', 0),
                jsonb_build_object('account_id', v_pay_acc_id, 'debit', 0, 'credit', v_total_gross_expense)
            );
        END IF;
    END IF;

    v_tx_date := (v_now AT TIME ZONE COALESCE(v_settings.timezone, 'Asia/Jakarta'))::date;

    -- Post atomically via Kronos Ledger RPC (auto-updates account balances & audit_logs)
    PERFORM set_config('kronos.internal_tx_call', 'true', true);
    v_tx_id := public.post_double_entry_transaction(
        p_company_id,
        v_tx_date,
        v_source_ref,
        format('Batch Payroll Periode %s/%s (%s Karyawan)', LPAD(p_month::text, 2, '0'), p_year, v_emp_count),
        v_lines,
        'POSTED'
    );
    PERFORM set_config('kronos.internal_tx_call', 'false', true);

    INSERT INTO public.att_payroll_ledger_batches (
        company_id, period_year, period_month, source_ref, transaction_id,
        employees_count, total_gross_expense, total_net_salary, total_fixed_deductions,
        posted_by, posted_at
    )
    VALUES (
        p_company_id, p_year, p_month, v_source_ref, v_tx_id,
        v_emp_count, v_total_gross_expense, v_total_net, v_total_tax_ded,
        auth.uid(), v_now
    );

    -- Mark settled payrolls as PAID when paid directly from Cash/Bank (11xx)
    v_mark_paid := left(v_pay_code, 2) = '11';

    UPDATE public.att_payrolls
       SET ledger_transaction_id = v_tx_id,
           ledger_posted_at = v_now,
           status = CASE WHEN v_mark_paid THEN 'PAID' ELSE status END
     WHERE company_id = p_company_id
       AND period_month = p_month
       AND period_year = p_year
       AND status = 'FINALIZED'
       AND ledger_transaction_id IS NULL;

    RETURN jsonb_build_object(
        'success', true,
        'already_posted', false,
        'transaction_id', v_tx_id,
        'source_ref', v_source_ref,
        'employees_count', v_emp_count,
        'total_gross_expense', v_total_gross_expense,
        'total_net_salary', v_total_net,
        'total_fixed_deductions', v_total_tax_ded,
        'payment_account_code', v_pay_code,
        'marked_paid', v_mark_paid,
        'posted_at', v_now
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. EXECUTION PERMISSIONS
-- ----------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.generate_monthly_payroll(UUID, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.post_payroll_to_ledger(UUID, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.generate_monthly_payroll(UUID, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.post_payroll_to_ledger(UUID, INTEGER, INTEGER, TEXT, TEXT) TO authenticated;

COMMIT;
