// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  bumpAgentModelConfigVersion,
  bumpHostModelConfigVersion,
  bumpModelConfigVersion,
} from "./modelConfigVersion";
import { ModelPicker } from "./ModelPicker";
import type { Response } from "./protocol";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  selector: vi.fn((_props: unknown) => null),
}));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
vi.mock("./ModelSelector", () => ({ ModelSelector: mocks.selector }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("groups a declared Provider 1M mode as 默认 / 1M, restores it, and keeps the open chat's model when support is removed", async () => {
  const onChange = vi.fn();
  const ready = vi.fn();
  const catalog = {
    kind: "models",
    models: ["custom", "small", "custom[1m]"],
    provider: "Team",
    default_model: "custom",
    effort_levels: [],
    model_labels: { custom: "Custom model" },
    model_variants: {
      custom: [
        { model: "custom", label: "默认", context_window: 200000 },
        { model: "custom[1m]", label: "1M", context_window: 1000000 },
      ],
    },
  };
  mocks.request.mockResolvedValue(catalog);
  const props = {
    hostId: "devbox",
    agent: "claude",
    connected: true,
    settingsOpen: false,
    preserveUnavailableModel: true,
    value: "custom[1m]",
    onChange,
    effort: null,
    onEffortChange: vi.fn(),
    disabled: false,
    onReadyChange: ready,
  };
  const view = render(<ModelPicker {...props} />);
  await act(async () => {});
  const selected = mocks.selector.mock.calls.at(-1)![0] as {
    value: string;
    options: {
      value: string;
      label?: string;
      variants?: { value: string; label: string; contextWindow?: number }[];
    }[];
    onChange: (value: string) => void;
  };
  expect(selected.value).toBe("custom[1m]");
  expect(selected.options.map((option) => option.value)).toEqual([
    "custom",
    "small",
  ]);
  expect(selected.options[0].variants).toEqual([
    expect.objectContaining({
      value: "custom",
      label: "默认",
      contextWindow: 200000,
      description: "200K context",
    }),
    expect.objectContaining({
      value: "custom[1m]",
      label: "1M",
      contextWindow: 1000000,
    }),
  ]);
  selected.onChange("custom[1m]");
  expect(onChange).toHaveBeenCalledWith("custom[1m]");
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );
  onChange.mockClear();
  view.rerender(<ModelPicker {...props} settingsOpen />);
  mocks.request.mockResolvedValue({
    ...catalog,
    models: ["custom", "small"],
    model_variants: undefined,
  });
  view.rerender(<ModelPicker {...props} />);
  await act(async () => {});
  expect(onChange).not.toHaveBeenCalled();
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({
      value: "custom[1m]",
      options: [
        expect.objectContaining({ value: "custom" }),
        expect.objectContaining({ value: "small" }),
        expect.objectContaining({
          value: "custom[1m]",
          label: "custom[1m] (unavailable)",
        }),
      ],
    }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
});

it("keeps an already-open draft's model across a Provider update without flashing stale readiness", async () => {
  const onChange = vi.fn();
  const onProviderFallback = vi.fn();
  const ready = vi.fn();
  mocks.request.mockResolvedValue({
    kind: "models",
    models: ["model-a", "model-b"],
    provider: "Team",
    default_model: "model-a",
    effort_levels: [],
    model_labels: {},
  });
  const props = {
    hostId: "local",
    projectId: "p",
    agent: "claude",
    connected: true,
    settingsOpen: false,
    value: "model-b",
    onChange,
    onProviderFallback,
    effort: null,
    onEffortChange: vi.fn(),
    disabled: false,
    onReadyChange: ready,
  };
  const view = render(<ModelPicker {...props} />);
  await act(async () => {});
  expect(onChange).not.toHaveBeenCalled();
  expect(onProviderFallback).not.toHaveBeenCalled();
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );

  let resolveUpdated: ((value: Response) => void) | undefined;
  mocks.request.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        resolveUpdated = resolve;
      }),
  );
  ready.mockClear();
  view.rerender(<ModelPicker {...props} settingsOpen />);
  act(() => bumpModelConfigVersion());
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
  view.rerender(<ModelPicker {...props} settingsOpen={false} />);
  expect(ready.mock.calls.some(([state]) => state.ready)).toBe(false);
  await act(async () =>
    resolveUpdated?.({
      kind: "models",
      models: ["model-c"],
      provider: "Team",
      default_model: "model-c",
      effort_levels: [],
      model_labels: {},
    }),
  );
  expect(onChange).not.toHaveBeenCalled();
  expect(onProviderFallback).not.toHaveBeenCalled();
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({
      value: "model-b",
      options: [
        expect.objectContaining({ value: "model-c" }),
        expect.objectContaining({
          value: "model-b",
          label: "model-b (unavailable)",
        }),
      ],
    }),
    undefined,
  );
  expect(ready.mock.calls.some(([state]) => state.ready)).toBe(false);
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
});

