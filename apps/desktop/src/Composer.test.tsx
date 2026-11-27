// @vitest-environment jsdom
import { useState, type ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { Select } from "./Select";
import { composerTrigger } from "./composerActions";
import { referenceMessage } from "./referenceMessage";
const pasteMocks = vi.hoisted(() => ({
  paths: vi.fn(),
  importFile: vi.fn(),
  store: vi.fn(),
}));
vi.mock("./pasteAttachments", async (original) => ({
  ...(await original<typeof import("./pasteAttachments")>()),
  clipboardFilePaths: pasteMocks.paths,
  importClipboardFile: pasteMocks.importFile,
  storePastedFile: pasteMocks.store,
}));
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  send: vi.fn(),
  choose: vi.fn(),
  openSubagents: vi.fn(),
  openModelSettings: vi.fn(),
}));
vi.mock("./api", () => ({
  request: mocks.request,
  chooseReferencePath: mocks.choose,
  message: (e: unknown) => String(e),
}));
let resetHarnessDraft: (() => void) | null = null;
function Harness({
  hostId = "remote",
  projectId = "p",
  agent = "claude",
  sideChat = false,
  ...props
}: Partial<ComponentProps<typeof Composer>>) {
  const [text, setText] = useState("");
  resetHarnessDraft = () => setText("");
  return (
    <Composer
      agent={agent}
      hostId={hostId}
      projectId={projectId}
      connected
      disabled={false}
      sending={false}
      sideChat={sideChat}
      hidden={false}
      value={text}
      onChange={setText}
      onSubmit={mocks.send}
      onOpenSubagents={mocks.openSubagents}
      onOpenModelSettings={mocks.openModelSettings}
      placeholder="任务"
      {...props}
      toolbar={
        props.toolbar ??
        ((submit, content) => (
          <button disabled={!content} onClick={submit}>
            发送
          </button>
        ))
      }
    />
  );
}
function type(value: string, cursor = value.length) {
  let input = screen.getByRole("textbox", { name: "任务输入" });
  if (input.classList.contains("composer-rich-input") && resetHarnessDraft) {
    act(() => resetHarnessDraft?.());
    input = screen.getByRole("textbox", { name: "任务输入" });
  }
  if (input instanceof HTMLTextAreaElement) {
    fireEvent.change(input, {
      target: { value, selectionStart: cursor, selectionEnd: cursor },
    });
    return;
  }
  const nodes = Array.from(input.childNodes).filter(
    (node) => node.nodeType === Node.TEXT_NODE,
  );
  const first = nodes[0] ?? input.appendChild(document.createTextNode(""));
  first.textContent = value;
  for (const node of nodes.slice(1)) node.textContent = "";
  const range = document.createRange();
  range.setStart(first, cursor);
  range.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  fireEvent.input(input);
}
function inputText() {
  const input = screen.getByRole("textbox", { name: "任务输入" });
  if (input instanceof HTMLTextAreaElement) return input.value;
  if (input.classList.contains("composer-rich-input")) {
    return Array.from(input.children)
      .map((block) =>
        Array.from(block.childNodes)
          .map((node) => {
            if (node instanceof HTMLElement && node.dataset.commandName)
              return `/${node.dataset.commandName}`;
            if (node instanceof HTMLElement && node.dataset.referencePath)
              return "";
            return node.textContent ?? "";
          })
          .join(""),
      )
      .join("\n");
  }
  return Array.from(input.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("");
}
beforeEach(() => {
  vi.clearAllMocks();
  pasteMocks.paths.mockReset().mockResolvedValue([]);
  pasteMocks.store.mockReset();
  pasteMocks.importFile.mockReset();
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    fn(0);
    return 0;
  });
  mocks.send.mockResolvedValue(false);
  mocks.openModelSettings.mockReset().mockReturnValue(null);
  mocks.choose.mockReset().mockResolvedValue(null);
  mocks.request.mockImplementation(async (_host, request) =>
    request.method === "agent_commands"
      ? {
          kind: "agent_commands",
          commands: [
            {
              name: "compact",
              description: "压缩上下文",
              argument_hint: "[说明]",
            },
            {
              name: "project:check",
              description: "项目检查",
              argument_hint: "<目标>",
            },
          ],
        }
      : {
          kind: "files",
          entries:
            request.path === "src"
              ? [
                  {
                    name: "中文 file.ts",
                    path: "src/中文 file.ts",
                    directory: false,
                  },
                ]
              : [
                  { name: "src", path: "src", directory: true },
                  { name: "README.md", path: "README.md", directory: false },
                ],
        },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const prediction = { id: "round-1", text: "检查修改结果\n并补充边界测试" };
function expectNoPredictionDescription() {
  const input = screen.getByRole("textbox", {
    name: "任务输入",
    description: "",
  });
  expect(input.getAttribute("aria-describedby")).toBeNull();
  expect(
    input.closest(".composer")!.querySelector(".composer-prediction"),
  ).toBeNull();
}
it("describes the complete multiline prediction and Tab hint without a live announcement", () => {
  const view = render(<Harness prediction={prediction} />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  // Role queries compute the description through dom-accessibility-api.
  expect(
    screen.getByRole("textbox", {
      description: (description) =>
        description.replace(/\s+/g, " ") ===
        "检查修改结果 并补充边界测试 Tab 插入",
    }),
  ).toBe(input);
  const descriptionIds = input.getAttribute("aria-describedby")!.split(" ");
  expect(descriptionIds).toHaveLength(2);
  const body = document.getElementById(descriptionIds[0])!;
  expect(body.textContent).toBe(prediction.text);
  expect(body.getAttribute("aria-hidden")).toBe("true");
  expect(document.getElementById(descriptionIds[1])!.textContent).toBe(
    "Tab 插入",
  );
  expect(view.container.querySelector("[aria-live]")).toBeNull();
  expect(input.value).toBe("");
  expect(screen.getByText("发送")).toHaveProperty("disabled", true);
  expect(mocks.send).not.toHaveBeenCalled();
});
it("uses unique prediction description IDs for multiple composers", () => {
  const other = { ...prediction, text: "另一条完整建议" };
  render(
    <>
      <Harness prediction={prediction} inputLabel="第一个输入" />
      <Harness prediction={other} inputLabel="第二个输入" />
    </>,
  );
  const inputs = screen.getAllByRole("textbox");
  expect(
    screen.getByRole("textbox", {
      name: "第一个输入",
      description: (description) =>
        description.replace(/\s+/g, " ") ===
        "检查修改结果 并补充边界测试 Tab 插入",
    }),
  ).toBe(inputs[0]);
  expect(
    screen.getByRole("textbox", {
      name: "第二个输入",
      description: "另一条完整建议 Tab 插入",
    }),
  ).toBe(inputs[1]);
  const ids = inputs.flatMap((input) =>
    input.getAttribute("aria-describedby")!.split(" "),
  );
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(4);
  expect(ids.every((id) => document.getElementById(id))).toBe(true);
});
it("shows a multiline prediction outside the empty editor and Tab inserts without sending", () => {
  render(<Harness prediction={prediction} />);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(
    screen.getByText(prediction.text, {
      exact: true,
      normalizer: (text) => text,
    }),
  ).toBeTruthy();
  expect(screen.getByText("Tab 插入")).toBeTruthy();
  expect(input.value).toBe("");
  expect(screen.getByText("发送")).toHaveProperty("disabled", true);
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input.value).toBe(prediction.text);
  expectNoPredictionDescription();
  expect(input.selectionStart).toBe(prediction.text.length);
  expect(document.activeElement).toBe(input);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(screen.getByText("发送")).toHaveProperty("disabled", false);
  type("");
  expect(screen.queryByText("Tab 插入")).toBeNull();
  expectNoPredictionDescription();
});
it("fits the empty editor to multiline ghost height, caps at 200px and restores ordinary height", () => {
  const height = vi
    .spyOn(Element.prototype, "scrollHeight", "get")
    .mockImplementation(function (this: Element) {
      return this.classList.contains("composer-prediction") ? 280 : 20;
    });
  try {
    const view = render(<Harness prediction={prediction} />);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").style.height).toBe(
      "200px",
    );
    view.rerender(<Harness />);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").style.height).toBe(
      "20px",
    );
  } finally {
    height.mockRestore();
  }
});
it("allows an explicitly empty context component without creating a draft", () => {
  function EmptyContext() {
    return null;
  }
  render(
    <Harness
      prediction={prediction}
      hasContext={false}
      context={<EmptyContext />}
    />,
  );
  expect(screen.getByText("Tab 插入")).toBeTruthy();
  expect(inputText()).toBe("");
});
it.each([" ", "\n", "已有草稿"])(
  "does not predict over a nonempty value %j",
  (value) => {
    render(<Harness prediction={prediction} />);
    type(value);
    expect(screen.queryByText("Tab 插入")).toBeNull();
    expectNoPredictionDescription();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab" });
    expect(inputText()).toBe(value);
  },
);
it.each([
  { shiftKey: true },
  { ctrlKey: true },
  { metaKey: true },
  { altKey: true },
  { isComposing: true },
  { keyCode: 229 },
])("preserves modified Tab and IME %j", (modifiers) => {
  render(<Harness prediction={prediction} />);
  expect(
    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "Tab",
      ...modifiers,
    }),
  ).toBe(true);
  expect(inputText()).toBe("");
  expect(mocks.send).not.toHaveBeenCalled();
});
it("hides predictions during composition and Escape dismisses only this source", () => {
  const view = render(<Harness prediction={prediction} />);
  const input = screen.getByRole("textbox");
  fireEvent.compositionStart(input);
  expect(screen.queryByText("Tab 插入")).toBeNull();
  expectNoPredictionDescription();
  fireEvent.keyDown(input, { key: "Tab" });
  expect(inputText()).toBe("");
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByText("Tab 插入")).toBeNull();
  expectNoPredictionDescription();
  view.rerender(
    <Harness prediction={{ ...prediction, text: "同轮晚到结果" }} />,
  );
  expect(screen.queryByText("Tab 插入")).toBeNull();
  expectNoPredictionDescription();
  view.rerender(<Harness prediction={{ ...prediction, id: "round-2" }} />);
  expect(screen.getByText("Tab 插入")).toBeTruthy();
});
it.each([
  { connected: false },
  { disabled: true },
  { sending: true },
  { hidden: true },
  { concealSubmitted: true },
  { predictionBlocked: true },
  { skillCreator: true },
  { hasContext: true },
  { context: <div>引用正文</div> },
  { annotations: [{ id: "annotation" }] },
  {
    referenceState: {
      scope: "remote:p:claude",
      entries: [{ name: "src", path: "src", directory: true }],
    },
  },
  {
    referenceState: {
      scope: "remote:p:claude",
      entries: [
        {
          name: "file",
          path: "/tmp/file",
          directory: false,
          attachmentKind: "file",
        },
      ],
    },
  },
])("does not display or accept predictions in blocked state %j", (props) => {
  const view = render(<Harness prediction={prediction} />);
  expect(
    screen.getByRole("textbox", {
      description: (description) =>
        description.replace(/\s+/g, " ") ===
        "检查修改结果 并补充边界测试 Tab 插入",
    }),
  ).toBeTruthy();
  view.rerender(
    <Harness
      prediction={prediction}
      {...(props as Partial<ComponentProps<typeof Composer>>)}
    />,
  );
  expect(screen.queryByText("Tab 插入")).toBeNull();
  expectNoPredictionDescription();
  expect(fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab" })).toBe(
    true,
  );
  expect(inputText()).toBe("");
  expect(mocks.send).not.toHaveBeenCalled();
});
it("hides and does not accept predictions while a toolbar Select combobox is expanded", async () => {
  render(
    <Harness
      prediction={prediction}
      toolbar={() => (
        <Select
          label="权限"
          value="default"
          options={[{ value: "default", label: "跟随 Agent" }]}
          onChange={vi.fn()}
        />
      )}
    />,
  );
  expect(screen.getByText("Tab 插入")).toBeTruthy();
  fireEvent.click(screen.getByRole("combobox", { name: "权限" }));
  await waitFor(() => expect(screen.queryByText("Tab 插入")).toBeNull());
  expect(
    fireEvent.keyDown(screen.getByRole("textbox", { name: "任务输入" }), {
      key: "Tab",
    }),
  ).toBe(true);
  expect(inputText()).toBe("");
  // Select itself closes on Tab while leaving its native navigation unprevented.
  await waitFor(() => expect(screen.getByText("Tab 插入")).toBeTruthy());
  fireEvent.click(screen.getByRole("combobox", { name: "权限" }));
  await waitFor(() => expect(screen.queryByText("Tab 插入")).toBeNull());
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  await waitFor(() => expect(screen.getByText("Tab 插入")).toBeTruthy());
  expect(mocks.send).not.toHaveBeenCalled();
});
it("gives menus priority and preserves normal Tab when no prediction exists", () => {
  const view = render(<Harness prediction={prediction} />);
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  expect(screen.queryByText("Tab 插入")).toBeNull();
  expectNoPredictionDescription();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.getByText("Tab 插入")).toBeTruthy();
  view.rerender(<Harness />);
  expect(fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab" })).toBe(
    true,
  );
  expect(inputText()).toBe("");
});

