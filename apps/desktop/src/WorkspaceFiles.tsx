import { useAppClose } from "./appLifecycle";
import { SourcePreview } from "./SourcePreview";
import { FileTextView, isMarkdownFile } from "./FileTextView";
import { useEffect, useState } from "react";
import { Code2, Eye, Folders, RefreshCw, WrapText } from "lucide-react";
import type { FileEntry, Project } from "./protocol";
import { request, message } from "./api";
import { ChangesView } from "./ChangesView";
import { WorkspaceFileTree } from "./WorkspaceFileTree";
import { useStatusIssues } from "./statusNotices";
import { useFileTreeWidth } from "./useFileTreeWidth";
import {
  Badge,
  EmptyState,
  IconButton,
  SplitHandle,
  StateBlock,
  Subbar,
} from "./ui";

const WRAP_STORAGE_KEY = "latte-work.file-wrap.v1";

function savedWrap() {
  try {
    return localStorage.getItem(WRAP_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function WorkspaceFiles({
  hostId,
  project,
  tab,
  active: visible,
  path,
  file,
  navigate,
  reference,
  sessionId,
}: {
  hostId: string;
  project: Project;
  tab: "files" | "diff";
  active: boolean;
  path: string;
  file: string;
  navigate: (value: { path?: string; file?: string }) => void;
  reference?: FileEntry;
  sessionId?: string;
}) {
  const [closing, setClosing] = useState(false);
  const active = visible && !closing;
  useAppClose(
    `${tab === "diff" ? "改动" : "文件"} · ${project.name}`,
    () => {
      setClosing(true);
    },
    () => setClosing(false),
  );
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [treeOpen, setTreeOpen] = useState(true);
  const [wrap, setWrap] = useState(savedWrap);
  const [markdownScope, setMarkdownScope] = useState("");
  const fileScope = JSON.stringify([
    hostId,
    project.id,
    project.path,
    reference?.path,
    file,
  ]);
  const markdown = isMarkdownFile(file) && markdownScope === fileScope;
  useEffect(() => setMarkdownScope(""), [fileScope]);
  const treeWidth = useFileTreeWidth(active && tab === "files" && treeOpen);

  useEffect(() => {
    try {
      localStorage.setItem(WRAP_STORAGE_KEY, String(wrap));
    } catch {
      // Wrapping remains available when local storage is unavailable.
    }
  }, [wrap]);

  useEffect(() => {
    if (!active || tab !== "files") return;
    if (reference) {
      setLoading(false);
      setError("");
      setTruncated(false);
      return;
    }
    if (!file) {
      setLoading(false);
      setError("");
      return;
    }
    let disposed = false;
    setLoading(true);
    setError("");
    void request(hostId, {
      method: "read_file",
      project_id: project.id,
      path: file,
    })
      .then((r) => {
        if (disposed) return;
        if (r.kind === "content") {
          setContent(r.text);
          setTruncated(r.truncated);
        } else throw new Error("无法读取项目文件，请检查 Server 版本");
      })
      .catch((e) => {
        if (!disposed) setError(message(e));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [
    hostId,
    project.id,
    project.path,
    file,
    tab,
    revision,
    active,
    reference,
  ]);
  useStatusIssues([
    {
      id: `file:${hostId}:${project.id}:${project.path}:${file || path}`,
      title: `${file || path || project.name} 未能读取`,
      error: active && tab === "files" && file && !reference ? error : "",
      pending: active && tab === "files" && !!file && loading,
      action: { label: "重试", run: () => refresh((value) => value + 1) },
    },
  ]);

  if (tab === "diff")
    return <ChangesView hostId={hostId} project={project} active={active} />;

  return (
    <div className="workspace-files">
      <Subbar className="workspace-file-header">
        <div
          className="workspace-file-path"
          title={
            reference
              ? file || reference.path
              : `${project.path}/${file || path}`
          }
        >
          {(!reference || reference.directory) && (
            <>
              <button
                type="button"
                className="workspace-file-project"
                aria-label={reference ? "返回所选目录" : "返回项目目录"}
                title={reference?.path ?? project.path}
                disabled={
                  reference ? !reference.directory || !file : !file && !path
                }
                onClick={() => {
                  navigate({ file: "", path: reference?.path ?? "" });
                  setTreeOpen(true);
                }}
              >
                {reference?.name ?? project.name}
              </button>
              <span className="workspace-file-path-separator">/</span>
            </>
          )}
          <span className="workspace-file-location">
            {reference
              ? file.slice(reference.path.length).replace(/^\//, "") ||
                (file ? reference.name : "文件")
              : file || path || "文件"}
          </span>
        </div>
        {file && !reference && !loading && !error && truncated && (
          <Badge tone="warning" className="workspace-file-truncated">
            内容已截断
          </Badge>
        )}
        <div className="workspace-file-actions">
          {isMarkdownFile(file) && (
            <IconButton
              size="sm"
              label={markdown ? "查看源码" : "预览 Markdown"}
              active={markdown}
              aria-pressed={markdown}
              disabled={!active}
              onClick={() => setMarkdownScope(markdown ? "" : fileScope)}
            >
              {markdown ? <Code2 size={15} /> : <Eye size={15} />}
            </IconButton>
          )}
          <IconButton
            size="sm"
            label="自动换行"
            active={wrap}
            aria-pressed={wrap}
            disabled={markdown}
            onClick={() => setWrap((value) => !value)}
          >
            <WrapText size={15} />
          </IconButton>
          <IconButton
            size="sm"
            label={treeOpen ? "隐藏文件树" : "显示文件树"}
            active={treeOpen}
            aria-pressed={treeOpen}
            onClick={() => setTreeOpen((value) => !value)}
          >
            <Folders size={15} />
          </IconButton>
          <IconButton
            size="sm"
            label="刷新"
            disabled={loading}
            onClick={() => refresh((v) => v + 1)}
          >
            <RefreshCw size={15} />
          </IconButton>
        </div>
      </Subbar>
      <div className="workspace-files-body" ref={treeWidth.container}>
        <div className="workspace-file-content">
          {!file ? (
            <div className="workspace-file-empty">
              <EmptyState
                icon={<Folders size={22} />}
                title="打开文件"
                description="从右侧目录选择文件"
              />
            </div>
          ) : reference ? (
            <SourcePreview
              key={`${file}:${revision}`}
              hostId={hostId}
              projectId={project.id}
              projectPath={project.path}
              sessionId={sessionId}
              source={{
                path: file,
                name: file.split("/").at(-1) || file,
                directory: false,
              }}
              active={active}
              open={() => {}}
              embedded
              wrap={wrap}
              markdown={markdown}
            />
          ) : loading ? (
            <StateBlock kind="loading">正在读取…</StateBlock>
          ) : error ? null : (
            <FileTextView
              key={`${project.path}:${file}`}
              content={content}
              wrap={wrap}
              markdown={markdown}
            />
          )}
        </div>
        <SplitHandle
          label="调整文件目录宽度"
          className="resize-handle workspace-file-resize"
          aria-valuemin={Math.round(treeWidth.minimum)}
          aria-valuemax={Math.round(treeWidth.maximum)}
          aria-valuenow={treeWidth.width}
          tabIndex={0}
          hidden={!treeOpen}
          onPointerDown={treeWidth.onPointerDown}
          onKeyDown={treeWidth.onKeyDown}
        />
        <nav
          className="workspace-file-tree"
          aria-label="项目文件树"
          hidden={!treeOpen}
          style={{ flexBasis: treeWidth.width }}
        >
          <WorkspaceFileTree
            key={`${hostId}:${project.id}:${project.path}:${reference?.path ?? ""}`}
            hostId={hostId}
            projectId={project.id}
            reference={reference}
            sessionId={sessionId}
            file={file}
            directoryPath={path}
            active={active && treeOpen}
            revision={revision}
            openFile={(nextFile) =>
              navigate({
                file: nextFile,
                path: nextFile.split("/").slice(0, -1).join("/"),
              })
            }
          />
        </nav>
      </div>
    </div>
  );
}
