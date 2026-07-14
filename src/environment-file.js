const keyPattern = /^[A-Z][A-Z0-9_]{0,127}$/;

export function parseEnvironmentFile(content) {
  const result = {};
  for (const line of content.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("Invalid environment line");
    const key = line.slice(0, separator);
    if (!keyPattern.test(key)) throw new Error(`Invalid environment key: ${key}`);
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate environment key: ${key}`);
    const value = line.slice(separator + 1);
    if (value.includes("\0") || value.includes("\r")) throw new Error(`Invalid environment value: ${key}`);
    result[key] = value;
  }
  return result;
}
