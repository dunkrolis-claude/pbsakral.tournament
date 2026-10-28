// Rincian biaya & deposit untuk halaman pemain, per kode booking.
// Hanya mengembalikan angka uang milik satu pendaftaran berstatus REGISTERED:
// tanpa nama, tanpa WhatsApp, tanpa bukti bayar, tanpa catatan admin.
// (Keputusan panitia: kode booking cukup sebagai kunci, tanpa verifikasi tambahan.)
const { getServiceClient } = require("./_lib/supabaseServer");
const { sendJson } = require("./_lib/authz");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  const code = String((req.query && req.query.code) || "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,24}$/.test(code)) return sendJson(res, 400, { ok: false, error: "invalid_code" });
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("registrations")
      .select("reg_no,status,payment_amount_due,payment_amount_paid,discount_amount,deposit_initial,deposit_balance,deposit_transactions,is_demo")
      .eq("reg_no", code)
      .maybeSingle();
    if (error) throw error;
    if (!data || data.status !== "REGISTERED" || data.is_demo) return sendJson(res, 404, { ok: false, error: "not_found" });
    const tx = Array.isArray(data.deposit_transactions) ? data.deposit_transactions : [];
    const sum = (t) => tx.filter((x) => x && x.type === t).reduce((s, x) => s + (Number(x.amount) || 0), 0);
    return sendJson(res, 200, {
      ok: true,
      data: {
        regNo: data.reg_no,
        amountDue: data.payment_amount_due || 0,
        amountPaid: data.payment_amount_paid || 0,
        discountAmount: data.discount_amount || 0,
        depositInitial: data.deposit_initial || 0,
        depositBalance: data.deposit_balance || 0,
        kokUsage: sum("USAGE"),
        topups: sum("TOPUP"),
      },
    });
  } catch (e) {
    console.error("player-money error", e);
    return sendJson(res, 500, { ok: false, error: "server_error" });
  }
};
