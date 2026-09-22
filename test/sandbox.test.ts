import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSandboxedBashOps, type SandboxRuntime } from "../src/sandbox.ts";

const cwd = mkdtempSync(join(tmpdir(), "guard-cwd-"));

/**
 * A stand-in for `@anthropic-ai/sandbox-runtime`'s singleton.
 *
 * The real one spawns proxy processes and rewrites the command through platform sandbox tooling;
 * what the guard owes the runtime is a wrapping call and a cleanup call, and that contract is what
 * these tests pin.
 */
function fakeRuntime(
  options: { socksProxyPort?: number } = {},
): SandboxRuntime & {
  wrapped: { command: string; shell: string | undefined }[];
  argvWrapped: string[];
  cleanups: number;
} {
  const runtime = {
    wrapped: [] as { command: string; shell: string | undefined }[],
    argvWrapped: [] as string[],
    cleanups: 0,
    isSupportedPlatform: () => true,
    async checkDependencies(): Promise<{
      warnings: string[];
      errors: string[];
    }> {
      return { warnings: [], errors: [] };
    },
    async initialize(): Promise<void> {},
    async wrapWithSandbox(command: string, shell?: string): Promise<string> {
      runtime.wrapped.push({ command, shell });
      return command;
    },
    async wrapWithSandboxArgv(
      command: string,
    ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
      runtime.argvWrapped.push(command);
      // An argv that echoes the command, so the test can prove the child really ran.
      return {
        argv: [
          process.execPath,
          "-e",
          `process.stdout.write(${JSON.stringify(command)})`,
        ],
        env: { SRT_FENCED: "1" },
      };
    },
    getSocksProxyPort(): number | undefined {
      return options.socksProxyPort;
    },
    cleanupAfterCommand(): void {
      runtime.cleanups += 1;
    },
    async reset(): Promise<void> {},
  };
  return runtime;
}

const shell = { shell: "/bin/bash", args: ["-c"] };

function collect(): { chunks: Buffer[]; onData: (data: Buffer) => void } {
  const chunks: Buffer[] = [];
  return { chunks, onData: (data) => chunks.push(data) };
}

test("runs the command through the shell and returns its exit code", async () => {
  const runtime = fakeRuntime();
  const ops = createSandboxedBashOps(runtime, shell);
  const output = collect();

  const result = await ops.exec("echo hello-from-sandbox", cwd, {
    onData: output.onData,
  });

  assert.equal(result.exitCode, 0);
  assert.match(Buffer.concat(output.chunks).toString(), /hello-from-sandbox/);
});

test("reports the exit code of a failing command rather than throwing", async () => {
  const runtime = fakeRuntime();
  const ops = createSandboxedBashOps(runtime, shell);

  const result = await ops.exec("exit 3", cwd, { onData: () => {} });

  assert.equal(result.exitCode, 3);
});

test("asks the runtime to wrap the command, naming the shell it will run under", async () => {
  const runtime = fakeRuntime();
  const ops = createSandboxedBashOps(runtime, shell);

  await ops.exec("echo wrapped", cwd, { onData: () => {} });

  assert.equal(runtime.wrapped.length, 1);
  assert.match(runtime.wrapped[0]?.command ?? "", /echo wrapped/);
  assert.equal(runtime.wrapped[0]?.shell, "/bin/bash");
});

test("spawns the fenced argv the runtime hands back on Windows", async () => {
  const runtime = fakeRuntime();
  // The real Windows fence is unverified on this machine; this pins the routing, not the fence.
  const ops = createSandboxedBashOps(runtime, shell, "win32");
  const output = collect();

  const result = await ops.exec("echo hello-from-windows", cwd, {
    onData: output.onData,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(
    runtime.wrapped.length,
    0,
    "the POSIX shell wrapper must not be used on Windows",
  );
  assert.deepEqual(runtime.argvWrapped, ["echo hello-from-windows"]);
  assert.match(Buffer.concat(output.chunks).toString(), /hello-from-windows/);
});

test("refuses a working directory that does not exist", async () => {
  const runtime = fakeRuntime();
  const ops = createSandboxedBashOps(runtime, shell);

  await assert.rejects(
    ops.exec("echo nowhere", join(cwd, "missing"), { onData: () => {} }),
    /Working directory does not exist/,
  );
});

test("kills a command that overruns its timeout", async () => {
  const runtime = fakeRuntime();
  const ops = createSandboxedBashOps(runtime, shell);
  const started = Date.now();

  await assert.rejects(
    ops.exec("sleep 30", cwd, { onData: () => {}, timeout: 1 }),
    /timeout:1/,
  );

  assert.ok(
    Date.now() - started < 10_000,
    "the timeout should kill the command, not wait it out",
  );
});

test("kills a command when the caller aborts", async () => {
  const runtime = fakeRuntime();
  const ops = createSandboxedBashOps(runtime, shell);
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 50);

  await assert.rejects(
    ops.exec("sleep 30", cwd, { onData: () => {}, signal: controller.signal }),
    /aborted/,
  );

  assert.ok(
    Date.now() - started < 10_000,
    "aborting should kill the command, not wait it out",
  );
});

test("tells the runtime each command has finished, so it can release proxy state", async () => {
  const runtime = fakeRuntime();
  const ops = createSandboxedBashOps(runtime, shell);

  await ops.exec("echo done", cwd, { onData: () => {} });
  await assert.rejects(
    ops.exec("sleep 30", cwd, { onData: () => {}, timeout: 1 }),
  );

  assert.equal(runtime.cleanups, 2);
});

test("routes ssh through the runtime's SOCKS proxy on macOS", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("the ssh shim is macOS-specific");
    return;
  }
  const runtime = fakeRuntime({ socksProxyPort: 1080 });
  const ops = createSandboxedBashOps(runtime, shell);

  await ops.exec("ssh host", cwd, { onData: () => {} });

  assert.match(runtime.wrapped[0]?.command ?? "", /^ssh\(\) \{/);
  assert.match(runtime.wrapped[0]?.command ?? "", /-x localhost:1080/);
});

test("leaves ssh alone when the runtime reports no proxy port", async () => {
  const runtime = fakeRuntime();
  const ops = createSandboxedBashOps(runtime, shell);

  await ops.exec("ssh host", cwd, { onData: () => {} });

  assert.doesNotMatch(runtime.wrapped[0]?.command ?? "", /ssh\(\)/);
});

test("writes the command to stdin when the shell is configured that way", async () => {
  const runtime = fakeRuntime();
  const ops = createSandboxedBashOps(runtime, {
    shell: "/bin/sh",
    args: ["-s"],
    commandTransport: "stdin",
  });
  const output = collect();

  const result = await ops.exec("echo from-stdin", cwd, {
    onData: output.onData,
  });

  assert.equal(result.exitCode, 0);
  assert.match(Buffer.concat(output.chunks).toString(), /from-stdin/);
});
