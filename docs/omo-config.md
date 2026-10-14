# Engine configuration on OpenCode V2

The engine keeps its own configuration file; OpenCode V2 is not involved in it.

## Location

| Version | Path |
| --- | --- |
| V1 (legacy) | `~/.config/opencode/oh-my-openagent.jsonc` |
| V2 / current engine | `~/.omo/omo.jsonc` (user) and `<project>/.omo/omo.jsonc` (project) |

On first load the engine migrates the legacy file to `~/.omo/omo.jsonc`, moves the
original into `~/.omo/migration-backup-<timestamp>-opencode-config/`, and records
the migration in `_migrations`.

**The migration is lossy**: it keeps harness-scoped keys such as `model_fallback`
(wrapped into a `[opencode]` block) but drops agent and category overrides.

## Shape for engine 5.1.33

Validated against `dist/oh-my-opencode.schema.json` shipped with the engine:

- `model_fallback`, and other host-specific switches, belong inside the
  harness-scoped `[opencode]` block. At the root they fail validation.
- Agent and category entries take `model` (a string) plus `models`
  (an array). The older `fallback_models` key does **not** validate any more.
- `agents` and `categories` are root keys.

A working file:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/omo.schema.json",
  "_migrations": ["2026-07-opencode-config-unification", "2026-08-reasoning-unification"],

  "[opencode]": {
    "model_fallback": false
  },

  "agents": {
    "oracle": {
      "model": "opencode-go/deepseek-v4.1-flash",
      "models": ["opencode-go/deepseek-v4.1-flash"]
    }
  },

  "categories": {
    "deep": {
      "model": "opencode-go/deepseek-v4.1-flash",
      "models": ["opencode-go/deepseek-v4.1-flash"]
    }
  }
}
```

Keep `_migrations` as written so the engine does not re-run a migration over the
file. If validation fails, the engine logs
`legacy configuration changes were not applied: Migration validation failed for
~/.omo/omo.jsonc: <keys>` and continues with defaults.

## Verifying an override took effect

The primary agents inherit the host's default model through the engine's config
pipeline, so a broken file shows up as a primary agent keeping the engine's own
default model instead of the configured one. Compare with the bridge log at
`~/.cache/oh-my-openagent-v2/bridge.log`, which records the replay report for
every load.
