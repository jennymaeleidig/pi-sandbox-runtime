---
status: accepted
---

# A pass-through Tool's call is judged, not waved through

Some Tools exist only to invoke another Tool. `@wolido/pi-lazy-tools` registers `call_tool`, whose
`execute` resolves the target from `pi.getAllTools()` and calls that Tool's `execute` directly. pi
fires one `tool_call` event — for `call_tool` — carrying an opaque `params` bag, so the nested,
path-bearing Tool runs with its claims unjudged. `load_tools`/`call_tool` are opaque to
introspection, and only an explicit `access: "none"` entry made the route usable, which is exactly
what made it silent.

The guard now knows a **pass-through Tool**: a `tools` entry of the form
`{ "passThrough": { "tool": "<field>", "params": "<field>" } }`. The inventory resolves the named
target against the live Tool inventory and maps the forwarded call through the same precedence a
direct call would take — command table, then override, then core Tool, then schema introspection.
The nested claims are what the guard judges; the outer call is only the envelope. An undeclared
pass-through Tool, a target the guard cannot judge, a missing target or non-object parameters, or a
chain longer than four forwards is `unmapped`, and therefore refused, as before.

Two facts forced this shape rather than an upstream fix. pi's `ExtensionAPI` exposes no way to
forward a Tool call through the pipeline (`registerTool` and the `tool_call` event are the whole
surface), so `pi-lazy-tools` cannot route `call_tool` through the event the guard listens to. And the
guard cannot recognise a pass-through Tool from its schema: `params` is `Record<string, unknown>`,
and guessing from a field named `tool` would be the name heuristic ADR-0002 already rejected. The
declaration is the only truthful source, and it is checked by the same fail-closed config parser as
every other override.

A forwarded call that lands on a Shell Tool is refused outright, ahead of any session grant. A
command's filesystem access is enforced by the OS fence, but the guard cannot confirm the fence wraps
a command the pass-through resolved and ran itself, so it will not wave one through on the strength
of the outer call's name — and a grant, which speaks to what a Tool touches under the path policy,
cannot change that.

## Considered Options

- **Refuse any Tool that re-invokes another Tool's `execute`.** Undetectable from a schema, so in
  practice it means refusing `call_tool` by name — either a hardcoded third-party dependency in the
  guard, or a policy toggle that converges on `access: "none"` for anyone who wants lazy tools.
- **Leave it to `access: "none"` and document the risk.** That is the status quo: a declaration that
  means "touches no paths" being used for a Tool that touches whichever paths its target names. A
  declaration whose meaning is a lie is the bug, not the documentation.
- **Recognise `call_tool` by name.** Couples the guard to one package's Tool name and fails open for
  the next pass-through Tool, while a config declaration covers both with no special case.

## Consequences

- **The `tools` map now has two entry shapes.** A pass-through entry must not also carry `fields` or
  `access`; the parser refuses the mixture rather than pick a winner.
- **A pass-through Tool's target must itself be judgeable.** Where the old workaround let an
  undeclared target run, it is now refused until the target is declared with its fields or as another
  pass-through Tool. This is the intended tightening: a pathless target is declared
  `{ "fields": [], "access": "none" }`, and a mid-chain pass-through Tool is declared in turn.
- **`access: "none"` on a pass-through Tool still fails open, and must be replaced.** The guard
  cannot check a declaration that asserts a Tool touches no paths, so an existing
  `call_tool: { "fields": [], "access": "none" }` keeps working and keeps the hole. That spelling is
  how the hole was made; a config still using it must be migrated to the `passThrough` shape, not
  merely left alone. The refusal prose and the README name the replacement, which is as far as a
  declarative guard can go without a schema it can read.
- **Recursion is bounded, not detected.** A chain of more than four forwards, or one that names
  itself, is refused as `unmapped`, naming the last target. The guard does not attempt cycle
  detection; a depth bound is the cheaper fail-closed rule and no legitimate lazy-tools chain
  approaches it.
- **A forwarded command is refused, not fenced.** The extension's live-fence gate only sees the outer
  `call_tool` name, and the pass-through runs the resolved Tool's own `execute`, so the registered
  sandboxed shell Tool is not the one that would run. Refusing is the only honest outcome.
