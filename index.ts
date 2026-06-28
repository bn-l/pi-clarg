/**
 * pi-clarg — clarg guardrails for the pi coding agent.
 *
 * Spawns the `clarg` binary as a PreToolUse-style gate. Blocks tool calls
 * that match `block_access_to`, `commands_forbidden`, or `special_flags`
 * patterns in `.claude/clarg-default.yaml`.
 *
 * /clarg-on / /clarg-off — instant on/off (in-memory)
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

/** Map a close event to a verdict. Exported for testability. */
export function closeToVerdict(
  code: number | null,
  exitSignal: string | null,
  stderr: string,
): ClargVerdict {
  if (exitSignal) {
    return { blocked: true, reason: `clarg killed by signal ${exitSignal}` };
  }
  if (code === 2) {
    return { blocked: true, reason: stderr.trim() };
  }
  if (code === 0) {
    return { blocked: false };
  }
  return {
    blocked: true,
    reason: `clarg exited with code ${code}: ${stderr.trim()}`,
  };
}

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
      done(closeToVerdict(code, exitSignal, stderr));
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
  // /clarg-on / /clarg-off — instant toggle
  pi.registerCommand("clarg-on", {
    description: "Enable clarg guardrails",
    handler: async (_args, ctx) => {
      if (enabled) {
        ctx.ui.notify("clarg guardrails are already ON", "info");
        return;
      }
      enabled = true;
      ctx.ui.notify("clarg guardrails ON", "info");
    },
  });

  pi.registerCommand("clarg-off", {
    description: "Disable clarg guardrails",
    handler: async (_args, ctx) => {
      if (!enabled) {
        ctx.ui.notify("clarg guardrails are already OFF", "info");
        return;
      }
      enabled = false;
      ctx.ui.notify("clarg guardrails OFF", "warning");
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
    ctx.signal?.addEventListener(
      "abort",
      () => controller.abort(),
      { once: true },
    );

    const verdict = await runClarg(hookInput, ctx.cwd, controller.signal);

    if (verdict.blocked) {
      return { block: true, reason: verdict.reason };
    }
  });
}
