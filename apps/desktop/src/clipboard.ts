import { invoke } from "@tauri-apps/api/core";
import { native } from "./api";

export async function copyText(text: string): Promise<void> {
  const focused = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) =>
        selection.getRangeAt(i).cloneRange(),
      )
    : [];
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.className = "appearance-copy-buffer";
  field.setAttribute("aria-hidden", "true");
  (focused?.closest('[role="dialog"]') ?? document.body).appendChild(field);
  let copied = false;
  try {
    field.focus({ preventScroll: true });
    field.select();
    copied = document.execCommand?.("copy") ?? false;
  } catch {
    // Modern clipboard is a fallback when the WebView disables legacy copying.
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach((range) => selection.addRange(range));
    }
  }
  if (!copied) await navigator.clipboard.writeText(text);
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
};

export function imageDownloadName(name: string, mime: string): string {
  const base =
    name
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/[\x00-\x1f/\\:]/g, "")
      .trim() || "图片";
  const ext = MIME_EXTENSIONS[mime.toLowerCase()];
  if (!ext || /\.[a-z0-9]{2,5}$/i.test(base)) return base;
  return `${base}.${ext}`;
}

export async function copyImageBytes(
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  if (!bytes.byteLength) throw new Error("图片内容为空，无法复制");
  if (native) {
    await invoke("copy_image", { mime, data: Array.from(bytes) });
    return;
  }
  if (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  ) {
    await navigator.clipboard.write([
      new ClipboardItem({
        [mime]: new Blob([bytes as BlobPart], { type: mime }),
      }),
    ]);
    return;
  }
  await invoke("copy_image", { mime, data: Array.from(bytes) });
}

export async function saveImageBytes(
  name: string,
  bytes: Uint8Array,
  mime: string,
): Promise<boolean> {
  const saved = await invoke<string | null>("save_file_as", {
    name: imageDownloadName(name, mime),
    data: Array.from(bytes),
  });
  return saved !== null && saved !== undefined;
}
