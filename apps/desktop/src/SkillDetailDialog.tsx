import { useState } from "react";
import { Box, Copy, Folder } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { message } from "./api";
import { copyText } from "./clipboard";
import { skillScopes as scopes, skillStates as states } from "./SkillGrid";
import type { ManagedSkill, Response, SkillState } from "./protocol";
import { Badge, Button, Dialog, NoticeBanner, Switch, Well } from "./ui";

export function SkillDetailDialog({
  detail,
  skill,
  error,
  busy,
  connected,
  hostName,
  onClose,
  onChange,
  onError,
  onRefresh,
}: {
  detail?: Extract<Response, { kind: "skill_detail" }>;
  skill?: ManagedSkill;
  error: string;
  busy: boolean;
  connected: boolean;
  hostName?: string;
  onClose: () => void;
  onChange: (skill: ManagedSkill, next: SkillState) => void;
  onError: (error: string) => void;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open
      width={680}
      className="skill-detail"
      title={skill?.name ?? "技能详情"}
      description={
        detail ? skill?.description || "此技能未提供描述。" : undefined
      }
      ariaDescribedBy={!detail ? "skill-detail-status" : undefined}
      headerLeading={
        <span className="skills-icon">
          <Box size={20} />
        </span>
      }
      headerActions={
        skill ? (
          <Switch
            label="启用技能"
            checked={skill.state === "enabled"}
            disabled={busy || !connected || skill.state === "uninstalled"}
            onChange={() =>
              onChange(
                skill,
                skill.state === "enabled" ? "disabled" : "enabled",
              )
            }
          />
        ) : undefined
      }
      closeLabel="关闭技能详情"
      busy={busy}
      onClose={onClose}
      footer={
        detail ? (
          <>
            {skill && skill.state !== "uninstalled" && (
              <Button
                variant="danger"
                size="md"
                style={{ marginRight: "auto" }}
                disabled={busy || !connected}
                onClick={() => onChange(skill, "uninstalled")}
              >
                卸载
              </Button>
            )}
            <Button
              variant="subtle"
              size="md"
              disabled={busy}
              title="复制完整 SKILL.md，包含名称和描述元数据"
              leading={<Copy size={14.5} />}
              onClick={() => {
                void copyText(detail.markdown)
                  .then(() => setCopied(true))
                  .catch((e) => onError(message(e)));
              }}
            >
              {copied ? "已复制" : "复制 Markdown"}
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={busy || !connected || skill?.state !== "uninstalled"}
              onClick={() => {
                if (skill) onChange(skill, "enabled");
              }}
            >
              {skill?.state === "uninstalled" ? "安装" : "已安装"}
            </Button>
          </>
        ) : undefined
      }
    >
      {!detail && (
        <p
          id="skill-detail-status"
          role="status"
          className="ui-dialog-description"
        >
          {error ? "技能详情暂不可用" : "正在读取…"}
        </p>
      )}
      {detail && (
        <>
          <div className="skill-detail-meta" style={{ marginBottom: 0 }}>
            <Badge>
              {scopes.find((s) => s.value === skill?.scope)?.label} ·{" "}
              {skill && states[skill.state]}
            </Badge>
            {hostName && <Badge>{hostName}</Badge>}
          </div>
          {skill?.directory && (
            <Well
              className="skill-detail-path"
              title={skill.directory}
              style={{ padding: "6px 10px", margin: 0 }}
            >
              <Folder size={13.5} />
              <span>{skill.directory}</span>
            </Well>
          )}
          <div
            className="skill-markdown markdown"
            role="region"
            aria-label="技能正文"
            tabIndex={0}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ children, href }) => <span title={href}>{children}</span>,
                img: ({ alt }) => <span>{alt || "图片"}</span>,
              }}
            >
              {detail.markdown.replace(
                /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
                "",
              )}
            </ReactMarkdown>
          </div>
        </>
      )}
      {error && (
        <NoticeBanner
          tone="danger"
          action={
            <Button
              size="xs"
              variant="subtle"
              disabled={busy}
              onClick={() => onRefresh()}
            >
              刷新核对
            </Button>
          }
        >
          {error}
        </NoticeBanner>
      )}
    </Dialog>
  );
}
