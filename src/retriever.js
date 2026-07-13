import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { run } from "./process.js";
import { mergeRepositoryContext } from "./repo-map.js";

const textExtensions = new Set([".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx", ".json", ".md", ".mdx", ".php", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".svelte", ".toml", ".ts", ".tsx", ".vue", ".yaml", ".yml"]);
const ignoredDirectories = new Set([".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules", "vendor"]);

export function chunkText(file, value, { linesPerChunk = 120, overlapLines = 20 } = {}) {
  const lines = value.split("\n");
  const chunks = [];
  const step = Math.max(1, linesPerChunk - overlapLines);
  for (let start = 0; start < lines.length; start += step) {
    const content = lines.slice(start, start + linesPerChunk).join("\n").trim();
    if (content) chunks.push({ path: file, startLine: start + 1, endLine: Math.min(lines.length, start + linesPerChunk), content });
    if (start + linesPerChunk >= lines.length) break;
  }
  return chunks;
}

export function formatRetrievedContext(points, maxCharacters = 12_000, repositoryEntries = []) {
  return mergeRepositoryContext(repositoryEntries, points, maxCharacters).semanticText;
}

async function collectFiles(directory, root, output, limits) {
  if (output.length >= limits.maxFiles) return;
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink?.() || ignoredDirectories.has(entry.name) || output.length >= limits.maxFiles) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(absolute, root, output, limits);
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) {
      const metadata = await lstat(absolute);
      if (metadata.size <= limits.maxFileBytes) output.push({ absolute, relative: path.relative(root, absolute) });
    }
  }
}

async function workspaceRevision(directory) {
  const head = (await run("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim();
  const status = (await run("git", ["-C", directory, "status", "--porcelain=v1"], { maxOutputBytes: 200_000 })).stdout;
  if (!status) return head;
  const diff = (await run("git", ["-C", directory, "diff", "--binary", "HEAD"], { maxOutputBytes: 2_000_000 })).stdout;
  return `${head}-worktree-${createHash("sha256").update(status).update(diff).digest("hex").slice(0, 16)}`;
}

function pointId(value) {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export class LocalRetriever {
  #locks = new Map();

  constructor({
    stateDir,
    ollamaUrl = "http://127.0.0.1:11434",
    qdrantUrl = "http://127.0.0.1:6333",
    model = "embeddinggemma",
    collection = "factory_ai_code",
    fetch = globalThis.fetch,
  }) {
    this.stateDir = stateDir;
    this.manifestFile = path.join(stateDir, "retrieval", "manifest.json");
    this.ollamaUrl = ollamaUrl;
    this.qdrantUrl = qdrantUrl;
    this.model = model;
    this.collection = collection;
    this.fetch = fetch;
  }

  async request(url, options = {}) {
    const response = await this.fetch(url, { ...options, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Local retrieval HTTP ${response.status}: ${url}`);
    return response.status === 204 ? {} : response.json();
  }

  async embed(input) {
    const result = await this.request(`${this.ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input }),
    });
    return result.embeddings;
  }

  async loadManifest() {
    try { return JSON.parse(await readFile(this.manifestFile, "utf8")); } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  }

  async saveManifest(value) {
    await mkdir(path.dirname(this.manifestFile), { recursive: true, mode: 0o750 });
    const temporary = `${this.manifestFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
    await rename(temporary, this.manifestFile);
  }

  async ensureIndexed(directory, repository) {
    const previous = this.#locks.get(repository) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.#index(directory, repository));
    this.#locks.set(repository, current);
    try { return await current; } finally { if (this.#locks.get(repository) === current) this.#locks.delete(repository); }
  }

  async #index(directory, repository) {
    const commit = await workspaceRevision(directory);
    const manifest = await this.loadManifest();
    if (manifest[repository]?.[commit]?.model === this.model) return false;
    const files = [];
    await collectFiles(directory, directory, files, { maxFiles: 2000, maxFileBytes: 256_000 });
    const chunks = [];
    for (const file of files) {
      const value = await readFile(file.absolute, "utf8");
      chunks.push(...chunkText(file.relative, value));
      if (chunks.length >= 5000) break;
    }
    const selected = chunks.slice(0, 5000);
    if (selected.length === 0) return false;
    const sample = await this.embed([`${selected[0].path}\n${selected[0].content}`]);
    const vectorSize = sample[0].length;
    const collectionResponse = await this.fetch(`${this.qdrantUrl}/collections/${this.collection}`, { signal: AbortSignal.timeout(30_000) });
    if (collectionResponse.status === 404) {
      await this.request(`${this.qdrantUrl}/collections/${this.collection}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ vectors: { size: vectorSize, distance: "Cosine" } }),
      });
    } else if (!collectionResponse.ok) throw new Error(`Qdrant collection HTTP ${collectionResponse.status}`);
    for (let start = 0; start < selected.length; start += 32) {
      const batch = selected.slice(start, start + 32);
      const remaining = batch.slice(1);
      const embeddings = start === 0
        ? [sample[0], ...(remaining.length ? await this.embed(remaining.map((item) => `${item.path}\n${item.content}`)) : [])]
        : await this.embed(batch.map((item) => `${item.path}\n${item.content}`));
      const points = batch.map((item, index) => ({ id: pointId(`${repository}:${commit}:${item.path}:${item.startLine}`), vector: embeddings[index], payload: { repository, commit, ...item } }));
      await this.request(`${this.qdrantUrl}/collections/${this.collection}/points?wait=true`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ points }),
      });
    }
    manifest[repository] = { ...(manifest[repository]?.commit ? {} : manifest[repository]), [commit]: { model: this.model, chunks: selected.length, indexedAt: new Date().toISOString() } };
    await this.saveManifest(manifest);
    return true;
  }

  async context(directory, repository, query, { limit = 8, maxCharacters = 12_000, repositoryEntries = [] } = {}) {
    await this.ensureIndexed(directory, repository);
    const commit = await workspaceRevision(directory);
    const [vector] = await this.embed([query]);
    const result = await this.request(`${this.qdrantUrl}/collections/${this.collection}/points/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: vector, filter: { must: [{ key: "repository", match: { value: repository } }, { key: "commit", match: { value: commit } }] }, limit, with_payload: true }),
    });
    return formatRetrievedContext(result.result?.points ?? [], maxCharacters, repositoryEntries);
  }
}
