import { run } from "./process.js";

const sourceGlob = "*.{c,cc,cpp,cs,go,h,hpp,java,js,jsx,php,py,rb,rs,sh,ts,tsx}";
const excludedGlobs = [
  "!**/.git/**",
  "!**/.next/**",
  "!**/.turbo/**",
  "!**/build/**",
  "!**/coverage/**",
  "!**/dist/**",
  "!**/generated/**",
  "!**/node_modules/**",
  "!**/vendor/**",
  "!**/*.generated.*",
  "!**/*.min.*",
];
const symbolPattern = String.raw`^\s*(?:(?:export|public|private|protected|static)\s+)*(?:async\s+)?(?:class|def|enum|fn|func|function|interface|struct|trait|type|const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*`;
const stopWords = new Set(["and", "for", "from", "into", "the", "this", "with"]);

function objectiveTerms(objective) {
  return [...new Set(String(objective).toLowerCase().match(/[a-z_$][a-z0-9_$-]{2,}/g) ?? [])]
    .filter((term) => !stopWords.has(term))
    .sort();
}

function rgArgs(pattern) {
  return [
    "--line-number", "--no-heading", "--color", "never", "--max-count", "20", "--max-filesize", "256K",
    "--glob", sourceGlob,
    ...excludedGlobs.flatMap((glob) => ["--glob", glob]),
    "--regexp", pattern,
    ".",
  ];
}

async function extract(directory, pattern) {
  if (!pattern) return [];
  const { stdout } = await run("rg", rgArgs(pattern), {
    cwd: directory,
    allowExitCodes: [0, 1],
    timeoutMs: 15_000,
    maxOutputBytes: 5_000_000,
  });
  return stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\.\/(.*?):(\d+):(.*)$/);
    if (!match) return [];
    return [{ path: match[1], startLine: Number(match[2]), endLine: Number(match[2]), content: match[3].trim().slice(0, 500) }];
  });
}

function keyFor(entry) {
  return `${entry.path}:${entry.startLine}:${entry.endLine}`;
}

function rank(entries, terms) {
  const byRange = new Map();
  for (const entry of entries) {
    const path = entry.path.toLowerCase();
    const content = entry.content.toLowerCase();
    const score = 1 + terms.reduce((total, term) => total + (path.includes(term) ? 8 : 0) + (content.includes(term) ? 3 : 0), 0);
    const ranked = { ...entry, score };
    const previous = byRange.get(keyFor(ranked));
    if (!previous || ranked.score > previous.score || (ranked.score === previous.score && ranked.content < previous.content)) byRange.set(keyFor(ranked), ranked);
  }
  return [...byRange.values()].sort((a, b) => b.score - a.score
    || a.path.localeCompare(b.path)
    || a.startLine - b.startLine
    || a.endLine - b.endLine
    || a.content.localeCompare(b.content));
}

function entriesWithinBudget(entries, maxCharacters, heading) {
  let length = `${heading}\n`.length;
  const selected = [];
  for (const entry of entries) {
    const section = `--- ${entry.path}:${entry.startLine}-${entry.endLine} score=${Number(entry.score ?? 0).toFixed(3)} ---\n${entry.content}\n`;
    if (length + section.length > maxCharacters) continue;
    selected.push(entry);
    length += section.length;
  }
  return selected;
}

export function formatRepositoryEntries(entries, maxCharacters, heading = "REPOSITORY MAP (ranked symbols and objective references)") {
  if (maxCharacters <= 0) return "";
  let output = `${heading}\n`;
  for (const entry of entriesWithinBudget(entries, maxCharacters, heading)) {
    output += `--- ${entry.path}:${entry.startLine}-${entry.endLine} score=${Number(entry.score ?? 0).toFixed(3)} ---\n${entry.content}\n`;
  }
  return output.length <= maxCharacters ? output.trimEnd() : output.slice(0, maxCharacters);
}

export async function buildRepositoryMap(directory, objective, { maxCharacters = 8000 } = {}) {
  const terms = objectiveTerms(objective);
  const referencePattern = terms.length ? terms.map((term) => term.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") : "";
  const [symbols, references] = await Promise.all([
    extract(directory, symbolPattern),
    extract(directory, referencePattern),
  ]);
  const ranked = rank([...symbols, ...references], terms);
  const heading = "REPOSITORY MAP (ranked symbols and objective references)";
  const entries = entriesWithinBudget(ranked, maxCharacters, heading);
  return { entries, text: formatRepositoryEntries(entries, maxCharacters) };
}

export function mergeRepositoryContext(repositoryEntries, semanticPoints, maxCharacters = 12_000) {
  const occupied = new Set(repositoryEntries.map(keyFor));
  const byRange = new Map();
  for (const point of semanticPoints) {
    const entry = {
    path: point.payload?.path ?? "",
    startLine: Number(point.payload?.startLine ?? 0),
    endLine: Number(point.payload?.endLine ?? point.payload?.startLine ?? 0),
    content: String(point.payload?.content ?? ""),
    score: Number(point.score ?? 0),
    };
    const key = keyFor(entry);
    const previous = byRange.get(key);
    if (entry.path && !occupied.has(key) && (!previous || entry.score > previous.score || (entry.score === previous.score && entry.content < previous.content))) byRange.set(key, entry);
  }
  const semanticEntries = [...byRange.values()].sort((a, b) => b.score - a.score
    || a.path.localeCompare(b.path)
    || a.startLine - b.startLine
    || a.endLine - b.endLine
    || a.content.localeCompare(b.content));
  const semanticText = formatRepositoryEntries(semanticEntries, maxCharacters, "LOCAL SEMANTIC CONTEXT");
  return { entries: [...repositoryEntries, ...semanticEntries], semanticText };
}
