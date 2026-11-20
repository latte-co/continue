import { useSyncExternalStore } from "react";

let version = 0;
const listeners = new Set<() => void>();

export function bumpModelConfigVersion() {
  version += 1;
  for (const listener of listeners) listener();
}

export function getModelConfigVersion() {
  return version;
}

export function useModelConfigVersion() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, getModelConfigVersion);
}
