#!/usr/bin/env node
import blessed from "neo-blessed";
import { createOperator } from "./operator.js";

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Factory AI UI requires an interactive terminal");

const operator = createOperator();
const screen = blessed.screen({ smartCSR: true, title: "Factory AI", fullUnicode: true, dockBorders: true });
const colors = { bg: "#0d0f12", panel: "#15191f", border: "#303743", text: "#d9e0e8", muted: "#7f8b99", accent: "#78dba9", warn: "#efc46b", danger: "#ef7d7d", blue: "#77a8ff" };

blessed.box({ parent: screen, top: 0, left: 0, width: "100%", height: 3, tags: true, style: { bg: colors.panel, fg: colors.text }, content: "  {bold}{#78dba9-fg}FACTORY AI{/}  {/bold}  private coding organization" });
const menu = blessed.list({ parent: screen, top: 3, left: 0, width: 23, bottom: 2, border: { type: "line" }, label: " Navigate ", keys: true, mouse: true, vi: true, items: ["Overview", "Objectives", "Agents", "Secrets", "Capabilities", "Logs", "Settings"], style: { bg: colors.panel, fg: colors.text, border: { fg: colors.border }, selected: { bg: colors.accent, fg: "#07130d", bold: true }, item: { fg: colors.text } } });
const main = blessed.box({ parent: screen, top: 3, left: 23, right: 0, bottom: 2, border: { type: "line" }, label: " Overview ", tags: true, scrollable: true, alwaysScroll: true, keys: true, mouse: true, vi: true, scrollbar: { ch: "▐", style: { fg: colors.accent } }, padding: { left: 2, right: 2 }, style: { bg: colors.bg, fg: colors.text, border: { fg: colors.border } } });
const footer = blessed.box({ parent: screen, bottom: 0, left: 0, width: "100%", height: 2, tags: true, style: { bg: colors.panel, fg: colors.muted }, content: "  {bold}n{/} new objective   {bold}r{/} refresh   {bold}a{/} add secret   {bold}p/u{/} pause/resume   {bold}q{/} quit" });

let dashboard;
let capabilities;
let secrets;
let logs;
let section = "Overview";

function status(message, color = colors.muted) {
  footer.setContent(`  {${color}-fg}${message}{/}   {bold}n{/} new   {bold}r{/} refresh   {bold}q{/} quit`);
  screen.render();
}

function badge(value) {
  const color = value === "succeeded" || value === "complete" ? colors.accent : value === "failed" || value === "blocked" ? colors.danger : value === "running" ? colors.blue : colors.warn;
  return `{${color}-fg}${value}{/}`;
}

function renderOverview() {
  const cost = dashboard?.cost ? `${dashboard.cost.currency} ${dashboard.cost.monthToDate.toFixed(2)}` : "unavailable";
  const counts = Object.entries(dashboard?.summary?.objectives ?? {}).map(([key, value]) => `${key} ${value}`).join("  ") || "none";
  const recent = (dashboard?.objectives ?? []).slice(-8).reverse().map((objective) => `  ${badge(objective.status.padEnd(9))}  {bold}${objective.objective}{/}\n             ${objective.repository ?? ""}`).join("\n\n");
  main.setContent(`{bold}System{/}\n\n  Queue      {#78dba9-fg}${dashboard?.queue?.active ?? 0}{/}\n  Dead letter ${dashboard?.queue?.deadLetter ?? 0}\n  Azure MTD  {#efc46b-fg}${cost}{/}\n  Objectives ${counts}\n\n{bold}Recent objectives{/}\n\n${recent || "  No objectives yet."}`);
}

