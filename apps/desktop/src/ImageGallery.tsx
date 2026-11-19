import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  X,
} from "lucide-react";
import { Modal } from "./Modal";
import { message } from "./api";
import { copyImageBytes, saveImageBytes } from "./clipboard";

export type ImagePayload = {
  bytes: Uint8Array;
  mime: string;
};

type Entry = {
  id: string;
  trigger: RefObject<HTMLElement | null>;
  name: string;
  title?: string;
  payload?: ImagePayload;
  content: ReactNode;
};
type Gallery = {
  active: boolean;
  selected: string | null;
  show: (id: string) => void;
  register: (entry: RefObject<Entry>) => () => void;
  update: () => void;
};
const Context = createContext<Gallery | null>(null);
const ItemIdentity = createContext<number | null>(null);

/** Event identity survives transcript regrouping when older pages are prepended. */
export function ImageGalleryItem({
  id,
  children,
}: {
  id: number;
  children: ReactNode;
}) {
  return <ItemIdentity.Provider value={id}>{children}</ItemIdentity.Provider>;
}

function ImageDialog({
  entry,
  close,
  index = 0,
  count = 1,
  move,
}: {
  entry: Entry;
  close: () => void;
  index?: number;
  count?: number;
  move?: (direction: number) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const stageFocus = useRef<HTMLElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const currentId = useRef(entry.id);
  currentId.current = entry.id;
  useEffect(() => {
    setCopied(false);
    setBusy(false);
    setActionError("");
  }, [entry.id, entry.payload]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  useLayoutEffect(() => {
    // Async reads can also replace a focused retry button without navigation.
    if (stageFocus.current && !stageFocus.current.isConnected) {
      if (document.activeElement === document.body)
        closeButton.current?.focus();
      stageFocus.current = null;
    }
  });
  const navigate = (direction: number) => {
    // The keyed stage removes retry controls. Move focus before replacing it,
    // so subsequent arrow/Escape events continue to reach this same dialog.
    if (stage.current?.contains(document.activeElement))
      closeButton.current?.focus();
    move?.(direction);
  };
  const previous = index > 0;
  const next = index < count - 1;
  const payload = entry.payload;
  return createPortal(
    <div
      className="modal-backdrop attachment-image-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <Modal
        className="modal attachment-image-dialog"
        aria-label={`图片预览 ${entry.name}`}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "ArrowLeft" ? previous : next)
              navigate(event.key === "ArrowLeft" ? -1 : 1);
          }
        }}
      >
        <header>
          <span title={entry.title}>{entry.name}</span>
          <div className="attachment-image-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={copied ? "已复制" : "复制图片"}
              title={copied ? "已复制到剪贴板" : "复制图片"}
              disabled={!payload || busy}
              onClick={() => {
                if (!payload || busy) return;
                const owner = entry.id;
                setBusy(true);
                setActionError("");
                void copyImageBytes(payload.bytes, payload.mime)
                  .then(() => {
                    if (currentId.current === owner) setCopied(true);
                  })
                  .catch((cause) => {
                    if (currentId.current === owner)
                      setActionError(`复制失败：${message(cause)}`);
                  })
                  .finally(() => {
                    if (currentId.current === owner) setBusy(false);
                  });
              }}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="下载图片"
              title="下载图片"
              disabled={!payload || busy}
              onClick={() => {
                if (!payload || busy) return;
                const owner = entry.id;
                setBusy(true);
                setActionError("");
                void saveImageBytes(entry.name, payload.bytes, payload.mime)
                  .catch((cause) => {
                    if (currentId.current === owner)
                      setActionError(`下载失败：${message(cause)}`);
                  })
                  .finally(() => {
                    if (currentId.current === owner) setBusy(false);
                  });
              }}
            >
              <Download size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭图片预览"
              title="关闭图片预览（Esc）"
              ref={closeButton}
              onClick={close}
            >
              <X size={18} />
            </button>
          </div>
        </header>
        {actionError && (
          <p className="attachment-image-action-error" role="alert">
            {actionError}
          </p>
        )}
        <div
          className="attachment-image-stage"
          ref={stage}
          onFocusCapture={(event) => {
            stageFocus.current = event.target;
          }}
        >
          <Fragment key={entry.id}>{entry.content}</Fragment>
        </div>
        {count > 1 && (
          <nav className="image-gallery-navigation" aria-label="图片切换">
            <button
              type="button"
              className="icon-button"
              aria-label="上一张图片"
              title="上一张图片（←）"
              aria-disabled={!previous}
              onClick={() => {
                if (previous) navigate(-1);
              }}
            >
              <ChevronLeft size={20} />
            </button>
            <span role="status" aria-live="polite" aria-atomic="true">
              {index + 1} / {count}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="下一张图片"
              title="下一张图片（→）"
              aria-disabled={!next}
              onClick={() => {
                if (next) navigate(1);
              }}
            >
              <ChevronRight size={20} />
            </button>
          </nav>
        )}
      </Modal>
    </div>,
    document.body,
  );
}

