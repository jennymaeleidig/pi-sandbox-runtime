---
status: accepted
---

# An inferred Tool access must satisfy both rule sets

When the guard cannot know whether an extension Tool's path field is read or written, it judges that claim against **both** the read and the write rules, and refuses if either refuses. The Tool's access is inferred rather than guessed, the inference is never permissive, and the fact that an access was inferred is surfaced both in the refusal reason and in a session-start notice.

The alternative — keeping the Tool-name heuristic that read `lint`/`check`/`read`/`list` as read and `format`/`fix`/`write`/`create`/`edit` as write — fails open in one direction. A Tool named `show_diff_and_save` contains `show` and no write hint, so it was judged a **read**, and reads are default-open: it could write anywhere outside `denyRead`. Reading the name can only be wrong in the permissive direction, because the write rules are the closed side.

Declaring-or-refusing every undeclared Tool was considered and rejected: it contradicts user story 6 of `.scratch/personal-srt-guard/spec.md`, which asks for a newly installed package's Tools to be "guarded without me editing config first, so that the default is safe rather than safe-once-remembered". Inference keeps that property while removing the guess.

## Considered Options

- **Declare or refuse; no inference.** Rejected — reverses story 6, and makes the guard's coverage depend on remembering to configure it.
- **Treat unknown access as write.** Closes the fail-open and is simpler, but judges a read-only Tool by rules it was never meant to meet, which conflicts with story 5 ("a Tool that only reads a path to be refused when that path is not readable") and breaks the test that pins it.
- **Keep the read/write guess, and only surface it.** Rejected — surfacing a permissive misclassification does not prevent the write it permits.

## Consequences

- **Read-only extension Tools get stricter.** A Tool whose access is unknown can only touch paths inside `allowWrite`. Previously a read-hinted Tool could read anything outside `denyRead`. This is the intended tightening, and the remedy is to declare the Tool.
- **The refusal is the teaching surface, and it needs a second trigger.** A permissive misclassification can never be discovered by being refused, so the session-start notice is what makes story 7 ("so that I can correct a misclassification without patching code") reachable at all.
- **The spec is amended, not silently overridden.** The access rule in `.scratch/personal-srt-guard/spec.md` is superseded by this decision; its precedence order and discovery rule still stand. Implemented by `.scratch/deepen-guard-seams/issues/07-access-inference.md`.
