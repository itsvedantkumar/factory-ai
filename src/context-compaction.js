function oneLine(value) {
  return String(value ?? "").replaceAll(/\s+/g, " ").trim();
}

export function compactCheckpoint(prompt, trace, { maxCharacters = 24_000, immutableContext = prompt } = {}) {
  const header = "COMPACTED EXECUTION CHECKPOINT\nContinue the original objective using this verified recent tool evidence. Re-read files when exact content matters.\n\n";
  const objectiveBudget = Math.max(200, Math.floor(maxCharacters * 0.4));
  const objective = `IMMUTABLE OBJECTIVE AND INSTRUCTIONS\n${String(immutableContext).slice(0, objectiveBudget)}\n\nRECENT TOOL EVIDENCE\n`;
  let evidence = "";
  for (const item of [...trace].reverse()) {
    const line = `- ${oneLine(item.tool)}${item.status === "error" ? " [error]" : ""}: ${oneLine(item.output).slice(0, 2000)}\n`;
    if (header.length + objective.length + evidence.length + line.length > maxCharacters) continue;
    evidence = line + evidence;
  }
  return `${header}${objective}${evidence || "- No retained tool output.\n"}`.slice(0, maxCharacters);
}
