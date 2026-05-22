# Registry Guide

AgentPM supports static YAML or JSON registry indexes served from local files or HTTPS URLs under the `registry` source kind.

The `skills.sh` CLI bridge is separate from this registry model. Use `agentpm skills search` and `agentpm skills install` when you want no-key public discovery or import without treating the provider as a normal indexed source.

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
- Registry search is backed by local indexes for configured sources. Rebuild indexes with `agentpm refresh`.
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
