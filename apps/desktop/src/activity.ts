import type { Event, JsonValue } from "./protocol";
import { transcript, queuedInputReceipts, type Item } from "./transcript";
import { toolOutput, type ToolImage } from "./toolOutput";

export interface ToolActivity {
  key: number;
  type: "tool";
  name: string;
  input?: JsonValue;
  output?: JsonValue;
  /** Present when `output` is a size-bounded preview of a larger payload. */
  load?: { seq: number; size: number };
  status:
    | "pending"
    | "waiting"
    | "denied"
    | "expired"
    | "completed"
    | "failed"
    | "unconfirmed";
}
export type ActivityItem =
  | { key: number; type: "tool_images"; images: ToolImage[] }
  | (Item & { approvalTool?: ToolActivity })
  | ToolActivity
  | {
      key: number;
      type: "tools";
      tools: ToolActivity[];
      /** True when the turn halted in failure/stop immediately on this group's trailing failed tool. */
      unrecovered?: boolean;
    };

/** Candidates for a confirmed completed process, never a live-turn classifier. */
export function isProcessActivity(item: ActivityItem): boolean {
  if (item.type === "assistant") return true;
  if (
    item.type === "tool" ||
    item.type === "tools" ||
    item.type === "tool_images"
  )
    return true;
  if (item.type !== "event") return false;
  if (item.value.kind === "progress" || item.value.kind === "usage")
    return true;
  return (
    item.value.kind === "notice" && !/^已加载 Skill：\S+$/.test(item.value.text)
  );
}

/** Metadata can split an answer into several rows after the last execution. */
export function finalReplyItems(items: ActivityItem[]) {
  let barrier = -1;
  items.forEach((item, index) => {
    if (
      item.type === "user" ||
      item.type === "tool" ||
      item.type === "tools" ||
      item.type === "tool_images" ||
      (item.type === "event" && !!item.approvalTool)
    )
      barrier = index;
  });
  return items.slice(barrier + 1).filter((item) => item.type === "assistant");
}

/** Keep original order and stable group identities around visible boundaries. */
export function activitySegments(
  items: ActivityItem[],
  fold: (item: ActivityItem, index: number) => boolean,
) {
  const segments: { process: boolean; items: ActivityItem[] }[] = [];
  items.forEach((item, index) => {
    const process = fold(item, index);
    const last = segments.at(-1);
    if (last?.process === process) last.items.push(item);
    else segments.push({ process, items: [item] });
  });
  return segments;
}

