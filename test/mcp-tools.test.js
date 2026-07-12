import test from "node:test";
import assert from "node:assert/strict";
import { connectMcpTools } from "../src/mcp-tools.js";

test("namespaces MCP tools, forwards calls, and closes every client", async () => {
  const calls = [];
  let closed = 0;
  const capability = { name: "docs", type: "mcp", command: ["/bin/docs"], environment: {} };
  const connected = await connectMcpTools([capability], {
    connect: async () => ({
      listTools: async () => ({ tools: [{ name: "lookup", description: "Look up docs", inputSchema: { type: "object" } }] }),
      callTool: async (request) => { calls.push(request); return { content: [{ type: "text", text: "answer" }] }; },
      close: async () => { closed += 1; },
    }),
  });
  assert.deepEqual(Object.keys(connected.tools), ["docs__lookup"]);
  assert.equal(await connected.tools.docs__lookup.execute({ library: "node" }), "answer");
  assert.deepEqual(calls, [{ name: "lookup", arguments: { library: "node" } }]);
  await connected.close();
  assert.equal(closed, 1);
});

test("rejects duplicate namespaced MCP tools", async () => {
  const duplicate = { name: "docs", type: "mcp", command: ["/bin/docs"] };
  await assert.rejects(() => connectMcpTools([duplicate, duplicate], {
    connect: async () => ({ listTools: async () => ({ tools: [{ name: "lookup", inputSchema: { type: "object" } }] }), close: async () => {} }),
  }), /Duplicate MCP tool/);
});
