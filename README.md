# AgentPM

AgentPM is a Git-native CLI for discovering, installing, updating, and removing AI skills and agent assets from static registries, Git repositories, and local folders.

## MVP features

- Add, list, and remove sources
- Inspect repository layouts and compatible adapters
- Search configured remote entries and installed items
- Install native skill layouts globally, per project, or into a workspace root
- Selectively install individual items or whole collections
- Track installed revisions and compare updates
- Remove installs and optionally purge cache data
- Initialize and sync committed `agentpm.yaml` project manifests
- Resolve active global, project, and temporary runtime skill layers without writing project runtime folders
- Use Git, local folder, public registry, and private registry sources in deterministic project order
- Run diagnostics with `agentpm doctor`

## Getting started

```bash
pnpm install
pnpm build
pnpm --filter agentpm exec agentpm --help
```

## Install globally

After the package is published, install the CLI from the npm registry:

```bash
pnpm add --global agentpm
agentpm --help
```

The npm equivalent is:

```bash
npm install --global agentpm
agentpm --help
```

If pnpm reports that no global bin directory is configured, run `pnpm setup`, restart your terminal, then run the global install command again.

## Smoke test

Run the local smoke test before publishing or handing the CLI to another machine:

```bash
pnpm smoke
```

The smoke test builds the workspace, runs the packaged `agentpm` bin with an isolated `AGENTPM_HOME`, inspects the Codex fixture repository, syncs a temporary project from `agentpm.yaml`, verifies runtime resolution, checks local Git exclude handling, and runs `agentpm doctor`.

## Example commands

```bash
agentpm source add ./examples/repos/codex-sample
agentpm inspect ./examples/repos/codex-sample
agentpm search audio
agentpm install audio-mastering --project
agentpm resolve --temp release-helper
agentpm sync
agentpm update
agentpm diff
agentpm doctor
```

## Docs

- [Getting Started](./docs/getting-started.md)
- [Architecture](./docs/architecture.md)
- [Adapter Guide](./docs/adapter-guide.md)
- [Registry Guide](./docs/registry-guide.md)
- [Concept](./docs/concept.md)
- [Plan](./docs/plan.md)
