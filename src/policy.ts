/**
 * Path canonicalization, glob matching, and the compiled path policy.
 *
 * Citation: Chris Arderne — pi-sandbox (v0.6.8) [MIT]
 * Source: https://github.com/carderne/pi-sandbox/blob/v0.6.8/src/policy.ts
 * Accessed: 2026-09-22
 * Modified by jennymaeleidig on 2026-09-22 — adapted: kept path canonicalization and glob
 * matching; dropped the interactive write-permission and prompt machinery, which this guard
 * replaces with a fail-closed policy check.
 * Modified by jennymaeleidig on 2026-09-22 — compiled the policy's path regions once, so judging a
 * claim does no canonicalization and no filesystem access, and moved the refusal into a structured
 * value the guard turns into prose.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import type { Access, AccessBasis, Claim } from "./claims.ts";

declare const canonicalPathBrand: unique symbol;

/**
 * A path the canonicalization step has resolved, so two claims naming the same place compare equal.
 * Produced only by {@link canonicalizePath} / {@link canonicalizeAgainst}; forgetting to canonicalize
 * is a compile error, and {@link compilePathPolicy} refuses a path that was cast past the brand.
 */
export type CanonicalPath = string & { readonly [canonicalPathBrand]: true };

export interface CanonicalClaim {
  path: CanonicalPath;
  access: Access;
  basis: AccessBasis;
  /** For an inferred claim, the path fields introspection found, for the refusal's declaration. */
  fields?: string[];
}

/** The path regions of the guard policy, without the domain lists. */
export interface PathRules {
  allowRead: string[];
  denyRead: string[];
  allowWrite: string[];
  denyWrite: string[];
}

/** Why a claim was refused. The guard owns the wording; this module owns the verdict. */
export type Refusal =
  | { rule: "denyWrite"; claim: CanonicalClaim; region: string }
  | { rule: "allowWrite"; claim: CanonicalClaim }
  | { rule: "denyRead"; claim: CanonicalClaim; regions: string[] }
  | { rule: "malformed-claim"; claim: CanonicalClaim };

const HOME_PREFIX = /^~(?=$|\/)/;

/** Whether a path is spelled `~` or `~/...`; `~user` is left alone. The one home of that rule. */
export function isHomeRelative(filePath: string): boolean {
  return HOME_PREFIX.test(filePath);
}

export function expandPath(filePath: string): string {
  return resolve(filePath.replace(HOME_PREFIX, homedir()));
}

/** Resolve a possibly-relative, possibly-`~` path against an explicit working directory. */
function toAbsolute(filePath: string, cwd: string): string {
  if (isHomeRelative(filePath)) return expandPath(filePath);
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

/**
 * Resolve a path to its real location, following symlinks for the longest existing prefix so a
 * glob such as `~/.ssh/*` is judged under the real directory rather than as a literal.
 */
export function canonicalizePath(filePath: string): CanonicalPath {
  const absolutePath = expandPath(filePath);
  try {
    return realpathSync.native(absolutePath) as CanonicalPath;
  } catch {
    const tail: string[] = [];
    let probe = absolutePath;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) return absolutePath as CanonicalPath;
      tail.unshift(basename(probe));
      probe = parent;
    }
    try {
      return resolve(realpathSync.native(probe), ...tail) as CanonicalPath;
    } catch {
      return absolutePath as CanonicalPath;
    }
  }
}

/** Canonicalize a path against the session's working directory, not the process's. */
export function canonicalizeAgainst(
  filePath: string,
  cwd: string,
): CanonicalPath {
  return canonicalizePath(toAbsolute(filePath, cwd));
}

/** The canonical form of a set of claims, produced once by the guard's canonicalization step. */
export function canonicalizeClaims(
  claims: readonly Claim[],
  cwd: string,
): CanonicalClaim[] {
  return claims.map((claim) => ({
    path: canonicalizeAgainst(claim.path, cwd),
    access: claim.access,
    basis: claim.basis,
    ...(claim.fields !== undefined ? { fields: claim.fields } : {}),
  }));
}

interface CompiledPattern {
  canonical: string;
  isGlob: boolean;
  regex: RegExp | null;
}

