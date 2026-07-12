const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isAllowedChat(chatId, allowed) {
  return allowed.size > 0 && allowed.has(String(chatId));
}

export function parseTelegramCommand(input) {
  const text = String(input ?? "").trim();
  const [rawCommand, repository, ...words] = text.split(/\s+/);
  const command = rawCommand?.split("@")[0];
  if (["/status", "/help"].includes(command) && !repository) return { type: command.slice(1) };
  if (!["/submit", "/goal", "/loop"].includes(command)) throw new Error("Unknown command. Use /help");
  if (!repositoryPattern.test(repository ?? "")) throw new Error("Repository must be OWNER/REPO");
  const objective = words.join(" ").trim();
  if (objective.length < 3) throw new Error("Objective is required");
  if (objective.length > 8000) throw new Error("Objective is too long");
  const prefix = command === "/submit" ? "" : `${command} `;
  return { type: "submit", repository, objective: `${prefix}${objective}` };
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
