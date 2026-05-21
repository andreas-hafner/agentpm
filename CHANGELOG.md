# Changelog

All notable user-facing changes to AgentPM should be recorded in this file.

This repo uses a simple release workflow:

- each release-facing cycle updates this changelog
- each release-facing cycle bumps the workspace package versions together
- changelog and version bumps should land in the same commit when practical

## [0.5.1] - 2026-05-21

### Changed

- `agentpm install --project` and `agentpm install --workspace` no longer create `agentpm.yaml` automatically when a repo has not opted into contract mode yet.
- `agentpm init` is now the explicit way to create `agentpm.yaml` from current local installs, while later project and workspace installs update the existing manifest automatically.
- Docs now distinguish local package-manager installs from manifest-backed repo sync workflows.
- Git-backed source installs and `agentpm push` now suppress raw Git progress output, show AgentPM-owned status messages instead, and reuse cached target checkouts across repeated pushes.

## [0.5.0] - 2026-05-19

### Added

- `agentpm source skills` (alias `agentpm source entries`) to list installable skills from a configured source or a direct repo locator, with optional `--target`, `--refresh`, and `--json` output.
- `agentpm install --from <source-or-repo>` to install directly from a configured source, GitHub shorthand, Git URL, SSH URL, or local folder without forcing a separate search step first.
- Interactive direct-repo install selection for multi-skill repositories, plus `--add-source` for explicit source persistence in non-interactive workflows.

### Changed

- Git source indexing now reuses the persistent checkout cache when possible, so `source add` followed by install no longer duplicates the remote checkout in the common Git-backed flow.
- CLI help and getting-started docs now show the smoother source-listing and direct-repo install workflow.
- `file://` repository locators are now treated as Git sources.
- Workspace package versions were aligned to `0.5.0`.

## [0.4.0] - 2026-05-18

### Added

- `agentpm search --refresh` to refresh configured source indexes before searching, plus stale-index guidance when normal search returns no matches.
- Push target default management with `agentpm target add --default`, `agentpm target default`, and interactive default selection during `agentpm push`.
- `agentpm cache clean --dry-run` to preview unused Git checkout cache removals.
- `agentpm doctor --fix` can now remove stale install records when generated skill folders were deleted outside AgentPM.

### Changed

- Plain `skills/<name>` generic sources now install into `.agents/skills/<name>` so synced project skills are immediately usable by `.agents` runtimes.
- Cache, help, doctor, and update CLI output now explains outcomes and next actions more clearly.
- Workspace package versions were aligned to `0.4.0`.

### Fixed

- `agentpm doctor` no longer reports a duplicate missing-cache error for an install whose target path is already missing.
- `agentpm update` now prints an explicit success summary after applying changes.

## [0.3.0] - 2026-05-18

### Added

- `agentpm refresh` and `agentpm update --refresh` to rebuild local source indexes from configured registry, Git, and local sources.
- Interactive `agentpm update` previews that ask for confirmation before applying available skill updates.
- `agentpm cache clean` to remove unused repository cache roots while preserving source indexes for search.
- `agentpm doctor --fix` safe-fix planning for unreachable unused sources, including a second confirmation before applying changes.
- Regression coverage for Git source refresh, commit-pinned installs, cache cleanup, doctor fixes, and push flows.

### Changed

- Git cache materialization now lives under `cache/repos/` for a more explicit cache layout.
- Workspace package versions were aligned to `0.3.0`.

### Fixed

- PNPM/Vitest push tests no longer fail from a `packages/core` runtime import of `simple-git`; core push now uses the existing Git command runner.

## [0.2.2] - 2026-05-17

### Added

- Contributor governance documents, PR template, security policy, changelog, and GitHub Sponsors funding metadata.
- A repo-local GodMode operating contract in `AGENTS.md` for governance preflight, role routing, validation gates, and release-impact reporting.

### Changed

- Repository governance now requires release-facing cycles to update both the changelog and workspace package versions.

## [0.2.1] - 2026-05-17

### Added

- Interactive multi-select for `agentpm push`, including select-all and select-none controls in TTY mode.

### Changed

- `agentpm push` now resolves local skills and agents by name or path, preserves native target-relative layout in the destination repository, and handles empty Git remotes correctly.
- Git-backed remote operations now use an interactive runner that works with SSH passphrase prompts and private remotes more reliably.

## [0.2.0] - 2026-05-17

### Added

- Push target management commands and project/global target configuration.
- Project-aware `agentpm.yaml` support with detailed skill objects, source binding, target selection, sync, resolve, and doctor coverage.
- Layered multi-source resolution across local folders, Git repositories, static registries, private registries, and SkillsHub.
- Smoke-test coverage for end-to-end CLI behavior and registry-backed project sync flows.

### Changed

- The CLI received a broader UX overhaul, including improved inspect, install, and push-oriented flows.
- Git push fallback support was added for non-Git local folders targeting Git remotes.
- Registry loading and compatibility handling expanded to cover newer adapter and target semantics.
- Package versions were aligned to `0.2.0` across the publishable workspace.

## [0.1.0] - 2026-05-10

### Added

- Initial AgentPM release with CLI commands, workspace packages, adapter detection, registry support, config handling, tests, docs, and CI.

### Changed

- SQLite storage was later migrated from `better-sqlite3` to built-in `node:sqlite` during the early `0.1.x` development cycle before the `0.2.0` version line.
