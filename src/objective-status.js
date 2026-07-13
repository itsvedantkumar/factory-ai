import { readFile } from "node:fs/promises";
import path from "node:path";

const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;
const TERMINAL = new Set(["complete", "failed", "blocked", "cancelled", "denied", "expired"]);

export async function objectiveIsTerminal(stateDir, objectiveId) {
  if (!IDENTIFIER.test(objectiveId ?? "")) return false;
  try {
    const state = JSON.parse(await readFile(path.join(stateDir, objectiveId, "state.json"), "utf8"));
    return TERMINAL.has(state.status);
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}
