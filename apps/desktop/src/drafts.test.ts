import { expect, it } from "vitest";
import { DraftStore } from "./drafts";
import type { Annotation } from "./annotations";

it("versions annotation additions, edits and deletion independently from unchanged text", () => {
  const store = new DraftStore();
  const annotation: Annotation = {
    id: "one",
    quote: "原文",
    comment: "建议",
    source: { message: 2, start: 0, end: 2 },
  };
  store.update("a", { annotations: [annotation] });
  const sent = store.get("a");
  store.update("a", { annotations: [{ ...annotation, comment: "修改建议" }] });
  store.clear("a", sent);
  expect(store.get("a").annotations?.[0].comment).toBe("修改建议");
  const edited = store.get("a");
  store.update("a", { annotations: [] });
  store.clear("a", edited);
  expect(store.get("a").annotations).toEqual([]);
  expect(store.get("b").annotations).toBeUndefined();
});

it("clears an acknowledged message after duplicate input and empty-reference initialization", () => {
  const store = new DraftStore();
  store.update("task", { text: "sent" });
  const submitted = store.get("task");
  store.update("task", { text: "sent" });
  store.update("task", {
    references: { scope: "local:p:claude", entries: [] },
  });
  store.clear("task", submitted);
  expect(store.get("task").text).toBe("");
});
it("keeps a real edit even if it eventually has the same text as the acknowledged message", () => {
  const store = new DraftStore();
  store.update("task", { text: "repeat" });
  const submitted = store.get("task");
  store.update("task", { text: "" });
  store.update("task", { text: "repeat" });
  store.clear("task", submitted);
  expect(store.get("task").text).toBe("repeat");
});
it("preserves a draft retargeted to another host even when it has no references", () => {
  const store = new DraftStore();
  store.update("new-task", {
    text: "message",
    references: { scope: "local:p:claude", entries: [] },
  });
  const submitted = store.get("new-task");
  store.update("new-task", {
    references: { scope: "remote:q:claude", entries: [] },
  });
  store.clear("new-task", submitted);
  expect(store.get("new-task").text).toBe("message");
});
it("retains newly selected references when a prior message is accepted", () => {
  const store = new DraftStore();
  store.update("task", { text: "message" });
  const submitted = store.get("task");
  store.update("task", {
    references: {
      scope: "local:p:claude",
      entries: [{ path: "new.md", name: "new.md", directory: false }],
    },
  });
  store.clear("task", submitted);
  expect(store.get("task").references.entries[0].path).toBe("new.md");
});