it("detects only standalone mention and slash triggers", () => {
  expect(composerTrigger("mail@host", 9)).toBeNull();
  expect(composerTrigger("https://host/", 13)).toBeNull();
  expect(composerTrigger("/compact 参数", 11)).toBeNull();
  expect(composerTrigger("看看 @src/中文 file.ts 后文", 18)).toMatchObject({
    kind: "files",
    start: 3,
  });
});

it("discovers and submits skills in side chat while keeping control commands blocked", async () => {
  mocks.request.mockImplementation(async (_host, req) =>
    req.method === "agent_commands"
      ? {
          kind: "agent_commands",
          commands: [
            {
              name: "compact",
              description: "压缩会话上下文",
              argument_hint: "",
              kind: "command",
            },
            {
              name: "review-code-changes",
              display_name: "代码评审",
              description: "按评审契约审查变更",
              argument_hint: "[范围]",
              kind: "skill",
            },
          ],
        }
      : { kind: "files", entries: [] },
  );
  mocks.send.mockResolvedValue(true);
  const { container } = render(<Harness sideChat />);
  type("/");
  expect(screen.getAllByRole("option")).toHaveLength(2);
  fireEvent.click(screen.getByRole("option", { name: /选择模型/ }));
  fireEvent.click(screen.getByText("发送"));
  expect(mocks.openModelSettings).toHaveBeenCalledWith(
    "model",
    expect.any(Function),
  );

  // Known built-in control commands fail closed immediately without network or send.
  mocks.request.mockClear();
  type("/compact ");
  fireEvent.click(screen.getByText("发送"));
  expect(screen.getByText(/侧边聊天不支持 Agent 原生命令/)).toBeTruthy();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();

  // Opening `/` in side chat lists `/model`, `/effort`, and skills (hiding `/compact` and `/agents`).
  type("/");
  const skillOption = await screen.findByRole("option", {
    name: /review-code-changes.*代码评审/,
  });
  expect(screen.queryByRole("option", { name: /compact/ })).toBeNull();
  expect(screen.queryByRole("option", { name: /agents/ })).toBeNull();
  fireEvent.click(skillOption);
  expect(inputText()).toBe("/review-code-changes ");
  expect(container.querySelector(".composer-command-pill")?.textContent).toBe(
    "review-code-changes",
  );

  type("/review-code-changes 评审下");
  fireEvent.click(screen.getByText("发送"));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith("/review-code-changes 评审下"),
  );
});
it.each([
  ["local", "请检查 /comp", "Enter"],
  ["remote", "请检查   /comp", "Tab"],
])(
  "completes a command after text on %s, preserving spaces without submitting",
  async (hostId, draft, key) => {
    render(<Harness hostId={hostId} />);
    type(draft);
    await screen.findByRole("option", { name: /compact/ });
    expect(mocks.request).toHaveBeenCalledWith(hostId, {
      method: "agent_commands",
      project_id: "p",
      agent: "claude",
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key });
    const completed = draft.replace(/\/comp$/, "/compact ");
    expect(inputText()).toBe(completed);
    expect(
      screen.getByRole("textbox").querySelector('[data-command-name="compact"]')
        ?.textContent,
    ).toBe("compact");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith(completed.trim()),
    );
  },
);
it("completes a command at the caret without replacing surrounding text", async () => {
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
    window.setTimeout(() => fn(0), 0),
  );
  render(<Harness />);
  const before = "前文  ";
  const after = " 后文";
  type(`${before}/comp${after}`, before.length + "/comp".length);
  fireEvent.click(await screen.findByRole("option", { name: /compact/ }));
  expect(inputText()).toBe(`${before}/compact ${after}`);
  expect(
    screen.getByRole("textbox").querySelector('[data-command-name="compact"]')
      ?.textContent,
  ).toBe("compact");
  expect(mocks.send).not.toHaveBeenCalled();
});
it("loads native commands from the selected host and inserts without running; sends exact arguments", async () => {
  render(<Harness />);
  type("/comp");
  await screen.findByRole("option", { name: /compact/ });
  expect(mocks.request).toHaveBeenCalledWith("remote", {
    method: "agent_commands",
    project_id: "p",
    agent: "claude",
  });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(inputText()).toBe("/compact ");
  expect(mocks.send).not.toHaveBeenCalled();
  type("/compact 保留结论");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith("/compact 保留结论"),
  );
});
it("preserves plain draft text when submission returns false until an explicit retry", async () => {
  mocks.send.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<Harness />);
  type("保留原草稿，改选有效模型后再发送");
  await act(async () => fireEvent.click(screen.getByText("发送")));
  expect(mocks.send).toHaveBeenCalledOnce();
  expect(mocks.send).toHaveBeenLastCalledWith(
    "保留原草稿，改选有效模型后再发送",
  );
  expect(inputText()).toBe("保留原草稿，改选有效模型后再发送");
  expect(screen.getByText("发送")).toHaveProperty("disabled", false);
  await act(async () => fireEvent.click(screen.getByText("发送")));
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(mocks.send).toHaveBeenLastCalledWith(
    "保留原草稿，改选有效模型后再发送",
  );
});
it("adds a file with spaces at the caret, preserves surrounding text and retries failed sends", async () => {
  render(<Harness />);
  type("检查 @src/中文 file.ts 后文", 18);
  fireEvent.click(await screen.findByRole("option", { name: /中文 file.ts/ }));
  expect(
    screen.getByRole("button", { name: "移除引用 src/中文 file.ts" }),
  ).toBeTruthy();
  expect(inputText()).toBe("检查  后文");
  expect(
    screen.getByRole("textbox").querySelector("[data-reference-path]"),
  ).toHaveProperty("title", "src/中文 file.ts");
  fireEvent.click(screen.getByText("发送"));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
  expect(referenceMessage(mocks.send.mock.calls[0][0]).references).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "src/中文 file.ts" }),
    ]),
  );
  expect(screen.getByRole("button", { name: /移除引用/ })).toBeTruthy();
  mocks.send.mockResolvedValue(true);
  fireEvent.click(screen.getByText("发送"));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /移除引用/ })).toBeNull(),
  );
});
it("supports plus folder browsing, folder references and removing chips", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /引用工作区文件/ }));
  fireEvent.click(await screen.findByRole("option", { name: /src/ }));
  fireEvent.click(await screen.findByRole("option", { name: /引用此文件夹/ }));
  expect(screen.getByRole("button", { name: "移除引用 src" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "移除引用 src" }));
  expect(screen.queryByLabelText("已添加附件和引用")).toBeNull();
});
it("keeps path references in the text flow while editing, deleting and sending", async () => {
  render(<Harness />);
  type("在 @src/中文 file.ts 后面继续", "在 @src/中文 file.ts".length);
  fireEvent.click(await screen.findByRole("option", { name: /中文 file.ts/ }));
  const editor = screen.getByRole("textbox", { name: "任务输入" });
  expect(editor.classList.contains("composer-inline-input")).toBe(true);
  expect(
    Array.from(editor.childNodes).map((node) =>
      node instanceof HTMLElement && node.dataset.referencePath
        ? node.dataset.referencePath
        : node.textContent,
    ),
  ).toEqual(["在 ", "src/中文 file.ts", " 后面继续"]);

  editor.firstChild!.textContent = "请在 ";
  fireEvent.input(editor);
  expect(inputText()).toBe("请在  后面继续");
  fireEvent.click(screen.getByText("发送"));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
  expect(referenceMessage(mocks.send.mock.calls[0][0])).toMatchObject({
    text: "请在  后面继续",
    references: [expect.objectContaining({ path: "src/中文 file.ts" })],
  });

  const range = document.createRange();
  range.setStartAfter(editor.querySelector("[data-reference-path]")!);
  range.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  fireEvent.keyDown(editor, { key: "Backspace" });
  expect(
    screen.queryByRole("button", { name: "移除引用 src/中文 file.ts" }),
  ).toBeNull();
  expect(inputText()).toBe("请在  后面继续");
});
function selectComposerRange(range: Range) {
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}
async function addReadme(text = "前文 @READ", cursor = text.length) {
  type(text, cursor);
  fireEvent.click(await screen.findByRole("option", { name: /README/ }));
  return screen.getByRole("textbox", { name: "任务输入" });
}
it.each(["Backspace", "Delete", "button"])(
  "restores the textarea caret and multiline height after removing the last chip via %s",
  async (action) => {
    const height = vi
      .spyOn(Element.prototype, "scrollHeight", "get")
      .mockReturnValue(76);
    try {
      render(<Harness />);
      const editor = await addReadme(
        "前文 @READ 后文\n下一行",
        "前文 @READ".length,
      );
      editor.focus();
      const chip = editor.querySelector("[data-reference-path]")!;
      const range = document.createRange();
      if (action === "Delete") range.setStartBefore(chip);
      else range.setStartAfter(chip);
      range.collapse(true);
      selectComposerRange(range);

      if (action === "button")
        fireEvent.click(
          screen.getByRole("button", { name: "移除引用 README.md" }),
        );
      else fireEvent.keyDown(editor, { key: action });

      const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "任务输入",
      });
      expect(input).toBeInstanceOf(HTMLTextAreaElement);
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe("前文 ".length);
      expect(input.value).toBe("前文  后文\n下一行");
      expect(input.style.height).toBe("76px");
    } finally {
      height.mockRestore();
    }
  },
);
it("keeps the editor mounted while IME replaces the last chip and allows sending after composition", async () => {
  render(<Harness />);
  const editor = await addReadme();
  editor.focus();
  fireEvent.compositionStart(editor);
  editor.replaceChildren(document.createTextNode("中文"));
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selectComposerRange(range);
  fireEvent.input(editor, {
    inputType: "insertCompositionText",
    isComposing: true,
  });
  expect(screen.getByRole("textbox", { name: "任务输入" })).toBe(editor);
  fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.compositionEnd(editor, { data: "中文" });

  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "任务输入",
  });
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("中文");
  expect(input.selectionStart).toBe("中文".length);
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(mocks.send).toHaveBeenCalledWith("中文"));
});
it("renders a trailing line without adding a draft character and ignores WebKit's empty placeholder", async () => {
  render(<Harness />);
  const editor = await addReadme();
  const text = document.createRange();
  text.setStartAfter(editor.querySelector("[data-reference-path]")!);
  text.collapse(true);
  selectComposerRange(text);
  fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
  expect(editor.lastChild).toBeInstanceOf(HTMLBRElement);
  expect(inputText()).toBe("前文 \n");
  fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
  expect(editor.querySelectorAll("br")).toHaveLength(1);
  expect(inputText()).toBe("前文 \n\n");

  editor.replaceChildren(document.createElement("br"));
  const empty = document.createRange();
  empty.setStart(editor, 0);
  empty.collapse(true);
  selectComposerRange(empty);
  fireEvent.input(editor, { inputType: "deleteContentBackward" });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "任务输入",
  });
  expect(input.value).toBe("");
  expect(input.placeholder).toBe("任务");
});
it.each([false, true])(
  "rejects edits whose selection crosses the composer boundary (backward = %s)",
  async (backward) => {
    render(<Harness />);
    const editor = await addReadme();
    const outside = screen.getByRole("button", { name: "发送" });
    const selection = window.getSelection()!;
    const first = editor.firstChild!;
    const last = outside.firstChild!;
    selection.setBaseAndExtent(
      ...((backward ? [last, 1, first, 0] : [first, 0, last, 1]) as [
        Node,
        number,
        Node,
        number,
      ]),
    );
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(fireEvent.cut(editor)).toBe(false);
    pasteData("替换");
    expect(pasteMocks.paths).not.toHaveBeenCalled();
    expect(outside.textContent).toBe("发送");
    expect(inputText()).toBe("前文 ");
    expect(editor.querySelector("[data-reference-path]")).not.toBeNull();
  },
);
it("keeps adjacent chips on the left of command completion and successive deletions", async () => {
  render(<Harness />);
  const editor = await addReadme();
  const clipboard = document.createRange();
  clipboard.setStartAfter(editor.querySelector("[data-reference-path]")!);
  clipboard.collapse(true);
  selectComposerRange(clipboard);
  pasteData("@src/中文 file.ts");
  await waitFor(() => expect(inputText()).toBe("前文 @src/中文 file.ts"));
  fireEvent.click(editor);
  fireEvent.click(await screen.findByRole("option", { name: /中文 file.ts/ }));
  const second = editor.querySelector(
    '[data-reference-path="src/中文 file.ts"]',
  )!;
  const suffix = second.nextSibling!;
  suffix.textContent = "/comp";
  const range = document.createRange();
  range.setStart(suffix, "/comp".length);
  range.collapse(true);
  selectComposerRange(range);
  fireEvent.input(editor);
  fireEvent.click(await screen.findByRole("option", { name: /compact/ }));
  expect(inputText()).toBe("前文 /compact ");
  const richEditor = screen.getByRole("textbox", { name: "任务输入" });
  expect(
    richEditor.querySelector('[data-command-name="compact"]')?.textContent,
  ).toBe("compact");

  fireEvent.click(
    screen.getByRole("button", { name: "移除引用 src/中文 file.ts" }),
  );
  expect(richEditor.querySelectorAll("[data-reference-path]")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "移除引用 README.md" }));
  expect(screen.queryByRole("button", { name: /移除引用/ })).toBeNull();
  expect(inputText()).toBe("前文 /compact ");
});
it("restores the caret after the last pasted directory at the original position", async () => {
  render(<Harness hostId="local" />);
  type("前文 后文", "前文 ".length);
  pasteMocks.paths.mockResolvedValue(["/local/one", "/local/two"]);
  pasteMocks.importFile.mockImplementation(
    async (_host, _project, path: string) => ({
      path,
      name: path.split("/").at(-1),
      directory: true,
    }),
  );
  pasteData();
  const two = await screen.findByRole("button", {
    name: "移除引用 /local/two",
  });
  const point = window.getSelection()!.getRangeAt(0);
  const after = document.createRange();
  after.setStartAfter(two.closest("[data-reference-path]")!);
  after.collapse(true);
  expect(point.compareBoundaryPoints(Range.START_TO_START, after)).toBe(0);
});
it("drops only plain text and blocks native formatting commands in the inline editor", async () => {
  render(<Harness />);
  const editor = await addReadme();
  editor.focus();
  const range = document.createRange();
  range.setStartAfter(editor.querySelector("[data-reference-path]")!);
  range.collapse(true);
  selectComposerRange(range);
  expect(
    fireEvent.drop(editor, {
      dataTransfer: {
        types: ["text/plain", "text/html"],
        getData: (type: string) =>
          type === "text/plain" ? "一\r\n二" : "<b>different</b>",
      },
    }),
  ).toBe(false);
  expect(inputText()).toBe("前文 一\n二");
  expect(editor.querySelector("b")).toBeNull();
  expect(
    fireEvent(
      editor,
      new InputEvent("beforeinput", {
        inputType: "formatBold",
        bubbles: true,
        cancelable: true,
      }),
    ),
  ).toBe(false);
});
it("keeps image reference preview and removal interactive inside the text", async () => {
  mocks.request.mockResolvedValue({
    kind: "files",
    entries: [{ name: "diagram.png", path: "diagram.png", directory: false }],
  });
  render(<Harness />);
  type("查看 @diagram");
  fireEvent.click(await screen.findByRole("option", { name: /diagram.png/ }));
  const editor = screen.getByRole("textbox", { name: "任务输入" });
  expect(
    editor.querySelector('[data-reference-path="diagram.png"]'),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "预览图片 diagram.png" }),
  ).toBeTruthy();
  type("查看 @diagram");
  const list = await screen.findByRole("listbox");
  const option = await screen.findByRole("option", { name: /diagram.png/ });
  expect(editor.getAttribute("aria-autocomplete")).toBe("list");
  expect(editor.getAttribute("aria-controls")).toBe(list.id);
  expect(editor.getAttribute("aria-activedescendant")).toBe(option.id);
  fireEvent.click(screen.getByRole("button", { name: "预览图片 diagram.png" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(editor.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "移除引用 diagram.png" }));
  expect(
    screen.queryByRole("button", { name: "预览图片 diagram.png" }),
  ).toBeNull();
});
it("pastes on the selected side of an inline reference", async () => {
  render(<Harness />);
  type("前文 @READ");
  fireEvent.click(await screen.findByRole("option", { name: /README/ }));
  const editor = screen.getByRole("textbox", { name: "任务输入" });
  const chip = editor.querySelector("[data-reference-path]")!;
  const range = document.createRange();
  range.setStartAfter(chip);
  range.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  pasteData("后文");
  await waitFor(() => expect(inputText()).toBe("前文 后文"));
  expect(
    Array.from(editor.childNodes).map((node) =>
      node instanceof HTMLElement && node.dataset.referencePath
        ? node.dataset.referencePath
        : node.textContent,
    ),
  ).toEqual(["前文 ", "README.md", "后文"]);
  range.setStart(editor.firstChild!, "前文 ".length);
  range.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  pasteData("插入");
  await waitFor(() => expect(inputText()).toBe("前文 插入后文"));
  expect(
    Array.from(editor.childNodes).map((node) =>
      node instanceof HTMLElement && node.dataset.referencePath
        ? node.dataset.referencePath
        : node.textContent,
    ),
  ).toEqual(["前文 插入", "README.md", "后文"]);
  range.selectNodeContents(editor);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  pasteData("替换");
  await waitFor(() => expect(inputText()).toBe("替换"));
  expect(
    screen.queryByRole("button", { name: "移除引用 README.md" }),
  ).toBeNull();
});
it("keeps the caret after pasted text following a reference", async () => {
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
    window.setTimeout(() => fn(0), 0),
  );
  render(<Harness />);
  type("前文 @READ");
  fireEvent.click(await screen.findByRole("option", { name: /README/ }));
  const editor = screen.getByRole("textbox", { name: "任务输入" });
  await waitFor(() =>
    expect(editor.querySelector("[data-reference-path]")).toBeTruthy(),
  );
  pasteData("后文");
  await waitFor(() => expect(inputText()).toBe("前文 后文"));
  await waitFor(() =>
    expect(window.getSelection()?.anchorOffset).toBe("后文".length),
  );
  pasteData("继续");
  await waitFor(() => expect(inputText()).toBe("前文 后文继续"));
});
it("does not submit on IME, empty results or menu selection and closes on Escape", async () => {
  render(<Harness />);
  type("/unknown");
  await screen.findByText(/没有匹配项/);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  type("中文输入");
  fireEvent.compositionStart(screen.getByRole("textbox"));
  fireEvent.keyDown(screen.getByRole("textbox"), {
    key: "Enter",
    keyCode: 229,
  });
  expect(mocks.send).not.toHaveBeenCalled();
});
it("discards late file responses and references when changing project or host", async () => {
  const view = render(<Harness />);
  type("@READ");
  fireEvent.click(await screen.findByRole("option", { name: /README/ }));
  expect(
    screen.getByRole("button", { name: "移除引用 README.md" }),
  ).toBeTruthy();
  let finish: (value: unknown) => void = () => {};
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  type("@");
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
  view.rerender(<Harness hostId="another" projectId="different" />);
  await act(async () =>
    finish({
      kind: "files",
      entries: [{ name: "secret", path: "secret", directory: false }],
    }),
  );
  expect(
    screen.queryByRole("button", { name: "移除引用 README.md" }),
  ).toBeNull();
  expect(screen.queryByRole("listbox")).toBeNull();
});
it("reports command discovery errors and retries against the agent", async () => {
  mocks.request.mockRejectedValueOnce(new Error("unsupported agent"));
  render(<Harness />);
  type("/");
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("unsupported agent"),
  );
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("option", { name: /compact/ })).toBeTruthy();
});
it("keeps references through first-session creation while sending and clears on later navigation", async () => {
  const props = {
    agent: "claude",
    hostId: "local",
    projectId: "p",
    connected: true,
    disabled: false,
    sending: false,
    hidden: false,
    value: "",
    onChange: vi.fn(),
    onSubmit: mocks.send,
    placeholder: "任务",
    toolbar: () => null,
  };
  const view = render(<Composer {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /引用工作区文件/ }));
  fireEvent.click(await screen.findByRole("option", { name: /README/ }));
  view.rerender(<Composer {...props} sending sessionId="new-session" />);
  expect(
    screen.getByRole("button", { name: "移除引用 README.md" }),
  ).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "移除引用 README.md",
    }).disabled,
  ).toBe(true);
  view.rerender(<Composer {...props} sessionId="new-session" />);
  expect(
    screen.getByRole("button", { name: "移除引用 README.md" }),
  ).toBeTruthy();
  view.rerender(<Composer {...props} sessionId="another-session" />);
  expect(
    screen.queryByRole("button", { name: "移除引用 README.md" }),
  ).toBeNull();
});
it("searches friendly titles but inserts the original agent command", async () => {
  render(<Harness />);
  type("/压缩");
  fireEvent.click(await screen.findByRole("option", { name: /压缩上下文/ }));
  expect(inputText()).toBe("/compact ");
  expect(mocks.send).not.toHaveBeenCalled();
});

