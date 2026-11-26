import { describe, expect, it } from "vitest";
import type { Event, EventKind } from "./protocol";
import {
  activityTranscript,
  diffStringLines,
  toolDisplayParts,
  toolGroupLabel,
  toolInputDiffStat,
  toolLabel,
  type ToolActivity,
} from "./activity";
const e = (seq: number, event: EventKind): Event => ({
  seq,
  event,
  at: seq,
  session_id: "s",
});
const call = (seq: number, id: string, name = "Read") =>
  e(seq, { kind: "tool", id, name, input: { file_path: `/repo/${id}.ts` } });
const result = (seq: number, id: string, is_error = false) =>
  e(seq, { kind: "tool_result", id, content: `${id} output`, is_error });
describe("readable activity projection", () => {
  it("carries load-full identity only on previewed tool results", () => {
    const rows = activityTranscript([
      call(1, "a"),
      { ...result(2, "a"), content_size: 679_286 },
      { ...result(3, "orphan"), content_size: 512 * 1024 + 1 },
      result(4, "whole"),
    ]);
    expect(rows).toHaveLength(1);
    const group = rows[0] as { type: "tools"; tools: ToolActivity[] };
    expect(group.tools).toMatchObject([
      {
        type: "tool",
        name: "Read",
        output: "a output",
        load: { seq: 2, size: 679_286 },
      },
      {
        type: "tool",
        name: "工具输出",
        load: { seq: 3, size: 512 * 1024 + 1 },
      },
      { type: "tool", name: "工具输出", output: "whole output" },
    ]);
    expect(group.tools[2].load).toBeUndefined();
  });
  it("keeps an in-flight tool paired across a queued input handoff", () => {
    const rows = activityTranscript([
      call(1, "a"),
      e(2, {
        kind: "queued_message_sent",
        request_id: "queued",
        text: "follow up",
      }),
      result(3, "a"),
    ]);
    expect(rows).toMatchObject([
      { type: "tool", name: "Read", output: "a output", status: "completed" },
      { type: "user", text: "follow up", handoff: true },
    ]);
  });
  it("pairs parallel results by ID and compacts consecutive operations", () => {
    expect(
      activityTranscript([
        call(1, "a"),
        call(2, "b"),
        result(3, "b"),
        result(4, "a"),
      ]),
    ).toMatchObject([
      {
        type: "tools",
        tools: [
          { key: 1, output: "a output", status: "completed" },
          { key: 2, output: "b output", status: "completed" },
        ],
      },
    ]);
  });
  it("retains commentary between operations even when a result arrives later", () => {
    expect(
      activityTranscript([
        call(1, "a"),
        e(2, { kind: "text", text: "正在检查" }),
        result(3, "a"),
        call(4, "b"),
      ]).map((i) => i.type),
    ).toEqual(["tool", "assistant", "tool"]);
  });
  it("folds tool failures into phase groups while keeping approvals at top level and marking unrecovered tail failures", () => {
    expect(
      activityTranscript([
        call(1, "a"),
        call(2, "b"),
        result(3, "a"),
        result(4, "b", true),
        e(5, { kind: "approval", request_id: "r", tool: "Bash", input: {} }),
        call(6, "c"),
      ]),
    ).toMatchObject([
      {
        type: "tools",
        tools: [
          { type: "tool", status: "completed" },
          { type: "tool", status: "failed" },
        ],
      },
      { type: "event", value: { kind: "approval" } },
      { type: "tool", status: "pending" },
    ]);

    // Self-healed intermediate failure: unrecovered stays undefined
    const selfHealed = activityTranscript([
      call(1, "a"),
      result(2, "a", true),
      call(3, "b"),
      result(4, "b", false),
      e(5, { kind: "state", status: "completed", message: null }),
    ]);
    expect(selfHealed).toMatchObject([
      {
        type: "tools",
        tools: [{ status: "failed" }, { status: "completed" }],
      },
    ]);
    expect(
      (selfHealed[0] as { unrecovered?: boolean }).unrecovered,
    ).toBeUndefined();

    // Turn halted directly on a trailing failed tool: unrecovered is true
    const haltedTail = activityTranscript([
      call(1, "a"),
      result(2, "a", false),
      call(3, "b"),
      result(4, "b", true),
      e(5, { kind: "state", status: "failed", message: "命令失败" }),
    ]);
    expect(haltedTail).toMatchObject([
      {
        type: "tools",
        unrecovered: true,
        tools: [{ status: "completed" }, { status: "failed" }],
      },
      { type: "event", value: { kind: "state", status: "failed" } },
    ]);
  });
  it("keeps unmatched results rather than attaching them to an unrelated call", () => {
    expect(
      activityTranscript([call(1, "a"), result(2, "other")]),
    ).toMatchObject([
      {
        type: "tools",
        tools: [
          { status: "pending" },
          { name: "工具输出", output: "other output" },
        ],
      },
    ]);
  });
  it("does not pair reused IDs across turns", () => {
    expect(
      activityTranscript([
        call(1, "a"),
        e(2, { kind: "user", text: "next", request_id: "next" }),
        result(3, "a"),
      ]),
    ).toMatchObject([
      { type: "tool", status: "unconfirmed" },
      { type: "user" },
      { type: "tool", name: "工具输出" },
    ]);
  });
  it("marks missing results unconfirmed on terminal states, including states without text", () => {
    for (const status of [
      "completed",
      "failed",
      "unknown",
      "stopped",
    ] as const) {
      expect(
        activityTranscript([
          call(1, "a"),
          e(2, { kind: "state", status, message: null }),
        ]),
      ).toMatchObject([{ type: "tool", status: "unconfirmed" }]);
    }
    expect(
      activityTranscript([
        call(1, "a"),
        e(2, { kind: "state", status: "waiting", message: null }),
      ]),
    ).toMatchObject([{ status: "pending" }]);
  });
  it("does not leave a prior interrupted operation running when the next turn starts", () => {
    expect(
      activityTranscript([
        call(1, "a"),
        e(2, { kind: "state", status: "unknown", message: null }),
        e(3, { kind: "user", text: "next", request_id: "r" }),
        call(4, "b"),
      ]),
    ).toMatchObject([
      { status: "unconfirmed" },
      { type: "user" },
      { status: "pending" },
    ]);
  });
  it("labels actions from structured inputs with a safe fallback for unknown tools", () => {
    expect(
      toolLabel({
        key: 1,
        type: "tool",
        name: "Read",
        input: { file_path: "/repo/main.ts" },
        status: "completed",
      }),
    ).toBe("读取 /repo/main.ts");
    expect(
      toolLabel({
        key: 1,
        type: "tool",
        name: "Bash",
        input: { description: "检查构建结果", command: "npm test" },
        status: "completed",
      }),
    ).toBe("检查构建结果");
    expect(
      toolLabel({
        key: 1,
        type: "tool",
        name: "future_agent_tool",
        input: null,
        status: "completed",
      }),
    ).toBe("future_agent_tool");
  });

  it("summarizes tool groups as natural verb phrases and extracts two-tone parts", () => {
    const tools: ToolActivity[] = [
      {
        key: 1,
        type: "tool",
        name: "Read",
        input: { file_path: "/repo/a.ts" },
        status: "completed",
      },
      {
        key: 2,
        type: "tool",
        name: "Edit",
        input: {
          file_path: "/repo/src/b.ts",
          old_string: "const a = 1;",
          new_string: "const a = 2;\nconst b = 3;",
        },
        status: "completed",
      },
      {
        key: 3,
        type: "tool",
        name: "Bash",
        input: { command: "npm test", description: "运行单元测试" },
        status: "completed",
      },
    ];
    expect(toolGroupLabel(tools)).toBe("探索了文件、编辑了文件并运行了命令");
    expect(toolGroupLabel([tools[0], { ...tools[2], status: "pending" }])).toBe(
      "正在探索文件并运行命令",
    );
    expect(toolGroupLabel([tools[0], { ...tools[2], status: "failed" }])).toBe(
      "探索了 1 个文件",
    );
    expect(
      toolGroupLabel([
        { ...tools[0], status: "failed" },
        { ...tools[0], key: 99, status: "failed" },
      ]),
    ).toBe("尝试读取 2 次未通过");
    expect(toolDisplayParts(tools[1])).toEqual({
      verb: "已编辑",
      target: "…/src/b.ts",
      monoTarget: true,
      diff: { added: 2, removed: 1 },
    });
  });

  it("uses neutral call counts for unconfirmed tools without asserting file edits, and trims unchanged context in Edit diff stats", () => {
    const rows = activityTranscript([
      e(1, {
        kind: "tool",
        id: "w1",
        name: "Write",
        input: { file_path: "/repo/a.ts", content: "export const a = 1;\n" },
      }),
      e(2, {
        kind: "tool",
        id: "w2",
        name: "Write",
        input: { file_path: "/repo/b.ts", content: "export const b = 2;\n" },
      }),
      e(3, { kind: "state", status: "unknown", message: null }),
    ]);
    expect(rows).toHaveLength(1);
    const group = rows[0] as { type: "tools"; tools: ToolActivity[] };
    expect(group.tools.map((t) => t.status)).toEqual([
      "unconfirmed",
      "unconfirmed",
    ]);
    const label = toolGroupLabel(group.tools);
    expect(label).toBe("发起写入 2 次");
    expect(label).not.toContain("编辑了");

    expect(
      toolGroupLabel([
        {
          key: 10,
          type: "tool",
          name: "Read",
          input: { file_path: "/repo/readme.md" },
          status: "completed",
        },
        ...group.tools,
      ]),
    ).toBe("探索了 1 个文件 · 另有写入 2 次待确认");

    const beforeLines = Array.from({ length: 101 }, (_, i) => `line-${i + 1}`);
    const afterLines = [...beforeLines];
    afterLines[50] = "line-51-modified";
    expect(
      toolInputDiffStat({
        key: 20,
        type: "tool",
        name: "Edit",
        input: {
          file_path: "/repo/large.ts",
          old_string: beforeLines.join("\n"),
          new_string: afterLines.join("\n"),
        },
        status: "completed",
      }),
    ).toEqual({ added: 1, removed: 1 });

    const twoHunkAfter = [...beforeLines];
    twoHunkAfter[1] = "line-2-modified";
    twoHunkAfter[99] = "line-100-modified";
    expect(
      toolInputDiffStat({
        key: 21,
        type: "tool",
        name: "Edit",
        input: {
          file_path: "/repo/two-hunks.ts",
          old_string: beforeLines.join("\n"),
          new_string: twoHunkAfter.join("\n"),
        },
        status: "completed",
      }),
    ).toEqual({ added: 2, removed: 2 });

    // 511 lines inserted at top + 900 kept middle lines + 1 replaced tail line (D = 513 > 512)
    const keptUnique = Array.from({ length: 900 }, (_, i) => `keep-${i + 1}`);
    const inserted511 = Array.from({ length: 511 }, (_, i) => `ins-${i + 1}`);
    const old513 = [...keptUnique, "tail-old"].join("\n");
    const new513 = [...inserted511, ...keptUnique, "tail-new"].join("\n");
    const anchored = diffStringLines(old513, new513);
    expect(anchored.approximate).toBe(false);
    expect({ added: anchored.added, removed: anchored.removed }).toEqual({
      added: 512,
      removed: 1,
    });
    expect(anchored.ops[0]).toEqual({
      kind: "add",
      lineNo: 1,
      text: "ins-1",
    });

    // Same 511 + 900 + 1 structure even when all 900 kept lines are identical
    const keptRepeated = Array.from({ length: 900 }, () => "  return value;");
    expect(
      toolInputDiffStat({
        key: 22,
        type: "tool",
        name: "Edit",
        input: {
          file_path: "/repo/repeated-keep.ts",
          old_string: [...keptRepeated, "tail-old"].join("\n"),
          new_string: [...inserted511, ...keptRepeated, "tail-new"].join("\n"),
        },
        status: "completed",
      }),
    ).toEqual({ added: 512, removed: 1 });

    // Moving 1 unique comment line across 300 kept lines (both repeated and unique) must report +1/-1, never +300/-300
    const body300Repeated = Array.from(
      { length: 300 },
      (_, i) => `  item: ${i % 10},`,
    );
    expect(
      toolInputDiffStat({
        key: 24,
        type: "tool",
        name: "Edit",
        input: {
          file_path: "/repo/moved-comment-repeated.ts",
          old_string: ["// moved header comment", ...body300Repeated].join(
            "\n",
          ),
          new_string: [...body300Repeated, "// moved header comment"].join(
            "\n",
          ),
        },
        status: "completed",
      }),
    ).toEqual({ added: 1, removed: 1 });

    const body300Unique = Array.from(
      { length: 300 },
      (_, i) => `export const val${i} = ${i};`,
    );
    expect(
      toolInputDiffStat({
        key: 25,
        type: "tool",
        name: "Edit",
        input: {
          file_path: "/repo/moved-comment-unique.ts",
          old_string: ["// moved header comment", ...body300Unique].join("\n"),
          new_string: [...body300Unique, "// moved header comment"].join("\n"),
        },
        status: "completed",
      }),
    ).toEqual({ added: 1, removed: 1 });

    // Even when >512 insertions combine with a moved unique comment across 900 repeated lines,
    // the 900-line contiguous block wins over the 1-line moved anchor (+516/-1)
    const inserted515 = Array.from({ length: 515 }, (_, i) => `hdr-${i + 1}`);
    expect(
      toolInputDiffStat({
        key: 26,
        type: "tool",
        name: "Edit",
        input: {
          file_path: "/repo/combined-move-and-insert.ts",
          old_string: ["// lone-moved-comment", ...keptRepeated].join("\n"),
          new_string: [
            ...inserted515,
            ...keptRepeated,
            "// lone-moved-comment",
          ].join("\n"),
        },
        status: "completed",
      }),
    ).toEqual({ added: 516, removed: 1 });

    // Unanchored >512-step edit marks approximate=true and suppresses exact diff badge
    const unanchoredOld: string[] = [];
    const unanchoredNew: string[] = [];
    for (let i = 0; i < 300; i++) {
      unanchoredOld.push("}", `old-stmt-${i}`);
      unanchoredNew.push("}", `new-stmt-${i}`);
    }
    const simplifiedTool: ToolActivity = {
      key: 23,
      type: "tool",
      name: "Edit",
      input: {
        file_path: "/repo/chaotic.ts",
        old_string: unanchoredOld.join("\n"),
        new_string: unanchoredNew.join("\n"),
      },
      status: "completed",
    };
    const simplifiedStat = toolInputDiffStat(simplifiedTool);
    expect(simplifiedStat?.approximate).toBe(true);
    const simplifiedParts = toolDisplayParts(simplifiedTool);
    expect(simplifiedParts.diff).toBeUndefined();
    expect(simplifiedParts.diffSimplified).toBe(true);
  });
});
it("keeps parallel approval decisions bound to explicit tool IDs", () => {
  const approval = e(3, {
    kind: "approval",
    request_id: "approval",
    tool_use_id: "b",
    tool: "Read",
    input: {},
  });
  expect(
    activityTranscript([call(1, "a"), call(2, "b"), approval]),
  ).toMatchObject([
    { type: "tool", status: "pending" },
    { type: "event", resolved: false, approvalTool: { status: "waiting" } },
  ]);
  expect(
    activityTranscript([
      call(1, "a"),
      call(2, "b"),
      approval,
      e(4, { kind: "approval_resolved", request_id: "approval", allow: false }),
      result(5, "b", true),
    ]),
  ).toMatchObject([
    { type: "tool", status: "pending" },
    { type: "event", decision: "denied", approvalTool: { status: "denied" } },
  ]);
});

it("keeps execution failures inside the linked approval after allowing", () => {
  expect(
    activityTranscript([
      call(1, "a"),
      e(2, {
        kind: "approval",
        request_id: "r",
        tool_use_id: "a",
        tool: "Read",
        input: {},
      }),
      e(3, { kind: "approval_resolved", request_id: "r", allow: true }),
      result(4, "a", true),
    ]),
  ).toMatchObject([
    {
      type: "event",
      decision: "allowed",
      approvalTool: { status: "failed", output: expect.anything() },
    },
  ]);
});
