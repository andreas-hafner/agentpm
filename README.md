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
- Initialize and sync `agentpm.yaml`
- Run diagnostics with `agentpm doctor`

## Getting started

```bash
pnpm install
pnpm build
pnpm --filter agentpm-cli exec agentpm --help
```

## Example commands

```bash
agentpm source add ./examples/repos/codex-sample
agentpm inspect ./examples/repos/codex-sample
agentpm search audio
agentpm install audio-mastering --project
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
