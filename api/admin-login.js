const { getServiceClient } = require("./_lib/supabaseServer");
const { createSessionToken, buildSetCookie } = require("./_lib/session");
const { sendJson } = require("./_lib/authz");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const pin = body && typeof body.pin === "string" ? body.pin.trim() : "";

  if (!pin) {
    return sendJson(res, 400, { ok: false, error: "pin_required" });
  }

  try {
    const supabase = getServiceClient();
    const { data: scope, error } = await supabase.rpc("find_admin_scope_by_pin", {
      p_pin: pin,
    });

    if (error) {
      console.error("admin-login rpc error", error);
      return sendJson(res, 500, { ok: false, error: "server_error" });
    }

    if (!scope) {
      return sendJson(res, 401, { ok: false, error: "invalid_pin" });
    }

    const token = createSessionToken(scope);
    res.setHeader("Set-Cookie", buildSetCookie(token));
    return sendJson(res, 200, { ok: true, scope });
  } catch (e) {
    console.error("admin-login error", e);
    return sendJson(res, 500, { ok: false, error: "server_error" });
  }
};
