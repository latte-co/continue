import { useSyncExternalStore } from "react";

let globalVersion = 0;
const hostVersions = new Map<string, number>();
const agentVersions = new Map<string, number>();
const listeners = new Set<() => void>();

function agentKey(hostId: string, agent: string) {
  return JSON.stringify([hostId, agent]);
}

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function bumpModelConfigVersion() {
  globalVersion += 1;
  notify();
}

export function bumpHostModelConfigVersion(hostId: string) {
  hostVersions.set(hostId, (hostVersions.get(hostId) ?? 0) + 1);
  notify();
}

export function bumpAgentModelConfigVersion(hostId: string, agent: string) {
  const key = agentKey(hostId, agent);
  agentVersions.set(key, (agentVersions.get(key) ?? 0) + 1);
  notify();
}

export function getModelConfigVersion(hostId?: string, agent?: string) {
  if (hostId !== undefined && agent !== undefined) {
    return (
      globalVersion +
      (hostVersions.get(hostId) ?? 0) +
      (agentVersions.get(agentKey(hostId, agent)) ?? 0)
    );
  }
  if (hostId !== undefined) {
    return globalVersion + (hostVersions.get(hostId) ?? 0);
  }
  let total = globalVersion;
  for (const count of hostVersions.values()) total += count;
  for (const count of agentVersions.values()) total += count;
  return total;
}

export function useModelConfigVersion(hostId: string, agent?: string) {
  return useSyncExternalStore(subscribe, () =>
    getModelConfigVersion(hostId, agent),
  );
}
