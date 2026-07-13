function renderContent(result) {
  const value = (result.content ?? []).map((item) => item.type === "text" ? item.text : JSON.stringify(item)).join("\n");
  return value.length > 32_000 ? `${value.slice(0, 32_000)}\n[TRUNCATED: request narrower MCP output]` : value;
}

async function withTimeout(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); timer.unref?.(); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function defaultConnect(capability) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  const [command, ...args] = capability.command;
  const transport = new StdioClientTransport({
    command,
    args,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? "/tmp",
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/ms-playwright",
      ...(capability.environment ?? {}),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "factory-ai", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

export async function connectMcpTools(capabilities, { connect = defaultConnect } = {}) {
  const clients = [];
  const tools = {};
  try {
    const mcp = capabilities.filter((item) => item.type === "mcp");
    const connected = await Promise.allSettled(mcp.map(async (capability) => {
      const client = await connect(capability);
      const listed = await client.listTools();
      return { capability, client, listed };
    }));
    for (const result of connected) if (result.status === "fulfilled") clients.push(result.value.client);
    const failure = connected.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    for (const { capability, client, listed } of connected.map((result) => result.value)) {
      for (const definition of listed.tools) {
        const name = `${capability.name}__${definition.name}`;
        if (tools[name]) throw new Error(`Duplicate MCP tool: ${name}`);
        tools[name] = {
          description: definition.description ?? `${capability.name} ${definition.name}`,
          parameters: definition.inputSchema ?? { type: "object" },
          execute: async (argumentsValue) => renderContent(await withTimeout(client.callTool({ name: definition.name, arguments: argumentsValue }), capability.timeoutMs ?? 60_000, `MCP tool ${name}`)),
        };
      }
    }
    return {
      tools,
      close: async () => Promise.allSettled(clients.map((client) => client.close())),
    };
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()));
    throw error;
  }
}
