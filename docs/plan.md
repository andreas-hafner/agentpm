# AgentPM MVP Implementation Plan

## Summary

- Build a pnpm workspace + Turborepo monorepo with `apps/cli` and `packages/*`, using TypeScript and Node 24 LTS as the supported runtime.
- Use `Commander.js` for the CLI and keep `Ink` limited to interactive selection and confirmation flows.
- Route command behavior through `apps/cli -> packages/core -> {config, db, registry, git, adapters, fs, ui}`.
- Create the repo-level docs, summaries, examples, tests, and CI alongside the code.

## Key Changes

- `packages/shared`: domain types, identifiers, project config and manifest types, diff/diagnostic models, and shared helpers.
- `packages/config`: global config, committed `agentpm.yaml` loading/saving, optional `.agentpmrc` local override loading, plus AgentPM home path resolution.
- `packages/db`: SQLite schema, migrations, and repositories for sources, catalog entries, cache state, and installs.
- `packages/git`: Git URL handling, shallow sparse releases, remote HEAD resolution, and local Git revision helpers.
- `packages/registry`: static YAML/JSON registry index parsing and catalog entry normalization.
- `packages/adapters`: Generic, Codex, and Claude layout detection, compatibility scoring, install mapping, update validation, and removal validation.
- `packages/fs`: directory walking, signatures, tree diffing, and safe symlink or junction management.
- `packages/core`: orchestration for source, inspect, search, install, update, diff, remove, init, sync, list, and doctor.
- `packages/ui`: lightweight Ink prompts for interactive choice and risky confirmations.
- `apps/cli`: the `agentpm` binary and command wiring.

## Test Plan

- Unit test type-safe helpers, manifest parsing, registry parsing, adapter detection, target mapping, DB repositories, and file diff or link helpers.
- Integration test local Git repos and local folders for source add, inspect, selective install, `--all`, update detection, diff, remove, init, sync, and doctor.
- Add CLI smoke tests for help output and representative command flows.

## Assumptions

- Public and private registry support starts with static YAML/JSON indexes, plus supported API-backed public registry adapters.
- `agentpm.yaml` acts as the committed project setup config in v1. `.agentpmrc` is a local-only override or compatibility fallback.
- `sync` reconciles project and workspace installs only; global installs remain machine-local by default.
- Install scripts are detected and surfaced as warnings but are never auto-run in MVP.
