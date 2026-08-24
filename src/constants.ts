export const CLIENT_ID = process.env.CLIENT_ID || "Ov23libuCcWgJFNy6Cm9";

/** Injected at build time by esbuild — identifies exactly which bundle is running. */
export const BUILD_TIMESTAMP = process.env.BUILD_TIMESTAMP || "dev";

export const GITHUB_DEVICE_URL = "https://github.com/login/device/code";
export const GITHUB_TOKEN_URL  = "https://github.com/login/oauth/access_token";
export const GITHUB_API_BASE   = "https://api.github.com";

export const PLUGIN_ID         = "ultimate-vault-sync";
export const LEGACY_PLUGIN_ID  = "ultimate-obsi-sync"; // previous id — installs before rebrand
export const LEGACY_PLUGIN_ID_OLD = "git-obsi-sync"; // earliest id — very old installs
export const GIT_AUTHOR_NAME   = "Ultimate Vault Sync";
export const GIT_AUTHOR_EMAIL  = "sync@obsidian.local";
export const GIT_DIR           = ".git";
export const SYNC_DEBOUNCE_MS = 1000;
export const SYNC_DEBOUNCE_MIN_MS = 500;
export const SYNC_DEBOUNCE_MAX_MS = 10_000;
export const SYNC_DEBOUNCE_STEP_MS = 500;
/** Factory default before 1s became the default — migrate only this exact value. */
export const LEGACY_SYNC_DEBOUNCE_MS = 3000;

/** Clamp and snap to the slider step so stored values always match the UI. */
export function clampDebounceMs(ms: number): number {
  if (!Number.isFinite(ms)) return SYNC_DEBOUNCE_MS;
  const clamped = Math.min(SYNC_DEBOUNCE_MAX_MS, Math.max(SYNC_DEBOUNCE_MIN_MS, ms));
  return Math.round(clamped / SYNC_DEBOUNCE_STEP_MS) * SYNC_DEBOUNCE_STEP_MS;
}
export const PULL_INTERVAL_SEC = 30;
export const PULL_INTERVAL_MIN_SEC = 5;
export const PULL_INTERVAL_MAX_SEC = 3600;

/** Clamp the background-pull poll interval to a sane range (seconds). */
export function clampPullIntervalSec(sec: number): number {
  if (!Number.isFinite(sec)) return PULL_INTERVAL_SEC;
  return Math.min(PULL_INTERVAL_MAX_SEC, Math.max(PULL_INTERVAL_MIN_SEC, Math.round(sec)));
}

export const SYNC_ON_OPEN      = true;
export const SYNC_ON_CLOSE     = true;
export const DEFAULT_BRANCH    = "main";
