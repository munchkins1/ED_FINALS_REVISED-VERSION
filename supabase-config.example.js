/*
 * CampusQR - local Supabase configuration TEMPLATE.
 *
 * 1. Copy this file to a new file named:  supabase-config.js
 *    (that real file is git-ignored so your keys are never committed).
 * 2. Replace the values below with your own Supabase project values
 *    (Supabase Dashboard -> Project Settings -> API).
 *
 * IMPORTANT SECURITY NOTES
 * ------------------------
 * - Use ONLY the "anon / public" key here. It is designed to be exposed in
 *   the browser and is safe ONLY because Row Level Security (RLS) is enabled
 *   on every table (see sql/03_rls_policies.sql).
 * - NEVER place the "service_role" key, database password, or any other
 *   secret in this file or anywhere in the project source.
 */
window.SUPABASE_CONFIG = {
  url: "https://ufiljxagpurtfxuzamto.supabase.co",
  anonKey: "sb_publishable_MXrwhN3M-m8hT0Nkdao4tQ_TAjKggmB"
};
