# Contributing

AgentPM is a Git-native CLI workspace built with pnpm workspaces and Turborepo.
Keep changes small, buildable, and aligned with the existing package split.

## Ground Rules

- Read [AGENTS.md](./AGENTS.md) first. It is the repo-local constitution.
- Keep the CLI thin. Put reusable behavior in `packages/core` or the dedicated package that owns it.
- Preserve native repository layouts. Do not normalize or rewrite external skill repositories unless the command explicitly requires it.
- Treat local folders and Git repositories as the source of truth. AgentPM manages metadata, cache state, links, and diagnostics around them.
- Use `docs/summaries/README.md` and the relevant summary file before opening large modules.

## Setup

```bash
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

For user-facing CLI work, also run:

```bash
pnpm smoke
```

## Change Scope

- Add or update tests with code changes.
- Update docs alongside new commands, config formats, adapter behavior, or push/sync flows.
- If you change a summarized module, update the matching file in `docs/summaries/`.
- Prefer cross-platform path handling and avoid shell-specific assumptions in product code.

## Release Law

AgentPM uses a checked-in [CHANGELOG.md](./CHANGELOG.md) plus aligned workspace package versions.

- Classify each change as `none`, `patch`, `minor`, or `major` in the PR description.
- Add short user-facing notes to `CHANGELOG.md` when behavior, CLI output, config contracts, compatibility, or release expectations change.
- Keep internal refactors, test-only changes, and purely local tooling edits out of the changelog unless they affect users or contributors directly.
- Bump all workspace package versions together for release-facing cycles. The CLI package and internal packages should stay aligned unless the repo deliberately adopts independent versioning later.
- Changelog entries and version bumps should land in the same commit when practical.
- Do not publish or tag from routine feature work unless the release task explicitly calls for it.

## Pull Requests

- Use a Conventional Commit style title when possible, for example `fix: preserve native push layout`.
- Include a short summary, touched areas, validation steps, and release impact.
- Call out risks around layout migration, cache state, private Git access, and compatibility changes.

## Git Safety

- Never force-push shared branches.
- Never rewrite shared history.
- Do not push to `main` without explicit approval from the repository owner.
