// Exercise the real sideband plugin without an OpenCode process or external model.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  await new Promise((resolve) =>
    server.listen(join(directory, "events"), resolve),
  );
  const domain = { list: async () => lookup(++calls) };
  try {
    cleanup = await plugin.setup({
      app: { version },
      options: { socket: join(directory, "events") },
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
