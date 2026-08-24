import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

function loadDotEnv() {
  try {
    const text = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // No .env — shell env / CI secrets still apply.
  }
}
loadDotEnv();

const prod = process.argv[2] === "production";

const CLIENT_ID = process.env.CLIENT_ID || "Ov23libuCcWgJFNy6Cm9";
if (!process.env.CLIENT_ID) {
  console.warn("CLIENT_ID not set in env/.env — using source default.");
}

function getBuildTimestamp() {
  // SOURCE_DATE_EPOCH enables reproducible builds (https://reproducible-builds.org/specs/source-date-epoch/)
  if (process.env.SOURCE_DATE_EPOCH) {
    const epochMs = Number(process.env.SOURCE_DATE_EPOCH) * 1000;
    if (!Number.isNaN(epochMs)) return new Date(epochMs).toISOString();
  }
  try {
    const gitDate = execSync("git log -1 --format=%cI", { encoding: "utf8" }).trim();
    if (gitDate) return gitDate;
  } catch {
    // git not available or not a repo — fallback to current time
  }
  return new Date().toISOString();
}
const BUILD_TIMESTAMP = getBuildTimestamp();

esbuild.build({
  banner: { js: "/* ultimate-obsi-sync */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  inject: ["./src/shim/buffer.ts"],
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  define: {
    "process.env.CLIENT_ID": JSON.stringify(CLIENT_ID),
    "process.env.BUILD_TIMESTAMP": JSON.stringify(BUILD_TIMESTAMP),
  },
});
