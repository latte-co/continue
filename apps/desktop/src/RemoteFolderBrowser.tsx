import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Folder, LoaderCircle } from "lucide-react";
import { connect, message, request, type Host } from "./api";
import type { Response } from "./protocol";
import { Button, InputGroup, NoticeBanner, TextInput } from "./ui";

export function RemoteFolderBrowser({
  host,
  initialPath,
  cancel,
  select,
}: {
  host: Host;
  initialPath: string;
  cancel: () => void;
  select: (path: string) => void;
}) {
  const [listing, setListing] =
    useState<Extract<Response, { kind: "directories" }>>();
  const [path, setPath] = useState(initialPath);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  async function browse(target: string | null) {
    const ticket = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const hello = await connect(host);
      if (hello.kind !== "hello")
        throw new Error(
          hello.kind === "error" ? hello.message : "主机连接失败",
        );
      const response = await request(host.id, {
        method: "browse_directories",
        path: target,
      });
      if (ticket !== generation.current) return;
      if (response.kind !== "directories")
        throw new Error("此 Server 不支持文件夹浏览，请更新远程 Server");
      setListing(response);
      setPath(response.path);
    } catch (e) {
      if (ticket === generation.current) setError(message(e));
    } finally {
      if (ticket === generation.current) setLoading(false);
    }
  }

  useEffect(() => {
    void browse(initialPath || null);
    return () => {
      generation.current++;
    };
  }, [host.id]);

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void browse(path.trim() || null);
        }}
      >
        <InputGroup>
          <TextInput
            autoFocus
            aria-label="远程目录路径"
            monospace
            size="md"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="输入绝对路径"
          />
          <Button type="submit" variant="subtle" size="md" disabled={loading}>
            前往
          </Button>
        </InputGroup>
      </form>
      <div className="directory-list" aria-busy={loading}>
        <button
          type="button"
          disabled={loading || !listing?.parent}
          onClick={() => void browse(listing?.parent ?? null)}
        >
          <ArrowLeft size={15} />
          上一级
        </button>
        {loading ? (
          <div className="directory-empty">
            <LoaderCircle size={17} className="spin" />
            正在读取目录…
          </div>
        ) : (
          <>
            {listing?.entries.map((entry) => (
              <button
                type="button"
                key={entry.path}
                onClick={() => void browse(entry.path)}
              >
                <Folder size={16} />
                <span>{entry.name}</span>
                <ChevronRight size={14} />
              </button>
            ))}
            {listing?.entries.length === 0 && (
              <div className="directory-empty">此目录没有子文件夹</div>
            )}
          </>
        )}
      </div>
      {listing?.truncated && (
        <NoticeBanner tone="warning">
          目录较大，仅显示部分条目。可输入完整路径前往。
        </NoticeBanner>
      )}
      {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
      <div className="ui-dialog-inline-footer">
        <Button variant="subtle" size="md" onClick={cancel}>
          返回
        </Button>
        <Button
          variant="primary"
          size="md"
          disabled={loading || !listing || !!error || path !== listing.path}
          onClick={() => listing && select(listing.path)}
        >
          选择此文件夹
        </Button>
      </div>
    </>
  );
}
