// Shared authorization helpers for admin-read / admin-mutate.
// "SUPER" scope can touch anything. A category scope (e.g. "PRIME") may
// only touch registrations/drawing/matches/schedule data belonging to
// that same category — mirroring the existing client-side adminCategoryScope
// restriction in current.html (viewAdminList / viewAdminDetail / adminTabs).

function isSuper(session) {
  return !!session && session.scope === "SUPER";
}

function scopeAllowsCategory(session, categoryCode) {
  if (!session) return false;
  if (session.scope === "SUPER") return true;
  return session.scope === categoryCode;
}

function sendJson(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(body));
}

function requireSession(session, res) {
  if (!session) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

module.exports = { isSuper, scopeAllowsCategory, sendJson, requireSession };
