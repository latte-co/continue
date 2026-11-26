import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ChevronDown, ChevronUp, LoaderCircle } from "lucide-react";
import type { TranscriptTurn } from "./TurnTranscript";
import { userMessageContent } from "./annotations";

export const TURN_PAGE_SIZE = 12;

export function turnNavigationEntries(turns: TranscriptTurn[]) {
  return turns.flatMap((turn) => {
    // A history page can start halfway through a turn. It has no known prompt
    // and must not acquire a fabricated navigation marker.
    if (turn.user?.type !== "user") return [];
    const content = userMessageContent(turn.user.text);
    const reply = [...turn.visible]
      .reverse()
      .find((item) => item.type === "assistant");
    return [
      {
        key: turn.key,
        prompt: excerpt(
          content.text ||
            content.references.map((reference) => reference.name).join("、"),
          240,
        ),
        reply: turn.finalText
          ? excerpt(turn.finalText, 600)
          : reply?.type === "assistant"
            ? excerpt(reply.text, 600)
            : "",
        status:
          turn.finalKey !== undefined
            ? ""
            : turn.status === "stopped"
              ? "已停止"
              : turn.status === "failed"
                ? "回复中断"
                : turn.status === "unknown"
                  ? "状态待确认"
                  : turn.status === "waiting"
                    ? "等待你的回应"
                    : turn.status === "completed"
                      ? "本轮已结束"
                      : "正在回复…",
      },
    ];
  });
}

function excerpt(text: string, limit: number) {
  const plain = text.replace(/\s+/g, " ").trim();
  return plain.length > limit
    ? `${plain.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "")}…`
    : plain;
}

type Entry = ReturnType<typeof turnNavigationEntries>[number];
type Anchor = { key: string; top: number };

