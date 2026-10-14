// V1 `config` hook -> V2 domain transforms.
//
// V1 hosts hand the plugin one mutable config object; V2 removed the config
// domain and replaced it with per-domain transforms. The omo engine fills in
// agents, commands, MCP servers, tool disables and permissions through the
// config hook, so this bridge captures that object and replays the parts V2 can
// express. Everything V2 cannot express is logged, never silently dropped.
import { log } from "./logger.js"

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** "provider/model#variant" -> V2 Model.Ref */
function parseModelRef(value) {
  if (isRecord(value)) {
    const providerID = typeof value.providerID === "string" ? value.providerID : undefined
    const id = typeof value.modelID === "string" ? value.modelID : typeof value.id === "string" ? value.id : undefined
    if (!providerID || !id) return undefined
    return typeof value.variant === "string" ? { providerID, id, variant: value.variant } : { providerID, id }
  }
  if (typeof value !== "string" || value.length === 0) return undefined
  const [ref, variant] = value.split("#")
  const separator = ref.indexOf("/")
  if (separator <= 0) return undefined
  const providerID = ref.slice(0, separator)
  const id = ref.slice(separator + 1)
  if (!providerID || !id) return undefined
  return variant ? { providerID, id, variant } : { providerID, id }
}

function permissionsFromV1(permission) {
  if (!isRecord(permission)) return undefined
  const rules = []
  for (const [action, effect] of Object.entries(permission)) {
    if (effect !== "allow" && effect !== "deny" && effect !== "ask") continue
    rules.push({ action, resource: "*", effect })
  }
  return rules.length > 0 ? rules : undefined
}

function applyAgent(target, definition) {
  if (typeof definition.name === "string" && definition.name.length > 0) target.name = definition.name
  if (typeof definition.description === "string") target.description = definition.description
  if (typeof definition.prompt === "string" && definition.prompt.length > 0) target.system = definition.prompt
  if (definition.mode === "primary" || definition.mode === "subagent" || definition.mode === "all") {
    target.mode = definition.mode
  }
  if (definition.hidden === true) target.hidden = true
  if (typeof definition.color === "string") target.color = definition.color
  const model = parseModelRef(definition.model)
  if (model) target.model = model
  const permissions = permissionsFromV1(definition.permission)
  if (permissions) target.permissions = permissions
  if (!target.request) target.request = { settings: {}, headers: {}, body: {} }
  if (typeof definition.maxTokens === "number") target.request.body = { ...target.request.body, maxTokens: definition.maxTokens }
  if (typeof definition.temperature === "number") {
    target.request.body = { ...target.request.body, temperature: definition.temperature }
  }
  if (typeof definition.top_p === "number") {
    target.request.body = { ...target.request.body, top_p: definition.top_p }
  }
  if (typeof definition.variant === "string") {
    const base = target.model
    const ref =
      base && typeof base === "object"
        ? { providerID: base.providerID, id: base.id, variant: definition.variant }
        : model
          ? { ...model, variant: definition.variant }
          : undefined
    if (ref) target.model = ref
  }
  if (typeof definition.steps === "number") target.steps = definition.steps
}

function renderTemplate(template, args, sessionID) {
  const stamp = new Date().toISOString()
  return String(template)
    .split("$ARGUMENTS")
    .join(args)
    .split("$SESSION_ID")
    .join(sessionID)
    .split("$TIMESTAMP")
    .join(stamp)
}

function mcpConfigFromV1(name, definition) {
  if (!isRecord(definition)) return undefined
  const disabled = definition.enabled === false || definition.disabled === true
  if (definition.type === "remote") {
    if (typeof definition.url !== "string" || definition.url.length === 0) return undefined
    return {
      type: "remote",
      url: definition.url,
      ...(isRecord(definition.headers) ? { headers: definition.headers } : {}),
      ...(definition.oauth !== undefined ? { oauth: definition.oauth } : {}),
      ...(disabled ? { disabled: true } : {}),
    }
  }
  if (definition.type === "local") {
    const command = Array.isArray(definition.command)
      ? definition.command.filter((entry) => typeof entry === "string")
      : undefined
    if (!command || command.length === 0) return undefined
    return {
      type: "local",
      command,
      ...(isRecord(definition.environment) ? { environment: definition.environment } : {}),
      ...(typeof definition.cwd === "string" ? { cwd: definition.cwd } : {}),
      ...(disabled ? { disabled: true } : {}),
    }
  }
  return undefined
}

function wildcardToPrefix(pattern) {
  return pattern.endsWith("*") ? pattern.slice(0, -1) : undefined
}

/**
 * Replay a captured V1 config object as V2 transforms.
 * Returns a report of what was applied, degraded or skipped.
 */
export const V2_PERMISSION_ACTION_RENAMES = { task: "subagent", bash: "shell", write: "edit", patch: "edit" }

function permissionRulesFromV1(permission) {
  if (!isRecord(permission)) return []
  const rules = []
  for (const [rawAction, effect] of Object.entries(permission)) {
    if (effect !== "allow" && effect !== "deny" && effect !== "ask") continue
    rules.push({ action: V2_PERMISSION_ACTION_RENAMES[rawAction] ?? rawAction, resource: "*", effect })
  }
  return rules
}

