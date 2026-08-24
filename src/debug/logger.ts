import { DataAdapter } from "obsidian";
import { PLUGIN_ID } from "../constants";

type LogLevel = "INFO" | "WARN" | "ERROR";
type LogContext = Record<string, unknown>;

const MAX_LOG_BYTES = 512 * 1024;

const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|device.?code|access.?code|body|content)/i;

function redactText(value: string): string {
  return value
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(password|token|secret|device_code|access_token)\s*[=:]\s*[^\s,}]+/gi, "$1=[REDACTED]");
}

function safeError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactText(error.message),
      ...(error.stack ? { stack: redactText(error.stack) } : {}),
    };
  }
  return { message: redactText(String(error)) };
}

function sanitize(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value instanceof Error) return safeError(value);
  if (typeof value === "string") {
    const safeValue = redactText(value);
    return safeValue.length > 500 ? `${safeValue.slice(0, 500)}…` : safeValue;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 50).map(([entryKey, entryValue]) => [
        entryKey,
        sanitize(entryValue, entryKey),
      ])
    );
  }
  return value;
}

/** Best-effort file logging that never hides or replaces the original error. */
export class DebugLogger {
  private writeChain: Promise<void> = Promise.resolve();
  private readonly sessionId = Math.random().toString(36).slice(2, 10);
  private readonly logDir: string;
  private readonly logFile: string;
  private readonly rotatedFile: string;

  constructor(private readonly adapter: DataAdapter, configDir: string) {
    // Use Vault.configDir so custom config folder installs do not write to the wrong path.
    this.logDir = `${configDir}/plugins/${PLUGIN_ID}/logs`;
    this.logFile = `${this.logDir}/ultimate-vault-sync.log`;
    this.rotatedFile = `${this.logDir}/ultimate-vault-sync.log.1`;
  }

  get path(): string {
    return this.logFile;
  }

  info(stage: string, message: string, context?: LogContext): Promise<void> {
    return this.write("INFO", stage, message, context);
  }

  warn(stage: string, message: string, context?: LogContext): Promise<void> {
    return this.write("WARN", stage, message, context);
  }

  error(stage: string, message: string, error?: unknown, context?: LogContext): Promise<void> {
    return this.write("ERROR", stage, message, {
      ...context,
      ...(error !== undefined ? { error: safeError(error) } : {}),
    });
  }

  async clear(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      try {
        await this.adapter.remove(this.logFile);
        await this.adapter.remove(this.rotatedFile);
      } catch {
        // Logging must never make the plugin fail.
      }
    });
    await this.writeChain;
  }

  /** Return the last `maxLines` non-empty log lines (for diagnostics snapshots). */
  async readTail(maxLines = 100): Promise<string> {
    try {
      const content = await this.adapter.read(this.logFile);
      return content
        .split("\n")
        .filter((line) => line.length > 0)
        .slice(-maxLines)
        .join("\n");
    } catch {
      return "";
    }
  }

  private write(
    level: LogLevel,
    stage: string,
    message: string,
    context?: LogContext
  ): Promise<void> {
    // Promote `context.code` to a top-level field so entries can be filtered
    // by error code without parsing the context blob.
    const logContext = context ? { ...context } : undefined;
    const code = logContext?.code;
    if (logContext && "code" in logContext) delete logContext.code;

    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      sessionId: this.sessionId,
      stage,
      message,
      ...(typeof code === "string" && code.length > 0 ? { code } : {}),
      ...(logContext && Object.keys(logContext).length > 0
        ? { context: sanitize(logContext) }
        : {}),
    });

    this.writeChain = this.writeChain.then(async () => {
      try {
        await this.adapter.mkdir(this.logDir).catch(() => undefined);
        let current = "";
        try {
          current = await this.adapter.read(this.logFile);
        } catch {
          // The log is created by the first write.
        }

        const next = `${current}${entry}\n`;
        if (next.length > MAX_LOG_BYTES) {
          try {
            await this.adapter.remove(this.rotatedFile);
          } catch {
            // The rotated file may not exist yet.
          }
          try {
            await this.adapter.rename(this.logFile, this.rotatedFile);
          } catch {
            // Continue with a truncated current log if rename is unavailable.
          }
          current = "";
        }
        await this.adapter.write(this.logFile, `${current}${entry}\n`);
      } catch {
        // Never mask the operation that was being logged.
      }
    });
    return this.writeChain;
  }
}