it("references a local file or folder chosen outside the project without sending", async () => {
  mocks.choose
    .mockResolvedValueOnce("/outside/中文 file.txt")
    .mockResolvedValueOnce("/outside/docs");
  mocks.request.mockImplementation(async (_host, req) =>
    req.method === "resolve_reference"
      ? {
          kind: "file_reference",
          entry: {
            name: "chosen",
            path: req.path,
            directory: req.path.endsWith("docs"),
          },
        }
      : { kind: "files", entries: [] },
  );
  render(<Harness hostId="local" />);
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /引用工作区文件/ }));
  fireEvent.click(screen.getByRole("button", { name: "引用本机路径…" }));
  fireEvent.click(screen.getByRole("button", { name: "选择文件并引用…" }));
  await screen.findByRole("button", {
    name: "移除引用 /outside/中文 file.txt",
  });
  expect(mocks.choose).toHaveBeenCalledWith(false);
  expect(mocks.request).toHaveBeenCalledWith("local", {
    method: "resolve_reference",
    project_id: "p",
    path: "/outside/中文 file.txt",
  });
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /引用工作区文件/ }));
  fireEvent.click(screen.getByRole("button", { name: "引用本机路径…" }));
  fireEvent.click(screen.getByRole("button", { name: "选择文件夹并引用…" }));
  await screen.findByRole("button", { name: "移除引用 /outside/docs" });
  expect(mocks.choose).toHaveBeenCalledWith(true);
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("发送"));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
  expect(referenceMessage(mocks.send.mock.calls[0][0]).references).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "/outside/中文 file.txt" }),
    ]),
  );
  expect(mocks.send.mock.calls[0][0]).toContain("绝对路径在当前主机");
});
it("resolves remote paths on the selected host and never opens a local chooser", async () => {
  mocks.request.mockResolvedValue({
    kind: "file_reference",
    entry: { name: "docs", path: "/home/user/docs", directory: true },
  });
  render(<Harness hostId="ssh:devbox" />);
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /引用工作区文件/ }));
  expect(screen.queryByRole("button", { name: "选择文件并引用…" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "引用远程路径…" }));
  const field = screen.getByRole("textbox", { name: "引用绝对路径" });
  fireEvent.change(field, { target: { value: "/home/user/docs" } });
  fireEvent.keyDown(field, { key: "Enter", isComposing: true });
  expect(mocks.request).not.toHaveBeenCalledWith(
    "ssh:devbox",
    expect.objectContaining({ method: "resolve_reference" }),
  );
  fireEvent.keyDown(field, { key: "Enter" });
  await screen.findByRole("button", { name: "移除引用 /home/user/docs" });
  expect(mocks.request).toHaveBeenCalledWith("ssh:devbox", {
    method: "resolve_reference",
    project_id: "p",
    path: "/home/user/docs",
  });
  expect(mocks.choose).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it("keeps references unchanged on cancellation and rejects invalid or inaccessible paths", async () => {
  render(<Harness hostId="local" />);
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /引用工作区文件/ }));
  fireEvent.click(screen.getByRole("button", { name: "引用本机路径…" }));
  fireEvent.click(screen.getByRole("button", { name: "选择文件并引用…" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "返回项目目录",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(screen.queryByLabelText("已添加附件和引用")).toBeNull();

  const field = screen.getByRole("textbox", { name: "引用绝对路径" });
  fireEvent.change(field, { target: { value: "../secret" } });
  fireEvent.click(screen.getByRole("button", { name: "添加引用" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("绝对路径"),
  );
  mocks.request.mockRejectedValueOnce(new Error("路径不存在或无法访问"));
  fireEvent.change(field, { target: { value: "/missing" } });
  fireEvent.click(screen.getByRole("button", { name: "添加引用" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("路径不存在"),
  );
  expect(screen.queryByLabelText("已添加附件和引用")).toBeNull();
});
it("discards a late native selection after switching hosts", async () => {
  let finish: (value: string) => void = () => {};
  mocks.choose.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<Harness hostId="local" />);
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /引用工作区文件/ }));
  fireEvent.click(screen.getByRole("button", { name: "引用本机路径…" }));
  fireEvent.click(screen.getByRole("button", { name: "选择文件并引用…" }));
  view.rerender(<Harness hostId="remote" />);
  await act(async () => finish("/private/local-file"));
  expect(mocks.request).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ method: "resolve_reference" }),
  );
  expect(screen.queryByLabelText("已添加附件和引用")).toBeNull();
});

