// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import {
  agentEnvironments,
  agentProviders,
  bindAgentProvider,
  connect,
  disconnect,
  loadHosts,
  providerRequest,
  request,
  saveAgentEnvironment,
  saveHosts,
  ServerRequestError,
} from "./api";
import { getModelConfigVersion } from "./modelConfigVersion";
import {
  HOST_DISCONNECTED_EVENT,
  HostConnectionError,
} from "./connectionErrors";
afterEach(() => vi.resetAllMocks());

it("negotiates preview support per host and never sends the new method to old servers", async () => {
  const legacy = {
    id: "legacy-preview",
    name: "Old",
    ssh: "old",
    server_path: null,
  };
  const current = { ...legacy, id: "current-preview", ssh: "new" };
  const preview = {
    method: "preview_change" as const,
    target: { kind: "turn" as const, session_id: "s", request_id: "r" },
    path: "image.png",
    before: false,
    offset: 0,
  };
  mocks.invoke.mockImplementation(async (command, args) =>
    command === "connect_host"
      ? { kind: "hello", change_preview: args.host.id === current.id }
      : { kind: "change_preview", chunk: null },
  );
  await connect(legacy);
  await connect(current);
  await expect(request(legacy.id, preview)).rejects.toMatchObject({
    code: "unsupported",
    message: expect.stringContaining("更新"),
  });
  expect(
    mocks.invoke.mock.calls.filter(([cmd]) => cmd === "host_request"),
  ).toHaveLength(0);
  await expect(request(current.id, preview)).resolves.toMatchObject({
    kind: "change_preview",
  });
  expect(mocks.invoke).toHaveBeenLastCalledWith("host_request", {
    hostId: current.id,
    request: preview,
  });
  await disconnect(current.id);
  await expect(request(current.id, preview)).rejects.toMatchObject({
    code: "unsupported",
  });
  mocks.invoke.mockResolvedValueOnce({ kind: "hello", change_preview: true });
  await connect(legacy);
  await expect(request(legacy.id, preview)).resolves.toMatchObject({
    kind: "change_preview",
  });
});

it("forgets preview support on failed reconnect instead of reusing stale capabilities", async () => {
  const host = {
    id: "preview-reconnect",
    name: "Remote",
    ssh: "remote",
    server_path: null,
  };
  const preview = {
    method: "preview_change" as const,
    target: { kind: "task" as const, session_id: "s" },
    path: "i.png",
    before: true,
    offset: 0,
  };
  mocks.invoke.mockResolvedValueOnce({ kind: "hello", change_preview: true });
  await connect(host);
  mocks.invoke.mockRejectedValueOnce(new Error("connect failed"));
  await expect(connect(host)).rejects.toThrow("connect failed");
  await expect(request(host.id, preview)).rejects.toMatchObject({
    code: "unsupported",
  });
  mocks.invoke.mockResolvedValueOnce({ kind: "hello" });
  await connect(host);
  await expect(request(host.id, preview)).rejects.toMatchObject({
    code: "unsupported",
  });
  expect(
    mocks.invoke.mock.calls.some(([command]) => command === "host_request"),
  ).toBe(false);
});

it("reports confirmed native transport failure from metadata requests", async () => {
  const listener = vi.fn();
  window.addEventListener(HOST_DISCONNECTED_EVENT, listener);
  try {
    mocks.invoke.mockRejectedValue("HOST_CONNECTION_LOST:连接已失效");
    await expect(
      request("test-host", { method: "agent_permissions", agent: "claude" }),
    ).rejects.toBeInstanceOf(HostConnectionError);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].detail).toMatchObject({
      hostId: "test-host",
      message: "连接已失效",
    });
  } finally {
    window.removeEventListener(HOST_DISCONNECTED_EVENT, listener);
  }
});