/** Read-only navigation over the same turns rendered by the transcript. */
export function TurnNavigator({
  entries,
  scroller,
  onNavigate,
  hasEarlierHistory,
  earlierHistoryLoading,
  onLoadEarlier,
}: {
  entries: Entry[];
  scroller: RefObject<HTMLDivElement | null>;
  onNavigate: (top: number) => void;
  hasEarlierHistory: boolean;
  earlierHistoryLoading: boolean;
  onLoadEarlier?: (minTurns?: number) => void;
}) {
  const rail = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const anchors = useRef<Anchor[]>([]);
  const navigation = useRef<{ key: string; top: number } | null>(null);
  const prevActiveKey = useRef<string | undefined>(undefined);
  const pendingLoadAnchor = useRef<number | null>(null);
  const pendingPageFocus = useRef<"first" | "last" | null>(null);
  const [activeKey, setActiveKey] = useState<string>();
  const [focusKey, setFocusKey] = useState<string>();
  const [previewKey, setPreviewKey] = useState<string>();
  const [previewTop, setPreviewTop] = useState(0);
  const [offset, setOffset] = useState(0);
  const tooltipId = useId();

  const total = entries.length;
  const maxOffset = Math.max(0, total - TURN_PAGE_SIZE);
  const clampedOffset = Math.min(offset, maxOffset);
  const end = total - clampedOffset;
  const start = Math.max(0, end - TURN_PAGE_SIZE);
  const visibleEntries = entries.slice(start, end);
  const entry = visibleEntries.find((item) => item.key === previewKey);
  const rovingKey =
    focusKey && visibleEntries.some((item) => item.key === focusKey)
      ? focusKey
      : activeKey && visibleEntries.some((item) => item.key === activeKey)
        ? activeKey
        : visibleEntries.at(-1)?.key;
  const showPagination =
    total > TURN_PAGE_SIZE || (hasEarlierHistory && !!onLoadEarlier);
  const canStepEarlierInMemory = start > 0;
  const canLoadEarlierFromHost = hasEarlierHistory && !!onLoadEarlier;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    let needsMeasure = true;
    const keys = new Set(entries.map((entry) => entry.key));
    const update = () => {
      frame = 0;
      if (needsMeasure) {
        const top = el.getBoundingClientRect().top;
        anchors.current = [
          ...el.querySelectorAll<HTMLElement>("[data-turn-key]"),
        ]
          .filter((node) => keys.has(node.dataset.turnKey!))
          .map((node) => ({
            key: node.dataset.turnKey!,
            top: el.scrollTop + node.getBoundingClientRect().top - top,
          }));
        needsMeasure = false;
      }
      const known = anchors.current;
      if (!known.length) return;
      const locked = navigation.current;
      if (
        locked &&
        keys.has(locked.key) &&
        Math.abs(el.scrollTop - locked.top) < 2
      ) {
        setActiveKey(locked.key);
        return;
      }
      navigation.current = null;
      if (
        el.scrollTop > 0 &&
        el.scrollHeight - el.clientHeight - el.scrollTop <= 2
      ) {
        setActiveKey(known.at(-1)!.key);
        return;
      }
      const readingTop = el.scrollTop + Math.min(100, el.clientHeight * 0.2);
      let low = 0,
        high = known.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (known[middle].top <= readingTop) low = middle + 1;
        else high = middle;
      }
      setActiveKey(known[Math.max(0, low - 1)].key);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const measure = () => {
      needsMeasure = true;
      schedule();
    };
    const release = () => {
      navigation.current = null;
      schedule();
    };
    schedule();
    el.addEventListener("scroll", schedule, { passive: true });
    el.addEventListener("wheel", release, { passive: true });
    el.addEventListener("toggle", measure, true);
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(el);
    const messages = el.querySelector(".messages");
    if (messages) observer?.observe(messages);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", schedule);
      el.removeEventListener("wheel", release);
      el.removeEventListener("toggle", measure, true);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [entries, scroller]);

  useLayoutEffect(() => {
    if (
      pendingLoadAnchor.current !== null &&
      total > pendingLoadAnchor.current
    ) {
      const added = total - pendingLoadAnchor.current;
      pendingLoadAnchor.current = null;
      const nextMax = Math.max(0, total - TURN_PAGE_SIZE);
      setOffset((prev) =>
        Math.min(nextMax, prev + Math.max(1, Math.min(TURN_PAGE_SIZE, added))),
      );
      setPreviewKey(undefined);
    } else if (!hasEarlierHistory && !earlierHistoryLoading) {
      pendingLoadAnchor.current = null;
    }
  }, [total, hasEarlierHistory, earlierHistoryLoading]);

  useLayoutEffect(() => {
    if (activeKey === prevActiveKey.current) return;
    prevActiveKey.current = activeKey;
    if (!activeKey) return;
    const activeIndex = entries.findIndex((item) => item.key === activeKey);
    if (activeIndex < 0) return;
    if (activeIndex < start || activeIndex >= end) {
      const nextOffset = Math.min(
        maxOffset,
        Math.floor((total - 1 - activeIndex) / TURN_PAGE_SIZE) * TURN_PAGE_SIZE,
      );
      setOffset(nextOffset);
    }
  }, [activeKey, entries, start, end, maxOffset, total]);

  useLayoutEffect(() => {
    if (!pendingPageFocus.current) return;
    const direction = pendingPageFocus.current;
    pendingPageFocus.current = null;
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>("button");
    if (!buttons?.length) return;
    const target =
      direction === "first" ? buttons[0] : buttons[buttons.length - 1];
    target?.focus();
  }, [clampedOffset, visibleEntries.length]);

  useLayoutEffect(() => {
    // Keep the current marker visible in very long conversations without moving
    // the transcript or scrolling an ancestor of the rail.
    const el = list.current;
    const button = focusKey
      ? [...(el?.querySelectorAll<HTMLElement>("[data-jump-key]") ?? [])].find(
          (node) => node.dataset.jumpKey === focusKey,
        )
      : el?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!el || !button) return;
    if (button.offsetTop < el.scrollTop) el.scrollTop = button.offsetTop;
    else if (
      button.offsetTop + button.offsetHeight >
      el.scrollTop + el.clientHeight
    )
      el.scrollTop = button.offsetTop + button.offsetHeight - el.clientHeight;
  }, [activeKey, focusKey, entries, clampedOffset]);

  useLayoutEffect(() => {
    if (!entry || !rail.current || !preview.current) return;
    const button = [
      ...rail.current.querySelectorAll<HTMLElement>("[data-jump-key]"),
    ].find((node) => node.dataset.jumpKey === entry.key);
    if (!button) return;
    const place = () => {
      if (!rail.current || !preview.current) return;
      const railRect = rail.current.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      setPreviewTop(
        Math.max(
          0,
          Math.min(
            buttonRect.top -
              railRect.top +
              buttonRect.height / 2 -
              preview.current.offsetHeight / 2,
            railRect.height - preview.current.offsetHeight,
          ),
        ),
      );
    };
    place();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(rail.current);
    observer?.observe(preview.current);
    window.addEventListener("resize", place);
    const markers = list.current;
    markers?.addEventListener("scroll", place, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      markers?.removeEventListener("scroll", place);
    };
  }, [entry, activeKey]);

  function jump(key: string) {
    const el = scroller.current;
    const node =
      el &&
      [...el.querySelectorAll<HTMLElement>("[data-turn-key]")].find(
        (node) => node.dataset.turnKey === key,
      );
    if (!el || !node) return;
    const top = Math.max(
      0,
      Math.min(
        el.scrollTop +
          node.getBoundingClientRect().top -
          el.getBoundingClientRect().top -
          16,
        el.scrollHeight - el.clientHeight,
      ),
    );
    navigation.current = { key, top };
    setActiveKey(key);
    setPreviewKey(undefined);
    onNavigate(top);
  }

  function stepEarlierPage() {
    setPreviewKey(undefined);
    if (canStepEarlierInMemory) {
      setOffset(Math.min(maxOffset, clampedOffset + TURN_PAGE_SIZE));
      return;
    }
    if (canLoadEarlierFromHost && !earlierHistoryLoading) {
      pendingLoadAnchor.current = total;
      onLoadEarlier(TURN_PAGE_SIZE);
    }
  }

  function stepLaterPage() {
    if (clampedOffset <= 0) return;
    setPreviewKey(undefined);
    setOffset(
      clampedOffset > TURN_PAGE_SIZE
        ? Math.floor((clampedOffset - 1) / TURN_PAGE_SIZE) * TURN_PAGE_SIZE
        : 0,
    );
  }

  return (
    <nav className="turn-navigator" aria-label="对话轮次" ref={rail}>
      {showPagination && (
        <button
          type="button"
          className="turn-navigator-earlier"
          aria-label={
            canStepEarlierInMemory
              ? "上一页轮次"
              : earlierHistoryLoading
                ? "正在加载更早的轮次"
                : "加载更早的轮次"
          }
          title={canStepEarlierInMemory ? "上一页轮次" : "加载更早的轮次"}
          disabled={
            !canStepEarlierInMemory &&
            (!canLoadEarlierFromHost || earlierHistoryLoading)
          }
          onClick={stepEarlierPage}
        >
          {!canStepEarlierInMemory && earlierHistoryLoading ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <ChevronUp size={14} />
          )}
        </button>
      )}
      <div
        className="turn-navigator-list"
        ref={list}
        onMouseLeave={() => setPreviewKey(undefined)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setFocusKey(undefined);
            setPreviewKey(undefined);
          }
        }}
      >
        {visibleEntries.map((item, index) => (
          <button
            type="button"
            key={item.key}
            data-jump-key={item.key}
            aria-label={`跳转到：${excerpt(item.prompt, 80)}`}
            aria-current={activeKey === item.key ? "location" : undefined}
            aria-describedby={previewKey === item.key ? tooltipId : undefined}
            tabIndex={rovingKey === item.key ? 0 : -1}
            onMouseEnter={() => setPreviewKey(item.key)}
            onFocus={() => {
              setFocusKey(item.key);
              setPreviewKey(item.key);
            }}
            onClick={() => jump(item.key)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setPreviewKey(undefined);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                if (index > 0) {
                  list.current
                    ?.querySelectorAll<HTMLButtonElement>("button")
                    ?.[index - 1]?.focus();
                } else if (canStepEarlierInMemory) {
                  pendingPageFocus.current = "last";
                  stepEarlierPage();
                }
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                if (index < visibleEntries.length - 1) {
                  list.current
                    ?.querySelectorAll<HTMLButtonElement>("button")
                    ?.[index + 1]?.focus();
                } else if (clampedOffset > 0) {
                  pendingPageFocus.current = "first";
                  stepLaterPage();
                }
                return;
              }
              if (event.key === "PageUp") {
                event.preventDefault();
                if (canStepEarlierInMemory) {
                  pendingPageFocus.current = "first";
                  stepEarlierPage();
                } else {
                  list.current
                    ?.querySelectorAll<HTMLButtonElement>("button")?.[0]
                    ?.focus();
                }
                return;
              }
              if (event.key === "PageDown") {
                event.preventDefault();
                if (clampedOffset > 0) {
                  pendingPageFocus.current = "last";
                  stepLaterPage();
                } else {
                  const buttons =
                    list.current?.querySelectorAll<HTMLButtonElement>("button");
                  buttons?.[buttons.length - 1]?.focus();
                }
                return;
              }
              if (event.key === "Home") {
                event.preventDefault();
                if (canStepEarlierInMemory) {
                  pendingPageFocus.current = "first";
                  setPreviewKey(undefined);
                  setOffset(maxOffset);
                } else {
                  list.current
                    ?.querySelectorAll<HTMLButtonElement>("button")?.[0]
                    ?.focus();
                }
                return;
              }
              if (event.key === "End") {
                event.preventDefault();
                if (clampedOffset > 0) {
                  pendingPageFocus.current = "last";
                  setPreviewKey(undefined);
                  setOffset(0);
                } else {
                  const buttons =
                    list.current?.querySelectorAll<HTMLButtonElement>("button");
                  buttons?.[buttons.length - 1]?.focus();
                }
              }
            }}
          >
            <span
              key={activeKey === item.key ? "active" : "idle"}
              aria-hidden="true"
            />
          </button>
        ))}
      </div>
      {showPagination && (
        <button
          type="button"
          className="turn-navigator-later"
          aria-label="下一页轮次"
          title="下一页轮次"
          disabled={clampedOffset === 0}
          onClick={stepLaterPage}
        >
          <ChevronDown size={14} />
        </button>
      )}
      {entry && (
        <div
          className="turn-navigator-preview"
          ref={preview}
          role="tooltip"
          id={tooltipId}
          style={{ top: previewTop }}
        >
          <p className="turn-navigator-prompt">{entry.prompt}</p>
          {entry.status && <small>{entry.status}</small>}
          <p className="turn-navigator-reply">
            {entry.reply || (entry.status ? "尚无文字回复" : "暂无文字回复")}
          </p>
        </div>
      )}
    </nav>
  );
}
