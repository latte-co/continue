import { useEffect, useRef, useState } from "react";
import { ChevronRight, Plus, Server, Trash2 } from "lucide-react";
import {
  message,
  providerRequest,
  fetchProviderModels,
  type ProviderRequest,
} from "./api";
import { SettingsPane } from "./SettingsPane";
import type {
  Provider,
  ProviderDraft,
  ProviderProtocol,
  Response,
} from "./protocol";
import {
  Badge,
  Button,
  Card,
  CardList,
  Checkbox,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  ItemRow,
  NoticeBanner,
  Select,
  TextInput,
} from "./ui";

type Catalog = Extract<Response, { kind: "providers" }>;

export const protocols: Record<ProviderProtocol, string> = {
  anthropic_messages: "Anthropic Messages",
  openai_chat: "OpenAI Chat Completions",
  openai_responses: "OpenAI Responses",
};

const empty = (): ProviderDraft => ({
  id: null,
  name: "",
  protocol: "anthropic_messages",
  base_url: "",
  model: "",
  models: [],
  model_labels: {},
  models_1m: [],
  auth: "none",
  credential: null,
});

export function ProviderSettings({
  active,
  onBusy,
  onClose,
  closeDisabled = false,
}: {
  active: boolean;
  onBusy: (busy: boolean) => void;
  onClose?: () => void;
  closeDisabled?: boolean;
}) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [error, setError] = useState("");
  const baseline = useRef<string>("");
  const [notice, setNotice] = useState("");
  const dirty = !!draft && JSON.stringify(draft) !== baseline.current;
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!active) {
      setBusy(false);
      return;
    }
    setError("");
    const current = ++generation.current;
    setBusy(true);
    void providerRequest({ method: "providers" })
      .then((result) => {
        if (result.kind !== "providers") throw new Error("Provider 响应不匹配");
        if (current === generation.current) setCatalog(result);
      })
      .catch((e) => {
        if (current === generation.current) setError(message(e));
      })
      .finally(() => {
        if (current === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [active]);

  async function mutate(value: ProviderRequest) {
    const current = generation.current;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const result = await providerRequest(value);
      if (result.kind !== "providers") throw new Error("Provider 响应不匹配");
      if (current === generation.current) {
        setCatalog(result);
        setDraft(null);
        setRemove(null);
        setNotice(
          value.method === "save_provider"
            ? "Provider 已保存；下次发送时生效。"
            : "Provider 已移除。",
        );
      }
    } catch (e) {
      if (current === generation.current) setError(message(e));
    } finally {
      onBusy(false);
      if (current === generation.current) setBusy(false);
    }
  }

  async function fetchModels() {
    if (!draft || busy) return;
    const current = generation.current;
    setBusy(true);
    onBusy(true);
    setError("");
    setNotice("");
    try {
      const models = await fetchProviderModels(draft);
      if (current !== generation.current) return;
      const ids = Array.from(
        new Set([
          ...draft.models.filter((id) => id.trim()),
          ...models.map((m) => m.id),
        ]),
      );
      if (ids.length > 256) throw new Error("模型配置最多支持 256 个模型");
      const labels = { ...draft.model_labels };
      for (const model of models)
        if (!labels[model.id]?.trim()) labels[model.id] = model.name;
      setDraft({ ...draft, models: ids, model_labels: labels });
      setNotice(
        models.length
          ? `已获取 ${models.length} 个模型，保存后生效。`
          : "后端未返回可用模型。",
      );
    } catch (e) {
      if (current === generation.current) setError(message(e));
    } finally {
      onBusy(false);
      if (current === generation.current) setBusy(false);
    }
  }

  function startAdd() {
    const next = empty();
    baseline.current = JSON.stringify(next);
    setDraft(next);
    setNotice("");
    setRemove(null);
    setError("");
  }

  function edit(p: Provider) {
    const next: ProviderDraft = {
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      base_url: p.base_url,
      model: p.model,
      models: Array.from(new Set([p.model, ...p.models])),
      model_labels: p.model_labels ?? {},
      models_1m: p.models_1m ?? [],
      auth: p.auth,
      credential: null,
    };
    baseline.current = JSON.stringify(next);
    setDraft(next);
    setNotice("");
    setRemove(null);
    setError("");
  }

  if (draft) {
    return (
      <SettingsPane
        title="模型"
        className="provider-settings"
        onClose={onClose}
        closeDisabled={closeDisabled || busy}
        subview={{
          parentTitle: "模型",
          title: draft.id
            ? `编辑 ${draft.name || "Provider"}`
            : "添加 Provider",
          backDisabled: busy,
          onBack: () => {
            setDraft(null);
            setError("");
          },
          status: busy
            ? "正在保存…"
            : dirty
              ? "有未保存的修改 · 离开设置后保留"
              : draft.id
                ? "已保存"
                : "填写服务信息",
          footer: (
            <>
              <Button
                variant="subtle"
                size="md"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setError("");
                }}
              >
                取消
              </Button>
              <Button
                type="submit"
                form="provider-edit-form"
                variant="primary"
                size="md"
                busy={busy}
                disabled={!dirty || busy}
              >
                {busy ? "正在保存…" : "保存 Provider"}
              </Button>
            </>
          ),
        }}
      >
        {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
        {notice && <NoticeBanner tone="success">{notice}</NoticeBanner>}

        <Card>
          <form
            id="provider-edit-form"
            onSubmit={(e) => {
              e.preventDefault();
              const models = Array.from(
                new Set(draft.models.map((id) => id.trim()).filter(Boolean)),
              );
              if (!models.length) {
                setError("请至少添加一个模型");
                return;
              }
              if (dirty && !busy)
                void mutate({
                  method: "save_provider",
                  provider: {
                    ...draft,
                    models,
                    model: models.includes(draft.model)
                      ? draft.model
                      : models[0],
                    models_1m: Array.from(
                      new Set(
                        (draft.models_1m ?? [])
                          .map((id) => id.trim())
                          .filter(
                            (id) =>
                              models.includes(id) &&
                              !id.toLowerCase().endsWith("[1m]"),
                          ),
                      ),
                    ),
                    model_labels: Object.fromEntries(
                      Object.entries(draft.model_labels ?? {}).filter(
                        ([id, label]) => models.includes(id) && label?.trim(),
                      ),
                    ),
                  },
                });
            }}
          >
            <fieldset disabled={busy} className="settings-subview-form">
              <div className="settings-form-grid">
                <Field label="名称" htmlFor="provider-name">
                  <TextInput
                    id="provider-name"
                    autoFocus
                    required
                    maxLength={80}
                    placeholder="例如：团队模型服务"
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                  />
                </Field>
                <Field label="接口协议">
                  <Select
                    label="接口协议"
                    size="lg"
                    value={draft.protocol}
                    options={Object.entries(protocols).map(
                      ([value, label]) => ({ value, label }),
                    )}
                    disabled={busy}
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        protocol: value as ProviderProtocol,
                        models_1m:
                          value === "anthropic_messages" ? draft.models_1m : [],
                        auth:
                          draft.auth === "none"
                            ? "none"
                            : value === "anthropic_messages"
                              ? "api_key"
                              : "bearer",
                      })
                    }
                  />
                </Field>
              </div>

              <Field label="Base URL" htmlFor="provider-base-url">
                <TextInput
                  id="provider-base-url"
                  type="url"
                  required
                  monospace
                  placeholder={
                    draft.protocol === "anthropic_messages"
                      ? "https://api.example.com"
                      : "https://api.example.com/v1"
                  }
                  value={draft.base_url}
                  onChange={(e) =>
                    setDraft({ ...draft, base_url: e.target.value })
                  }
                />
              </Field>

              <Field label="API Key" htmlFor="provider-api-key">
                <TextInput
                  id="provider-api-key"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={
                    draft.id && draft.auth !== "none"
                      ? "已保存，留空保持不变"
                      : "留空则无需认证"
                  }
                  value={draft.credential ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      credential: e.target.value || null,
                      auth: e.target.value
                        ? draft.id && draft.auth !== "none"
                          ? draft.auth
                          : draft.protocol === "anthropic_messages"
                            ? "api_key"
                            : "bearer"
                        : draft.id &&
                            JSON.parse(baseline.current).auth !== "none"
                          ? draft.auth
                          : "none",
                    })
                  }
                />
              </Field>

              {draft.id && draft.auth !== "none" && (
                <div>
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() =>
                      setDraft({ ...draft, auth: "none", credential: null })
                    }
                  >
                    清除 API Key，改为无需认证
                  </Button>
                </div>
              )}

              <section
                className="provider-models-field"
                aria-label="模型配置"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <div className="provider-model-heading" style={{ margin: 0 }}>
                  <span className="ui-field-label">模型配置</span>
                  <Button
                    variant="subtle"
                    size="sm"
                    busy={busy}
                    disabled={busy || !draft.base_url.trim()}
                    onClick={() => void fetchModels()}
                  >
                    {busy ? "正在获取…" : "获取可用模型"}
                  </Button>
                </div>
                <DataTable className="provider-model-table">
                  <thead>
                    <tr>
                      <th>模型 ID</th>
                      <th>显示名称</th>
                      {draft.protocol === "anthropic_messages" && (
                        <th style={{ width: 108 }}>Claude Code</th>
                      )}
                      <th style={{ width: 44 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.models.map((model, index) => (
                      <tr key={index}>
                        <td>
                          <TextInput
                            size="sm"
                            monospace
                            aria-label={`模型 ID ${index + 1}`}
                            maxLength={256}
                            placeholder="服务端提供的完整模型 ID"
                            value={model}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                models_1m: (draft.models_1m ?? []).map((id) =>
                                  id === model ? e.target.value : id,
                                ),
                                model_labels: {
                                  ...draft.model_labels,
                                  [e.target.value]:
                                    draft.model_labels?.[model] ?? "",
                                },
                                models: draft.models.map((value, i) =>
                                  i === index ? e.target.value : value,
                                ),
                              })
                            }
                          />
                        </td>
                        <td>
                          <TextInput
                            size="sm"
                            aria-label={`显示名称 ${index + 1}`}
                            maxLength={80}
                            placeholder="可选，默认显示模型 ID"
                            value={draft.model_labels?.[model] ?? ""}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                model_labels: {
                                  ...draft.model_labels,
                                  [model]: e.target.value,
                                },
                              })
                            }
                          />
                        </td>
                        {draft.protocol === "anthropic_messages" && (
                          <td>
                            <Checkbox
                              ariaLabel={`模型 ${index + 1} 支持 1M 上下文`}
                              label="支持 1M"
                              checked={
                                model.toLowerCase().endsWith("[1m]") ||
                                (draft.models_1m ?? []).includes(model)
                              }
                              disabled={
                                !model.trim() ||
                                model.toLowerCase().endsWith("[1m]")
                              }
                              onChange={(checked) =>
                                setDraft({
                                  ...draft,
                                  models_1m: checked
                                    ? [...(draft.models_1m ?? []), model]
                                    : (draft.models_1m ?? []).filter(
                                        (id) => id !== model,
                                      ),
                                })
                              }
                            />
                          </td>
                        )}
                        <td>
                          <IconButton
                            label={`删除模型 ${index + 1}`}
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setDraft({
                                ...draft,
                                models: draft.models.filter(
                                  (_, i) => i !== index,
                                ),
                                models_1m: (draft.models_1m ?? []).filter(
                                  (id) =>
                                    id !== model ||
                                    draft.models.some(
                                      (value, i) => i !== index && value === id,
                                    ),
                                ),
                              })
                            }
                          >
                            <Trash2 size={14} />
                          </IconButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
                {draft.protocol === "anthropic_messages" && (
                  <p className="ui-field-hint" style={{ margin: 0 }}>
                    勾选声明模型支持 1M；使用 Claude Code 时，可在模型菜单选择
                    1M 上下文。请以模型服务的实际能力为准。
                  </p>
                )}
                <div>
                  <Button
                    variant="subtle"
                    size="sm"
                    leading={<Plus size={14} />}
                    onClick={() =>
                      setDraft({ ...draft, models: [...draft.models, ""] })
                    }
                  >
                    添加模型
                  </Button>
                </div>
              </section>
            </fieldset>
          </form>
        </Card>
      </SettingsPane>
    );
  }

  return (
    <SettingsPane
      title="模型"
      description="配置模型服务，并在连接与 Agent 中关联使用。"
      className="provider-settings"
      onClose={onClose}
      closeDisabled={closeDisabled || busy}
      actions={
        <Button
          variant="primary"
          size="md"
          leading={<Plus size={15} />}
          aria-label="添加 Provider"
          disabled={busy || !catalog}
          onClick={startAdd}
        >
          添加
        </Button>
      }
    >
      {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
      {notice && <NoticeBanner tone="success">{notice}</NoticeBanner>}
      {busy && !catalog && (
        <NoticeBanner tone="neutral">正在加载…</NoticeBanner>
      )}

      {catalog &&
        (catalog.providers.length === 0 ? (
          <EmptyState
            icon={<Server size={22} />}
            title="还没有 Provider"
            description="点击右上角「添加」配置一个模型服务开始使用。"
          />
        ) : (
          <CardList label="已配置的模型服务">
            {catalog.providers.map((p) => {
              const modelCount = new Set([p.model, ...p.models].filter(Boolean))
                .size;
              return (
                <ItemRow
                  key={p.id}
                  title={p.name}
                  badge={<Badge>{`${modelCount} 个模型`}</Badge>}
                  subtitle={
                    remove === p.id ? (
                      <span
                        role="status"
                        style={{ color: "var(--color-danger)" }}
                      >
                        删除后将解除所有 Agent 关联。
                      </span>
                    ) : (
                      `${protocols[p.protocol]} · ${p.model} · ${p.base_url}`
                    )
                  }
                  actions={
                    <>
                      <Button
                        variant="subtle"
                        size="sm"
                        trailing={<ChevronRight size={14} />}
                        disabled={busy}
                        onClick={() => edit(p)}
                      >
                        编辑
                      </Button>
                      <Button
                        variant={remove === p.id ? "danger" : "ghost"}
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          remove === p.id
                            ? void mutate({
                                method: "delete_provider",
                                id: p.id,
                              })
                            : setRemove(p.id)
                        }
                      >
                        {remove === p.id ? "确认删除" : "删除"}
                      </Button>
                      {remove === p.id && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setRemove(null)}
                        >
                          取消
                        </Button>
                      )}
                    </>
                  }
                />
              );
            })}
          </CardList>
        ))}
    </SettingsPane>
  );
}
