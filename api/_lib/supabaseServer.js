// Service-role Supabase client — SERVER-SIDE ONLY.
// This file must never be imported by any browser-served/staging HTML asset.
// SUPABASE_SERVICE_ROLE_KEY must only exist as a Vercel server environment
// variable and is never sent to the client.

const { createClient } = require("@supabase/supabase-js");

let cachedClient = null;

function getServiceClient() {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  }

  cachedClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

module.exports = { getServiceClient };
