// Bridge logger. Kept deliberately dependency-free: it must work even if the
// V1 engine fails to initialise its own logger.
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const ENV_DIR = process.env.OMO_V2_BRIDGE_LOG_DIR
const LOG_DIR = ENV_DIR && ENV_DIR.length > 0 ? ENV_DIR : join(homedir(), ".cache", "oh-my-openagent-v2")
const LOG_FILE = join(LOG_DIR, "bridge.log")

let ready = false
function ensureDir() {
  if (ready) return true
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    ready = true
    return true
  } catch {
    return false
  }
}

function serialise(data) {
  if (data === undefined) return ""
  try {
    return ` ${JSON.stringify(data)}`
  } catch {
    return ` ${String(data)}`
  }
}

export function log(message, data) {
  const line = `${new Date().toISOString()} ${message}${serialise(data)}\n`
  if (ensureDir()) {
    try {
      appendFileSync(LOG_FILE, line)
      return
    } catch {
      // fall through to stderr
    }
  }
  try {
    process.stderr.write(line)
  } catch {
    // nothing else we can do
  }
}

export function logError(scope, error) {
  log(`[error] ${scope}`, {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error && error.stack ? error.stack.split("\n").slice(0, 6).join("\n") : undefined,
  })
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const logFilePath = LOG_FILE
