import { ConflictFile } from "../types";

/**
 * Produce a simple line-by-line diff summary between ours and theirs.
 * Used in the conflict modal to help the user decide.
 */
export function diffSummary(conflict: ConflictFile): string {
  if (conflict.binary) {
    return "(binary file — choose Keep Mine or Keep Theirs; content is not shown)";
  }
  const oursLines   = conflict.ours.split("\n");
  const theirsLines = conflict.theirs.split("\n");

  const maxLen = Math.max(oursLines.length, theirsLines.length);
  const diffLines: string[] = [];
  const MAX_HUNKS = 80;

  for (let i = 0; i < maxLen; i++) {
    const a = oursLines[i]   ?? "";
    const b = theirsLines[i] ?? "";
    if (a !== b) {
      diffLines.push(`Line ${i + 1}:`);
      if (a) diffLines.push(`  - ${a}`);
      if (b) diffLines.push(`  + ${b}`);
      if (diffLines.length >= MAX_HUNKS * 3) {
        diffLines.push("…(diff truncated)");
        break;
      }
    }
  }

  return diffLines.length > 0
    ? diffLines.join("\n")
    : "(files are identical — safe to accept either)";
}
