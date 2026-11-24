import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { SessionActions } from "./SessionActions";
import type { Workbench } from "./useWorkbench";
import { IconButton } from "./ui";

export function SessionMenuButton({ state }: { state: Workbench }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const scope = JSON.stringify([state.hostId, state.session?.id]);
  const [anchor, setAnchor] = useState<{
    scope: string;
    point: { x: number; y: number };
  } | null>(null);
  useEffect(() => setAnchor(null), [scope]);
  const open = anchor?.scope === scope;
  const session = state.session
    ? { ...state.session, hostId: state.hostId }
    : undefined;
  return (
    <>
      <IconButton
        ref={trigger}
        size="sm"
        active={open}
        className={`panel-toggle${open ? " is-active" : ""}`}
        label="当前对话操作"
        title={session ? "当前对话操作" : "发送消息后可操作当前对话"}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!session}
        onClick={() => {
          if (open) {
            setAnchor(null);
            return;
          }
          const button = trigger.current!;
          button.focus();
          const rect = button.getBoundingClientRect();
          setAnchor({ scope, point: { x: rect.right, y: rect.bottom + 4 } });
        }}
      >
        <MoreHorizontal size={15.5} />
      </IconButton>
      {open && session && anchor && (
        <SessionActions
          key={scope}
          session={session}
          agentState={state.agentSessionState(session)}
          state={state}
          point={anchor.point}
          align="end"
          trigger={trigger.current}
          close={() => setAnchor(null)}
        />
      )}
    </>
  );
}
