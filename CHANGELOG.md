# Changelog

All notable user-facing changes to AgentPM should be recorded in this file.

This repo uses a simple release workflow:

- each release-facing cycle updates this changelog
- each release-facing cycle bumps the workspace package versions together
- changelog and version bumps should land in the same commit when practical

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