function modelRefToString(model) {
  if (!model || typeof model !== "object") return undefined
  if (typeof model.providerID !== "string" || typeof model.id !== "string") return undefined
  return model.variant ? `${model.providerID}/${model.id}#${model.variant}` : `${model.providerID}/${model.id}`
}

/**
 * Build the V1 config object the engine expects as input. In V1 the host handed
 * the plugin its own configuration; V2 has no such object, so the host's current
 * providers, agents, default model and MCP servers are reconstructed from the V2
 * domains and handed to the engine's config hook.
 */
export async function buildV1ConfigSeed(ctx) {
  const seed = { agent: {}, command: {}, mcp: {}, tools: {}, permission: {}, skills: {}, provider: {} }
  try {
    const current = await ctx.model.default()
    const value = current && current.data
    const ref = modelRefToString(value)
    if (ref) seed.model = ref
  } catch (error) {
    log("[config-bridge] default model lookup failed", { error: String(error) })
  }
  try {
    const response = await ctx.agent.list()
    for (const agent of (response && response.data) || []) {
      seed.agent[agent.id] = {
        ...(typeof agent.description === "string" ? { description: agent.description } : {}),
        ...(typeof agent.mode === "string" ? { mode: agent.mode } : {}),
        ...(modelRefToString(agent.model) ? { model: modelRefToString(agent.model) } : {}),
        ...(typeof agent.system === "string" ? { prompt: agent.system } : {}),
        ...(agent.disabled === true ? { disable: true } : {}),
      }
    }
  } catch (error) {
    log("[config-bridge] agent seed failed", { error: String(error) })
  }
  try {
    const response = await ctx.provider.list()
    for (const provider of (response && response.data) || []) {
      seed.provider[provider.id] = { name: provider.name ?? provider.id }
    }
  } catch (error) {
    log("[config-bridge] provider seed failed", { error: String(error) })
  }
  try {
    const response = await ctx.mcp.list()
    const entries = Array.isArray(response) ? response : (response && response.data) || []
    for (const entry of entries) {
      const [name, config] = Array.isArray(entry) ? entry : [entry && entry.name, entry && entry.config]
      if (!name || !config) continue
      seed.mcp[name] = { ...config, enabled: config.disabled !== true }
    }
  } catch (error) {
    log("[config-bridge] mcp seed failed", { error: String(error) })
  }
  return seed
}

function skillDescription(content) {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)
  if (frontmatter) {
    const line = frontmatter[1].split("\n").find((entry) => entry.trim().startsWith("description:"))
    if (line) return line.slice(line.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "")
  }
  const line = content.split("\n").find((entry) => entry.trim().length > 0 && !entry.trim().startsWith("#"))
  return line ? line.trim().slice(0, 200) : undefined
}

async function registerRuntimeSkills(ctx, urls) {
  if (!Array.isArray(urls) || urls.length === 0) return 0
  const collected = []
  for (const raw of urls) {
    const base = String(raw).replace(/\/+$/, "")
    if (!base) continue
    try {
      const indexResponse = await fetch(`${base}/index.json`)
      if (!indexResponse.ok) {
        log("[config-bridge] skill source index unavailable", { base, status: indexResponse.status })
        continue
      }
      const index = await indexResponse.json()
      for (const entry of (index && index.skills) || []) {
        if (!entry || typeof entry.name !== "string") continue
        const file = Array.isArray(entry.files) && entry.files.length > 0 ? entry.files[0] : "SKILL.md"
        const markdownResponse = await fetch(`${base}/${entry.name}/${file}`)
        if (!markdownResponse.ok) continue
        const content = await markdownResponse.text()
        if (!content) continue
        collected.push({ name: entry.name, path: `${base}/${entry.name}`, content })
      }
    } catch (error) {
      log("[config-bridge] skill source fetch failed", { base, error: String(error) })
    }
  }
  if (collected.length === 0) return 0
  await ctx.skill.transform((editor) => {
    for (const skill of collected) {
      const description = skillDescription(skill.content)
      editor.add({
        id: `omo:${skill.name}`,
        name: skill.name,
        path: skill.path,
        content: skill.content,
        ...(description ? { description } : {}),
      })
    }
  })
  return collected.length
}