/** Pair by tool ID within a user turn, never by result arrival order. */
export function activityTranscript(
  events: Event[],
  receipts = queuedInputReceipts(events),
): ActivityItem[] {
  const rows: ActivityItem[] = [];
  const attached = new Set<ToolActivity>();
  const pending = new Map<string, ToolActivity>();
  const unfinished = new Set<ToolActivity>();
  const eventLoads = new Map<number, { seq: number; size: number }>();
  for (const { seq, content_size } of events)
    if (content_size != null) eventLoads.set(seq, { seq, size: content_size });
  function finish() {
    for (const tool of unfinished) {
      if (tool.status === "pending") tool.status = "unconfirmed";
    }
    unfinished.clear();
    pending.clear();
  }
  // State events without a message are still needed to end pending operations.
  const terminal = events
    .filter(
      ({ event }) =>
        event.kind === "state" &&
        !["running", "waiting"].includes(event.status),
    )
    .map(({ seq }) => seq);
  let terminalIndex = 0;
  const projected = transcript(events, receipts);
  for (const item of projected) {
    while (
      terminalIndex < terminal.length &&
      terminal[terminalIndex] <= item.key
    ) {
      finish();
      terminalIndex++;
    }
    if (item.type === "user" && !item.handoff) finish();
    if (item.type !== "event") {
      rows.push(item);
      continue;
    }
    const value = item.value;
    if (value.kind === "tool") {
      const tool: ToolActivity = {
        key: item.key,
        type: "tool",
        name: value.name,
        input: value.input,
        status: "pending",
      };
      rows.push(tool);
      unfinished.add(tool);
      if (value.id) pending.set(value.id, tool);
    } else if (value.kind === "tool_result") {
      const output = toolOutput(value.content);
      // Preview rows keep their full payload addressable by the result event's
      // sequence number; whole payloads have no load identity.
      const load = eventLoads.get(item.key);
      const tool = value.id ? pending.get(value.id) : undefined;
      if (tool) {
        tool.output = output.content;
        tool.load = load;
        if (tool.status !== "denied")
          tool.status = value.is_error ? "failed" : "completed";
        pending.delete(value.id);
        unfinished.delete(tool);
      } else {
        // Partial histories must not lose unmatched results.
        rows.push({
          key: item.key,
          type: "tool",
          name: "工具输出",
          output: output.content,
          load,
          status: value.is_error ? "failed" : "completed",
        });
      }
      if (output.images.length)
        rows.push({
          key: item.key + 0.5,
          type: "tool_images",
          images: output.images,
        });
    } else {
      if (
        (value.kind === "approval" || value.kind === "question") &&
        value.tool_use_id
      ) {
        const tool = pending.get(value.tool_use_id);
        if (tool) {
          attached.add(tool);
          rows.push({ ...item, approvalTool: tool });
          tool.status =
            value.kind === "question"
              ? item.resolved
                ? item.answers === null
                  ? "denied"
                  : item.answers === undefined
                    ? "expired"
                    : "pending"
                : "waiting"
              : item.decision === "denied"
                ? "denied"
                : item.decision === "expired"
                  ? "expired"
                  : item.decision === "allowed"
                    ? "pending"
                    : "waiting";
          continue;
        }
      }
      rows.push(item);
    }
  }
  if (terminalIndex < terminal.length) finish();
  const GROUPABLE_STATUSES: ToolActivity["status"][] = [
    "pending",
    "completed",
    "failed",
    "unconfirmed",
  ];
  const grouped: ActivityItem[] = [];
  for (const row of rows) {
    if (row.type === "tool" && attached.has(row)) continue;
    const last = grouped.at(-1);
    // Approval / waiting / denied / expired controls remain visible at top level;
    // ordinary tool failures stay folded inside their phase cluster.
    if (row.type === "tool" && GROUPABLE_STATUSES.includes(row.status)) {
      if (last?.type === "tools") last.tools.push(row);
      else if (
        last?.type === "tool" &&
        GROUPABLE_STATUSES.includes(last.status)
      )
        grouped.splice(-1, 1, {
          key: last.key,
          type: "tools",
          tools: [last, row],
        });
      else grouped.push(row);
    } else grouped.push(row);
  }

  // Mark a trailing tool group `unrecovered` when its turn ended in `failed` or
  // `stopped` directly on a failed tool without any subsequent recovery step.
  let turnStart = 0;
  while (turnStart < grouped.length) {
    let turnEnd = turnStart + 1;
    while (turnEnd < grouped.length) {
      const candidate = grouped[turnEnd];
      if (candidate.type === "user" && !candidate.handoff) break;
      turnEnd++;
    }
    let halted = false;
    let lastSubstantive: ActivityItem | undefined;
    for (let i = turnStart; i < turnEnd; i++) {
      const item = grouped[i];
      if (item.type === "event") {
        if (
          item.value.kind === "state" &&
          (item.value.status === "failed" || item.value.status === "stopped")
        ) {
          halted = true;
        } else if (
          item.value.kind === "approval" ||
          item.value.kind === "question"
        ) {
          lastSubstantive = item;
        }
      } else if (
        item.type === "assistant" ||
        item.type === "tool" ||
        item.type === "tools"
      ) {
        lastSubstantive = item;
      }
    }
    if (
      halted &&
      lastSubstantive?.type === "tools" &&
      lastSubstantive.tools.at(-1)?.status === "failed"
    ) {
      lastSubstantive.unrecovered = true;
    }
    turnStart = turnEnd;
  }

  return grouped;
}

function field(input: JsonValue | undefined, key: string): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  return typeof input[key] === "string" ? input[key] : "";
}

function compactPath(fullPath: string, compact: boolean): string {
  const parts = fullPath.split("/").filter(Boolean);
  return compact && parts.length > 2
    ? `…/${parts.slice(-2).join("/")}`
    : fullPath;
}

export interface ToolDisplayParts {
  verb: string;
  target: string;
  monoTarget?: boolean;
  diff?: { added: number; removed: number };
  diffSimplified?: boolean;
}

