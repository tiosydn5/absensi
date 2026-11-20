-- ============================================================================
-- VECTRA x KRONOS LEDGER — 20_att_seed_demo.sql
-- Idempotent Seed Dataset (ON CONFLICT DO NOTHING) aligned with Kronos Ledger
-- Creates Organization (auto-seeds Kronos CoA), 2 Branches (Jakarta & Depok),
-- 3 Shifts (incl. Cross-Day), 18 Employees, 30-Day Logs, Requests & Payrolls
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. ORGANIZATIONS (Triggers Kronos Ledger 06_org_onboarding_and_coa_seeder)
-- ----------------------------------------------------------------------------
INSERT INTO public.organizations (id, name, currency, tax_rate)
VALUES
    ('11111111-1111-4111-8111-111111111111', 'PT Nusantara Ritel Operasional', 'IDR', 0.50),
    ('11111111-1111-4111-8111-111111111112', 'PT Karya Logistik Mandiri', 'IDR', 0.50)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.att_company_settings (
    company_id, slug, subscription_plan, timezone, late_penalty_per_minute,
    salary_expense_account_code, cash_bank_account_code, tax_payable_account_code, payroll_payable_account_code
)
VALUES
    ('11111111-1111-4111-8111-111111111111', 'nusantara-ritel', 'ENTERPRISE', 'Asia/Jakarta', 1500.00, '6102', '1102', '2201', '2101'),
    ('11111111-1111-4111-8111-111111111112', 'karya-logistik', 'GROWTH', 'Asia/Jakarta', 1200.00, '6102', '1102', '2201', '2101')
