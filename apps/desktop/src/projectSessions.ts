import { request, message, ServerRequestError } from "./api";
import { supportsSideChatAgent } from "./composerActions";
import type { Response, Session } from "./protocol";
export type CloseProjectResult = {
  closed: string[];
  failed: { session: Session; error: string }[];
  pendingWrites: Session[];
};
export async function openProjectSessions(
  host: string,
  project: string,
): Promise<Session[]> {
  const result = await request(host, {
    method: "sessions",
    project_id: project,
  });
  if (result.kind !== "sessions") throw new Error("无法读取项目会话状态");
  const sessions = new Map(result.sessions.map((s) => [s.id, s]));
  const deadline = Date.now() + 30_000;
  for (const parent of result.sessions) {
    if (!parent.native_id || !supportsSideChatAgent(parent.agent)) continue;
    let before: string | null = null;
    const cursors = new Set<string>();
    do {
      if (Date.now() >= deadline)
        throw new Error("读取项目全部会话超时，请重试");
      const page: Response = await request(host, {
        method: "side_chat_history",
        session_id: parent.id,
        before,
      }).catch(async (cause) => {
        if (
          before !== null ||
          !(cause instanceof ServerRequestError) ||
          cause.code !== "invalid_request"
        )
          throw cause;
        // Hosts predating side chats have no children. An older side-chat host
        // can supply only a bounded snapshot; never claim it is complete at its cap.
        const legacy = await request(host, {
          method: "side_chats",
          session_id: parent.id,
        }).catch((error): Response => {
          if (
            error instanceof ServerRequestError &&
            error.code === "invalid_request"
          )
            return { kind: "sessions", sessions: [] };
          throw error;
        });
        if (legacy.kind !== "sessions" || legacy.sessions.length >= 100)
          throw new Error("请更新 Server 后读取全部侧边聊天");
        return legacy;
      });
      if (page.kind !== "side_chat_history" && page.kind !== "sessions")
        throw new Error("无法读取项目侧边聊天状态");
      for (const side of page.sessions) sessions.set(side.id, side);
      before = page.kind === "side_chat_history" ? page.next : null;
      if (before && (!page.sessions.length || cursors.has(before)))
        throw new Error("侧边聊天历史分页未前进");
      if (before) cursors.add(before);
    } while (before);
  }
  const all = [...sessions.values()];
  if (all.some((s) => s.project_id !== project))
    throw new Error("会话不属于此项目");
  if (all.some((s) => s.agent_session_open === undefined))
    throw new Error("当前 Server 未提供会话状态，请更新 Server 后重试");
  return all.filter((s) => s.agent_session_open === true);
}
export function needsCloseConfirmation(sessions: Session[]): boolean {
  return sessions.some(
    (s) =>
      s.agent_session_busy !== false ||
      ["running", "waiting", "unknown"].includes(s.status),
  );
}
export async function closeProjectSessions(
  host: string,
  project: string,
  sessions: Session[],
  close: (host: string, id: string) => Promise<Response | void>,
): Promise<CloseProjectResult> {
  const result: CloseProjectResult = {
    closed: [],
    failed: [],
    pendingWrites: [],
  };
  for (const session of sessions) {
    if (session.project_id !== project) throw new Error("会话不属于此项目");
    if (
      result.closed.includes(session.id) ||
      result.failed.some((item) => item.session.id === session.id)
    )
      continue;
    try {
      const response = await close(host, session.id);
      result.closed.push(session.id);
      if (response?.kind === "side_chat_closed")
        result.pendingWrites.push(session);
    } catch (error) {
      result.failed.push({ session, error: message(error) });
    }
  }
  return result;
}