function pasteData(text = "", files: File[] = []) {
  fireEvent.paste(screen.getByRole("textbox", { name: "任务输入" }), {
    clipboardData: { files, getData: () => text },
  });
}
it("pastes short text at the selection and stages long text as a file without filling the input", async () => {
  render(<Harness hostId="local" />);
  type("prefix old suffix");
  const input = screen.getByRole("textbox", {
    name: "任务输入",
  }) as HTMLTextAreaElement;
  input.setSelectionRange(7, 10);
  pasteData("新文本");
  await waitFor(() => expect(input.value).toBe("prefix 新文本 suffix"));
  expect(pasteMocks.store).not.toHaveBeenCalled();
  pasteMocks.store.mockResolvedValue({
    name: "粘贴文本.txt",
    path: "/cache/text.txt",
    directory: false,
    attachmentKind: "text",
  });
  pasteData("x".repeat(8001));
  await screen.findByRole("button", { name: "移除附件 /cache/text.txt" });
  expect(input.value).toBe("prefix 新文本 suffix");
  expect(pasteMocks.store.mock.calls[0][0]).toBeInstanceOf(File);
  expect(pasteMocks.store.mock.calls[0][4]).toBe("text");
  expect(mocks.send).not.toHaveBeenCalled();
});
it("recognizes image/video/file pastes and keeps native file URLs ahead of clipboard previews", async () => {
  render(<Harness hostId="remote" />);
  pasteMocks.paths.mockResolvedValueOnce(["/local/movie.mov"]);
  pasteMocks.importFile.mockResolvedValue({
    name: "movie.mov",
    path: "/remote/cache/movie.mov",
    directory: false,
    attachmentKind: "video",
  });
  pasteData("movie.mov", [
    new File(["thumbnail"], "preview.png", { type: "image/png" }),
  ]);
  await screen.findByRole("button", {
    name: "移除附件 /remote/cache/movie.mov",
  });
  expect(pasteMocks.store).not.toHaveBeenCalled();
  expect(pasteMocks.importFile).toHaveBeenCalledWith(
    "remote",
    "p",
    "/local/movie.mov",
  );
  pasteMocks.store.mockImplementation(async (file: File) => ({
    name: file.name,
    path: `/remote/cache/${file.name}`,
    directory: false,
    attachmentKind: file.type.startsWith("image/") ? "image" : "file",
  }));
  pasteData("", [
    new File(["png"], "image.png", { type: "image/png" }),
    new File(["pdf"], "doc.pdf", { type: "application/pdf" }),
  ]);
  await screen.findByRole("button", {
    name: "移除附件 /remote/cache/image.png",
  });
  await screen.findByRole("button", { name: "移除附件 /remote/cache/doc.pdf" });
  expect(screen.getByText("图片 · image.png")).toBeTruthy();
  expect(screen.getByText("movie.mov")).toBeTruthy();
  expect(screen.getByText("doc.pdf")).toBeTruthy();
});
it("blocks send while pasting and discards failed batches and late results after host changes", async () => {
  const view = render(<Harness hostId="local" />);
  type("keep this draft");
  let finish: (value: unknown) => void = () => {};
  pasteMocks.store.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  pasteData("", [new File(["png"], "image.png")]);
  await waitFor(() => expect(pasteMocks.store).toHaveBeenCalledOnce());
  expect((screen.getByText("发送") as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<Harness hostId="another" />);
  await act(async () =>
    finish({
      name: "image.png",
      path: "/old/cache/image.png",
      directory: false,
    }),
  );
  expect(screen.queryByLabelText("已添加附件和引用")).toBeNull();
  pasteMocks.store
    .mockResolvedValueOnce({
      name: "first.png",
      path: "/cache/first.png",
      directory: false,
    })
    .mockRejectedValueOnce(new Error("上传失败"));
  pasteData("", [new File(["1"], "first.png"), new File(["2"], "second.png")]);
  await screen.findByText(/上传失败/);
  expect(screen.queryByLabelText("已添加附件和引用")).toBeNull();
  expect(
    (screen.getByRole("textbox", { name: "任务输入" }) as HTMLTextAreaElement)
      .value,
  ).toBe("keep this draft");
});

it("keeps pasted text authoritative when a clipboard manager restores older file URLs", async () => {
  pasteMocks.paths.mockResolvedValue(["/old/report.pdf"]);
  render(<Harness hostId="local" />);
  pasteData("ordinary text from this paste");
  await waitFor(() =>
    expect(
      (screen.getByRole("textbox", { name: "任务输入" }) as HTMLTextAreaElement)
        .value,
    ).toBe("ordinary text from this paste"),
  );
  expect(pasteMocks.importFile).not.toHaveBeenCalled();
});

it("shows one local subagent entry and hides native listing variants", async () => {
  mocks.request.mockResolvedValue({
    kind: "agent_commands",
    commands: [
      {
        name: "agents",
        display_name: "Manage native agents",
        description: "Native wizard",
        argument_hint: "",
        ui_action: "subagents",
      },
      {
        name: "list-agents",
        description: "Native list",
        argument_hint: "",
        ui_action: "subagents",
      },
      {
        name: "tasks",
        description: "Native tasks",
        argument_hint: "",
        ui_action: "subagents",
      },
      {
        name: "native-list",
        description: "Other adapter's native list",
        argument_hint: "",
        ui_action: "subagents",
      },
      { name: "compact", description: "压缩上下文", argument_hint: "" },
    ],
  });
  render(<Harness agent="another" />);
  type("/");
  await waitFor(() => expect(mocks.request).toHaveBeenCalled());
  await screen.findByRole("option", { name: /压缩上下文/ });
  expect(screen.getAllByRole("option")).toHaveLength(4);
  const subagentOption = screen.getByRole("option", { name: /子智能体/ });
  expect(
    subagentOption.querySelector(".composer-menu-option-primary")?.textContent,
  ).toBe("agents");
  expect(subagentOption.textContent).not.toContain("/agents");
  expect(
    screen.queryByRole("option", {
      name: /list-agents|Native wizard|Native list|Native tasks/,
    }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: /子智能体/ }));
  expect(mocks.openSubagents).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
  mocks.request.mockClear();
  fireEvent.click(screen.getByText("发送"));
  expect(mocks.openSubagents).toHaveBeenCalledOnce();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});

