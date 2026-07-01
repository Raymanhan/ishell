import type { ServerRecord } from "../types";

export function groupServers(servers: ServerRecord[]) {
  const grouped = servers.reduce<Record<string, ServerRecord[]>>((acc, server) => {
    const group = server.group || "Default";
    acc[group] = acc[group] || [];
    acc[group].push(server);
    return acc;
  }, {});

  Object.values(grouped).forEach((list) => {
    list.sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  });

  return grouped;
}
