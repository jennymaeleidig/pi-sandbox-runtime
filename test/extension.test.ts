import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import guardExtension from "../src/extension.ts";
import type { SandboxRuntime } from "../src/sandbox.ts";
import { toolSchema } from "./tool-info.ts";

const agentDir = mkdtempSync(join(tmpdir(), "guard-ext-agent-"));
// Canonical, like the guard's regions: the temp root can be a symlink (macOS `/tmp`).
const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "guard-ext-cwd-")));
const allowed = join(cwd, "allowed");
const denied = join(cwd, "denied");
mkdirSync(allowed);
mkdirSync(denied);

function writeConfig(config: unknown): void {
  writeFileSync(
    join(agentDir, "sandbox.json"),
    JSON.stringify(config),
    "utf-8",
  );
}

const validConfig = {
  network: { allowedDomains: ["github.com"] },
  filesystem: {
    denyRead: [denied],
    allowRead: [allowed],
    allowWrite: [allowed],
    denyWrite: [],
  },
};

/** A minimal host that records what the extension registers, so the wiring can be inspected. */
function fakePi(
  options: {
    flags?: Record<string, boolean | string>;
    tools?: { name?: unknown; parameters?: unknown }[];
  } = {},
) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const tools: { name?: unknown }[] = [];

  const pi = {
    handlers,
    commands,
    tools,
    registerFlag(): void {},
    getFlag: (name: string) => options.flags?.[name],
    getAllTools: () =>
      options.tools ?? [
        {
          name: "read",
          parameters: { properties: { path: { type: "string" } } },
        },
        { name: "bash", parameters: { properties: {} } },
      ],
    on(
      event: string,
      handler: (event: unknown, ctx: unknown) => unknown,
    ): void {
      handlers.set(event, handler);
    },
    registerTool(tool: { name?: unknown }): void {
      tools.push(tool);
    },
    registerCommand(
      name: string,
      options: { handler: (args: string, ctx: unknown) => unknown },
    ): void {
      commands.set(name, options.handler);
    },
  };

  const notifications: { message: string; kind: string }[] = [];
  const ctx = {
    cwd,
    ui: {
      notify: (message: string, kind: string = "info") => {
        notifications.push({ message, kind });
      },
    },
  };

  return {
    pi: pi as unknown as ExtensionAPI,
    notifications,
    tools,
    commands,
    call: (event: string, payload: unknown) =>
      handlers.get(event)?.(payload, ctx),
    command: (name: string, args: string) => commands.get(name)?.(args, ctx),
  };
}

function fakeRuntime(
  options: {
    depErrors?: string[];
    depWarnings?: string[];
    supported?: boolean;
  } = {},
): SandboxRuntime & { resets: number; initialized: number } {
  const runtime = {
    resets: 0,
    initialized: 0,
    isSupportedPlatform: () => options.supported ?? true,
    async checkDependencies(): Promise<{
      warnings: string[];
      errors: string[];
    }> {
      return {
        warnings: options.depWarnings ?? [],
        errors: options.depErrors ?? [],
      };
    },
    async initialize(): Promise<void> {
      runtime.initialized += 1;
    },
    async wrapWithSandbox(command: string): Promise<string> {
      return command;
    },
    async wrapWithSandboxArgv(
      command: string,
    ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
      return { argv: [process.execPath, "-e", command], env: {} };
    },
    getSocksProxyPort: () => undefined,
    cleanupAfterCommand(): void {},
    async reset(): Promise<void> {
      runtime.resets += 1;
    },
  };
  return runtime;
}

async function startSession(host: ReturnType<typeof fakePi>): Promise<void> {
  await host.call("session_start", {
    type: "session_start",
    reason: "startup",
  });
}

function readCall(path: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "call-1",
    toolName: "read",
    input: { path },
  } as ToolCallEvent;
}

test("fences the bash Tool and registers the guard's commands when the session starts", async () => {
  writeConfig(validConfig);
  const host = fakePi();
  const runtime = fakeRuntime();
  guardExtension(host.pi, { runtime, agentDir });

  await startSession(host);

  assert.deepEqual(
    host.tools.map((tool) => tool.name),
    ["bash"],
    JSON.stringify(host.notifications),
  );
  assert.ok(
    host.commands.has("guard"),
    "a status command should be registered",
  );
  assert.ok(
    host.commands.has("guard-allow"),
    "a grant command should be registered",
  );
  assert.equal(runtime.initialized, 1);
});