export type StringDiffOp =
  | { kind: "equal"; oldLineNo: number; newLineNo: number; text: string }
  | { kind: "del"; lineNo: number; text: string }
  | { kind: "add"; lineNo: number; text: string };

interface DiffAnchor {
  oldIdx: number;
  newIdx: number;
}

function findUniqueLineAnchors(
  oldSlice: string[],
  newSlice: string[],
  allowBlank = false,
): DiffAnchor[] {
  const oldUnique = new Map<string, number>();
  for (let i = 0; i < oldSlice.length; i++) {
    const line = oldSlice[i];
    if (!allowBlank && line.trim().length === 0) continue;
    oldUnique.set(line, oldUnique.has(line) ? -1 : i);
  }
  const newUnique = new Map<string, number>();
  for (let j = 0; j < newSlice.length; j++) {
    const line = newSlice[j];
    if (!allowBlank && line.trim().length === 0) continue;
    newUnique.set(line, newUnique.has(line) ? -1 : j);
  }

  const pairs: DiffAnchor[] = [];
  for (let i = 0; i < oldSlice.length; i++) {
    const line = oldSlice[i];
    if (oldUnique.get(line) !== i) continue;
    const j = newUnique.get(line);
    if (j !== undefined && j >= 0) {
      pairs.push({ oldIdx: i, newIdx: j });
    }
  }
  if (pairs.length === 0) {
    return allowBlank ? [] : findUniqueLineAnchors(oldSlice, newSlice, true);
  }

  const tails: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let p = 0; p < pairs.length; p++) {
    const val = pairs[p].newIdx;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pairs[tails[mid]].newIdx < val) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[p] = tails[lo - 1];
    tails[lo] = p;
  }

  const lis: DiffAnchor[] = [];
  for (let cur = tails[tails.length - 1]; cur >= 0; cur = prev[cur]) {
    lis.push(pairs[cur]);
  }
  lis.reverse();
  return lis;
}

function findLongestContiguousRun(
  oldSlice: string[],
  newSlice: string[],
): DiffAnchor[] {
  const firstNew = new Map<string, number>();
  const lastNew = new Map<string, number>();
  for (let j = 0; j < newSlice.length; j++) {
    const line = newSlice[j];
    if (!firstNew.has(line)) firstNew.set(line, j);
    lastNew.set(line, j);
  }

  const firstOld = new Map<string, number>();
  const lastOld = new Map<string, number>();
  for (let i = 0; i < oldSlice.length; i++) {
    const line = oldSlice[i];
    if (!firstNew.has(line)) continue;
    if (!firstOld.has(line)) firstOld.set(line, i);
    lastOld.set(line, i);
  }

  let best: { oldIdx: number; newIdx: number; len: number } | null = null;
  let checked = 0;
  for (const [line, oFirst] of firstOld) {
    if (++checked > 64) break;
    const oCandidates =
      lastOld.get(line)! !== oFirst ? [oFirst, lastOld.get(line)!] : [oFirst];
    const nFirst = firstNew.get(line)!;
    const nLast = lastNew.get(line)!;
    const nCandidates = nLast !== nFirst ? [nFirst, nLast] : [nFirst];

    for (const oi of oCandidates) {
      for (const nj of nCandidates) {
        if (
          best &&
          oi >= best.oldIdx &&
          oi < best.oldIdx + best.len &&
          oi - best.oldIdx === nj - best.newIdx
        ) {
          continue;
        }
        let sOld = oi;
        let sNew = nj;
        while (
          sOld > 0 &&
          sNew > 0 &&
          oldSlice[sOld - 1] === newSlice[sNew - 1]
        ) {
          sOld--;
          sNew--;
        }
        let eOld = oi + 1;
        let eNew = nj + 1;
        while (
          eOld < oldSlice.length &&
          eNew < newSlice.length &&
          oldSlice[eOld] === newSlice[eNew]
        ) {
          eOld++;
          eNew++;
        }
        const len = eOld - sOld;
        if (!best || len > best.len) {
          best = { oldIdx: sOld, newIdx: sNew, len };
        }
      }
    }
  }
  return best && best.len >= 4
    ? [{ oldIdx: best.oldIdx, newIdx: best.newIdx }]
    : [];
}