ON CONFLICT (company_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. BRANCHES (Real Jakarta & Depok Coordinates)
-- ----------------------------------------------------------------------------
INSERT INTO public.att_branches (id, company_id, name, code, address, latitude, longitude, radius_meters, qr_secret_key, is_active)
VALUES
    (
        '22222222-2222-4222-8222-222222222201',
        '11111111-1111-4111-8111-111111111111',
        'Cabang Pusat Jakarta (Sudirman HQ)',
        'JKT-HQ',
        'Jl. Jend. Sudirman Kav. 52-53, Senayan, Kebayoran Baru, Jakarta Selatan 12190',
        -6.2087634,
        106.8205543,
        150,
        'vectra_jkt_hq_totp_secret_9a8f4e21',
        true
    ),
    (
        '22222222-2222-4222-8222-222222222202',
        '11111111-1111-4111-8111-111111111111',
        'Cabang Operasional Depok (Margonda Hub)',
        'DPK-01',
        'Jl. Margonda Raya No. 358, Kemiri Muka, Beji, Kota Depok 16423',
        -6.3726925,
        106.8323285,
        150,
        'vectra_dpk_hub_totp_secret_3c7b1d90',
        true
    )
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. SHIFTS (Pagi, Siang, Malam Cross-Day)
-- ----------------------------------------------------------------------------
INSERT INTO public.att_shifts (id, company_id, name, code, start_time, end_time, grace_period_minutes, is_cross_day, overtime_rate_multiplier)
VALUES
    ('33333333-3333-4333-8333-333333333301', '11111111-1111-4111-8111-111111111111', 'Shift Pagi Operasional', 'SHF-PG', '08:00:00', '17:00:00', 15, false, 1.50),
    ('33333333-3333-4333-8333-333333333302', '11111111-1111-4111-8111-111111111111', 'Shift Siang Ritel', 'SHF-SG', '14:00:00', '22:00:00', 15, false, 1.50),
    ('33333333-3333-4333-8333-333333333303', '11111111-1111-4111-8111-111111111111', 'Shift Malam Cross-Day', 'SHF-ML', '22:00:00', '06:00:00', 10, true, 2.00)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 4. AUTH USERS + ORGANIZATION MEMBERS + 18 EMPLOYEE PROFILES
-- Default password for Supabase Auth seed accounts: VectraDemo2026!
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_users JSONB := '[
        {"id":"44444444-4444-4444-8444-444444444401","branch":"22222222-2222-4222-8222-222222222201","code":"EMP-001","name":"Rizky Pratama","email":"rizky.hrd@nusantararitel.co.id","phone":"0812-8001-1001","role":"company_admin","org_role":"owner","dept":"HR & People","pos":"HRD Operations Lead","sal":14500000,"allow":75000,"ded":350000,"leave":12,"hash":"dev_8a91f0c2e41b"},
        {"id":"44444444-4444-4444-8444-444444444402","branch":"22222222-2222-4222-8222-222222222201","code":"EMP-002","name":"Hendra Wijaya","email":"hendra.spv@nusantararitel.co.id","phone":"0812-8001-1002","role":"supervisor","org_role":"staff","dept":"Operasional Toko","pos":"Branch Supervisor Jakarta","sal":9800000,"allow":60000,"ded":220000,"leave":11,"hash":"dev_3b77c910a22e"},
        {"id":"44444444-4444-4444-8444-444444444403","branch":"22222222-2222-4222-8222-222222222202","code":"EMP-003","name":"Ratna Sari Dewi","email":"ratna.spv@nusantararitel.co.id","phone":"0812-8001-1003","role":"supervisor","org_role":"staff","dept":"Gudang & Logistik","pos":"Branch Supervisor Depok","sal":9500000,"allow":60000,"ded":210000,"leave":10,"hash":"dev_71d4e890b12a"},
        {"id":"44444444-4444-4444-8444-444444444404","branch":"22222222-2222-4222-8222-222222222201","code":"EMP-004","name":"Dimas Anggara","email":"dimas.anggara@nusantararitel.co.id","phone":"0813-8001-1004","role":"employee","org_role":"staff","dept":"Operasional Toko","pos":"Senior Store Crew","sal":6200000,"allow":45000,"ded":140000,"leave":12,"hash":"dev_c492a1109f33"},
        {"id":"44444444-4444-4444-8444-444444444405","branch":"22222222-2222-4222-8222-222222222201","code":"EMP-005","name":"Nadia Kusuma","email":"nadia.kusuma@nusantararitel.co.id","phone":"0813-8001-1005","role":"employee","org_role":"staff","dept":"Kasir & POS","pos":"Lead Cashier","sal":5400000,"allow":40000,"ded":120000,"leave":9,"hash":"dev_e210b44318ad"},
        {"id":"44444444-4444-4444-8444-444444444406","branch":"22222222-2222-4222-8222-222222222201","code":"EMP-006","name":"Fajar Nugroho","email":"fajar.nugroho@nusantararitel.co.id","phone":"0813-8001-1006","role":"employee","org_role":"staff","dept":"Keamanan & Malam","pos":"Night Shift Lead","sal":5200000,"allow":45000,"ded":120000,"leave":12,"hash":"dev_99a3f11200ce"},
        {"id":"44444444-4444-4444-8444-444444444407","branch":"22222222-2222-4222-8222-222222222201","code":"EMP-007","name":"Sinta Rahmawati","email":"sinta.rahmawati@nusantararitel.co.id","phone":"0813-8001-1007","role":"employee","org_role":"accountant","dept":"Finance & Admin","pos":"Accounting Staff","sal":7100000,"allow":50000,"ded":165000,"leave":11,"hash":"dev_42fe0981ba11"},
        {"id":"44444444-4444-4444-8444-444444444408","branch":"22222222-2222-4222-8222-222222222201","code":"EMP-008","name":"Bagas Saputra","email":"bagas.saputra@nusantararitel.co.id","phone":"0813-8001-1008","role":"employee","org_role":"staff","dept":"IT & Support","pos":"POS Systems Engineer","sal":7800000,"allow":50000,"ded":180000,"leave":12,"hash":"dev_661ab90877cd"},
        {"id":"44444444-4444-4444-8444-444444444409","branch":"22222222-2222-4222-8222-222222222201","code":"EMP-009","name":"Putri Maharani","email":"putri.maharani@nusantararitel.co.id","phone":"0813-8001-1009","role":"employee","org_role":"staff","dept":"Kasir & POS","pos":"Cashier Staff","sal":5300000,"allow":40000,"ded":120000,"leave":10,"hash":"dev_109f22cd440a"},
        {"id":"44444444-4444-4444-8444-444444444410","branch":"22222222-2222-4222-8222-222222222201","code":"EMP-010","name":"Arif Setiawan","email":"arif.setiawan@nusantararitel.co.id","phone":"0813-8001-1010","role":"employee","org_role":"staff","dept":"Gudang & Logistik","pos":"Inventory Dispatcher","sal":5600000,"allow":45000,"ded":125000,"leave":8,"hash":"dev_5540de1189fa"},
        {"id":"44444444-4444-4444-8444-444444444411","branch":"22222222-2222-4222-8222-222222222202","code":"EMP-011","name":"Maya Puspita","email":"maya.puspita@nusantararitel.co.id","phone":"0815-8001-1011","role":"employee","org_role":"staff","dept":"Operasional Toko","pos":"Store Crew Depok","sal":5800000,"allow":45000,"ded":130000,"leave":12,"hash":"dev_ab2301ff884c"},
        {"id":"44444444-4444-4444-8444-444444444412","branch":"22222222-2222-4222-8222-222222222202","code":"EMP-012","name":"Eko Prasetyo","email":"eko.prasetyo@nusantararitel.co.id","phone":"0815-8001-1012","role":"employee","org_role":"staff","dept":"Gudang & Logistik","pos":"Warehouse Operator","sal":5500000,"allow":45000,"ded":125000,"leave":10,"hash":"dev_7721aa09cc12"},
        {"id":"44444444-4444-4444-8444-444444444413","branch":"22222222-2222-4222-8222-222222222202","code":"EMP-013","name":"Dewi Lestari","email":"dewi.lestari@nusantararitel.co.id","phone":"0815-8001-1013","role":"employee","org_role":"staff","dept":"Kasir & POS","pos":"Cashier Depok","sal":5100000,"allow":40000,"ded":115000,"leave":11,"hash":"dev_3019be4412aa"},
        {"id":"44444444-4444-4444-8444-444444444414","branch":"22222222-2222-4222-8222-222222222202","code":"EMP-014","name":"Yoga Permana","email":"yoga.permana@nusantararitel.co.id","phone":"0815-8001-1014","role":"employee","org_role":"staff","dept":"Keamanan & Malam","pos":"Night Security Depok","sal":5200000,"allow":45000,"ded":120000,"leave":12,"hash":"dev_8800cd2143ef"},
        {"id":"44444444-4444-4444-8444-444444444415","branch":"22222222-2222-4222-8222-222222222202","code":"EMP-015","name":"Tari Wulandari","email":"tari.wulandari@nusantararitel.co.id","phone":"0815-8001-1015","role":"employee","org_role":"staff","dept":"Operasional Toko","pos":"Visual Merchandiser","sal":5900000,"allow":45000,"ded":135000,"leave":9,"hash":"dev_4488fe1092bd"},
        {"id":"44444444-4444-4444-8444-444444444416","branch":"22222222-2222-4222-8222-222222222202","code":"EMP-016","name":"Ilham Ramadhan","email":"ilham.ramadhan@nusantararitel.co.id","phone":"0815-8001-1016","role":"employee","org_role":"staff","dept":"Gudang & Logistik","pos":"Field Courier Lead","sal":5700000,"allow":45000,"ded":130000,"leave":12,"hash":"dev_5190cc32ab01"},
        {"id":"44444444-4444-4444-8444-444444444417","branch":"22222222-2222-4222-8222-222222222201","code":"EMP-017","name":"Citra Ayu","email":"citra.ayu@nusantararitel.co.id","phone":"0812-8001-1017","role":"employee","org_role":"accountant","dept":"Finance & Admin","pos":"Payroll Specialist","sal":6900000,"allow":50000,"ded":155000,"leave":12,"hash":"dev_2091ef7780ca"},
        {"id":"44444444-4444-4444-8444-444444444418","branch":"22222222-2222-4222-8222-222222222202","code":"EMP-018","name":"Andi Kurniawan","email":"andi.kurniawan@nusantararitel.co.id","phone":"0815-8001-1018","role":"employee","org_role":"staff","dept":"IT & Support","pos":"Branch Tech Support","sal":7200000,"allow":50000,"ded":165000,"leave":10,"hash":"dev_9012aa4510de"}
    ]'::jsonb;
    v_item JSONB;
