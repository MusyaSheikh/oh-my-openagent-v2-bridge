// oh-my-openagent-v2-bridge
//
// Runs the complete V1 oh-my-openagent (oh-my-opencode) engine on OpenCode V2.
//
// OpenCode V2 replaced the plugin API: a V1 plugin returned one object of tools
// and hooks, while V2 expects `{ id, setup }` and hands the plugin a different
// context. This bridge drives the *unmodified* V1 engine through a V1-shaped
// facade built on the V2 context, then translates the V1 tools and hooks back
// into V2 registrations. The engine itself is not reimplemented, so its tools,
// agents, commands, MCP servers, skills, background tasks and hooks all keep
// working through one translation layer.
import { Plugin } from "@opencode/plugin"
import pluginModule from "oh-my-opencode"
import { createV1CompatContext } from "./lib/compat-client.js"
import { createEventBus } from "./lib/event-bus.js"
import { createSessionRegistry, createStatusCache, createTodoStore } from "./lib/stores.js"
import { applyToolDefinitionOverrides, registerHookBridge } from "./lib/hook-bridge.js"
import { convertV1Tool } from "./lib/tool-bridge.js"
import { applyV1Config, buildV1ConfigSeed } from "./lib/config-bridge.js"
import { log, logError } from "./lib/logger.js"

const PLUGIN_ID = "oh-my-openagent"
const LOG_SCOPE = "[oh-my-openagent-v2]"

let bunShell
try {
  const bun = await import("bun")
  bunShell = bun.$
} catch {
  bunShell = undefined
}

async function discoverServerUrl() {
  const envUrl = process.env.OPENCODE_SERVER_URL
  if (typeof envUrl === "string" && envUrl.length > 0) {
    try {
      return new URL(envUrl)
    } catch {
      // ignore
    }
  }
  try {
    const { Service } = await import("@opencode/client/service")
    const endpoint = await Promise.race([
      Service.discover(),
      new Promise((resolve) => setTimeout(() => resolve(undefined), 1500)),
    ])
    if (endpoint && typeof endpoint.url === "string") return new URL(endpoint.url)
  } catch {
    // the live-server features degrade; they are optional
  }
  return new URL("http://127.0.0.1:0")
}

export const omoV2Bridge = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const report = { tools: 0, hooks: false, agents: 0, commands: 0, mcp: 0, steps: [], degraded: [] }
    const controller = new AbortController()
    let disposeBridge
    let disposeV1
    let v1hooks

    const step = async (name, run) => {
      try {
        const value = await run()
        report.steps.push({ name, ok: true })
        return value
      } catch (error) {
        report.steps.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
        logError(`${LOG_SCOPE} step failed: ${name}`, error)
        return undefined
      }
    }

    const directory = (ctx.location && ctx.location.directory) || process.cwd()
    const registry = createSessionRegistry(ctx.storage)
    const todos = createTodoStore(ctx.storage)
    const statusCache = createStatusCache()

    const serverUrl = await discoverServerUrl()
    log(`${LOG_SCOPE} starting`, {
      directory,
      opencode: ctx.app && ctx.app.version,
      engine: pluginModule && pluginModule.id,
      serverUrl: serverUrl.toString(),
    })

    const v1Input = createV1CompatContext(ctx, {
      registry,
      todos,
      statusCache,
      bunShell,
      serverUrl,
    })

    // 1. Boot the V1 engine with the V1-shaped facade.
    const hooks = await step("engine.boot", async () => {
      if (!pluginModule || typeof pluginModule.server !== "function") {
        throw new Error("oh-my-opencode did not expose a V1 server entrypoint")
      }
      return await pluginModule.server(v1Input, {})
    })
    if (!hooks) {
      return () => controller.abort()
    }
    v1hooks = hooks
    report.hooks = true

    // 2. V1 config hook -> V2 domain transforms (agents, commands, MCP, tools).
    const configStep = await step("config.replay", async () => {
      if (typeof hooks.config !== "function") return { agents: 0, commands: 0, mcp: 0, toolsDisabled: 0, permissionRules: [], degraded: [], skipped: [] }
      const config = await buildV1ConfigSeed(ctx)
      await hooks.config(config)
      return await applyV1Config(ctx, config, hooks)
    })
    if (configStep) {
      report.agents = configStep.agents ?? 0
      report.commands = configStep.commands ?? 0
      report.mcp = configStep.mcp ?? 0
      report.skills = configStep.skills ?? 0
      report.degraded.push(...(configStep.degraded ?? []))
    }

    // 3. V1 tools -> V2 tool registrations.
    const engineTools = hooks.tool && typeof hooks.tool === "object" ? hooks.tool : {}
    const resolveDirectory = async (sessionID) => {
      const record = await registry.get(sessionID)
      return (record && record.directory) || directory
    }
    await step("tools.register", async () => {
      const ids = []
      for (const [name, definition] of Object.entries(engineTools)) {
        try {
          const converted = convertV1Tool(name, definition, {
            resolveDirectory,
            defaultDirectory: directory,
            worktree: directory,
          })
          await ctx.tool.transform((editor) => {
            editor.add(converted)
          })
          ids.push(name)
          report.tools += 1
        } catch (error) {
          logError(`${LOG_SCOPE} tool registration failed: ${name}`, error)
        }
      }
      return ids
    }).then((ids) => {
      if (Array.isArray(ids) && ids.length > 0) {
        return applyToolDefinitionOverrides(ctx.tool, hooks, ids)
      }
      return undefined
    })

    // 4. V2 event stream -> V1 event bus.
    const bus = createEventBus(ctx.event, statusCache)
    void bus.run(controller.signal).catch((error) => {
      logError(`${LOG_SCOPE} event stream ended`, error)
    })

    // 5. V1 hooks -> V2 hooks.
    const bridge = await step("hooks.register", async () =>
      registerHookBridge(ctx, bus, hooks, { permissionRules: configStep ? configStep.permissionRules : [] }),
    )
    if (bridge) disposeBridge = bridge.disposeAll

    if (typeof hooks.dispose === "function") {
      disposeV1 = hooks.dispose
    }

    log(`${LOG_SCOPE} ready`, report)

    return async () => {
      try {
        if (disposeBridge) await disposeBridge()
      } catch (error) {
        logError(`${LOG_SCOPE} bridge dispose failed`, error)
      }
      try {
        if (disposeV1) await disposeV1()
      } catch (error) {
        logError(`${LOG_SCOPE} engine dispose failed`, error)
      }
      controller.abort()
    }
  },
})

export default omoV2Bridge
