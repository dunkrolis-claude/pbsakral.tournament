const { getServiceClient } = require("./_lib/supabaseServer");
const { readSessionFromRequest } = require("./_lib/session");
const { isSuper, scopeAllowsCategory, sendJson, requireSession } = require("./_lib/authz");

// Same short-string id format as the existing client uid() function, so
// ids generated here stay compatible with drawing.slots / match
// participantId references and with old Firebase-era backups.
function genCompatId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function nowIso() {
  return new Date().toISOString();
}

const CREATE_ALLOWED_FIELDS = [
  "category",
  "player1",
  "player2",
  "player1_photo_url",
  "player2_photo_url",
  "club",
  "whatsapp",
  "whatsapp_number_normalized",
  "whatsapp_opt_in",
  "whatsapp_opt_in_at",
  "domicile",
  "note",
  "verification_video",
  "rules_accepted",
  "rules_accepted_at",
  "category_rules_version",
];

// Statuses that CREATE_REGISTRATION is allowed to set directly.
// REGISTERED/CANCELLED are never allowed here.
const CREATE_ALLOWED_STATUSES = ["WAITING_VALIDATION", "WAITING_PAYMENT", "WAITING_LIST"];

// Fields UPDATE_REGISTRATION may touch. Deliberately excludes reg_no.
// status may be set EXCEPT to 'REGISTERED' (that must go through
// MARK_PAID / VERIFY_PAYMENT so regNo allocation stays atomic + consistent).
const UPDATE_ALLOWED_FIELDS = [
  "status",
  "pending_category",
  "admin_note",
  "note",
  "notifications",
  "deposit_initial",
  "deposit_balance",
  "deposit_transactions",
  "payment", // partial object merge; payment.status may NOT be forced to PAID here
  "payment_status", // may be set to UNPAID / WAITING_VERIFICATION only (not PAID)
  "payment_amount_paid",
  "player1_photo_url",
  "player2_photo_url",
  "is_demo",
];