test("/guard reports the loaded policy, the config paths, and the grants", async () => {
  writeConfig(validConfig);
  const host = fakePi();
  guardExtension(host.pi, { runtime: fakeRuntime(), agentDir });
  await startSession(host);

  await host.command("guard", "");

  const report = host.notifications.at(-1);
  assert.equal(report?.kind, "info");
  const message = report?.message ?? "";
  assert.match(message, /policy: allowRead \[/);
  assert.ok(message.includes(denied), message);
  assert.ok(message.includes(allowed), message);
  assert.ok(message.includes(join(agentDir, "sandbox.json")), message);
  assert.ok(message.includes(join(cwd, ".pi", "sandbox.json")), message);
  assert.match(message, /nothing granted this session/);
});

test("notices which Tools have an inferred access, so a wrong guess is discoverable", async () => {
  writeConfig(validConfig);
  const host = fakePi({
    tools: [
      {
        name: "read",
        parameters: { properties: { path: { type: "string" } } },
      },
      {
        name: "format_md_tables",
        parameters: { properties: { path: { type: "string" } } },
      },
    ],
  });
  guardExtension(host.pi, { runtime: fakeRuntime(), agentDir });

  await startSession(host);

  assert.ok(
    host.notifications.some(
      (entry) =>
        entry.kind === "warning" &&
        /inferred/.test(entry.message) &&
        /format_md_tables/.test(entry.message),
    ),
    JSON.stringify(host.notifications),
  );
});

test("notices a Tool whose access is inferred only after the session starts", async () => {
  writeConfig(validConfig);
  const tools = [toolSchema("read", { path: { type: "string" } })];
  const host = fakePi({ tools });
  guardExtension(host.pi, { runtime: fakeRuntime(), agentDir });
  await startSession(host);

  assert.equal(
    host.notifications.filter((entry) => /inferred/.test(entry.message)).length,
    0,
  );

  // A package registered after session start: it must still be announced.
  tools.push(toolSchema("later_formatter", { path: { type: "string" } }));
  await host.call("tool_call", readCall(join(allowed, "file.txt")));

  assert.ok(
    host.notifications.some(
      (entry) =>
        entry.kind === "warning" &&
        /inferred/.test(entry.message) &&
        /later_formatter/.test(entry.message),
    ),
    JSON.stringify(host.notifications),
  );
});

test("blocks a Tool call the policy refuses", async () => {
  writeConfig(validConfig);
  const host = fakePi();
  guardExtension(host.pi, { runtime: fakeRuntime(), agentDir });
  await startSession(host);

  const decision = (await host.call(
    "tool_call",
    readCall(join(denied, "file.txt")),
  )) as {
    block?: boolean;
    reason?: string;
  };

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /denied/);
});

test("fences user-run shell commands through the sandbox too", async () => {
  writeConfig(validConfig);
  const host = fakePi();
  guardExtension(host.pi, { runtime: fakeRuntime(), agentDir });
  await startSession(host);

  const result = (await host.call("user_bash", {
    type: "user_bash",
    command: "echo hi",
    excludeFromContext: false,
    cwd,
  })) as { operations?: unknown };

  assert.ok(
    result.operations,
    "the user's own commands must run under the OS fence",
  );
});

test("fails closed when the config cannot be loaded", async () => {
  writeConfig({
    ...validConfig,
    filesystem: { ...validConfig.filesystem, allowWrites: ["."] },
  });
  const host = fakePi();
  guardExtension(host.pi, { runtime: fakeRuntime(), agentDir });
  await startSession(host);

  const decision = (await host.call(
    "tool_call",
    readCall(join(allowed, "file.txt")),
  )) as {
    block?: boolean;
    reason?: string;
  };
  const userBash = await host.call("user_bash", { command: "echo hi", cwd });

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /allowWrites/);
  assert.equal(userBash, undefined, "no unfenced shell should be handed back");
  assert.ok(
    host.notifications.some((entry) => entry.kind === "error"),
    "the failure should be reported to the user",
  );
});

test("refuses a shell Tool before the sandbox is running", async () => {
  writeConfig(validConfig);
  const host = fakePi();
  guardExtension(host.pi, { runtime: fakeRuntime(), agentDir });

  const decision = (await host.call("tool_call", {
    type: "tool_call",
    toolCallId: "call-2",
    toolName: "bash",
    input: { command: "echo hi" },
  })) as { block?: boolean; reason?: string };

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /not running/);
});

test("fences every command kind, not just bash, before the sandbox is running", async () => {
  writeConfig(validConfig);
  const host = fakePi();
  guardExtension(host.pi, { runtime: fakeRuntime(), agentDir });

  const decision = (await host.call("tool_call", {
    type: "tool_call",
    toolCallId: "call-ps",
    toolName: "powershell",
    input: { command: "echo hi" },
  })) as { block?: boolean; reason?: string };

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /not running/);
});

test("the extension derives the fence fact from the kind table, with no second list", () => {
  const source = readFileSync(
    new URL("../src/extension.ts", import.meta.url),
    "utf-8",
  );

  // The extension must ask the kind table rather than name Shell Tools itself.
  assert.match(source, /needsLiveFence\(/);
  assert.match(
    source,
    /import\s*\{[^}]*needsLiveFence[^}]*\}\s*from\s*"\.\/claims\.ts"/,
  );
  assert.doesNotMatch(source, /"(bash|powershell)"/);
});

