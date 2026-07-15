import { parseQuickAction, parseQuickActionFailure, parseQuickActionResult } from "./validation.js";

const terminal = new Set(["succeeded", "failed", "cancelled"]);

function redact(value) {
  return String(value ?? "").replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]").replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
}

export class QuickActionControl {
  constructor({ store, sendTask }) {
    this.store = store;
    this.sendTask = sendTask;
  }

  async acceptAction(value) {
    const action = parseQuickAction(value);
    let state;
    try {
      state = await this.store.read(action.id);
      if (terminal.has(state.status) || state.dispatchedAt) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = { schemaVersion: 1, action, status: "queued", createdAt: action.createdAt };
      await this.store.write(action.id, state);
    }
    await this.sendTask({
      type: "quick_action_task",
      actionId: action.id,
      action,
      task: { id: "respond", role: "scout", title: "Respond to workspace prompt", instructions: action.prompt, dependsOn: [], capabilities: [], complexity: "simple" },
    });
    await this.store.update(action.id, (current) => ({ ...current, dispatchedAt: new Date().toISOString() }));
  }

  async acceptResult(value) {
    const result = parseQuickActionResult(value);
    const safe = { ...result, summary: redact(result.summary), checks: result.checks.map(redact), risks: result.risks.map(redact) };
    await this.store.update(result.actionId, (state) => terminal.has(state.status) ? state : ({ ...state, status: "succeeded", result: safe, completedAt: new Date().toISOString() }));
  }

  async acceptFailure(value) {
    const failure = parseQuickActionFailure(value);
    await this.store.update(failure.actionId, (state) => terminal.has(state.status) ? state : ({ ...state, status: "failed", failure: failure.error, completedAt: new Date().toISOString() }));
  }
}
