function renderContent(result) {
  return (result.content ?? []).map((item) => item.type === "text" ? item.text : JSON.stringify(item)).join("\n");
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
  const client = new Client({ name: "agent-factory", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

export async function connectMcpTools(capabilities, { connect = defaultConnect } = {}) {
  const clients = [];
  const tools = {};
  try {
    for (const capability of capabilities.filter((item) => item.type === "mcp")) {
      const client = await connect(capability);
      clients.push(client);
      const listed = await client.listTools();
      for (const definition of listed.tools) {
        const name = `${capability.name}__${definition.name}`;
        if (tools[name]) throw new Error(`Duplicate MCP tool: ${name}`);
        tools[name] = {
          description: definition.description ?? `${capability.name} ${definition.name}`,
          parameters: definition.inputSchema ?? { type: "object" },
          execute: async (argumentsValue) => renderContent(await client.callTool({ name: definition.name, arguments: argumentsValue })),
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
