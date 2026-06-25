import type { ServerRecord } from "../types";

export function groupServers(servers: ServerRecord[]) {
  return servers.reduce<Record<string, ServerRecord[]>>((acc, server) => {
    const group = server.group || "Default";
    acc[group] = acc[group] || [];
    acc[group].push(server);
    return acc;
  }, {});
}

export function filterServers(servers: ServerRecord[], group: string, query: string) {
  const needle = query.trim().toLowerCase();
  return servers.filter((server) => {
    const inGroup = group === "全部" || server.group === group;
    const haystack = [server.name, server.host, server.username, server.group, ...server.tags]
      .join(" ")
      .toLowerCase();
    return inGroup && (!needle || haystack.includes(needle));
  });
}
