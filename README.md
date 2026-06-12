# AgentPM

<p align="center">
  <a href="https://www.npmjs.com/package/@travelhawk/agentpm"><img src="https://img.shields.io/npm/v/@travelhawk/agentpm?color=cb3837&label=npm" alt="npm version" /></a>
  <a href="https://github.com/travelhawk/agentpm/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-0f766e.svg" alt="MIT License" /></a>
  <a href="https://github.com/travelhawk/agentpm/actions/workflows/ci.yml"><img src="https://github.com/travelhawk/agentpm/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<p align="center">
  <strong>Git-native skill management for AI coding agents.</strong><br />
  Discover, install, sync, and publish skills across Codex, Claude, and generic agent layouts.
</p>

<p align="center">
  <img src="./docs/assets/agentpm-demo.gif" alt="AgentPM add and push demo" width="900" />
</p>

## Install

Use the published CLI when you want to use AgentPM:

```bash
npm install -g @travelhawk/agentpm
agentpm --help
```

Use the repository checkout only when developing AgentPM itself:

```bash
git clone https://github.com/travelhawk/agentpm.git
cd agentpm
pnpm install
pnpm build
pnpm --filter @travelhawk/agentpm exec agentpm --help
```

If you want the development checkout on your global `PATH` while working on the CLI:

```bash
pnpm run link:global
agentpm --help
```

## First 5 Minutes

Start here instead of reading the full command surface:

```bash
agentpm quickstart
agentpm quickstart install
agentpm quickstart team
agentpm quickstart sync
agentpm quickstart --json
```

### 1. Install One Skill

Use this when you want one skill on this machine or in the current repo.

```bash
agentpm skills search typescript
agentpm skills install typescript --project
agentpm list
```

- `--project` installs into the current repo.
- `--global` installs into your home agent directories.

### 2. Set Up a Team Repo

Use this when the repository should declare required skills for everyone who clones it.

```bash
agentpm source add travelhawk/skills-vault
agentpm install --from travelhawk/skills-vault --skill release-helper --project --add-source
agentpm init
agentpm sync
```

This creates and maintains an `agentpm.yaml` contract. Once that file exists, future project and workspace installs update the repo contract automatically.

### 3. Sync Skills Across Machines

Use this when you want one canonical skills repo and multiple machines pulling from it.

```bash
agentpm target add my-skills git@github.com:me/skills.git --default
agentpm push --all
agentpm pull --from my-skills
```

Add `--target codex,claude,generic` to control which runtimes receive pulled skills.

## What AgentPM Does Well

- `📦` Install skills from Git repositories, local folders, static registries, and the public `skills.sh` bridge.
- `🧭` Keep the CLI thin while respecting native agent layouts instead of rewriting them.
- `🤝` Turn `agentpm.yaml` into a reproducible team contract for repo-scoped skills.
- `🔁` Publish a canonical `skills/<name>` library with `push`, then materialize it everywhere with `pull`.
- `🩺` Explain broken state with `doctor` and clean stale cache data with `cache clean`.
- `🧾` Emit machine-readable JSON with `--json` across stateful automation flows.

## Common Flows

### Project Contract

Create and commit `agentpm.yaml` when you want repository-level setup to be reproducible:

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
```

String entries are shorthand. Object entries bind a project skill to a configured source, optional Git ref or resolved revision, runtime target, install scope, and one or more native skill items.

### Public Bridge

Use the public bridge when you do not have your own team source yet:

```bash
agentpm skills search typescript
agentpm skills install wshobson/agents@typescript-advanced-types --project
agentpm skills list
agentpm skills update --yes
```

### Canonical Push / Pull / Adopt

AgentPM keeps a canonical skill library in `~/.agentpm/skills/` under `AGENTPM_HOME`. A single skill is stored once and fanned out into agent-specific directories through managed links.

```bash
agentpm target add my-skills git@github.com:me/skills.git --default
agentpm push --all
agentpm pull --from my-skills
agentpm adopt .claude/skills/my-existing-skill --target codex,generic
```

## Automation and JSON Output

For scripts, CI, and local tooling, prefer `--json`:

```bash
agentpm quickstart --json
agentpm source list --json
agentpm install release-helper --project --json
agentpm update --json
agentpm update --yes --json
agentpm doctor --json
agentpm doctor --fix --yes --json
```

Behavior is consistent:

- read/list flows return structured data
- stateful commands return `{ "ok": true, "action": "..." }`
- confirmation-based flows return previews in JSON unless `--yes` is also provided
- failures return `{ "ok": false, "error": { "message", "hints" } }`

## Error Guidance

AgentPM now tries to tell you what to do next instead of only failing.

Typical recovery commands:

```bash
agentpm source list
agentpm target list
agentpm doctor
agentpm doctor --fix
```

Common cases:

- no configured sources: `agentpm source add <repo-or-registry>`
- non-interactive runs: pass explicit flags such as `--skill`, `--all`, `--from`, or `--yes`
- unknown target agents: use `codex`, `claude`, or `generic`
- manifest confusion: run `agentpm init` if the repo should own a contract

## Development

Validate the workspace before release-facing changes:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm smoke
```

`pnpm smoke` builds the CLI and runs an end-to-end flow with an isolated `AGENTPM_HOME`.

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

MIT. See [LICENSE](./LICENSE).