it("keeps local navigation available when native command discovery fails", async () => {
  mocks.request.mockRejectedValue(new Error("catalog unavailable"));
  render(<Harness agent="another" />);
  type("/");
  await screen.findByText(/catalog unavailable/);
  fireEvent.click(screen.getByRole("option", { name: /子智能体/ }));
  mocks.request.mockClear();
  fireEvent.click(screen.getByText("发送"));
  expect(mocks.openSubagents).toHaveBeenCalledOnce();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});

it.each(["/tmp/project/src", "/tmp", "/missing-project"])(
  "sends an OpenCode prompt starting with %s when command discovery is unavailable",
  async (path) => {
    mocks.request.mockRejectedValue(new Error("catalog unavailable"));
    render(<Harness agent="opencode" />);
    const prompt = `${path} 请检查这里`;
    type(prompt);
    fireEvent.click(screen.getByText("发送"));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith(prompt));
    expect(mocks.request).not.toHaveBeenCalled();
  },
);

it("submits a single-component OpenCode path with a project reference", async () => {
  render(<Harness agent="opencode" />);
  type("@READ");
  fireEvent.click(await screen.findByRole("option", { name: /README.md/ }));
  type("/tmp 请检查这里");
  fireEvent.click(screen.getByText("发送"));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      expect.stringMatching(/^\/tmp 请检查这里[\s\S]*README\.md/),
    ),
  );
});

it("does not submit an adapter-specific navigation command discovered from pasted text", async () => {
  mocks.request.mockResolvedValue({
    kind: "agent_commands",
    commands: [
      {
        name: "native-list",
        description: "",
        argument_hint: "",
        ui_action: "subagents",
      },
    ],
  });
  render(<Harness agent="another" />);
  type("/native-list ");
  fireEvent.click(screen.getByText("发送"));
  await waitFor(() => expect(mocks.openSubagents).toHaveBeenCalledOnce());
  expect(mocks.send).not.toHaveBeenCalled();
});

it("fences a late discovery of adapter-specific navigation after changing projects", async () => {
  let finish!: (value: unknown) => void;
  mocks.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<Harness />);
  type("/native-list ");
  fireEvent.click(screen.getByText("发送"));
  await waitFor(() => expect(mocks.request).toHaveBeenCalled());
  view.rerender(<Harness projectId="other" />);
  await act(async () =>
    finish({
      kind: "agent_commands",
      commands: [
        {
          name: "native-list",
          description: "",
          argument_hint: "",
          ui_action: "subagents",
        },
      ],
    }),
  );
  expect(mocks.openSubagents).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});

it.each([
  "/agents inspect",
  "/list-agents all",
  "/tasks 参数",
  "/agents\n请继续检查",
])(
  "never forwards navigation parameters in %s, and preserves the draft",
  async (command) => {
    render(<Harness agent="another" />);
    type(command);
    fireEvent.click(screen.getByText("发送"));
    expect(mocks.openSubagents).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(inputText()).toBe(command);
    expect(screen.getByText(/此命令不接受参数/)).toBeTruthy();
  },
);

it("prioritizes the exact native command over matches in other command descriptions", async () => {
  mocks.request.mockResolvedValue({
    kind: "agent_commands",
    commands: [
      { name: "batch", description: "Run many agents", argument_hint: "" },
      {
        name: "agents",
        description: "Manage agents",
        argument_hint: "",
        ui_action: "subagents",
      },
    ],
  });
  render(<Harness />);
  type("/agents");
  await screen.findAllByRole("option");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(inputText()).toBe("/agents ");
  expect(mocks.send).not.toHaveBeenCalled();
});

it.each(["/list-agents", "/agents", "/tasks", "/subagents"])(
  "routes %s directly to the local panel without discovery or submission",
  async (command) => {
    render(<Harness />);
    type(` ${command}  `);
    fireEvent.click(screen.getByText("发送"));
    expect(mocks.openSubagents).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  },
);

it("maps a typed native alias to the single local menu entry", async () => {
  mocks.request.mockResolvedValue({
    kind: "agent_commands",
    commands: [
      {
        name: "list-agents",
        description: "List agents",
        argument_hint: "",
        ui_action: "subagents",
      },
    ],
  });
  render(<Harness />);
  type("/list-ag");
  await screen.findByRole("option", { name: /子智能体/ });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(mocks.openSubagents).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
  mocks.request.mockClear();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(mocks.openSubagents).toHaveBeenCalledOnce();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
});

it("preserves attached references when a local panel command clears only its text", async () => {
  render(<Harness />);
  type("@README");
  fireEvent.click(await screen.findByRole("option", { name: /README.md/ }));
  type("/list-agents ");
  fireEvent.click(screen.getByText("发送"));
  expect(mocks.openSubagents).toHaveBeenCalledOnce();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "移除引用 README.md" }),
  ).toBeTruthy();
});

it.each(["model", "effort"] as const)(
  "routes /%s to App settings without discovery or submission",
  (target) => {
    render(<Harness agent="another" />);
    type(` /${target}  `);
    fireEvent.click(screen.getByText("发送"));
    expect(mocks.openModelSettings).toHaveBeenCalledWith(
      target,
      expect.any(Function),
    );
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  },
);

it.each(["/model opus", "/effort high", "/model\n检查项目"])(
  "never dispatches App command parameters in %s",
  (command) => {
    render(<Harness />);
    type(command);
    fireEvent.click(screen.getByText("发送"));
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(inputText()).toBe(command);
    expect(screen.getByText(/请在菜单中选择/)).toBeTruthy();
  },
);

it("preserves the draft when the App model settings are unavailable", () => {
  mocks.openModelSettings.mockReturnValue("当前 Agent 不支持调整思考强度。");
  render(<Harness />);
  type("/effort ");
  fireEvent.click(screen.getByText("发送"));
  expect(screen.getByText(/不支持调整思考强度/)).toBeTruthy();
  expect(inputText()).toBe("/effort ");
  expect(mocks.send).not.toHaveBeenCalled();
});

it("unifies native model and effort entries while retaining namespaced project commands", async () => {
  mocks.request.mockResolvedValue({
    kind: "agent_commands",
    commands: [
      { name: "model", description: "native model", argument_hint: "<id>" },
      {
        name: "effort",
        description: "native effort",
        argument_hint: "<level>",
      },
      {
        name: "project:model",
        description: "project model",
        argument_hint: "",
      },
    ],
  });
  render(<Harness />);
  type("/");
  await screen.findByRole("option", { name: /project model/ });
  expect(screen.getAllByRole("option")).toHaveLength(4);
  expect(
    screen.queryByRole("option", { name: /native model|native effort/ }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: /选择模型/ }));
  expect(mocks.openModelSettings).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(mocks.openModelSettings).toHaveBeenCalledWith(
    "model",
    expect.any(Function),
  );
  expect(mocks.send).not.toHaveBeenCalled();
});

