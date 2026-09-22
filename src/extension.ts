// The extension wiring: pi's registration surface attached to the guard, the sandboxed bash tool,
// and the session-grant commands. Everything below delegates to `guard.ts` / `sandbox.ts`; there is
// no policy logic here.
import {
  SettingsManager,
  createBashToolDefinition,
  createPowerShellToolDefinition,
  getAgentDir,
  getShellConfig,
  type ExtensionAPI,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import { inferredToolAccesses, needsLiveFence } from "./claims.ts";
import { loadGuardConfig } from "./config.ts";
import { createGuard, type Guard } from "./guard.ts";
import {
  createSandboxRuntime,
  createSandboxedBashOps,
  type BashOps,
  type SandboxRuntime,
} from "./sandbox.ts";

export interface GuardExtensionDeps {
  /** Replaced in tests, so the wiring can be exercised without the runtime's proxy processes. */
  runtime?: SandboxRuntime;
  /** Where `sandbox.json` lives. Defaults to pi's agent directory. */
  agentDir?: string;
  /** Injected so the Windows routing below is reachable from tests on this machine. */
  platform?: NodeJS.Platform;
}

export default function guardExtension(
  pi: ExtensionAPI,
  deps: GuardExtensionDeps = {},
): void {
  const runtime = deps.runtime ?? createSandboxRuntime();
  const platform = deps.platform ?? process.platform;
  let guard: Guard | undefined;
  let bashOps: BashOps | undefined;
  let fenceUnavailableReason: string | undefined;
  let status = "guard: not started";

  const disabledByFlag = (): boolean => pi.getFlag("no-guard") === true;

  /** Why a shell command cannot run right now, if it cannot. */
  const fenceUnavailable = (): string | undefined => {
    if (disabledByFlag()) return undefined;
    return fenceUnavailableReason;
  };

  pi.registerFlag("no-guard", {
    description:
      "Run without the sandbox guard (the OS fence and path policy are off)",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async (_event, ctx) => {
    guard = undefined;
    bashOps = undefined;
    fenceUnavailableReason = undefined;
    status = "guard: starting";

    if (disabledByFlag()) {
      status = "guard: off (--no-guard)";
      return;
    }

    try {
      const config = loadGuardConfig({
        agentDir: deps.agentDir ?? getAgentDir(),
        cwd: ctx.cwd,
      });
      if (!config.enabled) {
        status = "guard: off (enabled: false in sandbox.json)";
        ctx.ui.notify(status, "warning");
        return;
      }

      const shell = getShellConfig(
        SettingsManager.create(ctx.cwd).getShellPath(),
      );
      const ops = createSandboxedBashOps(runtime, shell);
      const handler = createGuard({
        policy: config.policy,
        tools: () => pi.getAllTools(),
        overrides: config.overrides,
        cwd: ctx.cwd,
      });

      // Pre-flight before initializing: a missing platform tool must be a clear refusal here, not a
      // confusing failure inside a command later.
      if (!runtime.isSupportedPlatform()) {
        throw new Error(
          `this platform (${platform}) has no OS sandbox the runtime can drive`,
        );
      }
      const dependencies = await runtime.checkDependencies();
      if (dependencies.errors.length > 0) {
        throw new Error(
          `missing sandbox dependencies — ${dependencies.errors.join("; ")}`,
        );
      }
      if (dependencies.warnings.length > 0) {
        ctx.ui.notify(`guard: ${dependencies.warnings.join("; ")}`, "warning");
      }

      await runtime.initialize(config.runtime);

      bashOps = ops;
      guard = handler;
      status = `guard: on — ${config.policy.allowedDomains.length} domain(s), ${config.policy.allowWrite.length} writable root(s)`;
      if (config.ignoredKeys.length > 0) {
        ctx.ui.notify(
          `guard: ignoring config keys the runtime no longer accepts — ${config.ignoredKeys.join(", ")}`,
          "warning",
        );
      }

      // Access the guard had to infer is the one thing a refusal cannot surface when the guess is
      // permissive, so announce it at session start: this is the trigger for correcting it in config.
      const inferred = inferredToolAccesses(pi.getAllTools(), config.overrides);
      if (inferred.length > 0) {
        const summary = inferred
          .map((tool) => `${tool.name} (fields: ${tool.fields.join(", ")})`)
          .join("; ");
        ctx.ui.notify(
          `guard: access inferred for ${inferred.length} Tool(s) — ${summary}. Each is judged against both the read and write rules until declared in \`tools\`.`,
          "warning",
        );
      }

      // The sandboxed shell tools are registered per session so they capture this session's cwd.
      // Every shell Tool pi offers goes through the adapter: the point of this package is that no
      // command Tool is left unfenced.
      const operations = {
        exec: (
          command: string,
          commandCwd: string,
          options: Parameters<BashOps["exec"]>[2],
        ) => {
          const reason = fenceUnavailable();
          if (reason !== undefined) throw new Error(reason);
          if (bashOps === undefined) throw new Error("guard is not running");
          return bashOps.exec(command, commandCwd, options);
        },
      };

      pi.registerTool(
        createBashToolDefinition(ctx.cwd, {
          shellPath: shell.shell,
          operations,
        }),
      );
      if (platform === "win32") {
        pi.registerTool(
          createPowerShellToolDefinition(ctx.cwd, { operations }),
        );
      }
    } catch (error) {
      // Fail closed: a guard that could not start must not silently leave tools unguarded.
      fenceUnavailableReason = `the guard could not start: ${error instanceof Error ? error.message : String(error)}`;
      status = `guard: FAILED — ${fenceUnavailableReason}`;
      ctx.ui.notify(status, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    if (disabledByFlag()) return;
    try {
      await runtime.reset();
    } catch {
      // Teardown failures must not mask the session's own shutdown.
    }
  });

  pi.on(
    "tool_call",
    (event: ToolCallEvent): ToolCallEventResult | undefined => {
      if (disabledByFlag()) return undefined;

      if (fenceUnavailableReason !== undefined) {
        return {
          block: true,
          reason: `Guard refused ${event.toolName}: ${fenceUnavailableReason}`,
        };
      }
      if (needsLiveFence(event.toolName) && bashOps === undefined) {
        return {
          block: true,
          reason: `Guard refused ${event.toolName}: the OS sandbox is not running, so this command could not be fenced`,
        };
      }
      if (guard === undefined) return undefined;

      return guard({ toolName: event.toolName, input: { ...event.input } });
    },
  );

  pi.on("user_bash", () => {
    if (disabledByFlag() || bashOps === undefined) return undefined;
    return { operations: bashOps };
  });

  pi.registerCommand("guard", {
    description: "Show what the sandbox guard is enforcing",
    handler: async (_args, ctx) => {
      const grants = guard?.grants();
      const granted =
        grants === undefined ||
        (grants.paths.length === 0 && grants.tools.length === 0)
          ? "nothing granted this session"
          : `granted — paths: ${grants.paths.join(", ") || "none"}; tools: ${grants.tools.join(", ") || "none"}`;
      ctx.ui.notify(`${status}; ${granted}`, "info");
    },
  });

  pi.registerCommand("guard-allow", {
    description: "Admit a path, or `tool:<name>`, for the rest of this session",
    handler: async (args, ctx) => {
      const target = args.trim();
      if (target.length === 0) {
        ctx.ui.notify(
          "Usage: /guard-allow <path> | /guard-allow tool:<name>",
          "warning",
        );
        return;
      }
      if (guard === undefined) {
        ctx.ui.notify(`${status}; nothing to grant`, "error");
        return;
      }

      if (target.startsWith("tool:")) {
        const toolName = target.slice("tool:".length).trim();
        guard.grantTool(toolName);
        ctx.ui.notify(
          `guard: ${toolName} may run for the rest of this session`,
          "info",
        );
        return;
      }

      const result = guard.grantPath(target);
      if (!result.granted) {
        ctx.ui.notify(`guard: ${result.reason}`, "warning");
        return;
      }
      ctx.ui.notify(
        `guard: ${target} is admitted for the rest of this session`,
        "info",
      );
    },
  });
}
