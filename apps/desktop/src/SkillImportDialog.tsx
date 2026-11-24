import { useEffect, useRef, useState } from "react";
import { FileText, FolderOpen, Upload } from "lucide-react";
import { message } from "./api";
import { dragHasFiles } from "./fileDrag";
import {
  droppedSkillFiles,
  selectedSkillFiles,
  type SkillUpload,
} from "./skillImport";
import { Button, Dialog, Field, NoticeBanner, TextInput, Well } from "./ui";

export function SkillImportDialog({
  hostName,
  busy,
  connected,
  supported,
  error,
  onClose,
  onImport,
}: {
  hostName?: string;
  busy: boolean;
  connected: boolean;
  supported: boolean;
  error: string;
  onClose: () => void;
  onImport: (upload: SkillUpload) => void;
}) {
  const [upload, setUpload] = useState<SkillUpload>();
  const [selectionError, setSelectionError] = useState("");
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const revision = useRef(0);
  const locked = busy || reading || !connected || !supported;

  useEffect(
    () => () => {
      revision.current++;
    },
    [],
  );

  async function select(selection: Promise<SkillUpload>) {
    const version = ++revision.current;
    setReading(true);
    setSelectionError("");
    setUpload(undefined);
    try {
      const result = await selection;
      if (version === revision.current) setUpload(result);
    } catch (cause) {
      if (version === revision.current) setSelectionError(message(cause));
    } finally {
      if (version === revision.current) {
        setReading(false);
        requestAnimationFrame(() => {
          if (version === revision.current)
            (nameInput.current ?? chooseButton.current)?.focus();
        });
      }
    }
  }

  return (
    <Dialog
      open
      width={540}
      className="skill-import"
      title="添加技能"
      description={`从此电脑选择技能，安装到 ${hostName} 的全局技能目录。`}
      ariaDescribedBy="skill-add-limits"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" size="md" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="md"
            busy={busy}
            disabled={
              locked ||
              !upload ||
              !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(upload.name)
            }
            onClick={() => {
              if (upload) onImport(upload);
            }}
          >
            {busy ? "正在安装…" : "安装"}
          </Button>
        </>
      }
    >
      <input
        hidden
        type="file"
        accept=".md,text/markdown"
        aria-label="选择 SKILL.md"
        ref={filePicker}
        disabled={locked}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (!locked && files.length) void select(selectedSkillFiles(files));
        }}
      />
      <input
        hidden
        type="file"
        multiple
        aria-label="选择技能文件夹"
        ref={(element) => {
          folderPicker.current = element;
          element?.setAttribute("webkitdirectory", "");
        }}
        disabled={locked}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (!locked && files.length) void select(selectedSkillFiles(files));
        }}
      />
      <div
        className={`skill-import-drop${dragging ? " dragging" : ""}`}
        role="group"
        aria-label="拖入技能文件或文件夹"
        onDragOver={(event) => {
          if (!dragHasFiles(event.dataTransfer)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = locked ? "none" : "copy";
          if (!locked) setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node))
            setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragging(false);
          if (!locked) void select(droppedSkillFiles(event.dataTransfer));
        }}
      >
        <Upload size={22} />
        <strong>
          {dragging ? "松开以选择技能" : "拖入 SKILL.md 或技能文件夹"}
        </strong>
        <span>文件夹内的脚本、模板和参考资料会一起导入</span>
        <div className="skill-import-choose">
          <Button
            ref={chooseButton}
            variant="subtle"
            size="md"
            disabled={locked}
            leading={<FileText size={15} />}
            onClick={() => filePicker.current?.click()}
          >
            选择文件
          </Button>
          <Button
            variant="subtle"
            size="md"
            disabled={locked}
            leading={<FolderOpen size={15} />}
            onClick={() => folderPicker.current?.click()}
          >
            选择文件夹
          </Button>
        </div>
      </div>

      {reading && <NoticeBanner tone="neutral">正在读取技能…</NoticeBanner>}

      {upload && (
        <div
          className="skill-import-selection"
          style={{
            marginTop: 0,
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
          }}
        >
          <Field label="技能名称" htmlFor="skill-import-name">
            <TextInput
              id="skill-import-name"
              ref={nameInput}
              aria-label="技能名称"
              aria-describedby="skill-name-help"
              value={upload.name}
              disabled={busy}
              onChange={(e) => setUpload({ ...upload, name: e.target.value })}
            />
          </Field>
          <p
            id="skill-name-help"
            className="ui-field-hint"
            style={{ margin: 0 }}
          >
            最多 128 个英文字母、数字、连字符、下划线或点号，不能以点号开头。
          </p>
          <Well style={{ padding: "8px 12px" }}>
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--color-text-secondary)",
                marginBottom: 4,
              }}
            >
              已选择 {upload.files.length} 个文件
            </div>
            <ul
              aria-label="已选择的技能文件"
              tabIndex={0}
              style={{
                margin: 0,
                paddingLeft: 18,
                maxHeight: 130,
                overflow: "auto",
              }}
            >
              {upload.files.map((item) => (
                <li key={item.path}>{item.path}</li>
              ))}
            </ul>
          </Well>
        </div>
      )}

      <p id="skill-add-limits" className="ui-field-hint" style={{ margin: 0 }}>
        安装到 {hostName} 的 ~/.agents/skills，原文件保留。最多 512 项、16 MiB。
      </p>

      {!supported && (
        <NoticeBanner tone="danger">
          此主机的 Server 尚不支持文件导入，请更新并重新连接。
        </NoticeBanner>
      )}
      {(selectionError || error) && (
        <NoticeBanner tone="danger">{selectionError || error}</NoticeBanner>
      )}
    </Dialog>
  );
}