function pickAllowed(payload, allowedFields) {
  const out = {};
  for (const key of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      out[key] = payload[key];
    }
  }
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const action = body && body.action;
  const payload = (body && body.payload) || {};

  if (!action) {
    return sendJson(res, 400, { ok: false, error: "action_required" });
  }

  const supabase = getServiceClient();
  const session = readSessionFromRequest(req);

  try {
    // ------------------------------------------------------------------
    // PUBLIC action — no session required. Everything else below is
    // privileged and requires a valid session.
    // ------------------------------------------------------------------
    if (action === "CREATE_REGISTRATION") {
      const fields = pickAllowed(payload, CREATE_ALLOWED_FIELDS);
      if (!fields.category || !fields.player1 || !fields.player2 || !fields.club || !fields.whatsapp || !fields.domicile) {
        return sendJson(res, 400, { ok: false, error: "missing_required_fields" });
      }

      // Look up category fee for payment_amount_due (server-trusted source,
      // never taken from client payload).
      const { data: settings, error: settingsErr } = await supabase
        .from("tournament_settings")
        .select("categories")
        .eq("id", 1)
        .maybeSingle();
      if (settingsErr) throw settingsErr;
      const cat = (settings?.categories || []).find((c) => c.code === fields.category);
      if (!cat) return sendJson(res, 400, { ok: false, error: "unknown_category" });

      // If an admin session exists, allow WAITING_PAYMENT/WAITING_LIST per
      // client-computed quota decision (business logic stays client-side).
      // If no session (public self-registration), force WAITING_VALIDATION
      // regardless of what the client sent.
      let status = "WAITING_VALIDATION";
      if (session) {
        if (!scopeAllowsCategory(session, fields.category)) {
          return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
        }
        if (CREATE_ALLOWED_STATUSES.includes(payload.status)) {
          status = payload.status;
        }
      }

      const row = {
        id: genCompatId(),
        reg_no: null,
        category: fields.category,
        pending_category: null,
        status,
        player1: fields.player1,
        player2: fields.player2,
        player1_photo_url: fields.player1_photo_url || "",
        player2_photo_url: fields.player2_photo_url || "",
        club: fields.club,
        whatsapp: fields.whatsapp,
        whatsapp_number_normalized: fields.whatsapp_number_normalized || null,
        whatsapp_opt_in: !!fields.whatsapp_opt_in,
        whatsapp_opt_in_at: fields.whatsapp_opt_in_at || null,
        domicile: fields.domicile,
        note: fields.note || "",
        admin_note: "",
        category_rules_version: fields.category_rules_version || null,
        rules_accepted: !!fields.rules_accepted,
        rules_accepted_at: fields.rules_accepted_at || null,
        payment_status: "UNPAID",
        payment_amount_due: cat.fee || 0,
        payment_amount_paid: 0,
        deposit_initial: 0,
        deposit_balance: 0,
        is_demo: false,
        payment: { method: "", amountDue: cat.fee || 0, amountPaid: 0, senderName: "", proofDataUrl: "", status: "UNPAID", verifiedBy: "", verifiedAt: "" },
        verification_video: fields.verification_video || { type: "link", value: "" },
        deposit_transactions: [],
        notifications: Array.isArray(payload.notifications) ? payload.notifications : [],
        created_at: nowIso(),
        updated_at: nowIso(),
      };

      const { data, error } = await supabase.from("registrations").insert(row).select().single();
      if (error) throw error;
      return sendJson(res, 200, { ok: true, data });
    }

    // ------------------------------------------------------------------
    // Everything below requires a valid admin/category session.
    // ------------------------------------------------------------------
    if (!requireSession(session, res)) return;

    if (action === "MARK_PAID" || action === "VERIFY_PAYMENT") {
      const { id, method, amount, sender, verifiedBy } = payload;
      if (!id) return sendJson(res, 400, { ok: false, error: "id_required" });

      const { data: existing, error: fetchErr } = await supabase
        .from("registrations")
        .select("category")
        .eq("id", id)
        .maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!existing) return sendJson(res, 404, { ok: false, error: "not_found" });
      if (!scopeAllowsCategory(session, existing.category)) {
        return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      }

      const { data, error } = await supabase.rpc("mark_registration_paid", {
        p_id: id,
        p_method: method || "TRANSFER",
        p_amount: Number(amount) || 0,
        p_sender: sender || "",
        p_verified_by: verifiedBy || "Admin",
      });
      if (error) {
        if (String(error.message).includes("already_has_reg_no")) {
          return sendJson(res, 409, { ok: false, error: "already_paid" });
        }
        throw error;
      }
      return sendJson(res, 200, { ok: true, data });
    }

    if (action === "REJECT_PAYMENT") {
      const { id } = payload;
      if (!id) return sendJson(res, 400, { ok: false, error: "id_required" });
      const { data: existing, error: fetchErr } = await supabase
        .from("registrations").select("category").eq("id", id).maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!existing) return sendJson(res, 404, { ok: false, error: "not_found" });
      if (!scopeAllowsCategory(session, existing.category)) {
        return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      }
      const { data, error } = await supabase
        .from("registrations")
        .update({ status: "WAITING_PAYMENT", payment_status: "UNPAID", updated_at: nowIso() })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return sendJson(res, 200, { ok: true, data });
    }

    if (action === "UPDATE_REGISTRATION") {
      const { id } = payload;
      if (!id) return sendJson(res, 400, { ok: false, error: "id_required" });

      const fields = pickAllowed(payload, UPDATE_ALLOWED_FIELDS);
      if (fields.status === "REGISTERED") {
        return sendJson(res, 400, { ok: false, error: "use_mark_paid_or_verify_payment" });
      }
      if (fields.payment_status === "PAID") {
        return sendJson(res, 400, { ok: false, error: "use_mark_paid_or_verify_payment" });
      }
      if (fields.payment && fields.payment.status === "PAID") {
        return sendJson(res, 400, { ok: false, error: "use_mark_paid_or_verify_payment" });
      }

      const { data: existing, error: fetchErr } = await supabase
        .from("registrations").select("category, payment").eq("id", id).maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!existing) return sendJson(res, 404, { ok: false, error: "not_found" });
      if (!scopeAllowsCategory(session, existing.category)) {
        return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      }

      // merge payment jsonb instead of overwriting wholesale, if provided
      if (fields.payment) {
        fields.payment = { ...(existing.payment || {}), ...fields.payment };
      }
      fields.updated_at = nowIso();

      const { data, error } = await supabase
        .from("registrations").update(fields).eq("id", id).select().single();
      if (error) throw error;
      return sendJson(res, 200, { ok: true, data });
    }

    if (action === "DELETE_REGISTRATION") {
      const { id } = payload;
      if (!id) return sendJson(res, 400, { ok: false, error: "id_required" });
      const { data: existing, error: fetchErr } = await supabase
        .from("registrations").select("category").eq("id", id).maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!existing) return sendJson(res, 200, { ok: true, alreadyDeleted: true });
      if (!scopeAllowsCategory(session, existing.category)) {
        return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      }

      const { error: delErr } = await supabase.from("registrations").delete().eq("id", id);
      if (delErr) throw delErr;

      // best-effort scrub of drawing slot references (matches existing
      // deleteRegistrationPermanently() behavior in current.html)
      const { data: drawRow } = await supabase
        .from("drawing").select("*").eq("category_code", existing.category).maybeSingle();
      if (drawRow && Array.isArray(drawRow.data?.slots) && drawRow.data.slots.includes(id)) {
        const newSlots = drawRow.data.slots.map((s) => (s === id ? null : s));
        const newData = { ...drawRow.data, slots: newSlots };
        await supabase.rpc("cas_update_drawing", {
          p_category_code: existing.category,
          p_expected_version: drawRow.version,
          p_data: newData,
        }).then(() => {}, () => {
          // best-effort only; ignore version conflicts here
        });
      }

      return sendJson(res, 200, { ok: true });
    }

    if (action === "SAVE_SETTINGS") {
      if (!isSuper(session)) return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      const allowed = pickAllowed(payload, [
        "categories", "registration_open", "whatsapp_enabled",
        "public_results_visible", "scoring_target", "referee_names",
      ]);
      allowed.updated_at = nowIso();
      const { data, error } = await supabase
        .from("tournament_settings").update(allowed).eq("id", 1).select().single();
      if (error) throw error;
      return sendJson(res, 200, { ok: true, data });
    }

    if (action === "UPDATE_PIN") {
      if (!isSuper(session)) return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      const { scope, newPin } = payload;
      if (!scope || !newPin) return sendJson(res, 400, { ok: false, error: "scope_and_pin_required" });
      const { error } = await supabase.rpc("set_admin_pin", { p_scope: scope, p_new_pin: newPin });
      if (error) throw error;
      return sendJson(res, 200, { ok: true });
    }

    if (action === "SAVE_DRAWING") {
      const { categoryCode, expectedVersion, data: newData } = payload;
      if (!categoryCode || expectedVersion === undefined) {
        return sendJson(res, 400, { ok: false, error: "category_and_version_required" });
      }
      if (!scopeAllowsCategory(session, categoryCode)) {
        return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      }
      const { data, error } = await supabase.rpc("cas_update_drawing", {
        p_category_code: categoryCode, p_expected_version: expectedVersion, p_data: newData,
      });
      if (error) {
        if (String(error.message).includes("version_conflict")) {
          const { data: current } = await supabase.from("drawing").select("version").eq("category_code", categoryCode).maybeSingle();
          return sendJson(res, 409, { ok: false, error: "version_conflict", current_version: current?.version });
        }
        throw error;
      }
      return sendJson(res, 200, { ok: true, data });
    }

    if (action === "SAVE_MATCHES") {
      const { categoryCode, expectedVersion, data: newData } = payload;
      if (!categoryCode || expectedVersion === undefined) {
        return sendJson(res, 400, { ok: false, error: "category_and_version_required" });
      }
      if (!scopeAllowsCategory(session, categoryCode)) {
        return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      }
      const { data, error } = await supabase.rpc("cas_update_matches", {
        p_category_code: categoryCode, p_expected_version: expectedVersion, p_data: newData,
      });
      if (error) {
        if (String(error.message).includes("version_conflict")) {
          const { data: current } = await supabase.from("matches").select("version").eq("category_code", categoryCode).maybeSingle();
          return sendJson(res, 409, { ok: false, error: "version_conflict", current_version: current?.version });
        }
        throw error;
      }
      return sendJson(res, 200, { ok: true, data });
    }

    if (action === "SAVE_SCHEDULE") {
      const { expectedVersion, data: newData } = payload;
      if (expectedVersion === undefined) {
        return sendJson(res, 400, { ok: false, error: "version_required" });
      }
      // schedule spans all categories; require SUPER to avoid one category
      // admin overwriting another category's schedule slots wholesale.
      if (!isSuper(session)) return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      const { data, error } = await supabase.rpc("cas_update_schedule", {
        p_expected_version: expectedVersion, p_data: newData,
      });
      if (error) {
        if (String(error.message).includes("version_conflict")) {
          const { data: current } = await supabase.from("schedule").select("version").eq("id", 1).maybeSingle();
          return sendJson(res, 409, { ok: false, error: "version_conflict", current_version: current?.version });
        }
        throw error;
      }
      return sendJson(res, 200, { ok: true, data });
    }

    if (action === "ADD_EXPENSE") {
      if (!isSuper(session)) return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      const { description, amount, source } = payload;
      if (!description || !amount || !source) {
        return sendJson(res, 400, { ok: false, error: "missing_fields" });
      }
      const row = { id: genCompatId(), description, amount: Number(amount), source, created_at: nowIso() };
      const { data, error } = await supabase.from("expenses").insert(row).select().single();
      if (error) throw error;
      return sendJson(res, 200, { ok: true, data });
    }

    if (action === "REMOVE_EXPENSE") {
      if (!isSuper(session)) return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      const { id } = payload;
      if (!id) return sendJson(res, 400, { ok: false, error: "id_required" });
      const { error } = await supabase.from("expenses").delete().eq("id", id);
      if (error) throw error;
      return sendJson(res, 200, { ok: true });
    }

    if (action === "CLEAR_DEMO_DATA") {
      if (!isSuper(session)) return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      const { error } = await supabase.from("registrations").delete().eq("is_demo", true);
      if (error) throw error;
      return sendJson(res, 200, { ok: true });
    }

    if (action === "RESET_ALL") {
      if (!isSuper(session)) return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      if (payload.confirm !== "HAPUS SEMUA") {
        return sendJson(res, 400, { ok: false, error: "confirmation_phrase_required" });
      }
      const { error: e1 } = await supabase.from("registrations").delete().neq("id", "__never__");
      if (e1) throw e1;
      const { error: e2 } = await supabase.from("expenses").delete().neq("id", "__never__");
      if (e2) throw e2;
      const cats = ["PRIME", "CORE", "RISING", "QUEENS"];
      for (const c of cats) {
        await supabase.from("drawing").update({ data: { locked: false, slots: [], auditLog: [] }, version: 1, updated_at: nowIso() }).eq("category_code", c);
        await supabase.from("matches").update({ data: { list: [] }, version: 1, updated_at: nowIso() }).eq("category_code", c);
      }
      await supabase.from("schedule").update({ data: { list: [] }, version: 1, updated_at: nowIso() }).eq("id", 1);
      await supabase.from("registration_counters").update({ current_value: 0 });
      return sendJson(res, 200, { ok: true });
    }

    if (action === "IMPORT_BACKUP") {
      if (!isSuper(session)) return sendJson(res, 403, { ok: false, error: "forbidden_scope" });
      const { meta, registrations, drawing, matches, schedule, expenses } = payload;

      if (Array.isArray(registrations)) {
        for (const reg of registrations) {
          const row = {
            id: reg.id, reg_no: reg.regNo ?? null, category: reg.category,
            pending_category: reg.pendingCategory ?? null, status: reg.status,
            player1: reg.player1, player2: reg.player2,
            player1_photo_url: reg.player1PhotoUrl || "", player2_photo_url: reg.player2PhotoUrl || "",
            club: reg.club, whatsapp: reg.whatsapp,
            whatsapp_number_normalized: reg.whatsappNumberNormalized || null,
            whatsapp_opt_in: !!reg.whatsappOptIn, whatsapp_opt_in_at: reg.whatsappOptInAt || null,
            domicile: reg.domicile, note: reg.note || "", admin_note: reg.adminNote || "",
            category_rules_version: reg.categoryRulesVersion || null,
            rules_accepted: !!reg.rulesAccepted, rules_accepted_at: reg.rulesAcceptedAt || null,
            payment_status: reg.payment?.status || "UNPAID",
            payment_amount_due: reg.payment?.amountDue || 0,
            payment_amount_paid: reg.payment?.amountPaid || 0,
            deposit_initial: reg.deposit?.initial || 0,
            deposit_balance: reg.deposit?.balance || 0,
            is_demo: !!reg.isDemo,
            payment: reg.payment || {},
            verification_video: reg.verificationVideo || { type: "link", value: "" },
            deposit_transactions: reg.depositTransactions || [],
            notifications: reg.notifications || [],
            created_at: reg.createdAt || nowIso(),
            updated_at: reg.updatedAt || nowIso(),
          };
          const { error } = await supabase.from("registrations").upsert(row);
          if (error) throw error;
        }
      }
      if (Array.isArray(expenses)) {
        for (const exp of expenses) {
          const { error } = await supabase.from("expenses").upsert({
            id: exp.id, description: exp.description, amount: exp.amount,
            source: exp.source, created_at: exp.createdAt || nowIso(),
          });
          if (error) throw error;
        }
      }
      if (meta) {
        const { error } = await supabase.from("tournament_settings").update({
          categories: meta.categories || [],
          registration_open: meta.settings?.registrationOpen ?? true,
          whatsapp_enabled: meta.settings?.whatsappEnabled ?? true,
          public_results_visible: meta.settings?.publicResultsVisible ?? false,
          scoring_target: meta.settings?.scoringTarget ?? 42,
          referee_names: meta.settings?.refereeNames || [],
          updated_at: nowIso(),
        }).eq("id", 1);
        if (error) throw error;
        // NOTE: meta.settings.adminPin / categoryPins from an old-format
        // backup are intentionally NOT imported here — PIN restore must be
        // a deliberate manual step (UPDATE_PIN), never a silent import.
      }
      if (drawing) {
        for (const [categoryCode, data] of Object.entries(drawing)) {
          const { error } = await supabase.from("drawing").upsert({
            category_code: categoryCode, data, version: 1, updated_at: nowIso(),
          });
          if (error) throw error;
        }
      }
      if (matches) {
        for (const [categoryCode, list] of Object.entries(matches)) {
          const { error } = await supabase.from("matches").upsert({
            category_code: categoryCode, data: { list }, version: 1, updated_at: nowIso(),
          });
          if (error) throw error;
        }
      }
      if (schedule) {
        const { error } = await supabase.from("schedule").upsert({
          id: 1, data: { list: schedule.list || schedule || [] }, version: 1, updated_at: nowIso(),
        });
        if (error) throw error;
      }

      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 400, { ok: false, error: "unknown_action" });
  } catch (e) {
    console.error("admin-mutate error", action, e);
    return sendJson(res, 500, { ok: false, error: "server_error" });
  }
};