it("keeps a verified model ready when closing Settings without Provider changes and refresh fails", async () => {
  const onChange = vi.fn();
  const onEffortInvalid = vi.fn();
  const ready = vi.fn();
  mocks.request.mockResolvedValueOnce({
    kind: "models",
    models: ["model-a", "model-b"],
    provider: "Team",
    default_model: "model-a",
    effort_levels: ["high"],
    model_labels: {},
  });
  const props = {
    hostId: "local",
    projectId: "p",
    agent: "claude",
    connected: true,
    settingsOpen: false,
    value: "model-b",
    onChange,
    effort: "high" as const,
    onEffortChange: vi.fn(),
    onEffortInvalid,
    disabled: false,
    onReadyChange: ready,
  };
  const view = render(<ModelPicker {...props} />);
  await act(async () => {});
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );

  // Open Settings without mutating Provider/Agent config, then close with a transient refresh error.
  view.rerender(<ModelPicker {...props} settingsOpen />);
  mocks.request.mockRejectedValueOnce(new Error("transient refresh error"));
  view.rerender(<ModelPicker {...props} settingsOpen={false} />);
  await act(async () => {});
  expect(onChange).not.toHaveBeenCalled();
  expect(onEffortInvalid).not.toHaveBeenCalled();
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({
      value: "model-b",
      notice: "刷新失败，使用上次列表",
      levels: ["high"],
    }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );

  // Actual Provider config mutations invalidate the cached catalog so failed refreshes block sending.
  view.rerender(<ModelPicker {...props} settingsOpen />);
  act(() => bumpModelConfigVersion());
  mocks.request.mockRejectedValueOnce(new Error("transient refresh error"));
  view.rerender(<ModelPicker {...props} settingsOpen={false} />);
  await act(async () => {});
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
});
it("uses Cursor native model metadata without guessing effort, context, aliases or Provider defaults", async () => {
  mocks.request.mockResolvedValue({
    kind: "models",
    models: ["cursor-native-opus"],
    provider: null,
    default_model: null,
    effort_levels: [],
    model_labels: { "cursor-native-opus": "Native Cursor Model" },
  });
  const invalid = vi.fn(),
    change = vi.fn(),
    effortChange = vi.fn(),
    ready = vi.fn();
  const props = {
    hostId: "cursor-remote",
    projectId: "p",
    agent: "cursor",
    connected: true,
    settingsOpen: false,
    value: "cursor-native-opus",
    onChange: change,
    effort: "high" as const,
    onEffortChange: effortChange,
    onEffortInvalid: invalid,
    disabled: false,
    onReadyChange: ready,
  };
  const view = render(<ModelPicker {...props} />);
  await act(async () => {});
  expect(mocks.request).toHaveBeenCalledWith("cursor-remote", {
    method: "models",
    agent: "cursor",
    model: "cursor-native-opus",
    project_id: "p",
  });
  const selected = mocks.selector.mock.calls.at(-1)![0] as {
    levels: string[];
    options: {
      value: string;
      label: string;
      description?: string;
      contextWindow?: number;
      variants?: unknown;
    }[];
  };
  expect(selected.levels).toEqual([]);
  expect(selected.options).toEqual([
    expect.objectContaining({ value: "", label: "default" }),
    expect.objectContaining({
      value: "cursor-native-opus",
      label: "Native Cursor Model",
      description: undefined,
      contextWindow: undefined,
      variants: undefined,
    }),
  ]);
  expect(invalid).toHaveBeenCalled();
  expect(effortChange).not.toHaveBeenCalled();
  expect(change).not.toHaveBeenCalled();
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
  view.rerender(<ModelPicker {...props} effort={null} />);
  await act(async () => {});
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );
});

