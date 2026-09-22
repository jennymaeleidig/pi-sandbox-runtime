import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export type Access = "read" | "write";

/** The only part of a Tool's advertised schema the guard consumes; pi's `ToolInfo` satisfies it. */
export type ToolSchema = Pick<ToolInfo, "name"> & {
  parameters: { properties?: Record<string, { type?: unknown }> };
};

export interface Claim {
  path: string;
  access: Access;
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

/** Whether this Tool's access only the OS fence can enforce, so it needs a live sandbox. */
export function needsLiveFence(toolName: string): boolean {
  const kinds: Record<string, ToolKind | undefined> = TOOL_KINDS;
  return kinds[toolName] === "command";
}

const WRITE_TOOLS = new Set(["write", "edit"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** Tools whose `path` is optional, defaulting to the working directory. */
const OPTIONAL_PATH_TOOLS = new Set(["grep", "find", "ls"]);

/** Path-ish field names used when introspecting a Tool's own parameter schema. */
const PATH_FIELD_NAMES = ["path", "file", "files", "dir", "directory", "root"];

const WRITE_NAME_HINTS = [
  "format",
  "fix",
  "write",
  "create",
  "edit",
  "apply",
  "rewrite",
];
const READ_NAME_HINTS = [
  "lint",
  "check",
  "read",
  "list",
  "show",
  "scan",
  "analyze",
];

function pathFieldsFromOverride(
  input: Record<string, unknown>,
  fields: string[],
): Claim[] {
  const claims: Claim[] = [];
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string" && value.length > 0)
      claims.push({ path: value, access: "read" });
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.length > 0)
          claims.push({ path: entry, access: "read" });
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

function accessFromToolName(name: string): Access {
  const lower = name.toLowerCase();
  if (WRITE_NAME_HINTS.some((hint) => lower.includes(hint))) return "write";
  if (READ_NAME_HINTS.some((hint) => lower.includes(hint))) return "read";
  return "write";
}

/**
 * Map a Tool call to the paths it touches.
 *
 * Precedence: command Tools first (a `tools` override must never be able to turn the fence's
 * network check off), then an explicit config entry, then a known core Tool, then the Tool's own
 * advertised parameter schema. Anything left over is `unmapped` and the guard refuses it.
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
        ? { kind: "claims", claims: [{ path: cwd, access }] }
        : { kind: "unmapped" };
    }
    return { kind: "claims", claims: [{ path, access }] };
  }

  const tool = tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) return { kind: "unmapped" };

  const fields = stringFieldNames(tool);
  if (fields.length === 0) return { kind: "unmapped" };

  const access = accessFromToolName(toolName);
  const claims = pathFieldsFromOverride(input, fields).map((claim) => ({
    path: claim.path,
    access,
  }));
  return claims.length > 0 ? { kind: "claims", claims } : { kind: "unmapped" };
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
