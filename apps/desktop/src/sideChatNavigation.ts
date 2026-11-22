import { request, ServerRequestError } from "./api";
import type { RecentCursor, Session } from "./protocol";

async function ownsSideChat(
  hostId: string,
  parentId: string,
  sideId: string,
): Promise<boolean> {
  const seenCursors = new Set<string>();
  let before: string | null = null;
  while (true) {
    try {
      const page = await request(hostId, {
        method: "side_chat_history",
        session_id: parentId,
        before,
      });
      if (page.kind !== "side_chat_history") return false;
      if (page.sessions.some((item) => item.id === sideId)) return true;
      if (
        !page.next ||
        page.sessions.length === 0 ||
        seenCursors.has(page.next)
      )
        return false;
      seenCursors.add(page.next);
      before = page.next;
    } catch (cause) {
      if (
        before === null &&
        cause instanceof ServerRequestError &&
        cause.code === "unsupported"
      ) {
        const legacy = await request(hostId, {
          method: "side_chats",
          session_id: parentId,
        });
        return (
          legacy.kind === "sessions" &&
          legacy.sessions.some((item) => item.id === sideId)
        );
      }
      throw cause;
    }
  }
}

/** Resolves the owning parent session of a side chat across projects and server versions. */
export async function resolveSideChatParentSession(
  hostId: string,
  sideId: string,
): Promise<Session> {
  const sideResponse = await request(hostId, {
    method: "session",
    session_id: sideId,
  });
  if (sideResponse.kind !== "session" || sideResponse.session.id !== sideId)
    throw new Error("无法读取侧边聊天记录");
  const side = sideResponse.session;
  if (side.parent_session_id) {
    const parentResponse = await request(hostId, {
      method: "session",
      session_id: side.parent_session_id,
    });
    if (
      parentResponse.kind !== "session" ||
      parentResponse.session.id !== side.parent_session_id ||
      parentResponse.session.id === sideId ||
      parentResponse.session.project_id !== side.project_id
    )
      throw new Error("侧边聊天记录不匹配");
    return parentResponse.session;
  }
  const checked = new Set<string>([sideId]);
  const sessionsResponse = await request(hostId, {
    method: "sessions",
    project_id: side.project_id,
  });
  if (sessionsResponse.kind !== "sessions")
    throw new Error("无法读取侧边聊天所属项目的会话列表");
  for (const candidate of sessionsResponse.sessions) {
    if (candidate.parent_session_id || checked.has(candidate.id)) continue;
    checked.add(candidate.id);
    if (await ownsSideChat(hostId, candidate.id, sideId)) return candidate;
  }
  const seenRecentCursors = new Set<string>();
  let before: RecentCursor | null = null;
  while (true) {
    let page;
    try {
      page = await request(hostId, { method: "recent_sessions", before });
    } catch (cause) {
      if (cause instanceof ServerRequestError && cause.code === "unsupported")
        break;
      throw cause;
    }
    if (page.kind !== "recent_sessions") break;
    for (const entry of page.sessions) {
      const candidate = entry.session;
      if (
        candidate.project_id !== side.project_id ||
        candidate.parent_session_id ||
        checked.has(candidate.id)
      )
        continue;
      checked.add(candidate.id);
      if (await ownsSideChat(hostId, candidate.id, sideId)) return candidate;
    }
    if (!page.next || page.sessions.length === 0) break;
    const cursorKey = JSON.stringify([page.next.updated_at, page.next.id]);
    if (seenRecentCursors.has(cursorKey)) break;
    seenRecentCursors.add(cursorKey);
    before = page.next;
  }
  const seenAgentCursors = new Set<string>();
  let after: string | null = null;
  while (true) {
    let page;
    try {
      page = await request(hostId, {
        method: "project_agent_sessions",
        project_id: side.project_id,
        after,
      });
    } catch (cause) {
      if (cause instanceof ServerRequestError && cause.code === "unsupported")
        break;
      throw cause;
    }
    if (page.kind !== "project_agent_sessions") break;
    for (const candidate of page.sessions) {
      if (candidate.parent_session_id || checked.has(candidate.id)) continue;
      checked.add(candidate.id);
      if (await ownsSideChat(hostId, candidate.id, sideId)) return candidate;
    }
    if (
      !page.next ||
      page.sessions.length === 0 ||
      seenAgentCursors.has(page.next)
    )
      break;
    seenAgentCursors.add(page.next);
    after = page.next;
  }
  throw new Error("未找到侧边聊天所属的主会话");
}