it("presents Traex native names and sends the unchanged native ID when selected", async () => {
  mocks.request.mockResolvedValue({
    kind: "models",
    models: ["Doubao-Seed-Evolving", "alwaysday1"],
    provider: null,
    default_model: "Doubao-Seed-Evolving",
    effort_levels: [],
    model_labels: {
      "Doubao-Seed-Evolving": "Seed-Evolving",
      alwaysday1: "auto_model/alwaysday1",
    },
  });
  const onChange = vi.fn();
  render(
    <ModelPicker
      hostId="local"
      agent="traex"
      connected
      settingsOpen={false}
      value="Doubao-Seed-Evolving"
      onChange={onChange}
      effort={null}
      onEffortChange={vi.fn()}
      disabled={false}
    />,
  );
  await act(async () => {});
  const props = mocks.selector.mock.calls.at(-1)![0] as unknown as {
    options: { value: string; label: string; description?: string }[];
    onChange: (value: string) => void;
  };
  expect(props.options).toEqual([
    { value: "", label: "default" },
    {
      value: "Doubao-Seed-Evolving",
      label: "Seed-Evolving",
      description: undefined,
    },
    {
      value: "alwaysday1",
      label: "auto_model/alwaysday1",
      description: undefined,
    },
  ]);
  props.onChange("alwaysday1");
  expect(onChange).toHaveBeenCalledWith("alwaysday1");
});
it("ignores stale catalogs and clears unsupported effort without recording a user preference", async () => {
  const responses: ((value: Response) => void)[] = [];
  mocks.request.mockImplementation(
    () => new Promise((resolve) => responses.push(resolve)),
  );
  const change = vi.fn(),
    invalid = vi.fn();
  const props = {
    hostId: "local",
    projectId: "p",
    agent: "claude",
    connected: true,
    settingsOpen: false,
    value: "haiku",
    onChange: vi.fn(),
    effort: "high" as const,
    onEffortChange: change,
    onEffortInvalid: invalid,
    disabled: false,
  };
  const view = render(<ModelPicker {...props} />);
  view.rerender(<ModelPicker {...props} value="opus" />);
  const catalog = (levels: "high"[]): Response => ({
    kind: "models",
    models: ["haiku", "opus"],
    provider: null,
    default_model: null,
    effort_levels: levels,
    model_labels: {},
  });
  await act(async () => responses[0](catalog([])));
  expect(invalid).not.toHaveBeenCalled();
  await act(async () => responses[1](catalog(["high"])));
  expect(invalid).not.toHaveBeenCalled();
  view.rerender(<ModelPicker {...props} />);
  await act(async () => responses[2](catalog([])));
  expect(invalid).toHaveBeenCalledOnce();
  expect(change).not.toHaveBeenCalled();
});

it("replaces a stale Claude alias with the provider model while preserving valid selections", async () => {
  mocks.request.mockResolvedValue({
    kind: "models",
    models: ["team-code", "team-fast"],
    provider: "Team",
    default_model: "team-code",
    effort_levels: [],
    model_labels: {},
  });
  const onChange = vi.fn();
  const props = {
    hostId: "local",
    agent: "claude",
    connected: true,
    settingsOpen: false,
    value: "opus",
    onChange,
    effort: null,
    onEffortChange: vi.fn(),
    disabled: false,
  };
  const view = render(<ModelPicker {...props} />);
  await act(async () => {});
  expect(onChange).toHaveBeenCalledWith("team-code");
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({
      value: "team-code",
      options: [
        expect.objectContaining({ value: "team-code" }),
        expect.objectContaining({ value: "team-fast" }),
      ],
    }),
    undefined,
  );
  onChange.mockClear();
  view.rerender(<ModelPicker {...props} value="team-fast" />);
  await act(async () => {});
  expect(onChange).not.toHaveBeenCalled();
  view.rerender(<ModelPicker {...props} value={null} />);
  await act(async () => {});
  expect(onChange).toHaveBeenCalledWith("team-code");
});

