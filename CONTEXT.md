# pi-sandbox-runtime

A pi extension that fences shell commands through the operating system and judges every Tool call — including Tools contributed by other packages — against one policy.

## Language

**Tool**:
A capability pi offers the agent, declared with a name and a parameter schema.
_Avoid_: function, command

**Tool call**:
One request to run a Tool, carrying that Tool's name and the input it was given.
_Avoid_: invocation, tool use

**Tool inventory**:
The set of Tools pi offers at a given moment, including Tools contributed by other packages.
_Avoid_: tool list, registry, catalogue

**Tool kind**:
What a Tool call must be judged as — a command for the sandbox fence, or a set of claims for the guard. A Shell Tool's kind is what makes it a Shell Tool, rather than a separate list of names beside the table.
_Avoid_: category, tool type

**Claim**:
A path a Tool call touches, together with whether that call reads or writes it. One call may make several claims.
_Avoid_: path, target, access request

**Canonical claim**:
A claim whose path has been resolved to a real, absolute location, so that two claims naming the same place compare equal. Only canonical claims are judged, and the canonical form is produced once, by the guard's canonicalization step.
_Avoid_: resolved path, normalized path, real path

**Guard policy**:
The configured rules the guard enforces: which path regions may be read and written, and which domains may be reached.
_Avoid_: policy (ambiguous alone), rules

**Path policy**:
The guard policy's path regions in canonical form, so that a claim and the region that governs it are compared in one form.
_Avoid_: path rules

**Sandbox fence**:
The OS-level enforcement the sandbox runtime applies to a shell command's filesystem and network access.
_Avoid_: sandbox (ambiguous with the package), jail, container

**Shell Tool**:
A Tool whose filesystem and network access only the sandbox fence can enforce, so it needs a live fence to run at all.
_Avoid_: command Tool, bash

**Guard**:
The decision layer that judges a Tool call against the guard policy and the session's grants, and allows or blocks it.
_Avoid_: firewall, filter, interceptor, validator

**Grant**:
A path, or a whole Tool, that a session has opened by explicit command. It lasts only for that session, and covers the children of any path it names.
_Avoid_: permission, exception, allow-list entry

**Tool override**:
A configuration entry declaring a Tool's path fields and access — or, for a pass-through Tool, the
fields that carry its target — for a Tool the guard cannot judge by introspection.
_Avoid_: tool config, mapping

**Pass-through Tool**:
A Tool whose only work is to invoke another Tool, so a call to it must be judged as a call to the Tool
it names. The `tools` config entry names the two fields that carry the target's name and its
forwarded parameters; until it is declared, the Tool is refused like any other Tool the guard cannot
judge.
_Avoid_: wrapper, proxy, dispatcher

**Ignored key**:
A recognised configuration key from the predecessor package that this guard reports and does not honour.
_Avoid_: unknown key — a key that is not recognised at all is an error, not an ignored key
