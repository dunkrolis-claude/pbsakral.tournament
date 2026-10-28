-- PB Sakral Tournament — migration: jam mulai pertandingan per hari
-- Sifat: ADDITIVE saja (satu kolom baru). Tidak mengubah/menghapus kolom atau data yang sudah ada.
-- Aman dijalankan ulang (idempotent). Belum diterapkan ke production sampai disetujui.
-- Nilai = menit sejak 00.00. Default 480 = 08.00 untuk Sabtu (1) dan Minggu (2).

begin;

alter table public.tournament_settings
  add column if not exists day_start_minutes jsonb not null default '{"1":480,"2":480}'::jsonb;

commit;
