# VECTRA // Enterprise Workforce, Anti-Fraud Attendance & Payroll OS

VECTRA adalah platform B2B Multi-Tenant SaaS untuk manajemen kehadiran karyawan, penjadwalan shift lintas hari (*cross-day*), validasi lokasi anti-fraud, workflow persetujuan berjenjang, dan kalkulasi payroll otomatis yang terintegrasi secara *batch* dan *idempotent* dengan **Kronos Ledger**. Dibangun dengan arsitektur **Zero-Build Static ES6+** (HTML5, Tailwind CSS, Vanilla JavaScript Modular) dan backend **Supabase** (PostgreSQL, Auth, Storage, Row Level Security, dan SECURITY DEFINER RPC).

## Fitur Utama

- **Command Center & Mobile Portal Terintegrasi**: Antarmuka *Industrial Command Center* untuk HRD Admin dan Supervisor Cabang, serta portal *mobile-first* dengan navigasi bawah (*Absen, Jadwal, Pengajuan, Slip Gaji*) untuk karyawan.
- **12 Live Operational KPI Cards**: Menghitung karyawan aktif, persentase kehadiran, keterlambatan, alpha, lembur aktif, cuti, WFH/dinas luar, pending approvals, flag anomali GPS, total jam kerja bulan berjalan, estimasi upah lembur, dan estimasi total payroll.
- **Multi-Layer Anti-Fraud Engine**:
  1. Validasi radius geofencing **Haversine** di browser dan di dalam PostgreSQL RPC.
  2. Deteksi *Mock GPS* (`accuracy <= 0` atau `> 100m`) dan *Impossible Travel Speed* (`> 120 km/jam` antar log).
  3. **Device Fingerprint Binding** berbasis hash SHA-256 (UA, resolusi layar, zona waktu, hardware concurrency, dan canvas signature).
  4. Kamera live `getUserMedia` (upload galeri diblokir) dengan injeksi **watermark metadata permanen** langsung pada HTML5 `<canvas>`.
  5. **Dynamic Rotating QR Kiosk** yang merotasi token kriptografis setiap 15 detik.
  6. **Server-Side Time Authority**: Seluruh timestamp `clock_in_at` dan `clock_out_at` berasal dari `now()` PostgreSQL sehingga kebal terhadap manipulasi jam perangkat client.
- **Cross-Day Shift Scheduler**: Mendukung shift reguler, split shift, dan shift malam lintas hari (misal `22:00 - 06:00`), mengaitkan `clock_out_at` pada H+1 pagi ke `work_date` malam sebelumnya.
- **Approval 2 Tahap & Kuota Cuti Otomatis**: Alur `pending_supervisor` ke `pending_hr` hingga `approved`/`rejected`, dilengkapi trigger database untuk memotong `leave_balance` saat cuti disetujui.
- **Automated Payroll & Kronos Ledger Batch Bridge**:
  - Kalkulasi payroll otomatis berbasis `1/173` jam kerja/bulan, lembur bertingkat (`1.5x` / `2.0x`), tunjangan kehadiran fisik WFO, dan cetak **Slip Gaji A4/A5** (`@media print`).
  - Log absensi mentah **tidak pernah** menulis langsung ke jurnal akuntansi. Hanya batch payroll berstatus `FINALIZED` yang diposting lewat RPC `post_payroll_to_ledger` ke **Kronos Ledger** dengan proteksi idempotensi `UNIQUE (company_id, period_year, period_month, source_ref)`.
- **Offline-First Queue & Live Demo Mode (`?mode=demo`)**: Antrean **IndexedDB** saat sinyal terputus dan simulasi lengkap di sisi client via `?mode=demo`.

---

## Struktur Direktori

```text
vectra/
├── index.html                        # Landing page, login Supabase Auth & Quick Demo Role Switcher
├── app.html                          # Command Center (Admin/Supervisor) & Mobile Employee Portal
├── styles.css                        # Poppins typography, tabular-nums, fokus aksesibel & @media print
├── config.js                         # Kredensial Supabase, interceptor ?mode=demo & unified DataClient
├── demo-engine.js                    # Mock database, RPC absensi/payroll & simulasi Kronos Ledger
├── anti-fraud.js                     # Haversine, device hash, rotating QR 15s, kamera watermark & IndexedDB
├── app.js                            # State management, 12 KPI, tabel filter/pagination, modal audit & slip gaji
├── 16_att_core_tables.sql            # Migrasi lanjutan: tabel att_*, index & trigger (BEGIN..COMMIT)
├── 17_att_rls_and_storage.sql        # RLS non-rekursif selaras Kronos Ledger & Storage policies
├── 18_att_rpcs_and_anti_fraud.sql    # RPC submit_clock_in, submit_clock_out & get_dashboard_kpis
├── 19_att_payroll_ledger_bridge.sql  # RPC generate_monthly_payroll & post_payroll_to_ledger (idempotent)
├── 20_att_seed_demo.sql              # Seed idempotent (ON CONFLICT DO NOTHING) Jakarta & Depok
├── .gitignore                        # Abaikan folder referensi SQL lokal & file sementara
└── README.md
```

---

## Integrasi SQL dengan Kronos Ledger (Migrasi 01–20)

VECTRA dirancang sebagai ekstensi non-destruktif di atas fondasi database **Kronos Ledger (`01_tables.sql` s.d. `15_invoice_rpcs_and_permissions.sql`)**:

