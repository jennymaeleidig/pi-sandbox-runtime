import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalizeAgainst,
  compilePathPolicy,
  type CanonicalClaim,
  type CanonicalPath,
  type PathRegions,
} from "../src/policy.ts";

const root = mkdtempSync(join(tmpdir(), "policy-"));
const allowed = join(root, "allowed");
const denied = join(root, "denied");
mkdirSync(allowed);
mkdirSync(denied);

const emptyRules: PathRegions = {
  allowRead: [],
  denyRead: [],
  allowWrite: [],
  denyWrite: [],
};

function claim(
  path: string,
  access: "read" | "write",
  cwd: string = root,
): CanonicalClaim {
  return { path: canonicalizeAgainst(path, cwd), access, basis: "declared" };
}

test("allows a read that no denyRead pattern matches", () => {
  const judge = compilePathPolicy(emptyRules, root);

  assert.equal(judge(claim(join(allowed, "file.txt"), "read")), undefined);
});

test("refuses a read inside a denyRead region, carrying the region", () => {
  const judge = compilePathPolicy({ ...emptyRules, denyRead: [denied] }, root);

  const refusal = judge(claim(join(denied, "file.txt"), "read"));

  assert.equal(refusal?.rule, "denyRead");
  assert.deepEqual(
    refusal !== undefined && "regions" in refusal ? refusal.regions : [],
    [canonicalizeAgainst(denied, root)],
  );
});

test("re-opens a denied region where allowRead names a path beneath it", () => {
  const judge = compilePathPolicy(
    { ...emptyRules, denyRead: [root], allowRead: [allowed] },
    root,
  );

  assert.equal(judge(claim(join(allowed, "file.txt"), "read")), undefined);
  assert.equal(
    judge(claim(join(denied, "file.txt"), "read"))?.rule,
    "denyRead",
  );
});

test("a wildcard deny outranks a broader allowance beneath it", () => {
  const judge = compilePathPolicy(
    {
      ...emptyRules,
      denyRead: [join(denied, "*.env")],
      allowRead: [denied],
    },
    root,
  );

  assert.equal(judge(claim(join(denied, "x.env"), "read"))?.rule, "denyRead");
  assert.equal(judge(claim(join(denied, "notes.md"), "read")), undefined);
});

test("refuses a write that is not in allowWrite", () => {
  const judge = compilePathPolicy(emptyRules, root);

  assert.equal(
    judge(claim(join(allowed, "file.txt"), "write"))?.rule,
    "allowWrite",
  );
});

test("refuses a write by denyWrite ahead of allowWrite", () => {
  const judge = compilePathPolicy(
    { ...emptyRules, allowWrite: [allowed], denyWrite: [denied] },
    root,
  );

  const refusal = judge(claim(join(denied, "file.txt"), "write"));
  assert.equal(refusal?.rule, "denyWrite");
  assert.equal(
    refusal !== undefined && "region" in refusal ? refusal.region : "",
    canonicalizeAgainst(denied, root),
  );
});

test("resolves relative patterns against the session cwd, not the process's", () => {
  const sessionCwd = mkdtempSync(join(tmpdir(), "policy-cwd-"));
  const inside = join(sessionCwd, "inside");
  mkdirSync(inside);

  const judge = compilePathPolicy(
    { ...emptyRules, allowWrite: ["."] },
    sessionCwd,
  );

  assert.equal(
    judge(claim(join(inside, "file.txt"), "write", sessionCwd)),
    undefined,
  );
  assert.equal(
    judge(claim(join(allowed, "file.txt"), "write", sessionCwd))?.rule,
    "allowWrite",
  );
});

test("compiles the canonical form once, not per claim", () => {
  const base = mkdtempSync(join(tmpdir(), "policy-once-"));
  const targetA = join(base, "a");
  const targetB = join(base, "b");
  mkdirSync(targetA);
  mkdirSync(targetB);
  const link = join(base, "link");
  symlinkSync(targetA, link);

  const judge = compilePathPolicy({ ...emptyRules, allowWrite: [link] }, base);
  assert.equal(
    judge(claim(join(targetA, "file.txt"), "write", base)),
    undefined,
  );

  // Repointing the link does not move the already-compiled region.
  unlinkSync(link);
  symlinkSync(targetB, link);

  assert.equal(
    judge(claim(join(targetB, "file.txt"), "write", base))?.rule,
    "allowWrite",
  );
  assert.equal(
    judge(claim(join(targetA, "file.txt"), "write", base)),
    undefined,
  );
});

test("fails closed on a claim that was cast past the canonical brand", () => {
  const judge = compilePathPolicy(emptyRules, root);

  const refusal = judge({
    path: "relative/not-canonical" as CanonicalPath,
    access: "read",
    basis: "declared",
  });

  assert.equal(refusal?.rule, "malformed-claim");
});
