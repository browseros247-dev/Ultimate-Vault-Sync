export interface PluginSettings {
  githubToken: string;           // OAuth access token (stored locally)
  githubUsername: string;        // Authenticated GitHub username
  repoName: string;              // e.g. "obsidian-my-vault"
  autoSync: boolean;             // auto-sync on file changes
  syncOnFocus: boolean;          // pull on window/tab focus
  backgroundPullEnabled: boolean; // periodic background pull while connected
  pullIntervalSec: number;       // background pull poll interval (seconds)
  syncIntervalMs: number;        // debounce window
  excludePatterns: string[];     // glob patterns to ignore (e.g. ".obsidian/workspace")
  includePatterns: string[];     // glob patterns to include (empty = all files)
  lastSyncTime: number;          // unix timestamp of last successful sync
  lastSyncOutcome: SyncOutcome | null; // result of the most recent sync attempt
  commitMessageTemplate: string; // e.g. "sync: {{datetime}}"
  setupInProgress?: boolean;     // another instance is mid repository setup
  setupStartedAt?: number;       // epoch ms of the setup start (crash-recovery staleness)
  /** Set after the one-shot 3000→1000 default migrate so a user-chosen 3000 is kept. */
  syncDebounceMigrated?: boolean;
}

export type SyncOutcome = {
  status: "ok" | "error" | "conflict";
  message?: string;
  /** Stable error code from src/debug/errors.ts (present when status is "error"). */
  code?: string;
  timestamp: number;
};

import { PLUGIN_ID, SYNC_DEBOUNCE_MS, PULL_INTERVAL_SEC } from "./constants";

/** Patterns that must always be excluded so the plugin's own writes never self-trigger sync. */
export function getProtectedExcludes(configDir: string): string[] {
  return [
    ".git",
    ".git/**",
    `${configDir}/plugins/*/data.json`,
    `${configDir}/plugins/${PLUGIN_ID}/data.json`,
    `${configDir}/plugins/${PLUGIN_ID}/logs/*`,
    `${configDir}/plugins/${PLUGIN_ID}/logs/**`,
    `${configDir}/plugins/${PLUGIN_ID}/trash-*/**`,
  ];
}
export const PROTECTED_EXCLUDES = getProtectedExcludes(".obsidian");

export function getDefaultExcludePatterns(configDir: string): string[] {
  return [
    `${configDir}/workspace`,
    `${configDir}/workspace.json`,
    `${configDir}/workspace-mobile.json`,
    ...getProtectedExcludes(configDir),
  ];
}

export function buildDefaultSettings(configDir: string): PluginSettings {
  return {
    githubToken: "",
    githubUsername: "",
    repoName: "",
    autoSync: true,
    syncOnFocus: true,
    backgroundPullEnabled: true,
    pullIntervalSec: PULL_INTERVAL_SEC,
    syncIntervalMs: SYNC_DEBOUNCE_MS,
    excludePatterns: getDefaultExcludePatterns(configDir),
    includePatterns: [],
    lastSyncTime: 0,
    lastSyncOutcome: null,
    commitMessageTemplate: "sync: {{datetime}}",
  };
}

/** Factory defaults for the stock config folder name; runtime may rebuild via configDir. */
export const DEFAULT_SETTINGS: PluginSettings = buildDefaultSettings(".obsidian");

export interface DeviceFlowResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitHubUser {
  login: string;
  id: number;
  name: string;
  email: string;
}

export interface GitHubRepo {
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  html_url: string;
}

export type SyncStatus =
  | "idle"
  | "pulling"
  | "pushing"
  | "conflict"
  | "error"
  | "connecting";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface ConflictFile {
  path: string;
  ours: string;
  theirs: string;
  binary?: boolean;
}

export interface SyncResult {
  success: boolean;
  conflictFiles: ConflictFile[];
  error?: string;
}
