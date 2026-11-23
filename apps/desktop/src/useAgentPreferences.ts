import { useState } from "react";
import type { Effort, Session } from "./protocol";

type Selection = {
  model: string | null;
  effort: Effort | null;
  permissionMode: string | null;
};
type TransientModelEntry = {
  draftScope: string;
  conversationKey: string;
  host: string;
  agent: string;
  model: string;
};
type HookState = {
  source: string;
  conversationKey: string;
  selection: Selection;
  error: string;
  transientModels: TransientModelEntry[];
};

const empty: Selection = { model: null, effort: null, permissionMode: null };
const levels = new Set(["low", "medium", "high", "xhigh", "max"]);
const MAX_TRANSIENT_SCOPES = 64;
const key = (host: string, agent: string) =>
  `latte-work.agent-selection.v1:${JSON.stringify([host, agent])}`;

function read(host: string, agent: string): Selection {
  try {
    const raw = localStorage.getItem(key(host, agent));
    if (!raw || raw.length > 4096) return empty;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return empty;
    const { model, effort, permissionMode } = value as Partial<Selection>;
    return {
      model:
        typeof model === "string" &&
        model.trim() &&
        model.length <= 256 &&
        !/[\u0000-\u001f]/.test(model)
          ? model
          : null,
      effort: effort && levels.has(effort) ? effort : null,
      permissionMode:
        typeof permissionMode === "string" &&
        /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(permissionMode)
          ? permissionMode
          : null,
    };
  } catch {
    return empty;
  }
}

function upsertTransientModel(
  entries: TransientModelEntry[],
  draftScope: string,
  conversationKey: string,
  host: string,
  agent: string,
  model: string | null,
): TransientModelEntry[] {
  const withoutScope = entries.filter(
    (entry) => entry.draftScope !== draftScope,
  );
  if (!model) return withoutScope;
  const trimmed =
    withoutScope.length >= MAX_TRANSIENT_SCOPES
      ? withoutScope.slice(withoutScope.length - MAX_TRANSIENT_SCOPES + 1)
      : withoutScope;
  return [...trimmed, { draftScope, conversationKey, host, agent, model }];
}

function initialSelection(
  host: string,
  agent: string,
  session: Session | undefined,
  draftScope: string,
  transientModels: TransientModelEntry[],
): Selection {
  if (session) {
    return {
      model: session.model,
      effort: session.effort,
      permissionMode: session.permission_mode ?? null,
    };
  }
  const stored = read(host, agent);
  const transient = transientModels.find(
    (entry) => entry.draftScope === draftScope,
  );
  return transient ? { ...stored, model: transient.model } : stored;
}

/** Remember explicit choices per host/agent, never infer an override from CLI defaults. */
export function useAgentPreferences(
  host: string,
  agent: string,
  projectId: string | undefined,
  session: Session | undefined,
  sending: boolean,
  conversationKey?: string,
) {
  const normalizedConversationKey = conversationKey ?? "";
  const draftScope = JSON.stringify([
    normalizedConversationKey,
    host,
    agent,
    projectId ?? "",
  ]);
  const source = JSON.stringify([
    normalizedConversationKey,
    host,
    agent,
    projectId,
    session?.id,
    session?.model,
    session?.effort,
    session?.permission_mode,
  ]);
  const [state, setState] = useState<HookState>(() => ({
    source,
    conversationKey: normalizedConversationKey,
    selection: initialSelection(host, agent, session, draftScope, []),
    error: "",
    transientModels: [],
  }));

  let active = state;
  if (state.source !== source) {
    // Persisting the first prompt creates a Session before its send is accepted.
    // Keep the in-flight draft's choices until that transition is complete.
    const nextTransientModels = session
      ? state.transientModels.filter(
          (entry) =>
            entry.conversationKey !== normalizedConversationKey &&
            entry.conversationKey !== state.conversationKey,
        )
      : state.transientModels;
    active = sending
      ? {
          ...state,
          source,
          conversationKey: normalizedConversationKey,
          transientModels: nextTransientModels,
        }
      : {
          source,
          conversationKey: normalizedConversationKey,
          selection: initialSelection(
            host,
            agent,
            session,
            draftScope,
            nextTransientModels,
          ),
          error: "",
          transientModels: nextTransientModels,
        };
    setState(active);
  }

  function choose(patch: Partial<Selection>) {
    let nextError = "";
    try {
      // Write only the field the user changed, preserving the other remembered choice.
      localStorage.setItem(
        key(host, agent),
        JSON.stringify({ ...read(host, agent), ...patch }),
      );
    } catch {
      nextError = "本次选择已生效，但无法保存；重启后可能丢失。";
    }
    setState((current) => ({
      ...current,
      selection: { ...current.selection, ...patch },
      error: nextError,
      transientModels:
        "model" in patch
          ? current.transientModels.filter(
              (entry) => !(entry.host === host && entry.agent === agent),
            )
          : current.transientModels,
    }));
  }

  return {
    ...active.selection,
    error: active.error,
    chooseModel: (model: string | null) => choose({ model }),
    choosePermissionMode: (permissionMode: string | null) =>
      choose({ permissionMode }),
    chooseEffort: (effort: Effort | null) => choose({ effort }),
    // Capability refreshes and initial Provider fallbacks are not user choices
    // and must not erase remembered selections in localStorage, while keeping
    // the settled effective model across project round-trips on the same draft.
    replaceUnsupportedModel: (model: string | null) =>
      setState((current) => ({
        ...current,
        selection: { ...current.selection, model },
        transientModels: session
          ? current.transientModels
          : upsertTransientModel(
              current.transientModels,
              draftScope,
              normalizedConversationKey,
              host,
              agent,
              model,
            ),
      })),
    clearUnsupportedEffort: () =>
      setState((current) => ({
        ...current,
        selection: { ...current.selection, effort: null },
      })),
  };
}
