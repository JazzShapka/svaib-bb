// Canonical global and bundled MCP IDs of the shipped methodological plugin.
const svaibMcpServerIds = new Set(['svaib', 'plugin:svaib:svaib']);
export function isSvaibMcpServer(server: unknown): server is string {
  return typeof server === 'string' && svaibMcpServerIds.has(server);
}
