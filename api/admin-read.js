const { getServiceClient } = require("./_lib/supabaseServer");
const { readSessionFromRequest } = require("./_lib/session");
const { isSuper, scopeAllowsCategory, sendJson, requireSession } = require("./_lib/authz");

// Fields exposed for the admin listing/index view (Pendaftar/Peserta pages).
// This is a superset of registrations_public (adds whatsapp/payment/deposit
// summary fields that the admin UI needs but must not be publicly selectable).
const INDEX_COLUMNS =
  "id, reg_no, category, status, player1, player2, club, whatsapp, " +
  "payment_status, payment_amount_due, payment_amount_paid, deposit_initial, " +
  "deposit_balance, is_demo, created_at, updated_at";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  const session = readSessionFromRequest(req);
  if (!requireSession(session, res)) return;

  const resource = req.query.resource;
  const supabase = getServiceClient();

  try {
    if (resource === "registrations_index") {
      let query = supabase.from("registrations").select(INDEX_COLUMNS);
      if (!isSuper(session)) {
        query = query.eq("category", session.scope);
      }
      const { data, error } = await query;
      if (error) throw error;
      return sendJson(res, 200, { ok: true, data });
    }

    if (resource === "registration") {
      const id = req.query.id;
      if (!id) return sendJson(res, 400, { ok: false, error: "id_required" });
      const { data, error } = await supabase
        .from("registrations")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return sendJson(res, 404, { ok: false, error: "not_found" });
      if (!scopeAllowsCategory(session, data.category)) {
        return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      }
      return sendJson(res, 200, { ok: true, data });
    }

    if (resource === "expenses") {
      if (!isSuper(session)) {
        return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      }
      const { data, error } = await supabase
        .from("expenses")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return sendJson(res, 200, { ok: true, data });
    }

    if (resource === "drawing_all") {
      // admin can always see drawing/matches/schedule regardless of the
      // public_results_visible flag (that flag only gates PUBLIC reads).
      const { data, error } = await supabase.from("drawing").select("*");
      if (error) throw error;
      const filtered = isSuper(session)
        ? data
        : data.filter((r) => r.category_code === session.scope);
      return sendJson(res, 200, { ok: true, data: filtered });
    }

    if (resource === "matches_all") {
      const { data, error } = await supabase.from("matches").select("*");
      if (error) throw error;
      const filtered = isSuper(session)
        ? data
        : data.filter((r) => r.category_code === session.scope);
      return sendJson(res, 200, { ok: true, data: filtered });
    }

    if (resource === "schedule") {
      const { data, error } = await supabase
        .from("schedule")
        .select("*")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      return sendJson(res, 200, { ok: true, data });
    }

    return sendJson(res, 400, { ok: false, error: "unknown_resource" });
  } catch (e) {
    console.error("admin-read error", e);
    return sendJson(res, 500, { ok: false, error: "server_error" });
  }
};
