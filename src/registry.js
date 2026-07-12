import { readFile } from "node:fs/promises";
import { validateRegistry } from "./capabilities.js";

export async function loadRegistry(file) {
  return validateRegistry(JSON.parse(await readFile(file, "utf8")));
}
