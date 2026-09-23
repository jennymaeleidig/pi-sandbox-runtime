import type {
  BashToolCallEvent,
  EditToolCallEvent,
  FindToolCallEvent,
  GrepToolCallEvent,
  LsToolCallEvent,
  PowerShellToolCallEvent,
  ReadToolCallEvent,
  ToolInfo,
  WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";

export type Access = "read" | "write";

/** Whether a claim's access was declared by config or the core table, or inferred by introspection. */
export type AccessBasis = "declared" | "inferred";

export interface Claim {
  path: string;
  access: Access;
  basis: AccessBasis;
  /** For an inferred claim, the path fields introspection found, for the refusal's declaration. */
  fields?: string[];
}

/** A Tool's declared path fields and access, from the guard's own config. */
export interface PathToolOverride {
  fields: string[];
  access: Access | "none";
}

/**
 * A Tool declared to be a pass-through: it carries another Tool's name and that Tool's parameters in
 * the two named fields, and the guard judges the nested call instead of this one.
 */
export interface PassThroughToolOverride {
  passThrough: { tool: string; params: string };
}

export type ToolOverride = PathToolOverride | PassThroughToolOverride;

/** A call a pass-through Tool forwarded: which Tool forwarded it, and the target it named. */
export interface ForwardedCall {
  /** The pass-through Tool that forwarded the call. */
  forwardedBy: string;
  /** The Tool it named, when the call named one. */
  target?: string;
}

/** A call the guard could not judge, and the pass-through Tool that reached it, if any. */
export type UnjudgedCall = { kind: "unmapped"; forwarded?: ForwardedCall };

export type ClaimResult =
  | { kind: "claims"; claims: Claim[] }
  | { kind: "command"; command: string; forwarded?: ForwardedCall }
  | { kind: "none" }
  | UnjudgedCall;

/** A Tool call, as pi hands it to the guard. */
export interface ToolCallLike {
  toolName: string;
  input: Record<string, unknown>;
}

/** What a Tool call touches, behind one entry point. */
export interface ToolInventory {
  touches(call: ToolCallLike): ClaimResult;
}

/**
 * What a Tool call must be judged as.
 *
 * The single home of the Shell Tool fact: the guard judges a call by its kind, and the extension
 * asks `needsLiveFence` for the same fact. pi has no shell notion of its own, so only this table can
 * say which Tools are commands.
 */
type CoreToolFacts =
  | { kind: "command" }
  | { kind: "paths"; access: Access; pathRequired: boolean };

// pi does not re-export its `ToolName` union from the package root, but each core Tool's
// `tool_call` event type is exported and carries that Tool's literal name, so the union is derived
// from pi rather than copied. A core Tool pi adds or renames then fails this table's `satisfies`
// check at compile time, instead of silently falling through to introspection.
type CoreToolName =
  | BashToolCallEvent["toolName"]
  | PowerShellToolCallEvent["toolName"]
  | ReadToolCallEvent["toolName"]
  | EditToolCallEvent["toolName"]
  | WriteToolCallEvent["toolName"]
  | GrepToolCallEvent["toolName"]
  | FindToolCallEvent["toolName"]
  | LsToolCallEvent["toolName"];

const TOOL_FACTS = {
  bash: { kind: "command" },
  powershell: { kind: "command" },
  read: { kind: "paths", access: "read", pathRequired: true },
  write: { kind: "paths", access: "write", pathRequired: true },
  edit: { kind: "paths", access: "write", pathRequired: true },
  // The listing Tools default to the working directory when `path` is absent.
  grep: { kind: "paths", access: "read", pathRequired: false },
  find: { kind: "paths", access: "read", pathRequired: false },
  ls: { kind: "paths", access: "read", pathRequired: false },
} as const satisfies Record<CoreToolName, CoreToolFacts>;

function coreToolFacts(toolName: string): CoreToolFacts | undefined {
  const facts: Record<string, CoreToolFacts | undefined> = TOOL_FACTS;
  return facts[toolName];
}

/** Whether this Tool's access only the OS fence can enforce, so it needs a live sandbox. */
export function needsLiveFence(toolName: string): boolean {
  return coreToolFacts(toolName)?.kind === "command";
}

/** Path-ish field names used when introspecting a Tool's own parameter schema. */
const PATH_FIELD_NAMES = ["path", "file", "files", "dir", "directory", "root"];

/** The string values a declared or introspected set of path fields holds in one call. */
function pathValues(
  input: Record<string, unknown>,
  fields: string[],
): string[] {
  const paths: string[] = [];
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string" && value.length > 0) paths.push(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.length > 0) paths.push(entry);
      }
    }
  }
  return paths;
}

