// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useMemo, useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Event, EventKind } from "./protocol";
import { TurnTranscript, turnTranscript } from "./TurnTranscript";
import { TurnNavigator, turnNavigationEntries } from "./TurnNavigator";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const rows = (...values: EventKind[]): Event[] =>
  values.map((event, seq) => ({
    session_id: "s",
    seq: seq + 1,
    at: seq * 1000,
    event,
  }));
const user = (text: string): EventKind => ({
  kind: "user",
  text,
  request_id: text,
});
const reply = (text: string): EventKind => ({ kind: "text", text });
const done: EventKind = { kind: "state", status: "completed", message: null };
const conversation = rows(
  user("第一题"),
  reply("第一答"),
  done,
  user("第二题"),
  reply("第二答"),
  done,
  user("第三题"),
  reply("第三答"),
  done,
);
let offsets: Record<string, number>;
let scroll: HTMLDivElement;
const navigated = vi.fn();

function Harness({
  events = conversation,
  earlier = false,
  loading = false,
  load = vi.fn(),
}: {
  events?: Event[];
  earlier?: boolean;
  loading?: boolean;
  load?: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const turns = useMemo(() => turnTranscript(events), [events]);
  const entries = useMemo(() => turnNavigationEntries(turns), [turns]);
  return (
    <>
      <div ref={scroller} className="conversation-scroll">
        <div className="messages">
          <TurnTranscript events={events} turns={turns}>
            {(item) => (
              <p key={item.key}>
                {item.type === "user" || item.type === "assistant"
                  ? item.text
                  : "tool"}
              </p>
            )}
          </TurnTranscript>
        </div>
      </div>
      <TurnNavigator
        entries={entries}
        scroller={scroller}
        onNavigate={(top) => {
          navigated(top);
          scroller.current?.scrollTo({ top });
        }}
        hasEarlierHistory={earlier}
        earlierHistoryLoading={loading}
        onLoadEarlier={load}
      />
    </>
  );
}

beforeEach(() => {
  offsets = { "s:1": 0, "s:4": 500, "s:7": 1000 };
  navigated.mockClear();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const key = this.dataset.turnKey;
      const top = key ? (offsets[key] ?? 0) - (scroll?.scrollTop ?? 0) : 0;
      return new DOMRect(0, top, 500, 300);
    },
  );
  HTMLElement.prototype.scrollTo = vi.fn(function (
    this: HTMLElement,
    options?: ScrollToOptions | number,
    y?: number,
  ) {
    this.scrollTop =
      typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
    fireEvent.scroll(this);
  });
});

function mount(props: Parameters<typeof Harness>[0] = {}) {
  const view = render(<Harness {...props} />);
  scroll = view.container.querySelector<HTMLDivElement>(
    ".conversation-scroll",
  )!;
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 1500 },
    clientHeight: { configurable: true, value: 300 },
  });
  return view;
}
const marker = (prompt: string) =>
  screen.getByRole("button", { name: `跳转到：${prompt}` });

it("uses known user turns and final prose, excluding partial history and tool progress", () => {
  const events = rows(
    reply("partial"),
    user("question"),
    reply("progress"),
    { kind: "tool", id: "t", name: "Read", input: { secret: "not a preview" } },
    { kind: "tool_result", id: "t", content: "tool output", is_error: false },
    reply("final"),
    done,
  );
  expect(turnNavigationEntries(turnTranscript(events))).toEqual([
    { key: "s:2", prompt: "question", reply: "final", status: "" },
  ]);
});

it("distinguishes a waiting turn and its received progress from a final answer", () => {
  const entries = turnNavigationEntries(
    turnTranscript(
      rows(user("question"), reply("working"), {
        kind: "state",
        status: "waiting",
        message: null,
      }),
    ),
  );
  expect(entries[0]).toMatchObject({
    reply: "working",
    status: "等待你的回应",
  });
});

it("tracks the reading viewport and jumps to the same stable transcript anchors", async () => {
  mount();
  await waitFor(() =>
    expect(marker("第一题").getAttribute("aria-current")).toBe("location"),
  );
  scroll.scrollTop = 520;
  fireEvent.scroll(scroll);
  await waitFor(() =>
    expect(marker("第二题").getAttribute("aria-current")).toBe("location"),
  );
  fireEvent.click(marker("第一题"));
  expect(navigated).toHaveBeenLastCalledWith(0);
  expect(scroll.scrollTop).toBe(0);
  expect(marker("第一题").getAttribute("aria-current")).toBe("location");
  scroll.scrollTop = 1200;
  fireEvent.scroll(scroll);
  await waitFor(() =>
    expect(marker("第三题").getAttribute("aria-current")).toBe("location"),
  );
});

