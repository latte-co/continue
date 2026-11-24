import { useEffect, useState } from "react";
import { Globe2, Monitor, RefreshCw } from "lucide-react";
import { SkillAddMenu } from "./SkillAddMenu";
import { SkillDetailDialog } from "./SkillDetailDialog";
import { SkillChangeDialog, SkillImportDialog } from "./SkillOperationDialogs";
import {
  SkillGrid,
  skillScopes as scopes,
  type GlobalSkillScope,
} from "./SkillGrid";
import { useSkills } from "./useSkills";
import type { Workbench } from "./useWorkbench";
import {
  Button,
  Disclosure,
  FilterBar,
  IconButton,
  NoticeBanner,
  PageContainer,
  PageHeader,
  SearchInput,
  Section,
  SectionHeader,
  Select,
  Tabs,
} from "./ui";
import "./skills.css";

export function SkillsSettings({
  state,
  active,
  onBusy,
  onCreate,
}: {
  state: Workbench;
  active: boolean;
  onBusy: (busy: boolean) => void;
  onCreate?: (hostId: string) => void;
}) {
  const [scope, setScope] = useState<GlobalSkillScope>("platform");
  const [query, setQuery] = useState("");
  const [installedExpanded, setInstalledExpanded] = useState(false);
  const [categoryExpanded, setCategoryExpanded] = useState(false);
  const {
    hostId,
    setHostId,
    host,
    connected,
    catalog,
    loading,
    busy,
    notice,
    pageError,
    detailError,
    operationError,
    setDetailError,
    clearErrors,
    detail,
    selected,
    setSelected,
    setDetail,
    confirm,
    setConfirm,
    add,
    setAdd,
    refresh,
    operation,
    context,
    reload,
    mutate,
    change,
    selectSkill,
  } = useSkills(state, active, onBusy);

  useEffect(() => {
    setInstalledExpanded(false);
    setCategoryExpanded(false);
  }, [context]);

  const filtered = (catalog?.skills ?? []).filter(
    (s) =>
      s.scope !== "project" &&
      `${s.name} ${s.description} ${s.origin}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const installed = filtered.filter((s) => s.state !== "uninstalled");
  const category = filtered.filter((s) => s.scope === scope);
  const locked = busy || loading || !connected;
  const skill = detail?.skill;

  return (
    <PageContainer
      size="wide"
      className="settings-panel-content skills-settings"
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.key !== "Escape" ||
          (!selected && !add)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (operation.current) return;
        if (confirm) setConfirm(undefined);
        else if (add) setAdd(false);
        else {
          setSelected(undefined);
          setDetail(undefined);
        }
      }}
    >
      <PageHeader
        title="技能"
        description="管理当前主机的全局技能"
        actions={
          <FilterBar className="skills-toolbar">
            <SearchInput
              aria-label="搜索技能"
              placeholder="搜索技能"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery("")}
            />
            <Select
              label="技能所在主机"
              menuTitle="主机"
              minMenuWidth={240}
              align="end"
              size="md"
              leading={
                hostId === "local" ? (
                  <Monitor size={14.5} />
                ) : (
                  <Globe2 size={14.5} />
                )
              }
              value={hostId}
              disabled={busy}
              options={state.hosts.map((h) => ({ value: h.id, label: h.name }))}
              onChange={setHostId}
            />
            <IconButton
              ref={refresh}
              label="刷新技能"
              variant="subtle"
              size="md"
              disabled={locked}
              onClick={() => reload()}
            >
              <RefreshCw
                size={15.5}
                className={loading ? "skills-spinning" : ""}
              />
            </IconButton>
            <SkillAddMenu
              key={context}
              disabled={busy || !active}
              importDisabled={locked || !catalog}
              onCreate={onCreate ? () => onCreate(hostId) : undefined}
              onImport={() => {
                clearErrors();
                setAdd(true);
              }}
            />
          </FilterBar>
        }
      />

      {!connected && (
        <NoticeBanner tone="warning">
          {host?.name ?? "主机"} 未连接。请在「连接与 Agent」中连接后查看技能。
        </NoticeBanner>
      )}
      {pageError && !selected && !add && (
        <NoticeBanner
          tone="danger"
          action={
            <Button
              size="xs"
              variant="subtle"
              disabled={busy || loading || !connected}
              onClick={() => reload()}
            >
              刷新核对
            </Button>
          }
        >
          {pageError}
        </NoticeBanner>
      )}
      {notice && <NoticeBanner tone="success">{notice}</NoticeBanner>}
      {loading && <NoticeBanner tone="neutral">正在读取技能…</NoticeBanner>}

      {catalog && (
        <>
          {(catalog.warnings.length > 0 || catalog.truncated) && (
            <Disclosure
              title="部分目录未能完整读取"
              className="skills-warnings"
            >
              {catalog.warnings.map((w, i) => (
                <p key={i} style={{ margin: 0 }}>
                  {w}
                </p>
              ))}
              {catalog.truncated && (
                <p style={{ margin: 0 }}>
                  扫描达到数量、大小或时间上限，部分技能可能未显示；请整理目录后刷新。
                </p>
              )}
            </Disclosure>
          )}

          <Section className="skills-installed">
            <SectionHeader title="已安装" count={installed.length} />
            <SkillGrid
              skills={installed}
              expanded={installedExpanded}
              onExpand={setInstalledExpanded}
              query={query}
              loading={loading}
              disabled={busy || !connected}
              label="已安装技能"
              emptyMessage="暂无技能"
              onSelect={selectSkill}
            />
          </Section>

          <Section className="skills-categories">
            <Tabs
              label="技能分类"
              idPrefix="skill-tab-"
              panelId="skill-category-panel"
              value={scope}
              onChange={(nextScope) => {
                setScope(nextScope);
                setCategoryExpanded(false);
              }}
              options={scopes.map((s) => ({
                value: s.value,
                label: s.label,
              }))}
            />
            <p className="skills-scope-note" style={{ margin: "2px 0 6px" }}>
              {scope === "platform"
                ? "随 Latte Work 提供，仅注入 Work 启动的 Agent。"
                : "当前主机的全局技能；文件操作会影响该主机上的其他 Agent。"}
            </p>
            <div
              role="tabpanel"
              id="skill-category-panel"
              aria-labelledby={`skill-tab-${scope}`}
            >
              <SkillGrid
                skills={category}
                expanded={categoryExpanded}
                onExpand={setCategoryExpanded}
                query={query}
                loading={loading}
                disabled={busy || !connected}
                label="分类技能"
                emptyMessage="暂无技能"
                onSelect={selectSkill}
              />
            </div>
          </Section>
        </>
      )}

      {active && selected && (
        <SkillDetailDialog
          key={selected}
          detail={detail}
          skill={skill}
          error={detailError}
          busy={busy}
          connected={connected}
          hostName={host?.name}
          onClose={() => {
            if (!busy && !confirm) {
              setSelected(undefined);
              setDetail(undefined);
            }
          }}
          onChange={change}
          onError={setDetailError}
          onRefresh={() => {
            setSelected(undefined);
            reload();
          }}
        />
      )}
      {active && confirm && (
        <SkillChangeDialog
          confirm={confirm}
          hostName={host?.name}
          busy={busy}
          connected={connected}
          error={operationError}
          onClose={() => setConfirm(undefined)}
          onConfirm={() => void mutate(confirm)}
        />
      )}
      {active && add && (
        <SkillImportDialog
          hostName={host?.name}
          busy={busy}
          connected={connected}
          supported={state.hostSupportsSkillFiles(hostId)}
          error={operationError}
          onClose={() => setAdd(false)}
          onImport={(upload) => void mutate(upload)}
        />
      )}
    </PageContainer>
  );
}
