# pi-sandbox-runtime

A [pi](https://github.com/badlogic/pi-mono) package that puts **every Tool call and every shell
command** under one sandbox policy, driving
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)
directly.

It exists because the pi-sandbox extension it replaces guarded `bash` only. `grep`, `find` and `ls`
ran unchecked against the whole filesystem, and Tools contributed by other packages were never
judged at all — a formatter that rewrites files in place is neither `write` nor `edit`, so
`denyWrite` never saw it. This package closes both holes and leaves the shell fencing to the same
runtime.

## What it enforces

- **Every Tool call** is judged before it runs. Core Tools (`read`, `write`, `edit`, `grep`, `find`,
  `ls`, `bash`, `powershell`) are mapped to what they touch; Tools from other packages are read from
  their advertised parameter schema, so a Tool with a `path` argument is checked even though this
  package has never heard of it. When the guard cannot tell whether such a Tool reads or writes that
  path, it judges the claim against **both** the read and the write rules, and says so in the
  refusal; a session-start notice lists the Tools whose access was inferred, so a stricter-than-
  needed classification can be corrected with a `tools` entry. A Tool that only forwards its call to
  another Tool is declared as a **pass-through Tool**, and the nested call is judged in its place.
- **Shell commands** run inside the OS sandbox: macOS `sandbox-exec`, Linux `bwrap`, and the
  runtime's own Windows backend. The fence covers the filesystem only; network access is left
  unrestricted (see below).
- **Unknown Tools are refused**, not allowed. A Tool whose paths cannot be determined is a Tool whose
  access cannot be judged.
- **Fail closed.** An invalid config, a missing runtime dependency, an unsupported platform, or a
  sandbox that has not started all refuse the call with a message naming the reason.

## Install

Not published to npm yet, so install from a checkout or the git remote:

```sh
pi install /absolute/path/to/pi-sandbox-runtime
pi install git:git@github.com:jennymaeleidig/pi-sandbox-runtime
```

Requires Node >= 20.11.0. On Linux the runtime needs `ripgrep` (`rg`) as well as `bwrap` and
`socat`; macOS needs no extra tool. This package runs the runtime's dependency check before the
sandbox starts and refuses the session with the missing tool named.

## Configuration

Two files are read, and both may be absent:

| Scope   | Path                         |
| ------- | ---------------------------- |
| Global  | `~/.pi/agent/sandbox.json`   |
| Project | `<project>/.pi/sandbox.json` |

The project file is layered over the global one: scalars and individual `network` / `filesystem`
keys are replaced by the project's value, the four `filesystem` path lists are **unioned**, and the
`tools` map is merged per Tool name. That union is deliberate — a project file cannot silently drop
a global `denyRead` from either the guard or the OS fence. `enabled` is replace-not-merge, so a
project can switch the guard off for itself. A key the guard does not recognise is an error rather
than a shrug: a key you believe is protection but which is ignored is worse than no protection. Keys
it recognises but no longer honours are reported at session start instead of being silently dropped.

```json
{
  "enabled": true,
  "filesystem": {
    "denyRead": ["/Users", "/home"],
    "allowRead": ["."],
    "allowWrite": ["."],
    "denyWrite": [".env"]
  },
  "tools": {
    "format_md_tables": { "fields": ["path"], "access": "write" }
  }
}
```

That example is a working global config: it denies reads under the home root, re-allows the project
you are in, allows writes only there, and declares one third-party Tool. Two things are worth
knowing before you copy it:

- `allowRead` overrides `denyRead`, which is the opposite of how writes behave, and a more specific
  deny still wins over a broader allow. Reads default to **allowed** wherever no `denyRead` matches.
- If no config exists at all, the guard supplies `denyRead: ["/Users", "/home"]` and empty lists for
  everything else. Nothing is writable until you say so.
- The guard fences the **filesystem only**. It initializes the runtime without a domain allow-list,
  which is what leaves network access unrestricted, so no network proxy runs.
  `network.allowedDomains` and `network.deniedDomains` are read, reported as ignored, and stripped;
  the rest of the `network` block passes through untouched, because those keys (`allowUnixSockets`,
  `allowAllUnixSockets`, `allowLocalBinding`, `allowMachLookup`) grant local IPC access rather than
  restrict anything.

### Tools the guard must be told about

A `tools` entry takes one of two shapes. The first declares a Tool's own path fields and whether it
reads or writes them:

```json
{ "format_md_tables": { "fields": ["path"], "access": "write" } }
```

`access: "none"` (with no `fields`, or an empty list) is the deliberate way to say a Tool touches no
paths at all.

The second declares a **pass-through Tool** — one whose only work is to invoke another Tool, like
`@wolido/pi-lazy-tools`' `call_tool`. Name the fields that carry the target Tool's name and the
parameters forwarded to it, and the guard unwraps the call and judges the target:

```json
{
  "tools": {
    "call_tool": { "passThrough": { "tool": "tool", "params": "params" } }
  }
}
```

Without that declaration a pass-through Tool is refused like any other Tool the guard cannot judge:
its `params` bag is opaque, so nothing inside it is visible to schema introspection. Declaring it
`access: "none"` instead would silently wave through every path its target touches, which is the
hole this shape closes — if a config already declares it that way, replace the entry; the guard
cannot detect the false assertion for you. The target must itself be judgeable — declare it by its
path fields, or as another pass-through Tool; a pathless target takes
`{ "fields": [], "access": "none" }`.

## Every key

The `network` and `filesystem` sections are the runtime's schema; `enabled` and `tools` belong to
this package. Omitting an optional key leaves the runtime's own default in place. The guard fences
the filesystem only, so it strips every `network` key that acts through the runtime's network proxy
— the rows marked **Ignored** below — and reports them at session start. That proxy therefore never
runs, and network access is unrestricted. Permissive local-IPC keys (`allowUnixSockets`,
`allowAllUnixSockets`, `allowLocalBinding`, `allowMachLookup`) are grants rather than restrictions
and pass through untouched.

<!-- config-keys:start -->

| Key                               | Required                       | What it does                                                                                                                                                             |
| --------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                         | no, defaults to `true`         | This package's off switch for the whole guard.                                                                                                                           |
| `tools`                           | no                             | Per-Tool overrides: `{ "fields": ["path"], "access": "read" \| "write" \| "none" }`, or a pass-through Tool `{ "passThrough": { "tool": "tool", "params": "params" } }`. |
| `filesystem.denyRead`             | yes, defaults to the home root | Paths no Tool may read, unless `allowRead` re-allows them.                                                                                                               |
| `filesystem.allowRead`            | no                             | Paths re-allowed beneath a `denyRead` region.                                                                                                                            |
| `filesystem.allowWrite`           | yes, defaults to nothing       | The only paths any Tool may write.                                                                                                                                       |
| `filesystem.denyWrite`            | yes, defaults to nothing       | Paths denied even inside `allowWrite`.                                                                                                                                   |
| `filesystem.allowGitConfig`       | no                             | Permit reading `.git/config`, which is otherwise withheld.                                                                                                               |
| `filesystem.disabled`             | no                             | Turn the filesystem half of the sandbox off.                                                                                                                             |
| `network.allowedDomains`          | yes, defaults to nothing       | Domains commands may reach. **Ignored** — the guard fences filesystem only and leaves network access unrestricted.                                                       |
| `network.deniedDomains`           | yes, defaults to nothing       | Domains to block regardless. **Ignored**, like `network.allowedDomains`.                                                                                                 |
| `network.deniedDomainReasons`     | no                             | Explanations for specific denied domains. **Ignored** — the guard fences filesystem only.                                                                                |
| `network.strictAllowlist`         | no                             | Deny anything not explicitly allowed, rather than only what is resolved. **Ignored** — the guard runs no network proxy.                                                  |
| `network.deniedResolvedAddresses` | no                             | Addresses to block after resolution. **Ignored** — the guard runs no network proxy.                                                                                      |
| `network.allowUnixSockets`        | no                             | Unix socket paths commands may use.                                                                                                                                      |
| `network.allowAllUnixSockets`     | no                             | Skip the unix socket check entirely.                                                                                                                                     |
| `network.allowLocalBinding`       | no                             | Permit binding local ports.                                                                                                                                              |
| `network.allowMachLookup`         | no                             | macOS: additional Mach services to allow.                                                                                                                                |
| `network.httpProxyPort`           | no                             | Pin the HTTP proxy port instead of choosing one. **Ignored** — the guard runs no network proxy.                                                                          |
| `network.socksProxyPort`          | no                             | Pin the SOCKS proxy port instead of choosing one. **Ignored** — the guard runs no network proxy.                                                                         |
| `network.mitmProxy`               | no                             | Upstream's MITM proxy block; mutually exclusive with `tlsTerminate`. **Ignored** — the guard runs no network proxy.                                                      |
| `network.filterRequest`           | no                             | Request-filtering hook (upstream feature). **Ignored** — the guard runs no network proxy.                                                                                |
| `network.tlsTerminate`            | no                             | TLS termination block (upstream feature). **Ignored** — the guard runs no network proxy.                                                                                 |
| `network.parentProxy`             | no                             | Route the sandbox's proxies through an upstream proxy. **Ignored** — the guard runs no network proxy.                                                                    |
| `credentials`                     | no                             | Upstream's credential-masking block.                                                                                                                                     |
| `ripgrep`                         | no                             | Where to find `rg`, and how to run it.                                                                                                                                   |
| `ignoreViolations`                | no                             | Violations to log without failing the command.                                                                                                                           |
| `mandatoryDenySearchDepth`        | no                             | How deep the runtime searches to plant its deny markers.                                                                                                                 |
| `enableWeakerNestedSandbox`       | no                             | Relax the sandbox for running inside another one.                                                                                                                        |
| `enableWeakerNetworkIsolation`    | no                             | Relax network isolation.                                                                                                                                                 |
| `allowAppleEvents`                | no                             | macOS: permit Apple Events.                                                                                                                                              |
| `allowPty`                        | no                             | Permit pseudo-terminal allocation.                                                                                                                                       |
| `seccomp`                         | no                             | Linux: seccomp tuning block.                                                                                                                                             |
| `bwrapPath`                       | no                             | Linux: path to `bwrap`.                                                                                                                                                  |
| `socatPath`                       | no                             | Path to `socat`.                                                                                                                                                         |
| `javaAgentJarPath`                | no                             | Path to the JVM agent jar.                                                                                                                                               |
| `windows`                         | no                             | Windows: sandbox tuning block (upstream support is alpha).                                                                                                               |
| `git`                             | no                             | Git-specific allowances.                                                                                                                                                 |