function runBoundedMyers(
  subOld: string[],
  oldOffset: number,
  subNew: string[],
  newOffset: number,
): { ops: StringDiffOp[]; approximate: boolean } {
  const m = subOld.length;
  const n = subNew.length;
  const maxD = Math.min(m + n, 512);
  const offset = maxD + 2;
  let v = new Int32Array(2 * offset + 4).fill(-1);
  v[offset] = 0;
  const trace: Int32Array[] = [];
  let foundD = -1;

  for (let d = 1; d <= maxD; d++) {
    trace.push(v);
    const nextV = new Int32Array(v.length).fill(-1);
    for (let k = -d; k <= d; k += 2) {
      const prevXDown = k < d ? v[k + 1 + offset] : -1;
      const validDown = prevXDown >= 0 && prevXDown - k <= n;
      const prevXRight = k > -d ? v[k - 1 + offset] : -1;
      const validRight = prevXRight >= 0 && prevXRight + 1 <= m;
      if (!validDown && !validRight) continue;

      const down = validDown && (!validRight || prevXDown > prevXRight);
      let x = down ? prevXDown : prevXRight + 1;
      let y = x - k;
      while (x < m && y < n && subOld[x] === subNew[y]) {
        x++;
        y++;
      }
      nextV[k + offset] = x;
      if (x === m && y === n) {
        foundD = d;
        break;
      }
    }
    v = nextV;
    if (foundD >= 0) break;
  }

  if (foundD < 0) {
    return {
      ops: [
        ...subOld.map((text, i): StringDiffOp => ({
          kind: "del",
          lineNo: oldOffset + i + 1,
          text,
        })),
        ...subNew.map((text, j): StringDiffOp => ({
          kind: "add",
          lineNo: newOffset + j + 1,
          text,
        })),
      ],
      approximate: true,
    };
  }

  const reversed: StringDiffOp[] = [];
  let curX = m;
  let curY = n;
  for (let step = foundD; step >= 1; step--) {
    const prevV = trace[step - 1];
    const k = curX - curY;
    const prevXDown = k < step ? prevV[k + 1 + offset] : -1;
    const validDown = prevXDown >= 0 && prevXDown - k <= n;
    const prevXRight = k > -step ? prevV[k - 1 + offset] : -1;
    const validRight = prevXRight >= 0 && prevXRight + 1 <= m;
    const down = validDown && (!validRight || prevXDown > prevXRight);

    const prevX = down ? prevXDown : prevXRight;
    const prevY = down ? prevXDown - k - 1 : prevXRight - k + 1;
    const startX = down ? prevX : prevX + 1;
    const startY = down ? prevY + 1 : prevY;

    while (curX > startX && curY > startY) {
      curX--;
      curY--;
      reversed.push({
        kind: "equal",
        oldLineNo: oldOffset + curX + 1,
        newLineNo: newOffset + curY + 1,
        text: subOld[curX],
      });
    }
    if (down) {
      reversed.push({
        kind: "add",
        lineNo: newOffset + prevY + 1,
        text: subNew[prevY],
      });
    } else {
      reversed.push({
        kind: "del",
        lineNo: oldOffset + prevX + 1,
        text: subOld[prevX],
      });
    }
    curX = prevX;
    curY = prevY;
  }
  reversed.reverse();

  const normalized: StringDiffOp[] = [];
  let idx = 0;
  while (idx < reversed.length) {
    if (reversed[idx].kind === "equal") {
      normalized.push(reversed[idx]);
      idx++;
      continue;
    }
    const dels: StringDiffOp[] = [];
    const adds: StringDiffOp[] = [];
    while (idx < reversed.length && reversed[idx].kind !== "equal") {
      if (reversed[idx].kind === "del") dels.push(reversed[idx]);
      else adds.push(reversed[idx]);
      idx++;
    }
    normalized.push(...dels, ...adds);
  }
  return { ops: normalized, approximate: false };
}

