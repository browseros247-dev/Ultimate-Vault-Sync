/**
 * Lightweight gitignore-style matching for include/exclude patterns.
 * `**` matches across `/` (including empty); `*` matches one path segment.
 */
export function globToRegExp(pattern: string): RegExp {
  const escapeSegment = (segment: string): string =>
    segment.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, "[^/]*");
  const body = pattern.split("**").map(escapeSegment).join(".*");
  return new RegExp(`^${body}$`);
}

export function matchesGlob(filepath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(filepath);
}

export function matchesAnyGlob(filepath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(filepath, pattern));
}

/** Plugin data.json holds the OAuth token — never stage, even if excludes were cleared. */
export function isPluginDataFile(filepath: string): boolean {
  return /(?:^|\/)plugins\/[^/]+\/data\.json$/.test(filepath);
}
