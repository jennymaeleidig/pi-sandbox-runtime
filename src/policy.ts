/**
 * Path canonicalization and glob matching.
 *
 * Citation: Chris Arderne — pi-sandbox (v0.6.8) [MIT]
 * Source: https://github.com/carderne/pi-sandbox/blob/v0.6.8/src/policy.ts
 * Accessed: 2026-09-22
 * Modified by jennymaeleidig on 2026-09-22 — adapted: kept path canonicalization and glob
 * matching; dropped the interactive write-permission and prompt machinery, which this guard
 * replaces with a fail-closed policy check.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export function expandPath(filePath: string): string {
  return resolve(filePath.replace(/^~(?=$|\/)/, homedir()));
}

/**
 * Resolve a path to its real location, following symlinks for the longest existing prefix so a
 * glob such as `~/.ssh/*` is judged under the real directory rather than as a literal.
 */
export function canonicalizePath(filePath: string): string {
  const absolutePath = expandPath(filePath);
  try {
    return realpathSync.native(absolutePath);
  } catch {
    const tail: string[] = [];
    let probe = absolutePath;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) return absolutePath;
      tail.unshift(basename(probe));
      probe = parent;
    }
    try {
      return resolve(realpathSync.native(probe), ...tail);
    } catch {
      return absolutePath;
    }
  }
}

export function matchesPattern(
  filePath: string,
  patterns: readonly string[],
): boolean {
  const absolutePath = canonicalizePath(filePath);
  return patterns.some((pattern) => {
    // Glob patterns are canonicalized too, so a glob under a symlinked directory (macOS `/var`
    // beside `/private/var`, say) names the same place as the path it is matched against.
    const absolutePattern = canonicalizePath(pattern);
    if (pattern.includes("*")) {
      const escaped = absolutePattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(absolutePath);
    }
    const separator = absolutePattern.endsWith("/") ? "" : "/";
    return (
      absolutePath === absolutePattern ||
      absolutePath.startsWith(absolutePattern + separator)
    );
  });
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
