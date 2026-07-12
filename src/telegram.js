const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isAllowedChat(chatId, allowed) {
  return allowed.size > 0 && allowed.has(String(chatId));
}

export function parseTelegramCommand(input, defaultRepository) {
  const text = String(input ?? "").trim();
  const [rawCommand, repository, ...words] = text.split(/\s+/);
  const command = rawCommand?.split("@")[0];
  if (!text.startsWith("/") && defaultRepository) {
    if (text.length > 8000) throw new Error("Objective is too long");
    return { type: "submit", repository: defaultRepository, objective: text };
  }
  if (["/status", "/help", "/recent"].includes(command) && !repository) return { type: command.slice(1) };
  if (command === "/objective" && /^[A-Za-z0-9_-]{1,64}$/.test(repository ?? "") && words.length === 0) return { type: "objective", objectiveId: repository };
  if (command === "/repo" && repositoryPattern.test(repository ?? "") && words.length === 0) return { type: "set_repository", repository };
  if (!["/submit", "/goal", "/loop"].includes(command)) throw new Error("Unknown command. Use /help");
  const explicitRepository = repositoryPattern.test(repository ?? "");
  const selectedRepository = explicitRepository ? repository : defaultRepository;
  if (!repositoryPattern.test(selectedRepository ?? "")) throw new Error("Repository must be OWNER/REPO or configured with /repo");
  const objective = (explicitRepository ? words : [repository, ...words]).join(" ").trim();
  if (objective.length < 3) throw new Error("Objective is required");
  if (objective.length > 8000) throw new Error("Objective is too long");
  const prefix = command === "/submit" ? "" : `${command} `;
  return { type: "submit", repository: selectedRepository, objective: `${prefix}${objective}` };
}

export function objectiveFromTelegram(updateId, command, now = new Date()) {
  if (command.type !== "submit" || !Number.isSafeInteger(updateId) || updateId < 0) throw new Error("Invalid Telegram objective input");
  return {
    id: `telegram-${updateId}`,
    type: "objective",
    objective: command.objective,
    repository: `https://github.com/${command.repository}.git`,
    baseBranch: "main",
    createdAt: now.toISOString(),
  };
}

export function formatObjectiveProgress(state) {
  const tasks = state.tasks ?? [];
  const results = state.results ?? {};
  const complete = tasks.filter((task) => results[task.id]?.status === "succeeded").length;
  const lines = [
    `Factory AI objective ${state.objective?.id ?? "unknown"}`,
    state.objective?.objective ?? "",
    `Status: ${state.status ?? "unknown"}`,
    `${complete}/${tasks.length} tasks complete`,
  ];
  for (const task of tasks.slice(0, 20)) lines.push(`${task.role}: ${results[task.id]?.status ?? "blocked"} — ${task.title}`);
  if (state.failure) lines.push(`Blocker: ${String(state.failure).slice(0, 500)}`);
  if (state.release?.url) lines.push(`PR: ${state.release.url}`);
  return lines.join("\n").slice(0, 4000);
}
