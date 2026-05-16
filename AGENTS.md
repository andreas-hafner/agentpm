PROJECT RULES

GOAL: Build and maintain AgentPM as a Git-native CLI for discovering, installing, updating, and removing AI skills and agent assets across local folders, Git repositories, and static registry indexes.

Architecture principles:

- Keep the CLI thin. Put reusable behavior in `packages/core` and specialized concerns in the dedicated packages.
- Prefer compatibility-first behavior over clever normalization. Preserve native repository layouts unless the command explicitly asks otherwise.
- Treat repositories and local folders as the source of truth. AgentPM manages metadata, cache state, links, and diagnostics around them.
- Prefer explicit confirmations for destructive or risky actions such as replacing existing links, remapping installs after layout changes, or pruning cache data.
- Keep modules small and composable. Add helpers instead of widening already-large files when behavior starts to branch.

Code and testing expectations:

- Keep the repo buildable and runnable after each meaningful change.
- Add or update tests with code changes. Cover adapters, install/update flows, manifest handling, and diagnostics when behavior changes.
- Validate CLI behavior manually for user-visible flows and automatically with Vitest for stable coverage.
- Use cross-platform path handling and avoid shell-specific assumptions in product code.
- Prefer primary sources when researching dependencies or platform behavior, and record key decisions in docs when they affect architecture.

Docs and summaries:

- Use `docs/summaries/README.md` and only the relevant `docs/summaries/*.md` files as the first-pass codebase index before reading large files.
- If a change affects a summarized module, update the matching summary in the same diff.
- Keep summaries short and structured with `Responsibility`, `Key Files`, `Entry Points`, `Dependencies`, and `Notes`.
- Write docs alongside code for new commands, config formats, adapter behaviors, and examples.

GitHub push gate:

- Ask `Ready to push to GitHub? (yes/no)` before any push.
- Never push on main without an explicit `yes`.

## Git safety

- Classify changes as major, minor, patch, or none.
- Do not start multi-agent parallel delivery in a greenfield repo until a repo-root `AGENTS.md` or equivalent local governance scaffold exists.
- Before editing `VERSION`, `CHANGELOG.md`, release notes, or change fragments, determine the repo's release law.
- Only update `[Unreleased]` when the repo explicitly uses that model for unreleased work.
- If the repo uses change fragments or release-managed versioning, follow that system instead of editing `VERSION` or `CHANGELOG.md` during normal feature work.
- Suggest Conventional Commit style titles when preparing commits.
- Never commit or push without explicit approval.
- Never force-push a shared branch.
- Never rewrite shared history.