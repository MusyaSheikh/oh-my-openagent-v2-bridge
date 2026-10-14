// ESM loader that maps the OpenCode runtime virtual module to a local stub so the
// bridge can be exercised with plain Node.
import { pathToFileURL } from "node:url"

const STUB = new URL("./stub-opencode-plugin.mjs", import.meta.url)

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@opencode/plugin" || specifier.startsWith("@opencode/plugin/")) {
    return { url: STUB.href, shortCircuit: true }
  }
  if (specifier === "@opencode/client/service" || specifier === "@opencode/client") {
    return { url: STUB.href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export const pathToFileURLRef = pathToFileURL
