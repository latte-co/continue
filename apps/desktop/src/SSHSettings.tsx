import { useState } from "react";
import { FolderOpen, Globe2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { CopyButton } from "./MessageContent";
import { chooseIdentityFile, message, type Host } from "./api";
import type { Workbench } from "./useWorkbench";
import {
  Badge,
  Button,
  CardList,
  ChoiceGroup,
  Dialog,
  Disclosure,
  EmptyState,
  Field,
  IconButton,
  InputGroup,
  ItemRow,
  NoticeBanner,
  PageContainer,
  PageHeader,
  TextInput,
} from "./ui";

const setupCommands =
  'cargo build --release -p latte-work-server --locked\nmkdir -p "$HOME/.local/bin"\ninstall -m 755 target/release/latte-work-server "$HOME/.local/bin/latte-work-server"';

type Auth = NonNullable<Host["auth"]>;
type Draft = {
  id: string;
  name: string;
  ssh: string;
  port: string;
  serverPath: string;
  auth: Auth;
  identityFile: string;
  password: string;
};

function draftFor(host?: Host): Draft {
  return {
    id: host?.id ?? crypto.randomUUID(),
    name: host?.name ?? "",
    ssh: host?.ssh ?? "",
    port: host?.port?.toString() ?? "",
    serverPath: host?.server_path ?? "",
    auth: host?.auth ?? "none",
    identityFile: host?.identity_file ?? "",
    password: "",
  };
}

const authOptions: { value: Auth; label: string }[] = [
  { value: "none", label: "默认身份验证" },
  { value: "identity_file", label: "身份文件" },
  { value: "password", label: "密码" },
];

export function SSHSettings({
  state,
  onBusy,
}: {
  state: Workbench;
  onBusy: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [workingHost, setWorkingHost] = useState("");
  const [error, setError] = useState("");
  const hosts = state.hosts.filter((host) => host.ssh);

  function update(patch: Partial<Draft>) {
    setDraft((value) => value && { ...value, ...patch });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || busy) return;
    setError("");
    const port = draft.port.trim() ? Number(draft.port.trim()) : null;
    if (
      port !== null &&
      (!Number.isInteger(port) || port < 1 || port > 65535)
    ) {
      setError("SSH 端口必须是 1–65535");
      return;
    }
    const existing = hosts.find((host) => host.id === draft.id);
    if (
      draft.auth === "password" &&
      !draft.password &&
      (existing?.auth !== "password" ||
        existing.ssh !== draft.ssh.trim() ||
        (existing.port ?? null) !== port)
    ) {
      setError("请输入本次连接使用的 SSH 密码");
      return;
    }
    const host: Host = {
      id: draft.id,
      name: draft.name.trim(),
      ssh: draft.ssh.trim(),
      port,
      server_path: draft.serverPath.trim(),
      auth: draft.auth,
      identity_file:
        draft.auth === "identity_file" ? draft.identityFile.trim() : null,
    };
    setBusy(true);
    onBusy(true);
    try {
      await state.saveSshHost(
        host,
        draft.auth === "password" ? draft.password : undefined,
      );
      setDraft(null);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }

  async function remove(host: Host) {
    if (
      !window.confirm(
        `移除 SSH 连接「${host.name}」？此设备上的项目将从侧边栏隐藏。`,
      )
    )
      return;
    setWorkingHost(host.id);
    onBusy(true);
    setError("");
    try {
      await state.removeSshHost(host.id);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setWorkingHost("");
      onBusy(false);
    }
  }

  async function pickIdentityFile() {
    try {
      const path = await chooseIdentityFile();
      if (path) update({ identityFile: path });
    } catch (cause) {
      setError(message(cause));
    }
  }

  const editingExisting = !!draft && hosts.some((host) => host.id === draft.id);

  return (
    <PageContainer className="settings-panel-content ssh-settings">
      <PageHeader
        title="SSH 连接"
        description="管理远程项目使用的 SSH 主机。远程设备需先安装 Latte Work Server。"
        actions={
          <Button
            variant="primary"
            size="md"
            leading={<Plus size={15} />}
            onClick={(event) => {
              event.currentTarget.focus();
              setError("");
              setDraft(draftFor());
            }}
          >
            添加
          </Button>
        }
      />

      <Disclosure title="准备远程设备" className="ssh-setup">
        <ol>
          <li>
            在终端运行 <code>ssh 你的主机</code>，核对并确认主机指纹。
          </li>
          <li>
            在远端安装并登录所需 Agent，用 <code>claude --version</code> 或{" "}
            <code>traex --version</code>、<code>codex --version</code>、
            <code>opencode --version</code> 检查。Server
            与桌面端应从同一版本源码构建。
          </li>
          <li>
            在远端源码目录执行（需要 Rust 1.97 和 C 编译器）：
            <pre>{setupCommands}</pre>
            <CopyButton text={setupCommands} label="复制安装命令" />
          </li>
          <li>
            运行 <code>~/.local/bin/latte-work-server --help</code>{" "}
            检查可执行文件，然后添加连接。无需手动常驻启动服务。
          </li>
        </ol>
        <p>
          连接失败时先检查 SSH 登录、主机指纹、Server 路径及版本；Agent
          不可用时检查远端 CLI 登录和非交互 Shell 的
          PATH。升级前先结束任务并关闭终端。
        </p>
      </Disclosure>

      {hosts.length ? (
        <CardList label="SSH 主机列表">
          {hosts.map((host) => {
            const status = state.hostErrors[host.id];
            const checked = Object.hasOwn(state.hostErrors, host.id);
            const authLabel = authOptions.find(
              (option) => option.value === (host.auth ?? "none"),
            )?.label;
            return (
              <ItemRow
                key={host.id}
                icon={<Globe2 size={16} />}
                title={host.name}
                badge={
                  <Badge
                    tone={
                      workingHost === host.id
                        ? "neutral"
                        : status
                          ? "danger"
                          : checked
                            ? "success"
                            : "neutral"
                    }
                  >
                    {workingHost === host.id
                      ? "正在处理…"
                      : status
                        ? "连接失败"
                        : checked
                          ? "已连接"
                          : "等待连接"}
                  </Badge>
                }
                subtitle={
                  status
                    ? `${host.ssh}${host.port ? `:${host.port}` : ""} · ${status}`
                    : `${host.ssh}${host.port ? `:${host.port}` : ""} · ${authLabel}`
                }
                actions={
                  <>
                    <IconButton
                      label="重新连接"
                      variant="subtle"
                      size="sm"
                      disabled={!!workingHost || busy}
                      onClick={() => void state.refreshHost(host)}
                    >
                      <RefreshCw size={14} />
                    </IconButton>
                    <Button
                      variant="subtle"
                      size="sm"
                      disabled={!!workingHost || busy}
                      onClick={(event) => {
                        event.currentTarget.focus();
                        setError("");
                        setDraft(draftFor(host));
                      }}
                    >
                      编辑
                    </Button>
                    <IconButton
                      label={`移除 ${host.name}`}
                      variant="ghost"
                      size="sm"
                      disabled={!!workingHost || busy}
                      onClick={() => void remove(host)}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </>
                }
              />
            );
          })}
        </CardList>
      ) : (
        <EmptyState
          icon={<Globe2 size={22} />}
          title="尚未添加 SSH 连接"
          description="添加远程开发机后，即可与本机项目共享一致的会话、文件与终端体验。"
        />
      )}

      <p className="ui-field-hint" style={{ margin: 0 }}>
        默认身份验证使用现有 OpenSSH 配置或 SSH
        Agent。首次连接请先在终端确认主机指纹。密码仅在本次应用运行期间保留；重启后连接时会提示重新输入。
      </p>

      {!draft && error && <NoticeBanner tone="danger">{error}</NoticeBanner>}

      <Dialog
        open={!!draft}
        title={editingExisting ? "编辑 SSH 连接" : "添加 SSH 连接"}
        busy={busy}
        className="ssh-modal"
        onClose={() => {
          if (!document.querySelector(".ssh-password-modal")) setDraft(null);
        }}
        footer={
          <>
            <Button
              variant="subtle"
              size="md"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="ssh-host-form"
              variant="primary"
              size="md"
              busy={busy}
            >
              {busy ? "正在连接…" : "保存并连接"}
            </Button>
          </>
        }
      >
        {draft && (
          <form
            id="ssh-host-form"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
            onSubmit={(event) => void save(event)}
          >
            <Field label="显示名称" htmlFor="ssh-name">
              <TextInput
                id="ssh-name"
                autoFocus
                required
                maxLength={100}
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>
            <Field label="主机名" htmlFor="ssh-host">
              <TextInput
                id="ssh-host"
                required
                monospace
                placeholder="host.com 或 user@host.com"
                value={draft.ssh}
                onChange={(event) => update({ ssh: event.target.value })}
              />
            </Field>
            <Field label="SSH 端口（可选）" htmlFor="ssh-port">
              <TextInput
                id="ssh-port"
                type="number"
                min={1}
                max={65535}
                placeholder="22"
                value={draft.port}
                onChange={(event) => update({ port: event.target.value })}
              />
            </Field>
            <Disclosure title="高级设置">
              <Field
                label="远程 Server 路径（可选）"
                htmlFor="ssh-server-path"
                hint="留空时自动查找远端 ~/.local/bin/latte-work-server 及 PATH。其他安装位置可填写绝对路径。"
              >
                <TextInput
                  id="ssh-server-path"
                  monospace
                  placeholder="自动查找远程 Server"
                  value={draft.serverPath}
                  onChange={(event) =>
                    update({ serverPath: event.target.value })
                  }
                />
              </Field>
            </Disclosure>
            <Field label="身份验证">
              <ChoiceGroup
                label="身份验证方式"
                value={draft.auth}
                options={authOptions}
                onChange={(auth) => update({ auth })}
              />
            </Field>
            {draft.auth === "identity_file" && (
              <Field label="身份文件" htmlFor="ssh-identity-file">
                <InputGroup>
                  <TextInput
                    id="ssh-identity-file"
                    required
                    monospace
                    placeholder="/Users/name/.ssh/id_ed25519"
                    value={draft.identityFile}
                    onChange={(event) =>
                      update({ identityFile: event.target.value })
                    }
                  />
                  <IconButton
                    label="选择身份文件"
                    variant="subtle"
                    size="lg"
                    onClick={() => void pickIdentityFile()}
                  >
                    <FolderOpen size={16} />
                  </IconButton>
                </InputGroup>
              </Field>
            )}
            {draft.auth === "password" && (
              <Field
                label="SSH 密码"
                htmlFor="ssh-password"
                hint="密码不会写入连接配置。应用重启后连接时会提示重新输入。"
              >
                <TextInput
                  id="ssh-password"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    hosts.some(
                      (host) =>
                        host.id === draft.id && host.auth === "password",
                    )
                      ? "留空则使用本次运行已输入的密码"
                      : undefined
                  }
                  value={draft.password}
                  onChange={(event) => update({ password: event.target.value })}
                />
              </Field>
            )}
            {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
          </form>
        )}
      </Dialog>
    </PageContainer>
  );
}
