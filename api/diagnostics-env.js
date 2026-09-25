// TEMPORARY DIAGNOSTIC ENDPOINT — safe to deploy, returns ONLY booleans and
// Vercel's own auto-injected metadata (branch/env name). Never returns actual
// secret values. Delete this file once the admin-login issue is resolved.

module.exports = async function handler(req, res) {
  res.status(200).setHeader("Content-Type", "application/json");
  res.send(JSON.stringify({
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    ADMIN_SESSION_SECRET: !!process.env.ADMIN_SESSION_SECRET,
    vercelEnv: process.env.VERCEL_ENV || null,
    gitBranch: process.env.VERCEL_GIT_COMMIT_REF || null,
    gitCommitSha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    deploymentUrl: process.env.VERCEL_URL || null,
  }));
};
