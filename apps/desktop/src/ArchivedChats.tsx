import { useEffect, useState } from "react";
import { Archive, Folder } from "lucide-react";
import { message, request } from "./api";
import { SettingsPane } from "./SettingsPane";
import type { Session } from "./protocol";
import type { Workbench } from "./useWorkbench";
import {
  Button,
  CardList,
  EmptyState,
  FilterBar,
  ItemRow,
  NoticeBanner,
  SearchInput,
  Section,
  SectionHeader,
  Select,
} from "./ui";

export function ArchivedChats({
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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [records, setRecords] = useState<Record<string, Session[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const targets = JSON.stringify(
    state.projects.map((p) => ({ hostId: p.hostId, id: p.id })),
  );
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setLoading(true);
    setRecords({});
    setErrors({});
    void (async () => {
      for (const p of JSON.parse(targets) as { hostId: string; id: string }[]) {
        if (disposed) return;
        const key = `${p.hostId}:${p.id}`;
        try {
          const result = await request(p.hostId, {
            method: "sessions",
            project_id: p.id,
          });
          if (result.kind !== "sessions") throw new Error("无法加载聊天");
          if (!disposed)
            setRecords((old) => ({
              ...old,
              [key]: result.sessions.filter((s) => s.archived),
            }));
        } catch (e) {
          if (!disposed) setErrors((old) => ({ ...old, [key]: message(e) }));
        }
      }
      if (!disposed) setLoading(false);
    })();
    return () => {
      disposed = true;
    };
  }, [active, targets, revision]);

  async function restore(hostId: string, session: Session) {
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      await state.sessionAction(hostId, {
        method: "archive_session",
        session_id: session.id,
        archived: false,
      });
      const key = `${hostId}:${session.project_id}`;
      setRecords((old) => ({
        ...old,
        [key]: (old[key] ?? []).filter((s) => s.id !== session.id),
      }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }

  const groups = state.projects
    .filter((p) => !filter || `${p.hostId}:${p.id}` === filter)
    .map((p) => ({
      ...p,
      key: `${p.hostId}:${p.id}`,
      chats: (records[`${p.hostId}:${p.id}`] ?? []).filter((s) =>
        s.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
    }));

  return (
    <SettingsPane
      title="已归档的聊天"
      description="按项目检索并恢复已归档的历史对话记录。"
      className="archived-chats"
      onClose={onClose}
      closeDisabled={closeDisabled || busy}
    >
      <FilterBar className="archive-filters">
        <SearchInput
          aria-label="搜索已归档的聊天"
          placeholder="搜索已归档的聊天"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery("")}
        />
        <Select
          label="筛选项目"
          leading={<Folder size={14.5} />}
          size="md"
          minMenuWidth={220}
          align="end"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "", label: "所有项目" },
            ...state.projects.map((p) => ({
              value: `${p.hostId}:${p.id}`,
              label: `${p.name} · ${state.hosts.find((h) => h.id === p.hostId)?.name ?? p.hostId}`,
            })),
          ]}
        />
      </FilterBar>
      {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
      {loading && <NoticeBanner tone="neutral">正在加载…</NoticeBanner>}
      {groups.map((p) =>
        p.chats.length > 0 || errors[p.key] ? (
          <Section key={p.key} className="archive-group">
            <SectionHeader
              icon={<Folder size={15} />}
              title={p.name}
              meta={state.hosts.find((h) => h.id === p.hostId)?.name}
              count={errors[p.key] ? undefined : `${p.chats.length} 个聊天`}
            />
            {errors[p.key] && (
              <NoticeBanner
                tone="danger"
                action={
                  <Button
                    size="xs"
                    variant="subtle"
                    disabled={busy || loading}
                    onClick={() => setRevision((v) => v + 1)}
                  >
                    重试
                  </Button>
                }
              >
                {errors[p.key]}
              </NoticeBanner>
            )}
            {p.chats.length > 0 && (
              <CardList>
                {p.chats.map((s) => (
                  <ItemRow
                    key={s.id}
                    title={s.title}
                    actions={
                      <Button
                        size="sm"
                        variant="subtle"
                        disabled={busy || loading}
                        aria-label={`取消归档 ${s.title}`}
                        onClick={() => void restore(p.hostId, s)}
                      >
                        取消归档
                      </Button>
                    }
                  />
                ))}
              </CardList>
            )}
          </Section>
        ) : null,
      )}
      {!loading && !groups.some((p) => p.chats.length || errors[p.key]) && (
        <EmptyState
          icon={<Archive size={22} />}
          title={
            query || filter ? "没有匹配的已归档聊天" : "还没有已归档的聊天"
          }
          description={
            query || filter
              ? "尝试更换搜索关键词或切换到所有项目。"
              : "在左侧边栏对会话执行归档后，可随时在此找回并恢复。"
          }
        />
      )}
    </SettingsPane>
  );
}
