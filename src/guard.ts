import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import {
  createToolInventory,
  type Access,
  type ToolCallLike,
  type ToolOverride,
} from "./claims.ts";
import {
  canonicalizeAgainst,
  canonicalizeClaims,
  compilePathPolicy,
  domainIsAllowed,
  extractDomainsFromCommand,
  pathIsWithin,
  type CanonicalClaim,
  type Refusal,
} from "./policy.ts";

export type { ToolCallLike } from "./claims.ts";

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
  /**
   * The live Tool inventory (pi's `getAllTools()`), read per call so a Tool another package
   * registers mid-session is judged like any other rather than refused as `unmapped`.
   */
  tools: () => readonly ToolInfo[];
  overrides: Record<string, ToolOverride>;
  cwd: string;
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
  /** Admit one path for the rest of the session. A glob is refused: a grant is a path, not a pattern. */
  grantPath(path: string): GrantResult;
  /** Admit every path touched by one Tool for the rest of the session. */
  grantTool(toolName: string): void;
  /** What the session has opened, for the user to inspect. */
  grants(): { paths: string[]; tools: string[] };
}

export type GrantResult =
  { granted: true; path: string } | { granted: false; reason: string };

/** A call the guard could not judge, whatever the cause. */
export type Unjudgeable =
  { kind: "unmapped" } | { kind: "malformed-claim"; claim: CanonicalClaim };

/**
 * The one fail-closed outcome for a call the guard could not judge.
 *
 * The cause is carried as a token, so prose can differ per cause and a new cause is additive. An
 * `unmapped` call is a user problem with a user remedy; a `malformed-claim` is a programmer error the
 * canonical-claim brand should have made unrepresentable, so it gets no tutorial prose.
 */
export function unjudgeableDecision(
  cause: Unjudgeable,
  toolName: string,
): GuardDecision {
  if (cause.kind === "unmapped") {
    return {
      block: true,
      reason: `Guard refused tool "${toolName}": no path in this call could be judged against the guard policy. Declare the Tool in the guard's \`tools\` config with its path fields and access.`,
    };
  }
  return {
    block: true,
    reason: `Guard refused tool "${toolName}": the call produced a claim the guard could not judge.`,
  };
}

/** The prose for a structured refusal. The wording lives with the presentation, not the path policy. */
function refusalReason(
  refusal: Exclude<Refusal, { rule: "malformed-claim" }>,
): string {
  switch (refusal.rule) {
    case "denyRead":
      return "it falls inside a denyRead region";
    case "denyWrite":
      return "it falls inside a denyWrite region";
    case "allowWrite":
      return "it is not in allowWrite";
  }
}

/**
 * The refusal prose for one refused access.
 *
 * For an inferred claim it also shows the declaration to add, using the field names introspection
 * already found, so the refusal teaches the one-line fix.
 */
function refusalMessage(
  claim: CanonicalClaim,
  toolName: string,
  access: Access,
  refusal: Exclude<Refusal, { rule: "malformed-claim" }>,
): string {
  const grant = `Grant it for this session with /guard-allow ${claim.path}`;
  const refused = `Guard refused ${access} of "${claim.path}" by tool "${toolName}": ${refusalReason(refusal)}`;
  if (claim.basis !== "inferred") return `${refused}. ${grant}`;
  const fields = (claim.fields ?? []).map((field) => `"${field}"`).join(", ");
  return `${refused}. Its access was inferred, not declared: declare it in the guard's \`tools\` config as {"fields": [${fields}]} with access "read" or "write". ${grant}`;
}

/** The first domain a command names that the guard policy does not allow, if any. */
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
  const inventory = createToolInventory({ tools, overrides, cwd });
  // Built once: judging a claim must not re-canonicalize the patterns or touch the filesystem.
  const judge = compilePathPolicy(policy, cwd);
  const grantedPaths = new Set<string>();
  const grantedTools = new Set<string>();

  const isGranted = (claim: CanonicalClaim): boolean =>
    [...grantedPaths].some((granted) => pathIsWithin(claim.path, granted));

  const guard = (event: ToolCallLike): GuardDecision => {
    if (grantedTools.has(event.toolName)) return {};

    const mapped = inventory.touches({
      toolName: event.toolName,
      input: event.input,
    });

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
      return unjudgeableDecision({ kind: "unmapped" }, event.toolName);
    }

    if (mapped.kind !== "claims") return {};

    for (const claim of canonicalizeClaims(mapped.claims, cwd)) {
      if (isGranted(claim)) continue;

      // An inferred claim must satisfy both rule sets; a declared one is judged by its own alone.
      const accesses: readonly Access[] =
        claim.basis === "inferred" ? ["read", "write"] : [claim.access];
      const refusals: {
        access: Access;
        refusal: Exclude<Refusal, { rule: "malformed-claim" }>;
      }[] = [];
      for (const access of accesses) {
        const refusal = judge({ ...claim, access });
        if (refusal === undefined) continue;
        if (refusal.rule === "malformed-claim") {
          return unjudgeableDecision(
            { kind: "malformed-claim", claim: refusal.claim },
            event.toolName,
          );
        }
        refusals.push({ access, refusal });
      }
      if (refusals.length === 0) continue;

      // When both rule sets refuse, report the read reason: it is the substantive finding on the
      // default-open side. Either refusal is enough to block.
      const refusal =
        refusals.find((entry) => entry.access === "read") ?? refusals[0];
      if (refusal === undefined) continue;
      return {
        block: true,
        reason: refusalMessage(
          claim,
          event.toolName,
          refusal.access,
          refusal.refusal,
        ),
      };
    }

    return {};
  };

  guard.grantPath = (path: string): GrantResult => {
    // A grant is a path, not a pattern: matching it by the pattern engine let a glob silently cover
    // less than the user believed, so refuse it loudly instead.
    if (path.includes("*")) {
      return {
        granted: false,
        reason: `"${path}" is a pattern, and a session grant is a path. Grant the directory it is meant to cover instead.`,
      };
    }
    // Resolved against the session's cwd and canonicalized once, here; lookup only compares forms.
    const canonical = canonicalizeAgainst(path, cwd);
    grantedPaths.add(canonical);
    return { granted: true, path: canonical };
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