function compilePattern(pattern: string, cwd: string): CompiledPattern {
  const canonical = canonicalizeAgainst(pattern, cwd);
  if (pattern.includes("*")) {
    const escaped = canonical
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return { canonical, isGlob: true, regex: new RegExp(`^${escaped}$`) };
  }
  return { canonical, isGlob: false, regex: null };
}

function matches(path: string, pattern: CompiledPattern): boolean {
  if (pattern.regex !== null) return pattern.regex.test(path);
  const separator = pattern.canonical.endsWith("/") ? "" : "/";
  return (
    path === pattern.canonical || path.startsWith(pattern.canonical + separator)
  );
}

/**
 * Whether a `denyRead` pattern outranks an `allowRead` pattern that also matches.
 *
 * Upstream reads are deny-then-allow: `allowRead` takes precedence over `denyRead`, the opposite of
 * writes, but a denial aimed at particular files stays denied. So a wildcard deny always wins, while
 * a literal deny yields only to an allowance *beneath* the region it denies — `denyRead: ["/Users"]`
 * with `allowRead: ["."]` re-opens the working directory, but a deny naming a path deeper than the
 * allowance keeps it shut.
 */
function denyOutranksAllow(
  deny: CompiledPattern,
  allow: CompiledPattern,
): boolean {
  if (deny.isGlob) return true;
  return !(
    allow.canonical === deny.canonical ||
    allow.canonical.startsWith(deny.canonical + "/")
  );
}

/**
 * Compile the guard policy's path regions once, against the session working directory.
 *
 * The result is the judge: call it once per canonical claim, and it does no filesystem access and no
 * canonicalization. `undefined` means allowed.
 */
export function compilePathPolicy(
  rules: PathRules,
  cwd: string,
): (claim: CanonicalClaim) => Refusal | undefined {
  const allowRead = rules.allowRead.map((pattern) =>
    compilePattern(pattern, cwd),
  );
  const denyRead = rules.denyRead.map((pattern) =>
    compilePattern(pattern, cwd),
  );
  const allowWrite = rules.allowWrite.map((pattern) =>
    compilePattern(pattern, cwd),
  );
  const denyWrite = rules.denyWrite.map((pattern) =>
    compilePattern(pattern, cwd),
  );

  return (claim) => {
    // A caller that cast past the brand can hand us a path we never resolved; judging it would let
    // it fail to match a region and then be allowed by the read default-open, so refuse instead.
    if (!isAbsolute(claim.path)) return { rule: "malformed-claim", claim };

    if (claim.access === "read") {
      const denies = denyRead.filter((pattern) => matches(claim.path, pattern));
      if (denies.length === 0) return undefined;
      const allows = allowRead.filter((pattern) =>
        matches(claim.path, pattern),
      );
      const reAllowed = allows.some((allow) =>
        denies.every((deny) => !denyOutranksAllow(deny, allow)),
      );
      if (reAllowed) return undefined;
      return {
        rule: "denyRead",
        claim,
        regions: denies.map((deny) => deny.canonical),
      };
    }

    const deny = denyWrite.find((pattern) => matches(claim.path, pattern));
    if (deny !== undefined) {
      return { rule: "denyWrite", claim, region: deny.canonical };
    }
    if (allowWrite.some((pattern) => matches(claim.path, pattern))) {
      return undefined;
    }
    return { rule: "allowWrite", claim };
  };
}

const URL_PATTERN = /https?:\/\/([a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

/** Domains named by literal URLs in a command. */
export function extractDomainsFromCommand(command: string): string[] {
  const domains = new Set<string>();
  let match: RegExpExecArray | null;
  URL_PATTERN.lastIndex = 0;
  while ((match = URL_PATTERN.exec(command)) !== null) {
    if (match[1] !== undefined) domains.add(match[1]);
  }
  return [...domains];
}

export function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return domain === base || domain.endsWith("." + base);
  }
  return domain === pattern;
}

export function domainIsAllowed(
  domain: string,
  allowedDomains: readonly string[],
): boolean {
  return allowedDomains.some((pattern) =>
    domainMatchesPattern(domain, pattern),
  );
}
