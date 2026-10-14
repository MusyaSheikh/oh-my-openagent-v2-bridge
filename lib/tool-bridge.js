// V1 tool definition -> V2 tool registration.
//
// V1 tools carry a zod raw shape (`z.ZodRawShape`). V2 tool definitions accept a
// JSON Schema, an Effect Schema or a StandardSchema. The omo engine attaches a
// sanitised per-arg `toJSONSchema` override to every arg schema, so the most
// faithful conversion is: build one object schema with the vendored zod, which
// reuses those per-arg overrides through zod's own reflection.
import { z } from "zod"
import { log } from "./logger.js"

const PERMISSIVE = { type: "object", properties: {}, additionalProperties: true }

function stripRoot(schema) {
  if (schema && typeof schema === "object" && "$schema" in schema) {
    const { $schema, ...rest } = schema
    return rest
  }
  return schema
}

function argOverride(schema) {
  try {
    if (schema && schema._zod && typeof schema._zod.toJSONSchema === "function") {
      return stripRoot(schema._zod.toJSONSchema())
    }
  } catch {
    // fall through
  }
  return undefined
}

export function toJsonSchema(args) {
  if (!args || typeof args !== "object") return PERMISSIVE
  try {
    const built = z.toJSONSchema(z.object(args), { io: "input" })
    if (built && built.type === "object") return stripRoot(built)
  } catch (error) {
    log("[tool-bridge] z.toJSONSchema(object) failed; assembling per-arg", { error: String(error) })
  }
  try {
    const properties = {}
    const required = []
    for (const [name, schema] of Object.entries(args)) {
      const converted = argOverride(schema)
      if (!converted) return PERMISSIVE
      properties[name] = converted
      const optin = schema && schema._zod ? schema._zod.optin : undefined
      if (optin !== "optional") required.push(name)
    }
    return { type: "object", properties, required, additionalProperties: false }
  } catch (error) {
    log("[tool-bridge] per-arg JSON schema assembly failed", { error: String(error) })
    return PERMISSIVE
  }
}

function resultToV2(result) {
  if (typeof result === "string") return { content: result }
  if (result && typeof result === "object") {
    const content = typeof result.output === "string" ? result.output : ""
    const metadata = result.metadata && typeof result.metadata === "object" ? result.metadata : undefined
    return metadata ? { content, metadata } : { content }
  }
  return { content: String(result ?? "") }
}

export function convertV1Tool(name, definition, deps) {
  const input = toJsonSchema(definition.args)
  return {
    name,
    input,
    description: definition.description ?? "",
    execute: async (toolInput, context) => {
      let directory = deps.defaultDirectory
      try {
        directory = (await deps.resolveDirectory(context.sessionID)) || deps.defaultDirectory
      } catch {
        directory = deps.defaultDirectory
      }
      const v1context = {
        sessionID: context.sessionID,
        messageID: context.messageID,
        agent: context.agent,
        directory,
        worktree: deps.worktree ?? directory,
        abort: context.signal,
        metadata: (entry) => {
          const payload = {}
          if (entry && typeof entry === "object") {
            if (entry.title) payload.title = entry.title
            if (entry.metadata) Object.assign(payload, entry.metadata)
          }
          void context.progress(payload).catch(() => {})
        },
        ask: async () => {},
      }
      const result = await definition.execute(toolInput, v1context)
      return resultToV2(result)
    },
  }
}

export { resultToV2 }