function expandAnchorRuns(
  subOld: string[],
  subNew: string[],
  rawAnchors: DiffAnchor[],
): Array<{ oldIdx: number; newIdx: number; len: number }> {
  const m = subOld.length;
  const n = subNew.length;
  const runs: Array<{ oldIdx: number; newIdx: number; len: number }> = [];
  for (const anchor of rawAnchors) {
    const prev = runs.at(-1);
    if (
      prev &&
      (anchor.oldIdx < prev.oldIdx + prev.len ||
        anchor.newIdx < prev.newIdx + prev.len)
    ) {
      continue;
    }
    const minOld = prev ? prev.oldIdx + prev.len : 0;
    const minNew = prev ? prev.newIdx + prev.len : 0;
    let sOld = anchor.oldIdx;
    let sNew = anchor.newIdx;
    while (
      sOld > minOld &&
      sNew > minNew &&
      subOld[sOld - 1] === subNew[sNew - 1]
    ) {
      sOld--;
      sNew--;
    }
    let eOld = anchor.oldIdx + 1;
    let eNew = anchor.newIdx + 1;
    while (eOld < m && eNew < n && subOld[eOld] === subNew[eNew]) {
      eOld++;
      eNew++;
    }
    if (
      prev &&
      prev.oldIdx + prev.len === sOld &&
      prev.newIdx + prev.len === sNew
    ) {
      prev.len += eOld - sOld;
    } else {
      runs.push({ oldIdx: sOld, newIdx: sNew, len: eOld - sOld });
    }
  }
  return runs;
}

function diffRange(
  oldSlice: string[],
  oldStart: number,
  newSlice: string[],
  newStart: number,
  depth: number,
): { ops: StringDiffOp[]; approximate: boolean } {
  let prefix = 0;
  while (
    prefix < oldSlice.length &&
    prefix < newSlice.length &&
    oldSlice[prefix] === newSlice[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldSlice.length - prefix &&
    suffix < newSlice.length - prefix &&
    oldSlice[oldSlice.length - 1 - suffix] ===
      newSlice[newSlice.length - 1 - suffix]
  ) {
    suffix++;
  }

  const ops: StringDiffOp[] = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({
      kind: "equal",
      oldLineNo: oldStart + i + 1,
      newLineNo: newStart + i + 1,
      text: oldSlice[i],
    });
  }

  const subOld = oldSlice.slice(prefix, oldSlice.length - suffix);
  const subNew = newSlice.slice(prefix, newSlice.length - suffix);
  const subOldStart = oldStart + prefix;
  const subNewStart = newStart + prefix;
  const m = subOld.length;
  const n = subNew.length;

  let approximate = false;
  if (m === 0 && n > 0) {
    for (let j = 0; j < n; j++) {
      ops.push({ kind: "add", lineNo: subNewStart + j + 1, text: subNew[j] });
    }
  } else if (n === 0 && m > 0) {
    for (let i = 0; i < m; i++) {
      ops.push({ kind: "del", lineNo: subOldStart + i + 1, text: subOld[i] });
    }
  } else if (m > 0 && n > 0) {
    const newSet = new Set(subNew);
    const hasCommon = subOld.some((line) => newSet.has(line));
    if (!hasCommon) {
      for (let i = 0; i < m; i++) {
        ops.push({ kind: "del", lineNo: subOldStart + i + 1, text: subOld[i] });
      }
      for (let j = 0; j < n; j++) {
        ops.push({ kind: "add", lineNo: subNewStart + j + 1, text: subNew[j] });
      }
    } else {
      // Always attempt exact bounded Myers first so small edit distances (such as
      // moving 1 line across 300+ kept lines, D = 2) get the globally minimal SES.
      const myers = runBoundedMyers(subOld, subOldStart, subNew, subNewStart);
      if (!myers.approximate || depth >= 8) {
        ops.push(...myers.ops);
        approximate = myers.approximate;
      } else {
        const uniqueRuns = expandAnchorRuns(
          subOld,
          subNew,
          findUniqueLineAnchors(subOld, subNew),
        );
        const uniqueMatched = uniqueRuns.reduce((sum, r) => sum + r.len, 0);
        const contigRuns = expandAnchorRuns(
          subOld,
          subNew,
          findLongestContiguousRun(subOld, subNew),
        );
        const contigMatched = contigRuns.reduce((sum, r) => sum + r.len, 0);
        const runs = uniqueMatched >= contigMatched ? uniqueRuns : contigRuns;
        const matched = Math.max(uniqueMatched, contigMatched);

        if (matched >= 4) {
          let curOld = 0;
          let curNew = 0;
          for (const run of runs) {
            if (curOld < run.oldIdx || curNew < run.newIdx) {
              const gap = diffRange(
                subOld.slice(curOld, run.oldIdx),
                subOldStart + curOld,
                subNew.slice(curNew, run.newIdx),
                subNewStart + curNew,
                depth + 1,
              );
              ops.push(...gap.ops);
              if (gap.approximate) approximate = true;
            }
            for (let t = 0; t < run.len; t++) {
              ops.push({
                kind: "equal",
                oldLineNo: subOldStart + run.oldIdx + t + 1,
                newLineNo: subNewStart + run.newIdx + t + 1,
                text: subOld[run.oldIdx + t],
              });
            }
            curOld = run.oldIdx + run.len;
            curNew = run.newIdx + run.len;
          }
          if (curOld < m || curNew < n) {
            const tail = diffRange(
              subOld.slice(curOld),
              subOldStart + curOld,
              subNew.slice(curNew),
              subNewStart + curNew,
              depth + 1,
            );
            ops.push(...tail.ops);
            if (tail.approximate) approximate = true;
          }
        } else {
          ops.push(...myers.ops);
          approximate = true;
        }
      }
    }
  }

  for (let i = 0; i < suffix; i++) {
    const oldIdx = oldSlice.length - suffix + i;
    const newIdx = newSlice.length - suffix + i;
    ops.push({
      kind: "equal",
      oldLineNo: oldStart + oldIdx + 1,
      newLineNo: newStart + newIdx + 1,
      text: newSlice[newIdx],
    });
  }

  return { ops, approximate };
}

