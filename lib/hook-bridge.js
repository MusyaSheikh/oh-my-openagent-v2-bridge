// V1 hook -> V2 hook bridge.
//
// The omo engine returns the V1 plugin-interface surface (tool hooks, chat
// hooks, events, compaction). V2 has different hook names, different event
// objects and different lifecycle sinks, so each V1 extension point is mapped
// onto the closest V2 hook. Where V2 has no faithful sink the bridge logs the
// degradation instead of silently dropping the behaviour.
import { log } from "./logger.js"
import { toMillis } from "./message-text.js"

export const DEFERRED_BRIDGES = ["command.execute.before", "experimental.compaction.autocontinue"]

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(value, fallback = "") {
  return typeof value === "string" ? value : fallback
}

function textOfPart(part) {
  if (!isRecord(part)) return undefined
  return part.type === "text" && typeof part.text === "string" ? part.text : undefined
}

function joinPartTexts(parts) {
  const texts = []
  for (const part of parts ?? []) {
    const text = textOfPart(part)
    if (text !== undefined) texts.push(text)
  }
  return texts.join("\n")
}

function resultContentToOutput(content) {
  if (content === undefined) return ""
  if (typeof content === "string") return content
  const chunks = []
  for (const part of content ?? []) {
    const text = textOfPart(part)
    chunks.push(text ?? JSON.stringify(part))
  }
  return chunks.join("\n")
}

function extractDelta(before, after) {
  if (after === before) return undefined
  if (before.length > 0 && after.startsWith(before)) return after.slice(before.length)
  if (before.length > 0 && after.endsWith(before)) return after.slice(0, after.length - before.length)
  return after
}

// ---------------------------------------------------------------------------
// V2 event -> V1 event translation
// ---------------------------------------------------------------------------

function sessionInfoFromEvent(data, sessionID) {
  const now = Date.now()
  return {
    id: sessionID,
    projectID: readString(data.projectID),
    directory: readString(data.directory) || readString(data.location && data.location.directory),
    parentID: typeof data.parentID === "string" ? data.parentID : undefined,
    title: readString(data.title),
    version: readString(data.version),
    time: {
      created: typeof data.created === "number" ? data.created : toMillis(data.time && data.time.created) || now,
      updated: now,
    },
  }
}

function textPart(messageID, sessionID, text) {
  return { id: `${messageID}_text`, sessionID, messageID, type: "text", text }
}

function toolPartFromContent(messageID, sessionID, content) {
  const state = content.state && typeof content.state === "object" ? content.state : { status: "pending" }
  return {
    id: typeof content.id === "string" ? content.id : `${messageID}_tool`,
    sessionID,
    messageID,
    type: "tool",
    callID: typeof content.id === "string" ? content.id : `${messageID}_tool`,
    tool: readString(content.name, "unknown"),
    state: {
      status: state.status === "streaming" ? "running" : readString(state.status, "pending"),
      input: state.input ?? {},
      ...(state.status === "completed"
        ? {
            output: Array.isArray(state.content)
              ? state.content.map((part) => readString(part && part.text)).filter(Boolean).join("\n")
              : "",
            title: "",
            metadata: state.metadata ?? {},
          }
        : {}),
      ...(state.status === "error" ? { error: readString(state.error && state.error.message, "tool error") } : {}),
    },
  }
}

