import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadGuardConfig } from "../src/config.ts";

function fixtureDir(): { agentDir: string; cwd: string } {
  const agentDir = mkdtempSync(join(tmpdir(), "guard-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "guard-project-"));
  return { agentDir, cwd };
}

function writeGlobal(dir: { agentDir: string }, config: unknown): void {
  writeFileSync(join(dir.agentDir, "sandbox.json"), JSON.stringify(config), "utf-8");
}

function writeProject(dir: { cwd: string }, config: unknown): void {
  mkdirSync(join(dir.cwd, ".pi"), { recursive: true });
  writeFileSync(join(dir.cwd, ".pi", "sandbox.json"), JSON.stringify(config), "utf-8");
}

test("reads the filesystem and network policy out of the existing config file", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    network: { allowedDomains: ["github.com"] },
    filesystem: {
      denyRead: ["/Users"],
      allowRead: ["."],
      allowWrite: ["."],
      denyWrite: [".env"],
    },
  });

  const config = loadGuardConfig(dir);

  assert.deepEqual(config.policy.allowedDomains, ["github.com"]);
  assert.deepEqual(config.policy.denyRead, ["/Users"]);
  assert.deepEqual(config.policy.allowWrite, ["."]);
  assert.deepEqual(config.policy.denyWrite, [".env"]);
});

test("unions the layers so a project file cannot drop a global denyRead", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    network: { allowedDomains: ["github.com"] },
    filesystem: { denyRead: ["/Users"], allowRead: ["~/secrets"], allowWrite: ["/tmp"], denyWrite: [] },
  });
  writeProject(dir, {
    network: { allowedDomains: ["npmjs.org"] },
    filesystem: { denyRead: [], allowRead: ["."], allowWrite: [], denyWrite: [".env"] },
  });

  const config = loadGuardConfig(dir);

  // Both layers, guard and OS fence, must see the same effective policy.
  assert.deepEqual(config.policy.denyRead, ["/Users"], "the global denyRead must survive");
  assert.deepEqual(config.runtime.filesystem.denyRead, ["/Users"]);
  assert.deepEqual(config.policy.allowRead, ["~/secrets", "."]);
  assert.deepEqual(config.runtime.filesystem.allowRead, ["~/secrets", "."]);
  assert.deepEqual(config.policy.allowedDomains, ["github.com", "npmjs.org"]);
  assert.deepEqual(config.runtime.network.allowedDomains, ["github.com", "npmjs.org"]);
  assert.deepEqual(config.policy.denyWrite, [".env"]);
});

test("supplies the denyRead default the config file omits, so the home root stays denied", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    network: { allowedDomains: [] },
    filesystem: { allowRead: ["."], allowWrite: ["."], denyWrite: [] },
  });

  const config = loadGuardConfig(dir);

  assert.deepEqual(config.policy.denyRead, ["/Users", "/home"]);
});

test("merges a project config over the global one, unioning the path lists", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    network: { allowedDomains: ["github.com"] },
    filesystem: { denyRead: ["/Users"], allowRead: ["."], allowWrite: ["."], denyWrite: [] },
  });
  writeProject(dir, {
    network: { allowedDomains: ["npmjs.org"] },
    filesystem: { allowRead: ["/opt"], allowWrite: ["/tmp"], denyWrite: [] },
  });

  const config = loadGuardConfig(dir);

  assert.deepEqual(config.policy.allowedDomains, ["github.com", "npmjs.org"]);
  assert.deepEqual(config.policy.allowRead, [".", "/opt"]);
  assert.deepEqual(config.policy.allowWrite, [".", "/tmp"]);
});

test("hard-errors on an unrecognised key, so a typo cannot look like protection", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    network: { allowedDomains: [] },
    filesystem: { denyRead: [], allowRead: ["."], allowWrites: ["."], denyWrite: [] },
  });

  assert.throws(() => loadGuardConfig(dir), /allowWrites/);
});

test("tolerates prompt-era keys, reporting them as ignored rather than stripping them", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    enabled: true,
    permissionPromptTimeoutSeconds: 600,
    network: { allowedDomains: [], allowUnauthenticatedSocksProxy: true, sshProxy: false },
    filesystem: { denyRead: [], allowRead: ["."], allowWrite: ["."], denyWrite: [] },
  });

  const config = loadGuardConfig(dir);

  assert.deepEqual(config.ignoredKeys, [
    "network.allowUnauthenticatedSocksProxy",
    "network.sshProxy",
    "permissionPromptTimeoutSeconds",
  ]);
});

test("refuses to load a config whose types are wrong", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    network: { allowedDomains: "github.com" },
    filesystem: { denyRead: [], allowWrite: [". "], denyWrite: [] },
  });

  assert.throws(() => loadGuardConfig(dir), /allowedDomains|network/i);
});

test("reads the guard's own tools map", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    network: { allowedDomains: [] },
    filesystem: { denyRead: [], allowRead: ["."], allowWrite: ["."], denyWrite: [] },
    tools: { format_md_tables: { fields: ["path"], access: "write" } },
  });

  const config = loadGuardConfig(dir);

  assert.deepEqual(config.overrides, {
    format_md_tables: { fields: ["path"], access: "write" },
  });
});

test("an absent config file is not an error", () => {
  const dir = fixtureDir();

  const config = loadGuardConfig(dir);

  assert.equal(config.enabled, true);
  assert.deepEqual(config.overrides, {});
  assert.deepEqual(config.policy.denyRead, ["/Users", "/home"]);
});

test("honours enabled: false as an explicit off switch", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    enabled: false,
    network: { allowedDomains: [] },
    filesystem: { denyRead: [], allowRead: ["."], allowWrite: ["."], denyWrite: [] },
  });

  assert.equal(loadGuardConfig(dir).enabled, false);
});

test("reports malformed JSON rather than silently falling back to defaults", () => {
  const dir = fixtureDir();
  writeFileSync(join(dir.agentDir, "sandbox.json"), "{ not json", "utf-8");

  assert.throws(() => loadGuardConfig(dir), /sandbox\.json/);
});
