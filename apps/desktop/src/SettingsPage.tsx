import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Compass,
  Globe2,
  MessageSquare,
  Palette,
  Settings2,
} from "lucide-react";
import { ArchivedChats } from "./ArchivedChats";
import { AgentSettings } from "./AgentSettings";
import { ProviderSettings } from "./ProviderSettings";
import { SSHSettings } from "./SSHSettings";
import type { Workbench } from "./useWorkbench";
import { BrowserSettings } from "./BrowserSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { isHiddenOrInert, useModalBehavior } from "./Modal";
import { NavRow } from "./ui";

const tabs = [
  { id: "agents", label: "连接与 Agent", icon: MessageSquare },
  { id: "ssh", label: "SSH 连接", icon: Globe2 },
  { id: "providers", label: "模型", icon: Settings2 },
  { id: "browser", label: "浏览器", icon: Compass },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "archived", label: "已归档的聊天", icon: Archive },
] as const;

export function SettingsPage({
  state,
  active,
}: {
  state: Workbench;
  active: boolean;
}) {
  const tab = state.settingsTab;
  const setTab = state.setSettingsTab;
  const [agentBusy, setAgentBusy] = useState(false);
  const [providerBusy, setProviderBusy] = useState(false);
  const [sshBusy, setSshBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const navigation = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const busy = agentBusy || providerBusy || sshBusy || archiveBusy;

  useModalBehavior(dialog, active);

  useEffect(() => {
    if (!active) return;
    navigation.current
      ?.querySelector<HTMLButtonElement>(`#settings-tab-${tab}`)
      ?.focus();
  }, [active]);

  function close() {
    if (!busy) {
      state.setModal(state.settingsReturnToProject ? "project" : null);
      state.setSettingsReturnToProject(false);
    }
  }

  return (
    <div
      className="ui-dialog-backdrop settings-modal-backdrop"
      hidden={!active}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) close();
      }}
    >
      <div className="settings-window-drag" data-tauri-drag-region />
      <section
        ref={dialog}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (
            !event.defaultPrevented &&
            !event.nativeEvent.isComposing &&
            event.key === "Escape" &&
            !busy &&
            !isHiddenOrInert(dialog.current) &&
            !document.querySelector(".ssh-password-modal")
          ) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        <aside className="settings-navigation">
          <h1>设置</h1>
          <div
            ref={navigation}
            role="tablist"
            aria-label="设置分类"
            aria-orientation="vertical"
            onKeyDown={(event) => {
              if (
                busy ||
                !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const current = tabs.findIndex((entry) => entry.id === tab);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : (current +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        tabs.length) %
                      tabs.length;
              setTab(tabs[next].id);
              if (!active) return;
              navigation.current
                ?.querySelectorAll<HTMLButtonElement>("button")
                [next]?.focus();
            }}
          >
            {tabs.map(({ id, label, icon: Icon }) => (
              <NavRow
                key={id}
                id={`settings-tab-${id}`}
                role="tab"
                selected={tab === id}
                aria-selected={tab === id}
                aria-controls={`settings-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                disabled={busy}
                icon={<Icon size={15.5} />}
                onClick={() => setTab(id)}
              >
                {label}
              </NavRow>
            ))}
          </div>
        </aside>

        <div className="settings-body">
          <section
            id="settings-panel-agents"
            className="settings-tabpanel"
            role="tabpanel"
            aria-labelledby="settings-tab-agents"
            hidden={tab !== "agents"}
          >
            <AgentSettings
              state={state}
              active={active && tab === "agents"}
              onBusy={setAgentBusy}
              onClose={close}
              closeDisabled={busy}
            />
          </section>
          <section
            id="settings-panel-ssh"
            className="settings-tabpanel"
            role="tabpanel"
            aria-labelledby="settings-tab-ssh"
            hidden={tab !== "ssh"}
          >
            <SSHSettings
              state={state}
              onBusy={setSshBusy}
              onClose={close}
              closeDisabled={busy}
            />
          </section>
          <section
            id="settings-panel-providers"
            className="settings-tabpanel"
            role="tabpanel"
            aria-labelledby="settings-tab-providers"
            hidden={tab !== "providers"}
          >
            <ProviderSettings
              active={active && tab === "providers"}
              onBusy={setProviderBusy}
              onClose={close}
              closeDisabled={busy}
            />
          </section>
          <section
            id="settings-panel-browser"
            className="settings-tabpanel"
            role="tabpanel"
            aria-labelledby="settings-tab-browser"
            hidden={tab !== "browser"}
          >
            <BrowserSettings onClose={close} closeDisabled={busy} />
          </section>
          <section
            id="settings-panel-appearance"
            className="settings-tabpanel"
            role="tabpanel"
            aria-labelledby="settings-tab-appearance"
            hidden={tab !== "appearance"}
          >
            {tab === "appearance" && (
              <AppearanceSettings onClose={close} closeDisabled={busy} />
            )}
          </section>
          <section
            id="settings-panel-archived"
            className="settings-tabpanel"
            role="tabpanel"
            aria-labelledby="settings-tab-archived"
            hidden={tab !== "archived"}
          >
            <ArchivedChats
              state={state}
              active={active && tab === "archived"}
              onBusy={setArchiveBusy}
              onClose={close}
              closeDisabled={busy}
            />
          </section>
        </div>
      </section>
    </div>
  );
}
