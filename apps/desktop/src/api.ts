import {
  HOST_DISCONNECTED_EVENT,
  HOST_CONNECTION_PREFIX,
  HostConnectionError,
} from "./connectionErrors";
import { invoke } from "@tauri-apps/api/core";
import {
  bumpAgentModelConfigVersion,
  bumpHostModelConfigVersion,
  bumpModelConfigVersion,
} from "./modelConfigVersion";
import type { AgentProviderBinding, Request, Response } from "./protocol";
export interface Host {
  id: string;
  name: string;
  ssh: string | null;
  server_path: string | null;
  auth?: "none" | "identity_file" | "password";
  identity_file?: string | null;
  port?: number | null;
}
export const localHost: Host = {
  id: "local",
  name: "本机",
  ssh: null,
  server_path: null,
};
export const native = "__TAURI_INTERNALS__" in window;
const connectionGenerations = new Map<string, number>();
const changePreviewSupport = new Map<string, boolean>();
const connections = new Map<
  string,
  { signature: string; promise: Promise<Response> }
>();
export function connect(host: Host, password?: string): Promise<Response> {
  const signature = JSON.stringify(host);
  const pending = connections.get(host.id);
  if (pending?.signature === signature && password === undefined)
    return pending.promise;
  const invokeConnection = () => {
    connectionGenerations.set(
      host.id,
      (connectionGenerations.get(host.id) ?? 0) + 1,
    );
    const generation = connectionGenerations.get(host.id);
    changePreviewSupport.delete(host.id);
    return invoke<Response>("connect_host", { host, password }).then(
      (response) => {
        if (
          generation === connectionGenerations.get(host.id) &&
          response.kind === "hello"
        )
          changePreviewSupport.set(host.id, response.change_preview === true);
        return response;
      },
    );
  };
  const promise = (
    pending
      ? pending.promise.catch(() => undefined).then(invokeConnection)
      : invokeConnection()
  ).finally(() => {
    if (connections.get(host.id)?.promise === promise)
      connections.delete(host.id);
  });
  connections.set(host.id, { signature, promise });
  return promise;
}
export function disconnect(hostId: string): Promise<void> {
  changePreviewSupport.delete(hostId);
  connectionGenerations.set(
    hostId,
    (connectionGenerations.get(hostId) ?? 0) + 1,
  );
  return invoke("disconnect_host", { hostId });
}
export function chooseProjectFolder(): Promise<string | null> {
  return invoke("choose_project_folder");
}
export function chooseReferencePath(
  directory: boolean,
): Promise<string | null> {
  return invoke("choose_reference_path", { directory });
}
export function chooseIdentityFile(): Promise<string | null> {
  return invoke("choose_identity_file");
}
export class ServerRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServerRequestError";
  }
}
export async function request(
  hostId: string,
  request: Request,
): Promise<Response> {
  if (
    request.method === "preview_change" &&
    changePreviewSupport.get(hostId) !== true
  )
    throw new ServerRequestError(
      "unsupported",
      "Server 不支持变更图片预览，请更新后重试",
    );
  const generation = connectionGenerations.get(hostId);
  let response: Response;
  try {
    response = await invoke<Response>("host_request", { hostId, request });
  } catch (cause) {
    const detail = message(cause);
    if (!detail.startsWith(HOST_CONNECTION_PREFIX)) throw cause;
    const error = new HostConnectionError(
      hostId,
      detail.slice(HOST_CONNECTION_PREFIX.length),
    );
    if (generation === connectionGenerations.get(hostId)) {
      changePreviewSupport.delete(hostId);
      window.dispatchEvent(
        new CustomEvent(HOST_DISCONNECTED_EVENT, { detail: error }),
      );
    }
    throw error;
  }
  if (response.kind === "error")
    throw new ServerRequestError(response.code, response.message);
  return response;
}
let knownRemoteHosts: Map<string, string> | null = null;
let allProviderBindingsLoaded = false;
const providerBindings = new Map<
  string,
  { hostId: string; agent: string; providerId: string }
>();

function snapshotRemoteHosts(hosts: Host[]) {
  return new Map(
    hosts
      .filter((host) => host.id !== "local")
      .map((host) => [host.id, JSON.stringify(host)]),
  );
}

function diffRemoteHosts(
  previous: Map<string, string> | null,
  next: Map<string, string>,
) {
  if (!previous) return Array.from(next.keys());
  const changed = new Set<string>();
  for (const [id, serialized] of previous) {
    if (next.get(id) !== serialized) changed.add(id);
  }
  for (const [id, serialized] of next) {
    if (previous.get(id) !== serialized) changed.add(id);
  }
  return Array.from(changed);
}

