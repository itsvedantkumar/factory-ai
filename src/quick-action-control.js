import { parseQuickAction, parseQuickActionFailure, parseQuickActionResult } from "./validation.js";
import { redactSecrets } from "./redaction.js";

const terminal = new Set(["succeeded", "failed", "cancelled"]);

export class QuickActionControl {
  constructor({ store, sendTask, publish = async () => {} }) {
    this.store = store;
    this.sendTask = sendTask;
    this.publish = publish;
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
    state = await this.store.update(action.id, (current) => ({ ...current, dispatchedAt: new Date().toISOString() }));
    await this.publish(state);
  }

  async acceptResult(value) {
    const result = parseQuickActionResult(value);
    const safe = { ...result, summary: redactSecrets(result.summary), checks: result.checks.map(redactSecrets), risks: result.risks.map(redactSecrets) };
    const state = await this.store.update(result.actionId, (current) => terminal.has(current.status) ? current : ({ ...current, status: "succeeded", result: safe, completedAt: new Date().toISOString() }));
    await this.publish(state);
  }

  async acceptFailure(value) {
    const failure = parseQuickActionFailure(value);
    const state = await this.store.update(failure.actionId, (current) => terminal.has(current.status) ? current : ({ ...current, status: "failed", failure: redactSecrets(failure.error), completedAt: new Date().toISOString() }));
    await this.publish(state);
  }
}
