-- Enable RLS on two public tables flagged by Dood's security sweep.
--
-- grain_heartbeat and buddy_pending_menus are both service-role-only:
-- the grain app writes them via SUPABASE_SERVICE_ROLE_KEY and no
-- client-side code (browser/anon key) touches them. Service role
-- bypasses RLS, so enabling RLS with zero policies locks out anon +
-- authenticated while leaving the app unchanged.
--
-- This fixes the 2 ERROR-level advisories:
--   rls_disabled_in_public / public.grain_heartbeat
--   rls_disabled_in_public / public.buddy_pending_menus

-- DELIBERATELY NO POLICIES: service-role-only.
-- Future migrations adding an anon/authenticated policy should be
-- scrutinized — these tables are not user-facing.
ALTER TABLE public.grain_heartbeat ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buddy_pending_menus ENABLE ROW LEVEL SECURITY;
