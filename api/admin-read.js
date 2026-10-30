const { getServiceClient } = require("./_lib/supabaseServer");
const { readSessionFromRequest } = require("./_lib/session");
const { isSuper, isReferee, refereeCourt, scopeAllowsCategory, sendJson, requireSession } = require("./_lib/authz");

// Fields exposed for the admin listing/index view (Pendaftar/Peserta pages).
// This is a superset of registrations_public (adds whatsapp/payment/deposit
// summary fields that the admin UI needs but must not be publicly selectable).
const INDEX_COLUMNS =
  "id, reg_no, category, status, player1, player2, club, whatsapp, " +
  "payment_status, payment_amount_due, payment_amount_paid, deposit_initial, " +
  "deposit_balance, discount_amount, discount_note, is_demo, created_at, updated_at";
// Tambahan: daftar pelunasan (metode tunai/transfer) untuk laporan keuangan. Bila sintaks ini ditolak,
// daftar pendaftar tetap harus tampil, jadi ada cadangan tanpa kolom ini.
const INDEX_COLUMNS_WITH_SETTLEMENTS = INDEX_COLUMNS + ", payment_settlements:payment->settlements, deposit_tx:deposit_transactions";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  const session = readSessionFromRequest(req);
  if (!requireSession(session, res)) return;

  const resource = req.query.resource;
  const supabase = getServiceClient();

  // Akun wasit hanya boleh membaca papan wasit.
  if (isReferee(session) && resource !== "ref_board") {
    return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
  }

  try {
    if (resource === "ref_board") {
      if (!isReferee(session) && !isSuper(session)) return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      const court = isReferee(session) ? refereeCourt(session) : "R";
      const { data: sch, error: e1 } = await supabase.from("schedule").select("data").eq("id", 1).maybeSingle();
      if (e1) throw e1;
      const all = (sch && sch.data && sch.data.list) || [];
      const entries = court === "R" ? all : all.filter((e) => e.court === court);
      const { data: st } = await supabase.from("tournament_settings").select("scoring_target").eq("id", 1).maybeSingle();
      const { data: mrows, error: e2 } = await supabase.from("matches").select("category_code, data");
      if (e2) throw e2;
      const wanted = new Set(entries.map((e) => e.category + "|" + e.matchId));
      const matches = [];
      (mrows || []).forEach((r) => {
        ((r.data && r.data.list) || []).forEach((m) => {
          if (wanted.has(r.category_code + "|" + m.id)) matches.push(Object.assign({ category: r.category_code }, m));
        });
      });
      const ids = new Set();
      matches.forEach((m) => [m.sideA, m.sideB].forEach((x) => { if (x && x.type === "participant" && x.participantId) ids.add(x.participantId); }));
      const names = {};
      if (ids.size) {
        const { data: regs, error: e3 } = await supabase.from("registrations").select("id, player1, player2").in("id", [...ids]);
        if (e3) throw e3;
        (regs || []).forEach((r) => { names[r.id] = [r.player1, r.player2]; });
      }
      return sendJson(res, 200, { ok: true, data: { court, entries, matches, names, target: (st && Number(st.scoring_target)) || 42 } });
    }

    if (resource === "referee_accounts") {
      if (!isSuper(session)) return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      // hanya scope + waktu; pin_hash tidak pernah dipilih
      const { data, error } = await supabase.from("admin_credentials").select("scope, updated_at");
      if (error) throw error;
      return sendJson(res, 200, { ok: true, data: (data || []).filter((r) => /^WASIT_[A-ER]$/.test(r.scope)) });
    }

    if (resource === "registrations_index") {
      const run = (cols) => {
        let q = supabase.from("registrations").select(cols);
        if (!isSuper(session)) q = q.eq("category", session.scope);
        return q;
      };
      let { data, error } = await run(INDEX_COLUMNS_WITH_SETTLEMENTS);
      if (error) {
        console.error("registrations_index with settlements failed, retrying without:", error.message);
        ({ data, error } = await run(INDEX_COLUMNS));
      }
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

    if (resource === "income_other" || resource === "budget_items") {
      if (!isSuper(session)) {
        return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      }
      const q = supabase.from(resource).select("*");
      const { data, error } = resource === "budget_items"
        ? await q.order("section").order("sort")
        : await q.order("created_at", { ascending: false });
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