export async function applyV1Config(ctx, config, hooks) {
  const report = { agents: 0, commands: 0, mcp: 0, toolsDisabled: 0, skills: 0, permissionRules: [], degraded: [], skipped: [] }

  // --- agents -------------------------------------------------------------
  const agents = isRecord(config.agent) ? config.agent : {}
  const agentEntries = Object.entries(agents).filter(([, definition]) => isRecord(definition))
  if (agentEntries.length > 0) {
    try {
      await ctx.agent.transform((editor) => {
        for (const [key, definition] of agentEntries) {
          if (definition.disable === true || definition.disabled === true) {
            editor.remove(key)
            continue
          }
          editor.update(key, (target) => applyAgent(target, definition))
        }
      })
      report.agents = agentEntries.length
    } catch (error) {
      report.degraded.push(`agents: ${String(error)}`)
    }
  }

  const defaultAgent = config.default_agent
  if (typeof defaultAgent === "string" && defaultAgent.length > 0) {
    const match = agentEntries.find(([key, definition]) => key === defaultAgent || definition.name === defaultAgent)
    if (match) {
      try {
        await ctx.agent.transform((editor) => {
          editor.default(match[0])
        })
      } catch (error) {
        report.degraded.push(`default_agent: ${String(error)}`)
      }
    } else {
      report.skipped.push(`default_agent:${defaultAgent} (no matching agent)`)
    }
  }

  // --- commands -----------------------------------------------------------
  const commands = isRecord(config.command) ? config.command : {}
  const commandEntries = Object.entries(commands).filter(([, definition]) => isRecord(definition))
  if (commandEntries.length > 0) {
    try {
      await ctx.command.transform((editor) => {
        for (const [name, definition] of commandEntries) {
          editor.add({
            name,
            ...(typeof definition.description === "string" ? { description: definition.description } : {}),
            execute: async (invocation) => {
              const args = invocation && invocation.prompt && typeof invocation.prompt.text === "string" ? invocation.prompt.text : ""
              const text = renderTemplate(definition.template ?? "", args, invocation.sessionID)
              if (typeof definition.agent === "string" && definition.agent) {
                await ctx.session.switchAgent({ sessionID: invocation.sessionID, agent: definition.agent }).catch(() => {})
              }
              const model = parseModelRef(definition.model)
              if (model) {
                await ctx.session.switchModel({ sessionID: invocation.sessionID, model }).catch(() => {})
              }
              await ctx.session.prompt({ sessionID: invocation.sessionID, text, delivery: invocation.delivery ?? "queue" })
            },
          })
        }
      })
      report.commands = commandEntries.length
    } catch (error) {
      report.degraded.push(`commands: ${String(error)}`)
    }
  }

  // --- mcp ----------------------------------------------------------------
  const mcpServers = isRecord(config.mcp) ? config.mcp : {}
  const mcpEntries = Object.entries(mcpServers)
    .map(([name, definition]) => [name, mcpConfigFromV1(name, definition)])
    .filter(([, server]) => server !== undefined)
  if (mcpEntries.length > 0) {
    try {
      await ctx.mcp.transform((editor) => {
        for (const [name, server] of mcpEntries) editor.set(name, server)
      })
      report.mcp = mcpEntries.length
    } catch (error) {
      report.degraded.push(`mcp: ${String(error)}`)
    }
    const unsupported = Object.entries(mcpServers).filter(([, definition]) => isRecord(definition) && mcpConfigFromV1("", definition) === undefined)
    for (const [name] of unsupported) report.skipped.push(`mcp:${name} (unsupported shape)`)
  }

  // --- tool disables ------------------------------------------------------
  const toolFlags = isRecord(config.tools) ? config.tools : {}
  const disabledExact = []
  const disabledPrefixes = []
  for (const [name, value] of Object.entries(toolFlags)) {
    if (value !== false) continue
    const prefix = wildcardToPrefix(name)
    if (prefix) disabledPrefixes.push(prefix)
    else disabledExact.push(name)
  }
  if (disabledExact.length > 0 || disabledPrefixes.length > 0) {
    try {
      await ctx.tool.transform((editor) => {
        const ids = editor.list().map((tool) => tool.id)
        for (const id of ids) {
          const matchesExact = disabledExact.includes(id)
          const matchesPrefix = disabledPrefixes.some((prefix) => id.startsWith(prefix))
          if (matchesExact || matchesPrefix) {
            editor.remove(id)
            report.toolsDisabled += 1
          }
        }
      })
    } catch (error) {
      report.degraded.push(`tools: ${String(error)}`)
    }
  }

  // --- permissions / formatter / instructions / skills --------------------
  report.permissionRules = permissionRulesFromV1(config.permission)
  if (report.permissionRules.length === 0 && isRecord(config.permission) && Object.keys(config.permission).length > 0) {
    report.degraded.push("permission (no rule in the V1 map had a usable effect)")
  }
  if (config.formatter !== undefined) {
    report.degraded.push("formatter (no V2 plugin sink)")
  }
  if (config.instructions !== undefined) {
    report.degraded.push("instructions (no V2 plugin sink)")
  }
  const skillUrls = isRecord(config.skills) && Array.isArray(config.skills.urls) ? config.skills.urls : []
  if (skillUrls.length > 0) {
    try {
      report.skills = await registerRuntimeSkills(ctx, skillUrls)
    } catch (error) {
      report.degraded.push(`skills.urls: ${String(error)}`)
    }
  }
  if (Array.isArray(config.skills && config.skills.paths) && config.skills.paths.length > 0) {
    report.degraded.push(`skills.paths (${config.skills.paths.length}) — V2 discovers skills from configured locations`)
  }

  log("[config-bridge] replay report", report)
  return report
}
