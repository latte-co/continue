import { useSyncExternalStore } from "react";

const requested = new Set<string>();
const listeners = new Set<() => void>();

function scopeKey(hostId: string, sideId: string) {
  return JSON.stringify([hostId, sideId]);
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

export function parsePendingSideWriteSessionId(
  errorMessage: string,
): string | null {
  const match = /具备写权限的侧边聊天（([^）]+)）的写入结束时间待确认/.exec(
    errorMessage,
  );
  return match?.[1] ?? null;
}

export function requestSideWriteConfirmation(hostId: string, sideId: string) {
  const target = scopeKey(hostId, sideId);
  if (requested.has(target)) return;
  requested.add(target);
  notify();
}

export function clearSideWriteConfirmation(hostId: string, sideId: string) {
  if (!requested.delete(scopeKey(hostId, sideId))) return;
  notify();
}

export function useSideWriteConfirmationRequested(
  hostId: string,
  sideId: string,
) {
  return useSyncExternalStore(subscribe, () =>
    requested.has(scopeKey(hostId, sideId)),
  );
}