it("keeps sending blocked until a provider fallback and its capabilities are both current", async () => {
  const responses: ((value: Response) => void)[] = [];
  mocks.request.mockImplementation(
    () => new Promise((resolve) => responses.push(resolve)),
  );
  const ready = vi.fn(),
    change = vi.fn();
  const props = {
    hostId: "remote",
    projectId: "p",
    agent: "claude",
    connected: true,
    settingsOpen: false,
    value: "opus",
    onChange: change,
    effort: null,
    onEffortChange: vi.fn(),
    disabled: false,
    onReadyChange: ready,
  };
  const view = render(<ModelPicker {...props} />);
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
  const catalog: Response = {
    kind: "models",
    models: ["real-id"],
    provider: "Dev",
    default_model: "real-id",
    effort_levels: [],
    model_labels: {},
  };
  await act(async () => responses[0](catalog));
  expect(change).toHaveBeenCalledWith("real-id");
  expect(ready.mock.calls.some(([value]) => value.ready)).toBe(false);
  view.rerender(<ModelPicker {...props} value="real-id" />);
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
  await act(async () => responses[1](catalog));
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );
  view.rerender(<ModelPicker {...props} value="real-id" connected={false} />);
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
});

it("groups native backend modes and keeps the persisted Max value ready", async () => {
  mocks.request.mockResolvedValue({
    kind: "models",
    models: ["gpt", "backend-large"],
    provider: null,
    default_model: "gpt",
    effort_levels: ["low"],
    model_labels: { gpt: "GPT", "backend-large": "GPT / Max" },
    model_variants: {
      gpt: [
        { model: "gpt", label: "Standard", context_window: 475000 },
        { model: "backend-large", label: "Max", context_window: 800000 },
      ],
    },
  });
  const ready = vi.fn();
  render(
    <ModelPicker
      hostId="devbox"
      agent="traex"
      connected
      settingsOpen={false}
      value="backend-large"
      onChange={vi.fn()}
      effort="low"
      onEffortChange={vi.fn()}
      disabled={false}
      onReadyChange={ready}
    />,
  );
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({
      value: "backend-large",
      levels: ["low"],
      options: [
        expect.objectContaining({ value: "" }),
        expect.objectContaining({
          value: "gpt",
          contextWindow: 475000,
          variants: [
            {
              value: "gpt",
              label: "Standard",
              description: "475K context",
              contextWindow: 475000,
            },
            {
              value: "backend-large",
              label: "Max",
              description: "800K context",
              contextWindow: 800000,
            },
          ],
        }),
      ],
    }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );
});

it("keeps the last model list usable after changing selection within its host, project and Agent", async () => {
  const catalog: Response = {
    kind: "models",
    models: ["first", "second"],
    provider: null,
    default_model: "first",
    effort_levels: ["high"],
    model_labels: {},
  };
  mocks.request
    .mockResolvedValueOnce(catalog)
    .mockRejectedValue(new Error("offline"));
  const props = {
    hostId: "devbox",
    projectId: "p",
    agent: "codex",
    connected: true,
    settingsOpen: false,
    value: "first",
    onChange: vi.fn(),
    effort: "high" as const,
    onEffortChange: vi.fn(),
    onEffortInvalid: vi.fn(),
    disabled: false,
    onReadyChange: vi.fn(),
  };
  const view = render(<ModelPicker {...props} />);
  await act(async () => {});
  view.rerender(<ModelPicker {...props} value="second" />);
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({
      value: "second",
      notice: "刷新失败，使用上次列表",
      status: undefined,
      options: expect.arrayContaining([
        expect.objectContaining({ value: "first" }),
        expect.objectContaining({ value: "second" }),
      ]),
      levels: [],
      canResetEffort: true,
    }),
    undefined,
  );
  expect(props.onEffortInvalid).not.toHaveBeenCalled();
  expect(props.onReadyChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
  const reset = mocks.selector.mock.calls.at(-1)?.[0] as {
    onEffortChange: (effort: null) => void;
  };
  act(() => reset.onEffortChange(null));
  expect(props.onEffortChange).toHaveBeenCalledWith(null);
  view.rerender(<ModelPicker {...props} value="second" effort={null} />);
  expect(props.onReadyChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );

  view.rerender(<ModelPicker {...props} hostId="other-host" />);
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({
      notice: undefined,
      status: "模型刷新失败，重新打开可重试",
      options: [{ value: "", label: "default" }],
    }),
    undefined,
  );
  expect(props.onReadyChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
});

