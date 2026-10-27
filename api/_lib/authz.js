// Shared authorization helpers for admin-read / admin-mutate.
// "SUPER" scope can touch anything. A category scope (e.g. "PRIME") may
// only touch registrations/drawing/matches/schedule data belonging to
// that same category — mirroring the existing client-side adminCategoryScope
// restriction in current.html (viewAdminList / viewAdminDetail / adminTabs).

function isSuper(session) {
  return !!session && session.scope === "SUPER";
}

// Akun wasit: scope "WASIT_A".."WASIT_E" (per lapangan) dan "WASIT_R" (cadangan, semua lapangan).
function isReferee(session) {
  return !!session && typeof session.scope === "string" && /^WASIT_[A-ER]$/.test(session.scope);
}
function refereeCourt(session) {
  return isReferee(session) ? session.scope.slice(6) : null;
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

module.exports = { isReferee, refereeCourt, isSuper, scopeAllowsCategory, sendJson, requireSession };
