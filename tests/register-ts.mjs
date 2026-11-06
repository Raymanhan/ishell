// Lets `node --test` load app modules that use extensionless imports
// (`../../i18n`), the way the Vite bundler resolves them.
import { register } from "node:module";

register("./resolve-ts.mjs", import.meta.url);