it("preserves another host's validated model cache when a different host or Agent config changes", async () => {
  const catalog: Response = {
    kind: "models",
    models: ["first", "second"],
    provider: null,
    default_model: "first",
    effort_levels: [],
    model_labels: {},
  };
  mocks.request
    .mockResolvedValueOnce(catalog)
    .mockRejectedValue(new Error("transient network error"));
  const ready = vi.fn();
  const props = {
    hostId: "remote-stable",
    projectId: "p",
    agent: "codex",
    connected: true,
    settingsOpen: false,
    value: "first",
    onChange: vi.fn(),
    effort: null,
    onEffortChange: vi.fn(),
    disabled: false,
    onReadyChange: ready,
  };
  const view = render(<ModelPicker {...props} />);
  await act(async () => {});
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );

  // Config mutations on other hosts or other Agents do not invalidate remote-stable/codex.
  act(() => {
    bumpHostModelConfigVersion("other-ssh");
    bumpAgentModelConfigVersion("remote-stable", "claude");
  });
  expect(mocks.request).toHaveBeenCalledTimes(1);

  // Even if remote-stable later experiences a transient refresh failure on model switch,
  // its validated catalog remains usable and sending stays unblocked.
  view.rerender(<ModelPicker {...props} value="second" />);
  await act(async () => {});
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );

  // Mutating remote-stable itself invalidates its cache, so a failed refresh blocks unverified sends.
  await act(async () => {
    bumpHostModelConfigVersion("remote-stable");
  });
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
});