it("retains the chosen marker when the last screen clamps a jump, then releases on manual scrolling", async () => {
  offsets["s:4"] = 1300;
  offsets["s:7"] = 1400;
  mount();
  fireEvent.click(marker("第二题"));
  expect(navigated).toHaveBeenLastCalledWith(1200);
  await waitFor(() =>
    expect(marker("第二题").getAttribute("aria-current")).toBe("location"),
  );
  fireEvent.wheel(scroll);
  await waitFor(() =>
    expect(marker("第三题").getAttribute("aria-current")).toBe("location"),
  );
});

it("previews text safely on hover, hides after jumping, and supports roving keyboard focus", async () => {
  const view = mount();
  await waitFor(() => expect(marker("第一题").tabIndex).toBe(0));
  fireEvent.mouseEnter(marker("第二题"));
  expect(screen.getByRole("tooltip").textContent).toContain("第二答");
  fireEvent.click(marker("第二题"));
  expect(screen.queryByRole("tooltip")).toBeNull();
  marker("第二题").focus();
  fireEvent.keyDown(marker("第二题"), { key: "Home" });
  expect(document.activeElement).toBe(marker("第一题"));
  fireEvent.keyDown(marker("第一题"), { key: "End" });
  expect(document.activeElement).toBe(marker("第三题"));
  fireEvent.keyDown(marker("第三题"), { key: "ArrowUp" });
  expect(document.activeElement).toBe(marker("第二题"));
  expect(navigated).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(marker("第二题"), { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  view.rerender(
    <Harness
      events={rows(
        user("<img src=x onerror=evil()>"),
        reply("<script>evil()</script>"),
        done,
      )}
    />,
  );
  fireEvent.mouseEnter(screen.getByRole("button", { name: /跳转到：<img/ }));
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip.querySelector("img, script")).toBeNull();
  expect(tooltip.textContent).toContain("<script>evil()</script>");
});

it("keeps anchors stable as older turns are prepended and disables an ongoing history read", async () => {
  const load = vi.fn();
  const view = mount({ earlier: true, load });
  fireEvent.click(screen.getByRole("button", { name: "加载更早的轮次" }));
  expect(load).toHaveBeenCalledTimes(1);
  view.rerender(<Harness earlier loading load={load} />);
  expect(
    screen
      .getByRole("button", { name: "正在加载更早的轮次" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "正在加载更早的轮次" }));
  expect(load).toHaveBeenCalledTimes(1);
  const earlier = rows(user("更早的问题"), reply("更早的回复"), done).map(
    (event) => ({ ...event, seq: event.seq - 10 }),
  );
  view.rerender(<Harness events={[...earlier, ...conversation]} />);
  fireEvent.click(marker("第二题"));
  expect(navigated).toHaveBeenLastCalledWith(484);
  expect(marker("更早的问题")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "加载更早的轮次" })).toBeNull();
});

it("does not expand a completed process when navigating", () => {
  const events = rows(
    user("question"),
    reply("progress"),
    { kind: "tool", id: "t", name: "Read", input: {} },
    { kind: "tool_result", id: "t", content: "ok", is_error: false },
    reply("final"),
    done,
  );
  mount({ events });
  fireEvent.click(marker("question"));
  expect(screen.queryByText("progress")).toBeNull();
  expect(screen.getByText(/用时/).closest("details")!.open).toBe(false);
});

it("keeps keyboard previews visible when the marker list itself scrolls", async () => {
  const view = mount();
  const list = view.container.querySelector<HTMLDivElement>(
    ".turn-navigator-list",
  )!;
  Object.defineProperty(list, "clientHeight", {
    configurable: true,
    value: 32,
  });
  Object.defineProperties(marker("第三题"), {
    offsetTop: { configurable: true, value: 96 },
    offsetHeight: { configurable: true, value: 16 },
  });
  await waitFor(() => expect(marker("第一题").tabIndex).toBe(0));
  marker("第一题").focus();
  fireEvent.keyDown(marker("第一题"), { key: "End" });
  expect(document.activeElement).toBe(marker("第三题"));
  await waitFor(() => expect(list.scrollTop).toBe(80));
  fireEvent.scroll(list);
  expect(screen.getByRole("tooltip").textContent).toContain("第三答");
  expect(navigated).not.toHaveBeenCalled();
});

