import { useRef, useState } from "react";
import type { Response } from "./protocol";
import type { ComposerPrediction } from "./Composer";

export type ComposerPredictionResponse = Extract<
  Response,
  { kind: "composer_prediction" }
>;

/** Presentation state only. Never writes a draft, generates a prompt or starts an Agent. */
export function useComposerPrediction(
  scope: string,
  sessionId: string | undefined,
  agent: string,
  response: ComposerPredictionResponse | null | undefined,
) {
  const dismissed = useRef<ReadonlySet<string>>(new Set());
  const [, update] = useState(0);
  const text = response?.suggestion;
  const id = response?.source_request_id
    ? JSON.stringify([scope, response.source_request_id])
    : null;
  const prediction: ComposerPrediction | null =
    agent !== "opencode" &&
    response?.session_id === sessionId &&
    response?.status === "ready" &&
    !!response.generation_id &&
    !!id &&
    typeof text === "string" &&
    !!text.trim() &&
    Array.from(text).length <= 240 &&
    !dismissed.current.has(id)
      ? { id, text }
      : null;
  function dismiss(id: string) {
    // Keep source suppression across scope switches, bounded for the App lifetime.
    dismissed.current = new Set([...dismissed.current, id].slice(-128));
    update((revision) => revision + 1);
  }
  return { prediction, dismiss };
}