/**
 * Shared multi-hunk line diff used by both summary stats and inline diff previews.
 * Splits large blocks along common anchors first, and flags `approximate` if any
 * unanchored block still exceeds the bounded Myers edit-distance budget.
 */
export function diffStringLines(
  oldStr: string,
  newStr: string,
): {
  ops: StringDiffOp[];
  added: number;
  removed: number;
  approximate: boolean;
} {
  const oldLines = oldStr.length === 0 ? [] : oldStr.split("\n");
  const newLines = newStr.length === 0 ? [] : newStr.split("\n");
  const { ops, approximate } = diffRange(oldLines, 0, newLines, 0, 0);

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "add") added++;
    else if (op.kind === "del") removed++;
  }
  return { ops, added, removed, approximate };
}

/** Compute lightweight line-level +/- counts for Edit/MultiEdit/Write inputs. */
export function toolInputDiffStat(
  tool: ToolActivity,
): { added: number; removed: number; approximate?: boolean } | undefined {
  const kind = tool.name.toLowerCase();
  const input = tool.input;
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const countLines = (text: string) =>
    text.length === 0 ? 0 : text.split("\n").length;
  if (kind === "write" && typeof input.content === "string") {
    return { added: countLines(input.content), removed: 0 };
  }
  if (kind === "edit") {
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    if (!oldStr && !newStr) return undefined;
    const { added, removed, approximate } = diffStringLines(oldStr, newStr);
    if (!added && !removed) return undefined;
    return approximate
      ? { added, removed, approximate: true }
      : { added, removed };
  }
  if (kind === "multiedit" && Array.isArray(input.edits)) {
    let added = 0;
    let removed = 0;
    let approximate = false;
    for (const entry of input.edits) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const oldStr =
          typeof entry.old_string === "string" ? entry.old_string : "";
        const newStr =
          typeof entry.new_string === "string" ? entry.new_string : "";
        const hunk = diffStringLines(oldStr, newStr);
        added += hunk.added;
        removed += hunk.removed;
        if (hunk.approximate) approximate = true;
      }
    }
    if (!added && !removed) return undefined;
    return approximate
      ? { added, removed, approximate: true }
      : { added, removed };
  }
  return undefined;
}

