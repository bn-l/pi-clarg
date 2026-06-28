/**
 * pi-clarg — clarg guardrails for the pi coding agent.
 *
 * Spawns the `clarg` binary as a PreToolUse-style gate. Blocks tool calls
 * that match `block_access_to`, `commands_forbidden`, or `special_flags`
 * patterns in `.claude/clarg-default.yaml`.
 *
 * /clarg — toggle guardrails on/off (instant, in-memory)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ── state ────────────────────────────────────────────────────────────────────
let enabled = true;
let configMissing = false;
export const CLARG_BIN = "clarg";
export const CONFIG_PATH = ".claude/clarg-default.yaml";

export function resetState(): void {
  enabled = true;
  configMissing = false;
}

// ── compat layer: pi tool → clarg stdin ─────────────────────────────────────

/** pi tools whose path arg should be remapped to clarg's `Glob` handler so
 *  `block_access_to` / `no_root` / `no_system_dirs` still apply. */
const PATH_AS_GLOB: ReadonlySet<string> = new Set(["find", "ls"]);

/**
 * Translate a pi tool call into the shape clarg expects on stdin.
 *
 *   - `find` / `ls` → `Glob` (so clarg checks the path)
 *   - `read` / `write` / `edit` → `path` is copied to `file_path`
 *   - `bash` / `grep` → pass-through
 */
export function translateForClarg(
  toolName: string,
  input: Record<string, unknown>,
): { tool_name: string; tool_input: Record<string, unknown> } {
  // Remap pi-specific filesystem tools to Glob so clarg's
  // evaluate_path_tool checks fire.
  if (PATH_AS_GLOB.has(toolName)) {
    return {
      tool_name: "Glob",
      tool_input: { path: input.path },
    };
  }

  const toolInput = { ...input } as Record<string, unknown>;

  // clarg expects `file_path` for Read/Write/Edit; pi uses `path`.
  if (
    (toolName === "read" || toolName === "write" || toolName === "edit") &&
    toolInput.path !== undefined &&
    toolInput.file_path === undefined
  ) {
    toolInput.file_path = toolInput.path;
  }

  return { tool_name: toolName, tool_input: toolInput };
}

// ── clarg executor ───────────────────────────────────────────────────────────

export type ClargVerdict =
  | { blocked: true; reason: string }
  | { blocked: false };

export async function runClarg(
  hookInput: Record<string, unknown>,
  cwd: string,
  signal?: AbortSignal,
): Promise<ClargVerdict> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: ClargVerdict) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const child = spawn(CLARG_BIN, [CONFIG_PATH], {
      cwd,
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5_000,
      signal,
    });

    let stderr = "";

    child.stdin.end(JSON.stringify(hookInput));

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Discard stdout — clarg writes deny messages to stderr.
    child.stdout.resume();

    child.on("close", (code, exitSignal) => {
      if (exitSignal) {
        done({
          blocked: true,
          reason: `clarg killed by signal ${exitSignal}`,
        });
      } else if (code === 2) {
        done({ blocked: true, reason: stderr.trim() });
      } else if (code === 0) {
        done({ blocked: false });
      } else {
        done({
          blocked: true,
          reason: `clarg exited with code ${code}: ${stderr.trim()}`,
        });
      }
    });

    child.on("error", (err) => {
      done({
        blocked: true,
        reason: `clarg spawn error: ${err.message}`,
      });
    });
  });
}

// ── hook input builder ──────────────────────────────────────────────────────

export function buildHookInput(
  toolName: string,
  toolCallId: string,
  ctxCwd: string,
  sessionFile: string | null,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const { tool_name, tool_input } = translateForClarg(toolName, input);
  return {
    session_id: sessionFile ?? "unknown",
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
    cwd: ctxCwd,
    tool_use_id: toolCallId,
  };
}

// ── extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // /clarg — instant toggle
  pi.registerCommand("clarg", {
    description: "Toggle clarg guardrails on/off",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      ctx.ui.notify(
        `clarg guardrails ${enabled ? "ON" : "OFF"}`,
        enabled ? "info" : "warning",
      );
    },
  });

  // Pre-tool gate
  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) return;

    // Skip if config file doesn't exist (no-op, warn once).
    if (!configMissing && !existsSync(resolve(ctx.cwd, CONFIG_PATH))) {
      configMissing = true;
      ctx.ui.notify(
        `clarg: ${CONFIG_PATH} not found — guardrails disabled`,
        "warning",
      );
      return;
    }
    if (configMissing) return;

    // Skip tools clarg doesn't understand (mcp*, etc.).
    if (event.toolName.startsWith("mcp")) return;

    const hookInput = buildHookInput(
      event.toolName,
      event.toolCallId,
      ctx.cwd,
      ctx.sessionManager.getSessionFile(),
      event.input as Record<string, unknown>,
    );

    // Tie the abort to pi's signal so Esc cancels the spawn.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const verdict = await runClarg(hookInput, ctx.cwd, controller.signal);

      if (verdict.blocked) {
        return { block: true, reason: verdict.reason };
      }
    } finally {
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  });
}