function assistantInfo(messageID, sessionID, data) {
  const now = Date.now()
  return {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: toMillis(data.created) || now, completed: now },
    parentID: readString(data.parentID),
    modelID: readString(data.model && data.model.id),
    providerID: readString(data.model && data.model.providerID),
    mode: "",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

/** Translate one V2 event into zero or more V1 events. */
export function translateEvent(event) {
  const data = isRecord(event.data) ? event.data : {}
  const sessionID =
    typeof data.sessionID === "string"
      ? data.sessionID
      : typeof data.id === "string"
        ? data.id
        : isRecord(data.info) && typeof data.info.id === "string"
          ? data.info.id
          : undefined
  switch (event.type) {
    case "session.created":
      if (!sessionID) return []
      return [{ type: "session.created", properties: { info: sessionInfoFromEvent(data, sessionID) } }]
    case "session.deleted":
      if (!sessionID) return []
      return [{ type: "session.deleted", properties: { info: sessionInfoFromEvent(data, sessionID) } }]
    case "session.renamed":
    case "session.metadata.updated":
    case "session.agent.selected":
    case "session.model.selected":
      if (!sessionID) return []
      return [{ type: "session.updated", properties: { info: sessionInfoFromEvent(data, sessionID) } }]
    case "session.idle":
      if (!sessionID) return []
      return [{ type: "session.idle", properties: { sessionID } }]
    case "session.status": {
      if (!sessionID) return []
      const status = data.status
      if (!isRecord(status) || typeof status.type !== "string") return []
      return [{ type: "session.status", properties: { sessionID, status } }]
    }
    case "session.execution.failed":
    case "session.step.failed":
      if (!sessionID) return []
      return [
        { type: "session.error", properties: { sessionID, ...(data.error === undefined ? {} : { error: data.error }) } },
      ]
    case "session.execution.interrupted":
      if (!sessionID) return []
      return [{ type: "session.idle", properties: { sessionID } }]
    case "session.compaction.started":
    case "session.compaction.ended":
    case "session.compaction.failed":
      if (!sessionID) return []
      return [{ type: "session.compacted", properties: { sessionID } }]
    case "session.message.content.updated": {
      const messageID = readString(data.messageID)
      if (!sessionID || !messageID) return []
      const content = Array.isArray(data.content) ? data.content : []
      const out = [{ type: "message.updated", properties: { info: assistantInfo(messageID, sessionID, data) } }]
      for (const item of content) {
        if (!isRecord(item)) continue
        const part = item.type === "tool" ? toolPartFromContent(messageID, sessionID, item) : textPart(messageID, sessionID, readString(item.text))
        out.push({ type: "message.part.updated", properties: { part } })
      }
      return out
    }
    case "session.text.delta":
    case "session.reasoning.delta":
    case "session.tool.input.delta": {
      const messageID = readString(data.assistantMessageID, sessionID)
      if (!sessionID) return []
      return [
        {
          type: "message.part.delta",
          properties: {
            sessionID,
            messageID,
            partID: messageID,
            field: event.type === "session.reasoning.delta" ? "reasoning" : "text",
            delta: readString(data.delta),
          },
        },
      ]
    }
    case "session.tool.called": {
      const messageID = readString(data.assistantMessageID, sessionID)
      if (!sessionID) return []
      return [
        {
          type: "message.part.updated",
          properties: {
            part: {
              id: readString(data.id, `${messageID}_tool`),
              sessionID,
              messageID,
              type: "tool",
              callID: readString(data.id, `${messageID}_tool`),
              tool: readString(data.name, readString(data.id, "unknown")),
              state: { status: "running", input: data.input ?? {}, time: { start: Date.now() } },
            },
          },
        },
      ]
    }
    case "permission.asked":
      if (!sessionID) return []
      return [{ type: "permission.asked", properties: { sessionID, ...data } }]
    case "permission.replied":
      if (!sessionID) return []
      return [{ type: "permission.replied", properties: { sessionID, ...data } }]
    case "tui.toast.show":
      return [{ type: "tui.toast.show", properties: data }]
    default:
      return []
  }
}

export const MAPPED_EVENT_TYPES = [
  "session.created",
  "session.deleted",
  "session.renamed",
  "session.metadata.updated",
  "session.agent.selected",
  "session.model.selected",
  "session.idle",
  "session.status",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.failed",
  "session.compaction.started",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.message.content.updated",
  "session.text.delta",
  "session.reasoning.delta",
  "session.tool.input.delta",
  "session.tool.called",
  "permission.asked",
  "permission.replied",
  "tui.toast.show",
]

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

async function registerToolHooks(tool, v1hooks) {
  const registrations = []
  const before = v1hooks["tool.execute.before"]
  if (before) {
    registrations.push(
      await tool.hook("execute.before", async (input) => {
        try {
          const original = input.input
          const output = { args: isRecord(original) ? { ...original } : original }
          await before({ tool: input.tool, sessionID: input.sessionID, callID: input.id }, output)
          input.input = output.args
        } catch (error) {
          log("[hook-bridge] tool.execute.before failed", { tool: input.tool, error: String(error) })
        }
      }),
    )
  }
  const after = v1hooks["tool.execute.after"]
  if (after) {
    registrations.push(
      await tool.hook("execute.after", async (input) => {
        try {
          if (input.status !== "completed") return
          const output = {
            title: "",
            output: resultContentToOutput(input.result && input.result.content),
            metadata: isRecord(input.result && input.result.metadata) ? { ...input.result.metadata } : {},
          }
          await after(
            { tool: input.tool, sessionID: input.sessionID, callID: input.id, args: input.input },
            output,
          )
          input.result = {
            ...input.result,
            content: output.output,
            ...(output.metadata && Object.keys(output.metadata).length > 0 ? { metadata: { ...output.metadata } } : {}),
          }
        } catch (error) {
          log("[hook-bridge] tool.execute.after failed", { tool: input.tool, error: String(error) })
        }
      }),
    )
  }
  return registrations
}

/**
 * V1 `tool.definition` rewrites a tool's description/parameters before the model
 * sees it. V2 tools are fixed at add time but the tool editor can update an
 * existing tool, so the override is applied as a second transform pass.
 */
export async function applyToolDefinitionOverrides(tool, v1hooks, toolIds) {
  const definition = v1hooks["tool.definition"]
  if (!definition) return
  const overrides = new Map()
  for (const id of toolIds) {
    try {
      const output = { description: "", parameters: undefined }
      await definition({ toolID: id }, output)
      if (output.description || output.parameters !== undefined) {
        overrides.set(id, output)
      }
    } catch (error) {
      log("[hook-bridge] tool.definition failed", { toolID: id, error: String(error) })
    }
  }
  if (overrides.size === 0) return
  await tool.transform((editor) => {
    for (const [id, output] of overrides) {
      editor.update(id, (target) => {
        if (output.description) target.description = output.description
        if (output.parameters !== undefined) target.input = output.parameters
      })
    }
  })
}

async function registerEventBridge(bus, v1hooks) {
  const onEvent = v1hooks["event"]
  if (!onEvent) return []
  const offs = []
  for (const v2type of MAPPED_EVENT_TYPES) {
    offs.push(
      bus.on(v2type, async (event) => {
        try {
          for (const translated of translateEvent(event)) {
            await onEvent({ event: translated })
          }
        } catch (error) {
          log("[hook-bridge] event bridge failed", { v2type, error: String(error) })
        }
      }),
    )
  }
  return offs.map((off) => ({ dispose: async () => off() }))
}

async function registerPromptHook(session, v1hooks) {
  const chatMessage = v1hooks["chat.message"]
  if (!chatMessage) return []
  const registration = await session.hook("prompt", async (input) => {
    try {
      const original = input.prompt.text
      const parts = [
        {
          type: "text",
          text: original,
          id: input.messageID,
          sessionID: input.sessionID,
          messageID: input.messageID,
        },
      ]
      const output = { message: { id: input.messageID, sessionID: input.sessionID }, parts }
      await chatMessage({ sessionID: input.sessionID, messageID: input.messageID }, output)
      const firstText = output.parts.find((part) => part.type === "text" && typeof part.text === "string")
      if (firstText && firstText.text !== undefined && firstText.text !== original) input.prompt.text = firstText.text
      if (output.parts.length > parts.length) {
        log("[hook-bridge] prompt bridge dropped pushed parts (no V2 sink)", {
          sessionID: input.sessionID,
          dropped: output.parts.length - parts.length,
        })
      }
    } catch (error) {
      log("[hook-bridge] prompt bridge failed", { sessionID: input.sessionID, error: String(error) })
    }
  })
  return [registration]
}

async function registerContextHooks(session, v1hooks) {
  const registrations = []
  const messagesTransform = v1hooks["experimental.chat.messages.transform"]
  if (messagesTransform) {
    registrations.push(
      await session.hook("context", async (input) => {
        try {
          const views = input.messages.map((message) => ({
            info: { role: message.role === "assistant" ? "assistant" : "user", sessionID: input.sessionID },
            parts: [{ type: "text", text: joinPartTexts(message.content) }],
          }))
          const before = views.map((view) => joinPartTexts(view.parts))
          const output = { messages: views }
          await messagesTransform({}, output)
          const after = output.messages.map((view) => joinPartTexts(view.parts))
          let lastUserIndex = -1
          for (let index = 0; index < input.messages.length; index++) {
            if (input.messages[index] && input.messages[index].role === "user") lastUserIndex = index
          }
          const shared = Math.min(before.length, after.length)
          for (let index = 0; index < shared; index++) {
            const delta = extractDelta(before[index] ?? "", after[index] ?? "")
            if (!delta) continue
            const role = input.messages[index] && input.messages[index].role
            if (role === "system") {
              input.system.push({ type: "text", text: delta })
            } else if (index === lastUserIndex) {
              const target = input.messages[index]
              if (target && Array.isArray(target.content)) target.content.push({ type: "text", text: delta })
            } else {
              input.system.push({ type: "text", text: delta })
            }
          }
          for (let index = shared; index < after.length; index++) {
            const text = after[index] ?? ""
            if (text) input.system.push({ type: "text", text })
          }
        } catch (error) {
          log("[hook-bridge] messages.transform bridge failed", { sessionID: input.sessionID, error: String(error) })
        }
      }),
    )
  }
  const systemTransform = v1hooks["experimental.chat.system.transform"]
  if (systemTransform) {
    registrations.push(
      await session.hook("context", async (input) => {
        try {
          const seed = input.system.map((part) => textOfPart(part)).filter((text) => text !== undefined)
          const seen = new Set(seed)
          const output = { system: [...seed] }
          const model = isRecord(input.model) ? input.model : {}
          await systemTransform(
            {
              sessionID: input.sessionID,
              model: { id: readString(model.id), providerID: readString(model.providerID) },
            },
            output,
          )
          for (const entry of output.system) {
            if (typeof entry === "string" && entry.length > 0 && !seen.has(entry)) {
              seen.add(entry)
              input.system.push({ type: "text", text: entry })
            }
          }
        } catch (error) {
          log("[hook-bridge] system.transform bridge failed", { sessionID: input.sessionID, error: String(error) })
        }
      }),
    )
  }
  return registrations
}

async function registerChatParamsHook(session, v1hooks) {
  const chatParams = v1hooks["chat.params"]
  if (!chatParams) return []
  const registration = await session.hook("context", async (input) => {
    try {
      const model = isRecord(input.model) ? input.model : {}
      const output = {
        temperature: undefined,
        topP: undefined,
        topK: undefined,
        maxOutputTokens: undefined,
        options: {},
      }
      await chatParams(
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: { id: readString(model.id), providerID: readString(model.providerID) },
          provider: { id: readString(model.providerID), info: {}, options: {} },
          message: { id: "", sessionID: input.sessionID, role: "user", time: { created: Date.now() } },
        },
        output,
      )
      const options = input.options
      if (typeof output.temperature === "number" && Number.isFinite(output.temperature)) {
        options.temperature = output.temperature
      }
      if (typeof output.topP === "number" && Number.isFinite(output.topP)) options.topP = output.topP
      if (typeof output.topK === "number" && Number.isFinite(output.topK)) options.topK = output.topK
      if (typeof output.maxOutputTokens === "number" && Number.isFinite(output.maxOutputTokens)) {
        options.maxTokens = output.maxOutputTokens
      }
      if (isRecord(output.options)) {
        for (const [key, value] of Object.entries(output.options)) {
          if (value !== undefined) options[key] = value
        }
      }
    } catch (error) {
      log("[hook-bridge] chat.params bridge failed", { sessionID: input.sessionID, error: String(error) })
    }
  })
  return [registration]
}

