function entries(registry) {
  return [
    ...Object.entries(registry.skills ?? {}).map(([name, definition]) => ({ name, type: "skill", ...definition })),
    ...Object.entries(registry.mcp ?? {}).map(([name, definition]) => ({ name, type: "mcp", ...definition })),
  ];
}

export function validateRegistry(registry) {
  for (const item of entries(registry)) {
    if (!item.version || !/^\d+\.\d+\.\d+$/.test(item.version)) {
      throw new Error(`Capability ${item.name} is not pinned to a semantic version`);
    }
    if (!Array.isArray(item.roles) || item.roles.length === 0) {
      throw new Error(`Capability ${item.name} has no allowed roles`);
    }
    if (item.type === "skill" && !item.path?.startsWith("/")) {
      throw new Error(`Skill ${item.name} must use an absolute path`);
    }
    if (item.type === "mcp" && (!Array.isArray(item.command) || !item.command[0]?.startsWith("/"))) {
      throw new Error(`MCP ${item.name} must use an absolute executable`);
    }
  }
  for (const [role, names] of Object.entries(registry.defaults ?? {})) {
    if (!Array.isArray(names)) throw new Error(`Default capabilities for ${role} must be an array`);
    const available = new Map(entries(registry).map((item) => [item.name, item]));
    for (const name of names) {
      const item = available.get(name);
      if (!item || !item.roles.includes(role)) throw new Error(`Invalid default capability ${name} for ${role}`);
    }
  }
  return registry;
}

export function selectCapabilities(registry, role, requested) {
  validateRegistry(registry);
  const available = new Map(entries(registry).map((item) => [item.name, item]));
  return [...new Set([...(registry.defaults?.[role] ?? []), ...requested])].map((name) => {
    const item = available.get(name);
    if (!item) throw new Error(`Unknown capability: ${name}`);
    if (!item.roles.includes(role)) throw new Error(`Capability ${name} is not allowed for role ${role}`);
    return item;
  });
}
