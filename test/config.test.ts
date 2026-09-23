import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadGuardConfig } from "../src/config.ts";

function fixtureDir(): { agentDir: string; cwd: string } {
  const agentDir = mkdtempSync(join(tmpdir(), "guard-agent-"));
  // The session cwd is canonical, matching how the guard names its region. On a host where the
  // temp root is a symlink (macOS `/tmp` -> `/private/tmp`) the raw mkdtemp path is not.
  const cwd = realpathSync.native(
    mkdtempSync(join(tmpdir(), "guard-project-")),
  );
  return { agentDir, cwd };
}

function writeGlobal(dir: { agentDir: string }, config: unknown): void {
  writeFileSync(
    join(dir.agentDir, "sandbox.json"),
    JSON.stringify(config),
    "utf-8",
  );
}

function writeProject(dir: { cwd: string }, config: unknown): void {
  mkdirSync(join(dir.cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(dir.cwd, ".pi", "sandbox.json"),
    JSON.stringify(config),
    "utf-8",
  );
}

test("reads the filesystem policy out of the existing config file", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    filesystem: {
      denyRead: ["/Users"],
      allowRead: ["."],
      allowWrite: ["."],
      denyWrite: [".env"],
    },
  });

  const config = loadGuardConfig(dir);

  // Relative patterns are absolutized against the session cwd, so the guard and the OS fence agree.
  assert.deepEqual(config.policy.denyRead, ["/Users"]);
  assert.deepEqual(config.policy.allowWrite, [dir.cwd]);
  assert.deepEqual(config.policy.denyWrite, [join(dir.cwd, ".env")]);
});

test("strips the network policy from the runtime config, so network access is not fenced", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    network: {
      allowedDomains: ["github.com"],
      deniedDomains: ["evil.test"],
      deniedResolvedAddresses: ["10.0.0.0/8"],
      strictAllowlist: true,
      allowAllUnixSockets: true,
    },
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
  });

  const config = loadGuardConfig(dir);
  const network = config.runtime.network as Record<string, unknown>;

  // Absent, not empty: the runtime reads an empty list as block-all and an absent one as
  // unrestricted, so removing the key is what turns its network layer off.
  assert.equal(network["allowedDomains"], undefined);
  assert.equal(network["deniedDomains"], undefined);
  // Every key that acts only through the proxy the guard no longer runs is stripped too, so none
  // can read as a fence.
  assert.equal(network["deniedResolvedAddresses"], undefined);
  assert.equal(network["strictAllowlist"], undefined);
  // Permissive local-IPC settings pass through, since they are grants rather than restrictions.
  assert.equal(network["allowAllUnixSockets"], true);
  assert.deepEqual(config.ignoredKeys, [
    "network.allowedDomains",
    "network.deniedDomains",
    "network.deniedResolvedAddresses",
    "network.strictAllowlist",
  ]);
});

test("reports the two config paths it read, so `/guard` can name them", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
  });
  writeProject(dir, {
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
  });

  assert.deepEqual(loadGuardConfig(dir).configPaths, {
    global: join(dir.agentDir, "sandbox.json"),
    project: join(dir.cwd, ".pi", "sandbox.json"),
  });
});

test("unions the layers so a project file cannot drop a global denyRead", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    filesystem: {
      denyRead: ["/Users"],
      allowRead: ["~/secrets"],
      allowWrite: ["/tmp"],
      denyWrite: [],
    },
  });
  writeProject(dir, {
    filesystem: {
      denyRead: [],
      allowRead: ["."],
      allowWrite: [],
      denyWrite: [".env"],
    },
  });

  const config = loadGuardConfig(dir);

  // Both layers, guard and OS fence, must see the same effective policy. Relative spellings are
  // absolutized against the session cwd; `~` is left for each consumer to expand.
  assert.deepEqual(
    config.policy.denyRead,
    ["/Users"],
    "the global denyRead must survive",
  );
  assert.deepEqual(config.runtime.filesystem.denyRead, ["/Users"]);
  assert.deepEqual(config.policy.allowRead, ["~/secrets", dir.cwd]);
  assert.deepEqual(config.runtime.filesystem.allowRead, ["~/secrets", dir.cwd]);
  assert.deepEqual(config.policy.denyWrite, [join(dir.cwd, ".env")]);
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
    filesystem: {
      denyRead: ["/Users"],
      allowRead: ["."],
      allowWrite: ["."],
      denyWrite: [],
    },
  });
  writeProject(dir, {
    filesystem: { allowRead: ["/opt"], allowWrite: ["/tmp"], denyWrite: [] },
  });

  const config = loadGuardConfig(dir);

  assert.deepEqual(config.policy.allowRead, [dir.cwd, "/opt"]);
  assert.deepEqual(config.policy.allowWrite, [
    dir.cwd,
    realpathSync.native("/tmp"),
  ]);
});