/**
 * pi types a Tool's `parameters` as an opaque schema, so this is the one place that reads its
 * `properties` bag. Everything else depends on the narrowed bag, not on pi's `TSchema`.
 */
function toolProperties(
  tool: ToolInfo,
): Record<string, { type?: unknown }> | undefined {
  const parameters: unknown = tool.parameters;
  if (typeof parameters !== "object" || parameters === null) return undefined;
  const properties = (parameters as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  return properties as Record<string, { type?: unknown }>;
}

function stringFieldNames(tool: ToolInfo): string[] {
  const properties = toolProperties(tool);
  if (properties === undefined) return [];
  return Object.entries(properties)
    .filter(([name, schema]) => {
      if (schema?.type !== "string" && schema?.type !== "array") return false;
      return PATH_FIELD_NAMES.some((candidate) =>
        name.toLowerCase().includes(candidate),
      );
    })
    .map(([name]) => name);
}

/**
 * How deep a pass-through chain may go before the guard gives up and refuses. A pass-through Tool
 * that names itself, directly or through another, would otherwise recurse forever.
 */
const MAX_FORWARD_DEPTH = 4;

/** Whether this override declares a pass-through rather than the Tool's own paths. */
function isPassThrough(
  override: ToolOverride,
): override is PassThroughToolOverride {
  return "passThrough" in override;
}

/** The refusal a pass-through Tool earns when the call it forwarded could not be judged. */
function unjudgedForward(forwardedBy: string, target?: string): ClaimResult {
  return {
    kind: "unmapped",
    forwarded: target === undefined ? { forwardedBy } : { forwardedBy, target },
  };
}

/**
 * Map a call a pass-through Tool forwarded to its target.
 *
 * The declaration names the fields; only the target Tool's own mapping decides the claims, so a
 * forwarded call is judged exactly as a direct call to that Tool would be. Any failure to resolve
 * the target or its parameters is `unmapped`, carrying the target when it is known so the refusal
 * can name what the user must declare.
 */
function mapForwardedCall(
  call: ToolCallLike,
  declaration: PassThroughToolOverride["passThrough"],
  deps: ToolInventoryDeps,
  depth: number,
): ClaimResult {
  const target = call.input[declaration.tool];
  if (typeof target !== "string" || target.length === 0) {
    return unjudgedForward(call.toolName);
  }
  const params = call.input[declaration.params];
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return unjudgedForward(call.toolName, target);
  }
  // Past the bound the guard stops following the chain, and names the last target so the refusal
  // still points at a Tool rather than at "a Tool you must declare".
  if (depth >= MAX_FORWARD_DEPTH) {
    return unjudgedForward(call.toolName, target);
  }
  const nested = mapToolCall(
    { toolName: target, input: params as Record<string, unknown> },
    deps,
    depth + 1,
  );
  // A command's provenance is carried so the guard can refuse it: the OS fence wraps the shell Tool
  // this package registers, not a command a pass-through resolved and ran itself.
  if (nested.kind === "command") {
    return nested.forwarded === undefined
      ? { ...nested, forwarded: { forwardedBy: call.toolName, target } }
      : nested;
  }
  // The inner cause is more specific than this one, so keep it; only a bare `unmapped` from the
  // target is attributed to the pass-through Tool that forwarded the call.
  if (nested.kind === "unmapped" && nested.forwarded === undefined) {
    return unjudgedForward(call.toolName, target);
  }
  return nested;
}