async function registerChatHeadersHook(session, v1hooks) {
  const chatHeaders = v1hooks["chat.headers"]
  if (!chatHeaders) return []
  const registration = await session.hook("model.request", async (input) => {
    try {
      const model = isRecord(input.model) ? input.model : {}
      const output = { headers: {} }
      await chatHeaders(
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: { id: readString(model.id), providerID: readString(model.providerID) },
          provider: { id: readString(model.providerID), info: {}, options: {} },
          message: { id: "", sessionID: input.sessionID, role: "user", time: { created: Date.now() } },
        },
        output,
      )
      for (const [key, value] of Object.entries(output.headers ?? {})) {
        if (typeof value === "string") input.headers[key] = value
      }
    } catch (error) {
      log("[hook-bridge] chat.headers bridge failed", { sessionID: input.sessionID, error: String(error) })
    }
  })
  return [registration]
}

async function registerCompactionHook(session, v1hooks) {
  const compacting = v1hooks["experimental.session.compacting"]
  if (!compacting) return []
  const registration = await session.hook("compaction", async (input) => {
    try {
      const output = { context: [] }
      await compacting({ sessionID: input.sessionID }, output)
      if (output.prompt) {
        const summary = [output.prompt, ...(output.context ?? [])].filter((part) => part && part.length > 0).join("\n\n")
        if (summary.length > 0) input.result = { summary }
      } else if (Array.isArray(output.context) && output.context.length > 0) {
        // V2 has no sink for extra compaction context: appending it to the system
        // prompt of the compaction request is the closest faithful behaviour.
        for (const entry of output.context) {
          if (typeof entry === "string" && entry.length > 0) input.system.push({ type: "text", text: entry })
        }
      }
    } catch (error) {
      log("[hook-bridge] compaction bridge failed", { sessionID: input.sessionID, error: String(error) })
    }
  })
  return [registration]
}

