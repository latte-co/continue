import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Folder, FolderPlus, Pencil, Server, X } from "lucide-react";
import { chooseProjectFolder, message, revealProject } from "./api";
import { isHiddenOrInert } from "./Modal";
import {
  openProjectSessions,
  needsCloseConfirmation,
  closeProjectSessions,
  type CloseProjectResult,
} from "./projectSessions";
import type { HostedProject } from "./projectCatalog";
import type { Session } from "./protocol";
import { RemoteFolderBrowser } from "./RemoteFolderBrowser";
import type { Workbench } from "./useWorkbench";
import {
  Button,
  Dialog,
  Disclosure,
  Field,
  IconButton,
  MenuRow,
  MenuSeparator,
  NoticeBanner,
  Popover,
  TextInput,
  Well,
} from "./ui";

export function ProjectActions({
  project,
  point,
  close,
  state,
}: {
  project: HostedProject;
  point: { x: number; y: number };
  close: () => void;
  state: Workbench;
}) {
  const [view, setView] = useState<
    "menu" | "edit" | "remove" | "close" | "close-result"
  >("menu");
  const [opened, setOpened] = useState<Session[]>();
  const [closeTargets, setCloseTargets] = useState<Session[]>([]);
  const [closeResult, setCloseResult] = useState<CloseProjectResult>({
    closed: [],
    failed: [],
  });
  const [name, setName] = useState(project.name);
  const [path, setPath] = useState(project.path);
  const [picking, setPicking] = useState(false);
  const [remoteBrowser, setRemoteBrowser] = useState(false);
  const [removeFromEdit, setRemoveFromEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogBody = useRef<HTMLDivElement>(null);
  const folderButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const editFocusTarget = useRef<"folder" | "remove" | null>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const disabled = busy || picking;
  const trimmedPath = path.trim();
  const folderName = trimmedPath
    ? (trimmedPath.split("/").filter(Boolean).at(-1) ?? "/")
    : "";
  const remoteHost =
    project.hostId === "local"
      ? undefined
      : state.hosts?.find((h) => h.id === project.hostId);

  function applySelectedFolder(selected: string) {
    setPath(selected);
    if (!name.trim())
      setName(selected.split("/").filter(Boolean).at(-1) ?? "项目");
    if (remoteBrowser) editFocusTarget.current = "folder";
    setRemoteBrowser(false);
    setError("");
  }

  async function pickFolder() {
    if (project.hostId !== "local") {
      if (!remoteHost) {
        setError("项目所在主机已移除");
        return;
      }
      setError("");
      setRemoteBrowser(true);
      return;
    }
    setPicking(true);
    try {
      const selected = await chooseProjectFolder();
      if (mounted.current && selected) applySelectedFolder(selected);
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      if (mounted.current) setPicking(false);
    }
  }

  useEffect(() => {
    if (view !== "menu") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const rows = await openProjectSessions(project.hostId, project.id);
        if (!disposed) {
          setOpened(rows);
          setError("");
        }
      } catch (cause) {
        if (!disposed) setError(message(cause));
      }
      if (!disposed) timer = setTimeout(() => void load(), 5000);
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [project.hostId, project.id, view]);

  useEffect(
    () => () => {
      if (opener.current?.isConnected && !isHiddenOrInert(opener.current))
        opener.current.focus();
    },
    [],
  );

  useLayoutEffect(() => {
    if (view !== "edit" || remoteBrowser || !editFocusTarget.current) return;
    const target = editFocusTarget.current;
    editFocusTarget.current = null;
    (target === "folder"
      ? folderButton.current
      : removeButton.current
    )?.focus();
  }, [view, remoteBrowser, trimmedPath]);

  useEffect(() => {
    if (view === "menu") return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isHiddenOrInert(dialogBody.current)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (disabled) return;
      if (view === "edit" && remoteBrowser) {
        editFocusTarget.current = "folder";
        setRemoteBrowser(false);
        return;
      }
      if (view === "remove" && removeFromEdit) {
        editFocusTarget.current = "remove";
        setError("");
        setView("edit");
        return;
      }
      close();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [view, disabled, remoteBrowser, removeFromEdit, close]);

  async function performClose(targets: Session[], confirmed = false) {
    setBusy(true);
    setError("");
    try {
      const result = await closeProjectSessions(
        project.hostId,
        project.id,
        targets,
        (host, id) =>
          state.sessionAction(host, {
            method: "close_agent_session",
            session_id: id,
            only_if_idle: !confirmed,
          }),
      );
      setCloseResult((old) => ({
        closed: [...old.closed, ...result.closed],
        failed: result.failed,
      }));
      if (!result.failed.length) close();
      else setView("close-result");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function retryFailed() {
    setBusy(true);
    setError("");
    try {
      const currentOpened = await openProjectSessions(
        project.hostId,
        project.id,
      );
      const targets = closeResult.failed.map(
        (item) =>
          currentOpened.find((s) => s.id === item.session.id) ?? item.session,
      );
      setCloseTargets(targets);
      if (needsCloseConfirmation(targets)) setView("close");
      else await performClose(targets);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function closeAll() {
    setBusy(true);
    setError("");
    try {
      const targets = await openProjectSessions(project.hostId, project.id);
      setOpened(targets);
      setCloseTargets(targets);
      if (!targets.length) return;
      if (needsCloseConfirmation(targets)) setView("close");
      else await performClose(targets);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      if (view === "edit")
        await state.updateProject(project.hostId, project.id, name, path);
      else await state.removeProject(project.hostId, project.id);
      close();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const finder = () => {
    close();
    void revealProject(project.hostId, project.id).catch((e) =>
      state.setError(message(e)),
    );
  };

  if (view === "menu") {
    return (
      <Popover
        open
        anchorPoint={point}
        minWidth={204}
        role="menu"
        label={`${project.name} 项目操作`}
        restoreFocusOnEscape={false}
        onContextMenu={(e) => e.preventDefault()}
        onClose={() => {
          if (!busy) close();
        }}
      >
        <MenuRow
          role="menuitem"
          leading={<Pencil size={15} />}
          onClick={() => {
            setError("");
            setRemoveFromEdit(false);
            setRemoteBrowser(false);
            setView("edit");
          }}
        >
          编辑
        </MenuRow>
        {project.hostId === "local" && (
          <>
            <MenuSeparator />
            <MenuRow
              role="menuitem"
              leading={<Folder size={15} />}
              onClick={finder}
            >
              在 Finder 中显示
            </MenuRow>
          </>
        )}
        <MenuSeparator />
        <MenuRow
          role="menuitem"
          disabled={busy || !opened?.length}
          leading={<X size={15} />}
          title={error || "关闭此项目已打开的 Agent 会话，保留聊天记录"}
          onClick={() => void closeAll()}
        >
          {opened === undefined
            ? "关闭全部对话"
            : `关闭全部对话（${opened.length}）`}
        </MenuRow>
        <MenuSeparator />
        <MenuRow
          role="menuitem"
          danger
          disabled={busy}
          leading={<X size={15} />}
          onClick={() => {
            setError("");
            setRemoveFromEdit(false);
            setView("remove");
          }}
        >
          移除项目
        </MenuRow>
        {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
      </Popover>
    );
  }

  const dialogAriaLabel =
    view === "edit"
      ? "编辑项目"
      : view === "remove"
        ? "移除项目"
        : "关闭全部对话";
  const isRemoteBrowseView = Boolean(
    view === "edit" && remoteBrowser && remoteHost,
  );
  const dialogTitle = isRemoteBrowseView ? "选择文件夹" : dialogAriaLabel;

  return (
    <Dialog
      open
      size={view === "edit" ? "md" : "sm"}
      className={view === "edit" ? "project-modal" : undefined}
      ariaLabel={dialogAriaLabel}
      title={dialogTitle}
      description={
        isRemoteBrowseView && remoteHost ? (
          <span
            className="folder-browser-host"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <Server size={13.5} />
            {remoteHost.name}
          </span>
        ) : undefined
      }
      busy={disabled}
      onClose={close}
      footer={
        isRemoteBrowseView ? undefined : view === "edit" ? (
          <>
            <Button
              ref={removeButton}
              variant="danger"
              size="md"
              disabled={disabled}
              style={{ marginRight: "auto" }}
              onClick={() => {
                setError("");
                setRemoveFromEdit(true);
                setView("remove");
              }}
            >
              {project.hostId === "local" ? "移除本地项目" : "移除项目"}
            </Button>
            <Button
              variant="subtle"
              size="md"
              disabled={disabled}
              onClick={close}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="project-action-form"
              variant="primary"
              size="md"
              busy={busy}
              disabled={disabled || !name.trim() || !trimmedPath}
            >
              {busy ? "正在保存…" : "保存"}
            </Button>
          </>
        ) : (
          <>
            <Button
              autoFocus
              variant="subtle"
              size="md"
              disabled={busy}
              onClick={() => {
                if (view === "remove" && removeFromEdit) {
                  editFocusTarget.current = "remove";
                  setError("");
                  setView("edit");
                } else {
                  close();
                }
              }}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="project-action-form"
              variant={view === "remove" ? "danger" : "primary"}
              size="md"
              busy={busy}
              disabled={busy}
            >
              {busy
                ? view === "close" || view === "close-result"
                  ? "正在关闭…"
                  : "正在保存…"
                : view === "remove"
                  ? "移除项目"
                  : view === "close"
                    ? "关闭全部"
                    : closeResult.failed.length
                      ? "重试失败项"
                      : "完成"}
            </Button>
          </>
        )
      }
    >
      <div ref={dialogBody}>
        {isRemoteBrowseView && remoteHost ? (
          <RemoteFolderBrowser
            host={remoteHost}
            initialPath={trimmedPath}
            cancel={() => {
              editFocusTarget.current = "folder";
              setRemoteBrowser(false);
            }}
            select={applySelectedFolder}
          />
        ) : view === "edit" ? (
          <form
            id="project-action-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <fieldset
              disabled={disabled}
              style={{
                border: 0,
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-3)",
                minWidth: 0,
              }}
            >
              <Field label="项目名称" htmlFor="edit-project-name">
                <TextInput
                  id="edit-project-name"
                  autoFocus
                  aria-label="项目名称"
                  placeholder="项目名称"
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>

              <Field label="源文件夹">
                <Well
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-2)",
                    padding: "10px 12px",
                  }}
                >
                  {trimmedPath && (
                    <div
                      className="chosen-folder"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <Folder size={16} />
                      <span
                        className="project-folder-name"
                        title={trimmedPath}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontWeight: 500,
                        }}
                      >
                        {folderName}
                      </span>
                      <IconButton
                        size="xs"
                        label="移除源文件夹"
                        onClick={() => {
                          editFocusTarget.current = "folder";
                          setPath("");
                        }}
                      >
                        <X size={14} />
                      </IconButton>
                    </div>
                  )}
                  <div>
                    <Button
                      ref={folderButton}
                      variant="subtle"
                      size="md"
                      busy={picking}
                      leading={!picking ? <FolderPlus size={15} /> : undefined}
                      onClick={() => void pickFolder()}
                    >
                      {trimmedPath ? "更换文件夹" : "添加文件夹"}
                    </Button>
                  </div>
                </Well>
              </Field>

              <Disclosure title="输入文件夹路径">
                <TextInput
                  aria-label="项目绝对路径"
                  monospace
                  placeholder={
                    project.hostId === "local"
                      ? "/Users/you/projects/my-project"
                      : "/home/user/projects/my-project"
                  }
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                />
              </Disclosure>

              {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
            </fieldset>
          </form>
        ) : (
          <form
            id="project-action-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (view === "close") void performClose(closeTargets, true);
              else if (view === "close-result") {
                if (closeResult.failed.length) void retryFailed();
                else close();
              } else void save();
            }}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3)",
            }}
          >
            {view === "close" ? (
              <p
                style={{
                  margin: 0,
                  fontSize: "var(--text-sm)",
                  color: "var(--color-text-secondary)",
                  lineHeight: 1.55,
                }}
              >
                将关闭「{project.name}」的 {closeTargets.length} 个 Agent
                会话，其中有运行任务、待审批操作、后台任务或待确认状态。关闭会停止这些任务，聊天记录、草稿和置顶状态保留。
              </p>
            ) : view === "close-result" ? (
              <NoticeBanner tone="warning">
                <p style={{ margin: "0 0 4px" }}>
                  已关闭 {closeResult.closed.length} 个，
                  {closeResult.failed.length} 个关闭失败。
                </p>
                {closeResult.failed.map((item) => (
                  <p key={item.session.id} style={{ margin: 0 }}>
                    {item.session.title}：{item.error}
                  </p>
                ))}
              </NoticeBanner>
            ) : (
              <p
                style={{
                  margin: 0,
                  fontSize: "var(--text-sm)",
                  color: "var(--color-text-secondary)",
                  lineHeight: 1.55,
                }}
              >
                将「{project.name}
                」从项目列表移除。文件和聊天记录会保留，重新添加同一目录即可恢复。
              </p>
            )}
            {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
          </form>
        )}
      </div>
    </Dialog>
  );
}
