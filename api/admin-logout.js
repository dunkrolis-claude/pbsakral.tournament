const { buildClearCookie } = require("./_lib/session");
const { sendJson } = require("./_lib/authz");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }
  res.setHeader("Set-Cookie", buildClearCookie());
  return sendJson(res, 200, { ok: true });
};
