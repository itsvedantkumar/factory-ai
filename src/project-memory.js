import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export class ProjectMemory {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, "project-events.jsonl");
  }

  async append(event) {
    await mkdir(this.directory, { recursive: true, mode: 0o750 });
    await appendFile(this.file, `${JSON.stringify({ ...event, recordedAt: new Date().toISOString() })}\n`, { mode: 0o640 });
  }

  async context(repository, limit = 8) {
    let text;
    try { text = await readFile(this.file, "utf8"); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return text.split("\n").filter(Boolean).flatMap((line) => {
      try { const value = JSON.parse(line); return value.repository === repository ? [value] : []; } catch { return []; }
    }).slice(-limit).map((value) => ({
      type: value.type,
      objectiveId: value.objectiveId,
      objective: String(value.objective ?? "").slice(0, 1000),
      executiveIntent: String(value.executiveIntent ?? "").slice(0, 1000),
      pullRequest: value.pullRequest,
      blockers: (value.blockers ?? []).slice(0, 10).map((item) => String(item).slice(0, 300)),
      recordedAt: value.recordedAt,
    }));
  }
}
