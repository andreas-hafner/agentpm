# Registry Guide

AgentPM registries are static YAML or JSON indexes that list installable entries. They can be local files, HTTPS URLs, or enterprise/private indexes exposed behind normal Git or HTTP access controls.

## Supported format

```yaml
version: 1
entries:
  - name: audio-mastering
    description: Codex skill collection for mastering workflows
    repo: https://github.com/example/audio-skills.git
    ref: main
    path: .codex/skills/audio-mastering
    target: codex
    tags:
      - audio
      - mastering
```

`target` is preferred for new registry indexes. `adapterHint` remains supported as a compatibility alias for older indexes.

## Behavior

- Add a registry index with `agentpm source add <path-or-url-to-index>`.
- Use `registry:<path-or-url-to-index>` when a source should be treated as a registry even if the locator does not end in `.yaml`, `.yml`, or `.json`.
- Registry search is limited to configured sources.
- Installing a registry entry resolves the underlying repo and path, then follows the normal adapter and cache flow.
- Private HTTP registries can use `AGENTPM_REGISTRY_TOKEN` or host-specific bearer tokens such as `AGENTPM_REGISTRY_TOKEN_REGISTRY_EXAMPLE_COM`. AgentPM reads those tokens from the environment but does not store them.
- Project configs should reference registry sources by top-level source `id`:

```yaml
sources:
  - id: enterprise
    locator: registry:https://registry.example.com/agentpm/index.yaml

skills:
  - name: audio-mastering
    source: enterprise
    target: codex
    ref: v1.2.0
    items:
      - audio-mastering
```
