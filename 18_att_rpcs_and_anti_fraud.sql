-- ============================================================================
-- VECTRA x KRONOS LEDGER — 18_att_rpcs_and_anti_fraud.sql
-- Server-Time Attendance RPCs (submit_clock_in, submit_clock_out, get_dashboard_kpis, Kiosk QR)
-- All timestamps use PostgreSQL now(); raw attendance logs never write to ledger.
-- ============================================================================

BEGIN;

SET LOCAL search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. SERVER-SIDE HAVERSINE DISTANCE (Meters)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.calculate_haversine_meters(
    lat1 DOUBLE PRECISION,
    lon1 DOUBLE PRECISION,
    lat2 DOUBLE PRECISION,
    lon2 DOUBLE PRECISION
)
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
    v_earth_radius CONSTANT DOUBLE PRECISION := 6371000.0;
    v_dlat DOUBLE PRECISION;
    v_dlon DOUBLE PRECISION;
    v_a DOUBLE PRECISION;
    v_c DOUBLE PRECISION;
BEGIN
    IF lat1 IS NULL OR lon1 IS NULL OR lat2 IS NULL OR lon2 IS NULL THEN
        RETURN NULL;
    END IF;
    v_dlat := radians(lat2 - lat1);
    v_dlon := radians(lon2 - lon1);
    v_a := sin(v_dlat / 2.0) ^ 2
         + cos(radians(lat1)) * cos(radians(lat2)) * (sin(v_dlon / 2.0) ^ 2);
    v_c := 2.0 * atan2(sqrt(v_a), sqrt(GREATEST(0.0, 1.0 - v_a)));
    RETURN ROUND((v_earth_radius * v_c)::numeric, 2)::DOUBLE PRECISION;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. RPCs: Kiosk Rotating TOTP QR (Secret never leaves server)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_kiosk_qr_token(
    p_branch_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_now TIMESTAMPTZ := now();
    v_branch public.att_branches%ROWTYPE;
    v_slice BIGINT;
    v_expires_in_sec INTEGER;
    v_token TEXT;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Sesi login tidak valid.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_branch FROM public.att_branches WHERE id = p_branch_id AND is_active = true;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cabang aktif tidak ditemukan.' USING ERRCODE = 'P0002';
    END IF;

    IF NOT (
        public.att_auth_role() = 'super_admin'
        OR public.att_is_company_admin(v_branch.company_id)
        OR (
            public.att_is_company_member(v_branch.company_id)
            AND public.att_auth_role() = 'supervisor'
            AND public.att_auth_branch_id() = v_branch.id
        )
    ) THEN
        RAISE EXCEPTION 'Hanya Admin HRD atau Supervisor cabang terkait yang berhak mengakses token Kiosk QR.'
            USING ERRCODE = '42501';
    END IF;

    v_slice := FLOOR(EXTRACT(EPOCH FROM v_now) / 15.0)::BIGINT;
    v_expires_in_sec := GREATEST(1, (15 - (FLOOR(EXTRACT(EPOCH FROM v_now))::BIGINT % 15))::INTEGER);
    v_token := upper(substr(encode(digest(v_branch.qr_secret_key || ':' || v_branch.code || ':' || v_slice::text, 'sha256'), 'hex'), 1, 10));

    RETURN jsonb_build_object(
        'token', v_token,
        'slice', v_slice,
        'expiresInSec', v_expires_in_sec,
        'expires_in_sec', v_expires_in_sec,
        'payload', format('VECTRA|%s|%s|%s', v_branch.code, v_slice::text, v_token),
        'branch_code', v_branch.code
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.verify_kiosk_qr_token(
    p_branch_id UUID,
    p_qr_payload TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_now TIMESTAMPTZ := now();
    v_branch public.att_branches%ROWTYPE;
    v_parts TEXT[];
    v_current_slice BIGINT;
    v_parsed_slice BIGINT;
    v_expected TEXT;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Sesi login tidak valid.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_branch FROM public.att_branches WHERE id = p_branch_id AND is_active = true;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Cabang tidak ditemukan atau nonaktif.');
    END IF;

    IF NOT (public.att_auth_role() = 'super_admin' OR public.att_is_company_member(v_branch.company_id)) THEN
        RAISE EXCEPTION 'Akses cabang ditolak.' USING ERRCODE = '42501';
    END IF;

    IF p_qr_payload IS NULL OR char_length(trim(p_qr_payload)) = 0 THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Payload QR kosong.');
    END IF;

    v_parts := string_to_array(trim(p_qr_payload), '|');
    IF array_length(v_parts, 1) IS DISTINCT FROM 4 OR v_parts[1] <> 'VECTRA' THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Format token QR VECTRA tidak dikenali.');
    END IF;

    IF v_parts[2] <> v_branch.code THEN
        RETURN jsonb_build_object('valid', false, 'reason', format('QR milik cabang %s, bukan cabang Anda (%s).', v_parts[2], v_branch.code));
    END IF;

    IF v_parts[3] !~ '^[0-9]+$' OR v_parts[4] !~ '^[A-F0-9]{10}$' THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Format potongan waktu atau token QR tidak valid.');
    END IF;

    v_parsed_slice := v_parts[3]::BIGINT;
    v_current_slice := FLOOR(EXTRACT(EPOCH FROM v_now) / 15.0)::BIGINT;
    IF v_parsed_slice < (v_current_slice - 1) OR v_parsed_slice > (v_current_slice + 1) THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Token QR sudah kedaluwarsa (melebihi jendela 15 detik).');
    END IF;

    v_expected := upper(substr(encode(digest(v_branch.qr_secret_key || ':' || v_branch.code || ':' || v_parsed_slice::text, 'sha256'), 'hex'), 1, 10));
    IF v_expected <> v_parts[4] THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Tanda tangan kriptografis QR tidak cocok.');
    END IF;

    RETURN jsonb_build_object('valid', true, 'slice', v_parsed_slice, 'token', v_parts[4]);
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. RPC: submit_clock_in
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.submit_clock_in(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.submit_clock_in(
    p_lat DOUBLE PRECISION,
    p_lon DOUBLE PRECISION,
    p_accuracy_m DOUBLE PRECISION,
    p_device_hash TEXT,
    p_photo_url TEXT,
    p_work_mode TEXT DEFAULT 'WFO',
    p_verification_method TEXT DEFAULT 'GPS_SELFIE',
    p_notes TEXT DEFAULT '',
    p_qr_payload TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_now TIMESTAMPTZ := now();
    v_uid UUID := auth.uid();
    v_profile public.att_profiles%ROWTYPE;
    v_settings public.att_company_settings%ROWTYPE;
    v_branch public.att_branches%ROWTYPE;
    v_qr_res JSONB;
    v_tz TEXT;
    v_local_date DATE;
    v_schedule RECORD;
    v_prev_log RECORD;
    v_distance_m DOUBLE PRECISION;
    v_travel_m DOUBLE PRECISION;
    v_elapsed_hrs DOUBLE PRECISION;
    v_speed_kmh DOUBLE PRECISION := 0;
    v_is_flagged BOOLEAN := false;
    v_flag_reasons TEXT[] := ARRAY[]::TEXT[];
    v_late_minutes INTEGER := 0;
    v_status TEXT := 'ON_TIME';
    v_shift_start_ts TIMESTAMPTZ;
    v_grace_cutoff_ts TIMESTAMPTZ;
    v_inserted_id UUID;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'UNAUTHENTICATED', 'message', 'Sesi login tidak valid.');
    END IF;

    IF p_work_mode NOT IN ('WFO', 'WFH', 'FIELD') THEN
        RETURN jsonb_build_object('success', false, 'code', 'INVALID_MODE', 'message', 'Mode kerja tidak valid.');
    END IF;

    IF p_verification_method IS NULL OR p_verification_method NOT IN ('GPS_SELFIE', 'KIOSK_QR', 'OFFLINE_SYNC') THEN
        RETURN jsonb_build_object('success', false, 'code', 'INVALID_METHOD', 'message', 'Metode verifikasi absensi tidak valid.');
    END IF;

    IF (p_lat IS NOT NULL AND (p_lat <> p_lat OR p_lat < -90 OR p_lat > 90))
       OR (p_lon IS NOT NULL AND (p_lon <> p_lon OR p_lon < -180 OR p_lon > 180))
       OR ((p_lat IS NULL) <> (p_lon IS NULL)) THEN
        RETURN jsonb_build_object('success', false, 'code', 'INVALID_COORDS', 'message', 'Koordinat GPS berada di luar rentang valid.');
    END IF;

    SELECT * INTO v_profile FROM public.att_profiles WHERE id = v_uid;
    IF NOT FOUND OR NOT v_profile.is_active THEN
        RETURN jsonb_build_object('success', false, 'code', 'INACTIVE_PROFILE', 'message', 'Akun karyawan tidak ditemukan atau nonaktif.');
    END IF;

    SELECT * INTO v_settings FROM public.att_company_settings WHERE company_id = v_profile.company_id;
    v_tz := COALESCE(v_settings.timezone, 'Asia/Jakarta');
    v_local_date := (v_now AT TIME ZONE v_tz)::date;

    IF p_device_hash IS NULL OR char_length(trim(p_device_hash)) < 8 THEN
        RETURN jsonb_build_object('success', false, 'code', 'INVALID_DEVICE', 'message', 'Fingerprint perangkat tidak valid.');
    END IF;

    IF p_photo_url IS NULL
       OR char_length(trim(p_photo_url)) = 0
       OR position('..' in p_photo_url) > 0
       OR p_photo_url NOT LIKE (v_profile.company_id::text || '/' || v_uid::text || '/%') THEN
        RETURN jsonb_build_object('success', false, 'code', 'SELFIE_REQUIRED', 'message', 'Foto selfie watermark dengan path bucket valid wajib disertakan.');
    END IF;

    IF v_profile.bound_device_hash IS NULL THEN
        PERFORM set_config('vectra.internal_rpc', 'on', true);
        UPDATE public.att_profiles
           SET bound_device_hash = p_device_hash,
               device_bound_at = v_now
         WHERE id = v_uid;
        PERFORM set_config('vectra.internal_rpc', 'off', true);
    ELSIF v_profile.bound_device_hash <> p_device_hash THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'DEVICE_MISMATCH',
            'message', 'Perangkat tidak dikenali. Hubungi HRD untuk reset device binding.'
        );
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.att_attendance_logs
        WHERE employee_id = v_uid AND clock_out_at IS NULL
    ) THEN
        RETURN jsonb_build_object('success', false, 'code', 'ALREADY_CLOCKED_IN', 'message', 'Anda masih memiliki sesi kerja aktif yang belum Clock Out.');
    END IF;

    IF v_profile.branch_id IS NOT NULL THEN
        SELECT * INTO v_branch FROM public.att_branches WHERE id = v_profile.branch_id;
        v_distance_m := public.calculate_haversine_meters(p_lat, p_lon, v_branch.latitude, v_branch.longitude);
    ELSE
        v_distance_m := NULL;
    END IF;

    IF p_verification_method = 'KIOSK_QR' THEN
        IF v_branch.id IS NULL THEN
            RETURN jsonb_build_object('success', false, 'code', 'KIOSK_BRANCH_REQUIRED', 'message', 'Akun karyawan belum terhubung ke cabang untuk verifikasi Kiosk QR.');
        END IF;
        v_qr_res := public.verify_kiosk_qr_token(v_branch.id, p_qr_payload);
        IF NOT COALESCE((v_qr_res->>'valid')::boolean, false) THEN
            RETURN jsonb_build_object(
                'success', false,
                'code', 'INVALID_KIOSK_QR',
                'message', COALESCE(v_qr_res->>'reason', 'Token Kiosk QR tidak valid atau kedaluwarsa.')
            );
        END IF;
    END IF;

    IF p_accuracy_m IS NULL OR p_accuracy_m <= 0 THEN
        v_is_flagged := true;
        v_flag_reasons := array_append(v_flag_reasons, 'MOCK_GPS_ZERO_ACCURACY');
    ELSIF p_accuracy_m > 100 THEN
        v_is_flagged := true;
        v_flag_reasons := array_append(v_flag_reasons, 'LOW_GPS_ACCURACY_' || ROUND(p_accuracy_m)::text || 'M');
    END IF;

    IF p_work_mode = 'WFO' AND v_branch.id IS NOT NULL THEN
        IF v_distance_m IS NULL THEN
            RETURN jsonb_build_object('success', false, 'code', 'GPS_REQUIRED', 'message', 'Koordinat GPS wajib tersedia untuk absensi WFO.');
        END IF;
        IF v_distance_m > v_branch.radius_meters THEN
            RETURN jsonb_build_object(
                'success', false,
                'code', 'OUT_OF_GEOFENCE',
                'distance_m', v_distance_m,
                'radius_meters', v_branch.radius_meters,
                'message', format('Anda berada %sm dari %s (batas radius %sm).', ROUND(v_distance_m), v_branch.name, v_branch.radius_meters)
            );
        END IF;
    END IF;

    IF p_work_mode = 'FIELD' AND char_length(trim(COALESCE(p_notes, ''))) < 5 THEN
        RETURN jsonb_build_object('success', false, 'code', 'FIELD_NOTES_REQUIRED', 'message', 'Mode Dinas Luar wajib menyertakan keterangan tugas minimal 5 karakter.');
    END IF;

    SELECT clock_in_lat, clock_in_lon, clock_in_at, clock_out_lat, clock_out_lon, clock_out_at
      INTO v_prev_log
      FROM public.att_attendance_logs
     WHERE employee_id = v_uid
     ORDER BY COALESCE(clock_out_at, clock_in_at) DESC
     LIMIT 1;

    IF FOUND THEN
        IF v_prev_log.clock_out_at IS NOT NULL AND v_prev_log.clock_out_lat IS NOT NULL THEN
            v_travel_m := public.calculate_haversine_meters(p_lat, p_lon, v_prev_log.clock_out_lat, v_prev_log.clock_out_lon);
            v_elapsed_hrs := EXTRACT(EPOCH FROM (v_now - v_prev_log.clock_out_at)) / 3600.0;
        ELSIF v_prev_log.clock_in_lat IS NOT NULL THEN
            v_travel_m := public.calculate_haversine_meters(p_lat, p_lon, v_prev_log.clock_in_lat, v_prev_log.clock_in_lon);
            v_elapsed_hrs := EXTRACT(EPOCH FROM (v_now - v_prev_log.clock_in_at)) / 3600.0;
        END IF;

        IF v_travel_m IS NOT NULL AND v_elapsed_hrs IS NOT NULL AND v_elapsed_hrs > 0.001 THEN
            v_speed_kmh := (v_travel_m / 1000.0) / v_elapsed_hrs;
            IF v_speed_kmh > 120.0 THEN
                v_is_flagged := true;
                v_flag_reasons := array_append(v_flag_reasons, format('IMPOSSIBLE_TRAVEL_SPEED_%skmh', ROUND(v_speed_kmh)));
            END IF;
        END IF;
    END IF;

    SELECT es.id AS schedule_id, es.work_date, s.start_time, s.end_time, s.grace_period_minutes, s.is_cross_day
      INTO v_schedule
      FROM public.att_schedules es
      JOIN public.att_shifts s ON s.id = es.shift_id
     WHERE es.employee_id = v_uid
       AND es.work_mode <> 'OFF'
       AND NOT EXISTS (
           SELECT 1 FROM public.att_attendance_logs al
           WHERE al.employee_id = v_uid AND al.schedule_id = es.id
       )
       AND (
           es.work_date = v_local_date
           OR (es.work_date = v_local_date - 1 AND s.is_cross_day = true AND (v_now AT TIME ZONE v_tz)::time <= s.end_time)
       )
     ORDER BY es.work_date ASC, s.start_time ASC
     LIMIT 1;

    IF FOUND THEN
        v_shift_start_ts := ((v_schedule.work_date::text || ' ' || v_schedule.start_time::text)::timestamp AT TIME ZONE v_tz);
        v_grace_cutoff_ts := v_shift_start_ts + make_interval(mins => COALESCE(v_schedule.grace_period_minutes, 0));
        IF v_now > v_grace_cutoff_ts THEN
            v_late_minutes := GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (v_now - v_grace_cutoff_ts)) / 60.0)::INTEGER);
        END IF;
    END IF;

    IF p_work_mode = 'WFH' THEN
        v_status := 'WFH';
    ELSIF p_work_mode = 'FIELD' THEN
        v_status := 'FIELD';
    ELSIF v_late_minutes > 0 THEN
        v_status := 'LATE';
    ELSE
        v_status := 'ON_TIME';
    END IF;

    INSERT INTO public.att_attendance_logs (
        company_id, employee_id, branch_id, schedule_id, work_date, work_mode,
        clock_in_at, clock_in_lat, clock_in_lon, clock_in_accuracy_m, clock_in_distance_m,
        clock_in_photo_url, status, late_minutes, is_flagged, flag_reason,
        device_hash, verification_method, notes
    )
    VALUES (
        v_profile.company_id, v_uid, v_profile.branch_id, v_schedule.schedule_id,
        COALESCE(v_schedule.work_date, v_local_date), p_work_mode,
        v_now, p_lat, p_lon, p_accuracy_m, v_distance_m,
        p_photo_url, v_status, v_late_minutes, v_is_flagged,
        CASE WHEN array_length(v_flag_reasons, 1) > 0 THEN array_to_string(v_flag_reasons, ', ') ELSE NULL END,
        p_device_hash, p_verification_method, COALESCE(p_notes, '')
    )
    RETURNING id INTO v_inserted_id;

    RETURN jsonb_build_object(
        'success', true,
        'log_id', v_inserted_id,
        'server_time', v_now,
        'work_date', COALESCE(v_schedule.work_date, v_local_date),
        'status', v_status,
        'late_minutes', v_late_minutes,
        'distance_m', v_distance_m,
        'is_flagged', v_is_flagged,
        'flag_reason', CASE WHEN array_length(v_flag_reasons, 1) > 0 THEN array_to_string(v_flag_reasons, ', ') ELSE NULL END
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. RPC: submit_clock_out (Cross-Day H+1 Aware)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_clock_out(
    p_lat DOUBLE PRECISION,
    p_lon DOUBLE PRECISION,
    p_accuracy_m DOUBLE PRECISION,
    p_device_hash TEXT,
    p_photo_url TEXT,
    p_notes TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_now TIMESTAMPTZ := now();
    v_uid UUID := auth.uid();
    v_profile public.att_profiles%ROWTYPE;
    v_settings public.att_company_settings%ROWTYPE;
    v_branch public.att_branches%ROWTYPE;
    v_log public.att_attendance_logs%ROWTYPE;
    v_shift public.att_shifts%ROWTYPE;
    v_tz TEXT;
    v_distance_m DOUBLE PRECISION;
    v_travel_m DOUBLE PRECISION;
    v_elapsed_hrs DOUBLE PRECISION;
    v_speed_kmh DOUBLE PRECISION := 0;
    v_shift_end_ts TIMESTAMPTZ;
    v_overtime_minutes INTEGER := 0;
    v_duration_minutes INTEGER := 0;
    v_is_flagged BOOLEAN;
    v_flag_reasons TEXT[];
    v_new_status TEXT;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'UNAUTHENTICATED', 'message', 'Sesi login tidak valid.');
    END IF;

    IF (p_lat IS NOT NULL AND (p_lat <> p_lat OR p_lat < -90 OR p_lat > 90))
       OR (p_lon IS NOT NULL AND (p_lon <> p_lon OR p_lon < -180 OR p_lon > 180))
       OR ((p_lat IS NULL) <> (p_lon IS NULL)) THEN
        RETURN jsonb_build_object('success', false, 'code', 'INVALID_COORDS', 'message', 'Koordinat GPS berada di luar rentang valid.');
    END IF;

    IF p_device_hash IS NULL OR char_length(trim(p_device_hash)) < 8 THEN
        RETURN jsonb_build_object('success', false, 'code', 'INVALID_DEVICE', 'message', 'Fingerprint perangkat tidak valid.');
    END IF;

    SELECT * INTO v_profile FROM public.att_profiles WHERE id = v_uid;
    IF NOT FOUND OR NOT v_profile.is_active THEN
        RETURN jsonb_build_object('success', false, 'code', 'INACTIVE_PROFILE', 'message', 'Akun karyawan tidak ditemukan atau nonaktif.');
    END IF;

    IF p_photo_url IS NULL
       OR char_length(trim(p_photo_url)) = 0
       OR position('..' in p_photo_url) > 0
       OR p_photo_url NOT LIKE (v_profile.company_id::text || '/' || v_uid::text || '/%') THEN
        RETURN jsonb_build_object('success', false, 'code', 'SELFIE_REQUIRED', 'message', 'Foto selfie Clock Out dengan path bucket valid wajib disertakan.');
    END IF;

    IF v_profile.bound_device_hash IS NOT NULL AND v_profile.bound_device_hash IS DISTINCT FROM p_device_hash THEN
        RETURN jsonb_build_object('success', false, 'code', 'DEVICE_MISMATCH', 'message', 'Device fingerprint tidak sesuai dengan perangkat terdaftar.');
    END IF;

    SELECT * INTO v_log
      FROM public.att_attendance_logs
     WHERE employee_id = v_uid AND clock_out_at IS NULL
     ORDER BY clock_in_at DESC
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'NO_OPEN_SESSION', 'message', 'Tidak ditemukan sesi Clock In aktif untuk ditutup.');
    END IF;

    SELECT * INTO v_settings FROM public.att_company_settings WHERE company_id = v_profile.company_id;
    v_tz := COALESCE(v_settings.timezone, 'Asia/Jakarta');

    IF v_log.branch_id IS NOT NULL THEN
        SELECT * INTO v_branch FROM public.att_branches WHERE id = v_log.branch_id;
        v_distance_m := public.calculate_haversine_meters(p_lat, p_lon, v_branch.latitude, v_branch.longitude);
    END IF;

    v_is_flagged := v_log.is_flagged;
    v_flag_reasons := CASE WHEN v_log.flag_reason IS NOT NULL THEN string_to_array(v_log.flag_reason, ', ') ELSE ARRAY[]::TEXT[] END;

    IF p_accuracy_m IS NULL OR p_accuracy_m <= 0 THEN
        v_is_flagged := true;
        v_flag_reasons := array_append(v_flag_reasons, 'CLOCKOUT_MOCK_GPS');
    ELSIF p_accuracy_m > 100 THEN
        v_is_flagged := true;
        v_flag_reasons := array_append(v_flag_reasons, 'CLOCKOUT_LOW_GPS_ACCURACY_' || ROUND(p_accuracy_m)::text || 'M');
    END IF;

    IF v_log.clock_in_lat IS NOT NULL AND p_lat IS NOT NULL THEN
        v_travel_m := public.calculate_haversine_meters(p_lat, p_lon, v_log.clock_in_lat, v_log.clock_in_lon);
        v_elapsed_hrs := EXTRACT(EPOCH FROM (v_now - v_log.clock_in_at)) / 3600.0;
        IF v_elapsed_hrs > 0.001 THEN
            v_speed_kmh := (v_travel_m / 1000.0) / v_elapsed_hrs;
            IF v_speed_kmh > 120.0 AND v_log.work_mode = 'WFO' THEN
                v_is_flagged := true;
                v_flag_reasons := array_append(v_flag_reasons, format('CLOCKOUT_TELEPORT_%skmh', ROUND(v_speed_kmh)));
            END IF;
        END IF;
    END IF;

    v_duration_minutes := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_now - v_log.clock_in_at)) / 60.0)::INTEGER);
    v_new_status := v_log.status;

    IF v_log.schedule_id IS NOT NULL THEN
        SELECT s.* INTO v_shift
          FROM public.att_schedules es
          JOIN public.att_shifts s ON s.id = es.shift_id
         WHERE es.id = v_log.schedule_id;

        IF FOUND THEN
            IF v_shift.is_cross_day OR v_shift.end_time <= v_shift.start_time THEN
                v_shift_end_ts := (((v_log.work_date + 1)::text || ' ' || v_shift.end_time::text)::timestamp AT TIME ZONE v_tz);
            ELSE
                v_shift_end_ts := ((v_log.work_date::text || ' ' || v_shift.end_time::text)::timestamp AT TIME ZONE v_tz);
            END IF;

            IF v_now > v_shift_end_ts THEN
                v_overtime_minutes := FLOOR(EXTRACT(EPOCH FROM (v_now - v_shift_end_ts)) / 60.0)::INTEGER;
            ELSIF v_now < (v_shift_end_ts - INTERVAL '15 minutes') AND v_log.status = 'ON_TIME' THEN
                v_new_status := 'EARLY_LEAVE';
            END IF;
        END IF;
    ELSIF v_duration_minutes > 480 THEN
        v_overtime_minutes := v_duration_minutes - 480;
    END IF;

    PERFORM set_config('vectra.internal_rpc', 'on', true);
    UPDATE public.att_attendance_logs
       SET clock_out_at = v_now,
           clock_out_lat = p_lat,
           clock_out_lon = p_lon,
           clock_out_accuracy_m = p_accuracy_m,
           clock_out_distance_m = v_distance_m,
           clock_out_photo_url = p_photo_url,
           work_duration_minutes = v_duration_minutes,
           overtime_minutes = v_overtime_minutes,
           status = v_new_status,
           is_flagged = v_is_flagged,
           flag_reason = CASE WHEN array_length(v_flag_reasons, 1) > 0 THEN array_to_string(v_flag_reasons, ', ') ELSE NULL END,
           notes = CASE WHEN char_length(trim(COALESCE(p_notes, ''))) > 0
                        THEN trim(COALESCE(v_log.notes, '') || ' | Out: ' || p_notes)
                        ELSE v_log.notes END
     WHERE id = v_log.id;
    PERFORM set_config('vectra.internal_rpc', 'off', true);

    RETURN jsonb_build_object(
        'success', true,
        'log_id', v_log.id,
        'server_time', v_now,
        'work_duration_minutes', v_duration_minutes,
        'overtime_minutes', v_overtime_minutes,
        'status', v_new_status,
        'distance_m', v_distance_m,
        'is_flagged', v_is_flagged
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. RPC: get_dashboard_kpis (12 Live Command Center KPIs)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_dashboard_kpis(
    p_company_id UUID,
    p_branch_id UUID DEFAULT NULL,
    p_department TEXT DEFAULT NULL,
    p_shift_id UUID DEFAULT NULL,
    p_start_date DATE DEFAULT CURRENT_DATE,
    p_end_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role TEXT := public.att_auth_role();
    v_caller_branch UUID := public.att_auth_branch_id();
    v_effective_branch UUID := p_branch_id;
    v_today DATE := (now() AT TIME ZONE 'Asia/Jakarta')::date;
    v_month_start DATE := date_trunc('month', v_today)::date;
    v_total_active INTEGER := 0;
    v_present_today INTEGER := 0;
    v_late_today INTEGER := 0;
    v_absent_today INTEGER := 0;
    v_overtime_active INTEGER := 0;
    v_leave_active INTEGER := 0;
    v_wfh_field_today INTEGER := 0;
    v_pending_approvals INTEGER := 0;
    v_fraud_flags INTEGER := 0;
    v_work_hours_month NUMERIC(10, 1) := 0;
    v_est_overtime_pay NUMERIC(14, 2) := 0;
    v_est_payroll_total NUMERIC(16, 2) := 0;
BEGIN
    IF NOT public.att_is_company_member(p_company_id) THEN
        RAISE EXCEPTION 'Tenant access denied for organization %', p_company_id
            USING ERRCODE = '42501';
    END IF;

    IF v_role NOT IN ('super_admin', 'company_admin', 'supervisor')
       AND NOT public.att_is_company_admin(p_company_id) THEN
        RAISE EXCEPTION 'Akses dashboard KPI dibatasi untuk Supervisor dan Admin HRD.'
            USING ERRCODE = '42501';
    END IF;

    IF v_role = 'supervisor' AND NOT public.att_is_company_admin(p_company_id) THEN
        v_effective_branch := v_caller_branch;
    END IF;

    SELECT COUNT(*)::INTEGER INTO v_total_active
      FROM public.att_profiles p
     WHERE p.company_id = p_company_id
       AND p.is_active = true
       AND (v_effective_branch IS NULL OR p.branch_id = v_effective_branch)
       AND (p_department IS NULL OR p.department = p_department);

    SELECT
        COUNT(DISTINCT al.employee_id) FILTER (WHERE al.status <> 'ABSENT')::INTEGER,
        COUNT(*) FILTER (WHERE al.status = 'LATE')::INTEGER,
        COUNT(*) FILTER (WHERE al.work_mode IN ('WFH', 'FIELD'))::INTEGER
      INTO v_present_today, v_late_today, v_wfh_field_today
      FROM public.att_attendance_logs al
      JOIN public.att_profiles p ON p.id = al.employee_id
      LEFT JOIN public.att_schedules es ON es.id = al.schedule_id
     WHERE al.company_id = p_company_id
       AND al.work_date BETWEEN COALESCE(p_start_date, v_today) AND COALESCE(p_end_date, v_today)
       AND (v_effective_branch IS NULL OR p.branch_id = v_effective_branch)
       AND (p_department IS NULL OR p.department = p_department)
       AND (p_shift_id IS NULL OR es.shift_id = p_shift_id);

    SELECT COUNT(*)::INTEGER INTO v_absent_today
      FROM public.att_schedules es
      JOIN public.att_profiles p ON p.id = es.employee_id
     WHERE es.company_id = p_company_id
       AND es.work_date BETWEEN COALESCE(p_start_date, v_today) AND LEAST(COALESCE(p_end_date, v_today), v_today)
       AND es.work_mode <> 'OFF'
       AND (v_effective_branch IS NULL OR p.branch_id = v_effective_branch)
       AND (p_department IS NULL OR p.department = p_department)
       AND (p_shift_id IS NULL OR es.shift_id = p_shift_id)
       AND NOT EXISTS (
           SELECT 1 FROM public.att_attendance_logs al
           WHERE al.employee_id = es.employee_id AND al.work_date = es.work_date
       )
       AND NOT EXISTS (
           SELECT 1 FROM public.att_requests r
           WHERE r.employee_id = es.employee_id
             AND r.status = 'approved'
             AND r.type IN ('LEAVE', 'SICK')
             AND es.work_date BETWEEN r.start_date AND r.end_date
       );

    SELECT COUNT(*)::INTEGER INTO v_overtime_active
      FROM public.att_attendance_logs al
      JOIN public.att_profiles p ON p.id = al.employee_id
      LEFT JOIN public.att_schedules es ON es.id = al.schedule_id
     WHERE al.company_id = p_company_id
       AND al.work_date BETWEEN COALESCE(p_start_date, v_today) AND COALESCE(p_end_date, v_today)
       AND al.overtime_minutes > 0
       AND (v_effective_branch IS NULL OR p.branch_id = v_effective_branch)
       AND (p_department IS NULL OR p.department = p_department)
       AND (p_shift_id IS NULL OR es.shift_id = p_shift_id);

    SELECT COUNT(DISTINCT r.employee_id)::INTEGER INTO v_leave_active
      FROM public.att_requests r
      JOIN public.att_profiles p ON p.id = r.employee_id
     WHERE r.company_id = p_company_id
       AND r.status = 'approved'
       AND r.type IN ('LEAVE', 'SICK')
       AND r.start_date <= COALESCE(p_end_date, v_today)
       AND r.end_date >= COALESCE(p_start_date, v_today)
       AND (v_effective_branch IS NULL OR p.branch_id = v_effective_branch)
       AND (p_department IS NULL OR p.department = p_department);

    SELECT COUNT(*)::INTEGER INTO v_pending_approvals
      FROM public.att_requests r
      JOIN public.att_profiles p ON p.id = r.employee_id
     WHERE r.company_id = p_company_id
       AND r.status IN ('pending_supervisor', 'pending_hr')
       AND (v_effective_branch IS NULL OR p.branch_id = v_effective_branch)
       AND (p_department IS NULL OR p.department = p_department);

    SELECT COUNT(*)::INTEGER INTO v_fraud_flags
      FROM public.att_attendance_logs al
      JOIN public.att_profiles p ON p.id = al.employee_id
     WHERE al.company_id = p_company_id
       AND al.is_flagged = true
       AND al.flag_reviewed_at IS NULL
       AND (v_effective_branch IS NULL OR p.branch_id = v_effective_branch)
       AND (p_department IS NULL OR p.department = p_department);

    SELECT
        ROUND((COALESCE(SUM(al.work_duration_minutes), 0) / 60.0)::numeric, 1),
        ROUND(COALESCE(SUM((al.overtime_minutes / 60.0) * 1.5 * (p.base_salary / 173.0)), 0)::numeric, 0)
      INTO v_work_hours_month, v_est_overtime_pay
      FROM public.att_attendance_logs al
      JOIN public.att_profiles p ON p.id = al.employee_id
     WHERE al.company_id = p_company_id
       AND al.work_date >= v_month_start
       AND (v_effective_branch IS NULL OR p.branch_id = v_effective_branch)
       AND (p_department IS NULL OR p.department = p_department);

    SELECT ROUND(COALESCE(SUM(p.base_salary), 0)::numeric, 0) + v_est_overtime_pay
      INTO v_est_payroll_total
      FROM public.att_profiles p
     WHERE p.company_id = p_company_id
       AND p.is_active = true
       AND (v_effective_branch IS NULL OR p.branch_id = v_effective_branch)
       AND (p_department IS NULL OR p.department = p_department);

    RETURN jsonb_build_object(
        'total_active_employees', v_total_active,
        'present_today', v_present_today,
        'attendance_rate_pct', CASE WHEN v_total_active > 0 THEN ROUND((v_present_today::numeric / v_total_active) * 100, 1) ELSE 0 END,
        'late_today', v_late_today,
        'absent_today', v_absent_today,
        'currently_overtime', v_overtime_active,
        'active_leave_today', v_leave_active,
        'wfh_field_today', v_wfh_field_today,
        'pending_approvals', v_pending_approvals,
        'fraud_flags_count', v_fraud_flags,
        'total_work_hours_month', v_work_hours_month,
        'estimated_overtime_pay', v_est_overtime_pay,
        'estimated_payroll_total', v_est_payroll_total,
        'server_time', now()
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. RPCs: Self-Service Employee Onboarding via Invite Token
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.preview_employee_invite(
    p_invite_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_token TEXT := upper(trim(COALESCE(p_invite_token, '')));
    v_row RECORD;
BEGIN
    IF char_length(v_token) < 12 THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Format kode undangan tidak valid.');
    END IF;

    SELECT
        i.id,
        i.employee_code,
        i.full_name,
        i.email,
        i.department,
        i.position,
        i.role,
        i.expires_at,
        i.accepted_at,
        i.revoked_at,
        o.name AS company_name,
        COALESCE(b.name, 'Kantor Pusat') AS branch_name
      INTO v_row
      FROM public.att_employee_invites i
      JOIN public.organizations o ON o.id = i.company_id
      LEFT JOIN public.att_branches b ON b.id = i.branch_id
     WHERE upper(i.invite_token) = v_token
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Kode undangan tidak ditemukan atau salah.');
    END IF;

    IF v_row.revoked_at IS NOT NULL THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Undangan ini telah dibatalkan oleh HRD Admin.');
    END IF;

    IF v_row.accepted_at IS NOT NULL THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Undangan ini sudah digunakan untuk aktivasi akun.');
    END IF;

    IF v_row.expires_at <= now() THEN
        RETURN jsonb_build_object('valid', false, 'reason', 'Masa berlaku undangan (7 hari) sudah habis. Minta HRD mengirim undangan baru.');
    END IF;

    RETURN jsonb_build_object(
        'valid', true,
        'company_name', v_row.company_name,
        'branch_name', v_row.branch_name,
        'employee_code', v_row.employee_code,
        'full_name', v_row.full_name,
        'email', v_row.email,
        'department', v_row.department,
        'position', v_row.position,
        'role', v_row.role,
        'expires_at', v_row.expires_at
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_employee_invite(
    p_invite_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_token TEXT := upper(trim(COALESCE(p_invite_token, '')));
    v_auth_email TEXT;
    v_existing public.att_profiles%ROWTYPE;
    v_invite public.att_employee_invites%ROWTYPE;
    v_created public.att_profiles%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'UNAUTHENTICATED', 'message', 'Silakan login atau buat akun terlebih dahulu sebelum menerima undangan.');
    END IF;

    IF char_length(v_token) < 12 THEN
        RETURN jsonb_build_object('success', false, 'code', 'INVALID_TOKEN', 'message', 'Kode undangan tidak valid.');
    END IF;

    SELECT email INTO v_auth_email FROM auth.users WHERE id = v_uid;

    SELECT * INTO v_invite
      FROM public.att_employee_invites
     WHERE upper(invite_token) = v_token
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'INVITE_NOT_FOUND', 'message', 'Kode undangan tidak ditemukan.');
    END IF;

    SELECT * INTO v_existing FROM public.att_profiles WHERE id = v_uid;
    IF FOUND THEN
        IF v_invite.accepted_by = v_uid AND v_existing.company_id = v_invite.company_id THEN
            RETURN jsonb_build_object('success', true, 'already_member', true, 'profile', to_jsonb(v_existing));
        END IF;
        RETURN jsonb_build_object('success', false, 'code', 'PROFILE_EXISTS', 'message', 'Akun ini sudah terhubung ke workspace VECTRA.');
    END IF;

    IF v_invite.revoked_at IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'INVITE_REVOKED', 'message', 'Undangan telah dibatalkan oleh HRD Admin.');
    END IF;

    IF v_invite.accepted_at IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'INVITE_USED', 'message', 'Undangan ini sudah diklaim oleh akun lain.');
    END IF;

    IF v_invite.expires_at <= now() THEN
        RETURN jsonb_build_object('success', false, 'code', 'INVITE_EXPIRED', 'message', 'Undangan sudah kedaluwarsa.');
    END IF;

    IF lower(trim(COALESCE(v_auth_email, ''))) <> lower(trim(v_invite.email)) THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'EMAIL_MISMATCH',
            'message', format('Undangan diterbitkan khusus untuk email %s, sedangkan Anda login sebagai %s.', v_invite.email, COALESCE(v_auth_email, '-'))
        );
    END IF;

    IF v_invite.role NOT IN ('company_admin', 'supervisor', 'employee') THEN
        RETURN jsonb_build_object('success', false, 'code', 'INVALID_ROLE', 'message', 'Role undangan tidak diizinkan.');
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.att_profiles p
        WHERE p.company_id = v_invite.company_id
          AND p.employee_code = v_invite.employee_code
    ) THEN
        RETURN jsonb_build_object('success', false, 'code', 'DUPLICATE_NIK', 'message', 'NIK karyawan sudah terdaftar di perusahaan ini. Hubungi HRD untuk memperbarui kode.');
    END IF;

    PERFORM set_config('vectra.internal_rpc', 'on', true);

    INSERT INTO public.organization_members (org_id, user_id, role)
    VALUES (
        v_invite.company_id,
        v_uid,
        CASE WHEN v_invite.role = 'company_admin' THEN 'accountant' ELSE 'staff' END
    )
    ON CONFLICT (org_id, user_id) DO NOTHING;

    INSERT INTO public.att_profiles (
        id, company_id, branch_id, employee_code, full_name, email, phone,
        role, department, position, base_salary, daily_allowance, fixed_deduction,
        leave_balance, is_active
    )
    VALUES (
        v_uid, v_invite.company_id, v_invite.branch_id, v_invite.employee_code,
        v_invite.full_name, COALESCE(v_auth_email, v_invite.email), v_invite.phone,
        v_invite.role, v_invite.department, v_invite.position,
        v_invite.base_salary, v_invite.daily_allowance, v_invite.fixed_deduction,
        v_invite.leave_balance, true
    )
    RETURNING * INTO v_created;

    UPDATE public.att_employee_invites
       SET accepted_at = now(),
           accepted_by = v_uid
     WHERE id = v_invite.id;

    PERFORM set_config('vectra.internal_rpc', 'off', true);

    RETURN jsonb_build_object(
        'success', true,
        'already_member', false,
        'profile', to_jsonb(v_created)
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. EXECUTION PERMISSIONS
-- ----------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.calculate_haversine_meters(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_kiosk_qr_token(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_kiosk_qr_token(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_clock_in(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_clock_out(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_dashboard_kpis(UUID, UUID, TEXT, UUID, DATE, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.preview_employee_invite(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_employee_invite(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.calculate_haversine_meters(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_kiosk_qr_token(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_kiosk_qr_token(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_clock_in(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_clock_out(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_dashboard_kpis(UUID, UUID, TEXT, UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_employee_invite(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_employee_invite(TEXT) TO authenticated;

COMMIT;
