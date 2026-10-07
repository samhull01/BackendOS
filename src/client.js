import { createClient } from "@supabase/supabase-js";
window.BackendOSConfig = { url: BUILD_URL, key: BUILD_KEY };
window.supabaseClient =
  BUILD_URL && BUILD_KEY ? createClient(BUILD_URL, BUILD_KEY) : null;
