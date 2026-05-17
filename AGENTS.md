PROJECT RULES

GOAL: Build and maintain AgentPM as a Git-native CLI for discovering, installing, updating, and removing AI skills and agent assets across local folders, Git repositories, and static registry indexes.

GodMode operating contract:

- For non-trivial work, prefer `godmode-workflow` as the default orchestration mode.
- Start with a governance preflight: inspect `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `.github/pull_request_template.md`, `CHANGELOG.md`, and any touched contract docs before planning changes.
- Frame non-trivial tasks with `Goal`, `Context`, `Constraints`, and `Done when` if the user has not already done so.
- The main thread is the orchestrator. Keep a single-writer model for code changes even when advisory agents are used.
- Use the smallest viable team:
  - `researcher` for repo discovery or source verification
  - `architect` for change shape, boundaries, and tradeoffs
  - `api_guardian` for CLI, config, schema, adapter, or user-visible contract changes
  - `builder` for implementation
  - `validator` and `tester` before final release output
  - `scribe` only after validation gates are green
- Use advisory department agents only when the task genuinely crosses runtime, workflow, governance, docs, or CI/security ownership.
- For long-running tasks, keep durable state in `state/` and generated handoff notes in `reports/generated/` when that will reduce re-discovery.
- If the workspace is missing repo-local governance, bootstrap it before parallel implementation.

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

Execution checkpoints:

- Report workspace root, branch, intended touched files, and expected impact before editing when the change is not trivial.
- Prefer repository-first evidence over assumptions. Re-verify old workflow notes, reports, and generated state against current code and docs.
- Keep implementation diffs scoped. Do not widen a task into opportunistic refactors.
- Run validation that matches the changed surface:
  - docs or governance only: targeted lint or consistency checks
  - package code: package-focused tests plus workspace checks when contracts move
  - CLI or user-facing flows: manual CLI validation plus automated coverage
- Before final handoff, state release impact as `none`, `patch`, `minor`, or `major`.

GitHub push gate:

- Ask `Ready to push to GitHub? (yes/no)` before any push.
- Never push on main without an explicit `yes`.

Release law:

- `CHANGELOG.md` is required and should reflect release-facing work already merged into the repo.
- Release-facing cycles should update `CHANGELOG.md` and bump workspace package versions together.
- Keep workspace package versions aligned unless the repo explicitly adopts independent versioning.
- If a cycle is split across multiple commits, keep the changelog section and the version bump in the same final release-facing commit when practical.
- Governance-only changes that affect contributor or release behavior still count as release-facing when they change how outside contributors work with the project.

## Git safety

- Classify changes as major, minor, patch, or none.
- Do not start multi-agent parallel delivery in a greenfield repo until a repo-root `AGENTS.md` or equivalent local governance scaffold exists.
- Before editing `VERSION`, `CHANGELOG.md`, release notes, or change fragments, determine the repo's release law.
- Only update `[Unreleased]` when the repo explicitly uses that model for unreleased work.
- If the repo uses change fragments or release-managed versioning, follow that system instead of editing `VERSION` or `CHANGELOG.md` during normal feature work.
- Suggest Conventional Commit style titles when preparing commits.
- Never commit blindly after a long run; verify `git diff`, release artifacts, and validation status first.
- Never push without explicit approval.
- Never force-push a shared branch.
- Never rewrite shared history.