1. **Jalankan Fondasi Kronos Ledger (01–15)** terlebih dahulu di Supabase SQL Editor (jika belum live).
2. **Jalankan Migrasi Lanjutan VECTRA (16–20)** secara berurutan. Setiap file dibungkus transaksi atomik `BEGIN; ... COMMIT;`:
   - `16_att_core_tables.sql`: Membuat tabel bernamespace `att_*` (`att_company_settings`, `att_branches`, `att_profiles`, `att_shifts`, `att_schedules`, `att_attendance_logs`, `att_requests`, `att_payrolls`, `att_payroll_ledger_batches`, `att_employee_invites`) yang mereferensi `public.organizations(id)` sebagai `company_id` tanpa mengubah tabel inti Kronos.
   - `17_att_rls_and_storage.sql`: Mengaktifkan RLS ketat dan menyelaraskan helper `att_is_company_admin()` / `att_is_company_member()` dengan `public.is_org_member()` & `public.has_org_role()` milik Kronos Ledger, plus proteksi kolom sensitif/undangan dan bucket `attendance-selfies` serta `request-attachments`.
   - `18_att_rpcs_and_anti_fraud.sql`: Mendaftarkan RPC `submit_clock_in`, `submit_clock_out`, `get_dashboard_kpis`, `get_kiosk_qr_token`, `verify_kiosk_qr_token`, `preview_employee_invite`, dan `accept_employee_invite` (onboarding karyawan mandiri via link undangan HRD).
   - `19_att_payroll_ledger_bridge.sql`: Mendaftarkan RPC `generate_monthly_payroll` dan `post_payroll_to_ledger`.
   - `20_att_seed_demo.sql` *(opsional)*: Mengisi tenant demo **PT Nusantara Ritel Operasional** (otomatis memicu seeder CoA Kronos Ledger `06`), 2 cabang Jakarta & Depok, 18 karyawan (`VectraDemo2026!`), log 30 hari, dan payroll siap posting.
3. **Alur Double-Entry Bridge (`post_payroll_to_ledger`)**:
   - Memvalidasi hanya slip dengan `status = 'FINALIZED'` dan `ledger_transaction_id IS NULL`.
   - Mencegah posting ganda via `att_payroll_ledger_batches` (`UNIQUE (company_id, period_year, period_month, source_ref)`).
   - Memanggil `public.post_double_entry_transaction(...)` milik Kronos Ledger secara atomik:
     - **Debit `6102` (Beban Gaji)** = Total Gaji Bersih + Total Potongan Tetap/Pajak
     - **Kredit `1102` (Bank BCA)** *(atau `1101` Kas Tunai / `2101` Utang Usaha)* = Total Gaji Bersih
     - **Kredit `2201` (Utang Pajak PPN/PPh)** = Total Potongan Tetap/Pajak *(jika > 0)*
   - Saldo `public.accounts` dan `public.audit_logs` di Kronos Ledger otomatis tersinkronisasi oleh trigger bawaan migrasi `08` dan `12`.

---

## Konfigurasi Kredensial Supabase & Menjalankan Secara Lokal (`?mode=demo`)

Secara default, `config.js` menggunakan placeholder kosong agar aman saat dipublikasikan. Untuk menghubungkan ke project Supabase milik Anda:
- Isi `PROJECT_ID`, `URL`, dan `ANON_KEY` (khusus **Publishable / Anon Key**, jangan pernah menggunakan `service_role` atau `sb_secret_*`) pada [config.js](config.js), **atau**
- Gunakan panel **Pengaturan Project Supabase (Override)** di halaman login (`index.html`) untuk menyimpan kredensial ke `localStorage` browser saat uji coba.

Karena aplikasi menggunakan ES6 Modules (`<script type="module">`), jalankan melalui web server lokal:

```bash
# Opsi 1: Node.js
npx serve .

# Opsi 2: Python 3
python -m http.server 8080
```

Buka di browser:
- Landing & Login: `http://localhost:8080/index.html`
- Live Demo Command Center (HRD Admin): `http://localhost:8080/app.html?mode=demo`
- Live Demo Supervisor Cabang: `http://localhost:8080/app.html?mode=demo&role=supervisor`
- Live Demo Portal Karyawan Mobile: `http://localhost:8080/app.html?mode=demo&role=employee`

---

## Ringkasan Arsitektur Anti-Fraud

| Lapisan | Validasi Client (`anti-fraud.js`) | Validasi Server (`18_att_rpcs_and_anti_fraud.sql`) |
| :--- | :--- | :--- |
| **Geofencing** | Rumus Haversine mengunci tombol WFO bila jarak melebihi `radius_meters`. | `submit_clock_in` menghitung ulang `calculate_haversine_meters` terhadap `att_branches`. |
| **Fake GPS & Teleport** | Menandai `accuracy <= 0`, `accuracy > 100m`, atau kecepatan `> 120 km/jam`. | `submit_clock_in` & `submit_clock_out` membandingkan koordinat log terakhir dan menyimpan `is_flagged = true`. |
| **Otoritas Waktu** | Menampilkan jam WIB untuk referensi UI. | Mengabaikan jam client dan mencatat `now()` di dalam transaksi PostgreSQL. |
| **Device Binding** | Menghasilkan hash SHA-256 karakteristik perangkat dan canvas. | Membandingkan `p_device_hash` dengan `att_profiles.bound_device_hash`; menolak jika berbeda. |
| **Foto Bukti** | Wajib kamera live `getUserMedia`, lalu membakar watermark permanen ke `<canvas>`. | Disimpan ke bucket privat `attendance-selfies` dengan kebijakan Storage RLS berbasis folder `company_id/employee_id`. |
| **Kiosk QR** | Memanggil RPC server `get_kiosk_qr_token` (15 detik) tanpa menyimpan `qr_secret_key` di client. | Kolom `qr_secret_key` dikecualikan dari `SELECT` client; RPC `verify_kiosk_qr_token` & `submit_clock_in` memverifikasi slice TOTP 15 detik (`-1/+1`). |
