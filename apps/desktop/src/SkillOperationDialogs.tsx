import type { SkillChange } from "./useSkills";
import { Button, Dialog, NoticeBanner, Well } from "./ui";

type Shared = {
  hostName?: string;
  busy: boolean;
  connected: boolean;
  error: string;
  onClose: () => void;
};

export function SkillChangeDialog({
  confirm,
  hostName,
  busy,
  connected,
  error,
  onClose,
  onConfirm,
}: Shared & { confirm: SkillChange; onConfirm: () => void }) {
  const actionVerb =
    confirm.next === "uninstalled"
      ? "卸载"
      : confirm.next === "disabled"
        ? "禁用"
        : confirm.skill.state === "uninstalled"
          ? "安装"
          : "启用";
  return (
    <Dialog
      open
      size="sm"
      hideCloseButton
      backdropClassName="skill-confirm-backdrop"
      title={`${actionVerb} ${confirm.skill.name}？`}
      ariaDescribedBy="skill-confirm-description"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="subtle"
            size="md"
            disabled={busy}
            onClick={() => onClose()}
          >
            取消
          </Button>
          <Button
            variant={confirm.next === "uninstalled" ? "danger" : "primary"}
            size="md"
            busy={busy}
            disabled={busy || !connected}
            onClick={() => onConfirm()}
          >
            {busy ? "正在保存…" : "确认"}
          </Button>
        </>
      }
    >
      <div
        id="skill-confirm-description"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
          fontSize: "var(--text-sm)",
          color: "var(--color-text-secondary)",
          lineHeight: 1.55,
        }}
      >
        <div>主机：{hostName}</div>
        <Well
          className="skill-detail-path"
          style={{ padding: "6px 10px", margin: 0 }}
        >
          {confirm.skill.directory ?? "Continue One 平台内置技能"}
        </Well>
        <p style={{ margin: 0 }}>
          {confirm.skill.scope === "platform"
            ? "仅影响此主机上由 Continue One 启动的 Agent。"
            : confirm.skill.state === "uninstalled"
              ? "会恢复到此主机的全局技能目录，影响使用该目录的其他 Agent。"
              : "会移动当前安装目录，影响这台主机上使用此目录的其他 Agent。"}
          {confirm.next === "uninstalled"
            ? "卸载后保留恢复副本，可在分类中重新安装。"
            : "可以随时在此恢复。"}{" "}
          已运行的会话及历史上下文保持原样，对后续新建的 Agent 会话生效。
        </p>
      </div>
      {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
    </Dialog>
  );
}

export { SkillImportDialog } from "./SkillImportDialog";
