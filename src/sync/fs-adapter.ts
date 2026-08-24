import { DataAdapter } from "obsidian";
import { DebugLogger } from "../debug/logger";

type Stats = {
  type: "file" | "dir";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  // isomorphic-git requires these Node.js-style methods on stat results
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/**
 * Creates a fs-like object for isomorphic-git that wraps Obsidian's DataAdapter.
 * Paths passed by isomorphic-git are ABSOLUTE (prefixed with vaultPath).
 * We strip the vaultPath prefix before calling Obsidian's adapter (which uses relative paths).
 */
export function createFsAdapter(adapter: DataAdapter, vaultPath: string, logger?: DebugLogger) {
  /** Strip the vault root prefix so Obsidian adapter gets relative paths */
  function rel(absPath: string): string {
    if (absPath == null) return "";
    const normalized = absPath.replace(/\\/g, "/");
    const base = vaultPath.replace(/\\/g, "/").replace(/\/$/, "");
    if (normalized.startsWith(base + "/")) {
      return normalized.slice(base.length + 1);
    }
    return normalized;
  }

  function pathType(path: string): string {
    const normalized = String(path).replace(/\\/g, "/");
    if (normalized === ".git/HEAD" || normalized.endsWith("/.git/HEAD")) return "head";
    if (normalized === ".git/config" || normalized.endsWith("/.git/config")) return "config";
    if (normalized === ".git/index" || normalized.endsWith("/.git/index")) return "index";
    if (normalized.includes(".git/objects/")) return "object";
    return "git-metadata";
  }

  /**
   * Recursively remove a file or directory tree using Obsidian's adapter.
   * isomorphic-git needs this to clean up a partial .git left by a failed clone,
   * and git.init() cannot repair a repo whose HEAD is missing.
   */
  async function removeRecursive(relativePath: string): Promise<void> {
    let listing: { files: string[]; folders: string[] } | null = null;
    try {
      listing = await adapter.list(relativePath);
    } catch {
      // Not a directory (or missing) — the direct remove below handles files.
    }
    if (listing) {
      for (const file of listing.files) {
        try { await adapter.remove(file); } catch { /* already gone */ }
      }
      for (const folder of listing.folders) {
        await removeRecursive(folder);
      }
    }
    try {
      await adapter.remove(relativePath);
    } catch {
      /* already gone — ignore */
    }
  }

  const promises = {
    async readFile(path: string, options?: { encoding?: string }): Promise<Uint8Array | string> {
      try {
        if (options?.encoding === "utf8") {
          // Git metadata such as HEAD and config is text. On mobile, using the
          // text adapter avoids readBinary visibility/decoding differences.
          return await adapter.read(rel(path));
        }
        const content = await adapter.readBinary(rel(path));
        return new Uint8Array(content);
} catch {
        // Only warn for files the repo should have (HEAD/config/index/objects).
        // Generic .git probes (packs, alternates, logs, shallow, etc.) are
        // normal on every sync and would flood the debug log on mobile.
        if (/\.git(?:\/|$)/i.test(String(path)) && pathType(path) !== "git-metadata") {
          const normalized = String(path).replace(/\\/g, "/");
          const base = vaultPath.replace(/\\/g, "/").replace(/\/$/, "");
          void logger?.warn("fs.readFile", "Git metadata file was not readable", {
            pathType: pathType(path),
            readMethod: options?.encoding === "utf8" ? "text" : "binary",
            errorCode: "ENOENT",
            vaultPathPresent: Boolean(vaultPath),
            basePrefixMatched: Boolean(base) && normalized.startsWith(`${base}/`),
          });
        }
        // Missing files must throw ENOENT (standard fs semantics). isomorphic-git's
        // FileSystem.read() catches the error itself and returns null; callers that
        // need to distinguish "missing" from "empty" rely on this contract.
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
    },

    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      try {
        const relativePath = rel(path);
        // Ensure parent directory exists
        const parts = relativePath.split("/");
        if (parts.length > 1) {
          const dir = parts.slice(0, -1).join("/");
          try { await adapter.mkdir(dir); } catch { /* already exists */ }
        }
        if (typeof data === "string") {
          await adapter.write(relativePath, data);
        } else {
          const view = data instanceof Uint8Array ? data : new Uint8Array(data);
          await adapter.writeBinary(
            relativePath,
            view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
          );
        }
      } catch (error) {
        await logger?.error("fs.writeFile", "Git metadata file could not be written", error, {
          pathType: pathType(path),
          vaultPathPresent: Boolean(vaultPath),
        });
        throw error;
      }
    },

    async unlink(path: string): Promise<void> {
      try {
        await adapter.remove(rel(path));
      } catch {
        /* ignore if not found */
      }
    },

    async readdir(path: string): Promise<string[]> {
      try {
        const result = await adapter.list(rel(path));
        const files = result.files
          .map((f) => f.split("/").pop())
          .filter((v): v is string => typeof v === "string" && v.length > 0);
        const folders = result.folders
          .map((f) => f.split("/").pop())
          .filter((v): v is string => typeof v === "string" && v.length > 0);
        return [...folders, ...files];
      } catch {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, scandir '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
    },

    async mkdir(path: string, _options?: unknown): Promise<void> {
      try {
        await adapter.mkdir(rel(path));
      } catch {
        /* already exists — ignore */
      }
    },

    async rmdir(path: string): Promise<void> {
      // Remove recursively so a partial .git can be fully cleaned up. isomorphic-git
      // dispatches FileSystem.rmdir(filepath, { recursive: true }) to fs.rm when the
      // adapter exposes it, but this also covers direct rmdir calls.
      await removeRecursive(rel(path));
    },

    async rm(path: string): Promise<void> {
      await removeRecursive(rel(path));
    },

    async stat(path: string): Promise<Stats> {
      try {
        const s = await adapter.stat(rel(path));
        if (!s) throw new Error("no stat");
        const isDir = s.type !== "file";
        return {
          type: isDir ? "dir" : "file",
          mode: isDir ? 0o040755 : 0o100644,
          size: s.size ?? 0,
          ino: 0,
          mtimeMs: s.mtime ?? Date.now(),
          ctimeMs: s.ctime ?? Date.now(),
          uid: 1,
          gid: 1,
          dev: 1,
          isFile: () => !isDir,
          isDirectory: () => isDir,
          isSymbolicLink: () => false,
        };
      } catch {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, stat '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
    },

    async lstat(path: string): Promise<Stats> {
      return promises.stat(path);
    },

    async readlink(path: string): Promise<string> {
      throw Object.assign(new Error(`EINVAL: readlink not supported '${path}'`), { code: "EINVAL" });
    },

    async symlink(): Promise<void> {
      throw Object.assign(new Error("EINVAL: symlink not supported"), { code: "EINVAL" });
    },

    async chmod(): Promise<void> {
      /* chmod is a no-op on mobile — isomorphic-git calls it but we can safely ignore */
    },
  };

  return { promises };
}
