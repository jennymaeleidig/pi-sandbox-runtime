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
  package has never heard of it.
- **Shell commands** run inside the OS sandbox: macOS `sandbox-exec`, Linux `bwrap`, with the network
  allowlist enforced through a proxy.
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

Requires Node >= 20.11.0. On macOS and Linux the runtime needs `ripgrep`, which this package checks
before the sandbox starts and reports plainly if it is missing.

## Configuration

Two files are read, and both may be absent:

| Scope   | Path                         |
| ------- | ---------------------------- |
| Global  | `~/.pi/agent/sandbox.json`   |
| Project | `<project>/.pi/sandbox.json` |

The project file is layered over the global one: scalars and the `network` / `filesystem` sections
are replaced, while the six path and domain lists are **unioned**, and the `tools` map is merged per
Tool name. That union is deliberate — a project file cannot silently drop a global `denyRead` from
either the guard or the OS fence. `enabled` is replace-not-merge, so a project can switch the guard
off for itself. A key the runtime does not recognise is an error rather than a shrug: a key you
believe is protection but which is ignored is worse than no protection.

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": ["github.com", "registry.npmjs.org"],
    "deniedDomains": []
  },
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
- `allowedDomains` must name real domains. `"*"` is rejected by the runtime, on purpose.

## Every key

The `network` and `filesystem` sections are the runtime's schema; `enabled` and `tools` belong to
this package. Omitting an optional key leaves the runtime's own default in place.

<!-- config-keys:start -->

| Key                               | Required                       | What it does                                                                         |
| --------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| `enabled`                         | no, defaults to `true`         | This package's off switch for the whole guard.                                       |
| `tools`                           | no                             | Per-Tool overrides: `{ "fields": ["path"], "access": "read" \| "write" \| "none" }`. |
| `filesystem.denyRead`             | yes, defaults to the home root | Paths no Tool may read, unless `allowRead` re-allows them.                           |
| `filesystem.allowRead`            | no                             | Paths re-allowed beneath a `denyRead` region.                                        |
| `filesystem.allowWrite`           | yes, defaults to nothing       | The only paths any Tool may write.                                                   |
| `filesystem.denyWrite`            | yes, defaults to nothing       | Paths denied even inside `allowWrite`.                                               |
| `filesystem.allowGitConfig`       | no                             | Permit reading `.git/config`, which is otherwise withheld.                           |
| `filesystem.disabled`             | no                             | Turn the filesystem half of the sandbox off.                                         |
| `network.allowedDomains`          | yes, defaults to nothing       | Domains commands may reach. Wildcards like `*.npmjs.org` are fine; `"*"` is not.     |
| `network.deniedDomains`           | yes, defaults to nothing       | Domains to block regardless.                                                         |
| `network.deniedDomainReasons`     | no                             | Explanations for specific denied domains.                                            |
| `network.strictAllowlist`         | no                             | Deny anything not explicitly allowed, rather than only what is resolved.             |
| `network.deniedResolvedAddresses` | no                             | Addresses to block after resolution.                                                 |
| `network.allowUnixSockets`        | no                             | Unix socket paths commands may use.                                                  |
| `network.allowAllUnixSockets`     | no                             | Skip the unix socket check entirely.                                                 |
| `network.allowLocalBinding`       | no                             | Permit binding local ports.                                                          |
| `network.allowMachLookup`         | no                             | macOS: additional Mach services to allow.                                            |
| `network.httpProxyPort`           | no                             | Pin the HTTP proxy port instead of choosing one.                                     |
| `network.socksProxyPort`          | no                             | Pin the SOCKS proxy port instead of choosing one.                                    |
| `network.mitmProxy`               | no                             | Upstream's MITM proxy block; mutually exclusive with `tlsTerminate`.                 |
| `network.filterRequest`           | no                             | Request-filtering hook (upstream feature).                                           |
| `network.tlsTerminate`            | no                             | TLS termination block (upstream feature).                                            |
| `network.parentProxy`             | no                             | Route the sandbox's proxies through an upstream proxy.                               |
| `credentials`                     | no                             | Upstream's credential-masking block.                                                 |
| `ripgrep`                         | no                             | Where to find `rg`, and how to run it.                                               |
| `ignoreViolations`                | no                             | Violations to log without failing the command.                                       |
| `mandatoryDenySearchDepth`        | no                             | How deep the runtime searches to plant its deny markers.                             |
| `enableWeakerNestedSandbox`       | no                             | Relax the sandbox for running inside another one.                                    |
| `enableWeakerNetworkIsolation`    | no                             | Relax network isolation.                                                             |
| `allowAppleEvents`                | no                             | macOS: permit Apple Events.                                                          |
| `allowPty`                        | no                             | Permit pseudo-terminal allocation.                                                   |
| `seccomp`                         | no                             | Linux: seccomp tuning block.                                                         |
| `bwrapPath`                       | no                             | Linux: path to `bwrap`.                                                              |
| `socatPath`                       | no                             | Path to `socat`.                                                                     |
| `javaAgentJarPath`                | no                             | Path to the JVM agent jar.                                                           |
| `windows`                         | no                             | Windows: sandbox tuning block (upstream support is alpha).                           |
| `git`                             | no                             | Git-specific allowances.                                                             |

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
