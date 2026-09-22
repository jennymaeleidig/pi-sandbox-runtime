import test from "node:test";
import assert from "node:assert/strict";

import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import {
  createToolInventory,
  inferredToolAccesses,
  needsLiveFence,
} from "../src/claims.ts";
import { toolSchema } from "./tool-info.ts";

test("the kind table is the one home of the Shell Tool fact", () => {
  assert.equal(needsLiveFence("bash"), true);
  assert.equal(needsLiveFence("powershell"), true);

  for (const name of ["read", "write", "edit", "grep", "find", "ls"]) {
    assert.equal(needsLiveFence(name), false, name);
  }
  assert.equal(needsLiveFence("mystery_tool"), false);
});

test("a command Tool is judged as a command, ahead of any config entry", () => {
  // A `tools` override must not be able to turn the fence's network check off.
  const inventory = createToolInventory({
    tools: () => [],
    overrides: { bash: { fields: ["command"], access: "read" } },
    cwd: "/tmp",
  });

  assert.deepEqual(
    inventory.touches({ toolName: "bash", input: { command: "curl x" } }),
    { kind: "command", command: "curl x" },
  );
});

test("an explicit config entry beats the core Tool table", () => {
  const inventory = createToolInventory({
    tools: () => [toolSchema("lint_notes", { out: { type: "string" } })],
    overrides: { lint_notes: { fields: ["out"], access: "write" } },
    cwd: "/tmp",
  });

  assert.deepEqual(
    inventory.touches({ toolName: "lint_notes", input: { out: "/tmp/x" } }),
    {
      kind: "claims",
      claims: [{ path: "/tmp/x", access: "write", basis: "declared" }],
    },
  );
});

test("a declared override whose field matches nothing is unmapped, not 'none'", () => {
  const inventory = createToolInventory({
    tools: () => [toolSchema("lint_notes", { path: { type: "string" } })],
    // "paths" is a typo for the Tool's actual `path` field. Treating the empty result as "touches
    // nothing" would let the typo lower protection below no config at all.
    overrides: { lint_notes: { fields: ["paths"], access: "write" } },
    cwd: "/tmp",
  });

  assert.deepEqual(
    inventory.touches({ toolName: "lint_notes", input: { path: "/tmp/x" } }),
    { kind: "unmapped" },
  );
});

test("an unknown Tool with path fields is judged by its schema", () => {
  const inventory = createToolInventory({
    tools: () => [toolSchema("format_md_tables", { path: { type: "string" } })],
    overrides: {},
    cwd: "/tmp",
  });

  assert.deepEqual(
    inventory.touches({
      toolName: "format_md_tables",
      input: { path: "/tmp/doc.md" },
    }),
    {
      kind: "claims",
      claims: [
        {
          path: "/tmp/doc.md",
          access: "write",
          basis: "inferred",
          fields: ["path"],
        },
      ],
    },
  );
});

test("an unknown Tool with no path field is unmapped, the fail-closed arm", () => {
  const inventory = createToolInventory({
    tools: () => [],
    overrides: {},
    cwd: "/tmp",
  });

  assert.deepEqual(
    inventory.touches({ toolName: "publish_notes", input: { mode: "dry" } }),
    { kind: "unmapped" },
  );
});

test("the provider is read per call, so a Tool that appears later is judged", () => {
  let tools: ToolInfo[] = [];
  const inventory = createToolInventory({
    tools: () => tools,
    overrides: {},
    cwd: "/tmp",
  });

  assert.deepEqual(
    inventory.touches({ toolName: "late_tool", input: { path: "/tmp/x" } }),
    { kind: "unmapped" },
  );

  tools = [toolSchema("late_tool", { path: { type: "string" } })];

  assert.deepEqual(
    inventory.touches({ toolName: "late_tool", input: { path: "/tmp/x" } }),
    {
      kind: "claims",
      claims: [
        {
          path: "/tmp/x",
          access: "write",
          basis: "inferred",
          fields: ["path"],
        },
      ],
    },
  );
});

test("lists the Tools whose access would be inferred, and the fields found", () => {
  const tools = [
    toolSchema("read", { path: { type: "string" } }),
    toolSchema("format_md_tables", { path: { type: "string" } }),
  ];

  assert.deepEqual(inferredToolAccesses(tools, {}), [
    { name: "format_md_tables", fields: ["path"] },
  ]);
  // Declaring the Tool ends the inference.
  assert.deepEqual(
    inferredToolAccesses(tools, {
      format_md_tables: { fields: ["path"], access: "read" },
    }),
    [],
  );
});