it("does not classify Server or Provider configuration errors as disconnects", async () => {
  const listener = vi.fn();
  window.addEventListener(HOST_DISCONNECTED_EVENT, listener);
  try {
    mocks.invoke.mockResolvedValueOnce({
      kind: "error",
      code: "unsupported",
      message: "权限选项不支持",
    });
    await expect(
      request("test-host", { method: "agent_permissions", agent: "claude" }),
    ).rejects.toThrow("权限选项不支持");
    mocks.invoke.mockRejectedValueOnce("Provider 配置无效");
    await expect(
      request("test-host", {
        method: "models",
        agent: "claude",
        model: null,
        project_id: null,
      }),
    ).rejects.toBe("Provider 配置无效");
    expect(listener).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(HOST_DISCONNECTED_EVENT, listener);
  }
});

it("ignores a late failure from a transport replaced by reconnect", async () => {
  let reject!: (error: string) => void;
  mocks.invoke.mockImplementation((command) =>
    command === "host_request"
      ? new Promise((_, fail) => {
          reject = fail;
        })
      : Promise.resolve({ kind: "hello", change_preview: true }),
  );
  const listener = vi.fn();
  window.addEventListener(HOST_DISCONNECTED_EVENT, listener);
  try {
    const pending = request("reconnect-host", { method: "projects" });
    const failure = expect(pending).rejects.toBeInstanceOf(HostConnectionError);
    await connect({
      id: "reconnect-host",
      name: "Test",
      ssh: null,
      server_path: null,
    });
    reject("HOST_CONNECTION_LOST:连接已失效");
    await failure;
    expect(listener).not.toHaveBeenCalled();
    mocks.invoke.mockResolvedValueOnce({ kind: "change_preview", chunk: null });
    await expect(
      request("reconnect-host", {
        method: "preview_change",
        target: { kind: "task", session_id: "s" },
        path: "i.png",
        before: false,
        offset: 0,
      }),
    ).resolves.toMatchObject({ kind: "change_preview" });
  } finally {
    window.removeEventListener(HOST_DISCONNECTED_EVENT, listener);
  }
});

it("preserves structured Server error codes without marking the host disconnected", async () => {
  const listener = vi.fn();
  window.addEventListener(HOST_DISCONNECTED_EVENT, listener);
  try {
    mocks.invoke.mockResolvedValueOnce({
      kind: "error",
      code: "not_git_repository",
      message: "此项目无 Git 分支信息",
    });
    const failure = request("metadata-host", {
      method: "git_info",
      project_id: "p",
    });
    await expect(failure).rejects.toBeInstanceOf(ServerRequestError);
    await expect(failure).rejects.toMatchObject({
      code: "not_git_repository",
      message: "此项目无 Git 分支信息",
    });
    expect(listener).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(HOST_DISCONNECTED_EVENT, listener);
  }
});

