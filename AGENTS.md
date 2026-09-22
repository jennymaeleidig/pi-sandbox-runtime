## Agent skills

- **Issue tracker**: local markdown under `.scratch/<feature-slug>/` — see `docs/agents/issue-tracker.md`
- **Domain docs**: single-context (`CONTEXT.md`, `docs/adr/`) — see `docs/agents/domain.md`
- **Formatting is a gate**: prettier is the lint step — run `npm run lint` (or `npm run format` to fix) and make sure it passes before committing. Nothing else enforces it, so unformatted code only gets caught here.
