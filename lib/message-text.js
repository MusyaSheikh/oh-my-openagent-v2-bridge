// Convert V2 session messages (ctx.session.context) into the V1
// { info, parts } views the omo engine consumes.
//
// Every conversion is defensive: the V2 schema is Effect-decoded, so timestamps
// may arrive as numbers, Dates, ISO strings or DateTime objects depending on the
// host version. Losing a field is acceptable; throwing is not.

export function toMillis(value) {
  if (value === undefined || value === null) return 0
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  if (value instanceof Date) return value.getTime()
  if (typeof value === "object") {
    if (typeof value.epochMillis === "number") return value.epochMillis
    if (typeof value.epochMilliseconds === "number") return value.epochMilliseconds
    if (typeof value.toMillis === "function") {
      try {
        const result = value.toMillis()
        if (typeof result === "number" && Number.isFinite(result)) return result
      } catch {
        // ignore
      }
    }
    if (typeof value.value === "number") return value.value
  }
  return 0
}

function textOfPart(part) {
  if (!part || typeof part !== "object") return undefined
  if (part.type === "text" && typeof part.text === "string") return part.text
  return undefined
}

function toolState(state) {
  const status = state && typeof state.status === "string" ? state.status : "pending"
  const input = state && typeof state.input === "object" && state.input !== null ? state.input : {}
  const now = Date.now()
  if (status === "completed") {
    const content = Array.isArray(state.content) ? state.content : []
    const output = content
      .map((part) => (part && part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .filter((text) => text.length > 0)
      .join("\n")
    return {
      status: "completed",
      input,
      output,
      title: "",
      metadata: state.metadata && typeof state.metadata === "object" ? state.metadata : {},
      time: { start: now, end: now },
    }
  }
  if (status === "error") {
    const error = state.error
    return {
      status: "error",
      input,
      error: error && typeof error.message === "string" ? error.message : "unknown tool error",
      time: { start: now, end: now },
    }
  }
  if (status === "running") return { status: "running", input, time: { start: now } }
  if (status === "streaming") return { status: "running", input, time: { start: now } }
  return { status: "pending", input, raw: "" }
}

function baseInfo(message, sessionID, role) {
  const info = {
    id: message.id,
    sessionID,
    role,
    time: { created: toMillis(message.time && message.time.created) },
  }
  if (message.agent) info.agent = message.agent
  return info
}

function userInfo(message, sessionID) {
  const info = baseInfo(message, sessionID, "user")
  const model = message.model
  if (model && typeof model === "object") {
    info.model = {
      providerID: typeof model.providerID === "string" ? model.providerID : "",
      modelID: typeof model.id === "string" ? model.id : "",
    }
  }
  return info
}

function assistantInfo(message, sessionID) {
  const model = message.model && typeof message.model === "object" ? message.model : {}
  const tokens = message.tokens && typeof message.tokens === "object" ? message.tokens : {}
  const info = baseInfo(message, sessionID, "assistant")
  info.time = {
    created: toMillis(message.time && message.time.created),
    completed: toMillis(message.time && message.time.completed),
  }
  info.parentID = ""
  info.modelID = typeof model.id === "string" ? model.id : ""
  info.providerID = typeof model.providerID === "string" ? model.providerID : ""
  info.mode = ""
  info.path = { cwd: "", root: "" }
  info.cost = typeof message.cost === "number" ? message.cost : 0
  info.tokens = {
    input: typeof tokens.input === "number" ? tokens.input : 0,
    output: typeof tokens.output === "number" ? tokens.output : 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
  if (typeof model.variant === "string") info.variant = model.variant
  return info
}

function asUserRole(message, sessionID) {
  return baseInfo(message, sessionID, "user")
}

export function toV1MessageViews(messages, sessionID) {
  const views = []
  for (const message of messages ?? []) {
    if (!message || typeof message !== "object") continue
    const type = message.type
    if (type === "user") {
      const parts = []
      const text = typeof message.text === "string" ? message.text : ""
      if (text) {
        parts.push({ id: message.id, sessionID, messageID: message.id, type: "text", text })
      }
      views.push({ info: userInfo(message, sessionID), parts })
      continue
    }
    if (type === "assistant") {
      const parts = []
      const content = Array.isArray(message.content) ? message.content : []
      for (const part of content) {
        const text = textOfPart(part)
        if (text !== undefined) {
          parts.push({ id: `${message.id}_text`, sessionID, messageID: message.id, type: "text", text })
          continue
        }
        if (part && part.type === "tool" && typeof part.name === "string") {
          parts.push({
            id: typeof part.id === "string" ? part.id : `${message.id}_tool`,
            sessionID,
            messageID: message.id,
            type: "tool",
            callID: typeof part.id === "string" ? part.id : `${message.id}_tool`,
            tool: part.name,
            state: toolState(part.state),
          })
        }
      }
      views.push({ info: assistantInfo(message, sessionID), parts })
      continue
    }
    if (type === "system" || type === "synthetic" || type === "skill" || type === "shell") {
      const text = typeof message.text === "string" ? message.text : ""
      const parts = text ? [{ id: message.id, sessionID, messageID: message.id, type: "text", text }] : []
      views.push({ info: asUserRole(message, sessionID), parts })
      continue
    }
    if (type === "compaction") {
      const summary =
        typeof message.summary === "string"
          ? message.summary
          : typeof message.text === "string"
            ? message.text
            : ""
      const parts = summary ? [{ id: message.id, sessionID, messageID: message.id, type: "text", text: summary }] : []
      views.push({ info: asUserRole(message, sessionID), parts })
    }
  }
  return views
}

export function extractV1Text(parts) {
  if (!Array.isArray(parts)) return ""
  const texts = []
  for (const part of parts) {
    if (part && part.type === "text" && typeof part.text === "string" && !part.synthetic) texts.push(part.text)
  }
  return texts.join("\n")
}

export function lastAssistantAgent(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message && message.type === "assistant" && message.agent) return message.agent
  }
  return undefined
}
