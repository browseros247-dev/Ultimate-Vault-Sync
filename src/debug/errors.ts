/**
 * Central error taxonomy for Ultimate Obsidian Sync.
 *
 * Every failure that can reach the user or the debug log is mapped to a stable
 * `code`, a human-friendly `message` and, where possible, a suggested `action`.
 * The raw technical detail is preserved via `detail` for the debug log and the
 * persisted sync outcome — only the friendly surface is shown to the user.
 */

export interface ErrorInfo {
  /** Stable machine-readable identifier, e.g. "API_UNAUTHORIZED". */
  code: string;
  /** Human-friendly description shown to the user. */
  message: string;
  /** Optional suggested next step for the user. */
  action?: string;
  /** The original raw message, for the debug log / persisted outcome. */
  detail: string;
}

/** Error that carries a stable code and suggested action at the throw site. */
export class SyncError extends Error {
  readonly code: string;
  readonly action?: string;

  constructor(code: string, message: string, action?: string) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    this.action = action;
  }
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * Network/connectivity failure signatures across Obsidian, isomorphic-git and Node.
 * Includes Android/Capacitor shapes surfaced by requestUrl on mobile
 * (UnknownHostException etc.) plus the POSIX errno spelling EAI_AGAIN.
 */
const NETWORK_PATTERNS: RegExp[] = [
  /fetch failed/i,
  /failed to fetch/i,
  /networkerror/i,
  /network request failed/i,
  /net::err_/i,
  /enetunreach|enotfound|econnrefused|etimedout|ehostunreach/i,
  /eai_again/i,
  /unknownhostexception/i,
  /unable to resolve host/i,
  /no address associated/i,
  /socket hang up/i,
  /connection (was )?reset/i,
  /the operation was aborted/i,
];

/** True when the thrown value looks like a transport/connectivity failure. */
export function isNetworkError(error: unknown): boolean {
  const raw = toMessage(error);
  return NETWORK_PATTERNS.some((pattern) => pattern.test(raw));
}

function describeApiStatus(status: number, raw: string): ErrorInfo {
  switch (status) {
    case 401:
      return {
        code: "API_UNAUTHORIZED",
        message: "GitHub rejected the authorization.",
        action: "Disconnect and reconnect your GitHub account in settings.",
        detail: raw,
      };
    case 403:
      return /rate limit/i.test(raw)
        ? {
            code: "API_RATE_LIMITED",
            message: "GitHub's rate limit was reached.",
            action: "Wait a few minutes and try again.",
            detail: raw,
          }
        : {
            code: "API_FORBIDDEN",
            message: "GitHub denied this action with the current authorization.",
            detail: raw,
          };
    case 404:
      return {
        code: "API_NOT_FOUND",
        message: "The repository was not found — it may have been deleted.",
        detail: raw,
      };
    case 409:
      return {
        code: "API_CONFLICT",
        message: "The repository is in an unexpected state on GitHub.",
        detail: raw,
      };
    case 422:
      return {
        code: "API_UNPROCESSABLE",
        message: "GitHub rejected the repository name.",
        action: "Choose a different repository name.",
        detail: raw,
      };
    default:
      if (status >= 500) {
        return {
          code: "API_SERVER_ERROR",
          message: "GitHub is having problems.",
          action: "Wait a moment and try again.",
          detail: raw,
        };
      }
      return {
        code: "API_REQUEST_FAILED",
        message: "GitHub could not complete the request.",
        detail: raw,
      };
  }
}

/**
 * Map any thrown value (Error, plain-string reject, API response) to a stable
 * code, friendly message, suggested action and the raw detail. Never throws.
 */
export function errorInfo(error: unknown): ErrorInfo {
  if (error instanceof SyncError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.action ? { action: error.action } : {}),
      detail: error.message,
    };
  }

  const raw = toMessage(error);

  // GitHub Device Flow (plain-string rejects from github-device.ts).
  if (/github device flow failed/i.test(raw)) {
    return {
      code: "AUTH_UNAVAILABLE",
      message: "GitHub could not start the login flow.",
      action: "Check your connection and try again.",
      detail: raw,
    };
  }
  if (/code expired\. please reconnect/i.test(raw)) {
    return {
      code: "AUTH_CODE_EXPIRED",
      message: "The login code expired before it was approved.",
      action: "Click Connect GitHub and try again.",
      detail: raw,
    };
  }
  if (/access denied/i.test(raw)) {
    return {
      code: "AUTH_DENIED",
      message: "The authorization was not approved in GitHub.",
      action: "Click Connect GitHub to start a new login.",
      detail: raw,
    };
  }
  if (/device code expired/i.test(raw)) {
    return {
      code: "AUTH_DEVICE_EXPIRED",
      message: "The login request timed out before you entered the code.",
      action: "Click Connect GitHub and enter the code sooner.",
      detail: raw,
    };
  }

  // GitHub REST API errors (ghFetch throws "GitHub API error <status>: <msg>").
  const apiMatch = raw.match(/GitHub API error (\d{3})/i);
  if (apiMatch) return describeApiStatus(Number(apiMatch[1]), raw);

  // Local repository problems.
  if (/unrelated|mergenotsupported/i.test(raw)) {
    return {
      code: "GIT_UNRELATED_HISTORIES",
      message: "This device and GitHub do not share a common git history.",
      action: "Use Change repository and replace this vault from GitHub, or connect a new empty repo.",
      detail: raw,
    };
  }

  if (/not initialized/i.test(raw)) {
    return {
      code: "LOCAL_REPO_NOT_INITIALIZED",
      message: "The local repository is not initialized.",
      action: "Disconnect and reconnect the vault in settings to repair it.",
      detail: raw,
    };
  }
  if (/repository name cannot be empty/i.test(raw)) {
    return {
      code: "REPO_NAME_REQUIRED",
      message: "A repository name is required.",
      action: "Enter a repository name and try again.",
      detail: raw,
    };
  }

  // Git transport / auth.
  if (/authentication failed/i.test(raw)) {
    return {
      code: "GIT_AUTH_FAILED",
      message: "GitHub rejected the saved credentials.",
      action: "Disconnect and reconnect your GitHub account in settings.",
      detail: raw,
    };
  }
  if (/non-fast-forward|rejected/i.test(raw)) {
    return {
      code: "GIT_PUSH_REJECTED",
      message: "GitHub rejected the push because the remote has moved.",
      action: "Sync again — the changes will be merged automatically.",
      detail: raw,
    };
  }

  // Network / connectivity.
  if (isNetworkError(raw)) {
    return {
      code: "NETWORK_UNAVAILABLE",
      message: "Could not reach GitHub.",
      action: "Check your internet connection and try again.",
      detail: raw,
    };
  }

  // Fallback: keep the raw detail as the message (no known mapping).
  return { code: "UNKNOWN", message: raw, detail: raw };
}