it("re-applies transient Provider fallback across P1 -> P2 -> P1 draft switches without overwriting localStorage", async () => {
  const { useAgentPreferences } = await import("./useAgentPreferences");
  localStorage.clear();
  localStorage.setItem(
    'latte-work.agent-selection.v1:["devbox","claude"]',
    JSON.stringify({ model: "opus", effort: null, permissionMode: null }),
  );
  let availableModels = ["real"];
  mocks.request.mockImplementation(async () => ({
    kind: "models",
    models: availableModels,
    provider: "Team",
    default_model: availableModels[0] ?? null,
    effort_levels: [],
    model_labels: {},
  }));
  const ready = vi.fn();
  function DraftHarness({
    projectId,
    settingsOpen = false,
  }: {
    projectId: string;
    settingsOpen?: boolean;
  }) {
    const preferences = useAgentPreferences(
      "devbox",
      "claude",
      projectId,
      undefined,
      false,
    );
    return (
      <ModelPicker
        hostId="devbox"
        projectId={projectId}
        agent="claude"
        conversationKey="draft"
        connected
        settingsOpen={settingsOpen}
        preserveUnavailableModel={false}
        value={preferences.model}
        onChange={preferences.chooseModel}
        onProviderFallback={preferences.replaceUnsupportedModel}
        effort={preferences.effort}
        onEffortChange={preferences.chooseEffort}
        onEffortInvalid={preferences.clearUnsupportedEffort}
        disabled={false}
        onReadyChange={ready}
      />
    );
  }

  const view = render(<DraftHarness projectId="p1" />);
  await act(async () => {});
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({ value: "real" }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );
  expect(
    JSON.parse(
      localStorage.getItem(
        'latte-work.agent-selection.v1:["devbox","claude"]',
      ) ?? "{}",
    ).model,
  ).toBe("opus");

  // Switch P1 -> P2: preferences reload "opus", and P2 falls back to "real".
  view.rerender(<DraftHarness projectId="p2" />);
  await act(async () => {});
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({ value: "real" }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );

  // Switch P2 -> P1: preferences reload "opus" again; P1 must NOT stay stuck on "opus (unavailable)".
  view.rerender(<DraftHarness projectId="p1" />);
  await act(async () => {});
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({
      value: "real",
      options: [expect.objectContaining({ value: "real" })],
    }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );
  expect(
    JSON.parse(
      localStorage.getItem(
        'latte-work.agent-selection.v1:["devbox","claude"]',
      ) ?? "{}",
    ).model,
  ).toBe("opus");

  // While staying on the same open draft in P1, editing the Provider preserves the active "real" choice.
  availableModels = ["next-model"];
  await act(async () => {
    bumpModelConfigVersion();
  });
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({
      value: "real",
      options: expect.arrayContaining([
        expect.objectContaining({ value: "real", label: "real (unavailable)" }),
      ]),
    }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
});

it("preserves a manually chosen and verified model across P1 -> P2 -> P1 draft switches after Provider removes it", async () => {
  const { useAgentPreferences } = await import("./useAgentPreferences");
  localStorage.clear();
  let availableModels = ["model-a", "model-b"];
  mocks.request.mockImplementation(async () => ({
    kind: "models",
    models: availableModels,
    provider: "Team",
    default_model: availableModels[0] ?? null,
    effort_levels: [],
    model_labels: {},
  }));
  const ready = vi.fn();
  function DraftHarness({ projectId }: { projectId: string }) {
    const preferences = useAgentPreferences(
      "devbox",
      "claude",
      projectId,
      undefined,
      false,
    );
    return (
      <ModelPicker
        hostId="devbox"
        projectId={projectId}
        agent="claude"
        conversationKey="draft"
        connected
        settingsOpen={false}
        preserveUnavailableModel={false}
        value={preferences.model}
        onChange={preferences.chooseModel}
        onProviderFallback={preferences.replaceUnsupportedModel}
        effort={preferences.effort}
        onEffortChange={preferences.chooseEffort}
        onEffortInvalid={preferences.clearUnsupportedEffort}
        disabled={false}
        onReadyChange={ready}
      />
    );
  }

  // 1. Open draft in P1, manually select and verify model-a.
  const view = render(<DraftHarness projectId="p1" />);
  await act(async () => {});
  await act(async () => {});
  await act(async () => {
    const lastCall = mocks.selector.mock.calls.at(-1)?.[0] as {
      onChange: (value: string) => void;
    };
    lastCall.onChange("model-a");
  });
  await act(async () => {});
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );

  // 2. Provider removes model-a, keeping only model-b -> P1 shows model-a unavailable and blocks send.
  availableModels = ["model-b"];
  await act(async () => {
    bumpModelConfigVersion();
  });
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({
      value: "model-a",
      options: expect.arrayContaining([
        expect.objectContaining({
          value: "model-a",
          label: "model-a (unavailable)",
        }),
      ]),
    }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );

  // 3. Switch P1 -> P2 on the same draft -> P2 has never verified model-a, so it falls back to model-b.
  view.rerender(<DraftHarness projectId="p2" />);
  await act(async () => {});
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({ value: "model-b" }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );

  // 4. Switch P2 -> P1 on the same draft -> P1 restores model-a and must keep blocking send until user switches.
  view.rerender(<DraftHarness projectId="p1" />);
  await act(async () => {});
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({
      value: "model-a",
      options: expect.arrayContaining([
        expect.objectContaining({
          value: "model-a",
          label: "model-a (unavailable)",
        }),
      ]),
    }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );

  // Active user switch to model-b unblocks send.
  await act(async () => {
    const lastCall = mocks.selector.mock.calls.at(-1)?.[0] as {
      onChange: (value: string) => void;
    };
    lastCall.onChange("model-b");
  });
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({ value: "model-b" }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );
});