test("grants: /guard-allow admits a refused path for the session", async () => {
  writeConfig(validConfig);
  const host = fakePi();
  guardExtension(host.pi, { runtime: fakeRuntime(), agentDir });
  await startSession(host);
  const path = join(denied, "file.txt");

  assert.ok(
    ((await host.call("tool_call", readCall(path))) as { block?: boolean })
      .block,
  );

  await host.command("guard-allow", path);

  assert.deepEqual(await host.call("tool_call", readCall(path)), {});
});

test("grants: /guard-allow refuses a glob instead of granting a pattern", async () => {
  writeConfig(validConfig);
  const host = fakePi();
  guardExtension(host.pi, { runtime: fakeRuntime(), agentDir });
  await startSession(host);

  await host.command("guard-allow", join(denied, "*.env"));

  assert.equal(
    (
      (await host.call("tool_call", readCall(join(denied, "x.env")))) as {
        block?: boolean;
      }
    ).block,
    true,
  );
  assert.ok(
    host.notifications.some(
      (entry) => entry.kind === "warning" && /pattern/.test(entry.message),
    ),
    JSON.stringify(host.notifications),
  );
});

test("grants: /guard-allow tool:<name> admits an unmapped Tool", async () => {
  writeConfig(validConfig);
  const host = fakePi();
  guardExtension(host.pi, { runtime: fakeRuntime(), agentDir });
  await startSession(host);
  const call = {
    type: "tool_call",
    toolCallId: "call-3",
    toolName: "mystery_tool",
    input: {},
  } as ToolCallEvent;

  assert.ok(
    ((await host.call("tool_call", call)) as { block?: boolean }).block,
  );

  await host.command("guard-allow", "tool:mystery_tool");

  assert.deepEqual(await host.call("tool_call", call), {});
});

test("refuses to start when a sandbox dependency is missing", async () => {
  writeConfig(validConfig);
  const host = fakePi();
  const runtime = fakeRuntime({ depErrors: ["ripgrep was not found on PATH"] });
  guardExtension(host.pi, { runtime, agentDir });

  await startSession(host);

  const decision = (await host.call(
    "tool_call",
    readCall(join(allowed, "file.txt")),
  )) as {
    block?: boolean;
    reason?: string;
  };

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /ripgrep/);
  assert.equal(
    runtime.initialized,
    0,
    "a half-installed sandbox must not be initialized",
  );
});

test("starts anyway when a dependency check only warns", async () => {
  writeConfig(validConfig);
  const host = fakePi();
  const runtime = fakeRuntime({
    depWarnings: ["nested sandboxing will be weaker"],
  });
  guardExtension(host.pi, { runtime, agentDir });

  await startSession(host);

  assert.equal(runtime.initialized, 1);
  assert.ok(host.notifications.some((entry) => entry.kind === "warning"));
});

test("refuses to start on a platform the OS sandbox does not support", async () => {
  writeConfig(validConfig);
  const host = fakePi();
  const runtime = fakeRuntime({ supported: false });
  guardExtension(host.pi, { runtime, agentDir });

  await startSession(host);

  const decision = (await host.call(
    "tool_call",
    readCall(join(allowed, "file.txt")),
  )) as {
    block?: boolean;
    reason?: string;
  };

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /platform/);
  assert.equal(runtime.initialized, 0);
});

test("registers the Windows command Tool so the adapter can fence it", async () => {
  writeConfig(validConfig);
  const host = fakePi();
  guardExtension(host.pi, {
    runtime: fakeRuntime(),
    agentDir,
    platform: "win32",
  });

  await startSession(host);

  assert.deepEqual(
    host.tools.map((tool) => tool.name).sort(),
    ["bash", "powershell"],
    JSON.stringify(host.notifications),
  );
});

test("registers only the shell Tools this platform has", async () => {
  writeConfig(validConfig);
  const host = fakePi();
  guardExtension(host.pi, {
    runtime: fakeRuntime(),
    agentDir,
    platform: "darwin",
  });

  await startSession(host);

  assert.deepEqual(
    host.tools.map((tool) => tool.name),
    ["bash"],
    JSON.stringify(host.notifications),
  );
});

test("resets the runtime when the session ends", async () => {
  writeConfig(validConfig);
  const host = fakePi();
  const runtime = fakeRuntime();
  guardExtension(host.pi, { runtime, agentDir });
  await startSession(host);

  await host.call("session_shutdown", {
    type: "session_shutdown",
    reason: "quit",
  });

  assert.equal(runtime.resets, 1);
});

test("stays out of the way when --no-guard is passed", async () => {
  writeConfig(validConfig);
  const host = fakePi({ flags: { "no-guard": true } });
  guardExtension(host.pi, { runtime: fakeRuntime(), agentDir });

  await startSession(host);

  assert.deepEqual(
    host.tools,
    [],
    "no sandboxed bash tool should be registered",
  );
  assert.equal(
    await host.call("tool_call", readCall(join(denied, "file.txt"))),
    undefined,
  );
});
