import { useEffect, useRef, useState } from "react";
import { RefreshCw, Monitor, LoaderCircle } from "lucide-react";
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
import type { AgentEnvironment, AgentInfo, Response } from "./protocol";
import type { Workbench } from "./useWorkbench";
import {
  Badge,
  Button,
  Card,
  CardFooter,
  CardHeader,
  CardList,
  Disclosure,
  Field,
  ItemRow,
  NoticeBanner,
  PageContainer,
  PageHeader,
  Select,
  SettingRow,
  TextArea,
} from "./ui";

type Catalog = Extract<Response, { kind: "providers" }>;
type EnvironmentDraft = { text: string; saved: string };

export function AgentSettings({
  state,
  active,
  onBusy,
}: {
  state: Workbench;
  active: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const [hostId, setHostId] = useState(state.host.id);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [catalog, setCatalog] = useState<Catalog>();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [environments, setEnvironments] = useState<
    Record<string, AgentEnvironment>
  >({});
  const [draftsByHost, setDraftsByHost] = useState<
    Record<string, Record<string, EnvironmentDraft>>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const [serverId, setServerId] = useState("");
  const [environmentSupported, setEnvironmentSupported] = useState(false);
  const generation = useRef(0);
  const host = state.hosts.find((h) => h.id === hostId) ?? localHost;
  const environmentDrafts = draftsByHost[host.id] ?? {};

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
          ...hello.agents.map((agent) => agent.id),
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
      setChoices(
        Object.fromEntries(
          target.bindings.map((b) => [b.agent, b.provider_id]),
        ),
      );
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

  async function bind(agent: string) {
    const current = generation.current;
    setBusy(true);
    onBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await bindAgentProvider(
        host.id,
        agent,
        choices[agent] || null,
      );
      if (result.kind !== "providers") throw new Error("关联响应不匹配");
      if (current === generation.current) {
        setCatalog(result);
        setNotice("关联已保存；下次发送消息时使用最新配置。");
      }
    } catch (e) {
      if (current === generation.current) setError(message(e));
    } finally {
      onBusy(false);
      if (current === generation.current) setBusy(false);
    }
  }

  async function saveEnvironment(agent: string) {
    const current = generation.current;
    setBusy(true);
    onBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await saveAgentEnvironment(
        host.id,
        agent,
        parseEnvironment(environmentDrafts[agent]?.text ?? ""),
      );
      if (current === generation.current) {
        setEnvironments((values) => ({ ...values, [agent]: saved }));
        setDraftsByHost((values) => ({
          ...values,
          [host.id]: {
            ...values[host.id],
            [agent]: {
              text: formatEnvironment(saved),
              saved: formatEnvironment(saved),
            },
          },
        }));
        setNotice(
          "环境变量已保存；下次启动 Agent 实例时生效，正在执行的任务继续使用原配置。",
        );
      }
    } catch (e) {
      if (current === generation.current) setError(message(e));
    } finally {
      onBusy(false);
      if (current === generation.current) setBusy(false);
    }
  }

  return (
    <PageContainer className="settings-panel-content">
      <PageHeader
        title="连接与 Agent"
        description="选择运行主机，为 Code Agent 配置 Provider 和环境变量。"
      />

      <CardList>
        <SettingRow label="运行主机" description="切换查看或配置的目标主机">
          <Select
            label="运行主机"
            size="md"
            minMenuWidth={200}
            align="end"
            value={host.id}
            options={state.hosts.map((h) => ({ value: h.id, label: h.name }))}
            disabled={busy}
            onChange={setHostId}
          />
        </SettingRow>
        <ItemRow
          icon={
            busy && !serverId ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Monitor size={16} />
            )
          }
          title={host.name}
          badge={
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
          }
          actions={
            <Button
              variant="subtle"
              size="sm"
              leading={<RefreshCw size={13.5} />}
              disabled={busy}
              onClick={() => setRetry((v) => v + 1)}
            >
              重新连接
            </Button>
          }
        />
      </CardList>

      {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
      {notice && <NoticeBanner tone="success">{notice}</NoticeBanner>}
      {busy && !catalog && (
        <NoticeBanner tone="neutral">正在加载…</NoticeBanner>
      )}

      {catalog &&
        agents.map((agent) => {
          const compatible = catalog.providers.filter((p) =>
            agent.provider_protocols.includes(p.protocol),
          );
          const options = [
            { value: "", label: "沿用 Agent CLI 配置" },
            ...compatible.map((p) => ({
              value: p.id,
              label: p.name,
              description: p.model,
            })),
          ];
          const saved =
            catalog.bindings.find((b) => b.agent === agent.id)?.provider_id ||
            "";
          const dirty = (choices[agent.id] || "") !== saved;
          const provider = catalog.providers.find((p) => p.id === saved);
          const environmentText = environmentDrafts[agent.id]?.text ?? "";
          const environmentDirty =
            environmentText !== formatEnvironment(environments[agent.id] || {});
          let environmentError = "";
          try {
            parseEnvironment(environmentText);
          } catch (e) {
            environmentError = message(e);
          }
          const providerHint = `${
            agent.provider_protocols.length
              ? `支持 ${agent.provider_protocols.map((p) => protocols[p]).join("、")}。`
              : "暂不支持 App Provider 关联。"
          }${
            provider
              ? `当前使用 App 中的 ${provider.name}，每轮发送时读取最新配置。`
              : `当前使用 ${host.name} 上的 Agent CLI 配置。`
          }${dirty ? " 新选择尚未保存。" : ""}`;

          return (
            <Card className="agent-card" key={agent.id}>
              <CardHeader title={agent.name} description={agent.detail} />
              <div style={{ padding: "14px 16px" }}>
                <Field label="关联 Provider" hint={providerHint}>
                  <Select
                    label={`${agent.name} 关联 Provider`}
                    size="lg"
                    value={choices[agent.id] || ""}
                    options={options}
                    disabled={busy || !agent.provider_protocols.length}
                    onChange={(id) =>
                      setChoices({ ...choices, [agent.id]: id })
                    }
                  />
                </Field>
              </div>
              <CardFooter status={dirty ? "有未保存的修改" : "已保存"}>
                <Button
                  variant="primary"
                  size="sm"
                  busy={busy && dirty}
                  disabled={
                    busy ||
                    !dirty ||
                    (!!choices[agent.id] &&
                      !compatible.some((p) => p.id === choices[agent.id]))
                  }
                  onClick={() => void bind(agent.id)}
                >
                  {busy && dirty ? "正在保存…" : "保存关联"}
                </Button>
              </CardFooter>

              <div
                className="agent-environment"
                style={{
                  padding: "14px 16px",
                  borderTop: "1px solid var(--color-border-subtle)",
                }}
              >
                <Field
                  label="自定义环境变量（ENV）"
                  htmlFor={`env-input-${agent.id}`}
                  error={environmentError || undefined}
                >
                  <TextArea
                    id={`env-input-${agent.id}`}
                    monospace
                    invalid={!!environmentError}
                    aria-label={`${agent.name} 环境变量`}
                    aria-describedby={`environment-note-${agent.id}`}
                    rows={4}
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
                          [agent.id]: {
                            text,
                            saved: formatEnvironment(
                              environments[agent.id] ?? {},
                            ),
                          },
                        },
                      }));
                    }}
                  />
                </Field>
                <p
                  className="ui-field-hint"
                  id={`environment-note-${agent.id}`}
                  style={{ margin: "6px 0 0" }}
                >
                  每行 NAME=value，值按原文传入，无需 export 或引号。仅用于{" "}
                  {host.name} 上的 {agent.name}
                  ；留空可恢复继承环境。代理地址须能从该主机访问。
                </p>
                {!environmentSupported && (
                  <p className="ui-field-hint" style={{ margin: "6px 0 0" }}>
                    此主机需要更新 Server 并重新连接，才能配置自定义环境变量。
                  </p>
                )}
              </div>
              <CardFooter
                status={
                  environmentDirty ? "有未保存的环境变量" : "环境变量已保存"
                }
              >
                <Button
                  variant="primary"
                  size="sm"
                  disabled={
                    busy ||
                    !environmentSupported ||
                    !environmentDirty ||
                    !!environmentError
                  }
                  onClick={() => void saveEnvironment(agent.id)}
                >
                  保存环境变量
                </Button>
              </CardFooter>
            </Card>
          );
        })}

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
    </PageContainer>
  );
}