it("preserves an automatically fallen-back model across P1 -> P2 -> P1 draft switches after Provider removes it", async () => {
  const { useAgentPreferences } = await import("./useAgentPreferences");
  localStorage.clear();
  localStorage.setItem(
    'latte-work.agent-selection.v1:["devbox","claude"]',
    JSON.stringify({ model: "opus", effort: null, permissionMode: null }),
  );
  let availableModels = ["real"];
  mocks.request.mockImplementation(async () => ({
    kind: "models",
    models: availableModels,
    provider: "Team",
    default_model: availableModels[0] ?? null,
    effort_levels: [],
    model_labels: {},
  }));
  const ready = vi.fn();
  function DraftHarness({
    projectId,
    conversationKey = "draft-1",
  }: {
    projectId: string;
    conversationKey?: string;
  }) {
    const preferences = useAgentPreferences(
      "devbox",
      "claude",
      projectId,
      undefined,
      false,
      conversationKey,
    );
    return (
      <ModelPicker
        hostId="devbox"
        projectId={projectId}
        agent="claude"
        conversationKey={conversationKey}
        connected
        settingsOpen={false}
        preserveUnavailableModel={false}
        value={preferences.model}
        onChange={preferences.chooseModel}
        onProviderFallback={preferences.replaceUnsupportedModel}
        effort={preferences.effort}
        onEffortChange={preferences.chooseEffort}
        onEffortInvalid={preferences.clearUnsupportedEffort}
        disabled={false}
        onReadyChange={ready}
      />
    );
  }

  // 1. Stored preference is "opus"; Provider only offers "real", so P1 falls back to "real".
  const view = render(<DraftHarness projectId="p1" />);
  await act(async () => {});
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({ value: "real" }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );

  // 2. Provider removes "real" and offers only "next-model"; P1 shows "real (unavailable)" and blocks send.
  availableModels = ["next-model"];
  await act(async () => {
    bumpModelConfigVersion();
  });
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({
      value: "real",
      options: expect.arrayContaining([
        expect.objectContaining({ value: "real", label: "real (unavailable)" }),
      ]),
    }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );

  // 3. Same draft switches P1 -> P2 -> P1: P2 falls back to "next-model", while P1 restores "real (unavailable)".
  view.rerender(<DraftHarness projectId="p2" />);
  await act(async () => {});
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({ value: "next-model" }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );

  view.rerender(<DraftHarness projectId="p1" />);
  await act(async () => {});
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({
      value: "real",
      options: expect.arrayContaining([
        expect.objectContaining({ value: "real", label: "real (unavailable)" }),
      ]),
    }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
  expect(
    JSON.parse(
      localStorage.getItem(
        'latte-work.agent-selection.v1:["devbox","claude"]',
      ) ?? "{}",
    ).model,
  ).toBe("opus");

  // 4. Opening a brand-new draft on P1 re-reads "opus" and falls back to "next-model".
  view.rerender(<DraftHarness projectId="p1" conversationKey="draft-2" />);
  await act(async () => {});
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({ value: "next-model" }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );
});

it("keeps each project's initial Provider fallback across P1 -> P2 -> P1 when stored preference is null and default_model changes", async () => {
  const { useAgentPreferences } = await import("./useAgentPreferences");
  localStorage.clear();
  let p1Default = "model-p1";
  mocks.request.mockImplementation(async (_hostId, req) => {
    const projectId =
      typeof req === "object" && req && "project_id" in req
        ? req.project_id
        : null;
    if (projectId === "p2") {
      return {
        kind: "models",
        models: ["model-p2"],
        provider: "TeamP2",
        default_model: "model-p2",
        effort_levels: [],
        model_labels: {},
      };
    }
    return {
      kind: "models",
      models: ["model-p1", "model-p1-next"],
      provider: "TeamP1",
      default_model: p1Default,
      effort_levels: [],
      model_labels: {},
    };
  });
  const ready = vi.fn();
  function DraftHarness({ projectId }: { projectId: string }) {
    const preferences = useAgentPreferences(
      "devbox",
      "claude",
      projectId,
      undefined,
      false,
      "draft-1",
    );
    return (
      <ModelPicker
        hostId="devbox"
        projectId={projectId}
        agent="claude"
        conversationKey="draft-1"
        connected
        settingsOpen={false}
        preserveUnavailableModel={false}
        value={preferences.model}
        onChange={preferences.chooseModel}
        onProviderFallback={preferences.replaceUnsupportedModel}
        effort={preferences.effort}
        onEffortChange={preferences.chooseEffort}
        onEffortInvalid={preferences.clearUnsupportedEffort}
        disabled={false}
        onReadyChange={ready}
      />
    );
  }

  const view = render(<DraftHarness projectId="p1" />);
  await act(async () => {});
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({ value: "model-p1" }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );

  // Switch P1 -> P2: P2 settles its own Provider fallback ("model-p2").
  view.rerender(<DraftHarness projectId="p2" />);
  await act(async () => {});
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({ value: "model-p2" }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );

  // Even if P1's Provider default_model changes while away, returning to P1 keeps "model-p1" without writing localStorage.
  p1Default = "model-p1-next";
  bumpModelConfigVersion();
  view.rerender(<DraftHarness projectId="p1" />);
  await act(async () => {});
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({ value: "model-p1" }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );
  expect(
    localStorage.getItem('latte-work.agent-selection.v1:["devbox","claude"]'),
  ).toBeNull();
});

it("clears settled draft models after transitioning to a session without refetching models on key change, and invalidates other projects on manual choice", async () => {
  const { useAgentPreferences } = await import("./useAgentPreferences");
  localStorage.clear();
  localStorage.setItem(
    'latte-work.agent-selection.v1:["devbox","claude"]',
    JSON.stringify({ model: "model-a", effort: null, permissionMode: null }),
  );
  let p1Models = ["model-a", "model-b"];
  const p2Models = ["model-a", "model-c"];
  mocks.request.mockImplementation(
    async (_host: string, req: { project_id?: string | null }) => ({
      kind: "models",
      models: req.project_id === "p2" ? p2Models : p1Models,
      provider: "Team",
      default_model: (req.project_id === "p2" ? p2Models : p1Models)[0] ?? null,
      effort_levels: [],
      model_labels: {},
    }),
  );
  const ready = vi.fn();
  const saved = {
    id: "s1",
    model: "model-a",
    effort: null,
    permission_mode: null,
  } as import("./protocol").Session;

  function Harness({
    projectId,
    session,
    conversationKey,
  }: {
    projectId: string;
    session?: import("./protocol").Session;
    conversationKey: string;
  }) {
    const preferences = useAgentPreferences(
      "devbox",
      "claude",
      projectId,
      session,
      false,
      conversationKey,
    );
    return (
      <ModelPicker
        hostId="devbox"
        projectId={projectId}
        agent="claude"
        conversationKey={conversationKey}
        connected
        settingsOpen={false}
        preserveUnavailableModel={!!session}
        value={preferences.model}
        onChange={preferences.chooseModel}
        onProviderFallback={preferences.replaceUnsupportedModel}
        effort={preferences.effort}
        onEffortChange={preferences.chooseEffort}
        onEffortInvalid={preferences.clearUnsupportedEffort}
        disabled={false}
        onReadyChange={ready}
      />
    );
  }

  // 1. Draft on P1 settles "model-a".
  const view = render(<Harness projectId="p1" conversationKey="new-task" />);
  await act(async () => {});
  await act(async () => {});
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );

  // 2. Transitioning the draft to persisted session "s1" with the same model must not issue a redundant models RPC.
  mocks.request.mockClear();
  view.rerender(
    <Harness projectId="p1" session={saved} conversationKey="s1" />,
  );
  await act(async () => {});
  expect(mocks.request).not.toHaveBeenCalled();

  // 3. Provider on P1 removes "model-a"; returning to a fresh "new-task" draft must fall back to "model-b" instead of reusing the consumed draft's settled state.
  p1Models = ["model-b"];
  await act(async () => {
    bumpModelConfigVersion();
  });
  await act(async () => {});
  view.rerender(<Harness projectId="p1" conversationKey="new-task" />);
  await act(async () => {});
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({ value: "model-b" }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );

  // 4. Re-add "model-a" on P1 so the new draft settles "model-a", then remove it on P1 so P1 holds unavailable "model-a".
  p1Models = ["model-a", "model-b"];
  await act(async () => {
    bumpModelConfigVersion();
  });
  await act(async () => {});
  await act(async () => {
    const lastCall = mocks.selector.mock.calls.at(-1)?.[0] as {
      onChange: (value: string) => void;
    };
    lastCall.onChange("model-a");
  });
  await act(async () => {});
  p1Models = ["model-b"];
  await act(async () => {
    bumpModelConfigVersion();
  });
  await act(async () => {});
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );

  // 5. On P2, user manually switches to "model-c" then "model-a"; returning to P1 treats "model-a" as a fresh cross-project choice and falls back to "model-b".
  view.rerender(<Harness projectId="p2" conversationKey="new-task" />);
  await act(async () => {});
  await act(async () => {
    const lastCall = mocks.selector.mock.calls.at(-1)?.[0] as {
      onChange: (value: string) => void;
    };
    lastCall.onChange("model-c");
  });
  await act(async () => {});
  await act(async () => {
    const lastCall = mocks.selector.mock.calls.at(-1)?.[0] as {
      onChange: (value: string) => void;
    };
    lastCall.onChange("model-a");
  });
  await act(async () => {});
  view.rerender(<Harness projectId="p1" conversationKey="new-task" />);
  await act(async () => {});
  await act(async () => {});
  expect(mocks.selector).toHaveBeenLastCalledWith(
    expect.objectContaining({ value: "model-b" }),
    undefined,
  );
  expect(ready).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );
});
