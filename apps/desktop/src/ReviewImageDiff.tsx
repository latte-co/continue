import { ImageGallery } from "./ImageGallery";
import { useEffect, useState } from "react";
import type { ChangeImage, ChangeImageLoader } from "./changeImageLoader";
import { imageRead } from "./AttachmentImage";
import { RasterImage } from "./RasterImage";
import { message } from "./api";
import { Button, NoticeBanner, Segmented } from "./ui";

type ImageDiffMode = "split" | "before" | "after";

export function ReviewImageDiff({
  path,
  load,
  active,
}: {
  path: string;
  load: ChangeImageLoader;
  active: boolean;
}) {
  const [revision, retry] = useState(0);
  const [mode, setMode] = useState<ImageDiffMode>("split");
  const [state, setState] = useState<{
    load: ChangeImageLoader;
    path: string;
    sides?: { image?: ChangeImage | null; error?: string }[];
    error?: string;
  }>();

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const valid = () => !disposed;
    setState(undefined);
    void imageRead(async () => {
      const sides = [];
      for (const before of [true, false]) {
        if (!valid()) throw new Error("图片预览已取消");
        try {
          sides.push({ image: await load(path, before, valid) });
        } catch (error) {
          sides.push({ error: message(error) });
        }
      }
      return sides;
    }, valid)
      .then((sides) => {
        if (valid()) setState({ load, path, sides });
      })
      .catch((error) => {
        if (valid()) setState({ load, path, error: message(error) });
      });
    return () => {
      disposed = true;
    };
  }, [path, load, active, revision]);

  const current =
    state?.load === load && state.path === path ? state : undefined;

  const retryButton = (
    <Button
      size="xs"
      variant="subtle"
      disabled={!active}
      onClick={() => retry((v) => v + 1)}
    >
      重试图片预览
    </Button>
  );

  const visibleSides = current?.sides
    ? current.sides
        .map((side, index) => ({ ...side, index }))
        .filter(({ index }) =>
          mode === "split"
            ? true
            : mode === "before"
              ? index === 0
              : index === 1,
        )
    : undefined;

  return (
    <ImageGallery scope={path} active={active}>
      {current?.sides && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            padding: "8px 12px 0",
          }}
        >
          <Segmented<ImageDiffMode>
            label="图片对比视图"
            value={mode}
            onChange={setMode}
            options={[
              { value: "split", label: "并排" },
              { value: "before", label: "修改前" },
              { value: "after", label: "修改后" },
            ]}
          />
        </div>
      )}
      <div
        className={`review-image-diff${mode !== "split" ? " review-image-diff--single" : ""}`}
      >
        {visibleSides ? (
          visibleSides.map(({ image, error, index }) => (
            <figure key={index}>
              <figcaption>{index ? "修改后" : "修改前"}</figcaption>
              {error ? (
                <NoticeBanner tone="danger" action={retryButton}>
                  {error}
                </NoticeBanner>
              ) : image ? (
                <RasterImage
                  bytes={image.bytes}
                  mime={image.mime}
                  name={`${path} · ${index ? "修改后" : "修改前"}`}
                  active={active}
                />
              ) : (
                <p className="panel-notice">此版本没有文件</p>
              )}
            </figure>
          ))
        ) : current?.error ? (
          <NoticeBanner tone="danger" action={retryButton}>
            {current.error}
          </NoticeBanner>
        ) : (
          <p role="status">正在读取图片…</p>
        )}
      </div>
    </ImageGallery>
  );
}
