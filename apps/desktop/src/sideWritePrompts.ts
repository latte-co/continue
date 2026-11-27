import { useSyncExternalStore } from "react";

let nextVersion = 0;
const requested = new Map<string, number>();
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

export function sideWriteConfirmationVersion(hostId: string, sideId: string) {
  return requested.get(scopeKey(hostId, sideId)) ?? 0;
}

export function requestSideWriteConfirmation(hostId: string, sideId: string) {
  requested.set(scopeKey(hostId, sideId), ++nextVersion);
  notify();
}

export function clearSideWriteConfirmation(
  hostId: string,
  sideId: string,
  maxVersion?: number,
) {
  const target = scopeKey(hostId, sideId);
  const current = requested.get(target);
  if (current === undefined) return;
  if (maxVersion !== undefined && current > maxVersion) return;
  requested.delete(target);
  notify();
}

export function useSideWriteConfirmationVersion(
  hostId: string,
  sideId: string,
) {
  return useSyncExternalStore(subscribe, () =>
    sideWriteConfirmationVersion(hostId, sideId),
  );
}

export function useSideWriteConfirmationRequested(
  hostId: string,
  sideId: string,
) {
  return useSyncExternalStore(subscribe, () =>
    requested.has(scopeKey(hostId, sideId)),
  );
}
