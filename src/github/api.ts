import { requestUrl } from "obsidian";
import { GITHUB_API_BASE } from "../constants";
import { GitHubUser, GitHubRepo } from "../types";

async function ghFetch<T>(
  path: string,
  token: string,
  options: { method?: string; body?: object } = {}
): Promise<T> {
  const response = await requestUrl({
    url: `${GITHUB_API_BASE}${path}`,
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    throw: false,
  });

  if (response.status >= 400) {
    // Error bodies are normally JSON, but proxies/HTML error pages can yield
    // nothing parseable — never let detail extraction mask the status code.
    const err = (response.json ?? {}) as { message?: string };
    throw new Error(`GitHub API error ${response.status}: ${err.message ?? "unknown"}`);
  }

  return response.json as T;
}

/** Get authenticated user info */
export async function getAuthenticatedUser(token: string): Promise<GitHubUser> {
  return ghFetch<GitHubUser>("/user", token);
}

/**
 * List private repos owned by the authenticated user, most recently updated
 * first. Filtered to private repos only — the plugin never syncs to public
 * repositories.
 *
 * Follows pagination until exhausted (capped at 10 pages / 1000 repos).
 * NOTE: the `type` query param must NOT be combined with `affiliation` —
 * GitHub rejects such requests with 422. `affiliation=owner` already scopes
 * the list to repos the user owns, so `type` is simply omitted.
 */
export async function getUserRepos(token: string): Promise<GitHubRepo[]> {
  const PER_PAGE = 100;
  const MAX_PAGES = 10;
  const all: GitHubRepo[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const repos = await ghFetch<GitHubRepo[]>(
      `/user/repos?per_page=${PER_PAGE}&page=${page}&affiliation=owner&sort=updated`,
      token
    );
    if (!Array.isArray(repos) || repos.length === 0) break;
    all.push(...repos);
    if (repos.length < PER_PAGE) break;
  }
  return all.filter((repo) => repo.private);
}

/**
 * Validate a repo name against GitHub's naming rules.
 * Returns an error message, or null when the name is valid.
 */
export function validateRepoName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Repository name is required.";
  if (trimmed.length > 100) return "Repository name must be 100 characters or fewer.";
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return "Repository name may only contain letters, numbers, hyphens, underscores and periods.";
  }
  if (trimmed === "." || trimmed === "..") return "Repository name cannot be '.' or '..'.";
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) {
    return "Repository name cannot start or end with a period.";
  }
  if (trimmed.includes("..")) return "Repository name cannot contain '..'.";
  return null;
}

/** Check if a repo exists under the authenticated user */
export async function repoExists(
  token: string,
  username: string,
  repoName: string
): Promise<boolean> {
  const response = await requestUrl({
    url: `${GITHUB_API_BASE}/repos/${username}/${repoName}`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
    throw: false,
  });
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  const err = (response.json ?? {}) as { message?: string };
  throw new Error(`GitHub API error ${response.status}: ${err.message ?? "unknown"}`);
}

/** True when the repo has at least one commit (false for an empty repo) */
export async function repoHasCommits(
  token: string,
  username: string,
  repoName: string
): Promise<boolean> {
  const response = await requestUrl({
    url: `${GITHUB_API_BASE}/repos/${username}/${repoName}/commits?per_page=1`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
    throw: false,
  });
  if (response.status === 200) return true;
  if (response.status === 409 || response.status === 404) return false;
  const err = (response.json ?? {}) as { message?: string };
  throw new Error(`GitHub API error ${response.status}: ${err.message ?? "unknown"}`);
}

/** Create a new private repo for this vault */
export async function createRepo(
  token: string,
  repoName: string,
  description: string
): Promise<GitHubRepo> {
  return ghFetch<GitHubRepo>("/user/repos", token, {
    method: "POST",
    body: {
      name: repoName,
      description,
      private: true,
      auto_init: false,
    },
  });
}

/**
 * Rename a repository owned by the authenticated user (server-side PATCH).
 * History, issues and stars are preserved, and GitHub automatically redirects
 * the old URL to the new one — other devices keep working unchanged.
 * The classic OAuth `repo` scope (granted by the device flow) covers this.
 */
export async function renameRepo(
  token: string,
  username: string,
  oldName: string,
  newName: string
): Promise<void> {
  await ghFetch<{ name: string }>(
    `/repos/${username}/${oldName}`,
    token,
    { method: "PATCH", body: { name: newName } }
  );
}

/** Derive a safe repo name from the vault name */
export function vaultNameToRepoName(vaultName: string): string {
  return `obsidian-${vaultName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}
