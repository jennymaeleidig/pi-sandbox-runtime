// Citation: Chris Arderne — pi-sandbox (v0.6.8) [MIT]
// Source: https://github.com/carderne/pi-sandbox/blob/v0.6.8/src/sandbox-runtime.ts
//         itself derived from pi-mono's sandbox example by Mario Zechner [MIT],
//         https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/sandbox
// Accessed: 2026-09-22
// Modified by jennymaeleidig on 2026-09-22 — adapted: narrowed the runtime to a structural
// interface so the wrapping contract can be tested against a fake, added stdin command transport,
// and dropped the fork-only session-allowance merging.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

import {
  SandboxManager,
  type SandboxDependencyCheck,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

/** The part of the runtime's singleton this package uses, as a seam tests can replace. */
export interface SandboxRuntime {
  /** Whether this platform has an OS sandbox the runtime can drive. */
  isSupportedPlatform(): boolean;
  /** Pre-flight: are the platform tools the sandbox needs actually present? */
  checkDependencies(): Promise<SandboxDependencyCheck>;
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  /** POSIX: fold a command into a shell string, already fenced. */
  wrapWithSandbox(command: string, shell?: string): Promise<string>;
  /** Windows: hand back the argv to spawn, already fenced. */
  wrapWithSandboxArgv(
    command: string,
    shell?: string,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
}

/** The shell to run wrapped commands under, mirroring pi's own `ShellConfig`. */
export interface Shell {
  shell: string;
  args: string[];
  commandTransport?: "argv" | "stdin";
}

/** Mirrors pi's `BashOperations.exec` contract without importing pi's types. */
export interface BashOps {
  exec(
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null }>;
}

/** After a command exits, wait this long for idle inherited pipes before releasing them. */
const EXIT_STDIO_GRACE_MS = 100;

/**
 * The real runtime, as a {@link SandboxRuntime}.
 *
 * Deliberately thin: every interesting decision lives in `guard.ts`, and this shim exists only to
 * keep the runtime's module-level singleton out of the rest of the package.
 */
export function createSandboxRuntime(): SandboxRuntime {
  return {
    isSupportedPlatform: () => SandboxManager.isSupportedPlatform(),
    checkDependencies: () => SandboxManager.checkDependenciesAsync(),
    initialize: (config) => SandboxManager.initialize(config),
    wrapWithSandbox: (command, shell) =>
      SandboxManager.wrapWithSandbox(command, shell),
    wrapWithSandboxArgv: (command, shell) =>
      SandboxManager.wrapWithSandboxArgv(command, shell),
    cleanupAfterCommand: () => SandboxManager.cleanupAfterCommand(),
    reset: () => SandboxManager.reset(),
  };
}

/**
 * Wait for a child process to exit without hanging on inherited stdio handles.
 *
 * A detached descendant can hold the pipes open after the direct child is gone; keep reading while
 * output is active, then release the pipes after a short idle grace.
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };

    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };

    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null) => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

/**
 * Bash operations that run every command inside the OS sandbox.
 *
 * This is the fence: every command runs inside the OS sandbox, whose filesystem rules come from the
 * same policy the guard judges Tools by, since only the OS can enforce them reliably.
 */
export function createSandboxedBashOps(
  runtime: SandboxRuntime,
  shell: Shell,
  platform: NodeJS.Platform = process.platform,
): BashOps {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd))
        throw new Error(`Working directory does not exist: ${cwd}`);

      // Windows has no shell-string wrapper: the runtime returns the argv to spawn under its
      // dedicated sandbox account instead. Both branches are fenced before anything runs.
      const windows = platform === "win32";
      let file = shell.shell;
      let args = shell.args;
      let childEnv = env;
      let stdinScript: string | undefined;

      if (windows) {
        const plan = await runtime.wrapWithSandboxArgv(command, shell.shell);
        const [executable, ...rest] = plan.argv;
        file = executable ?? shell.shell;
        args = rest;
        childEnv = { ...plan.env, ...env };
      } else {
        const wrappedCommand = await runtime.wrapWithSandbox(
          command,
          shell.shell,
        );
        if (shell.commandTransport === "stdin") {
          stdinScript = wrappedCommand;
        } else {
          args = [...shell.args, wrappedCommand];
        }
      }

      if (signal?.aborted) throw new Error("aborted");

      const child = spawn(file, args, {
        cwd,
        env: childEnv,
        detached: true,
        stdio: [stdinScript === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const killProcessGroup = () => {
        if (!child.pid) return;
        try {
          // A negative pid signals the whole process group, so a command's own children die too.
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          killProcessGroup();
        }, timeout * 1000);
      }

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      signal?.addEventListener("abort", killProcessGroup, { once: true });

      if (stdinScript !== undefined) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(stdinScript);
      }

      try {
        const exitCode = await waitForChildProcess(child);
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", killProcessGroup);
        runtime.cleanupAfterCommand();
      }
    },
  };
}