test("absolutizes relative path patterns against the session cwd, so the fence cannot diverge", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    network: { allowedDomains: ["github.com"] },
    filesystem: {
      denyRead: [],
      allowRead: ["."],
      allowWrite: ["sub/dir"],
      denyWrite: [".env"],
    },
  });

  const config = loadGuardConfig(dir);

  assert.deepEqual(config.runtime.filesystem.allowRead, [dir.cwd]);
  assert.deepEqual(config.runtime.filesystem.allowWrite, [
    join(dir.cwd, "sub/dir"),
  ]);
  assert.deepEqual(config.runtime.filesystem.denyWrite, [
    join(dir.cwd, ".env"),
  ]);
  // The guard reads the same absolutized object, so both name one region.
  assert.deepEqual(
    config.policy.allowRead,
    config.runtime.filesystem.allowRead,
  );
});

test("leaves absolute paths and `~` patterns unrewritten", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    filesystem: {
      denyRead: ["/Users", "~/secrets"],
      allowRead: [],
      allowWrite: [],
      denyWrite: [],
    },
  });

  const config = loadGuardConfig(dir);

  assert.deepEqual(config.runtime.filesystem.denyRead, ["/Users", "~/secrets"]);
});

test("canonicalizes a pattern under a symlinked root, so the fence and guard name one region", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "guard-link-agent-"));
  writeGlobal(
    { agentDir },
    {
      filesystem: {
        denyRead: [],
        allowRead: ["."],
        allowWrite: ["newdir"],
        denyWrite: [],
      },
    },
  );
  const real = realpathSync.native(
    mkdtempSync(join(tmpdir(), "guard-link-real-")),
  );
  const link = join(mkdtempSync(join(tmpdir(), "guard-link-parent-")), "link");
  symlinkSync(real, link, "dir");

  const config = loadGuardConfig({ agentDir, cwd: link });

  // `.` is the symlink itself, and `newdir` does not exist yet: both must reach the fence as the
  // realpath spelling the guard judges claims by, not as the link spelling.
  assert.deepEqual(config.runtime.filesystem.allowRead, [real]);
  assert.deepEqual(config.runtime.filesystem.allowWrite, [
    join(real, "newdir"),
  ]);
  assert.deepEqual(
    config.policy.allowRead,
    config.runtime.filesystem.allowRead,
  );
});

test("hard-errors on an unrecognised key, so a typo cannot look like protection", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    network: { allowedDomains: [] },
    filesystem: {
      denyRead: [],
      allowRead: ["."],
      allowWrites: ["."],
      denyWrite: [],
    },
  });

  assert.throws(() => loadGuardConfig(dir), /allowWrites/);
});

test("tolerates prompt-era keys, reporting them as ignored rather than stripping them", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    enabled: true,
    permissionPromptTimeoutSeconds: 600,
    network: {
      allowedDomains: [],
      allowUnauthenticatedSocksProxy: true,
      sshProxy: false,
    },
    filesystem: {
      denyRead: [],
      allowRead: ["."],
      allowWrite: ["."],
      denyWrite: [],
    },
  });

  const config = loadGuardConfig(dir);

  assert.deepEqual(config.ignoredKeys, [
    "network.allowUnauthenticatedSocksProxy",
    "network.allowedDomains",
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
    filesystem: {
      denyRead: [],
      allowRead: ["."],
      allowWrite: ["."],
      denyWrite: [],
    },
    tools: { format_md_tables: { fields: ["path"], access: "write" } },
  });

  const config = loadGuardConfig(dir);

  assert.deepEqual(config.overrides, {
    format_md_tables: { fields: ["path"], access: "write" },
  });
});

