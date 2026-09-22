import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export type Access = "read" | "write";

/** Whether a claim's access was declared by config or the core table, or inferred by introspection. */
export type AccessBasis = "declared" | "inferred";

/** The only part of a Tool's advertised schema the guard consumes; pi's `ToolInfo` satisfies it. */
export type ToolSchema = Pick<ToolInfo, "name"> & {
  parameters: { properties?: Record<string, { type?: unknown }> };
};

export interface Claim {
  path: string;
  access: Access;
  basis: AccessBasis;
  /** For an inferred claim, the path fields introspection found, for the refusal's declaration. */
  fields?: string[];
}

/** A Tool's declared path fields and access, from the guard's own config. */
export interface ToolOverride {
  fields: string[];
  access: Access | "none";
}

export type ClaimResult =
  | { kind: "claims"; claims: Claim[] }
  | { kind: "command"; command: string }
  | { kind: "none" }
  | { kind: "unmapped" };

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
type ToolKind = "command" | "paths";

// pi's `ToolName` union (`dist/core/tools/index.d.ts:23`), which the package does not re-export from
// its root. A new core Tool added upstream should surface here, and the matching table row below is
// the one edit it then needs.
type CoreToolName =
  "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls";

const TOOL_KINDS = {
  bash: "command",
  powershell: "command",
  read: "paths",
  write: "paths",
  edit: "paths",
  grep: "paths",
  find: "paths",
  ls: "paths",
} as const satisfies Record<CoreToolName, ToolKind>;

function coreToolKind(toolName: string): ToolKind | undefined {
  const kinds: Record<string, ToolKind | undefined> = TOOL_KINDS;
  return kinds[toolName];
}

/** Whether this Tool's access only the OS fence can enforce, so it needs a live sandbox. */
export function needsLiveFence(toolName: string): boolean {
  return coreToolKind(toolName) === "command";
}

const WRITE_TOOLS = new Set(["write", "edit"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** Tools whose `path` is optional, defaulting to the working directory. */
const OPTIONAL_PATH_TOOLS = new Set(["grep", "find", "ls"]);

/** Path-ish field names used when introspecting a Tool's own parameter schema. */
const PATH_FIELD_NAMES = ["path", "file", "files", "dir", "directory", "root"];

function pathFieldsFromOverride(
  input: Record<string, unknown>,
  fields: string[],
): Claim[] {
  const claims: Claim[] = [];
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string" && value.length > 0)
      claims.push({ path: value, access: "read", basis: "declared" });
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.length > 0)
          claims.push({ path: entry, access: "read", basis: "declared" });
      }
    }
  }
  return claims;
}

function stringFieldNames(tool: ToolSchema): string[] {
  const properties = tool.parameters.properties;
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
 * Map a Tool call to the paths it touches.
 *
 * Precedence: command Tools first (a `tools` override must never be able to turn the fence's
 * network check off), then an explicit config entry, then a known core Tool, then the Tool's own
 * advertised parameter schema. Anything left over is `unmapped` and the guard refuses it.
 *
 * Introspection discovers *which* fields are paths; it does not guess whether the Tool reads or
 * writes them, because that is semantic and not derivable from a name. Such a claim is marked
 * inferred and the guard judges it against both rule sets.
 */
function mapToolCall(
  toolName: string,
  input: Record<string, unknown>,
  tools: readonly ToolSchema[],
  overrides: Record<string, ToolOverride>,
  cwd: string,
): ClaimResult {
  if (needsLiveFence(toolName)) {
    const command = input["command"];
    return {
      kind: "command",
      command: typeof command === "string" ? command : "",
    };
  }

  const override = overrides[toolName];
  if (override !== undefined) {
    const access = override.access;
    if (access === "none") return { kind: "none" };
    const claims = pathFieldsFromOverride(input, override.fields).map(
      (claim) => ({
        path: claim.path,
        access,
        basis: "declared" as const,
      }),
    );
    return claims.length > 0 ? { kind: "claims", claims } : { kind: "none" };
  }

  if (WRITE_TOOLS.has(toolName) || READ_TOOLS.has(toolName)) {
    const access: Access = WRITE_TOOLS.has(toolName) ? "write" : "read";
    const raw = input["path"];
    const path = typeof raw === "string" && raw.length > 0 ? raw : undefined;
    // Only the listing Tools default to the working directory. `read`, `write` and `edit` require a
    // path, so a call without one is refused rather than judged against a guess.
    if (path === undefined) {
      return OPTIONAL_PATH_TOOLS.has(toolName)
        ? {
            kind: "claims",
            claims: [{ path: cwd, access, basis: "declared" }],
          }
        : { kind: "unmapped" };
    }
    return {
      kind: "claims",
      claims: [{ path, access, basis: "declared" }],
    };
  }

  const tool = tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) return { kind: "unmapped" };

  const fields = stringFieldNames(tool);
  if (fields.length === 0) return { kind: "unmapped" };

  const claims = pathFieldsFromOverride(input, fields).map((claim) => ({
    path: claim.path,
    // The access is unknown and stays unknown; `write` is only a conservative placeholder so a
    // code path that forgets the `inferred` basis still fails closed. The guard judges both.
    access: "write" as const,
    basis: "inferred" as const,
    fields,
  }));
  return claims.length > 0 ? { kind: "claims", claims } : { kind: "unmapped" };
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
  tools: readonly ToolSchema[],
  overrides: Record<string, ToolOverride>,
): InferredToolAccess[] {
  const inferred: InferredToolAccess[] = [];
  for (const tool of tools) {
    if (coreToolKind(tool.name) !== undefined) continue;
    if (overrides[tool.name] !== undefined) continue;
    const fields = stringFieldNames(tool);
    if (fields.length === 0) continue;
    inferred.push({ name: tool.name, fields });
  }
  return inferred;
}

export interface ToolInventoryDeps {
  /** The live Tool list, read per call so a Tool registered mid-session is judged, not refused. */
  tools: () => readonly ToolSchema[];
  overrides: Record<string, ToolOverride>;
  cwd: string;
}

export function createToolInventory(deps: ToolInventoryDeps): ToolInventory {
  return {
    touches: (call) =>
      mapToolCall(
        call.toolName,
        call.input,
        deps.tools(),
        deps.overrides,
        deps.cwd,
      ),
  };
}
