import { Modal } from "./Modal";
import { RemoteFolderBrowser } from "./RemoteFolderBrowser";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Folder, FolderPlus, LoaderCircle, Pencil, X } from "lucide-react";
import { chooseProjectFolder, message, revealProject } from "./api";
import {
  openProjectSessions,
  needsCloseConfirmation,
  closeProjectSessions,
  type CloseProjectResult,
} from "./projectSessions";
import type { Session } from "./protocol";
import type { HostedProject } from "./projectCatalog";
import type { Workbench } from "./useWorkbench";
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
  const [position, setPosition] = useState(point);
  const menu = useRef<HTMLDivElement>(null);
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
      const opened = await openProjectSessions(project.hostId, project.id);
      const targets = closeResult.failed.map(
        (item) => opened.find((s) => s.id === item.session.id) ?? item.session,
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
  useEffect(
    () => () => {
      if (opener.current?.isConnected) opener.current.focus();
    },
    [],
  );
  useLayoutEffect(() => {
    if (menu.current) {
      const rect = menu.current.getBoundingClientRect();
      setPosition({
        x: Math.max(8, Math.min(point.x, window.innerWidth - rect.width - 8)),
        y: Math.max(8, Math.min(point.y, window.innerHeight - rect.height - 8)),
      });
      menu.current.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [point]);
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
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
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
      }
      if (view !== "menu") return;
      if (e.key === "Tab") {
        close();
        return;
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const buttons = Array.from(
          menu.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? [],
        );
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        buttons[
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? buttons.length - 1
              : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                buttons.length
        ]?.focus();
      }
    };
    const outside = (e: PointerEvent) => {
      if (view === "menu" && !busy && !menu.current?.contains(e.target as Node))
        close();
    };
    const resize = () => {
      if (view === "menu") close();
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", resize);
    };
  }, [view, disabled, busy, remoteBrowser, removeFromEdit, close]);
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
  if (view === "menu")
    return createPortal(
      <div
        ref={menu}
        role="menu"
        aria-label={`${project.name} 项目操作`}
        className="project-context-menu"
        style={{ left: position.x, top: position.y }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <button
          role="menuitem"
          onClick={() => {
            setError("");
            setRemoveFromEdit(false);
            setRemoteBrowser(false);
            setView("edit");
          }}
        >
          <Pencil size={17} />
          <span>编辑</span>
        </button>
        {project.hostId === "local" && (
          <>
            <div role="separator" />
            <button role="menuitem" onClick={finder}>
              <Folder size={17} />
              <span>在 Finder 中显示</span>
            </button>
          </>
        )}
        <div role="separator" />
        <button
          role="menuitem"
          disabled={busy || !opened?.length}
          title={error || "关闭此项目已打开的 Agent 会话，保留聊天记录"}
          onClick={() => void closeAll()}
        >
          <X size={17} />
          <span>
            {opened === undefined
              ? "关闭全部对话"
              : `关闭全部对话（${opened.length}）`}
          </span>
        </button>
        <div role="separator" />
        <button
          role="menuitem"
          disabled={busy}
          onClick={() => {
            setError("");
            setRemoveFromEdit(false);
            setView("remove");
          }}
        >
          <X size={17} />
          <span>移除项目</span>
        </button>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>,
      document.body,
    );
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !disabled) close();
      }}
    >
      <Modal
        className={view === "edit" ? "modal project-modal" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-label={
          view === "edit"
            ? "编辑项目"
            : view === "remove"
              ? "移除项目"
              : "关闭全部对话"
        }
      >
        <button
          type="button"
          className="modal-close icon-button"
          aria-label="关闭"
          disabled={disabled}
          onClick={close}
        >
          <X size={view === "edit" ? 20 : 18} />
        </button>
        {view === "edit" && remoteBrowser && remoteHost ? (
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
          <>
            <h2>编辑项目</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <fieldset disabled={disabled}>
                <div className="project-name-input">
                  <Folder size={21} />
                  <input
                    autoFocus
                    aria-label="项目名称"
                    placeholder="项目名称"
                    maxLength={100}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <h3>源文件夹</h3>
                <div className="project-folder-list">
                  {trimmedPath && (
                    <div className="project-folder-row">
                      <Folder size={18} />
                      <span className="project-folder-name" title={trimmedPath}>
                        {folderName}
                      </span>
                      <button
                        type="button"
                        className="icon-button project-folder-clear"
                        aria-label="移除源文件夹"
                        title="移除源文件夹"
                        onClick={() => {
                          editFocusTarget.current = "folder";
                          setPath("");
                        }}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  )}
                  <button
                    ref={folderButton}
                    type="button"
                    className="project-folder-action"
                    onClick={() => void pickFolder()}
                  >
                    {picking ? (
                      <LoaderCircle size={18} className="spin" />
                    ) : (
                      <FolderPlus size={18} />
                    )}
                    <span>{trimmedPath ? "更换文件夹" : "添加文件夹"}</span>
                  </button>
                </div>
                <details className="manual-path">
                  <summary>输入文件夹路径</summary>
                  <input
                    aria-label="项目绝对路径"
                    placeholder={
                      project.hostId === "local"
                        ? "/Users/you/projects/my-project"
                        : "/home/user/projects/my-project"
                    }
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                  />
                </details>
                {error && (
                  <div className="form-error" role="alert">
                    {error}
                  </div>
                )}
                <div className="modal-actions project-edit-actions">
                  <button
                    ref={removeButton}
                    type="button"
                    className="danger-soft"
                    onClick={() => {
                      setError("");
                      setRemoveFromEdit(true);
                      setView("remove");
                    }}
                  >
                    {project.hostId === "local" ? "移除本地项目" : "移除项目"}
                  </button>
                  <div className="project-edit-submit">
                    <button className="secondary" type="button" onClick={close}>
                      取消
                    </button>
                    <button
                      className="primary"
                      disabled={disabled || !name.trim() || !trimmedPath}
                    >
                      {busy ? "正在保存…" : "保存"}
                    </button>
                  </div>
                </div>
              </fieldset>
            </form>
          </>
        ) : (
          <>
            <h2>{view === "remove" ? "移除项目" : "关闭全部对话"}</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (view === "close") void performClose(closeTargets, true);
                else if (view === "close-result") {
                  if (closeResult.failed.length) void retryFailed();
                  else close();
                } else void save();
              }}
            >
              {view === "close" ? (
                <p>
                  将关闭「{project.name}」的 {closeTargets.length} 个 Agent
                  会话，其中有运行任务、待审批操作、后台任务或待确认状态。关闭会停止这些任务，聊天记录、草稿和置顶状态保留。
                </p>
              ) : view === "close-result" ? (
                <div role="status">
                  <p>
                    已关闭 {closeResult.closed.length} 个，
                    {closeResult.failed.length} 个关闭失败。
                  </p>
                  {closeResult.failed.map((item) => (
                    <p key={item.session.id}>
                      {item.session.title}：{item.error}
                    </p>
                  ))}
                </div>
              ) : (
                <p>
                  将「{project.name}
                  」从项目列表移除。文件和聊天记录会保留，重新添加同一目录即可恢复。
                </p>
              )}
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
              <div className="modal-actions">
                <button
                  autoFocus
                  className="secondary"
                  type="button"
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
                </button>
                <button className="primary" disabled={busy}>
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
                </button>
              </div>
            </form>
          </>
        )}
      </Modal>
    </div>,
    document.body,
  );
}