it("opens App settings when command discovery fails and preserves references", async () => {
  render(<Harness />);
  type("@README");
  fireEvent.click(await screen.findByRole("option", { name: /README.md/ }));
  mocks.request.mockRejectedValue(new Error("catalog unavailable"));
  type("/effort");
  await screen.findByText(/catalog unavailable/);
  fireEvent.click(screen.getByRole("option", { name: /思考强度/ }));
  mocks.request.mockClear();
  fireEvent.click(screen.getByText("发送"));
  expect(mocks.openModelSettings).toHaveBeenCalledWith(
    "effort",
    expect.any(Function),
  );
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "移除引用 README.md" }),
  ).toBeTruthy();
});

it("opens an attached image without sending or removing the draft and restores its trigger on close", async () => {
  URL.createObjectURL = vi.fn(() => "blob:composer");
  URL.revokeObjectURL = vi.fn();
  mocks.request.mockResolvedValue({
    kind: "source_preview",
    mime_type: "image/png",
    data: [137, 80, 78, 71],
    size: 4,
    next: 4,
    has_more: false,
  });
  render(
    <Composer
      agent="claude"
      hostId="remote"
      projectId="p"
      connected
      disabled={false}
      sending={false}
      hidden={false}
      value="这张图呢"
      onChange={vi.fn()}
      onSubmit={mocks.send}
      placeholder="任务"
      toolbar={() => null}
      referenceState={{
        scope: "remote:p:claude",
        entries: [
          {
            name: "image.png",
            path: "/remote/image.png",
            directory: false,
            attachmentKind: "image",
          },
        ],
      }}
      onReferencesChange={vi.fn()}
    />,
  );
  const trigger = screen.getByRole("button", { name: "预览图片 image.png" });
  fireEvent.click(trigger);
  await screen.findByRole("img", { name: "image.png" });
  expect(mocks.request).toHaveBeenCalledWith(
    "remote",
    expect.objectContaining({
      method: "preview_source",
      project_id: "p",
      path: "/remote/image.png",
    }),
  );
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(document.activeElement).toBe(trigger);
  expect(
    (screen.getByRole("textbox", { name: "任务输入" }) as HTMLTextAreaElement)
      .value,
  ).toBe("这张图呢");
  expect(
    screen.getByRole("button", { name: "移除附件 /remote/image.png" }),
  ).toBeTruthy();
});

function chooseFiles(files: File[]) {
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /添加本机文件/ }));
  fireEvent.change(screen.getByLabelText("选择本机附件"), {
    target: { files },
  });
}
function dropData(files: File[], directory = false) {
  return {
    types: ["Files"],
    files,
    items: directory
      ? [{ webkitGetAsEntry: () => ({ isDirectory: true }) }]
      : [],
    dropEffect: "copy",
  };
}
it.each(["local", "ssh:devbox"])(
  "adds multiple local files to %s as attachments without workspace resolution or sending",
  async (hostId) => {
    pasteMocks.store.mockImplementation(async (file: File, host: string) => ({
      name: file.name,
      path: `/${host}/cache/${file.name}`,
      directory: false,
      attachmentKind: "file",
    }));
    render(<Harness hostId={hostId} />);
    type("draft");
    chooseFiles([new File(["a"], "a.txt"), new File(["b"], "b.pdf")]);
    await screen.findByText("b.pdf");
    expect(screen.getAllByText("附件")).toHaveLength(2);
    expect(pasteMocks.store).toHaveBeenCalledTimes(2);
    expect(
      pasteMocks.store.mock.calls.every((call) => call[1] === hostId),
    ).toBe(true);
    expect(pasteMocks.paths).not.toHaveBeenCalled();
    expect(mocks.choose).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("发送"));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(
      referenceMessage(mocks.send.mock.calls[0][0]).references.map(
        (item) => item.path,
      ),
    ).toEqual([`/${hostId}/cache/a.txt`, `/${hostId}/cache/b.pdf`]);
  },
);
it.each(["local", "ssh:devbox"])(
  "drops local files into %s and blocks sending until the batch finishes",
  async (hostId) => {
    let finish!: (value: unknown) => void;
    pasteMocks.store.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Harness hostId={hostId} />);
    type("keep draft");
    const composer = screen.getByRole("textbox").closest(".composer")!;
    const dataTransfer = dropData([new File(["a"], "a.txt")]);
    fireEvent.dragEnter(composer, { dataTransfer });
    expect(screen.getByText("松开以添加附件")).toBeTruthy();
    fireEvent.drop(composer, { dataTransfer });
    expect(screen.queryByText("松开以添加附件")).toBeNull();
    expect((screen.getByText("发送") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(mocks.send).not.toHaveBeenCalled();
    await act(async () =>
      finish({
        name: "a.txt",
        path: "/destination/a.txt",
        directory: false,
        attachmentKind: "file",
      }),
    );
    await screen.findByText("a.txt");
    expect((screen.getByText("发送") as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  },
);
it.each(["local", "ssh:devbox"])(
  "adds files dropped on the input field itself in %s",
  async (hostId) => {
    pasteMocks.store.mockImplementation(async (file: File, host: string) => ({
      name: file.name,
      path: `/${host}/cache/${file.name}`,
      directory: false,
      attachmentKind: "file",
    }));
    render(<Harness hostId={hostId} />);
    type("draft");
    const textarea = screen.getByRole("textbox");
    const dataTransfer = dropData([new File(["a"], "a.txt")]);
    fireEvent.dragEnter(textarea, { dataTransfer });
    // The drop must stay prevented even when it lands on the editable
    // field: WebKit otherwise inserts the file name as text.
    expect(fireEvent.dragOver(textarea, { dataTransfer })).toBe(false);
    expect(screen.getByText("松开以添加附件")).toBeTruthy();
    expect(fireEvent.drop(textarea, { dataTransfer })).toBe(false);
    await screen.findByText("a.txt");
    expect(pasteMocks.store).toHaveBeenCalledOnce();
  },
);
it("keeps failed file batches retryable and preserves the draft", async () => {
  pasteMocks.store
    .mockRejectedValueOnce(new Error("上传失败"))
    .mockResolvedValueOnce({
      name: "a.txt",
      path: "/cache/a.txt",
      directory: false,
      attachmentKind: "file",
    });
  render(<Harness />);
  type("keep draft");
  chooseFiles([new File(["a"], "a.txt")]);
  await screen.findByText(/上传失败/);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "keep draft",
  );
  expect((screen.getByText("发送") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "重试添加附件" }));
  await screen.findByText("a.txt");
  expect(pasteMocks.store).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("重试添加附件")).toBeNull();
  expect(mocks.send).not.toHaveBeenCalled();
});
it("discards a file selection and in-flight upload after switching conversations", async () => {
  const view = render(<Harness hostId="local" />);
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /添加本机文件/ }));
  view.rerender(<Harness hostId="remote" />);
  fireEvent.change(screen.getByLabelText("选择本机附件"), {
    target: { files: [new File(["a"], "old.txt")] },
  });
  expect(pasteMocks.store).not.toHaveBeenCalled();
  let finish!: (value: unknown) => void;
  pasteMocks.store.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  chooseFiles([new File(["a"], "a.txt")]);
  expect(pasteMocks.store).toHaveBeenCalledOnce();
  view.rerender(<Harness hostId="local" projectId="new" />);
  await act(async () =>
    finish({
      name: "a.txt",
      path: "/old/a.txt",
      directory: false,
      attachmentKind: "file",
    }),
  );
  expect(screen.queryByLabelText("已添加附件和引用")).toBeNull();
  expect(screen.queryByText("重试添加附件")).toBeNull();
});
it("rejects folders, oversized files and excessive batches before upload; ignores text drags", async () => {
  render(<Harness />);
  const composer = screen.getByRole("textbox").closest(".composer")!;
  fireEvent.drop(composer, { dataTransfer: dropData([], true) });
  await screen.findByText(/暂不支持上传文件夹/);
  fireEvent.dragEnter(composer, { dataTransfer: { types: ["text/plain"] } });
  expect(screen.queryByText("松开以添加附件")).toBeNull();
  const large = new File(["a"], "large.bin");
  Object.defineProperty(large, "size", { value: 64 * 1024 * 1024 + 1 });
  chooseFiles([large]);
  await screen.findByText(/64 MiB/);
  fireEvent.click(screen.getByRole("button", { name: "移除未添加附件" }));
  chooseFiles(
    Array.from({ length: 21 }, (_, i) => new File(["a"], `${i}.txt`)),
  );
  await screen.findByText(/最多添加 20/);
  expect(pasteMocks.store).not.toHaveBeenCalled();
});
it("supports keyboard navigation and Escape focus recovery in the add menu", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
  const first = screen.getByRole("menuitem", { name: /添加本机文件/ });
  const second = screen.getByRole("menuitem", { name: /引用工作区文件/ });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(second);
  fireEvent.keyDown(second, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("textbox"));
});
it("drops project-relative references while keeping absolute attachments when projectPath changes", async () => {
  const onReferencesChange = vi.fn();
  const initialReferences = {
    scope: "local:p:claude:/dir-a",
    entries: [
      {
        name: "old.ts",
        path: "src/old.ts",
        directory: false,
        inlineOffset: 0,
      },
      {
        name: "shot.png",
        path: "/tmp/paste/shot.png",
        directory: false,
        attachmentKind: "file" as const,
      },
    ],
  };
  const view = render(
    <Composer
      agent="claude"
      hostId="local"
      projectId="p"
      projectPath="/dir-a"
      connected
      disabled={false}
      sending={false}
      hidden={false}
      value="hello"
      onChange={vi.fn()}
      onSubmit={mocks.send}
      placeholder="任务"
      toolbar={() => null}
      referenceState={initialReferences}
      onReferencesChange={onReferencesChange}
    />,
  );
  expect(onReferencesChange).not.toHaveBeenCalled();

  view.rerender(
    <Composer
      agent="claude"
      hostId="local"
      projectId="p"
      projectPath="/dir-b"
      connected
      disabled={false}
      sending={false}
      hidden={false}
      value="hello"
      onChange={vi.fn()}
      onSubmit={mocks.send}
      placeholder="任务"
      toolbar={() => null}
      referenceState={initialReferences}
      onReferencesChange={onReferencesChange}
    />,
  );
  await waitFor(() =>
    expect(onReferencesChange).toHaveBeenCalledWith({
      scope: "local:p:claude:/dir-b",
      entries: [
        {
          name: "shot.png",
          path: "/tmp/paste/shot.png",
          directory: false,
          attachmentKind: "file",
        },
      ],
    }),
  );
});