/** Structured two-tone verb + target parts for calm scannable tool rows. */
export function toolDisplayParts(
  tool: ToolActivity,
  compact = true,
): ToolDisplayParts {
  const fullPath = field(tool.input, "file_path") || field(tool.input, "path");
  const path = compactPath(fullPath, compact);
  const description = field(tool.input, "description");
  const command = field(tool.input, "command");
  const pattern = field(tool.input, "pattern");
  const kind = tool.name.toLowerCase();
  switch (kind) {
    case "read":
      return path
        ? { verb: "读取", target: path, monoTarget: true }
        : { verb: "读取文件", target: "" };
    case "edit":
    case "multiedit": {
      const stat = toolInputDiffStat(tool);
      const diffMeta = stat?.approximate
        ? { diffSimplified: true }
        : stat
          ? { diff: { added: stat.added, removed: stat.removed } }
          : {};
      return path
        ? {
            verb: tool.status === "completed" ? "已编辑" : "编辑",
            target: path,
            monoTarget: true,
            ...diffMeta,
          }
        : { verb: "编辑文件", target: "", ...diffMeta };
    }
    case "write":
      return path
        ? {
            verb: tool.status === "completed" ? "已写入" : "写入",
            target: path,
            monoTarget: true,
            diff: toolInputDiffStat(tool),
          }
        : { verb: "写入文件", target: "", diff: toolInputDiffStat(tool) };
    case "bash":
      if (description) {
        const cleaned = description.replace(/^运行\s*/, "");
        return { verb: "运行", target: cleaned || description };
      }
      if (command)
        return {
          verb: "运行",
          target: command.replace(/\s+/g, " "),
          monoTarget: true,
        };
      return { verb: "运行命令", target: "" };
    case "glob":
      return pattern
        ? { verb: "查找", target: pattern, monoTarget: true }
        : { verb: "查找文件", target: "" };
    case "grep":
      return pattern
        ? { verb: "搜索", target: pattern, monoTarget: true }
        : { verb: "搜索内容", target: "" };
    case "skill":
      return {
        verb: "使用技能",
        target: field(tool.input, "skill") || "Skill",
      };
    case "task":
    case "agent":
    case "subagent":
      return {
        verb: "调用子智能体",
        target: description || field(tool.input, "prompt").slice(0, 60),
      };
    default:
      return description
        ? { verb: tool.name, target: description }
        : { verb: "", target: tool.name };
  }
}

export function toolLabel(tool: ToolActivity, compact = false): string {
  const fullPath = field(tool.input, "file_path") || field(tool.input, "path");
  const path = compactPath(fullPath, compact);
  const description = field(tool.input, "description");
  const command = field(tool.input, "command");
  const pattern = field(tool.input, "pattern");
  switch (tool.name.toLowerCase()) {
    case "read":
      return path ? `读取 ${path}` : "读取文件";
    case "edit":
    case "multiedit":
      return path ? `编辑 ${path}` : "编辑文件";
    case "write":
      return path ? `写入 ${path}` : "写入文件";
    case "bash":
      return description || (command ? `运行 ${command}` : "运行命令");
    case "glob":
      return pattern ? `查找文件 ${pattern}` : "查找文件";
    case "grep":
      return pattern ? `搜索 ${pattern}` : "搜索内容";
    case "skill":
      return `使用 ${field(tool.input, "skill") || "Skill"}`;
    default:
      return description || tool.name;
  }
}