async function registerPermissionHook(ctx, rules) {
  const list = Array.isArray(rules) ? rules : []
  const allow = list.filter((rule) => rule.effect === "allow")
  const denied = list.filter((rule) => rule.effect !== "allow")
  for (const rule of denied) {
    log("[hook-bridge] V1 permission not applied (a plugin rule is evaluated after agent rules, so a blanket override could cancel an agent-level allow)", rule)
  }
  if (allow.length === 0) return []
  if (!ctx.permission || typeof ctx.permission.hook !== "function") {
    log("[hook-bridge] permission.hook unavailable on this host; V1 permission defaults not applied")
    return []
  }
  const registration = await ctx.permission.hook("evaluate", (event) => {
    const match = allow.find((rule) => rule.action === event.action)
    if (match && event.effect !== "allow") event.effect = "allow"
  })
  return [registration]
}

export async function registerHookBridge(ctx, bus, v1hooks, options = {}) {
  const registrations = []
  const collect = async (step, run) => {
    try {
      registrations.push(...(await run()))
    } catch (error) {
      log("[hook-bridge] registration failed", { step, error: String(error) })
    }
  }
  await collect("tool", () => registerToolHooks(ctx.tool, v1hooks))
  await collect("event", () => registerEventBridge(bus, v1hooks))
  await collect("prompt", () => registerPromptHook(ctx.session, v1hooks))
  await collect("context", () => registerContextHooks(ctx.session, v1hooks))
  await collect("chat.params", () => registerChatParamsHook(ctx.session, v1hooks))
  await collect("chat.headers", () => registerChatHeadersHook(ctx.session, v1hooks))
  await collect("compaction", () => registerCompactionHook(ctx.session, v1hooks))
  await collect("permission", () => registerPermissionHook(ctx, options.permissionRules))
  if (v1hooks["experimental.compaction.autocontinue"]) {
    log("[hook-bridge] experimental.compaction.autocontinue has no V2 sink (logged, not bridged)")
  }
  if (v1hooks["command.execute.before"]) {
    log("[hook-bridge] command.execute.before is bridged through registered commands, not as a hook")
  }
  return {
    deferred: DEFERRED_BRIDGES,
    disposeAll: async () => {
      for (const registration of registrations) {
        try {
          await registration.dispose()
        } catch (error) {
          log("[hook-bridge] dispose failed", { error: String(error) })
        }
      }
    },
  }
}
