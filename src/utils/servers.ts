import type { ServerRecord } from "../types";

export function groupServers(servers: ServerRecord[]) {
  return servers.reduce<Record<string, ServerRecord[]>>((acc, server) => {
    const group = server.group || "Default";
    acc[group] = acc[group] || [];
    acc[group].push(server);
    return acc;
  }, {});
}