function renderObjectives() {
  main.setContent((dashboard?.objectives ?? []).slice().reverse().map((objective) => {
    const tasks = objective.tasks.map((task) => `    ${badge(task.state.padEnd(9))} ${task.role.padEnd(9)} {#7f8b99-fg}${task.model}{/}\n               ${task.title}`).join("\n");
    return `${badge(objective.status)} {bold}${objective.objective}{/}\n  ${objective.id}\n${tasks}${objective.pullRequest ? `\n  PR ${objective.pullRequest}` : ""}${objective.blocker ? `\n  {#ef7d7d-fg}${objective.blocker}{/}` : ""}`;
  }).join("\n\n────────────────────────────────────────────────────────\n\n") || "No objectives." );
}

function renderAgents() {
  const agents = (dashboard?.objectives ?? []).flatMap((objective) => objective.tasks.map((task) => ({ objective: objective.objective, ...task }))).filter((task) => !["succeeded"].includes(task.state));
  main.setContent(agents.map((task) => `${badge(task.state.padEnd(9))} {bold}${task.role}{/}  ${task.model}\n  ${task.title}\n  {#7f8b99-fg}${task.objective}{/}`).join("\n\n") || "No active agents.");
}

function renderSecrets() {
  main.setContent(`{bold}Global Azure Key Vault{/}\n{#7f8b99-fg}Values are never displayed. Press a to add or rotate a secret.{/}\n\n${(secrets ?? []).map((item) => `  {#78dba9-fg}●{/} ${item.name.padEnd(55)} ${item.updated ?? ""}`).join("\n") || "  Loading or empty."}`);
}

function renderCapabilities() {
  const skills = Object.entries(capabilities?.skills ?? {}).map(([name, item]) => `  {#77a8ff-fg}skill{/}  ${name.padEnd(36)} ${item.roles.join(", ")}`).join("\n");
  const mcp = Object.entries(capabilities?.mcp ?? {}).map(([name, item]) => `  {#78dba9-fg}mcp{/}    ${name.padEnd(36)} ${item.roles.join(", ")}`).join("\n");
  main.setContent(`{bold}Skills{/}\n\n${skills}\n\n{bold}MCP servers{/}\n\n${mcp}`);
}

function renderSettings() {
  const config = operator.config();
  main.setContent(`{bold}Runtime{/}\n\n  Resource group  ${config.resourceGroup}\n  VM              ${config.vm}\n  Service Bus     ${config.namespace}\n  Key Vault       ${config.vault}\n\n{bold}Model policy{/}\n\n  Scout           GPT-5.4 nano\n  Simple builder  Kimi K2.7-Code\n  Builder         GPT-5.6\n  Tester          GPT-5.4\n  Critical roles  GPT-5.6\n\n{#7f8b99-fg}Run factory setup to change providers or role routes.{/}`);
}

function render() {
  main.setLabel(` ${section} `);
  if (section === "Overview") renderOverview();
  else if (section === "Objectives") renderObjectives();
  else if (section === "Agents") renderAgents();
  else if (section === "Secrets") renderSecrets();
  else if (section === "Capabilities") renderCapabilities();
  else if (section === "Logs") main.setContent(logs ?? "Loading logs...");
  else renderSettings();
  main.setScrollPerc(0);
  screen.render();
}

async function refresh() {
  status("Refreshing...");
  try {
    dashboard = await operator.dashboard();
    if (section === "Capabilities" && !capabilities) capabilities = await operator.capabilities();
    if (section === "Secrets") secrets = await operator.listSecrets();
    if (section === "Logs") logs = await operator.logs();
    render();
    status(`Updated ${new Date().toLocaleTimeString()}`);
  } catch (error) { status(error.message, colors.danger); }
}

function ask(label, { secret = false } = {}) {
  return new Promise((resolve) => {
    const prompt = blessed.textbox({ parent: screen, top: "center", left: "center", width: "70%", height: 5, border: { type: "line" }, label: ` ${label} `, inputOnFocus: true, keys: true, mouse: true, censor: secret, style: { bg: colors.panel, fg: colors.text, border: { fg: colors.accent } } });
    prompt.focus();
    prompt.readInput((_, value) => { prompt.destroy(); screen.render(); resolve(value?.trim() ?? ""); });
    screen.render();
  });
}

async function submitObjective() {
  const repository = await ask("Repository owner/name");
  if (!repository) return;
  const objective = await ask("CEO objective");
  if (!objective) return;
  status("Submitting objective...");
  try { const result = await operator.submit(repository, objective); status(`Queued ${result.objectiveId ?? "objective"}`, colors.accent); await refresh(); } catch (error) { status(error.message, colors.danger); }
}

async function addSecret() {
  if (section !== "Secrets") return status("Open Secrets before adding a key", colors.warn);
  const name = await ask("Secret name");
  if (!name) return;
  const value = await ask("Secret value", { secret: true });
  if (!value) return;
  status("Storing secret...");
  try { await operator.setSecret(name, value); secrets = await operator.listSecrets(); renderSecrets(); status(`Stored ${name}`, colors.accent); } catch (error) { status(error.message, colors.danger); }
}

menu.on("select", async (_, index) => { section = menu.getItem(index).getText(); render(); await refresh(); menu.focus(); });
screen.key(["q", "C-c"], () => process.exit(0));
screen.key("r", refresh);
screen.key("n", submitObjective);
screen.key("a", addSecret);
screen.key("p", async () => { status("Pausing workers..."); try { await operator.control("pause"); status("Workers paused", colors.warn); } catch (error) { status(error.message, colors.danger); } });
screen.key("u", async () => { status("Resuming workers..."); try { await operator.control("resume"); status("Workers active", colors.accent); } catch (error) { status(error.message, colors.danger); } });
screen.key("tab", () => menu.focus());
menu.focus();
screen.render();
await refresh();
setInterval(refresh, 30_000).unref();