BEGIN
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_users)
    LOOP
        INSERT INTO auth.users (
            instance_id, id, aud, role, email, encrypted_password,
            email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
            created_at, updated_at
        )
        VALUES (
            '00000000-0000-0000-0000-000000000000',
            (v_item->>'id')::uuid,
            'authenticated',
            'authenticated',
            v_item->>'email',
            crypt('VectraDemo2026!', gen_salt('bf')),
            now(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('full_name', v_item->>'name'),
            now(),
            now()
        )
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO public.organization_members (org_id, user_id, role)
        VALUES (
            '11111111-1111-4111-8111-111111111111',
            (v_item->>'id')::uuid,
            v_item->>'org_role'
        )
        ON CONFLICT (org_id, user_id) DO NOTHING;

        INSERT INTO public.att_profiles (
            id, company_id, branch_id, employee_code, full_name, email, phone,
            role, department, position, base_salary, daily_allowance, fixed_deduction,
            leave_balance, bound_device_hash, device_bound_at, is_active
        )
        VALUES (
            (v_item->>'id')::uuid,
            '11111111-1111-4111-8111-111111111111',
            (v_item->>'branch')::uuid,
            v_item->>'code',
            v_item->>'name',
            v_item->>'email',
            v_item->>'phone',
            v_item->>'role',
            v_item->>'dept',
            v_item->>'pos',
            (v_item->>'sal')::numeric,
            (v_item->>'allow')::numeric,
            (v_item->>'ded')::numeric,
            (v_item->>'leave')::integer,
            v_item->>'hash',
            now() - INTERVAL '30 days',
            true
        )
        ON CONFLICT (id) DO NOTHING;
    END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 5. SCHEDULES & 30-DAY REALISTIC ATTENDANCE LOGS
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_today DATE := (now() AT TIME ZONE 'Asia/Jakarta')::date;
    v_d DATE;
    v_emp RECORD;
    v_shift_id UUID;
    v_mode TEXT;
    v_sched_id UUID;
    v_in_ts TIMESTAMPTZ;
    v_out_ts TIMESTAMPTZ;
    v_late INTEGER;
    v_ot INTEGER;
    v_dur INTEGER;
    v_status TEXT;
    v_dist DOUBLE PRECISION;
BEGIN
    FOR v_emp IN
        SELECT p.*, b.latitude AS b_lat, b.longitude AS b_lon
          FROM public.att_profiles p
          JOIN public.att_branches b ON b.id = p.branch_id
         WHERE p.company_id = '11111111-1111-4111-8111-111111111111'
    LOOP
        FOR i IN REVERSE 29..0 LOOP
            v_d := v_today - i;

            IF v_emp.employee_code IN ('EMP-006', 'EMP-014') THEN
                v_shift_id := '33333333-3333-4333-8333-333333333303';
            ELSIF v_emp.employee_code IN ('EMP-005', 'EMP-009', 'EMP-013', 'EMP-015') THEN
                v_shift_id := '33333333-3333-4333-8333-333333333302';
            ELSE
                v_shift_id := '33333333-3333-4333-8333-333333333301';
            END IF;

            IF (v_emp.employee_code IN ('EMP-006', 'EMP-014') AND EXTRACT(ISODOW FROM v_d) = 2)
               OR (v_emp.employee_code NOT IN ('EMP-006', 'EMP-014') AND EXTRACT(ISODOW FROM v_d) = 7) THEN
                v_mode := 'OFF';
            ELSIF v_emp.employee_code = 'EMP-008' AND EXTRACT(ISODOW FROM v_d) IN (3, 5) THEN
                v_mode := 'WFH';
            ELSIF v_emp.employee_code = 'EMP-016' AND EXTRACT(ISODOW FROM v_d) IN (2, 4) THEN
                v_mode := 'FIELD';
            ELSE
                v_mode := 'WFO';
            END IF;

            INSERT INTO public.att_schedules (company_id, employee_id, shift_id, work_date, work_mode)
            VALUES (v_emp.company_id, v_emp.id, v_shift_id, v_d, v_mode)
            ON CONFLICT (employee_id, work_date, shift_id) DO NOTHING
            RETURNING id INTO v_sched_id;

            IF v_sched_id IS NULL THEN
                SELECT id INTO v_sched_id FROM public.att_schedules
                WHERE employee_id = v_emp.id AND work_date = v_d AND shift_id = v_shift_id;
            END IF;

            IF v_mode = 'OFF' OR (i = 0 AND v_emp.employee_code IN ('EMP-013', 'EMP-009')) THEN
                CONTINUE;
            END IF;

            v_dist := 18.0 + ((ascii(substr(v_emp.employee_code, 7, 1)) + i) % 85);
            v_late := 0;
            v_ot := 0;

            IF v_shift_id = '33333333-3333-4333-8333-333333333303' THEN
                IF i = 0 THEN CONTINUE; END IF;
                v_in_ts := ((v_d::text || ' 21:54:00')::timestamp AT TIME ZONE 'Asia/Jakarta');
                v_ot := CASE WHEN i % 3 = 0 THEN 45 ELSE 15 END;
                v_out_ts := (((v_d + 1)::text || ' 06:00:00')::timestamp AT TIME ZONE 'Asia/Jakarta') + make_interval(mins => v_ot);
                v_status := 'ON_TIME';
            ELSIF v_shift_id = '33333333-3333-4333-8333-333333333302' THEN
                IF (i % 5 = 0 AND v_emp.employee_code IN ('EMP-005', 'EMP-015')) THEN
                    v_late := 22;
                    v_in_ts := ((v_d::text || ' 14:37:00')::timestamp AT TIME ZONE 'Asia/Jakarta');
                    v_status := 'LATE';
                ELSE
                    v_in_ts := ((v_d::text || ' 13:52:00')::timestamp AT TIME ZONE 'Asia/Jakarta');
                    v_status := 'ON_TIME';
                END IF;
                v_out_ts := CASE WHEN i = 0 THEN NULL ELSE ((v_d::text || ' 22:10:00')::timestamp AT TIME ZONE 'Asia/Jakarta') END;
                v_ot := CASE WHEN i = 0 THEN 0 ELSE 10 END;
            ELSE
                IF (i = 0 AND v_emp.employee_code IN ('EMP-004', 'EMP-011')) OR (i % 6 = 0 AND v_emp.employee_code = 'EMP-010') THEN
                    v_late := 18;
                    v_in_ts := ((v_d::text || ' 08:33:00')::timestamp AT TIME ZONE 'Asia/Jakarta');
                    v_status := 'LATE';
                ELSE
                    v_in_ts := ((v_d::text || ' 07:49:00')::timestamp AT TIME ZONE 'Asia/Jakarta');
                    v_status := CASE WHEN v_mode = 'WFH' THEN 'WFH' WHEN v_mode = 'FIELD' THEN 'FIELD' ELSE 'ON_TIME' END;
                END IF;
                IF i = 0 THEN
                    v_out_ts := NULL;
                ELSE
                    v_ot := CASE WHEN v_emp.employee_code IN ('EMP-004', 'EMP-007', 'EMP-016') AND i % 2 = 0 THEN 90 ELSE 0 END;
                    v_out_ts := ((v_d::text || ' 17:00:00')::timestamp AT TIME ZONE 'Asia/Jakarta') + make_interval(mins => v_ot);
                END IF;
            END IF;

            v_dur := CASE WHEN v_out_ts IS NOT NULL THEN FLOOR(EXTRACT(EPOCH FROM (v_out_ts - v_in_ts)) / 60.0)::INTEGER ELSE 0 END;

            INSERT INTO public.att_attendance_logs (
                company_id, employee_id, branch_id, schedule_id, work_date, work_mode,
                clock_in_at, clock_out_at, clock_in_lat, clock_in_lon, clock_in_accuracy_m, clock_in_distance_m,
                clock_out_lat, clock_out_lon, clock_out_accuracy_m, clock_out_distance_m,
                status, late_minutes, overtime_minutes, work_duration_minutes,
                is_flagged, flag_reason, device_hash, verification_method, notes
            )
            VALUES (
                v_emp.company_id, v_emp.id, v_emp.branch_id, v_sched_id, v_d, v_mode,
                v_in_ts, v_out_ts,
                v_emp.b_lat + ((i % 5) * 0.00012), v_emp.b_lon + ((i % 4) * 0.00011),
                14.5, v_dist,
                CASE WHEN v_out_ts IS NOT NULL THEN v_emp.b_lat ELSE NULL END,
                CASE WHEN v_out_ts IS NOT NULL THEN v_emp.b_lon ELSE NULL END,
                CASE WHEN v_out_ts IS NOT NULL THEN 16.0 ELSE NULL END,
                CASE WHEN v_out_ts IS NOT NULL THEN v_dist ELSE NULL END,
                v_status, v_late, v_ot, v_dur,
                false, NULL, v_emp.bound_device_hash,
                CASE WHEN v_mode = 'FIELD' THEN 'FIELD_GPS' WHEN i % 4 = 0 THEN 'KIOSK_QR' ELSE 'GPS_SELFIE' END,
                CASE WHEN v_mode = 'FIELD' THEN 'Pengiriman & audit stok vendor Jabodetabek' ELSE '' END
            )
            ON CONFLICT (employee_id, schedule_id) WHERE schedule_id IS NOT NULL DO NOTHING;
        END LOOP;
    END LOOP;

    UPDATE public.att_attendance_logs
       SET is_flagged = true,
           flag_reason = 'IMPOSSIBLE_TRAVEL_SPEED_412kmh',
           clock_in_accuracy_m = 42.0,
           clock_in_lat = -6.917464,
           clock_in_lon = 107.619123,
           clock_in_distance_m = 118400.0,
           notes = 'Anomali koordinat terdeteksi melompat ke Bandung lalu kembali ke Jakarta'
     WHERE employee_id = '44444444-4444-4444-8444-444444444410'
       AND work_date = v_today - 1;

    UPDATE public.att_attendance_logs
       SET is_flagged = true,
           flag_reason = 'MOCK_GPS_ZERO_ACCURACY',
           clock_in_accuracy_m = 0,
           notes = 'Akurasi GPS = 0m mengindikasikan aplikasi Mock Location / Fake GPS'
     WHERE employee_id = '44444444-4444-4444-8444-444444444412'
       AND work_date = v_today - 2;
END $$;

-- ----------------------------------------------------------------------------
-- 6. APPROVAL REQUESTS (LEAVE, SICK, OVERTIME, SHIFT_SWAP)
-- ----------------------------------------------------------------------------
INSERT INTO public.att_requests (
    id, company_id, employee_id, target_employee_id, type, start_date, end_date,
    hours_requested, reason, status, supervisor_id, supervisor_action_at, approved_by, hr_action_at
)
VALUES
    ('55555555-5555-4555-8555-555555555501', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444409', NULL, 'LEAVE', (now() AT TIME ZONE 'Asia/Jakarta')::date, (now() AT TIME ZONE 'Asia/Jakarta')::date + 1, 0, 'Cuti tahunan keperluan keluarga di Yogyakarta', 'approved', '44444444-4444-4444-8444-444444444402', now() - INTERVAL '2 days', '44444444-4444-4444-8444-444444444401', now() - INTERVAL '1 day'),
    ('55555555-5555-4555-8555-555555555502', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444411', NULL, 'OVERTIME', (now() AT TIME ZONE 'Asia/Jakarta')::date, (now() AT TIME ZONE 'Asia/Jakarta')::date, 3.0, 'Stock opname akhir periode di Cabang Margonda Depok', 'pending_supervisor', NULL, NULL, NULL, NULL),
    ('55555555-5555-4555-8555-555555555503', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444405', '44444444-4444-4444-8444-444444444409', 'SHIFT_SWAP', (now() AT TIME ZONE 'Asia/Jakarta')::date + 2, (now() AT TIME ZONE 'Asia/Jakarta')::date + 2, 0, 'Tukar shift siang ke shift pagi karena jadwal kontrol klinik', 'pending_hr', '44444444-4444-4444-8444-444444444402', now() - INTERVAL '4 hours', NULL, NULL),
    ('55555555-5555-4555-8555-555555555504', '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444415', NULL, 'SICK', (now() AT TIME ZONE 'Asia/Jakarta')::date + 1, (now() AT TIME ZONE 'Asia/Jakarta')::date + 1, 0, 'Demam tinggi, lampiran surat keterangan dokter klinik terlampir', 'pending_supervisor', NULL, NULL, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 7. SAMPLE FINALIZED PAYROLL LEDGER (READY FOR BATCH POSTING TO KRONOS LEDGER)
-- ----------------------------------------------------------------------------
INSERT INTO public.att_payrolls (
    company_id, employee_id, period_month, period_year,
    total_present, total_wfo_days, total_late_minutes, total_overtime_minutes, total_absent_days,
    base_salary, allowances_total, overtime_pay, deductions_total, fixed_deductions,
    net_salary, reference_no, status, generated_by, generated_at
)
SELECT
    p.company_id,
    p.id,
    EXTRACT(MONTH FROM ((now() AT TIME ZONE 'Asia/Jakarta')::date - INTERVAL '1 month'))::integer,
    EXTRACT(YEAR FROM ((now() AT TIME ZONE 'Asia/Jakarta')::date - INTERVAL '1 month'))::integer,
    24,
    22,
    CASE WHEN p.employee_code IN ('EMP-004', 'EMP-010') THEN 35 ELSE 0 END,
    CASE WHEN p.employee_code IN ('EMP-006', 'EMP-014') THEN 360 ELSE 180 END,
    0,
    p.base_salary,
    22 * p.daily_allowance,
    ROUND(((CASE WHEN p.employee_code IN ('EMP-006', 'EMP-014') THEN 6.0 ELSE 3.0 END) * 1.5 * (p.base_salary / 173.0))::numeric, 2),
    CASE WHEN p.employee_code IN ('EMP-004', 'EMP-010') THEN 52500.00 ELSE 0.00 END,
    p.fixed_deduction,
    ROUND((
        p.base_salary
        + (22 * p.daily_allowance)
        + ((CASE WHEN p.employee_code IN ('EMP-006', 'EMP-014') THEN 6.0 ELSE 3.0 END) * 1.5 * (p.base_salary / 173.0))
        - (CASE WHEN p.employee_code IN ('EMP-004', 'EMP-010') THEN 52500.00 ELSE 0.00 END)
        - p.fixed_deduction
    )::numeric, 2),
    format(
        'PAY-%s%s-%s',
        EXTRACT(YEAR FROM ((now() AT TIME ZONE 'Asia/Jakarta')::date - INTERVAL '1 month'))::integer,
        LPAD(EXTRACT(MONTH FROM ((now() AT TIME ZONE 'Asia/Jakarta')::date - INTERVAL '1 month'))::text, 2, '0'),
        p.employee_code
    ),
    'FINALIZED',
    '44444444-4444-4444-8444-444444444401',
    now() - INTERVAL '15 days'
FROM public.att_profiles p
WHERE p.company_id = '11111111-1111-4111-8111-111111111111'
ON CONFLICT (company_id, employee_id, period_month, period_year) DO NOTHING;

COMMIT;
