# AgentPM

[![License: MIT](https://img.shields.io/badge/License-MIT-0f766e.svg)](./LICENSE)
[![CI](https://github.com/travelhawk/agentpm/actions/workflows/ci.yml/badge.svg)](https://github.com/travelhawk/agentpm/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.5.1-2563eb.svg)](./apps/cli/package.json)

AgentPM is a Git-native CLI for discovering, installing, and updating AI skills from repos, folders, and registries without forcing teams into a new package format or flattening native layouts.

```bash
git clone https://github.com/travelhawk/agentpm.git
cd agentpm
pnpm install
pnpm run install:global
agentpm --help
```

AgentPM works in two modes: local installs stay local by default, while a committed `agentpm.yaml` turns a repo into a shared contract for reproducible skill sync. Generated skill folders, caches, symlinks, and credentials stay local.

## See it work

Install a skill from a source, then push it to a target repo in one short VHS walkthrough.

![AgentPM add and push demo](./docs/assets/agentpm-demo.gif)

## Features

- `agentpm.yaml` project contracts with string and detailed object `skills` entries
- Deterministic `agentpm sync` from configured sources in file order
- Public GitHub, private Git/SSH, local folder, static registry, and private HTTP registry sources
- Runtime targets for `codex`, `claude`, and `generic` native layouts
- Repository inspection for `.codex/skills`, `.codex.cloud/skills`, `.claude/agents`, `.agents/skills`, plain `skills`, and `subagents`
- Local source indexes rebuilt on `source add` and refreshed with `agentpm refresh` or `agentpm update --refresh`
- `agentpm source skills` to preview installable entries from a configured source or a direct repo locator
- Search hints when configured source indexes may be stale, with `agentpm search --refresh` for one-step refresh and search
- `agentpm install --from <repo-or-source>` for one-command repo install flows without a separate search step
- Runtime context resolution across global, project, and temporary layers without writing project runtime folders
- Diagnostics for malformed config, unavailable sources, missing generated targets, broken links, and tracked generated artifacts
- Interactive update previews for Git-backed installs, layout migration warnings, and local source drift checks
- Structured cache cleanup with `agentpm cache clean --dry-run` while preserving active install caches and the local search index

## Getting started

```bash
pnpm install
pnpm build
pnpm --filter agentpm exec agentpm --help
```

If you want a global command from this repository checkout, run:

```bash
pnpm run install:global
agentpm --help
```

If pnpm reports that no global bin directory is configured, run `pnpm setup`, restart your terminal, then run the global install command again.

## Project Config

Create and commit `agentpm.yaml` when you want a repository-level skill contract:

```yaml
sources:
  - id: internal
    locator: git@github.com:company/private-skills.git
  - id: public
    locator: github:agentpm/public-skills
  - id: registry
    locator: registry:https://registry.example.com/agentpm/index.yaml

skills:
  - nextjs-architecture

  - name: audio-mastering
    source: internal
    ref: v1.2.0
    target: codex
    scope: project
    items:
      - audio-mastering

  - name: shared-review
    source: registry
    target: generic
    scope: workspace
    workspaceRoot: ..
    items:
      - review/checklists
```

String entries are shorthand. Object entries bind a project skill to a configured source, optional Git ref or resolved revision, runtime target, install scope, and one or more native skill items. `target` selects a matching native layout; it does not transform one agent format into another. Accepted MVP targets are `codex`, `claude`, and `generic`.

Private Git sources use your existing SSH key or Git credential helper. Private HTTP registries use environment tokens such as `AGENTPM_REGISTRY_TOKEN` or `AGENTPM_REGISTRY_TOKEN_REGISTRY_EXAMPLE_COM`. Do not commit credentials to `agentpm.yaml`.

If `agentpm.yaml` is absent, `agentpm install --project` and `agentpm install --workspace` install locally without creating one. Run `agentpm init` to snapshot current local installs into `agentpm.yaml`. Once `agentpm.yaml` exists, future project or workspace installs update that repo contract automatically.

## Installation

You can install the CLI globally on your machine to use `agentpm` from anywhere.

From the root of this repository, use one of the following commands:

**For active development (Live Symlink)**:

```bash
pnpm run link:global
```

_This creates a global symlink. Any code changes will be instantly available in the global command after running `pnpm build`._

**For static installation**:

```bash
pnpm run install:global
```

_This installs a static copy of the CLI globally. You will need to run this command again to apply future updates._

## Smoke test

Run the local smoke test before publishing or handing the CLI to another machine:

```bash
pnpm smoke
```

The smoke test builds the workspace, runs the packaged `agentpm` bin with an isolated `AGENTPM_HOME`, inspects a Codex fixture repository, syncs a temporary project from a detailed registry-backed `agentpm.yaml`, verifies runtime resolution, checks local Git exclude handling, and runs `agentpm doctor`.

## Example commands

```bash
agentpm source add ./examples/repos/codex-sample
agentpm source skills github:company/private-skills
agentpm inspect ./examples/repos/codex-sample --skill audio-mastering --target codex
agentpm search audio --refresh
agentpm install --from github:company/private-skills --skill audio-mastering --project --add-source
agentpm install audio-mastering --project --target codex
agentpm resolve --temp release-helper
agentpm sync
agentpm refresh
agentpm update --refresh
agentpm diff
agentpm cache clean --dry-run
agentpm doctor --fix
agentpm target add production git@github.com:my-org/my-skills.git --default
agentpm push skill-a --to git@github.com:my-org/my-skills.git
agentpm push --all --to git@github.com:my-org/my-skills.git
```

## Git Push Flows

`agentpm push` is a skill push command, not a raw repository mirror.

- AgentPM detects pushable local entries from native layouts such as `.agents/skills`, `.codex/skills`, `.codex.cloud/skills`, `.claude/agents`, plain `skills/`, and `subagents/`.
- If you omit the name or path in a TTY session, AgentPM shows an interactive selector. Use Space to toggle, `a` to select all, `n` to select none, and Enter to confirm.
- If multiple push targets exist and none is marked `default`, `agentpm push` lets TTY users choose one and save it as the default. Non-interactive runs should pass `--to <target>` or set a default with `agentpm target default <id>`.
- Pushed entries keep their native target-relative path inside the destination repository. A Codex skill stays under `.codex/skills/...`, a generic skill stays under `.agents/skills/...`, and nested collections keep their subfolders.
- The target repository can be empty. AgentPM reuses a cached checkout for repeat pushes, copies the selected entries into place, commits, and pushes `HEAD`.
- Raw Git clone, commit, and push output stays hidden behind concise AgentPM status messages.

## Docs

- [Getting Started](./docs/getting-started.md)
- [Architecture](./docs/architecture.md)
- [Adapter Guide](./docs/adapter-guide.md)
- [Registry Guide](./docs/registry-guide.md)
- [Concept](./docs/concept.md)
- [Plan](./docs/plan.md)
- [Changelog](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)
- [Security Policy](./SECURITY.md)

## License

AgentPM is licensed under the MIT License. See [LICENSE](./LICENSE).