it("renders ordered lists and 🌐 link pills in rich mode, auto-continues on Shift+Enter, and submits clean Markdown on Enter", async () => {
  mocks.send.mockResolvedValue(true);
  render(<Harness hostId="local" />);
  type("1. 22");
  const rich = await waitFor(() => {
    const el = screen.getByRole("textbox", { name: "任务输入" });
    expect(el.classList.contains("composer-rich-input")).toBe(true);
    return el;
  });
  expect(rich.querySelectorAll("ol > li")).toHaveLength(1);

  fireEvent.keyDown(rich, { key: "Enter", shiftKey: true });
  await waitFor(() => expect(rich.querySelectorAll("ol > li")).toHaveLength(2));

  fireEvent.paste(rich, {
    clipboardData: {
      files: [],
      types: ["text/plain", "text/html"],
      getData: (mime: string) =>
        mime === "text/html"
          ? 'ddd <a href="https://example.com/docs">文档</a>'
          : "ddd 文档",
    },
  });

  await waitFor(() => {
    const pill = rich.querySelector<HTMLElement>(".composer-link-pill");
    expect(pill).not.toBeNull();
    expect(pill?.dataset.linkHref).toBe("https://example.com/docs");
    expect(pill?.textContent).toBe("文档");
  });

  fireEvent.keyDown(rich, { key: "Enter" });
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "1. 22\n2. ddd [文档](https://example.com/docs)",
    ),
  );
});

it("wraps selected text in textarea into a 🌐 link pill when pasting a URL", async () => {
  mocks.send.mockResolvedValue(true);
  render(<Harness hostId="local" />);
  type("请查看 文档 说明");
  const textarea = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "任务输入",
  });
  const start = "请查看 ".length;
  textarea.setSelectionRange(start, start + "文档".length);
  fireEvent.paste(textarea, {
    clipboardData: {
      files: [],
      types: ["text/plain"],
      getData: (mime: string) =>
        mime === "text/plain" ? "https://example.com/guide" : "",
    },
  });

  const rich = await waitFor(() => {
    const el = screen.getByRole("textbox", { name: "任务输入" });
    expect(el.classList.contains("composer-rich-input")).toBe(true);
    return el;
  });
  const pill = rich.querySelector<HTMLElement>(".composer-link-pill");
  expect(pill?.dataset.linkHref).toBe("https://example.com/guide");
  expect(pill?.textContent).toBe("文档");

  fireEvent.keyDown(rich, { key: "Enter" });
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "请查看 [文档](https://example.com/guide) 说明",
    ),
  );
});

it("renders pasted HTML tables inside the composer and submits GFM Markdown", async () => {
  mocks.send.mockResolvedValue(true);
  render(<Harness hostId="local" />);
  const initial = screen.getByRole("textbox", { name: "任务输入" });
  fireEvent.paste(initial, {
    clipboardData: {
      files: [],
      types: ["text/plain", "text/html"],
      getData: (mime: string) =>
        mime === "text/html"
          ? "<table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table>"
          : "列A\t列B\n1\t2",
    },
  });

  const rich = await waitFor(() => {
    const el = screen.getByRole("textbox", { name: "任务输入" });
    expect(el.querySelector("table")).not.toBeNull();
    return el;
  });
  expect(rich.querySelectorAll("th")).toHaveLength(2);
  expect(rich.querySelectorAll("td")).toHaveLength(2);

  fireEvent.keyDown(rich, { key: "Enter" });
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "| 列A | 列B |\n| --- | --- |\n| 1 | 2 |",
    ),
  );
});

it("renders fenced code blocks with language badge, keeps Shift+Enter as newline, and submits on Enter", async () => {
  mocks.send.mockResolvedValue(true);
  render(<Harness hostId="local" />);
  type("```ts\nconst a = 1;");
  const codeEditor = await waitFor(() => {
    const el = screen.getByRole("textbox", { name: "任务输入" });
    expect(el.querySelector("pre.composer-md-codeblock")).not.toBeNull();
    return el;
  });
  expect(
    codeEditor
      .querySelector("pre.composer-md-codeblock")
      ?.getAttribute("data-language"),
  ).toBe("ts");
  fireEvent.keyDown(codeEditor, { key: "Enter", shiftKey: true });
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.keyDown(codeEditor, { key: "Enter" });
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith("```ts\nconst a = 1;\n\n```"),
  );
});

it("preserves inline @file reference chips alongside rich Markdown lists", async () => {
  mocks.send.mockResolvedValue(true);
  render(<Harness hostId="remote" />);
  type("1. 检查 @READ");
  fireEvent.click(await screen.findByRole("option", { name: /README\.md/ }));
  const rich = screen.getByRole("textbox", { name: "任务输入" });
  expect(rich.classList.contains("composer-rich-input")).toBe(true);
  expect(rich.querySelector('[data-reference-path="README.md"]')).toBeTruthy();
  expect(rich.querySelectorAll("ol > li")).toHaveLength(1);

  fireEvent.keyDown(rich, { key: "Enter" });
  await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
  expect(referenceMessage(mocks.send.mock.calls[0][0])).toMatchObject({
    text: "1. 检查",
    references: [expect.objectContaining({ path: "README.md" })],
  });
});

it("uses Tab to drill into directory subpaths and complete files, while Enter directly selects directories or files", async () => {
  const { unmount } = render(<Harness hostId="local" />);
  type("@s");
  await screen.findByRole("option", { name: /^src/ });
  // Tab on a directory completes `@src/` and drills into its children without attaching yet
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab" });
  expect(
    (screen.getByRole("textbox", { name: "任务输入" }) as HTMLTextAreaElement)
      .value,
  ).toBe("@src/");
  expect(screen.queryByRole("button", { name: "移除引用 src" })).toBeNull();
  await screen.findByRole("option", { name: /中文 file\.ts/ });
  // Tab on a file completes and attaches that file
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab" });
  expect(
    screen.getByRole("button", { name: "移除引用 src/中文 file.ts" }),
  ).toBeTruthy();
  unmount();

  // Enter on a directory directly selects and attaches the directory
  render(<Harness hostId="local" />);
  type("@s");
  await screen.findByRole("option", { name: /^src/ });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(screen.getByRole("button", { name: "移除引用 src" })).toBeTruthy();
});

it.each([
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["traex", "Traex"],
  ["opencode", "OpenCode"],
  ["cursor", "Cursor Agent"],
])(
  "renders unified commands and skills menu for %s (%s) with skill badges",
  async (agent) => {
    mocks.request.mockImplementation(async (_host, req) =>
      req.method === "agent_commands"
        ? {
            kind: "agent_commands",
            commands: [
              {
                name: "compact",
                description: "压缩会话上下文",
                argument_hint: "",
                kind: "command",
              },
              {
                name: "review",
                description: "审查当前改动",
                argument_hint: "[说明]",
                kind: "command",
              },
              {
                name: "fix-ci",
                display_name: "修复 CI",
                description: "诊断并修复流水线失败",
                argument_hint: "[任务说明]",
                kind: "skill",
              },
            ],
          }
        : { kind: "files", entries: [] },
    );
    render(<Harness agent={agent} />);
    type("/");
    await screen.findByRole("option", { name: /修复 CI/ });
    const compactOption = screen.getByRole("option", { name: /压缩上下文/ });
    expect(
      compactOption.querySelector(".composer-menu-option-primary")?.textContent,
    ).toBe("compact");
    expect(compactOption.textContent).not.toContain("/compact");
    expect(screen.getByRole("option", { name: /代码审查/ })).toBeTruthy();
    const skillOption = screen.getByRole("option", { name: /修复 CI/ });
    expect(
      skillOption.querySelector(".composer-menu-option-primary")?.textContent,
    ).toBe("fix-ci");
    expect(skillOption.textContent).not.toContain("/fix-ci");
    expect(
      skillOption.querySelector(".composer-command-badge")?.textContent,
    ).toBe("技能");
    expect(mocks.request).toHaveBeenCalledWith("remote", {
      method: "agent_commands",
      project_id: "p",
      agent,
    });
  },
);

it("composes skills with @ references, quotes, and annotations while keeping control commands guarded", async () => {
  mocks.request.mockImplementation(async (_host, req) =>
    req.method === "agent_commands"
      ? {
          kind: "agent_commands",
          commands: [
            {
              name: "compact",
              description: "压缩会话上下文",
              argument_hint: "",
              kind: "command",
            },
            {
              name: "fix-ci",
              display_name: "修复 CI",
              description: "诊断并修复流水线失败",
              argument_hint: "[任务说明]",
              kind: "skill",
            },
          ],
        }
      : {
          kind: "files",
          entries: [{ name: "README.md", path: "README.md", directory: false }],
        },
  );
  mocks.send.mockResolvedValue(true);
  render(
    <Harness
      agent="codex"
      quotes={["请同步修复快照断言"]}
      annotations={[
        {
          id: "a1",
          quote: "expect(status).toBe(200)",
          comment: "补充失败分支检查",
          source: { message: 1, start: 0, end: 24 },
        },
      ]}
    />,
  );
  type("/fix");
  fireEvent.click(await screen.findByRole("option", { name: /修复 CI/ }));
  expect(inputText()).toBe("/fix-ci ");

  type("/fix-ci 检查 @READ");
  fireEvent.click(await screen.findByRole("option", { name: /README\.md/ }));
  fireEvent.click(screen.getByText("发送"));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
  const submitted = mocks.send.mock.calls[0][0] as string;
  expect(submitted.startsWith("/fix-ci ")).toBe(true);
  expect(submitted).toContain("README.md");
  expect(submitted).toContain("请同步修复快照断言");
  expect(submitted).toContain("补充失败分支检查");

  // Control commands (kind !== "skill") still reject mixing references/quotes/annotations.
  type("/compact ");
  fireEvent.click(screen.getByText("发送"));
  expect(
    await screen.findByText(/请先移除引用的文本片段，再使用 Agent 原生命令/),
  ).toBeTruthy();
  expect(mocks.send).toHaveBeenCalledOnce();
});

