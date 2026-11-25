import { useEffect, useRef, useState } from "react";
import { ChevronRight, Globe2, Monitor, RefreshCw } from "lucide-react";
import {
  agentProviders,
  agentEnvironments,
  saveAgentEnvironment,
  bindAgentProvider,
  connect,
  localHost,
  message,
} from "./api";
import { protocols } from "./ProviderSettings";
import { formatEnvironment, parseEnvironment } from "./agentEnvironment";
import { SettingsPane } from "./SettingsPane";
import type { AgentEnvironment, AgentInfo, Response } from "./protocol";
import type { Workbench } from "./useWorkbench";
import {
  Badge,
  Button,
  Card,
  CardList,
  Disclosure,
  EmptyState,
  Field,
  IconButton,
  ItemRow,
  NoticeBanner,
  Select,
  TextArea,
} from "./ui";

type Catalog = Extract<Response, { kind: "providers" }>;
type EnvironmentDraft = { text: string; saved: string };
type ProviderChoiceDraft = { providerId: string; saved: string };

export function AgentSettings({
  state,
  active,
  onBusy,
  onClose,
  closeDisabled = false,
}: {
  state: Workbench;
  active: boolean;
  onBusy: (busy: boolean) => void;
  onClose?: () => void;
  closeDisabled?: boolean;
}) {
  const [hostId, setHostId] = useState(state.host.id);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [catalog, setCatalog] = useState<Catalog>();
  const [choicesByHost, setChoicesByHost] = useState<
    Record<string, Record<string, ProviderChoiceDraft>>
  >({});
  const [environments, setEnvironments] = useState<
    Record<string, AgentEnvironment>
  >({});
  const [draftsByHost, setDraftsByHost] = useState<
    Record<string, Record<string, EnvironmentDraft>>
  >({});
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const [serverId, setServerId] = useState("");
  const [environmentSupported, setEnvironmentSupported] = useState(false);
  const generation = useRef(0);
  const host = state.hosts.find((h) => h.id === hostId) ?? localHost;
  const environmentDrafts = draftsByHost[host.id] ?? {};
  const hostChoices = choicesByHost[host.id] ?? {};

  useEffect(() => {
    if (!active) {
      setBusy(false);
      return;
    }
    setServerId("");
    setEnvironmentSupported(false);
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    setCatalog(undefined);
    setAgents([]);
    void (async () => {
      const [hello, target, savedEnvironments] = await Promise.all([
        connect(host),
        agentProviders(host.id),
        agentEnvironments(host.id),
      ]);
      if (hello.kind !== "hello")
        throw new Error("无法读取 Agent，请检查主机连接和 Server 版本");
      if (current !== generation.current) return;
      setServerId(hello.server_id);
      setEnvironmentSupported(hello.custom_agent_environment === true);
      if (target.kind !== "providers") throw new Error("Provider 响应不匹配");
      if (current !== generation.current) return;
      setAgents(hello.agents);
      setCatalog(target);
      setEnvironments(savedEnvironments);
      setDraftsByHost((values) => {
        const previous = values[host.id] ?? {};
        const drafts = { ...previous };
        for (const agent of new Set([
          ...hello.agents.map((entry) => entry.id),
          ...Object.keys(savedEnvironments),
          ...Object.keys(previous),
        ])) {
          const saved = formatEnvironment(savedEnvironments[agent] ?? {});
          const draft = previous[agent];
          drafts[agent] = {
            text: draft && draft.text !== draft.saved ? draft.text : saved,
            saved,
          };
        }
        return { ...values, [host.id]: drafts };
      });
      const bindingMap = Object.fromEntries(
        target.bindings.map((b) => [b.agent, b.provider_id]),
      );
      setChoicesByHost((values) => {
        const previous = values[host.id] ?? {};
        const nextChoices = { ...previous };
        for (const agent of new Set([
          ...hello.agents.map((entry) => entry.id),
          ...Object.keys(bindingMap),
          ...Object.keys(previous),
        ])) {
          const saved = bindingMap[agent] ?? "";
          const draft = previous[agent];
          nextChoices[agent] = {
            providerId:
              draft && draft.providerId !== draft.saved
                ? draft.providerId
                : saved,
            saved,
          };
        }
        return { ...values, [host.id]: nextChoices };
      });
    })()
      .catch((e) => {
        if (current === generation.current) setError(message(e));
      })
      .finally(() => {
        if (current === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [host, active, retry]);

  useEffect(() => {
    if (
      editingAgentId &&
      catalog &&
      !agents.some((agent) => agent.id === editingAgentId)
    ) {
      setEditingAgentId(null);
    }
  }, [editingAgentId, catalog, agents]);

  function savedProviderIdFor(agentId: string): string {
    return (
      catalog?.bindings.find((b) => b.agent === agentId)?.provider_id || ""
    );
  }

  function chosenProviderIdFor(agentId: string): string {
    return hostChoices[agentId]?.providerId ?? savedProviderIdFor(agentId);
  }

  function cancelEdit(agentId: string) {
    const savedProvider = savedProviderIdFor(agentId);
    const savedEnv = formatEnvironment(environments[agentId] ?? {});
    setChoicesByHost((values) => ({
      ...values,
      [host.id]: {
        ...values[host.id],
        [agentId]: { providerId: savedProvider, saved: savedProvider },
      },
    }));
    setDraftsByHost((values) => ({
      ...values,
      [host.id]: {
        ...values[host.id],
        [agentId]: { text: savedEnv, saved: savedEnv },
      },
    }));
    setError("");
    setEditingAgentId(null);
  }

  async function saveAgent(agent: AgentInfo) {
    const current = generation.current;
    const savedProvider = savedProviderIdFor(agent.id);
    const chosenProvider = chosenProviderIdFor(agent.id);
    const providerDirty =
      agent.provider_protocols.length > 0 && chosenProvider !== savedProvider;
    const environmentText = environmentDrafts[agent.id]?.text ?? "";
    const savedEnvText = formatEnvironment(environments[agent.id] || {});
    const environmentDirty = environmentText !== savedEnvText;
    if (!providerDirty && !environmentDirty) return;

    setBusy(true);
    setSaving(true);
    onBusy(true);
    setError("");
    setNotice("");
    try {
      if (providerDirty) {
        const result = await bindAgentProvider(
          host.id,
          agent.id,
          chosenProvider || null,
        );
        if (result.kind !== "providers") throw new Error("关联响应不匹配");
        if (current === generation.current) {
          setCatalog(result);
          setChoicesByHost((values) => ({
            ...values,
            [host.id]: {
              ...values[host.id],
              [agent.id]: {
                providerId: chosenProvider,
                saved: chosenProvider,
              },
            },
          }));
        }
      }
      if (environmentDirty) {
        const saved = await saveAgentEnvironment(
          host.id,
          agent.id,
          parseEnvironment(environmentText),
        );
        if (current === generation.current) {
          const formatted = formatEnvironment(saved);
          setEnvironments((values) => ({ ...values, [agent.id]: saved }));
          setDraftsByHost((values) => ({
            ...values,
            [host.id]: {
              ...values[host.id],
              [agent.id]: { text: formatted, saved: formatted },
            },
          }));
        }
      }
      if (current === generation.current) {
        setNotice(
          providerDirty && environmentDirty
            ? "关联与环境变量已保存；下次启动或发送消息时使用最新配置。"
            : providerDirty
              ? "关联已保存；下次发送消息时使用最新配置。"
              : "环境变量已保存；下次启动 Agent 实例时生效，正在执行的任务继续使用原配置。",
        );
        setEditingAgentId(null);
      }
    } catch (e) {
      if (current === generation.current) setError(message(e));
    } finally {
      onBusy(false);
      setSaving(false);
      if (current === generation.current) setBusy(false);
    }
  }

  const editingAgent =
    editingAgentId && catalog
      ? agents.find((entry) => entry.id === editingAgentId)
      : undefined;

  if (editingAgent && catalog) {
    const compatible = catalog.providers.filter((p) =>
      editingAgent.provider_protocols.includes(p.protocol),
    );
    const options = [
      {
        value: "",
        label: "沿用 Agent CLI 配置",
        description: `使用 ${host.name} 上的本地 Agent CLI 配置`,
      },
      ...compatible.map((p) => ({
        value: p.id,
        label: p.name,
        description: p.model,
      })),
    ];
    const savedProvider = savedProviderIdFor(editingAgent.id);
    const chosenProvider = chosenProviderIdFor(editingAgent.id);
    const providerDirty =
      editingAgent.provider_protocols.length > 0 &&
      chosenProvider !== savedProvider;
    const provider = catalog.providers.find((p) => p.id === savedProvider);
    const environmentText = environmentDrafts[editingAgent.id]?.text ?? "";
    const environmentDirty =
      environmentText !==
      formatEnvironment(environments[editingAgent.id] || {});
    let environmentError = "";
    try {
      parseEnvironment(environmentText);
    } catch (e) {
      environmentError = message(e);
    }
    const anyDirty = providerDirty || environmentDirty;
    const invalidProviderSelection =
      providerDirty &&
      !!chosenProvider &&
      !compatible.some((p) => p.id === chosenProvider);
    const invalidEnvironment =
      environmentDirty && (!environmentSupported || !!environmentError);
    const canSave =
      !busy && anyDirty && !invalidProviderSelection && !invalidEnvironment;

    const providerHint = `${
      editingAgent.provider_protocols.length
        ? `支持 ${editingAgent.provider_protocols.map((p) => protocols[p]).join("、")}。`
        : "暂不支持 App Provider 关联。"
    }${
      provider
        ? `当前使用 App 中的 ${provider.name}，每轮发送时读取最新配置。`
        : `当前使用 ${host.name} 上的 Agent CLI 配置。`
    }${providerDirty ? " 新选择尚未保存。" : ""}`;

    return (
      <SettingsPane
        title="连接与 Agent"
        onClose={onClose}
        closeDisabled={closeDisabled || busy}
        subview={{
          parentTitle: "连接与 Agent",
          title: `${editingAgent.name}（${host.name}）`,
          backDisabled: busy,
          onBack: () => {
            setError("");
            setEditingAgentId(null);
          },
          status: saving ? "正在保存…" : anyDirty ? "有未保存的修改" : "已保存",
          footer: (
            <>
              <Button
                variant="subtle"
                size="md"
                disabled={busy}
                onClick={() => cancelEdit(editingAgent.id)}
              >
                取消
              </Button>
              <Button
                variant="primary"
                size="md"
                busy={saving}
                disabled={!canSave}
                onClick={() => void saveAgent(editingAgent)}
              >
                {saving ? "正在保存…" : "保存"}
              </Button>
            </>
          ),
        }}
      >
        {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
        {notice && <NoticeBanner tone="success">{notice}</NoticeBanner>}

        <Card className="agent-card">
          <div className="settings-subview-form">
            <Field label="关联 Provider" hint={providerHint}>
              <Select
                label={`${editingAgent.name} 关联 Provider`}
                size="lg"
                value={chosenProvider}
                options={options}
                disabled={busy || !editingAgent.provider_protocols.length}
                onChange={(id) =>
                  setChoicesByHost((values) => ({
                    ...values,
                    [host.id]: {
                      ...values[host.id],
                      [editingAgent.id]: {
                        providerId: id,
                        saved: savedProvider,
                      },
                    },
                  }))
                }
              />
            </Field>

            <Field
              label="自定义环境变量（ENV）"
              htmlFor={`env-input-${editingAgent.id}`}
              error={environmentError || undefined}
            >
              <TextArea
                id={`env-input-${editingAgent.id}`}
                monospace
                invalid={!!environmentError}
                aria-label={`${editingAgent.name} 环境变量`}
                aria-describedby={`environment-note-${editingAgent.id}`}
                rows={5}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                value={environmentText}
                disabled={busy || !environmentSupported}
                placeholder={
                  "HTTPS_PROXY=http://127.0.0.1:7890\nHTTP_PROXY=http://127.0.0.1:7890\nNO_PROXY=localhost,127.0.0.1"
                }
                onChange={(event) => {
                  const text = event.target.value;
                  setDraftsByHost((values) => ({
                    ...values,
                    [host.id]: {
                      ...values[host.id],
                      [editingAgent.id]: {
                        text,
                        saved: formatEnvironment(
                          environments[editingAgent.id] ?? {},
                        ),
                      },
                    },
                  }));
                }}
              />
              <p
                className="ui-field-hint"
                id={`environment-note-${editingAgent.id}`}
                style={{ margin: "2px 0 0" }}
              >
                每行 NAME=value，值按原文传入，无需 export 或引号。仅用于{" "}
                {host.name} 上的 {editingAgent.name}
                ；留空可恢复继承环境。代理地址须能从该主机访问。
              </p>
              {!environmentSupported && (
                <p className="ui-field-hint" style={{ margin: "2px 0 0" }}>
                  此主机需要更新 Server 并重新连接，才能配置自定义环境变量。
                </p>
              )}
            </Field>
          </div>
        </Card>
      </SettingsPane>
    );
  }

  return (
    <SettingsPane
      title="连接与 Agent"
      description="选择运行主机，查看已安装的 Code Agent，并按需配置关联 Provider 与环境变量。"
      onClose={onClose}
      closeDisabled={closeDisabled || busy}
      actions={
        <>
          <Badge
            tone={
              busy && !serverId ? "neutral" : serverId ? "success" : "danger"
            }
          >
            {busy && !serverId
              ? "正在连接…"
              : serverId
                ? "Server 已连接"
                : "连接中断"}
          </Badge>
          <Select
            label="运行主机"
            menuTitle="主机"
            size="md"
            minMenuWidth={200}
            align="end"
            leading={
              host.id === "local" ? (
                <Monitor size={14.5} />
              ) : (
                <Globe2 size={14.5} />
              )
            }
            value={host.id}
            options={state.hosts.map((h) => ({ value: h.id, label: h.name }))}
            disabled={busy}
            onChange={(nextId) => {
              setHostId(nextId);
              setEditingAgentId(null);
            }}
          />
          <IconButton
            label="重新连接"
            variant="subtle"
            size="md"
            disabled={busy}
            onClick={() => setRetry((v) => v + 1)}
          >
            <RefreshCw
              size={14.5}
              className={busy && !serverId ? "spin" : ""}
            />
          </IconButton>
        </>
      }
    >
      {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
      {notice && <NoticeBanner tone="success">{notice}</NoticeBanner>}
      {busy && !catalog && (
        <NoticeBanner tone="neutral">正在加载…</NoticeBanner>
      )}

      {catalog &&
        (agents.length > 0 ? (
          <CardList label="已安装的 Agent">
            {agents.map((agent) => {
              const savedProvider = savedProviderIdFor(agent.id);
              const chosenProvider = chosenProviderIdFor(agent.id);
              const provider = catalog.providers.find(
                (p) => p.id === savedProvider,
              );
              const savedEnv = environments[agent.id] ?? {};
              const savedEnvCount = Object.keys(savedEnv).length;
              const environmentText =
                environmentDrafts[agent.id]?.text ??
                formatEnvironment(savedEnv);
              const isDirty =
                (agent.provider_protocols.length > 0 &&
                  chosenProvider !== savedProvider) ||
                environmentText !== formatEnvironment(savedEnv);

              return (
                <ItemRow
                  key={agent.id}
                  data-agent-id={agent.id}
                  title={agent.name}
                  badge={
                    <>
                      {agent.available === false && (
                        <Badge tone="warning">未就绪</Badge>
                      )}
                      {provider ? (
                        <Badge tone="brand">{provider.name}</Badge>
                      ) : (
                        <Badge>
                          {agent.provider_protocols.length
                            ? "CLI 默认"
                            : "仅 CLI"}
                        </Badge>
                      )}
                      {savedEnvCount > 0 && (
                        <Badge>{`ENV · ${savedEnvCount}`}</Badge>
                      )}
                      {isDirty && <Badge tone="warning">未保存修改</Badge>}
                    </>
                  }
                  subtitle={
                    agent.provider_protocols.length
                      ? agent.detail
                      : `${agent.detail} · 暂不支持 App Provider 关联`
                  }
                  actions={
                    <Button
                      variant="subtle"
                      size="sm"
                      trailing={<ChevronRight size={14} />}
                      aria-label={`编辑 ${agent.name}`}
                      disabled={busy}
                      onClick={() => {
                        setError("");
                        setNotice("");
                        setEditingAgentId(agent.id);
                      }}
                    >
                      编辑
                    </Button>
                  }
                />
              );
            })}
          </CardList>
        ) : (
          <EmptyState
            icon={<Monitor size={22} />}
            title="未检测到可用 Agent"
            description="请确认当前主机已安装 Code Agent CLI 并重新连接。"
          />
        ))}

      <p className="ui-field-hint" style={{ margin: 0 }}>
        未关联 Provider 时，沿用此主机的 Agent CLI
        配置。关闭设置或桌面窗口不会停止正在执行的任务。
      </p>

      {serverId && (
        <Disclosure title="连接详情">
          <div className="server-identity" style={{ margin: 0 }}>
            Server 实例<span>{serverId}</span>
          </div>
        </Disclosure>
      )}
    </SettingsPane>
  );
}
