import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  Monitor,
  Plus,
  Server,
} from "lucide-react";
import { chooseProjectFolder, message } from "./api";
import { RemoteFolderBrowser } from "./RemoteFolderBrowser";
import type { Workbench } from "./useWorkbench";
import {
  Button,
  Dialog,
  Disclosure,
  Field,
  MenuRow,
  MenuSeparator,
  MenuTitle,
  NoticeBanner,
  TextInput,
  Well,
} from "./ui";

export function ProjectDialog({ state }: { state: Workbench }) {
  const {
    hosts,
    projectHostId,
    setProjectHostId,
    projectPath,
    setProjectPath,
    projectName,
    setProjectName,
    busy,
    error,
    setError,
    setModal,
    addProject,
  } = state;
  const host = hosts.find((h) => h.id === projectHostId) ?? hosts[0];
  const [menu, setMenu] = useState(false);
  const source = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (menu)
      source.current
        ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
        ?.focus();
  }, [menu]);
  const [picking, setPicking] = useState(false);
  const [remoteBrowser, setRemoteBrowser] = useState(false);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const restoreChooseFocus = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (!remoteBrowser && restoreChooseFocus.current) {
      restoreChooseFocus.current = false;
      chooseButton.current?.focus();
    }
  }, [remoteBrowser]);

  function selectFolder(path: string) {
    setProjectPath(path);
    if (!projectName.trim())
      setProjectName(path.split("/").filter(Boolean).at(-1) ?? "项目");
    if (remoteBrowser) restoreChooseFocus.current = true;
    setRemoteBrowser(false);
    setError("");
  }

  async function pickFolder() {
    setMenu(false);
    if (host.ssh) {
      setRemoteBrowser(true);
      return;
    }
    setPicking(true);
    try {
      const path = await chooseProjectFolder();
      if (mounted.current && path) selectFolder(path);
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      if (mounted.current) setPicking(false);
    }
  }

  const disabled = busy || picking;

  return (
    <Dialog
      open
      size="md"
      className="project-modal"
      ariaLabel="创建项目"
      title={remoteBrowser ? "选择文件夹" : "创建项目"}
      description={
        remoteBrowser ? (
          <span
            className="folder-browser-host"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <Server size={13.5} />
            {host.name}
          </span>
        ) : undefined
      }
      busy={disabled}
      onClose={() => setModal(null)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || disabled) return;
        event.preventDefault();
        event.stopPropagation();
        if (menu) {
          setMenu(false);
          event.currentTarget
            .querySelector<HTMLButtonElement>(".source-trigger")
            ?.focus();
        } else if (remoteBrowser) {
          restoreChooseFocus.current = true;
          setRemoteBrowser(false);
        } else setModal(null);
      }}
      footer={
        !remoteBrowser ? (
          <>
            <Button
              variant="subtle"
              size="md"
              disabled={disabled}
              onClick={() => setModal(null)}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="create-project-form"
              variant="primary"
              size="md"
              busy={busy}
              disabled={disabled || !projectPath.trim()}
            >
              {busy ? "正在创建…" : "创建项目"}
            </Button>
          </>
        ) : undefined
      }
    >
      {remoteBrowser ? (
        <RemoteFolderBrowser
          host={host}
          initialPath={projectPath}
          cancel={() => {
            restoreChooseFocus.current = true;
            setRemoteBrowser(false);
          }}
          select={selectFolder}
        />
      ) : (
        <form id="create-project-form" onSubmit={(e) => void addProject(e)}>
          <fieldset
            disabled={disabled}
            style={{
              border: 0,
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3)",
              minWidth: 0,
            }}
          >
            <Field label="项目名称" htmlFor="project-name-field">
              <TextInput
                id="project-name-field"
                autoFocus
                aria-label="项目名称"
                placeholder="项目名称"
                maxLength={100}
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
              />
            </Field>

            <Field label="源文件夹">
              <Well
                className="folder-source"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2)",
                  padding: "10px 12px",
                }}
              >
                <div className="source-selector" ref={source}>
                  <button
                    type="button"
                    className="source-trigger"
                    aria-haspopup="menu"
                    aria-expanded={menu}
                    onClick={() => setMenu((v) => !v)}
                  >
                    在<strong>{host.ssh ? host.name : "此电脑"}</strong>
                    上添加文件夹
                    <ChevronDown size={15} />
                  </button>
                  {menu && (
                    <>
                      <button
                        type="button"
                        className="source-dismiss"
                        aria-label="收起主机选择"
                        onClick={() => setMenu(false)}
                      />
                      <div
                        className="source-menu"
                        role="menu"
                        aria-label="项目所在主机"
                        onKeyDown={(event) => {
                          if (!["ArrowDown", "ArrowUp"].includes(event.key))
                            return;
                          event.preventDefault();
                          const items = Array.from(
                            event.currentTarget.querySelectorAll<HTMLButtonElement>(
                              "button",
                            ),
                          );
                          const index = items.indexOf(
                            document.activeElement as HTMLButtonElement,
                          );
                          items[
                            (index +
                              (event.key === "ArrowDown" ? 1 : -1) +
                              items.length) %
                              items.length
                          ]?.focus();
                        }}
                      >
                        {hosts.map((h, i) => (
                          <div key={h.id}>
                            {i === 1 && <MenuTitle>远程设备</MenuTitle>}
                            <MenuRow
                              role="menuitemradio"
                              aria-checked={h.id === projectHostId}
                              active={h.id === projectHostId}
                              leading={
                                h.ssh ? (
                                  <Server size={15} />
                                ) : (
                                  <Monitor size={15} />
                                )
                              }
                              trailing={
                                h.id === projectHostId ? (
                                  <Check size={14.5} />
                                ) : undefined
                              }
                              onClick={() => {
                                if (h.id !== projectHostId) {
                                  setProjectHostId(h.id);
                                  setProjectPath("");
                                  setError("");
                                }
                                setMenu(false);
                                source.current
                                  ?.querySelector<HTMLButtonElement>(
                                    ".source-trigger",
                                  )
                                  ?.focus();
                              }}
                            >
                              {h.ssh ? h.name : "此电脑"}
                            </MenuRow>
                          </div>
                        ))}
                        <MenuSeparator />
                        <MenuRow
                          role="menuitem"
                          leading={<Plus size={15} />}
                          onClick={() => {
                            setError("");
                            state.setSettingsTab("ssh");
                            state.setSettingsReturnToProject(true);
                            setModal("settings");
                          }}
                        >
                          添加远程
                        </MenuRow>
                      </div>
                    </>
                  )}
                </div>

                {projectPath && (
                  <div className="chosen-folder">
                    <Folder size={17} />
                    <div>
                      <strong>
                        {projectPath.split("/").filter(Boolean).at(-1) ?? "/"}
                      </strong>
                      <span title={projectPath}>{projectPath}</span>
                    </div>
                  </div>
                )}

                <div>
                  <Button
                    ref={chooseButton}
                    variant="subtle"
                    size="md"
                    busy={picking}
                    leading={!picking ? <FolderPlus size={15} /> : undefined}
                    onClick={() => void pickFolder()}
                  >
                    {projectPath ? "更换文件夹" : "添加"}
                  </Button>
                </div>
              </Well>
            </Field>

            <Disclosure title="输入文件夹路径">
              <TextInput
                aria-label="项目绝对路径"
                monospace
                placeholder={
                  host.ssh
                    ? "/home/user/projects/my-project"
                    : "/Users/you/projects/my-project"
                }
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
              />
            </Disclosure>

            {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
          </fieldset>
        </form>
      )}
    </Dialog>
  );
}
