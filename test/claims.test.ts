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

test("a declared pass-through Tool is judged as the Tool it forwards to", () => {
  const inventory = createToolInventory({
    tools: () => [toolSchema("mermaid_lint", { path: { type: "string" } })],
    overrides: {
      call_tool: { passThrough: { tool: "tool", params: "params" } },
    },
    cwd: "/tmp",
  });

  assert.deepEqual(
    inventory.touches({
      toolName: "call_tool",
      input: { tool: "mermaid_lint", params: { path: "/tmp/diagram.mmd" } },
    }),
    {
      kind: "claims",
      claims: [
        {
          path: "/tmp/diagram.mmd",
          access: "write",
          basis: "inferred",
          fields: ["path"],
        },
      ],
    },
  );
});

test("a forwarded call is judged by the target's own override", () => {
  const inventory = createToolInventory({
    tools: () => [],
    overrides: {
      call_tool: { passThrough: { tool: "tool", params: "params" } },
      legacy_notes: { fields: [], access: "none" },
    },
    cwd: "/tmp",
  });

  assert.deepEqual(
    inventory.touches({
      toolName: "call_tool",
      input: { tool: "legacy_notes", params: {} },
    }),
    { kind: "none" },
  );
});

test("a pass-through Tool is not unwrapped until it is declared", () => {
  const inventory = createToolInventory({
    tools: () => [
      toolSchema("call_tool", {
        tool: { type: "string" },
        params: { type: "object" },
      }),
      toolSchema("mermaid_lint", { path: { type: "string" } }),
    ],
    overrides: {},
    cwd: "/tmp",
  });

  // Recognising a pass-through Tool by name or schema shape would be the heuristic ADR-0002
  // rejected; until declared, the opaque call is simply unjudgeable.
  assert.deepEqual(
    inventory.touches({
      toolName: "call_tool",
      input: { tool: "mermaid_lint", params: { path: "/tmp/x" } },
    }),
    { kind: "unmapped" },
  );
});

test("a forwarded target the guard cannot judge makes the whole call unmapped", () => {
  const inventory = createToolInventory({
    tools: () => [toolSchema("obs_recall", { query: { type: "string" } })],
    overrides: {
      call_tool: { passThrough: { tool: "tool", params: "params" } },
    },
    cwd: "/tmp",
  });

  assert.deepEqual(
    inventory.touches({
      toolName: "call_tool",
      input: { tool: "obs_recall", params: { query: "x" } },
    }),
    {
      kind: "unmapped",
      forwarded: { forwardedBy: "call_tool", target: "obs_recall" },
    },
  );
});

test("a pass-through call missing its target or params is unmapped", () => {
  const inventory = createToolInventory({
    tools: () => [],
    overrides: {
      call_tool: { passThrough: { tool: "tool", params: "params" } },
    },
    cwd: "/tmp",
  });

  assert.deepEqual(
    inventory.touches({ toolName: "call_tool", input: { params: {} } }),
    { kind: "unmapped", forwarded: { forwardedBy: "call_tool" } },
  );
  assert.deepEqual(
    inventory.touches({
      toolName: "call_tool",
      input: { tool: "x", params: "not an object" },
    }),
    { kind: "unmapped", forwarded: { forwardedBy: "call_tool", target: "x" } },
  );
});

test("a pass-through chain deeper than the bound is refused, naming the last target", () => {
  const inventory = createToolInventory({
    tools: () => [],
    overrides: {
      call_tool: { passThrough: { tool: "tool", params: "params" } },
    },
    cwd: "/tmp",
  });
  // A self-referential chain: each forward names call_tool again, so the bound is what stops it.
  const input: Record<string, unknown> = { tool: "call_tool" };
  input["params"] = input;

  assert.deepEqual(inventory.touches({ toolName: "call_tool", input }), {
    kind: "unmapped",
    forwarded: { forwardedBy: "call_tool", target: "call_tool" },
  });
});

test("a pass-through override cannot turn a shell Tool into a path claim", () => {
  const inventory = createToolInventory({
    tools: () => [],
    overrides: {
      bash: { passThrough: { tool: "tool", params: "params" } },
    },
    cwd: "/tmp",
  });

  assert.deepEqual(
    inventory.touches({ toolName: "bash", input: { command: "curl x" } }),
    { kind: "command", command: "curl x" },
  );
});

test("a forwarded shell Tool carries the pass-through that forwarded it", () => {
  const inventory = createToolInventory({
    tools: () => [],
    overrides: {
      call_tool: { passThrough: { tool: "tool", params: "params" } },
    },
    cwd: "/tmp",
  });

  // The guard cannot confirm the OS fence wraps a command the pass-through resolved itself, so the
  // mapping marks it; the command kind is not enough on its own.
  assert.deepEqual(
    inventory.touches({
      toolName: "call_tool",
      input: { tool: "bash", params: { command: "echo hi" } },
    }),
    {
      kind: "command",
      command: "echo hi",
      forwarded: { forwardedBy: "call_tool", target: "bash" },
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
