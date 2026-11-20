// Exercise the real sideband plugin without an OpenCode process or external model.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import plugin from "../crates/latte-work-server/src/agents/opencode/index.mjs";
const step = {
  type: "session.step.started",
  data: { sessionID: "root", model: { providerID: "p", id: "m" } },
};
const end = {
  type: "session.execution.interrupted",
  data: { sessionID: "root" },
};
async function probe(version, sequence, lookup, expected, interrupt = false) {
  const directory = await mkdtemp(join(tmpdir(), "lw-plugin-"));
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\latte-opencode-plugin-${randomUUID()}`
    : join(directory, "events");
  const messages = [];
  let socket,
    cleanup,
    timer,
    calls = 0,
    resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const server = createServer((conn) => {
    socket = conn;
    conn.setEncoding("utf8");
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        messages.push(message);
        if (message.type === "ready" && interrupt) {
          conn.write(
            JSON.stringify({
              action: "interrupt",
              id: "stop",
              sessionID: "root",
              permissions: [],
            }) + "\n",
          );
        }
        if (message.type === "session.execution.interrupted") resolveDone();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  const domain = { list: async () => lookup(++calls) };
  try {
    cleanup = await plugin.setup({
      app: { version },
      options: { socket: endpoint },
      location: { directory },
      ...(version === "2.0.0"
        ? { catalog: { model: domain } }
        : { model: domain }),
      event: {
        async *subscribe() {
          yield* sequence;
        },
      },
      tool: { async transform() {} },
      session: {
        async interrupt() {
          return { interrupted: true };
        },
      },
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Error("plugin event stream exceeded budget")),
        3500,
      );
    });
    const started = Date.now();
    await Promise.race([done, timeout]);
    expected(messages, calls, Date.now() - started);
  } finally {
    clearTimeout(timer);
    cleanup?.();
    socket?.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true });
  }
}
const catalog = (capacity) => ({
  data: [{ providerID: "p", id: "m", limit: { context: capacity } }],
});
for (const version of ["2.0.0", "2.3.0"]) {
  await test(`${version}: model catalog cache and invalidation`, () =>
    probe(
      version,
      [
        step,
        step,
        { type: version === "2.0.0" ? "catalog.updated" : "model.updated" },
        step,
        end,
      ],
      (count) => catalog(count * 10000),
      (messages, calls) => {
        assert.equal(calls, 2);
        assert.deepEqual(
          messages
            .filter((m) => m.type === step.type)
            .map((m) => m.data.contextWindow),
          [10000, 10000, 20000],
        );
      },
    ));
  await test(`${version}: failed metadata stays unknown and can retry`, () =>
    probe(
      version,
      [step, step, end],
      (count) =>
        count === 1 ? Promise.reject(Error("unavailable")) : catalog(20000),
      (messages, calls) => {
        assert.equal(calls, 2);
        assert.deepEqual(
          messages
            .filter((m) => m.type === step.type)
            .map((m) => m.data.contextWindow),
          [undefined, 20000],
        );
      },
    ));
  await test(`${version}: stalled lookup cannot accumulate waits or block interrupt`, () =>
    probe(
      version,
      [step, step, step, step, step, end],
      () => new Promise(() => {}),
      (messages, calls, elapsed) => {
        assert.equal(
          calls,
          1,
          "a stalled lookup must not spawn unbounded retries",
        );
        assert(
          elapsed < 3000,
          `stalled catalog delayed terminal by ${elapsed}ms`,
        );
        assert(
          messages.findIndex((m) => m.type === "reply" && m.interrupted) <
            messages.findIndex((m) => m.type === step.type),
          "metadata lookup must not block the interrupt request handler",
        );
      },
      true,
    ));
  await test(`${version}: metadata arriving after timeout restores capacity`, () =>
    probe(
      version,
      (async function* () {
        yield step;
        await new Promise((resolve) => setTimeout(resolve, 400));
        yield step;
        yield end;
      })(),
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(catalog(30000)), 1100),
        ),
      (messages, calls) => {
        assert.equal(calls, 1);
        assert.deepEqual(
          messages
            .filter((m) => m.type === step.type)
            .map((m) => m.data.contextWindow),
          [undefined, 30000],
        );
      },
    ));
}

for (const version of ["2.0.0", "2.3.0"]) {
  await test(`${version}: large tool display frames preserve execution and subsequent events`, async () => {
    const input = {
      filePath: "/workspace/large.txt",
      content: '中\u0000\\"'.repeat(300000),
    };
    const original = JSON.stringify(input);
    const huge = "x".repeat(2 * 1024 * 1024);
    const tools = ["input.started", "called", "success", "failed"].map(
      (kind) => ({
        type: `session.tool.${kind}`,
        data: {
          sessionID: "root",
          id: "tool-1",
          name: huge,
          input,
          metadata: { shellID: "shell-1", status: "running", unused: huge },
          content: [
            { type: "text", text: "\u0000".repeat(200000) },
            { type: "text", text: "small output", unused: huge },
          ],
          error: { message: huge },
          unused: huge,
        },
      }),
    );
    const approval = {
      type: "permission.asked",
      data: {
        sessionID: "root",
        id: "approve-1",
        action: "write",
        resources: ["/workspace/large.txt"],
      },
    };
    const ordinary = {
      type: "session.tool.called",
      data: {
        sessionID: "root",
        id: "tool-2",
        name: "read",
        input: { filePath: "small.txt" },
      },
    };
    await probe(
      version,
      [...tools, approval, ordinary, end],
      () => catalog(10000),
      (messages) => {
        assert.equal(messages.length, 8);
        for (const message of messages)
          assert(
            Buffer.byteLength(JSON.stringify(message) + "\n") < 1024 * 1024,
          );
        for (const message of messages.slice(1, 5)) {
          assert.equal(message.data.id, "tool-1");
          assert.equal(message.data.input._latte_display_truncated, true);
          assert.equal(message.data.metadata.shellID, "shell-1");
          assert.equal(message.data.metadata.status, "running");
          assert.equal(message.data.content[0].text, "small output");
        }
        assert.deepEqual(messages[5], approval);
        assert.deepEqual(messages[6].data.input, ordinary.data.input);
        assert.deepEqual(messages.at(-1), end);
      },
    );
    assert.equal(
      JSON.stringify(input),
      original,
      "native input must remain untouched",
    );
  });
  await test(`${version}: tool event burst drains without losing the terminal`, () =>
    probe(
      version,
      [
        ...Array.from({ length: 24 }, (_, i) => ({
          type: "session.tool.called",
          data: {
            sessionID: "root",
            id: `tool-${i}`,
            name: "write",
            input: { content: "界".repeat(80000) },
          },
        })),
        end,
      ],
      () => catalog(10000),
      (messages) => {
        assert.equal(messages.length, 26);
        assert.deepEqual(
          messages.slice(1, -1).map((m) => m.data.id),
          Array.from({ length: 24 }, (_, i) => `tool-${i}`),
        );
        assert.deepEqual(messages.at(-1), end);
      },
    ));
}
