/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** e.g. https://<project-ref>.supabase.co */
  readonly VITE_SUPABASE_URL?: string;
  /**
   * The `sb_publishable_...` key. Safe to ship in the bundle only because Row
   * Level Security is enabled on every table. Never put `sb_secret_...` here.
   */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
