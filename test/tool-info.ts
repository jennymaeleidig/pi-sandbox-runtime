import type { ToolInfo } from "@earendil-works/pi-coding-agent";

/**
 * A Tool contributed by another pi-package, as pi advertises it via `getAllTools()`. Tests only
 * care about a Tool's name and path fields; the rest is the minimum `ToolInfo` requires.
 */
export function toolSchema(
  name: string,
  properties: Record<string, { type?: unknown }>,
): ToolInfo {
  return {
    name,
    description: "",
    parameters: { type: "object", properties } as ToolInfo["parameters"],
    promptGuidelines: [],
    sourceInfo: {
      path: `${name}.ts`,
      source: "test",
      scope: "temporary",
      origin: "top-level",
    },
  };
}