test("adds a project tools map to the global one instead of replacing it", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    network: { allowedDomains: [] },
    filesystem: {
      denyRead: [],
      allowRead: ["."],
      allowWrite: ["."],
      denyWrite: [],
    },
    tools: {
      format_md_tables: { fields: ["path"], access: "write" },
      legacy_notes: { fields: [], access: "none" },
    },
  });
  writeProject(dir, {
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    tools: {
      format_md_tables: { fields: ["out"], access: "read" },
      project_only: { fields: ["path"], access: "read" },
    },
  });

  const config = loadGuardConfig(dir);

  assert.deepEqual(config.overrides, {
    // The project's entry for a Tool the global file already describes wins.
    format_md_tables: { fields: ["out"], access: "read" },
    // But it does not delete the global entries beside it.
    legacy_notes: { fields: [], access: "none" },
    project_only: { fields: ["path"], access: "read" },
  });
});

test("refuses a tools map that is not a map of Tool names", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    network: { allowedDomains: [] },
    filesystem: {
      denyRead: [],
      allowRead: ["."],
      allowWrite: ["."],
      denyWrite: [],
    },
    tools: ["format_md_tables"],
  });

  assert.throws(() => loadGuardConfig(dir), /tools/);
});

test("refuses a Tool override that is not an object, rather than skipping it", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    tools: { format_md_tables: "write" },
  });

  assert.throws(() => loadGuardConfig(dir), /tools\.format_md_tables/);
});

test("refuses a Tool override whose fields is missing, naming the Tool", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    tools: { format_md_tables: { access: "write" } },
  });

  assert.throws(() => loadGuardConfig(dir), /tools\.format_md_tables\.fields/);
});

test("refuses a Tool override whose fields names a non-string, so a typo cannot fail open", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    tools: { format_md_tables: { fields: ["path", 5], access: "write" } },
  });

  assert.throws(() => loadGuardConfig(dir), /tools\.format_md_tables\.fields/);
});

test("refuses a Tool override that declares an access but names no fields", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    tools: { format_md_tables: { fields: [], access: "write" } },
  });

  // "none" is the only deliberate way to say a Tool touches no paths.
  assert.throws(() => loadGuardConfig(dir), /tools\.format_md_tables/);
});

test("accepts access none with empty fields, the deliberate touches-nothing form", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    tools: { legacy_notes: { fields: [], access: "none" } },
  });

  assert.deepEqual(loadGuardConfig(dir).overrides, {
    legacy_notes: { fields: [], access: "none" },
  });
});

test("accepts access none with no fields key at all, since it names no paths", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    tools: { legacy_notes: { access: "none" } },
  });

  assert.deepEqual(loadGuardConfig(dir).overrides, {
    legacy_notes: { fields: [], access: "none" },
  });
});

test("reads a declared pass-through Tool, so a forwarded call can be unwrapped", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    tools: {
      call_tool: { passThrough: { tool: "tool", params: "params" } },
    },
  });

  assert.deepEqual(loadGuardConfig(dir).overrides, {
    call_tool: { passThrough: { tool: "tool", params: "params" } },
  });
});

test("refuses a pass-through declaration whose field names are missing or not strings", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    tools: { call_tool: { passThrough: { tool: "tool" } } },
  });

  assert.throws(
    () => loadGuardConfig(dir),
    /tools\.call_tool\.passThrough\.params/,
  );
});

test("refuses a pass-through declaration that also declares path fields", () => {
  const dir = fixtureDir();
  writeGlobal(dir, {
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    tools: {
      call_tool: {
        fields: ["path"],
        access: "read",
        passThrough: { tool: "tool", params: "params" },
      },
    },
  });

  assert.throws(() => loadGuardConfig(dir), /tools\.call_tool/);
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
    filesystem: {
      denyRead: [],
      allowRead: ["."],
      allowWrite: ["."],
      denyWrite: [],
    },
  });

  assert.equal(loadGuardConfig(dir).enabled, false);
});

test("reports malformed JSON rather than silently falling back to defaults", () => {
  const dir = fixtureDir();
  writeFileSync(join(dir.agentDir, "sandbox.json"), "{ not json", "utf-8");

  assert.throws(() => loadGuardConfig(dir), /sandbox\.json/);
});