it("permits a catalog skill named init with @ references, quotes, and annotations", async () => {
  mocks.request.mockImplementation(async (_host, req) =>
    req.method === "agent_commands"
      ? {
          kind: "agent_commands",
          commands: [
            {
              name: "compact",
              description: "压缩会话上下文",
              argument_hint: "",
              kind: "command",
            },
            {
              name: "init",
              display_name: "初始化项目技能",
              description: "按团队规范初始化配置",
              argument_hint: "[任务说明]",
              kind: "skill",
            },
          ],
        }
      : {
          kind: "files",
          entries: [{ name: "README.md", path: "README.md", directory: false }],
        },
  );
  mocks.send.mockResolvedValue(true);
  const view = render(
    <Harness
      agent="codex"
      quotes={["请同步修复快照断言"]}
      annotations={[
        {
          id: "a1",
          quote: "expect(status).toBe(200)",
          comment: "补充失败分支检查",
          source: { message: 1, start: 0, end: 24 },
        },
      ]}
    />,
  );
  // Submitting `/init` directly with quotes before opening `/` menu fetches catalog and permits skill.
  type("/init 直接提交");
  fireEvent.click(screen.getByText("发送"));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  expect(mocks.send.mock.calls[0][0] as string).toContain("/init 直接提交");
  expect(mocks.send.mock.calls[0][0] as string).toContain("请同步修复快照断言");

  // Also works after opening `/` menu and attaching an `@` file reference.
  type("/ini");
  fireEvent.click(
    await screen.findByRole("option", { name: /初始化项目技能/ }),
  );
  expect(inputText()).toBe("/init ");
  type("/init 检查 @READ");
  fireEvent.click(await screen.findByRole("option", { name: /README\.md/ }));
  fireEvent.click(screen.getByText("发送"));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
  const submitted = mocks.send.mock.calls[1][0] as string;
  expect(submitted.startsWith("/init ")).toBe(true);
  expect(submitted).toContain("README.md");
  expect(submitted).toContain("补充失败分支检查");
  view.unmount();
});

it("renders selected skills and commands as inline icon pills without leading slash and supports multiple tokens", async () => {
  mocks.request.mockImplementation(async (_host, req) =>
    req.method === "agent_commands"
      ? {
          kind: "agent_commands",
          commands: [
            {
              name: "doc-coauthoring",
              display_name: "Doc Coauthoring",
              description: "Guide users through co-authoring documentation",
              argument_hint: "",
              kind: "skill",
            },
            {
              name: "fix-ci",
              display_name: "修复 CI",
              description: "诊断并修复流水线失败",
              argument_hint: "",
              kind: "skill",
            },
          ],
        }
      : { kind: "files", entries: [] },
  );
  mocks.send.mockResolvedValue(true);
  render(<Harness agent="codex" />);
  type("/doc");
  fireEvent.click(
    await screen.findByRole("option", { name: /Doc Coauthoring/ }),
  );
  const rich = screen.getByRole("textbox", { name: "任务输入" });
  expect(rich.classList.contains("composer-rich-input")).toBe(true);
  const firstPill = rich.querySelector<HTMLElement>(
    '.composer-command-pill[data-command-name="doc-coauthoring"]',
  );
  expect(firstPill).not.toBeNull();
  expect(firstPill?.dataset.commandIcon).toBe("skill");
  expect(firstPill?.textContent).toBe("doc-coauthoring");
  expect(firstPill?.querySelector("svg")).not.toBeNull();

  // Select a second skill inline alongside the first pill
  fireEvent.paste(rich, {
    clipboardData: {
      files: [],
      types: ["text/plain"],
      getData: (mime: string) => (mime === "text/plain" ? "/fix" : ""),
    },
  });
  await waitFor(() => expect(inputText()).toBe("/doc-coauthoring /fix"));
  rich.click();
  type("/doc-coauthoring /fix");
  fireEvent.click(await screen.findByRole("option", { name: /修复 CI/ }));
  const pills = Array.from(
    screen
      .getByRole("textbox")
      .querySelectorAll<HTMLElement>(".composer-command-pill"),
  );
  expect(pills.map((p) => p.textContent)).toEqual([
    "doc-coauthoring",
    "fix-ci",
  ]);
  fireEvent.click(screen.getByText("发送"));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith("/doc-coauthoring /fix-ci"),
  );
});

it("converts character-by-character typed commands in rich input into inline pills upon completion", async () => {
  mocks.request.mockImplementation(async (_host, req) =>
    req.method === "agent_commands"
      ? {
          kind: "agent_commands",
          commands: [
            {
              name: "doc-coauthoring",
              display_name: "Doc Coauthoring",
              description: "Guide users through co-authoring documentation",
              argument_hint: "",
              kind: "skill",
            },
            {
              name: "fix-ci",
              display_name: "修复 CI",
              description: "诊断并修复流水线失败",
              argument_hint: "",
              kind: "skill",
            },
          ],
        }
      : { kind: "files", entries: [] },
  );
  mocks.send.mockResolvedValue(true);
  render(<Harness agent="codex" />);

  // Enter rich mode via a first command pill (`/doc-coauthoring `)
  type("/doc");
  fireEvent.click(
    await screen.findByRole("option", { name: /Doc Coauthoring/ }),
  );
  const rich = screen.getByRole("textbox", { name: "任务输入" });
  expect(rich.classList.contains("composer-rich-input")).toBe(true);

  const pmView = (
    rich as unknown as {
      editor: {
        view: {
          state: { tr: { insertText: (text: string) => unknown } };
          dispatch: (tr: unknown) => void;
        };
      };
    }
  ).editor.view;

  // Type `/fix-ci` character-by-character inside `ComposerRichInput`: while the
  // slash trigger is still active (no trailing space yet), `/fix-ci` stays plain text.
  for (const ch of "/fix-ci") {
    act(() => {
      pmView.dispatch(pmView.state.tr.insertText(ch));
    });
  }
  expect(
    Array.from(rich.querySelectorAll(".composer-command-pill")).map(
      (el) => el.textContent,
    ),
  ).toEqual(["doc-coauthoring"]);
  expect(rich.querySelector(".composer-command-pill svg")).not.toBeNull();
  expect(await screen.findByRole("option", { name: /修复 CI/ })).toBeTruthy();

  // Completing the command with a space immediately converts `/fix-ci` into a pill
  // on the same live rich-editor instance and keeps the caret positioned after the space.
  expect(screen.getByRole("textbox", { name: "任务输入" })).toBe(rich);
  act(() => {
    pmView.dispatch(pmView.state.tr.insertText(" "));
  });
  await waitFor(() =>
    expect(
      Array.from(rich.querySelectorAll(".composer-command-pill")).map(
        (el) => el.textContent,
      ),
    ).toEqual(["doc-coauthoring", "fix-ci"]),
  );

  for (const ch of "检查构建") {
    act(() => {
      pmView.dispatch(pmView.state.tr.insertText(ch));
    });
  }
  expect(
    Array.from(rich.querySelectorAll(".composer-command-pill")).every(
      (el) => el.querySelector("svg") !== null,
    ),
  ).toBe(true);
  fireEvent.click(screen.getByText("发送"));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "/doc-coauthoring /fix-ci 检查构建",
    ),
  );
});

it("preserves leading slash when copying and pasting formatted skill instructions", async () => {
  const { DOMSerializer } = await import("@tiptap/pm/model");
  mocks.request.mockImplementation(async (_host, req) =>
    req.method === "agent_commands"
      ? {
          kind: "agent_commands",
          commands: [
            {
              name: "doc-coauthoring",
              display_name: "Doc Coauthoring",
              description: "Guide users through co-authoring documentation",
              argument_hint: "",
              kind: "skill",
            },
          ],
        }
      : { kind: "files", entries: [] },
  );
  mocks.send.mockResolvedValue(true);
  const first = render(<Harness agent="codex" />);
  type("1. /doc");
  fireEvent.click(
    await screen.findByRole("option", { name: /Doc Coauthoring/ }),
  );
  const rich = screen.getByRole("textbox", { name: "任务输入" });
  const pmEditor = (
    rich as unknown as {
      editor: {
        schema: Parameters<typeof DOMSerializer.fromSchema>[0];
        state: {
          doc: { content: unknown };
          tr: { insertText: (text: string) => unknown };
        };
        view: { dispatch: (tr: unknown) => void };
      };
    }
  ).editor;
  act(() => {
    pmEditor.view.dispatch(pmEditor.state.tr.insertText("整理大纲"));
  });

  // 1. ProseMirror clipboard HTML serializer (`CommandPill.renderHTML`) keeps `/doc-coauthoring`
  const fragment = DOMSerializer.fromSchema(pmEditor.schema).serializeFragment(
    pmEditor.state.doc.content as never,
  );
  const wrap = document.createElement("div");
  wrap.append(fragment);
  const copiedHtml = wrap.innerHTML;
  expect(copiedHtml).toContain(">/doc-coauthoring</span>");

  // Also capture the live NodeView DOM (where label text has no leading `/`)
  const liveDomHtml = rich.innerHTML;
  first.unmount();

  // 2. Pasting copied ProseMirror HTML into a fresh composer preserves `/doc-coauthoring`
  const second = render(<Harness agent="codex" />);
  const target = screen.getByRole("textbox", { name: "任务输入" });
  fireEvent.paste(target, {
    clipboardData: {
      files: [],
      types: ["text/plain", "text/html"],
      getData: (mime: string) =>
        mime === "text/html" ? copiedHtml : "1. doc-coauthoring 整理大纲",
    },
  });
  await waitFor(() => {
    expect(
      screen.getByRole("textbox").querySelectorAll("ol > li"),
    ).toHaveLength(1);
    expect(inputText()).toBe("/doc-coauthoring 整理大纲");
  });
  fireEvent.click(screen.getByText("发送"));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith("1. /doc-coauthoring 整理大纲"),
  );
  second.unmount();

  // 3. Pasting raw NodeView DOM HTML (`<span data-command-name="doc-coauthoring"><svg/><span>doc-coauthoring</span></span>`)
  // also preserves `/doc-coauthoring` without dropping or doubling the slash.
  mocks.send.mockClear();
  render(<Harness agent="codex" />);
  fireEvent.paste(screen.getByRole("textbox", { name: "任务输入" }), {
    clipboardData: {
      files: [],
      types: ["text/plain", "text/html"],
      getData: (mime: string) =>
        mime === "text/html" ? liveDomHtml : "1. doc-coauthoring 整理大纲",
    },
  });
  await waitFor(() => {
    expect(
      screen.getByRole("textbox").querySelectorAll("ol > li"),
    ).toHaveLength(1);
    expect(inputText()).toBe("/doc-coauthoring 整理大纲");
  });
  fireEvent.click(screen.getByText("发送"));
  await waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith("1. /doc-coauthoring 整理大纲"),
  );
});
