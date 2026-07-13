import test from "node:test";
import assert from "node:assert/strict";
import { chunkText, formatRetrievedContext } from "../src/retriever.js";

test("chunks source by bounded lines with overlap", () => {
  const value = Array.from({ length: 250 }, (_, index) => `line ${index + 1}`).join("\n");
  const chunks = chunkText("src/app.js", value, { linesPerChunk: 100, overlapLines: 20 });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[1].startLine, 81);
  assert.match(chunks[1].content, /^line 81/);
});

test("formats retrieved context within a strict character budget", () => {
  const points = Array.from({ length: 20 }, (_, index) => ({ score: 1 - (index / 100), payload: { path: `src/${index}.js`, startLine: 1, content: "x".repeat(1000) } }));
  const output = formatRetrievedContext(points, 5000);
  assert.ok(output.length <= 5000);
  assert.match(output, /src\/0\.js/);
});
