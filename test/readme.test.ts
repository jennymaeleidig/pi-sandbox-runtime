import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";

import { loadGuardConfig } from "../src/config.ts";

/**
 * The README is the config documentation, and configuration is the whole product surface: a key
 * documented wrongly is a path the reader believes is protected. These tests hold it to the
 * shipped schema rather than to prose.
 */
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");

/** The guard's own keys, which it consumes instead of passing them to the runtime. */
const GUARD_KEYS = ["enabled", "tools"];

function fencedBlock(markdown: string, language: string): string {
  const match = new RegExp("```" + language + "\\n([\\s\\S]*?)```").exec(
    markdown,
  );
  const block = match?.[1];
  assert.ok(
    block !== undefined,
    `README.md must contain a \`\`\`${language} block`,
  );
  return block;
}

function property(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** Every config key the runtime's schema accepts, dotted one level deep. */
function acceptedKeys(): string[] {
  // The schema is a ZodEffects wrapping the object that holds the shape; probing it is the only way
  // to enumerate keys zod treats as optional, and a loud failure here is the point — upstream
  // adding a key should fail this test rather than silently go undocumented.
  const inner = property(SandboxRuntimeConfigSchema, "_def");
  const object =
    property(property(inner, "schema"), "shape") ?? property(inner, "shape");
  assert.ok(
    typeof object === "object" && object !== null,
    "could not read the schema's shape",
  );

  const keys: string[] = [];
  for (const top of Object.keys(object)) {
    const nested = property(object, top);
    const nestedShape = property(property(nested, "_def"), "schema") ?? nested;
    const nestedKeys = property(nestedShape, "shape");
    if (top === "network" || top === "filesystem") {
      assert.ok(
        typeof nestedKeys === "object" && nestedKeys !== null,
        `no shape for ${top}`,
      );
      for (const key of Object.keys(nestedKeys)) keys.push(`${top}.${key}`);
      continue;
    }
    keys.push(top);
  }
  return keys.sort();
}

/** The key names in the README's config table, between its markers. */
function documentedKeys(): string[] {
  const start = readme.indexOf("<!-- config-keys:start -->");
  const end = readme.indexOf("<!-- config-keys:end -->");
  assert.ok(
    start !== -1 && end > start,
    "README.md needs its config-keys markers",
  );
  const table = readme.slice(start, end);

  const keys: string[] = [];
  for (const line of table.split("\n")) {
    const cell = /^\|\s*`([^`]+)`/.exec(line.trim());
    if (cell?.[1] !== undefined) keys.push(cell[1]);
  }
  return keys.sort();
}

test("the README's example config loads as a real config", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "guard-readme-"));
  const cwd = mkdtempSync(join(tmpdir(), "guard-readme-project-"));
  writeFileSync(
    join(agentDir, "sandbox.json"),
    fencedBlock(readme, "json"),
    "utf-8",
  );

  const config = loadGuardConfig({ agentDir, cwd });

  assert.equal(config.enabled, true);
  assert.deepEqual(
    config.ignoredKeys,
    [],
    "the example must not carry keys the guard ignores",
  );
  assert.ok(
    config.policy.denyRead.length > 0,
    "the example must deny reads somewhere, or it teaches a config nobody should copy",
  );
  const caseInsensitive = config.policy.denyRead.join(" ");
  assert.match(
    caseInsensitive,
    /Users|home/,
    "the example should deny the home root, which is what the OS fence defaults to",
  );
});

test("the README documents every config key, and no key the runtime rejects", () => {
  const expected = [...acceptedKeys(), ...GUARD_KEYS].sort();

  assert.deepEqual(documentedKeys(), expected);
});
