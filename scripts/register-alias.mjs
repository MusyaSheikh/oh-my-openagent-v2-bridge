// Registers the alias loader for `node --import ./scripts/register-alias.mjs`.
import { register } from "node:module"

register("./alias-loader.mjs", import.meta.url)
