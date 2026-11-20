import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { request, message } from "./api";
import { modelOptions } from "./modelOptions";
import { modelSelectionScope } from "./modelSelectionScope";
import { ModelSelector, type ModelSelectorHandle } from "./ModelSelector";
import type { Effort, Response } from "./protocol";
import { useStatusIssues } from "./statusNotices";

export interface ModelPickerHandle {
  /** Null means opened; an error preserves the command draft. */
  openMenu: (
    target: "model" | "effort",
    isCurrent?: () => boolean,
  ) => string | null | Promise<string | null>;
}

type Catalog = Extract<Response, { kind: "models" }>;
const effortContextChanged = "模型设置已变化，请重新打开思考强度菜单。";
export function ModelPicker({
  hostId,
  projectId,
  agent,
  conversationKey,
  connected,
  settingsOpen,
  preserveUnavailableModel = false,
  value,
  onChange,
  onProviderFallback,
  effort,
  onEffortChange,
  onEffortInvalid,
  disabled,
  onReadyChange,
  ref,
}: {
  hostId: string;
  projectId?: string;
  agent: string;
  conversationKey?: string;
  connected: boolean;
  settingsOpen: boolean;
  preserveUnavailableModel?: boolean;
  value: string | null;
  onChange: (model: string | null) => void;
  onProviderFallback?: (model: string | null) => void;
  effort: Effort | null;
  onEffortChange: (effort: Effort | null) => void;
  onEffortInvalid?: () => void;
  disabled: boolean;
  onReadyChange?: (state: { scope: string; ready: boolean }) => void;
  ref?: Ref<ModelPickerHandle>;
}) {
  const selector = useRef<ModelSelectorHandle>(null);
  const scope = JSON.stringify([hostId, projectId, agent]);
  const conversationScope = JSON.stringify([scope, conversationKey ?? ""]);
  const [loaded, setCatalog] = useState<{
    scope: string;
    model: string | null;
    catalog: Catalog;
  }>();
  const [invalidated, setInvalidated] = useState(false);
  const [settledScopes, setSettledScopes] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const settled = settledScopes.has(conversationScope);
  const cached = loaded?.scope === scope && !invalidated ? loaded : undefined;
  const catalog = cached?.catalog;
  // The catalog covers every model, but effort levels describe the queried model.
  const matchesSelectedModel = cached?.model === value;
  const effortLevels = matchesSelectedModel
    ? catalog?.effort_levels
    : undefined;
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const [settledRetry, setSettledRetry] = useState(-1);
  const effortCommand = useRef<{
    scope: string;
    model: string | null;
    retry: number;
    isCurrent?: () => boolean;
    resolve: (error: string | null) => void;
  } | null>(null);
  useEffect(
    () => () => {
      effortCommand.current?.resolve("思考强度菜单已关闭，请重试。");
      effortCommand.current = null;
    },
    [],
  );
  useStatusIssues([
    {
      id: `models:${hostId}:${projectId}:${agent}`,
      title: "模型列表刷新失败",
      error: connected && !settingsOpen ? error : "",
      pending: connected && !settingsOpen && loading,
      action: { label: "重新加载模型", run: () => setRetry((v) => v + 1) },
    },
  ]);
  if (settingsOpen && !invalidated && loaded) setInvalidated(true);
  useEffect(() => {
    if (!settingsOpen || !value) return;
    setSettledScopes((current) => {
      if (current.has(conversationScope)) return current;
      const next = new Set(current);
      next.add(conversationScope);
      return next;
    });
  }, [settingsOpen, value, conversationScope]);
  useEffect(() => {
    if (!connected || settingsOpen) return;
    let disposed = false;
    setError("");
    setLoading(true);
    void request(hostId, {
      method: "models",
      agent,
      model: value,
      project_id: projectId ?? null,
    })
      .then((result) => {
        if (result.kind !== "models") throw new Error("无法加载模型列表");
        if (!disposed) {
          setInvalidated(false);
          setCatalog({ scope, model: value, catalog: result });
          if (value && result.models.includes(value)) {
            setSettledScopes((current) => {
              if (current.has(conversationScope)) return current;
              const next = new Set(current);
              next.add(conversationScope);
              return next;
            });
          }
        }
      })
      .catch((e) => {
        if (!disposed) setError(message(e) || "无法加载模型列表");
      })
      .finally(() => {
        if (!disposed) {
          setSettledRetry(retry);
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [
    hostId,
    projectId,
    agent,
    conversationScope,
    connected,
    settingsOpen,
    retry,
    value,
  ]);
  const usableCatalog =
    !loading && !settingsOpen && connected && (error || matchesSelectedModel)
      ? catalog
      : undefined;
  // Cached choices can be submitted after a failed refresh. Leave automatic
  // model and effort changes to a successful refresh.
  const freshCatalog = error ? undefined : usableCatalog;
  useEffect(() => {
    if (freshCatalog && effort && !freshCatalog.effort_levels.includes(effort))
      onEffortInvalid?.();
  }, [freshCatalog, effort, onEffortInvalid]);
  const providerFallback =
    freshCatalog?.provider != null &&
    (!value ||
      (!preserveUnavailableModel &&
        !settled &&
        !freshCatalog.models.includes(value)))
      ? freshCatalog.models.includes(freshCatalog.default_model ?? "")
        ? freshCatalog.default_model
        : (freshCatalog.models[0] ?? null)
      : undefined;
  useEffect(() => {
    if (providerFallback !== undefined && providerFallback !== value)
      (onProviderFallback ?? onChange)(providerFallback);
  }, [providerFallback, value, onProviderFallback, onChange]);
  const readyScope = modelSelectionScope(
    hostId,
    projectId,
    agent,
    value,
    effort,
  );
  const ready =
    !!usableCatalog &&
    providerFallback === undefined &&
    (!value || usableCatalog.models.includes(value)) &&
    (!effort || effortLevels?.includes(effort) === true);
  const canResetEffort =
    !!usableCatalog && !!error && !!effort && !effortLevels?.includes(effort);
  useEffect(() => {
    onReadyChange?.({ scope: readyScope, ready });
  }, [readyScope, ready, onReadyChange]);
  useImperativeHandle(
    ref,
    () => ({
      openMenu(target, isCurrent) {
        if (disabled) return "当前无法调整模型或思考强度，请在任务结束后选择。";
        if (!connected) return "主机未连接，请连接后选择模型或思考强度。";
        if (settingsOpen) return "模型设置尚未就绪，请稍后重试。";
        if (target === "model")
          return selector.current?.openMenu("model")
            ? null
            : "无法打开模型设置。";
        const pending = effortCommand.current;
        if (pending && pending.isCurrent?.() !== false)
          return "正在刷新思考强度，请稍候。";
        pending?.resolve(effortContextChanged);
        return new Promise<string | null>((resolve) => {
          effortCommand.current = {
            scope,
            model: value,
            retry: retry + 1,
            isCurrent,
            resolve,
          };
          setLoading(true);
          setRetry((v) => v + 1);
        });
      },
    }),
    [disabled, connected, settingsOpen, scope, value, retry],
  );
  useEffect(() => {
    const pending = effortCommand.current;
    if (!pending) return;
    let outcome: string | null;
    if (
      pending.isCurrent?.() === false ||
      pending.scope !== scope ||
      pending.model !== value ||
      disabled ||
      !connected ||
      settingsOpen
    ) {
      outcome = effortContextChanged;
    } else if (
      loading ||
      settledRetry < pending.retry ||
      (providerFallback !== undefined && providerFallback !== value)
    ) {
      return;
    } else if (!effortLevels?.length && !canResetEffort) {
      outcome = error
        ? "思考强度刷新失败，请重新打开后重试。"
        : "当前 Agent 或模型不支持调整思考强度。";
    } else {
      outcome = selector.current?.openMenu("effort", false)
        ? null
        : "无法打开思考强度菜单。";
    }
    effortCommand.current = null;
    pending.resolve(outcome);
  }, [
    scope,
    value,
    disabled,
    connected,
    settingsOpen,
    loading,
    settledRetry,
    providerFallback,
    effortLevels,
    canResetEffort,
    error,
  ]);
  const options = modelOptions(
    catalog?.models ?? [],
    catalog?.model_labels,
    agent === "claude",
  ).filter((option) => catalog?.provider == null || option.value !== "");
  const groupedOptions = options
    .filter(
      (option) =>
        !Object.values(catalog?.model_variants ?? {}).some((variants) =>
          variants?.slice(1).some((variant) => variant.model === option.value),
        ),
    )
    .map((option) => ({
      ...option,
      contextWindow: catalog?.model_variants?.[option.value]?.find(
        (variant) => variant.model === option.value,
      )?.context_window,
      variants: catalog?.model_variants?.[option.value]?.map((variant) => ({
        value: variant.model,
        label: variant.label,
        contextWindow: variant.context_window,
        description: variant.context_window
          ? `${new Intl.NumberFormat("en", { notation: "compact" }).format(variant.context_window)} context`
          : undefined,
      })),
    }));
  if (
    value &&
    catalog &&
    providerFallback === undefined &&
    !catalog.models.includes(value)
  )
    groupedOptions.push({
      value,
      label: `${value} (unavailable)`,
      contextWindow: undefined,
      variants: undefined,
    });
  return (
    <div className="model-picker">
      <ModelSelector
        ref={selector}
        value={providerFallback ?? value ?? ""}
        options={groupedOptions}
        onChange={(id) => onChange(id || null)}
        effort={effort}
        levels={effortLevels ?? []}
        canResetEffort={canResetEffort}
        onEffortChange={onEffortChange}
        onOpen={() => {
          if (loading) return;
          setLoading(true);
          setRetry((v) => v + 1);
        }}
        notice={usableCatalog && error ? "刷新失败，使用上次列表" : undefined}
        status={
          usableCatalog
            ? undefined
            : !loading && error
              ? "模型刷新失败，重新打开可重试"
              : "正在刷新模型…"
        }
        disabled={disabled || settingsOpen || !connected}
      />
    </div>
  );
}
