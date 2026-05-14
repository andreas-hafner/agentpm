# Adapter Guide

AgentPM adapters translate repository layouts into installable native targets.

## Built-in adapters

- `codex`: detects `.codex/skills/*` and `.codex.cloud/skills/*`, then installs back into the detected native root.
- `claude`: detects `.claude/agents/*` and installs back into `.claude/agents`.
- `generic`: detects `skills/*`, `.agents/skills/*`, and `subagents/*` and preserves those roots.

## Adapter contract

Each adapter implements:

- `detect()`
- `scoreCompatibility()`
- `install()`
- `update()`
- `remove()`
- `validate()`

## Detection behavior

- Adapters scan known layout roots and look for marker files such as `SKILL.md`, `README.md`, `AGENT.md`, or `CLAUDE.md`.
- Plain `skills/*` repositories are supported even when an upstream install script would normally copy them elsewhere.
- Install scripts such as `install.sh`, `install.ps1`, or `scripts/install.sh` are reported as warnings and are not executed automatically.
- Compatibility is scored from the number of matching roots and the confidence that the adapter can preserve native layout.
