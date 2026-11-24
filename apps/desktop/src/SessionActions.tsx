import { copyText } from "./clipboard";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  ArrowLeft,
  ChevronRight,
  Copy,
  Eye,
  Pencil,
  Pin,
  PinOff,
  Square,
  X,
} from "lucide-react";
import { message, request } from "./api";
import type { Workbench } from "./useWorkbench";
import type { HostedSession } from "./sessionNavigation";
import { conversationMarkdown, loadConversation } from "./sessionNavigation";
import {
  agentSessionLabels,
  type AgentSessionState,
} from "./agentSessionState";
import {
  Button,
  Dialog,
  Field,
  MenuRow,
  MenuSeparator,
  NoticeBanner,
  Popover,
  TextArea,
  TextInput,
} from "./ui";

export function SessionActions({
  session,
  agentState,
  point,
  align = "start",
  trigger,
  close,
  state,
}: {
  session: HostedSession;
  agentState: AgentSessionState;
  point: { x: number; y: number };
  align?: "start" | "end";
  trigger?: HTMLElement | null;
  close: () => void;
  state: Workbench;
}) {
  const [view, setView] = useState<
    "menu" | "rename" | "copy" | "transcript" | "confirm-close"
  >("menu");
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [copied, setCopied] = useState(false);
  const [closeId, setCloseId] = useState<string>();
  const opener = useRef(document.activeElement as HTMLElement | null);
  const triggerRef = useRef<HTMLElement | null>(trigger ?? null);
  triggerRef.current = trigger ?? null;

  useEffect(
    () => () => {
      if (opener.current?.isConnected) opener.current.focus();
    },
    [],
  );

  const menuView = view === "menu" || view === "copy";
  const active = ["running", "waiting"].includes(session.status);
  const canClose = agentState === "open";
  const previousView = useRef(view);

  useLayoutEffect(() => {
    if (view === "menu" && previousView.current === "copy") {
      document
        .querySelector<HTMLButtonElement>(".session-context-menu [data-copy]")
        ?.focus();
    } else if (view === "copy" && previousView.current === "menu") {
      document
        .querySelector<HTMLButtonElement>(
          ".session-context-menu button:not(:disabled)",
        )
        ?.focus();
    }
    previousView.current = view;
  }, [view]);

  async function perform(action: () => Promise<unknown>, dismiss = true) {
    setBusy(true);
    setError("");
    try {
      await action();
      if (dismiss) close();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const run = (action: Parameters<Workbench["sessionAction"]>[1]) =>
    void perform(() => state.sessionAction(session.hostId, action));
  const id = session.id;

  async function copy(text: string) {
    await copyText(text);
    setCopied(true);
  }

  if (menuView) {
    return (
      <Popover
        open
        anchorPoint={point}
        anchorRef={triggerRef}
        align={align}
        minWidth={204}
        role="menu"
        label={`${session.title} 会话操作`}
        className="session-context-menu"
        restoreFocusOnEscape={false}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" && view === "copy") {
            e.preventDefault();
            e.stopPropagation();
            setView("menu");
          } else if (
            e.key === "ArrowRight" &&
            (document.activeElement as HTMLElement)?.dataset.copy === "true"
          ) {
            e.preventDefault();
            e.stopPropagation();
            setView("copy");
          }
        }}
        onClose={(fromEscape) => {
          if (busy) return;
          if (fromEscape && view === "copy") {
            setView("menu");
            return;
          }
          close();
        }}
      >
        {view === "copy" ? (
          <>
            <MenuRow
              role="menuitem"
              disabled={busy}
              leading={<ArrowLeft size={15} />}
              onClick={() => setView("menu")}
            >
              返回
            </MenuRow>
            <MenuSeparator />
            <MenuRow
              role="menuitem"
              disabled={busy}
              leading={<Copy size={15} />}
              onClick={() => void perform(() => copy(session.title))}
            >
              复制标题
            </MenuRow>
            <MenuRow
              role="menuitem"
              disabled={busy}
              leading={<Copy size={15} />}
              onClick={() => void perform(() => copy(id))}
            >
              复制会话 ID
            </MenuRow>
            <MenuRow
              role="menuitem"
              disabled={busy}
              leading={<Copy size={15} />}
              onClick={() =>
                void perform(async () => {
                  const events = await loadConversation((after) =>
                    request(session.hostId, {
                      method: "poll",
                      session_id: id,
                      after,
                    }),
                  );
                  setMarkdown(conversationMarkdown(session.title, events));
                  setView("transcript");
                }, false)
              }
            >
              {busy ? "读取完整对话…" : "对话 Markdown…"}
            </MenuRow>
          </>
        ) : (
          <>
            <MenuRow
              role="menuitem"
              disabled={busy}
              leading={<Pencil size={15} />}
              onClick={() => setView("rename")}
            >
              重命名
            </MenuRow>
            <MenuRow
              role="menuitem"
              disabled={busy || session.archived}
              leading={
                session.pinned_at === null ? (
                  <Pin size={15} />
                ) : (
                  <PinOff size={15} />
                )
              }
              onClick={() =>
                run({
                  method: "pin_session",
                  session_id: id,
                  pinned: session.pinned_at === null,
                })
              }
            >
              {session.pinned_at === null ? "置顶" : "取消置顶"}
            </MenuRow>
            <MenuRow
              role="menuitem"
              disabled={busy}
              leading={<Eye size={15} />}
              onClick={() =>
                run({
                  method: "mark_session_unread",
                  session_id: id,
                  unread: !session.unread,
                })
              }
            >
              {session.unread ? "标记为已读" : "标记为未读"}
            </MenuRow>
            <MenuSeparator />
            <MenuRow
              role="menuitem"
              disabled={busy}
              data-copy="true"
              leading={<Copy size={15} />}
              trailing={<ChevronRight size={13.5} />}
              onClick={() => setView("copy")}
            >
              复制…
            </MenuRow>
            <MenuSeparator />
            {session.agent_close_pending && (
              <MenuRow
                role="menuitem"
                disabled={busy || active}
                leading={<Check size={15} />}
                onClick={() => {
                  setCloseId(session.agent_close_pending);
                  setView("confirm-close");
                }}
              >
                核对原生会话关闭
              </MenuRow>
            )}
            {active && (
              <MenuRow
                role="menuitem"
                disabled={busy}
                leading={<Square size={15} />}
                onClick={() => run({ method: "cancel", session_id: id })}
              >
                停止任务
              </MenuRow>
            )}
            <MenuRow
              role="menuitem"
              disabled={busy || !canClose}
              leading={<X size={15} />}
              title={
                canClose
                  ? "关闭对话，保留历史"
                  : agentState === "closed"
                    ? "此对话尚未打开"
                    : agentSessionLabels[agentState]
              }
              onClick={() =>
                canClose &&
                run({ method: "close_agent_session", session_id: id })
              }
            >
              关闭
            </MenuRow>
            <MenuRow
              role="menuitem"
              disabled={busy || active}
              leading={
                session.archived ? (
                  <ArchiveRestore size={15} />
                ) : (
                  <Archive size={15} />
                )
              }
              title={active ? "请先停止任务，再归档" : undefined}
              onClick={() =>
                run({
                  method: "archive_session",
                  session_id: id,
                  archived: !session.archived,
                })
              }
            >
              {session.archived ? "取消归档" : "归档"}
            </MenuRow>
          </>
        )}
        {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
      </Popover>
    );
  }

  const dialogTitle =
    view === "rename"
      ? "重命名会话"
      : view === "confirm-close"
        ? "核对原生会话关闭"
        : "复制对话";

  return (
    <Dialog
      open
      size={view === "transcript" ? "lg" : "sm"}
      ariaLabel={dialogTitle}
      title={dialogTitle}
      busy={busy}
      onClose={close}
      footer={
        view === "rename" ? (
          <>
            <Button variant="subtle" size="md" disabled={busy} onClick={close}>
              取消
            </Button>
            <Button
              type="submit"
              form="rename-session-form"
              variant="primary"
              size="md"
              busy={busy}
              disabled={busy}
            >
              {busy ? "保存中…" : "保存"}
            </Button>
          </>
        ) : view === "confirm-close" ? (
          <>
            <Button variant="subtle" size="md" disabled={busy} onClick={close}>
              取消
            </Button>
            <Button
              variant="primary"
              size="md"
              busy={busy}
              disabled={
                busy || !closeId || closeId !== session.agent_close_pending
              }
              onClick={() =>
                closeId &&
                run({
                  method: "confirm_agent_closed",
                  session_id: id,
                  close_id: closeId,
                })
              }
            >
              我已核对，确认关闭
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="md"
            disabled={busy}
            leading={copied ? <Check size={15} /> : <Copy size={15} />}
            onClick={() => void perform(() => copy(markdown), false)}
          >
            {copied ? "已复制" : "复制"}
          </Button>
        )
      }
    >
      {view === "rename" ? (
        <form
          id="rename-session-form"
          onSubmit={(e) => {
            e.preventDefault();
            run({ method: "rename_session", session_id: id, title });
          }}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
          }}
        >
          <Field label="会话名称" htmlFor="rename-session-input">
            <TextInput
              id="rename-session-input"
              autoFocus
              required
              maxLength={100}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
            />
          </Field>
          {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
        </form>
      ) : view === "confirm-close" ? (
        <>
          <p className="ui-field-hint" style={{ margin: 0 }}>
            请先在执行主机上确认原生进程和后台任务已停止，再继续会话。
          </p>
          {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
        </>
      ) : (
        <>
          <p className="ui-field-hint" style={{ margin: 0 }}>
            复制截至读取时的用户和助手消息，保留 Markdown
            格式，不包含工具原始输出。
          </p>
          <TextArea
            className="copy-transcript"
            aria-label="对话 Markdown"
            monospace
            rows={10}
            readOnly
            value={markdown}
          />
          {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
        </>
      )}
    </Dialog>
  );
}
