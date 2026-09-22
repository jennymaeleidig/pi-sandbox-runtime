import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SandboxRuntimeConfigSchema,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

import type { ToolOverride } from "./claims.ts";
import type { GuardPolicy } from "./guard.ts";
import { canonicalizeAgainst, isHomeRelative } from "./policy.ts";

/** Config keys the guard owns rather than passing to the runtime. */
const GUARD_KEYS = new Set(["enabled", "tools"]);

/**
 * Keys from the prompt-era predecessor that this guard deliberately ignores.
 *
 * They are reported rather than silently dropped: the point of rejecting unknown keys is that a
 * typo must not masquerade as protection, and these are known, not typos.
 */
const LEGACY_KEYS = new Set([
  "permissionPromptTimeoutSeconds",
  "sandboxUserShell",
  "allowBrowserProcess",
  "network.allowUnauthenticatedSocksProxy",
  "network.sshProxy",
]);

/**
 * Fields the runtime requires but the predecessor's config files routinely omit.
 *
 * The empty lists are fail-closed on purpose: a config that omits `allowWrite` must not silently
 * gain write access to anything.
 */
const DEFAULTS: {
  denyRead: string[];
  allowedDomains: string[];
  deniedDomains: string[];
  allowWrite: string[];
  denyWrite: string[];
} = {
  denyRead: ["/Users", "/home"],
  allowedDomains: [],
  deniedDomains: [],
  allowWrite: [],
  denyWrite: [],
};

const ARRAY_KEYS = [
  "network.allowedDomains",
  "network.deniedDomains",
  "filesystem.allowRead",
  "filesystem.denyRead",
  "filesystem.allowWrite",
  "filesystem.denyWrite",
] as const;

/**
 * The path lists, whose relative spellings the guard and the OS fence would otherwise resolve
 * against different working directories. Domain lists must never be rewritten this way.
 */
const PATH_KEYS = [
  "filesystem.allowRead",
  "filesystem.denyRead",
  "filesystem.allowWrite",
  "filesystem.denyWrite",
] as const;

export interface GuardConfig {
  enabled: boolean;
  policy: GuardPolicy;
  overrides: Record<string, ToolOverride>;
  /** Recognised keys that were ignored; surfaced so the user can prune them. */
  ignoredKeys: string[];
  /** Where each config layer was read from, so `/guard` can report the paths it loaded. */
  configPaths: { global: string; project: string };
  /** The validated runtime config, ready to hand to `SandboxManager.initialize`. */
  runtime: SandboxRuntimeConfig;
}

type Json = Record<string, unknown>;

function isJsonObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigFile(path: string): Json {
  if (!existsSync(path)) return {};
  const contents = readFileSync(path, "utf-8");
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isJsonObject(parsed)) throw new Error("expected a JSON object");
    return parsed;
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function objectAt(config: Json, key: string): Json {
  const value = config[key];
  return isJsonObject(value) ? value : {};
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item): item is string => typeof item === "string")
    ? value
    : undefined;
}

function layerValue(config: Json, dotted: string): unknown {
  const [section, key] = dotted.split(".");
  if (section === undefined || key === undefined) return undefined;
  return objectAt(config, section)[key];
}

function withKey(target: Json, dotted: string, value: unknown): void {
  const [section, key] = dotted.split(".");
  if (section === undefined || key === undefined) return;
  objectAt(target, section)[key] = value;
}

/** The layers' path and domain lists, unioned so a project file adds to the global one. */
function unionList(
  globalConfig: Json,
  projectConfig: Json,
  dotted: string,
): string[] | undefined {
  const globalValue = stringArray(layerValue(globalConfig, dotted));
  const projectValue = stringArray(layerValue(projectConfig, dotted));
  if (globalValue === undefined && projectValue === undefined) return undefined;
  return [...new Set([...(globalValue ?? []), ...(projectValue ?? [])])];
}

