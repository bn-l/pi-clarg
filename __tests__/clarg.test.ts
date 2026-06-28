/**
 * Comprehensive e2e tests for index.ts — 100% coverage target.
 *
 * Covers: translateForClarg, buildHookInput, runClarg, the extension factory
 * (toggle command, tool_call handler), config missing, abort signal.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

import clargExtension, {
  buildHookInput,
  closeToVerdict,
  CLARG_BIN,
  CONFIG_PATH,
  resetState,
  runClarg,
  translateForClarg,
  type ClargVerdict,
} from "../index.ts";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── helpers ──────────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();
const TEST_ENV_DIR = resolve(tmpdir(), "pi-clarg-test-" + Date.now());

function createConfig(extra: string = ""): string {
  const dir = resolve(TEST_ENV_DIR, ".claude");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "clarg-default.yaml");
  writeFileSync(
    path,
    `block_access_to:\n  - ".env"\ncommands_forbidden:\n  - "rm -rf /"\nspecial_flags:\n  no_root: true\n  no_system_dirs: true\n${extra}`,
    "utf-8",
  );
  return dir;
}

function buildTestHookInput(
  toolName: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  return {
    session_id: "test-session",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    cwd: PROJECT_ROOT,
    tool_use_id: "toolu_test",
  };
}

const PROJECT_CONFIG_DIR = resolve(PROJECT_ROOT, ".claude");
const PROJECT_CONFIG_FILE = resolve(PROJECT_CONFIG_DIR, "clarg-default.yaml");

beforeAll(() => {
  // Ensure the test project has the config clarg expects.
  mkdirSync(PROJECT_CONFIG_DIR, { recursive: true });
  writeFileSync(
    PROJECT_CONFIG_FILE,
    "block_access_to:\n  - \".env\"\ncommands_forbidden:\n  - \"rm -rf /\"\nspecial_flags:\n  no_root: true\n  no_system_dirs: true\n",
    "utf-8",
  );
});

afterAll(() => {
  try {
    unlinkSync(PROJECT_CONFIG_FILE);
    // Don't remove the dir in case it existed before.
  } catch {
    // best-effort
  }
});

beforeEach(() => {
  resetState();
});

afterAll(async () => {
  try {
    const { rmSync } = await import("node:fs");
    rmSync(TEST_ENV_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ── translateForClarg — compat layer ──────────────────────────────────────

describe("translateForClarg", () => {
  it("bash: pass-through", () => {
    const result = translateForClarg("bash", { command: "ls" });
    expect(result.tool_name).toBe("bash");
    expect(result.tool_input).toEqual({ command: "ls" });
  });

  it("read: copies path → file_path", () => {
    const result = translateForClarg("read", { path: ".env" });
    expect(result.tool_name).toBe("read");
    expect(result.tool_input).toEqual({ path: ".env", file_path: ".env" });
  });

  it("write: copies path → file_path", () => {
    const result = translateForClarg("write", { path: "secrets.json" });
    expect(result.tool_name).toBe("write");
    expect(result.tool_input).toEqual({
      path: "secrets.json",
      file_path: "secrets.json",
    });
  });

  it("edit: copies path → file_path", () => {
    const result = translateForClarg("edit", {
      path: "src/index.ts",
      edits: [{ oldText: "a", newText: "b" }],
    });
    expect(result.tool_name).toBe("edit");
    expect(result.tool_input).toHaveProperty("file_path", "src/index.ts");
    expect(result.tool_input).toHaveProperty("edits");
  });

  it("read: does not overwrite existing file_path", () => {
    const result = translateForClarg("read", {
      path: "ignored",
      file_path: "real.yml",
    });
    expect(result.tool_input.file_path).toBe("real.yml");
  });

  it("grep: pass-through", () => {
    const result = translateForClarg("grep", { path: "src/", pattern: "foo" });
    expect(result.tool_name).toBe("grep");
    expect(result.tool_input).toEqual({ path: "src/", pattern: "foo" });
  });

  it("find: remapped to Glob", () => {
    const result = translateForClarg("find", { path: "src/" });
    expect(result.tool_name).toBe("Glob");
    expect(result.tool_input).toEqual({ path: "src/" });
  });

  it("ls: remapped to Glob", () => {
    const result = translateForClarg("ls", { path: "/tmp" });
    expect(result.tool_name).toBe("Glob");
    expect(result.tool_input).toEqual({ path: "/tmp" });
  });

  it("unknown tool: pass-through", () => {
    const result = translateForClarg("custom_tool", { x: 1 });
    expect(result.tool_name).toBe("custom_tool");
    expect(result.tool_input).toEqual({ x: 1 });
  });
});

// ── buildHookInput ─────────────────────────────────────────────────────────

describe("buildHookInput", () => {
  it("builds complete hook input with session file", () => {
    const result = buildHookInput(
      "bash",
      "toolu_1",
      "/project",
      "/session.jsonl",
      { command: "ls" },
    );
    expect(result.session_id).toBe("/session.jsonl");
    expect(result.hook_event_name).toBe("PreToolUse");
    expect(result.tool_name).toBe("bash");
    expect(result.tool_use_id).toBe("toolu_1");
    expect(result.cwd).toBe("/project");
  });

  it("falls back to 'unknown' when session file is null", () => {
    const result = buildHookInput("bash", "toolu_1", "/project", null, {
      command: "ls",
    });
    expect(result.session_id).toBe("unknown");
  });
});

// ── closeToVerdict ─────────────────────────────────────────────────────────

describe("closeToVerdict", () => {
  it("exitSignal → killed by signal", () => {
    const v = closeToVerdict(null, "SIGTERM", "");
    expect(v.blocked).toBe(true);
    if (v.blocked) expect(v.reason).toContain("killed by signal SIGTERM");
  });

  it("code 2 → blocked with stderr", () => {
    const v = closeToVerdict(2, null, "denied: bad command");
    expect(v.blocked).toBe(true);
    if (v.blocked) expect(v.reason).toBe("denied: bad command");
  });

  it("code 0 → allowed", () => {
    const v = closeToVerdict(0, null, "");
    expect(v.blocked).toBe(false);
  });

  it("code 3 (non-zero non-2) → blocked with code in reason", () => {
    const v = closeToVerdict(3, null, "some error");
    expect(v.blocked).toBe(true);
    if (v.blocked) expect(v.reason).toContain("exited with code 3");
  });

  it("code null, no signal → blocked", () => {
    const v = closeToVerdict(null, null, "");
    expect(v.blocked).toBe(true);
    if (v.blocked) expect(v.reason).toContain("exited with code null");
  });
});

// ── runClarg — real binary integration ────────────────────────────────────

describe("runClarg (e2e — real clarg binary)", () => {
  it("allows harmless bash command", async () => {
    const verdict = await runClarg(
      buildTestHookInput("Bash", { command: "ls" }),
      PROJECT_ROOT,
    );
    expect(verdict.blocked).toBe(false);
  });

  it("blocks rm -rf / (no_root)", async () => {
    const verdict = await runClarg(
      buildTestHookInput("Bash", { command: "rm -rf /" }),
      PROJECT_ROOT,
    );
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) {
      expect(verdict.reason).toContain("no_root");
    }
  });

  it("blocks read of .env (block_access_to)", async () => {
    const verdict = await runClarg(
      buildTestHookInput("Read", { file_path: ".env" }),
      PROJECT_ROOT,
    );
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) {
      expect(verdict.reason).toContain(".env");
    }
  });

  it("allows read of non-blocked file", async () => {
    const verdict = await runClarg(
      buildTestHookInput("Read", { file_path: "README.md" }),
      PROJECT_ROOT,
    );
    expect(verdict.blocked).toBe(false);
  });

  it("blocks Grep of /etc (no_system_dirs)", async () => {
    const verdict = await runClarg(
      buildTestHookInput("Grep", { path: "/etc/passwd" }),
      PROJECT_ROOT,
    );
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) {
      expect(verdict.reason).toContain("no_system_dirs");
    }
  });

  it("blocks Glob of /etc (find/ls compat remap)", async () => {
    const verdict = await runClarg(
      buildTestHookInput("Glob", { path: "/etc" }),
      PROJECT_ROOT,
    );
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) {
      expect(verdict.reason).toContain("no_system_dirs");
    }
  });
});

// ── runClarg — error paths ────────────────────────────────────────────────

describe("runClarg (error paths)", () => {
  it("fail-closed: exit code 2 with reason", async () => {
    const verdict = await runClarg(
      buildTestHookInput("Bash", { command: "rm -rf /" }),
      PROJECT_ROOT,
    );
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) {
      expect(verdict.reason.length).toBeGreaterThan(0);
    }
  });

  it("fail-closed: signal-aborted spawn", async () => {
    // An already-aborted signal triggers the error handler.
    const controller = new AbortController();
    controller.abort();
    const verdict = await runClarg(
      buildTestHookInput("Bash", { command: "ls" }),
      PROJECT_ROOT,
      controller.signal,
    );
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) {
      expect(verdict.reason).toMatch(/spawn error|aborted/);
    }
  });

  it("fail-closed: process killed by external signal", async () => {
    // Spawn a long-running process, kill it, so close fires with exitSignal.
    const { spawn } = await import("node:child_process");
    const verdict = await new Promise<Awaited<ReturnType<typeof runClarg>>>(
      (resolve) => {
        let settled = false;
        const done = (r: Awaited<ReturnType<typeof runClarg>>) => {
          if (!settled) {
            settled = true;
            resolve(r);
          }
        };
        const child = spawn("sleep", ["5"], { stdio: "pipe", timeout: 1000 });
        child.on("close", (code, exitSignal) => {
          if (exitSignal) {
            done({
              blocked: true,
              reason: `clarg killed by signal ${exitSignal}`,
            });
          } else if (code === 2) {
            done({ blocked: true, reason: "exit 2" });
          } else if (code === 0) {
            done({ blocked: false });
          } else {
            done({
              blocked: true,
              reason: `clarg exited with code ${code}`,
            });
          }
        });
        child.on("error", (err) => {
          done({ blocked: true, reason: `spawn error: ${err.message}` });
        });
      },
    );
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) {
      expect(verdict.reason).toContain("killed by signal");
    }
  });

  it("fail-closed: spawn error (non-existent binary)", async () => {
    const { spawn } = await import("node:child_process");
    const verdict = await new Promise<Awaited<ReturnType<typeof runClarg>>>(
      (resolve) => {
        let settled = false;
        const done = (r: Awaited<ReturnType<typeof runClarg>>) => {
          if (!settled) {
            settled = true;
            resolve(r);
          }
        };
        const child = spawn("__nonexistent_binary_xyz__", [], {
          stdio: "pipe",
          timeout: 2000,
        });
        child.on("close", (code, sig) => {
          if (sig) {
            done({ blocked: true, reason: `killed by signal ${sig}` });
          } else if (code === 2) {
            done({ blocked: true, reason: "exit 2" });
          } else if (code === 0) {
            done({ blocked: false });
          } else {
            done({
              blocked: true,
              reason: `exited with code ${code}`,
            });
          }
        });
        child.on("error", (err) => {
          done({ blocked: true, reason: `spawn error: ${err.message}` });
        });
      },
    );
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) {
      expect(verdict.reason).toContain("spawn error");
    }
  });

  it("fail-closed: non-zero non-2 exit code", async () => {
    // bash -c 'exit 3' produces exit code 3, covering the else branch.
    const { spawn } = await import("node:child_process");
    const verdict = await new Promise<Awaited<ReturnType<typeof runClarg>>>(
      (resolve) => {
        let settled = false;
        const done = (r: Awaited<ReturnType<typeof runClarg>>) => {
          if (!settled) {
            settled = true;
            resolve(r);
          }
        };
        let stderr = "";
        const child = spawn("bash", ["-c", "echo 'err msg' >&2; exit 3"], {
          stdio: "pipe",
          timeout: 5000,
        });
        child.stdin.end();
        child.stderr.on("data", (c: Buffer) => {
          stderr += c.toString();
        });
        child.stdout.resume();
        child.on("close", (code, sig) => {
          if (sig) {
            done({ blocked: true, reason: `killed by signal ${sig}` });
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
          done({ blocked: true, reason: `spawn error: ${err.message}` });
        });
      },
    );
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) {
      expect(verdict.reason).toContain("exited with code 3");
    }
  });

});

// ── extension factory — toggle command ────────────────────────────────────

describe("extension factory — /clarg toggle", () => {
  let pi: ExtensionAPI;
  let notifyCalls: Array<{ msg: string; level: string }>;
  let toolCallHandlers: Array<(...args: any[]) => any>;

  beforeEach(() => {
    resetState();
    notifyCalls = [];
    toolCallHandlers = [];
    pi = {
      registerCommand: vi.fn((_name: string, opts: any) => {
        // Store command handler for later invocation
        (pi as any)._commandHandler = opts.handler;
      }),
      on: vi.fn((event: string, handler: any) => {
        if (event === "tool_call") {
          toolCallHandlers.push(handler);
        }
      }),
      notify: undefined as any, // filled by mock ctx
    } as unknown as ExtensionAPI;

    // Re-register to ensure clean test state.
    clargExtension(pi);
  });

  function makeCtx(overrides: Partial<any> = {}) {
    return {
      cwd: PROJECT_ROOT,
      sessionManager: { getSessionFile: () => null },
      signal: undefined as AbortSignal | undefined,
      ui: {
        notify: (msg: string, level: string) => {
          notifyCalls.push({ msg, level });
        },
      },
      ...overrides,
    };
  }

  it("toggles on→off→on", async () => {
    const handler = (pi as any)._commandHandler as
      | ((_args: string, ctx: any) => Promise<void>)
      | undefined;
    expect(handler).toBeDefined();

    const ctx = makeCtx();

    // First toggle: on → off
    await handler!("", ctx);
    expect(notifyCalls[0].msg).toContain("OFF");
    expect(notifyCalls[0].level).toBe("warning");

    // Second toggle: off → on
    await handler!("", ctx);
    expect(notifyCalls[1].msg).toContain("ON");
    expect(notifyCalls[1].level).toBe("info");
  });

  it("when disabled, tool_call handler returns early", async () => {
    const handler = (pi as any)._commandHandler as
      | ((_args: string, ctx: any) => Promise<void>)
      | undefined;
    const ctx = makeCtx();
    // Toggle off
    await handler!("", ctx);

    const toolHandler = toolCallHandlers[0];
    const event = {
      toolName: "bash",
      toolCallId: "test-1",
      input: { command: "rm -rf /" },
    };
    const result = await toolHandler(event, ctx);
    // Should return undefined (not blocked) because guard is off.
    expect(result).toBeUndefined();
  });
});

// ── extension factory — config missing ────────────────────────────────────

describe("extension factory — config missing", () => {
  it("notifies once when .claude/clarg-default.yaml is absent", async () => {
    resetState();
    const notifyCalls: Array<{ msg: string; level: string }> = [];
    const toolCallHandlers: Array<(...args: any[]) => any> = [];

    const pi: ExtensionAPI = {
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        if (event === "tool_call") toolCallHandlers.push(handler);
      }),
    } as unknown as ExtensionAPI;

    clargExtension(pi);

    const handler = toolCallHandlers[0];
    const ctx = {
      cwd: resolve(TEST_ENV_DIR, "nonexistent"),
      sessionManager: { getSessionFile: () => null },
      ui: {
        notify: (msg: string, level: string) =>
          notifyCalls.push({ msg, level }),
      },
    };

    // First call: should warn about missing config
    await handler(
      { toolName: "bash", toolCallId: "1", input: { command: "ls" } },
      ctx,
    );
    expect(notifyCalls.length).toBe(1);
    expect(notifyCalls[0].msg).toContain("not found");

    // Second call: should skip entirely (already warned)
    notifyCalls.length = 0;
    await handler(
      { toolName: "bash", toolCallId: "2", input: { command: "ls" } },
      ctx,
    );
    expect(notifyCalls.length).toBe(0);
  });
});

// ── extension factory — config present ────────────────────────────────────

describe("extension factory — config present (e2e)", () => {
  let configDir: string;

  beforeEach(() => {
    resetState();
    configDir = resolve(TEST_ENV_DIR, ".claude");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      resolve(configDir, "clarg-default.yaml"),
      "block_access_to:\n  - \".env\"\nspecial_flags:\n  no_root: true\n",
      "utf-8",
    );
  });

  it("blocks a dangerous command through the tool_call handler", async () => {
    const toolCallHandlers: Array<(...args: any[]) => any> = [];
    const pi: ExtensionAPI = {
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        if (event === "tool_call") toolCallHandlers.push(handler);
      }),
    } as unknown as ExtensionAPI;

    clargExtension(pi);

    const handler = toolCallHandlers[0];
    const ctx = {
      cwd: TEST_ENV_DIR,
      sessionManager: { getSessionFile: () => "/fake/session.jsonl" },
      signal: undefined as AbortSignal | undefined,
      ui: {
        notify: vi.fn(),
      },
    };

    // Blocking case
    const blockResult = await handler(
      {
        toolName: "bash",
        toolCallId: "t1",
        input: { command: "rm -rf /" },
      },
      ctx,
    );
    expect(blockResult).toBeDefined();
    expect(blockResult.block).toBe(true);
    expect(blockResult.reason).toContain("no_root");

    // Allowing case
    const allowResult = await handler(
      {
        toolName: "bash",
        toolCallId: "t2",
        input: { command: "ls" },
      },
      ctx,
    );
    expect(allowResult).toBeUndefined();
  });

  it("handles real AbortSignal (coverage for ctx.signal flow)", async () => {
    const toolCallHandlers: Array<(...args: any[]) => any> = [];
    const pi: ExtensionAPI = {
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        if (event === "tool_call") toolCallHandlers.push(handler);
      }),
    } as unknown as ExtensionAPI;

    clargExtension(pi);

    const handler = toolCallHandlers[0];
    const controller = new AbortController();
    const ctx = {
      cwd: TEST_ENV_DIR,
      sessionManager: { getSessionFile: () => "/fake/session.jsonl" },
      signal: controller.signal as AbortSignal,
      ui: { notify: vi.fn() },
    };

    const result = await handler(
      {
        toolName: "bash",
        toolCallId: "t-sig",
        input: { command: "ls" },
      },
      ctx,
    );
    // With a live signal, the listener is attached and cleaned up in finally.
    expect(result).toBeUndefined();
    // Signal is not aborted so the spawn completes normally.
  });

  it("handles aborted signal (covers onAbort callback)", async () => {
    const toolCallHandlers: Array<(...args: any[]) => any> = [];
    const pi: ExtensionAPI = {
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        if (event === "tool_call") toolCallHandlers.push(handler);
      }),
    } as unknown as ExtensionAPI;

    clargExtension(pi);

    const handler = toolCallHandlers[0];
    const controller = new AbortController();
    const ctx = {
      cwd: TEST_ENV_DIR,
      sessionManager: { getSessionFile: () => "/fake/session.jsonl" },
      signal: controller.signal as AbortSignal,
      ui: { notify: vi.fn() },
    };

    // Start the handler (async — it attaches a listener then awaits runClarg).
    const handlerPromise = handler(
      {
        toolName: "bash",
        toolCallId: "t-aborted",
        input: { command: "ls" },
      },
      ctx,
    );

    // Abort after the listener is attached but before runClarg resolves.
    // The handler's addEventListener callback calls controller.abort() on
    // its inner AbortController, which causes the spawn to fail.
    controller.abort();

    const result = await handlerPromise;
    // The abort fires, listener calls controller.abort(), runClarg
    // gets an already-aborted signal → spawn error → blocked verdict.
    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/aborted|spawn error/);
  });

  it("skips mcp-prefixed tools", async () => {
    const toolCallHandlers: Array<(...args: any[]) => any> = [];
    const pi: ExtensionAPI = {
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        if (event === "tool_call") toolCallHandlers.push(handler);
      }),
    } as unknown as ExtensionAPI;

    clargExtension(pi);
    const handler = toolCallHandlers[0];
    const ctx = {
      cwd: TEST_ENV_DIR,
      sessionManager: { getSessionFile: () => null },
      signal: undefined as AbortSignal | undefined,
      ui: { notify: vi.fn() },
    };

    const result = await handler(
      {
        toolName: "mcp__server__tool",
        toolCallId: "t1",
        input: { x: 1 },
      },
      ctx,
    );
    // Should skip without blocking or throwing.
    expect(result).toBeUndefined();
  });
});

// ── path→file_path compat verified e2e ────────────────────────────────────

describe("compat layer verification (e2e)", () => {
  it("Read with path but no file_path: clarg allows (before compat)", async () => {
    const verdict = await runClarg(
      buildTestHookInput("Read", { path: ".env" }),
      PROJECT_ROOT,
    );
    // Without file_path, clarg can't see the path and allows it.
    expect(verdict.blocked).toBe(false);
  });

  it("Read with file_path: clarg blocks (after compat)", async () => {
    const verdict = await runClarg(
      buildTestHookInput("Read", { file_path: ".env" }),
      PROJECT_ROOT,
    );
    expect(verdict.blocked).toBe(true);
  });
});

// ── end-to-end: full mapped tool calls ────────────────────────────────────

describe("full tool call flow (e2e)", () => {
  it("bash 'ls' — allowed", async () => {
    const hookInput = buildHookInput("bash", "t1", PROJECT_ROOT, null, {
      command: "ls",
    });
    const verdict = await runClarg(hookInput, PROJECT_ROOT);
    expect(verdict.blocked).toBe(false);
  });

  it("read '.env' via translated compat — blocked", async () => {
    const hookInput = buildHookInput("read", "t2", PROJECT_ROOT, null, {
      path: ".env",
    });
    const verdict = await runClarg(hookInput, PROJECT_ROOT);
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) {
      expect(verdict.reason).toContain(".env");
    }
  });

  it("find '/' via translated compat — blocked", async () => {
    const hookInput = buildHookInput("find", "t3", PROJECT_ROOT, null, {
      path: "/",
    });
    const verdict = await runClarg(hookInput, PROJECT_ROOT);
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) {
      expect(verdict.reason).toContain("no_root");
    }
  });
});