/**
 * Map a Tool call to the paths it touches.
 *
 * Precedence: command Tools first (a `tools` override must never be able to exempt a shell command
 * from the OS fence), then an explicit config entry, then a known core Tool, then the Tool's own
 * advertised parameter schema. Anything left over is `unmapped` and the guard refuses it.
 *
 * Introspection discovers *which* fields are paths; it does not guess whether the Tool reads or
 * writes them, because that is semantic and not derivable from a name. Such a claim is marked
 * inferred and the guard judges it against both rule sets.
 */
function mapToolCall(
  call: ToolCallLike,
  deps: ToolInventoryDeps,
  depth = 0,
): ClaimResult {
  const { toolName, input } = call;
  const { overrides, cwd } = deps;
  if (needsLiveFence(toolName)) {
    const command = input["command"];
    return {
      kind: "command",
      command: typeof command === "string" ? command : "",
    };
  }

  const override = overrides[toolName];
  if (override !== undefined) {
    if (isPassThrough(override)) {
      return mapForwardedCall(call, override.passThrough, deps, depth);
    }
    const access = override.access;
    if (access === "none") return { kind: "none" };
    const paths = pathValues(input, override.fields);
    // A declared override that yields nothing must not read as "touches no paths": only an explicit
    // `access: "none"` means that. Refusing keeps a misspelled field name from failing open.
    return paths.length > 0
      ? {
          kind: "claims",
          claims: paths.map((path) => ({
            path,
            access,
            basis: "declared" as const,
          })),
        }
      : { kind: "unmapped" };
  }

  const facts = coreToolFacts(toolName);
  if (facts?.kind === "paths") {
    const raw = input["path"];
    const path = typeof raw === "string" && raw.length > 0 ? raw : undefined;
    if (path === undefined) {
      if (facts.pathRequired) return { kind: "unmapped" };
      return {
        kind: "claims",
        claims: [{ path: cwd, access: facts.access, basis: "declared" }],
      };
    }
    return {
      kind: "claims",
      claims: [{ path, access: facts.access, basis: "declared" }],
    };
  }

  const tool = deps.tools().find((candidate) => candidate.name === toolName);
  if (tool === undefined) return { kind: "unmapped" };

  const fields = stringFieldNames(tool);
  if (fields.length === 0) return { kind: "unmapped" };

  const paths = pathValues(input, fields);
  if (paths.length === 0) return { kind: "unmapped" };
  return {
    kind: "claims",
    claims: paths.map((path) => ({
      path,
      // The access is unknown and stays unknown; `write` is only a conservative placeholder so a
      // code path that forgets the `inferred` basis still fails closed. The guard judges both.
      access: "write" as const,
      basis: "inferred" as const,
      fields,
    })),
  };
}

/** A Tool whose access the guard would have to infer, for the session-start notice. */
export interface InferredToolAccess {
  name: string;
  fields: string[];
}

/**
 * Every Tool whose access would be inferred: not a core Tool, not declared in config, and advertising
 * at least one path field. The session-start notice uses this to make a permissive misclassification
 * discoverable, which a refusal alone can never do.
 */
export function inferredToolAccesses(
  tools: readonly ToolInfo[],
  overrides: Record<string, ToolOverride>,
): InferredToolAccess[] {
  const inferred: InferredToolAccess[] = [];
  for (const tool of tools) {
    if (coreToolFacts(tool.name) !== undefined) continue;
    if (overrides[tool.name] !== undefined) continue;
    const fields = stringFieldNames(tool);
    if (fields.length === 0) continue;
    inferred.push({ name: tool.name, fields });
  }
  return inferred;
}

export interface ToolInventoryDeps {
  /** The live Tool inventory, read per call so a Tool registered mid-session is judged, not refused. */
  tools: () => readonly ToolInfo[];
  overrides: Record<string, ToolOverride>;
  cwd: string;
}

export function createToolInventory(deps: ToolInventoryDeps): ToolInventory {
  return {
    touches: (call) => mapToolCall(call, deps),
  };
}