/**
 * Layer the project config over the global one.
 *
 * Scalars and section objects are replaced; the six list keys are unioned. One merged object feeds
 * both the guard's policy and the runtime config, so the two layers cannot disagree about what is
 * allowed — a project file cannot quietly drop a global `denyRead` from the OS fence.
 */
function mergedConfig(globalConfig: Json, projectConfig: Json): Json {
  const merged: Json = { ...globalConfig, ...projectConfig };
  for (const section of ["network", "filesystem"] as const) {
    merged[section] = {
      ...objectAt(globalConfig, section),
      ...objectAt(projectConfig, section),
    };
  }
  for (const dotted of ARRAY_KEYS) {
    const union = unionList(globalConfig, projectConfig, dotted);
    if (union !== undefined) withKey(merged, dotted, union);
  }
  // The `tools` map layers per Tool: a project entry for one Tool must not delete the global entries
  // beside it, which is what the plain spread above would do.
  const tools = {
    ...objectAt(globalConfig, "tools"),
    ...objectAt(projectConfig, "tools"),
  };
  if (Object.keys(tools).length > 0) merged["tools"] = tools;
  return merged;
}

function topLevelKeys(parsed: SandboxRuntimeConfig): Set<string> {
  return new Set(Object.keys(parsed));
}

/** Keys the schema dropped, at the top level and one section deep. */
function droppedKeys(supplied: Json, parsed: SandboxRuntimeConfig): string[] {
  const dropped: string[] = [];
  const acceptedTop = topLevelKeys(parsed);
  for (const key of Object.keys(supplied)) {
    if (!acceptedTop.has(key)) dropped.push(key);
  }
  for (const section of ["network", "filesystem"] as const) {
    const suppliedSection = objectAt(supplied, section);
    const parsedSection: unknown = parsed[section];
    const accepted = new Set(
      isJsonObject(parsedSection) ? Object.keys(parsedSection) : [],
    );
    for (const key of Object.keys(suppliedSection)) {
      if (!accepted.has(key)) dropped.push(`${section}.${key}`);
    }
  }
  return dropped;
}

/**
 * A path pattern in the same canonical form the guard judges claims by.
 *
 * `~` is left for the runtime to expand itself, per ADR-0001. Every other pattern is realpath'd
 * over its longest existing prefix — not merely `path.resolve`-normalized — so that when a
 * component is a symlink the fence and the guard name the same region instead of two spellings of
 * it. Without this, a pattern under a symlinked root reached the fence lexically while the guard
 * matched claims canonicalized, so the fence could be the looser of the two.
 */
function canonicalPattern(pattern: string, cwd: string): string {
  if (isHomeRelative(pattern)) return pattern;
  return canonicalizeAgainst(pattern, cwd);
}

/**
 * Remove the guard/fence ambiguity: the runtime resolves relative path patterns against ambient
 * `process.cwd()`, while the guard resolves its claims against the session working directory.
 * Rewriting the path lists here means both name the same region. Domain lists are never touched.
 */
function absolutizePaths(config: Json, cwd: string): void {
  for (const dotted of PATH_KEYS) {
    const patterns = stringArray(layerValue(config, dotted));
    if (patterns === undefined) continue;
    withKey(
      config,
      dotted,
      patterns.map((pattern) => canonicalPattern(pattern, cwd)),
    );
  }
}

/** A `tools` map that is not a map of Tool names cannot be honoured, and must not be ignored. */
function assertToolsMapIsAnObject(config: Json, path: string): void {
  const tools = config["tools"];
  if (tools !== undefined && !isJsonObject(tools)) {
    throw new Error(
      `${path}: "tools" must be an object mapping Tool names to overrides`,
    );
  }
}

