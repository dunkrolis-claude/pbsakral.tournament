-- PB Sakral Tournament — migration: keuangan (pemasukan lain, anggaran), diskon pendaftar
-- Sifat: ADDITIVE saja. Tidak mengubah/menghapus kolom atau data yang sudah ada.
-- Aman dijalankan ulang (idempotent). Belum diterapkan ke production sampai disetujui.

begin;

-- 1) Diskon pendaftar (Rp) + keterangan
alter table public.registrations
  add column if not exists discount_amount integer not null default 0 check (discount_amount >= 0),
  add column if not exists discount_note   text    not null default '';

-- 2) Pemasukan di luar pendaftaran (sponsor, kas PB, jual kok sisa, lainnya)
create table if not exists public.income_other (
  id             text primary key,
  kind           text not null check (kind in ('SPONSOR','KAS_PB','KOK_SISA','LAINNYA')),
  description    text not null,
  committed      integer not null default 0 check (committed >= 0),  -- komitmen (khusus sponsor)
  amount         integer not null default 0 check (amount >= 0),     -- yang benar-benar diterima
  note           text not null default '',
  budget_item_id text,
  created_at     timestamptz not null default now()
);

-- 3) Draft anggaran (budget) — realisasi dihitung dari transaksi
create table if not exists public.budget_items (
  id             text primary key,
  section        text not null check (section in ('INCOME','EXPENSE')),
  group_name     text not null,
  label          text not null,
  qty            numeric not null default 1,
  unit_price     integer not null default 0,
  budget_key     text,                       -- 'REG:<KATEGORI>' / 'DEPOSIT_KOK' = realisasi otomatis
  is_target_only boolean not null default false, -- target sponsor: tidak dihitung di proyeksi operasional
  sort           integer not null default 0,
  note           text not null default ''
);

-- 4) Pengeluaran bisa ditautkan ke pos anggaran
alter table public.expenses add column if not exists budget_item_id text;

-- 5) Keamanan: sama seperti expenses — hanya service_role (lewat /api/admin-*)
alter table public.income_other enable row level security;
alter table public.budget_items enable row level security;
revoke all on public.income_other from anon, authenticated;
revoke all on public.budget_items from anon, authenticated;

-- 6) Isi awal anggaran dari RAB_PB_Sakral_Tournament_2026.xlsx (tidak menimpa jika sudah ada)
insert into public.budget_items (id, section, group_name, label, qty, unit_price, budget_key, is_target_only, sort) values
  ('bi-in-02','INCOME','Registrasi','PRIME',48,250000,'REG:PRIME',false,2),
  ('bi-in-03','INCOME','Registrasi','CORE',64,250000,'REG:CORE',false,3),
  ('bi-in-04','INCOME','Registrasi','RISING',32,150000,'REG:RISING',false,4),
  ('bi-in-05','INCOME','Registrasi','QUEENS',32,150000,'REG:QUEENS',false,5),
  ('bi-in-06','INCOME','Shuttlecock','Kok Turnamen',360,20000,'DEPOSIT_KOK',false,6),
  ('bi-in-07','INCOME','Shuttlecock','Kok Sisa Turnamen',0,0,NULL,false,7),
  ('bi-in-08','INCOME','Sponsor','Mas Huang',1,0,NULL,false,8),
  ('bi-in-09','INCOME','Sponsor','PB Sakral',1,1000000,NULL,false,9),
  ('bi-in-11','INCOME','Target Sponsor','Main Partner',1,10000000,NULL,true,11),
  ('bi-in-12','INCOME','Target Sponsor','Official Partner',1,5000000,NULL,true,12),
  ('bi-in-13','INCOME','Target Sponsor','Official Partner',1,5000000,NULL,true,13),
  ('bi-in-14','INCOME','Target Sponsor','Supporting Partner',1,2500000,NULL,true,14),
  ('bi-in-15','INCOME','Target Sponsor','Supporting Partner',1,2500000,NULL,true,15),
  ('bi-ex-02','EXPENSE','Hadiah','Prize PRIME',1,7000000,NULL,false,2),
  ('bi-ex-03','EXPENSE','Hadiah','Prize CORE',1,7000000,NULL,false,3),
  ('bi-ex-04','EXPENSE','Hadiah','Prize RISING',1,4000000,NULL,false,4),
  ('bi-ex-05','EXPENSE','Hadiah','Prize QUEENS',1,4000000,NULL,false,5),
  ('bi-ex-06','EXPENSE','Venue','Sewa lapangan (court-hour)',122,30000,NULL,false,6),
  ('bi-ex-07','EXPENSE','Official','Wasit (orang-hari)',12,150000,NULL,false,7),
  ('bi-ex-08','EXPENSE','Official','Hakim garis (orang-hari)',20,100000,NULL,false,8),
  ('bi-ex-09','EXPENSE','Pertandingan','Pembelian shuttlecock (slop)',50,120000,NULL,false,9),
  ('bi-ex-10','EXPENSE','Penghargaan','Medali (pcs)',32,70000,NULL,false,10),
  ('bi-ex-11','EXPENSE','Penghargaan','Giant check (pcs)',16,20000,NULL,false,11),
  ('bi-ex-12','EXPENSE','Penghargaan','Plakat (pcs)',8,50000,NULL,false,12),
  ('bi-ex-13','EXPENSE','Penghargaan','Door prize',1,800000,NULL,false,13),
  ('bi-ex-14','EXPENSE','Branding','Banner utama (m2)',1,0,NULL,false,14),
  ('bi-ex-15','EXPENSE','Branding','Banner podium',1,0,NULL,false,15),
  ('bi-ex-16','EXPENSE','Konsumsi','Makan (porsi)',60,15000,NULL,false,16),
  ('bi-ex-17','EXPENSE','Konsumsi','Minum (karton)',1,0,NULL,false,17),
  ('bi-ex-18','EXPENSE','Panitia','Honor panitia',7,500000,NULL,false,18),
  ('bi-ex-19','EXPENSE','Panitia','Jersey polos (pcs)',22,40000,NULL,false,19),
  ('bi-ex-20','EXPENSE','Panitia','Jersey panitia (orang-hari)',14,70000,NULL,false,20),
  ('bi-ex-21','EXPENSE','Perlengkapan','Sewa kursi (unit-hari)',15,10000,NULL,false,21),
  ('bi-ex-22','EXPENSE','Perlengkapan','Sewa meja (unit-hari)',2,100000,NULL,false,22),
  ('bi-ex-23','EXPENSE','Perlengkapan','Sound system (hari)',2,250000,NULL,false,23),
  ('bi-ex-24','EXPENSE','Souvenir','Souvenir peserta (pcs)',384,2000,NULL,false,24)
on conflict (id) do nothing;

commit;