function recordBindings(
  bindings: AgentProviderBinding[],
  fallbackHostId?: string,
) {
  if (fallbackHostId === undefined) {
    providerBindings.clear();
    allProviderBindingsLoaded = true;
  } else {
    for (const [key, entry] of Array.from(providerBindings.entries())) {
      if (entry.hostId === fallbackHostId) providerBindings.delete(key);
    }
  }
  for (const binding of bindings) {
    const hostId = binding.host_id ?? fallbackHostId ?? "local";
    providerBindings.set(JSON.stringify([hostId, binding.agent]), {
      hostId,
      agent: binding.agent,
      providerId: binding.provider_id,
    });
  }
}

function collectBoundAgents(providerId: string) {
  const targets = new Map<string, { hostId: string; agent: string }>();
  for (const [key, entry] of providerBindings) {
    if (entry.providerId === providerId) {
      targets.set(key, { hostId: entry.hostId, agent: entry.agent });
    }
  }
  return targets;
}

export async function loadHosts(): Promise<Host[]> {
  const remoteHosts = await invoke<Host[]>("load_hosts");
  knownRemoteHosts = snapshotRemoteHosts(remoteHosts);
  return [localHost, ...remoteHosts];
}
export async function saveHosts(hosts: Host[]): Promise<void> {
  const remoteHosts = hosts.filter((h) => h.id !== "local");
  const nextSnapshot = snapshotRemoteHosts(remoteHosts);
  const changed = await invoke<string[] | undefined>("save_hosts", {
    hosts: remoteHosts,
  });
  const affectedHostIds = Array.isArray(changed)
    ? changed
    : diffRemoteHosts(knownRemoteHosts, nextSnapshot);
  knownRemoteHosts = nextSnapshot;
  for (const hostId of affectedHostIds) bumpHostModelConfigVersion(hostId);
}
export function message(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value === "SSH_PASSWORD_REQUIRED" ? "请输入 SSH 密码后连接" : value;
}

export function revealProject(
  hostId: string,
  projectId: string,
): Promise<void> {
  return invoke("reveal_project", { hostId, projectId });
}

export async function bindAgentProvider(
  hostId: string,
  agent: string,
  providerId: string | null,
): Promise<Response> {
  const response = await invoke<Response>("bind_agent_provider", {
    hostId,
    agent,
    providerId,
  });
  if (response.kind === "error") throw new Error(response.message);
  if (response.kind === "providers") {
    recordBindings(response.bindings, hostId);
  } else {
    const key = JSON.stringify([hostId, agent]);
    if (providerId) {
      providerBindings.set(key, { hostId, agent, providerId });
    } else {
      providerBindings.delete(key);
    }
  }
  bumpAgentModelConfigVersion(hostId, agent);
  return response;
}

export async function agentProviders(hostId: string): Promise<Response> {
  const response = await invoke<Response>("agent_providers", { hostId });
  if (response.kind === "error") throw new Error(response.message);
  if (response.kind === "providers") {
    recordBindings(response.bindings, hostId);
  }
  return response;
}

export function agentEnvironments(
  hostId: string,
): Promise<Record<string, import("./protocol").AgentEnvironment>> {
  return invoke("agent_environments", { hostId });
}

export async function saveAgentEnvironment(
  hostId: string,
  agent: string,
  environment: import("./protocol").AgentEnvironment,
): Promise<import("./protocol").AgentEnvironment> {
  const saved = await invoke<import("./protocol").AgentEnvironment>(
    "save_agent_environment",
    { hostId, agent, environment },
  );
  bumpAgentModelConfigVersion(hostId, agent);
  return saved;
}

export type ProviderRequest = Extract<
  Request,
  { method: "providers" | "save_provider" | "delete_provider" }
>;
export async function providerRequest(
  request: ProviderRequest,
): Promise<Response> {
  const targetProviderId =
    request.method === "save_provider"
      ? request.provider.id
      : request.method === "delete_provider"
        ? request.id
        : null;
  const hadFullBindingsSnapshot = allProviderBindingsLoaded;
  const before = targetProviderId
    ? collectBoundAgents(targetProviderId)
    : new Map<string, { hostId: string; agent: string }>();
  const response = await invoke<Response>("provider_request", { request });
  if (response.kind === "error") throw new Error(response.message);
  if (response.kind === "providers") {
    recordBindings(response.bindings);
  }
  if (request.method !== "providers" && targetProviderId) {
    const affected = new Map(before);
    for (const [key, value] of collectBoundAgents(targetProviderId)) {
      affected.set(key, value);
    }
    if (affected.size > 0) {
      for (const { hostId, agent } of affected.values()) {
        bumpAgentModelConfigVersion(hostId, agent);
      }
    } else if (
      (request.method === "delete_provider" && !hadFullBindingsSnapshot) ||
      (request.method === "save_provider" &&
        response.kind !== "providers" &&
        !hadFullBindingsSnapshot)
    ) {
      bumpModelConfigVersion();
    }
  }
  return response;
}

export async function fetchProviderModels(
  provider: import("./protocol").ProviderDraft,
): Promise<{ id: string; name: string }[]> {
  return invoke("fetch_provider_models", { provider });
}