function toolsOverrides(config: Json): Record<string, ToolOverride> {
  const tools = objectAt(config, "tools");
  const overrides: Record<string, ToolOverride> = {};
  for (const [name, value] of Object.entries(tools)) {
    if (!isJsonObject(value)) {
      throw new Error(`sandbox.json: tools.${name} must be an object`);
    }
    const access = value["access"];
    if (access !== "read" && access !== "write" && access !== "none") {
      throw new Error(
        `sandbox.json: tools.${name}.access must be one of "read", "write", "none"`,
      );
    }
    // `access: "none"` says the Tool touches no paths, so it needs no fields: an absent `fields`
    // key is the documented spelling of that, alongside `fields: []`.
    const rawFields = value["fields"];
    const fields =
      rawFields === undefined && access === "none" ? [] : rawFields;
    if (!Array.isArray(fields) || !fields.every((f) => typeof f === "string")) {
      throw new Error(
        `sandbox.json: tools.${name}.fields must be an array of strings`,
      );
    }
    // An override that names no fields, yet declares an access, would be judged as touching no
    // paths and silently allowed — protection below even the name-heuristic default. "none" is the
    // only deliberate way to say a Tool touches no paths, so anything else here is a config error.
    if (access !== "none" && fields.length === 0) {
      throw new Error(
        `sandbox.json: tools.${name}.fields names no path fields; use access "none" if ${name} touches no paths`,
      );
    }
    overrides[name] = { fields, access };
  }
  return overrides;
}

/**
 * Load the guard's policy from the existing sandbox config files: the global file in the agent
 * directory, then the project file under `.pi/`, with project values layered over global ones.
 */
export function loadGuardConfig(paths: {
  agentDir: string;
  cwd: string;
}): GuardConfig {
  const globalPath = join(paths.agentDir, "sandbox.json");
  const projectPath = join(paths.cwd, ".pi", "sandbox.json");
  const globalConfig = readConfigFile(globalPath);
  const projectConfig = readConfigFile(projectPath);
  assertToolsMapIsAnObject(globalConfig, globalPath);
  assertToolsMapIsAnObject(projectConfig, projectPath);

  const supplied = mergedConfig(globalConfig, projectConfig);
  // Do this before the runtime schema is validated, so the guard policy and the runtime config are
  // read off the same absolutized object and cannot name different regions.
  absolutizePaths(supplied, paths.cwd);

  const suppliedNetwork = objectAt(supplied, "network");
  const suppliedFilesystem = objectAt(supplied, "filesystem");
  const runtimeCandidate: Json = {
    ...supplied,
    network: {
      allowedDomains: DEFAULTS.allowedDomains,
      deniedDomains: DEFAULTS.deniedDomains,
      ...suppliedNetwork,
    },
    filesystem: {
      denyRead: DEFAULTS.denyRead,
      allowWrite: DEFAULTS.allowWrite,
      denyWrite: DEFAULTS.denyWrite,
      ...suppliedFilesystem,
    },
  };

  const parsed = SandboxRuntimeConfigSchema.safeParse(runtimeCandidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `${globalPath} or ${projectPath} is not a valid sandbox config — ${issues}`,
    );
  }

  const dropped = droppedKeys(supplied, parsed.data);
  const unrecognised = dropped.filter(
    (key) => !GUARD_KEYS.has(key) && !LEGACY_KEYS.has(key),
  );
  if (unrecognised.length > 0) {
    throw new Error(
      `sandbox.json has unrecognised key(s): ${unrecognised.join(", ")}. ` +
        `A key the guard ignores is a path you may believe is protected, so this is refused.`,
    );
  }

  const enabled = supplied["enabled"] !== false;
  // One source of truth: the policy is read off the validated config, the same object the runtime
  // is initialized with, so the guard and the OS fence always agree.
  const filesystem = parsed.data.filesystem;
  const network = parsed.data.network;

  return {
    enabled,
    policy: {
      allowRead: filesystem.allowRead ?? [],
      denyRead: filesystem.denyRead,
      allowWrite: filesystem.allowWrite,
      denyWrite: filesystem.denyWrite,
      allowedDomains: network.allowedDomains ?? [],
      deniedDomains: network.deniedDomains ?? [],
    },
    overrides: toolsOverrides(supplied),
    ignoredKeys: dropped.filter((key) => LEGACY_KEYS.has(key)).sort(),
    configPaths: { global: globalPath, project: projectPath },
    runtime: parsed.data,
  };
}
