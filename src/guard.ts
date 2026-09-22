import {
  createToolInventory,
  type Claim,
  type ToolCallLike,
  type ToolOverride,
  type ToolSchema,
} from "./claims.ts";
import {
  canonicalizeAgainst,
  canonicalizeClaims,
  compilePathPolicy,
  domainIsAllowed,
  extractDomainsFromCommand,
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
   * The live Tool list (pi's `getAllTools()`), read per call so a Tool another package registers
   * mid-session is judged like any other rather than refused as `unmapped`.
   */
  tools: () => readonly ToolSchema[];
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
  /** Admit one path for the rest of the session. */
  grantPath(path: string): void;
  /** Admit every path touched by one Tool for the rest of the session. */
  grantTool(toolName: string): void;
  /** What the session has opened, for the user to inspect. */
  grants(): { paths: string[]; tools: string[] };
}

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
      reason: `Guard refused tool "${toolName}": no path in this call could be judged against the policy. Declare the Tool in the guard's \`tools\` config with its path fields and access.`,
    };
  }
  return {
    block: true,
    reason: `Guard refused tool "${toolName}": the call produced a claim the guard could not judge.`,
  };
}

/** The prose for a structured refusal. The wording lives with the presentation, not the policy. */
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

/** Whether a grant excuses a canonical claim: it names the claim, or a directory above it. */
function withinGrant(path: string, granted: string): boolean {
  const separator = granted.endsWith("/") ? "" : "/";
  return path === granted || path.startsWith(granted + separator);
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

  const isGranted = (claim: Claim): boolean =>
    [...grantedPaths].some((granted) => withinGrant(claim.path, granted));

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
      const refusal = judge(claim);
      if (refusal === undefined) continue;
      if (refusal.rule === "malformed-claim") {
        return unjudgeableDecision(
          { kind: "malformed-claim", claim: refusal.claim },
          event.toolName,
        );
      }
      return {
        block: true,
        reason: `Guard refused ${claim.access} of "${claim.path}" by tool "${event.toolName}": ${refusalReason(refusal)}. Grant it for this session with /guard-allow ${claim.path}`,
      };
    }

    return {};
  };

  guard.grantPath = (path: string): void => {
    // Resolved against the session's cwd and canonicalized, so a grant and the claim it excuses
    // are compared in the same form.
    grantedPaths.add(canonicalizeAgainst(path, cwd));
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