it("keeps strictly one current marker and replaces the indicator node when scrolling across turns", async () => {
  const view = mount();
  await waitFor(() =>
    expect(marker("第一题").getAttribute("aria-current")).toBe("location"),
  );
  const thirdBefore = marker("第三题").querySelector("span")!;
  scroll.scrollTop = 1200;
  fireEvent.scroll(scroll);
  await waitFor(() =>
    expect(marker("第三题").getAttribute("aria-current")).toBe("location"),
  );
  const thirdActive = marker("第三题").querySelector("span")!;
  expect(thirdActive).not.toBe(thirdBefore);
  expect(
    view.container.querySelectorAll(
      '.turn-navigator-list button[aria-current="location"]',
    ),
  ).toHaveLength(1);

  scroll.scrollTop = 520;
  fireEvent.scroll(scroll);
  await waitFor(() =>
    expect(marker("第二题").getAttribute("aria-current")).toBe("location"),
  );
  expect(marker("第三题").querySelector("span")).not.toBe(thirdActive);
  expect(
    view.container.querySelectorAll(
      '.turn-navigator-list button[aria-current="location"]',
    ),
  ).toHaveLength(1);
});

it("displays 12 turns per page, flips pages via ^ / v without scrolling the transcript, and follows scroll back", async () => {
  const manyEvents: Event[] = [];
  const nextOffsets: Record<string, number> = {};
  for (let i = 1; i <= 28; i++) {
    const baseSeq = (i - 1) * 3 + 1;
    nextOffsets[`s:${baseSeq}`] = (i - 1) * 200;
    manyEvents.push(
      {
        session_id: "s",
        seq: baseSeq,
        at: baseSeq * 1000,
        event: user(`第${i}问`),
      },
      {
        session_id: "s",
        seq: baseSeq + 1,
        at: (baseSeq + 1) * 1000,
        event: reply(`第${i}答`),
      },
      {
        session_id: "s",
        seq: baseSeq + 2,
        at: (baseSeq + 2) * 1000,
        event: done,
      },
    );
  }
  offsets = nextOffsets;
  const view = render(<Harness events={manyEvents} />);
  scroll = view.container.querySelector<HTMLDivElement>(
    ".conversation-scroll",
  )!;
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 5600 },
    clientHeight: { configurable: true, value: 400 },
  });
  scroll.scrollTop = 5200;
  fireEvent.scroll(scroll);

  await waitFor(() =>
    expect(marker("第28问").getAttribute("aria-current")).toBe("location"),
  );
  // Shows latest 12 turns (17..28); next-page button is disabled at bottom
  expect(
    view.container.querySelectorAll(".turn-navigator-list button"),
  ).toHaveLength(12);
  expect(screen.queryByRole("button", { name: "跳转到：第16问" })).toBeNull();
  expect(marker("第17问")).toBeTruthy();
  const prevBtn = screen.getByRole("button", { name: "上一页轮次" });
  const nextBtn = screen.getByRole("button", { name: "下一页轮次" });
  expect(nextBtn.hasAttribute("disabled")).toBe(true);
  navigated.mockClear();

  // Clicking ^ flips to turns 5..16 WITHOUT scrolling the transcript
  fireEvent.click(prevBtn);
  expect(navigated).not.toHaveBeenCalled();
  expect(scroll.scrollTop).toBe(5200);
  expect(
    view.container.querySelectorAll(".turn-navigator-list button"),
  ).toHaveLength(12);
  expect(marker("第5问")).toBeTruthy();
  expect(marker("第16问")).toBeTruthy();
  expect(nextBtn.hasAttribute("disabled")).toBe(false);

  // Hovering a bar on the flipped page previews it; clicking ^ again reaches 1..12
  fireEvent.mouseEnter(marker("第8问"));
  expect(screen.getByRole("tooltip").textContent).toContain("第8答");
  fireEvent.click(screen.getByRole("button", { name: "上一页轮次" }));
  expect(marker("第1问")).toBeTruthy();
  expect(marker("第12问")).toBeTruthy();

  // Clicking v steps back symmetrically (1..12 -> 5..16) without scrolling transcript
  fireEvent.click(screen.getByRole("button", { name: "下一页轮次" }));
  expect(marker("第5问")).toBeTruthy();
  expect(marker("第16问")).toBeTruthy();
  expect(navigated).not.toHaveBeenCalled();

  // Clicking a marker jumps the transcript to that turn
  fireEvent.click(marker("第6问"));
  expect(navigated).toHaveBeenCalledTimes(1);
  expect(marker("第6问").getAttribute("aria-current")).toBe("location");

  // Manually scrolling the transcript back to the bottom snaps the page back to 17..28
  scroll.scrollTop = 5200;
  fireEvent.wheel(scroll);
  await waitFor(() => expect(marker("第28问")).toBeTruthy());
  expect(marker("第28问").getAttribute("aria-current")).toBe("location");
});