function summarizeCompletedTools(tools: ToolActivity[]): string {
  let readCount = 0;
  let searchCount = 0;
  let editCount = 0;
  let bashCount = 0;
  let agentCount = 0;
  let otherCount = 0;
  const editedPaths = new Set<string>();

  for (const tool of tools) {
    const kind = tool.name.toLowerCase();
    const path = field(tool.input, "file_path") || field(tool.input, "path");
    if (kind === "read") readCount++;
    else if (kind === "glob" || kind === "grep") searchCount++;
    else if (kind === "edit" || kind === "multiedit" || kind === "write") {
      editCount++;
      if (path) editedPaths.add(path);
    } else if (kind === "bash") bashCount++;
    else if (kind === "task" || kind === "agent" || kind === "subagent")
      agentCount++;
    else otherCount++;
  }

  const exploreCount = readCount + searchCount;
  const editedFileCount = editedPaths.size || editCount;
  const clauses: string[] = [];

  if (exploreCount > 0) {
    if (editCount === 0 && bashCount === 0 && agentCount === 0) {
      if (readCount > 0 && searchCount > 0)
        clauses.push(`探索了 ${readCount} 个文件并搜索代码`);
      else if (readCount > 0) clauses.push(`探索了 ${readCount} 个文件`);
      else clauses.push(`搜索了 ${searchCount} 处内容`);
    } else {
      clauses.push("探索了文件");
    }
  }
  if (editCount > 0) {
    clauses.push(
      clauses.length === 0 && bashCount === 0
        ? `编辑了 ${editedFileCount} 个文件`
        : editedFileCount > 1
          ? `编辑了 ${editedFileCount} 个文件`
          : "编辑了文件",
    );
  }
  if (bashCount > 0) {
    clauses.push(
      clauses.length === 0 ? `运行了 ${bashCount} 条命令` : "运行了命令",
    );
  }
  if (agentCount > 0) {
    clauses.push(
      clauses.length === 0
        ? `协同了 ${agentCount} 个子智能体`
        : `协同 ${agentCount} 个子智能体`,
    );
  }
  if (clauses.length === 0) {
    clauses.push(`执行了 ${otherCount || tools.length} 项操作`);
  }

  return clauses.length === 1
    ? clauses[0]
    : clauses.length === 2
      ? `${clauses[0]}并${clauses[1]}`
      : `${clauses.slice(0, -1).join("、")}并${clauses.at(-1)}`;
}

function summarizeUnconfirmedTools(tools: ToolActivity[]): string {
  let readCount = 0;
  let searchCount = 0;
  let writeCount = 0;
  let editCount = 0;
  let bashCount = 0;
  let agentCount = 0;
  let otherCount = 0;

  for (const tool of tools) {
    const kind = tool.name.toLowerCase();
    if (kind === "read") readCount++;
    else if (kind === "glob" || kind === "grep") searchCount++;
    else if (kind === "write") writeCount++;
    else if (kind === "edit" || kind === "multiedit") editCount++;
    else if (kind === "bash") bashCount++;
    else if (kind === "task" || kind === "agent" || kind === "subagent")
      agentCount++;
    else otherCount++;
  }

  const parts: string[] = [];
  if (readCount > 0) parts.push(`读取 ${readCount} 次`);
  if (searchCount > 0) parts.push(`搜索 ${searchCount} 次`);
  if (writeCount > 0) parts.push(`写入 ${writeCount} 次`);
  if (editCount > 0) parts.push(`编辑 ${editCount} 次`);
  if (bashCount > 0) parts.push(`命令 ${bashCount} 条`);
  if (agentCount > 0) parts.push(`子智能体 ${agentCount} 个`);
  if (otherCount > 0) parts.push(`工具调用 ${otherCount} 次`);
  if (parts.length === 0) parts.push(`工具调用 ${tools.length} 次`);
  return parts.join("、");
}

/**
 * Natural verb-phrase phase summary.
 * Safety invariant: only confirmed (`status === "completed"`) operations use past-tense
 * completion phrasing; `unconfirmed` calls never assert file edits or command completion.
 */
export function toolGroupLabel(tools: ToolActivity[]): string {
  const pending = tools.some((t) => t.status === "pending");
  if (pending) {
    const active = tools.filter((t) => t.status !== "failed");
    return `正在${summarizeCompletedTools(active.length ? active : tools).replace(/了/g, "")}`;
  }
  const completed = tools.filter((t) => t.status === "completed");
  const failed = tools.filter((t) => t.status === "failed");
  const unconfirmed = tools.filter((t) => t.status === "unconfirmed");

  if (completed.length > 0) {
    const base = summarizeCompletedTools(completed);
    if (unconfirmed.length > 0) {
      return `${base} · 另有${summarizeUnconfirmedTools(unconfirmed)}待确认`;
    }
    return base;
  }
  if (failed.length > 0 && unconfirmed.length === 0) {
    return `尝试${summarizeUnconfirmedTools(failed)}未通过`;
  }
  if (failed.length > 0 && unconfirmed.length > 0) {
    return `尝试${summarizeUnconfirmedTools(failed)}未通过 · 另有${summarizeUnconfirmedTools(unconfirmed)}待确认`;
  }
  return `发起${summarizeUnconfirmedTools(unconfirmed)}`;
}
