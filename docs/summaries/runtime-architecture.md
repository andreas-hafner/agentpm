# Runtime Architecture

## Responsibility

Summarizes the runtime package split and the main command execution flow.

## Key Files

- `apps/cli/src/index.ts`
- `packages/core/src/index.ts`
- `packages/adapters/src/index.ts`
- `packages/git/src/index.ts`
- `packages/db/src/index.ts`
- `packages/registry/src/index.ts`
- `packages/shared/src/index.ts`

## Entry Points

- `agentpm` CLI binary
- `AgentPmService` orchestration layer

## Dependencies

- Commander.js
- simple-git
- Ink

## Notes

- The CLI stays thin and delegates behavior to `packages/core`.
- Native layout preservation is the default install strategy.
- Adapter detection scans supported roots for marker files, so nested collections inside `skills/` can still be indexed and installed.
- Git cache directories use shortened hashed paths so sparse clones stay within Windows path-length limits.
- Registry sources include the skills.sh API (auth required) and the SkillsHub API (skillshub.wtf, no auth, 1000-entry cap).
- On first start (no sources in DB, TTY available), the CLI prompts to add SkillsHub as the default registry.
