// Cari pasangan terdaftar lewat nomor HP pendaftar (untuk halaman pemain).
// Nomor HP TIDAK pernah dikembalikan; hanya data yang memang sudah publik di bagan
// (nama, level, klub) + kode booking. Hanya pendaftaran REGISTERED.
const { getServiceClient } = require("./_lib/supabaseServer");
const { sendJson } = require("./_lib/authz");

// Pembatas percobaan sederhana per IP (best-effort per instance serverless).
const HITS = new Map();
const WINDOW_MS = 10 * 60 * 1000, MAX_HITS = 30;
function limited(ip) {
  const now = Date.now();
  const arr = (HITS.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  HITS.set(ip, arr);
  if (HITS.size > 5000) HITS.clear();
  return arr.length > MAX_HITS;
}
function normalize(raw) {
  let d = String(raw || "").replace(/[^0-9]/g, "");
  if (d.startsWith("0")) d = "62" + d.slice(1);
  else if (d.startsWith("620")) d = "62" + d.slice(3);
  else if (!d.startsWith("62")) d = "62" + d;
  return "+" + d;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  const raw = String((req.query && req.query.phone) || "");
  const digits = raw.replace(/[\s\-+().]/g, "");
  if (!/^(0|62)\d{8,13}$/.test(digits)) return sendJson(res, 400, { ok: false, error: "invalid_phone" });
  const ip = String((req.headers && (req.headers["x-forwarded-for"] || "")) || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return sendJson(res, 429, { ok: false, error: "too_many_requests" });
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("registrations")
      .select("reg_no,category,status,player1,player2,club,is_demo")
      .eq("whatsapp_number_normalized", normalize(digits))
      .limit(20);
    if (error) throw error;
    const list = (data || [])
      .filter((r) => r.status === "REGISTERED" && !r.is_demo && r.reg_no)
      .map((r) => ({ regNo: r.reg_no, category: r.category, player1: r.player1, player2: r.player2, club: r.club || "" }));
    return sendJson(res, 200, { ok: true, data: list });
  } catch (e) {
    console.error("player-find error", e);
    return sendJson(res, 500, { ok: false, error: "server_error" });
  }
};