it("scopes model config version bumps to the affected host and Agent", async () => {
  const localClaudeStart = getModelConfigVersion("local", "claude");
  const localCodexStart = getModelConfigVersion("local", "codex");
  const remoteClaudeStart = getModelConfigVersion("remote-a", "claude");
  const untouchedHostStart = getModelConfigVersion("remote-b", "claude");

  // Editing an unbound provider before loading providers still affects no host or Agent.
  mocks.invoke.mockResolvedValueOnce({
    kind: "providers",
    providers: [],
    bindings: [],
  });
  await providerRequest({
    method: "save_provider",
    provider: {
      id: "unbound-existing",
      name: "Unbound",
      protocol: "anthropic_messages",
      base_url: "https://api.example.com",
      model: "claude",
      models: ["claude"],
      model_labels: {},
      models_1m: [],
      auth: "none",
      credential: null,
    },
  });
  expect(getModelConfigVersion("local", "claude")).toBe(localClaudeStart);
  expect(getModelConfigVersion("remote-a", "claude")).toBe(remoteClaudeStart);

  mocks.invoke.mockResolvedValue({
    kind: "providers",
    providers: [],
    bindings: [],
  });
  await providerRequest({ method: "providers" });
  await agentProviders("local");
  mocks.invoke.mockResolvedValueOnce({});
  await agentEnvironments("local");
  mocks.invoke.mockResolvedValueOnce([
    { id: "remote-a", name: "A", ssh: "a", server_path: null },
    { id: "remote-b", name: "B", ssh: "b", server_path: null },
  ]);
  await loadHosts();
  expect(getModelConfigVersion("local", "claude")).toBe(localClaudeStart);
  expect(getModelConfigVersion("remote-a", "claude")).toBe(remoteClaudeStart);

  // Creating an unbound provider affects no host or Agent.
  mocks.invoke.mockResolvedValueOnce({
    kind: "providers",
    providers: [],
    bindings: [],
  });
  await providerRequest({
    method: "save_provider",
    provider: {
      id: null,
      name: "Team",
      protocol: "anthropic_messages",
      base_url: "https://api.example.com",
      model: "claude",
      models: ["claude"],
      model_labels: {},
      models_1m: [],
      auth: "none",
      credential: null,
    },
  });
  expect(getModelConfigVersion("local", "claude")).toBe(localClaudeStart);
  expect(getModelConfigVersion("remote-a", "claude")).toBe(remoteClaudeStart);

  // Binding a provider on local/claude bumps only local/claude.
  mocks.invoke.mockResolvedValueOnce({
    kind: "providers",
    providers: [],
    bindings: [
      {
        host_id: "local",
        agent: "claude",
        provider_id: "p1",
        provider_revision: "r1",
      },
    ],
  });
  await bindAgentProvider("local", "claude", "p1");
  expect(getModelConfigVersion("local", "claude")).toBe(localClaudeStart + 1);
  expect(getModelConfigVersion("local", "codex")).toBe(localCodexStart);
  expect(getModelConfigVersion("remote-a", "claude")).toBe(remoteClaudeStart);

  // Updating bound provider p1 bumps only the (host, agent) bound to p1.
  mocks.invoke.mockResolvedValueOnce({
    kind: "providers",
    providers: [],
    bindings: [
      {
        host_id: "local",
        agent: "claude",
        provider_id: "p1",
        provider_revision: "r2",
      },
    ],
  });
  await providerRequest({
    method: "save_provider",
    provider: {
      id: "p1",
      name: "Team",
      protocol: "anthropic_messages",
      base_url: "https://api.example.com",
      model: "claude",
      models: ["claude"],
      model_labels: {},
      models_1m: [],
      auth: "none",
      credential: null,
    },
  });
  expect(getModelConfigVersion("local", "claude")).toBe(localClaudeStart + 2);
  expect(getModelConfigVersion("local", "codex")).toBe(localCodexStart);
  expect(getModelConfigVersion("remote-a", "claude")).toBe(remoteClaudeStart);

  // Saving an Agent environment bumps only that host and Agent.
  mocks.invoke.mockResolvedValueOnce({ ANTHROPIC_BASE_URL: "https://x" });
  await saveAgentEnvironment("local", "claude", {
    ANTHROPIC_BASE_URL: "https://x",
  });
  expect(getModelConfigVersion("local", "claude")).toBe(localClaudeStart + 3);
  expect(getModelConfigVersion("local", "codex")).toBe(localCodexStart);
  expect(getModelConfigVersion("remote-a", "claude")).toBe(remoteClaudeStart);

  // Saving SSH hosts bumps only the modified remote host, leaving local and untouched hosts cached.
  mocks.invoke.mockResolvedValueOnce(["remote-a"]);
  await saveHosts([
    { id: "remote-a", name: "A2", ssh: "a2", server_path: null },
    { id: "remote-b", name: "B", ssh: "b", server_path: null },
  ]);
  expect(getModelConfigVersion("remote-a", "claude")).toBe(
    remoteClaudeStart + 1,
  );
  expect(getModelConfigVersion("remote-b", "claude")).toBe(untouchedHostStart);
  expect(getModelConfigVersion("local", "claude")).toBe(localClaudeStart + 3);
});
