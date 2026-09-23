---
status: accepted
---

# Network access is outside the guard's policy

The guard fences the filesystem and nothing else. `loadGuardConfig` strips every `network` key that
takes effect through the runtime's network proxy — the domain lists, the resolved-address deny list,
`strictAllowlist`, and the proxy blocks — before handing the config to `SandboxManager.initialize`.
The runtime enables its network layer only when `network.allowedDomains` is present
(`sandbox-manager.js`: `needsNetworkRestriction = hasNetworkConfig`, where `hasNetworkConfig` tests
`allowedDomains !== undefined`), so an absent list means no proxy starts and shell commands reach the
network unrestricted. The stripped keys are reported at session start as ignored, matching how the
predecessor's keys are handled, so a config that still lists them keeps loading while the reader is
told they do nothing.

This reverses the guard's original spec (`.scratch/personal-srt-guard/spec.md`), which made network
access a command-level policy fed from the same domain lists — user story 27, the `bash`/`powershell`
row's "domain check for network", and the config-layering note that the domain lists are unioned.
The reversal was a deliberate decision by the repository owner. The guard judges Tool calls, and a
Tool that reaches the network from the pi process (a `fetch`-style Tool) does so regardless of any
command domain list; the same file declares network-touching Tools out of scope. A command-only
domain allow-list therefore blocks `bash` while the network-capable Tools beside it sail through —
a fence stricter than the boundary it claims to draw, refusing commands the agent can perform another
way. Rather than keep a half-fence, network access is dropped as a policy concern entirely.

## Considered Options

- **Keep the command-only domain allow-list.** It fences `bash` through the runtime's proxy but not
  the in-process Tools that can also reach the network, so it is both over- and under-inclusive.
- **Extend the domain list to non-shell Tools.** Would make the policy consistent, but requires a new
  domain-claim concept in the guard and a domain field on every network Tool; the owner chose not to.
- **Allow all with a broad domain pattern.** The runtime rejects `"*"` and `"*.tld"` on purpose, so
  there is no supported allow-all pattern; the only switch is the absent list this decision uses.

## Consequences

- `network.allowedDomains` and `network.deniedDomains` are no longer unioned across config layers or
  rewritten; they are read, reported, and removed. ADR-0001's statement that the two domain lists are
  not path patterns remains true — they are not paths, and they are not rewritten.
- Anything run through `bash` — including an untrusted build script — has unrestricted egress. The
  filesystem fence is the remaining boundary.
- The runtime is initialized with a config its own schema would reject (it requires
  `allowedDomains`), so the strip is a deliberate, documented cast. `SandboxManager.initialize`
  accepts the shape; the schema exists to validate file-borne config.
- Permissive local-IPC keys (`allowUnixSockets`, `allowAllUnixSockets`, `allowLocalBinding`,
  `allowMachLookup`) are grants rather than restrictions, and pass through untouched.
