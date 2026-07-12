import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class StateStore {
  #locks = new Map();

  constructor(root) {
    this.root = root;
  }

  objectiveDir(id) {
    return path.join(this.root, id);
  }

  async read(id) {
    return JSON.parse(await readFile(path.join(this.objectiveDir(id), "state.json"), "utf8"));
  }

  async write(id, value) {
    const directory = this.objectiveDir(id);
    await mkdir(directory, { recursive: true, mode: 0o750 });
    const temporary = path.join(directory, `state.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
    await rename(temporary, path.join(directory, "state.json"));
    return value;
  }

  async update(id, operation) {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const state = await this.read(id);
      return this.write(id, await operation(state));
    });
    this.#locks.set(id, current);
    try {
      return await current;
    } finally {
      if (this.#locks.get(id) === current) this.#locks.delete(id);
    }
  }

  async writeResult(id, result) {
    const directory = this.objectiveDir(id);
    const output = path.join(directory, "result.json");
    const temporary = path.join(directory, `result.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o640 });
    await rename(temporary, output);
  }
}
