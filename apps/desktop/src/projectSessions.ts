import { request, message, ServerRequestError } from "./api";
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
  const sessions = new Map<string, Session>();
  const deadline = Date.now() + 30_000;
  let after: string | null = null;
  do {
    if (Date.now() >= deadline) throw new Error("读取项目全部会话超时，请重试");
    const page: Response = await request(host, {
      method: "project_agent_sessions",
      project_id: project,
      after,
    }).catch((cause) => {
      if (
        cause instanceof ServerRequestError &&
        cause.code === "invalid_request"
      )
        throw new Error("请更新 Server 后读取项目全部运行会话");
      throw cause;
    });
    if (page.kind !== "project_agent_sessions")
      throw new Error("无法读取项目运行会话状态");
    if (
      page.next !== null &&
      (!page.sessions.length ||
        page.next !== page.sessions.at(-1)?.id ||
        (after !== null && page.next <= after))
    )
      throw new Error("项目运行会话分页未前进");
    for (const side of page.sessions) sessions.set(side.id, side);
    after = page.next;
  } while (after !== null);
  const all = [...sessions.values()];
  if (all.some((s) => s.project_id !== project))
    throw new Error("会话不属于此项目");
  if (all.some((s) => s.agent_session_open === undefined))
    throw new Error("当前 Server 未提供会话状态，请更新 Server 后重试");
  return all;
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
