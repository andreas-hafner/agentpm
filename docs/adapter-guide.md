# Adapter Guide

AgentPM adapters translate repository layouts into installable native targets.

## Built-in adapters

- `codex`: detects `.codex/skills/*` and installs back into `.codex/skills`.
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

- Adapters scan known layout roots only.
- Install scripts such as `install.sh` or `install.ps1` are reported as warnings.
- Compatibility is scored from the number of matching roots and the confidence that the adapter can preserve native layout.

