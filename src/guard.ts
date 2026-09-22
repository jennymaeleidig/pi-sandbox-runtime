import { resolve } from "node:path";

import {
  canonicalClaims,
  mapToolCall,
  type Claim,
  type ToolOverride,
  type ToolSchema,
} from "./claims.ts";
import {
  canonicalizePath,
  domainIsAllowed,
  extractDomainsFromCommand,
  matchesPattern,
} from "./policy.ts";

export interface GuardPolicy {
  allowRead: string[];
  denyRead: string[];
  allowWrite: string[];
  denyWrite: string[];
  /** Domains commands may reach. An empty list allows none, matching the runtime's own default. */
  allowedDomains: string[];
  deniedDomains?: string[];
}

export interface GuardOptions {
  policy: GuardPolicy;
  /** The Tool inventory (pi's `getAllTools()`), used to introspect extension Tools. */
  tools: readonly ToolSchema[];
  overrides: Record<string, ToolOverride>;
  cwd: string;
}

export interface ToolCallLike {
  toolName: string;
  input: Record<string, unknown>;
}

export interface GuardDecision {
  block?: boolean;
  reason?: string;
}

/**
 * The guard: a `tool_call` handler that carries the session's grants.
 *
 * Grants are the escape hatch that replaces the predecessor's interactive prompt. They live in
 * memory only, so they last as long as the agent session and never become file state nobody
 * remembers granting.
 */
export interface Guard {
  (event: ToolCallLike): GuardDecision;
  /** Admit one path for the rest of the session. */
  grantPath(path: string): void;
  /** Admit every path touched by one Tool for the rest of the session. */
  grantTool(toolName: string): void;
  /** What the session has opened, for the user to inspect. */
  grants(): { paths: string[]; tools: string[] };
}

type Outcome = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether a `denyRead` pattern outranks an `allowRead` pattern that also matches.
 *
 * Upstream reads are deny-then-allow: `allowRead` takes precedence over `denyRead`, the opposite of
 * writes, but a denial aimed at particular files stays denied. So a wildcard deny always wins, while
 * a literal deny yields only to an allowance *beneath* the region it denies — `denyRead: ["/Users"]`
 * with `allowRead: ["."]` re-opens the working directory, but a deny naming a path deeper than the
 * allowance keeps it shut.
 */
function denyOutranksAllow(deny: string, allow: string): boolean {
  if (deny.includes("*")) return true;
  const denied = canonicalizePath(deny);
  const allowed = canonicalizePath(allow);
  return !(allowed === denied || allowed.startsWith(denied + "/"));
}

/**
 * The read rule, matching the OS fence: denied regions, re-opened by an allowance beneath them.
 *
 * A path that is merely writable is not readable — a read is judged by the read rules alone, so
 * being allowed to write somewhere never widens what can be read.
 */
function decideRead(path: string, policy: GuardPolicy): Outcome {
  const denies = policy.denyRead.filter((pattern) =>
    matchesPattern(path, [pattern]),
  );
  if (denies.length === 0) return { allowed: true };
  const allows = policy.allowRead.filter((pattern) =>
    matchesPattern(path, [pattern]),
  );
  const reAllowed = allows.some((allow) =>
    denies.every((deny) => !denyOutranksAllow(deny, allow)),
  );
  if (reAllowed) return { allowed: true };
  return { allowed: false, reason: "it falls inside a denyRead region" };
}

function decideWrite(path: string, policy: GuardPolicy): Outcome {
  if (matchesPattern(path, policy.denyWrite)) {
    return { allowed: false, reason: "it falls inside a denyWrite region" };
  }
  if (matchesPattern(path, policy.allowWrite)) return { allowed: true };
  return { allowed: false, reason: "it is not in allowWrite" };
}

function decideClaim(claim: Claim, policy: GuardPolicy): Outcome {
  return claim.access === "read"
    ? decideRead(claim.path, policy)
    : decideWrite(claim.path, policy);
}

/** The first domain a command names that the policy does not allow, if any. */
function refusedDomain(
  command: string,
  policy: GuardPolicy,
): string | undefined {
  for (const domain of extractDomainsFromCommand(command)) {
    if (domainIsAllowed(domain, policy.deniedDomains ?? [])) return domain;
    if (!domainIsAllowed(domain, policy.allowedDomains)) return domain;
  }
  return undefined;
}

/**
 * Build the `tool_call` handler: the guard's single seam.
 *
 * Pure with respect to pi — it takes a Tool call and returns a block/allow decision, so tests drive
 * it directly with synthetic events instead of booting an agent.
 */
export function createGuard(options: GuardOptions): Guard {
  const { policy, tools, overrides, cwd } = options;
  const grantedPaths = new Set<string>();
  const grantedTools = new Set<string>();

  const isGranted = (claim: Claim): boolean =>
    matchesPattern(claim.path, [...grantedPaths]);

  const guard = (event: ToolCallLike): GuardDecision => {
    if (grantedTools.has(event.toolName)) return {};

    const mapped = mapToolCall(
      event.toolName,
      event.input,
      tools,
      overrides,
      cwd,
    );

    if (mapped.kind === "command") {
      const domain = refusedDomain(mapped.command, policy);
      if (domain !== undefined) {
        return {
          block: true,
          reason: `Guard refused tool "${event.toolName}": network access to "${domain}" is not in allowedDomains`,
        };
      }
      // Filesystem access from a command is fenced by the OS, not by this handler.
      return {};
    }

    if (mapped.kind === "unmapped") {
      return {
        block: true,
        reason: `Guard refused tool "${event.toolName}": no path in this call could be judged against the policy. Declare the Tool in the guard's \`tools\` config with its path fields and access.`,
      };
    }

    if (mapped.kind !== "claims") return {};

    for (const claim of canonicalClaims(mapped.claims, cwd)) {
      if (isGranted(claim)) continue;
      const outcome = decideClaim(claim, policy);
      if (!outcome.allowed) {
        return {
          block: true,
          reason: `Guard refused ${claim.access} of "${claim.path}" by tool "${event.toolName}": ${outcome.reason}. Grant it for this session with /guard-allow ${claim.path}`,
        };
      }
    }

    return {};
  };

  guard.grantPath = (path: string): void => {
    // Resolved against the session's cwd and canonicalized, so a grant and the claim it excuses
    // are compared in the same form.
    grantedPaths.add(canonicalizePath(resolve(cwd, path)));
  };
  guard.grantTool = (toolName: string): void => {
    grantedTools.add(toolName);
  };
  guard.grants = (): { paths: string[]; tools: string[] } => ({
    paths: [...grantedPaths],
    tools: [...grantedTools],
  });

  return guard;
}