/** One stable modal per reading surface; image resources stay with their owners. */
export function ImageGallery({
  children,
  scope = "",
  active = true,
}: {
  children: ReactNode;
  scope?: string;
  active?: boolean;
}) {
  const entries = useRef(new Map<string, RefObject<Entry>>());
  const [selected, select] = useState<string | null>(null);
  const [, invalidate] = useReducer((value: number) => value + 1, 0);
  const selection = useRef(selected);
  selection.current = selected;
  const update = useCallback(() => {
    if (selection.current !== null) invalidate();
  }, []);
  const origin = useRef<string | null>(null);
  const show = useCallback((id: string) => {
    origin.current = id;
    select(id);
  }, []);
  const close = useCallback(() => {
    const trigger =
      selection.current !== null && origin.current !== null
        ? entries.current.get(origin.current)?.current.trigger.current
        : null;
    select(null);
    // Modal restores the original DOM node normally. A prepended page may
    // replace that node; restore its current event/image counterpart instead.
    queueMicrotask(() => {
      if (trigger?.isConnected && !trigger.closest("[hidden], [inert]"))
        trigger.focus();
    });
  }, []);
  useLayoutEffect(() => select(null), [scope, active]);
  const register = useCallback(
    (entry: RefObject<Entry>) => {
      const id = entry.current.id;
      entries.current.set(id, entry);
      update();
      return () => {
        if (entries.current.get(id) === entry) entries.current.delete(id);
        update();
      };
    },
    [update],
  );
  // Child layout effects finish unregistering/re-registering before this
  // check. Only close if the selected image is absent from the committed tree.
  useLayoutEffect(() => {
    if (selected !== null && !entries.current.has(selected)) close();
  });
  const context = useMemo(
    () => ({ active, selected, show, register, update }),
    [active, selected, show, register, update],
  );
  // Registration order can differ from transcript order after lazy reads or
  // prepended pages. Use the actual trigger order, without reading more history.
  const items = (selected === null ? [] : [...entries.current.values()])
    .map((entry) => entry.current)
    .filter((entry) => entry.trigger.current?.isConnected)
    .sort((a, b) =>
      a.trigger.current!.compareDocumentPosition(b.trigger.current!) &
      Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1,
    );
  const index = items.findIndex((entry) => entry.id === selected);
  return (
    <Context.Provider value={context}>
      {children}
      {active && index >= 0 && (
        <ImageDialog
          entry={items[index]}
          index={index}
          count={items.length}
          close={close}
          move={(direction) => {
            const next = items[index + direction];
            if (next) select(next.id);
          }}
        />
      )}
    </Context.Provider>
  );
}

/** Standalone messages/tool results form a group; conversations supply a wider one. */
export function ImageGalleryBoundary({ children }: { children: ReactNode }) {
  return useContext(Context) ? (
    children
  ) : (
    <ImageGallery>{children}</ImageGallery>
  );
}

export function useImagePreview(
  identity: unknown,
  enabled: boolean,
  trigger: RefObject<HTMLElement | null>,
  imageKey?: string,
) {
  const gallery = useContext(Context);
  const item = useContext(ItemIdentity);
  const localId = useId();
  const id =
    item !== null && imageKey !== undefined
      ? JSON.stringify([item, imageKey])
      : localId;
  const [localOpen, setLocalOpen] = useState(false);
  const active = enabled && (gallery?.active ?? true);
  useLayoutEffect(() => setLocalOpen(false), [identity, active]);
  return {
    id,
    identity,
    active,
    trigger,
    gallery,
    open: active && (gallery ? gallery.selected === id : localOpen),
    show: () => {
      if (!active) return;
      trigger.current?.focus();
      if (gallery) gallery.show(id);
      else setLocalOpen(true);
    },
    close: () => setLocalOpen(false),
  };
}

export function ImagePreview({
  preview,
  name,
  title,
  payload,
  children,
}: {
  preview: ReturnType<typeof useImagePreview>;
  name: string;
  title?: string;
  payload?: ImagePayload;
  children: ReactNode;
}) {
  const { gallery, id, identity, active, open, trigger } = preview;
  const entry = useRef<Entry>({
    id,
    trigger,
    name,
    title,
    payload,
    content: children,
  });
  entry.current = { id, trigger, name, title, payload, content: children };
  const register = gallery?.register;
  const update = gallery?.update;
  useLayoutEffect(() => {
    if (active) return register?.(entry);
  }, [register, id, identity, active]);
  useLayoutEffect(() => {
    if (active) update?.();
  }, [update, active, name, title, payload, children]);
  return !gallery && open ? (
    <ImageDialog entry={entry.current} close={preview.close} />
  ) : null;
}
