---
status: accepted
---

# Relative policy paths resolve against the session working directory

The guard's policy patterns and the OS fence must name one region, so `loadGuardConfig` rewrites relative filesystem patterns to absolute against the session working directory — the `cwd` it is already given — before the config is validated, leaving absolute and `~` patterns untouched. Only the four `filesystem.*` arrays are paths; `network.allowedDomains` and `network.deniedDomains` are domains and must never be rewritten.

The sandbox runtime accepts relative pattern spellings and resolves them against its own ambient `process.cwd()` (`sandbox-utils.js:391-398`), and `SandboxManager.initialize` takes no cwd (`sandbox-manager.js:445`). The guard, by contrast, resolves claims against the session cwd. The project inherited relative-path semantics from carderne/pi-sandbox v0.6.8, where they were benign because an unresolved write fell through to an interactive prompt; this guard replaced that prompt with a fail-closed policy, which makes the base load-bearing.

## Considered Options

- **Reject relative patterns and require absolute paths.** Unambiguous, but `.pi/sandbox.json` is project-local config and `"."` meaning "this project" is the README's documented example. Requiring absolute paths would make project configs machine-specific.
- **Keep `process.cwd()` semantics and document them.** Leaves two bases in the code, and the fence's base is the runtime process's, not the session's.
- **Canonicalize only the guard's copy of the policy.** Leaves the fence on `process.cwd()`, so the two can still disagree — the exact divergence this decision removes.

## Consequences

- The config layer rewrites patterns _before_ validating, which reads backwards until you know the fence cannot be told a cwd.
- The fence receives `path.resolve`-normalized patterns while the guard canonicalizes with `realpath` for its own matching. Both derive from the session cwd, so they name the same region; the guard's form is the stricter one, and the difference must stay deliberate.
- Same-change requirement: this lands with the guard's policy canonicalization, not after it. Split across two changes, the divergence lives in the gap.