<!-- config-keys:end -->

Keys the old prompt-based guard wrote, which this package recognises and **ignores**: it reports
them at session start rather than refusing to load, because they are known history rather than
typos.

| Ignored key                              | Replaced by                             |
| ---------------------------------------- | --------------------------------------- |
| `permissionPromptTimeoutSeconds`         | nothing — there is no permission prompt |
| `sandboxUserShell`                       | the session's shell                     |
| `allowBrowserProcess`                    | `network` keys                          |
| `network.allowUnauthenticatedSocksProxy` | `network.allowAllUnixSockets`           |
| `network.sshProxy`                       | `network.parentProxy`                   |

Network-policy keys are ignored for a different reason: they act only through a proxy this guard
does not run, so honouring them would be a fence that is not there. `network.allowedDomains`,
`network.deniedDomains`, `network.deniedDomainReasons`, `network.strictAllowlist`,
`network.deniedResolvedAddresses`, `network.httpProxyPort`, `network.socksProxyPort`,
`network.mitmProxy`, `network.tlsTerminate`, `network.parentProxy` and `network.filterRequest` are
read, reported at session start, and stripped before the runtime is initialized. Their values are
still schema-checked before stripping, so a wrongly typed ignored key is a load error rather than a
silent pass. Prune them — in particular, a `network.allowedDomains` you believed restricted egress
does nothing.

## Session commands

| Command                    | Effect                                                                 |
| -------------------------- | ---------------------------------------------------------------------- |
| `/guard`                   | Show the loaded policy, the config paths, and any grants this session. |
| `/guard-allow <path>`      | Grant a path for this session; the grant covers its children.          |
| `/guard-allow tool:<name>` | Grant a whole Tool for this session.                                   |

Grants live in memory only and disappear when the session ends — nothing is written back to your
config files. Start pi with `--no-guard` to bypass the guard entirely for one session.

## Development

```sh
npm test     # node --test
npm run check  # tsc --noEmit
npm run lint   # prettier --check
npm run format # prettier --write
```

## License

New code is CC0-1.0. The path canonicalization and glob matching, and the sandboxed shell wiring,
are adapted from `carderne/pi-sandbox` (MIT) and, upstream of it, `badlogic/pi-mono` (MIT); those
adaptations carry citation blocks naming the source, and `CITATION.cff` records the details.
`@anthropic-ai/sandbox-runtime` is Apache-2.0.
