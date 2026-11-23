import { ImageGallery } from "./ImageGallery";
import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  Box,
  ChevronRight,
  FileText,
  FileVideo,
  Folder,
  Plus,
  Search,
  X,
} from "lucide-react";
import { chooseReferencePath, message, request } from "./api";
import type { AgentSlashCommand, FileEntry } from "./protocol";
import type { ModelPickerHandle } from "./ModelPicker";
import {
  commandTitle,
  composerTrigger,
  appCommandAction,
  type AppCommandAction,
  hasCommandArguments,
  isNativeSubagentCommand,
  supportsSideChatAgent,
  subagentPanelAliases,
  subagentPanelArgumentNotice,
  unifiedComposerCommands,
  referencePrompt,
  type ComposerTrigger,
} from "./composerActions";

import {
  MAX_PASTE_FILE,
  clipboardFilePaths,
  importClipboardFile,
  isLongPaste,
  storePastedFile,
  type ComposerReference,
} from "./pasteAttachments";
import { skillCreatorPrompt } from "./skillCreator";
import { dragHasFiles } from "./fileDrag";
import { AttachmentImage } from "./AttachmentImage";
import { referenceKind } from "./referenceMessage";
import { annotationPrompt, type Annotation } from "./annotations";
import {
  InlineReferenceInput,
  type InlineReferenceInputHandle,
  type InlineSelection,
} from "./InlineReferenceInput";

export function composerReferenceScope(
  hostId: string,
  projectId: string | undefined,
  agent: string,
  projectPath?: string,
): string {
  return projectPath === undefined
    ? `${hostId}:${projectId}:${agent}`
    : `${hostId}:${projectId}:${agent}:${projectPath}`;
}

export function resolveComposerReferences(
  references: { scope: string; entries: ComposerReference[] },
  hostId: string,
  projectId: string | undefined,
  agent: string,
  projectPath?: string,
): ComposerReference[] {
  const scope = composerReferenceScope(hostId, projectId, agent, projectPath);
  if (references.scope === scope) return references.entries;
  const projectScopePrefix = `${hostId}:${projectId}:${agent}:`;
  if (
    projectPath !== undefined &&
    references.scope.startsWith(projectScopePrefix)
  ) {
    return references.entries.filter((entry) => entry.path.startsWith("/"));
  }
  return [];
}

const EXPANDED_TOOLBAR_CONTROL =
  '.composer-toolbar [aria-haspopup][aria-expanded="true"], .composer-toolbar [role="combobox"][aria-expanded="true"]';

export interface ComposerPrediction {
  /** Stable source identity, independent of the draft and suggestion text. */
  id: string;
  text: string;
}
interface Props {
  prediction?: ComposerPrediction | null;
  predictionBlocked?: boolean;
  onDismissPrediction?: (id: string) => void;
  skillCreator?: boolean;
  onRemoveSkillCreator?: () => void;
  focusRequest?: number;
  inputLabel?: string;
  sideChat?: boolean;
  context?: ReactNode;
  hasContext?: boolean;
  annotations?: Annotation[];
  referenceState?: { scope: string; entries: ComposerReference[] };
  onReferencesChange?: (value: {
    scope: string;
    entries: ComposerReference[];
  }) => void;
  agent: string;
  hostId: string;
  projectId?: string;
  projectPath?: string;
  sessionId?: string;
  connected: boolean;
  disabled: boolean;
  sending: boolean;
  /** Presentation only: keep the submitted content until acknowledgement. */
  concealSubmitted?: boolean;
  hidden: boolean;
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  onSubmit: (prompt: string) => Promise<boolean>;
  onOpenSideChat?: (draft?: string) => boolean | Promise<boolean>;
  onOpenSubagents?: () => void;
  onOpenModelSettings?: ModelPickerHandle["openMenu"];
  toolbar: (
    submit: () => void,
    hasContent: boolean,
    localNavigation: AppCommandAction | null,
  ) => ReactNode;
}
type Option = {
  id: string;
  label: string;
  detail: string;
  icon: "file" | "folder" | "back" | "command";
  choose: () => void;
};
export function Composer(props: Props) {
  const {
    agent,
    hostId,
    projectId,
    projectPath,
    sessionId,
    connected,
    disabled,
    sending,
    sideChat = false,
    concealSubmitted = false,
    hidden,
    value,
    onChange,
    onSubmit,
    placeholder,
    toolbar,
  } = props;
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const inlineInput = useRef<InlineReferenceInputHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickerContext = useRef<string | null>(null);
  const [addMenu, setAddMenu] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [retryFiles, setRetryFiles] = useState<File[]>([]);
  useEffect(() => {
    if (props.focusRequest && !props.hidden)
      (inlineInput.current ?? input.current)?.focus();
  }, [props.focusRequest, props.hidden]);
  // The conceal remount drops focus; restore it when the submission resolves
  // unless the user has already moved focus elsewhere.
  const concealedBefore = useRef(concealSubmitted);
  useEffect(() => {
    const wasConcealed = concealedBefore.current;
    concealedBefore.current = concealSubmitted;
    if (
      wasConcealed &&
      !concealSubmitted &&
      !hidden &&
      document.activeElement === document.body
    )
      (inlineInput.current ?? input.current)?.focus();
  }, [concealSubmitted, hidden]);
  const composing = useRef(false);
  const [imeActive, setImeActive] = useState(false);
  const ghost = useRef<HTMLDivElement>(null);
  const [dismissedPrediction, setDismissedPrediction] = useState<string | null>(
    null,
  );
  const [pickingFiles, setPickingFiles] = useState(false);
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () =>
      setToolbarMenuOpen(!!element.querySelector(EXPANDED_TOOLBAR_CONTROL));
    const observer = new MutationObserver(update);
    observer.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-expanded"],
    });
    update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = fileInput.current;
    const cancel = () => {
      pickerContext.current = null;
      setPickingFiles(false);
    };
    element?.addEventListener("cancel", cancel);
    return () => element?.removeEventListener("cancel", cancel);
  }, []);
  const submitting = useRef(false);
  const scope = composerReferenceScope(hostId, projectId, agent, projectPath);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [localReferences, setLocalReferences] = useState<{
    scope: string;
    entries: ComposerReference[];
  }>({ scope, entries: [] });
  const references = props.referenceState ?? localReferences;
  const setReferences = props.onReferencesChange ?? setLocalReferences;
  const attached = resolveComposerReferences(
    references,
    hostId,
    projectId,
    agent,
    projectPath,
  );
  const inlineAttached = attached.filter((entry) => !entry.attachmentKind);
  const separateAttached = attached.filter((entry) => !!entry.attachmentKind);
  const inlineMode = !concealSubmitted && !!inlineAttached.length;
  // The native editor may be replaced after the last reference is removed.
  // Restore the caret only after React has mounted the destination editor.
  const editorContext = JSON.stringify([scope, sessionId]);
  const pendingCaret = useRef<{
    context: string;
    offset: number;
    afterPath?: string;
  } | null>(null);
  function restoreCaret(offset: number, afterPath?: string) {
    pendingCaret.current = { context: editorContext, offset, afterPath };
  }
  useLayoutEffect(() => {
    composing.current = false;
    setImeActive(false);
  }, [editorContext, inlineMode, concealSubmitted]);
  function inputSelection(): InlineSelection | null {
    if (inlineMode && inlineInput.current)
      return inlineInput.current.selection();
    const element = input.current;
    return element
      ? {
          start: element.selectionStart,
          end: element.selectionEnd,
          afterPath: undefined,
          selectedPaths: [],
        }
      : {
          start: value.length,
          end: value.length,
          afterPath: undefined,
          selectedPaths: [],
        };
  }
  function focusInput(offset?: number, afterPath?: string) {
    if (inlineInput.current) {
      if (offset === undefined) inlineInput.current.focus();
      else inlineInput.current.setCaret(offset, afterPath);
    } else {
      input.current?.focus();
      if (offset !== undefined)
        input.current?.setSelectionRange(offset, offset);
    }
  }
  const [pasting, setPasting] = useState(false);
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (!caret) return;
    if (
      caret.context !== editorContext ||
      hidden ||
      disabled ||
      sending ||
      concealSubmitted
    ) {
      pendingCaret.current = null;
      return;
    }
    if (pasting) return;
    pendingCaret.current = null;
    focusInput(caret.offset, caret.afterPath);
  });
  const [pasteProgress, setPasteProgress] = useState("");
  const pasteOperation = useRef(0);
  const pasteBusy = useRef(false);
  const latestValue = useRef(value);
  latestValue.current = value;
  useEffect(() => {
    pasteOperation.current++;
    pasteBusy.current = false;
    setPasting(false);
    setPasteProgress("");
    setRetryFiles([]);
    pickerContext.current = null;
    setPickingFiles(false);
    setDragging(false);
    dragDepth.current = 0;
    return () => {
      pasteOperation.current++;
    };
  }, [scope, sessionId, hidden, disabled, sending, connected]);
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [browse, setBrowse] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(0);
  const [commands, setCommands] = useState<AgentSlashCommand[]>([]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [external, setExternal] = useState(false);
  const [externalPath, setExternalPath] = useState("");
  const [externalError, setExternalError] = useState("");
  const [externalBusy, setExternalBusy] = useState(false);
  const referenceOperation = useRef(0);
  const currentContext = useRef("");
  const commandContext = `${scope}:${sessionId}:${disabled}:${sending}:${hidden}:${connected}`;
  currentContext.current = commandContext;
  const modelCommandGeneration = useRef(0);
  useLayoutEffect(
    () => () => {
      modelCommandGeneration.current++;
    },
    [commandContext, value],
  );
  useEffect(
    () => () => {
      referenceOperation.current++;
    },
    [],
  );
  const [revision, retry] = useState(0);
  const listId = useId();
  const menu =
    !disabled &&
    !sending &&
    !hidden &&
    (addMenu || browse !== null || trigger !== null);
  const predictionKey = props.prediction
    ? JSON.stringify([editorContext, props.prediction.id])
    : null;
  const visiblePrediction =
    props.prediction?.text &&
    value === "" &&
    connected &&
    !disabled &&
    !sending &&
    !hidden &&
    !concealSubmitted &&
    !props.predictionBlocked &&
    !props.skillCreator &&
    !(props.hasContext ?? !!props.context) &&
    !props.annotations?.length &&
    !attached.length &&
    !menu &&
    !toolbarMenuOpen &&
    !pasting &&
    !retryFiles.length &&
    !externalBusy &&
    !pickingFiles &&
    !dragging &&
    !imeActive &&
    dismissedPrediction !== predictionKey
      ? props.prediction
      : null;
  function dismissPrediction() {
    if (!visiblePrediction) return;
    setDismissedPrediction(predictionKey);
    props.onDismissPrediction?.(visiblePrediction.id);
  }
  useLayoutEffect(() => {
    const element = input.current;
    if (!element || hidden) return;
    function fit() {
      if (!element) return;
      element.style.height = "auto";
      element.style.height = `${Math.min(Math.max(element.scrollHeight, ghost.current?.scrollHeight ?? 0), 200)}px`;
    }
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [value, hidden, concealSubmitted, inlineMode, visiblePrediction?.text]);
  const mode = addMenu ? "add" : browse !== null ? "files" : trigger?.kind;
  const query = browse !== null ? search : (trigger?.query ?? "");
  const slash = query.lastIndexOf("/");
  const path =
    mode === "files"
      ? (browse ?? (slash < 0 ? "" : query.slice(0, slash)))
      : "";
  const filter = (
    browse !== null ? search : slash < 0 ? query : query.slice(slash + 1)
  ).toLowerCase();
  function close() {
    setAddMenu(false);
    referenceOperation.current++;
    setExternal(false);
    setExternalPath("");
    setExternalError("");
    setExternalBusy(false);
    setTrigger(null);
    setBrowse(null);
    setSearch("");
  }
  useEffect(() => {
    close();
    setCommands([]);
    setNotice("");
    // A different project never inherits references; moving a project directory
    // drops stale project-relative references while keeping absolute attachments.
    if (references.scope !== scope) {
      setReferences({
        scope,
        entries: resolveComposerReferences(
          references,
          hostId,
          projectId,
          agent,
          projectPath,
        ),
      });
    }
  }, [scope]);
  useEffect(() => {
    if (!sending && !props.referenceState) {
      setReferences({ scope, entries: [] });
      close();
    }
  }, [sessionId]);
  useEffect(() => {
    if (hidden || disabled || sending) close();
  }, [hidden, disabled, sending]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);
  useEffect(() => {
    if (!menu || mode === "add") return;
    let disposed = false;
    setEntries([]);
    setCommands([]);
    setError("");
    if (sideChat && mode === "commands") {
      setLoading(false);
      return;
    }
    setLoading(true);
    if (!connected || !projectId) {
      setError("请先连接项目所在主机");
      setLoading(false);
      return;
    }
    // Debounce typed paths; the server enforces canonical project containment.
    const timer = window.setTimeout(() => {
      void request(
        hostId,
        mode === "commands"
          ? { method: "agent_commands", project_id: projectId, agent }
          : { method: "files", project_id: projectId, path },
      )
        .then((response) => {
          if (disposed) return;
          if (mode === "commands" && response.kind === "agent_commands")
            setCommands(response.commands);
          else if (mode === "files" && response.kind === "files")
            setEntries(response.entries);
          else throw new Error("响应格式不匹配，请更新项目所在主机的 Server");
        })
        .catch((cause) => {
          if (!disposed) setError(message(cause));
        })
        .finally(() => {
          if (!disposed) setLoading(false);
        });
    }, 120);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [
    menu,
    mode,
    hostId,
    projectId,
    projectPath,
    agent,
    connected,
    path,
    revision,
    sideChat,
  ]);
  useEffect(() => {
    setSelected(0);
  }, [query, path, mode, entries, commands]);
  useEffect(() => {
    root.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  function replaceTrigger(
    replacement: string,
    entry?: FileEntry,
    range?: InlineSelection,
  ) {
    const selection = range ?? inputSelection();
    if (!selection) return false;
    const completing = range ? null : trigger;
    const start = completing?.start ?? selection.start;
    const end = completing?.end ?? selection.end;
    const afterIndex = attached.findIndex(
      (item) => item.path === selection.afterPath,
    );
    const selectedPaths = new Set(selection.selectedPaths);
    const next = value.slice(0, start) + replacement + value.slice(end);
    const caret = start + replacement.length;
    const delta = replacement.length - (end - start);
    let afterPath: string | undefined;
    if (entry || inlineAttached.length) {
      const shifted = attached.flatMap((item, index) => {
        if (selectedPaths.has(item.path)) return [];
        if (item.attachmentKind) return [item];
        const offset = Math.max(
          0,
          Math.min(value.length, item.inlineOffset ?? value.length),
        );
        const staysBefore =
          offset < start ||
          (offset === start && (completing !== null || index <= afterIndex));
        if (staysBefore && offset === caret) afterPath = item.path;
        return [
          {
            ...item,
            inlineOffset: staysBefore
              ? offset
              : offset >= end
                ? offset + delta
                : caret,
          },
        ];
      });
      if (entry && !shifted.some((item) => item.path === entry.path)) {
        shifted.push({ ...entry, inlineOffset: caret });
        afterPath = entry.path;
      }
      setReferences({ scope, entries: shifted });
    }
    restoreCaret(caret, afterPath);
    onChange(next);
    return true;
  }
  function attach(entry: FileEntry) {
    if (attached.length >= 20) {
      setNotice("最多添加 20 个文件或目录引用");
      return;
    }
    replaceTrigger("", entry);
    close();
    setNotice("");
  }
  async function addExternal(directory?: boolean) {
    if (externalBusy || !connected || !projectId) return;
    const context = currentContext.current;
    const operation = ++referenceOperation.current;
    const valid = () =>
      context === currentContext.current &&
      operation === referenceOperation.current;
    setExternalBusy(true);
    setExternalError("");
    try {
      const chosen =
        directory === undefined
          ? externalPath.trim()
          : await chooseReferencePath(directory);
      if (!valid() || !chosen) return;
      if (!chosen.startsWith("/"))
        throw new Error("请输入文件或目录的绝对路径，例如 /home/user/docs");
      const response = await request(hostId, {
        method: "resolve_reference",
        project_id: projectId,
        path: chosen,
      });
      if (!valid()) return;
      if (response.kind !== "file_reference")
        throw new Error("无法解析引用，请更新项目所在主机的 Server");
      attach(response.entry);
    } catch (cause) {
      if (valid()) setExternalError(message(cause));
    } finally {
      if (valid()) setExternalBusy(false);
    }
  }
  function navigate(next: string) {
    setBrowse(next);
    setSearch("");
  }
  function command(name: string) {
    replaceTrigger(`/${name} `);
    close();
  }
  const panelAliases = [
    ...subagentPanelAliases,
    ...commands.filter(isNativeSubagentCommand).map((command) => command.name),
  ];
  const sideAgent = !sideChat && supportsSideChatAgent(agent);
  const nativeCommands = sideChat ? [] : commands;
  const action = appCommandAction(value, nativeCommands, sideAgent);
  const localNavigation =
    sideChat && action !== "model" && action !== "effort" ? null : action;
  const options: Option[] =
    mode === "commands"
      ? unifiedComposerCommands(
          nativeCommands,
          sideAgent,
          !!props.onOpenSideChat,
        )
          .filter(
            (item) =>
              !sideChat ||
              item.ui_action === "model" ||
              item.ui_action === "effort",
          )
          .filter((item) =>
            `${item.name} ${commandTitle(item, agent)} ${item.description} ${item.ui_action === "subagents" ? panelAliases.join(" ") : ""}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .sort(
            (a, b) =>
              Number(b.name.toLowerCase() === query.toLowerCase()) -
                Number(a.name.toLowerCase() === query.toLowerCase()) ||
              Number(!!b.ui_action) - Number(!!a.ui_action),
          )
          .map((item) => ({
            id: item.name,
            label: commandTitle(item, agent),
            detail: `${item.argument_hint} ${item.description}`.trim(),
            icon: "command",
            choose: () => command(item.name),
          }))
      : [
          ...(path
            ? [
                {
                  id: "parent",
                  label: "上一级",
                  detail: path,
                  icon: "back" as const,
                  choose: () =>
                    navigate(path.split("/").slice(0, -1).join("/")),
                },
              ]
            : []),
          ...(!loading && !error && path
            ? [
                {
                  id: "attach-folder",
                  label: "引用此文件夹",
                  detail: path,
                  icon: "folder" as const,
                  choose: () =>
                    attach({
                      name: path.split("/").at(-1)!,
                      path,
                      directory: true,
                    }),
                },
              ]
            : []),
          ...(!loading && !error
            ? entries
                .filter((item) => item.name.toLowerCase().includes(filter))
                .map((item) => ({
                  id: `entry:${item.path}`,
                  label: item.name,
                  detail: item.directory
                    ? "Tab 引用"
                    : item.path === item.name
                      ? ""
                      : item.path,
                  icon: item.directory
                    ? ("folder" as const)
                    : ("file" as const),
                  choose: () =>
                    item.directory ? navigate(item.path) : attach(item),
                }))
            : []),
        ];
  const index = Math.min(selected, Math.max(0, options.length - 1));
  const autocomplete = {
    "aria-autocomplete": "list" as const,
    "aria-controls": menu && !addMenu ? listId : undefined,
    "aria-expanded": menu && !addMenu,
    "aria-activedescendant":
      menu && !addMenu && options.length ? `${listId}-${index}` : undefined,
  };
  useEffect(() => {
    if (addMenu)
      root.current
        ?.querySelector<HTMLButtonElement>(".composer-add-menu button")
        ?.focus();
  }, [addMenu]);
  async function storeAttachments(
    files: File[],
    paths: string[],
    valid: () => boolean,
    longText = false,
    insertionOffset = value.length,
  ) {
    if (!connected || !projectId)
      throw new Error("请先连接项目所在主机，再添加附件");
    const count = paths.length || files.length;
    if (attached.length + count > 20)
      throw new Error("最多添加 20 个附件或引用");
    if (files.some((file) => file.size > MAX_PASTE_FILE))
      throw new Error("单个附件不能超过 64 MiB");
    const added: ComposerReference[] = [];
    for (let i = 0; i < count; i++) {
      if (!valid()) return;
      const label = `正在保存附件 ${i + 1}/${count}`;
      setPasteProgress(`${label}…`);
      const entry = paths.length
        ? await importClipboardFile(hostId, projectId, paths[i])
        : await storePastedFile(
            files[i],
            hostId,
            valid,
            (percent) => {
              if (valid())
                setPasteProgress(
                  percent === 100 && hostId !== "local"
                    ? `正在上传到远程主机 ${i + 1}/${count}…`
                    : `${label} · ${percent}%`,
                );
            },
            longText ? "text" : undefined,
          );
      if (!valid()) return;
      added.push(
        entry.attachmentKind
          ? entry
          : { ...entry, inlineOffset: insertionOffset },
      );
    }
    const pathsSeen = new Set(attached.map((entry) => entry.path));
    const unique = added.filter((entry) => {
      if (pathsSeen.has(entry.path)) return false;
      pathsSeen.add(entry.path);
      return true;
    });
    const lastInline = unique.filter((entry) => !entry.attachmentKind).at(-1);
    if (lastInline) restoreCaret(insertionOffset, lastInline.path);
    setReferences({ scope, entries: [...attached, ...unique] });
    return !!lastInline;
  }
  async function addFiles(files: File[], retrying = false) {
    if (
      !files.length ||
      disabled ||
      sending ||
      hidden ||
      pasteBusy.current ||
      externalBusy
    )
      return;
    if (retryFiles.length && !retrying) {
      setNotice("请先重试或移除未添加附件");
      return;
    }
    const context = currentContext.current;
    const operation = ++pasteOperation.current;
    const valid = () =>
      context === currentContext.current &&
      operation === pasteOperation.current;
    pasteBusy.current = true;
    setPasting(true);
    setNotice("");
    setRetryFiles([]);
    close();
    try {
      await storeAttachments(files, [], valid);
    } catch (cause) {
      if (valid()) {
        setNotice(`${message(cause)}（未添加本次附件，草稿已保留）`);
        setRetryFiles(files);
      }
    } finally {
      if (valid()) {
        pasteBusy.current = false;
        setPasting(false);
        setPasteProgress("");
        focusInput();
      }
    }
  }
  function dropFiles(event: React.DragEvent<HTMLDivElement>) {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragging(false);
    if (disabled || sending || hidden || pasteBusy.current || externalBusy)
      return;
    const directories = Array.from(event.dataTransfer.items ?? []).some(
      (item) => item.webkitGetAsEntry?.()?.isDirectory,
    );
    if (directories) {
      setNotice(
        "暂不支持上传文件夹，请选择其中的文件；工作区目录可通过引用添加",
      );
      return;
    }
    void addFiles(Array.from(event.dataTransfer.files));
  }
  async function paste(event: React.ClipboardEvent<HTMLElement>) {
    event.preventDefault();
    if (
      disabled ||
      sending ||
      pasteBusy.current ||
      externalBusy ||
      composing.current
    )
      return;
    const files = Array.from(event.clipboardData.files);
    const text = event.clipboardData.getData("text/plain");
    const selection = inputSelection();
    if (!selection) return;
    let restoresCaret = false;
    const context = currentContext.current;
    const operation = ++pasteOperation.current;
    const valid = () =>
      context === currentContext.current &&
      operation === pasteOperation.current;
    pasteBusy.current = true;
    setPasting(true);
    setNotice("");
    setPasteProgress("正在读取剪贴板…");
    close();
    try {
      const nativePaths = await clipboardFilePaths();
      // A clipboard manager may replace the pasteboard after the paste event.
      // Keep the event's text snapshot authoritative unless it describes files.
      const textLines = text.trim().split(/\r?\n/);
      const paths =
        !text.trim() ||
        (textLines.length === nativePaths.length &&
          nativePaths.every((path, index) => {
            const line = textLines[index];
            return (
              line === path ||
              line === path.split("/").at(-1) ||
              line === `file://${path}` ||
              line === `file://${encodeURI(path)}`
            );
          }))
          ? nativePaths
          : [];
      if (!valid()) return;
      const longText = !paths.length && !files.length && isLongPaste(text);
      if (!paths.length && !files.length && !longText) {
        if (!text) throw new Error("剪贴板中没有可粘贴的文本或文件");
        if (latestValue.current !== value)
          throw new Error("输入内容已变化，请重新粘贴");
        restoresCaret = replaceTrigger(
          text.replace(/\r\n?/g, "\n"),
          undefined,
          selection,
        );
        return;
      }
      const items = longText
        ? [
            new File([text], `粘贴文本-${Date.now()}.txt`, {
              type: "text/plain",
            }),
          ]
        : files;
      restoresCaret = !!(await storeAttachments(
        items,
        paths,
        valid,
        longText,
        selection.start,
      ));
    } catch (cause) {
      if (valid())
        setNotice(`${message(cause)}（未添加本次附件，剪贴板内容未改变）`);
    } finally {
      if (valid()) {
        pasteBusy.current = false;
        setPasting(false);
        setPasteProgress("");
        if (!restoresCaret)
          requestAnimationFrame(() => {
            if (valid()) focusInput();
          });
      }
    }
  }
  async function submit() {
    if (
      disabled ||
      sending ||
      submitting.current ||
      pasteBusy.current ||
      retryFiles.length
    )
      return;
    if (localNavigation) {
      await openAppCommand(localNavigation);
      return;
    }
    if (sideChat && value.trimStart().startsWith("/")) {
      setNotice("侧边聊天暂不支持 Agent 原生命令，请输入普通消息。");
      return;
    }
    if (value.trimStart().startsWith("/") && props.annotations?.length) {
      setNotice("请先移除注释，再使用 Agent 原生命令。");
      return;
    }
    if (
      agent !== "opencode" &&
      value.trimStart().startsWith("/") &&
      attached.length
    ) {
      setNotice("Agent 命令使用原生参数，请先移除项目引用，避免改变命令含义。");
      return;
    }
    if (!value.trim() && !attached.length && !props.hasContext) return;
    const owner = scope;
    const commandContext = currentContext.current;
    submitting.current = true;
    close();
    const nativeCommand = value.trim().match(/^\/([^\s]+)(?:\s|$)/)?.[1];
    try {
      let catalog = commands;
      if (
        nativeCommand &&
        agent !== "opencode" &&
        !catalog.some((command) => command.name === nativeCommand)
      ) {
        const response = await request(hostId, {
          method: "agent_commands",
          agent,
          project_id: projectId!,
        });
        if (response.kind !== "agent_commands")
          throw new Error("无法读取原生命令列表");
        catalog = response.commands;
        if (
          currentScope.current !== owner ||
          currentContext.current !== commandContext
        )
          return;
      }
      const uiAction = appCommandAction(value, catalog, sideAgent);
      if (uiAction) {
        await openAppCommand(uiAction);
        return;
      }
      if (
        attached.length &&
        catalog.some((command) => command.name === nativeCommand)
      ) {
        setNotice(
          "Agent 命令使用原生参数，请先移除项目引用，避免改变命令含义。",
        );
        return;
      }
      const prompt = referencePrompt(
        annotationPrompt(
          props.skillCreator ? skillCreatorPrompt(value) : value,
          props.annotations ?? [],
        ),
        attached,
      );
      if (
        props.annotations?.length &&
        new TextEncoder().encode(prompt).length > 128 * 1024
      )
        throw new Error("消息与注释总内容过长，请缩短后再发送。");
      if (await onSubmit(prompt)) {
        if (!props.referenceState && currentScope.current === owner)
          setReferences({ scope: owner, entries: [] });
        setNotice("");
      }
    } catch (cause) {
      if (currentScope.current === owner) setNotice(message(cause));
    } finally {
      submitting.current = false;
    }
  }
  async function openAppCommand(action: AppCommandAction) {
    close();
    if (action === "side") {
      if (!props.onOpenSideChat) {
        setNotice(
          "侧边聊天需要已开始的 Claude Code、Codex 或 Traex 主会话，且执行主机的 Server 须支持此功能。",
        );
        return;
      }
      const owner = currentContext.current;
      submitting.current = true;
      try {
        if (
          (await props.onOpenSideChat(value.trim().replace(/^\/\S+\s*/, ""))) &&
          currentContext.current === owner &&
          latestValue.current === value
        ) {
          onChange("");
          setNotice("");
        }
      } finally {
        submitting.current = false;
      }
      return;
    }
    if (action === "subagents") {
      if (!props.onOpenSubagents) {
        setNotice("无法打开子智能体面板");
        return;
      }
      props.onOpenSubagents();
    } else {
      const generation = modelCommandGeneration.current;
      const isCurrent = () => modelCommandGeneration.current === generation;
      const result = props.onOpenModelSettings
        ? props.onOpenModelSettings(action, isCurrent)
        : "无法打开模型设置";
      const error = result instanceof Promise ? await result : result;
      if (!isCurrent()) return;
      if (error) {
        setNotice(error);
        return;
      }
    }
    if (hasCommandArguments(value))
      setNotice(
        action === "subagents"
          ? subagentPanelArgumentNotice
          : `已打开${action === "model" ? "模型" : "思考强度"}菜单；请在菜单中选择，输入内容已保留。`,
      );
    else {
      onChange("");
      setNotice("");
    }
  }
  function keys(event: React.KeyboardEvent) {
    if (
      event.nativeEvent.isComposing ||
      composing.current ||
      event.keyCode === 229
    )
      return;
    if (menu) {
      if (addMenu && event.key !== "Escape") return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        focusInput();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected(
          (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
            Math.max(1, options.length),
        );
        return;
      }
      if (
        (event.key === "Enter" && !event.shiftKey) ||
        (event.key === "Tab" &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey)
      ) {
        event.preventDefault();
        const option = options[index];
        const entry = entries.find(
          (item) => `entry:${item.path}` === option?.id,
        );
        if (event.key === "Tab" && entry?.directory) attach(entry);
        else option?.choose();
        return;
      }
    }
    if (
      !menu &&
      visiblePrediction &&
      !submitting.current &&
      !pasteBusy.current &&
      !root.current?.querySelector(EXPANDED_TOOLBAR_CONTROL)
    ) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissPrediction();
        return;
      }
      if (
        event.key === "Tab" &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        latestValue.current === "" &&
        input.current?.value === ""
      ) {
        event.preventDefault();
        dismissPrediction();
        replaceTrigger(visiblePrediction.text, undefined, {
          start: 0,
          end: 0,
          selectedPaths: [],
        });
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }
  return (
    <div
      className={`composer ${!connected ? "disabled" : ""}${dragging ? " composer-dragging" : ""}`}
      ref={root}
      onDragEnter={(event) => {
        if (!dragHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        if (
          !disabled &&
          !sending &&
          !hidden &&
          !pasteBusy.current &&
          !externalBusy
        ) {
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragOver={(event) => {
        if (!dragHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect =
          disabled || sending || hidden || pasting || externalBusy
            ? "none"
            : "copy";
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={dropFiles}
    >
      <input
        type="file"
        multiple
        hidden
        ref={fileInput}
        aria-label="选择本机附件"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (pickerContext.current === currentContext.current)
            void addFiles(files);
          pickerContext.current = null;
          setPickingFiles(false);
        }}
      />
      {dragging && (
        <div className="composer-drop-hint" role="status">
          松开以添加附件
        </div>
      )}
      {menu && addMenu && (
        <div
          className="composer-menu composer-add-menu"
          role="menu"
          aria-label="添加文件"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              keys(event);
              return;
            }
            if (event.key === "Tab") {
              close();
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
              );
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              buttons[
                (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                  buttons.length
              ]?.focus();
            }
          }}
        >
          <button
            role="menuitem"
            disabled={
              !connected || !projectId || pasting || !!retryFiles.length
            }
            onClick={() => {
              pickerContext.current = currentContext.current;
              setPickingFiles(true);
              close();
              fileInput.current?.click();
            }}
          >
            <FileText size={16} />
            <span>
              添加本机文件…<small>从这台电脑选择文件，可多选</small>
            </span>
          </button>
          <button
            role="menuitem"
            disabled={!connected || !projectId || pasting}
            onClick={() => {
              close();
              setBrowse("");
              focusInput();
            }}
          >
            <Folder size={16} />
            <span>
              引用工作区文件…
              <small>
                {hostId === "local"
                  ? "浏览本机工作区，仅引用路径"
                  : "浏览远程工作区，仅引用路径"}
              </small>
            </span>
          </button>
        </div>
      )}
      {menu && !addMenu && (
        <div
          className={`composer-menu${mode === "commands" ? " composer-command-menu" : ""}`}
          onKeyDown={keys}
        >
          <div className="composer-menu-heading">
            <span>{mode === "commands" ? "命令" : "引用工作区文件"}</span>
            <span>
              {mode === "commands"
                ? agent === "claude"
                  ? "Claude Code"
                  : agent
                : "↑↓ 选择 · Enter 确认 · Esc 关闭"}
            </span>
          </div>
          {external && mode === "files" ? (
            <div
              className="composer-external-path"
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  close();
                  focusInput();
                }
                if (
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  void addExternal();
                }
              }}
            >
              <label className="composer-menu-search">
                <Folder size={16} aria-hidden="true" />
                <input
                  autoFocus
                  aria-label="引用绝对路径"
                  placeholder={
                    hostId === "local"
                      ? "/Users/你/文件或目录"
                      : "/home/user/文件或目录（远程主机）"
                  }
                  value={externalPath}
                  onChange={(event) => setExternalPath(event.target.value)}
                  disabled={externalBusy}
                />
              </label>
              <p className="composer-menu-path">
                {hostId === "local" ? "本机" : "当前远程主机"}上的绝对路径 · 由
                Agent 按当前权限读取
              </p>
              <button
                disabled={externalBusy || !externalPath.trim() || !connected}
                onClick={() => void addExternal()}
              >
                {externalBusy ? "正在检查…" : "添加引用"}
              </button>
            </div>
          ) : (
            browse !== null && (
              <label className="composer-menu-search">
                <Search size={16} aria-hidden="true" />
                <input
                  autoFocus
                  aria-label="搜索当前目录"
                  placeholder="搜索当前目录…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-controls={listId}
                  aria-activedescendant={
                    options.length ? `${listId}-${index}` : undefined
                  }
                />
              </label>
            )
          )}
          {mode === "files" && !external && (
            <div className="composer-menu-path">
              {path || "项目根目录"} · 引用路径，供 Agent 按需读取
            </div>
          )}
          <div
            hidden={external && mode === "files"}
            role="listbox"
            id={listId}
            aria-label={mode === "commands" ? "斜杠命令" : "项目引用"}
            className="composer-menu-list"
          >
            {options.map((option, i) => {
              const Icon =
                option.icon === "folder"
                  ? Folder
                  : option.icon === "file"
                    ? FileText
                    : option.icon === "back"
                      ? ArrowLeft
                      : null;
              return (
                <div
                  key={option.id}
                  id={`${listId}-${i}`}
                  title={
                    option.id.startsWith("entry:")
                      ? option.id.slice(6)
                      : `${option.label} ${option.detail}`
                  }
                  role="option"
                  aria-selected={i === index}
                  onMouseEnter={() => setSelected(i)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={option.choose}
                  className="composer-menu-option"
                >
                  {Icon && <Icon size={17} />}
                  <span>
                    {option.icon === "command" ? (
                      <>
                        <span className="composer-command-title">
                          {option.label}
                        </span>
                        <span className="composer-command-id">
                          /{option.id}
                        </span>
                      </>
                    ) : (
                      option.label
                    )}
                  </span>
                  <small>{option.detail}</small>
                  {option.icon === "folder" &&
                    option.id.startsWith("entry:") && (
                      <ChevronRight size={15} />
                    )}
                </div>
              );
            })}
            {loading && (
              <p role="status">
                {mode === "commands"
                  ? "正在读取 Agent 原生命令…"
                  : "正在读取项目目录…"}
              </p>
            )}
            {error && (
              <div className="composer-menu-error" role="alert">
                {error}
                <button onClick={() => retry((n) => n + 1)}>重试</button>
              </div>
            )}
            {!loading && !error && !options.length && (
              <p>
                没有匹配项
                {mode === "files" && "，可输入目录路径继续查找"}
                {mode === "commands" &&
                  !sideChat &&
                  "，以当前 Agent 返回的命令为准"}
              </p>
            )}
          </div>
          {mode === "files" && (
            <div
              className="composer-reference-actions"
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  close();
                  focusInput();
                }
              }}
            >
              {externalError && <p role="alert">{externalError}</p>}
              {hostId === "local" && external && (
                <>
                  <button
                    disabled={externalBusy || !connected}
                    onClick={() => void addExternal(false)}
                  >
                    <FileText size={16} />
                    选择文件并引用…
                  </button>
                  <button
                    disabled={externalBusy || !connected}
                    onClick={() => void addExternal(true)}
                  >
                    <Folder size={16} />
                    选择文件夹并引用…
                  </button>
                </>
              )}
              <button
                disabled={externalBusy}
                onClick={() => {
                  setExternal((current) => !current);
                  setExternalError("");
                }}
              >
                {external
                  ? "返回项目目录"
                  : hostId === "local"
                    ? "引用本机路径…"
                    : "引用远程路径…"}
              </button>
            </div>
          )}
          {mode === "commands" && (
            <div className="composer-menu-footer">
              <span>↑↓ 选择</span>
              <span>↵ 补全</span>
              <span>esc 关闭</span>
            </div>
          )}
        </div>
      )}
      {props.skillCreator && !concealSubmitted && (
        <div
          className="composer-skill-preset"
          role="group"
          aria-label="已选择技能"
        >
          <span title="Latte Work 内置的技能创建指引；发送需求后创建全局技能">
            <Box size={16} />
            Skill Creator
            <button
              disabled={sending || pasting}
              aria-label="移除 Skill Creator"
              onClick={() => {
                props.onRemoveSkillCreator?.();
                focusInput();
              }}
            >
              <X size={13} />
            </button>
          </span>
        </div>
      )}
      <ImageGallery scope={scope} active={!hidden}>
        {!!separateAttached.length && !concealSubmitted && (
          <div className="composer-references" aria-label="已添加附件和引用">
            {separateAttached.map((entry) => (
              <span key={entry.path} title={entry.path}>
                <small className="composer-reference-kind">
                  {entry.attachmentKind ? "附件" : "引用"}
                </small>
                {!entry.directory && referenceKind(entry) === "image" ? (
                  <AttachmentImage
                    reference={entry}
                    variant="chip"
                    hostId={hostId}
                    projectId={projectId}
                    projectPath={projectPath}
                    sessionId={sessionId}
                    connected={connected}
                    active={!hidden}
                    onOpen={close}
                  />
                ) : (
                  <>
                    {entry.directory ? (
                      <Folder size={14} />
                    ) : entry.attachmentKind === "video" ? (
                      <FileVideo size={14} />
                    ) : (
                      <FileText size={14} />
                    )}
                    <span>
                      {entry.attachmentKind && !entry.directory
                        ? entry.name
                        : entry.path}
                    </span>
                  </>
                )}
                <button
                  disabled={sending || pasting}
                  aria-label={`${entry.attachmentKind ? "移除附件" : "移除引用"} ${entry.path}`}
                  onClick={() =>
                    setReferences({
                      scope,
                      entries: attached.filter(
                        (item) => item.path !== entry.path,
                      ),
                    })
                  }
                >
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        {!concealSubmitted && props.context}
        {inlineMode ? (
          <InlineReferenceInput
            key={editorContext}
            ref={inlineInput}
            value={value}
            references={inlineAttached}
            label={props.inputLabel ?? "任务输入"}
            disabled={disabled || sending || pasting}
            autocomplete={autocomplete}
            onEdit={(text, entries, caret) => {
              if (!entries.length && caret) restoreCaret(caret.start);
              if (text !== value) onChange(text);
              const paths = new Map(
                entries.map((entry) => [entry.path, entry]),
              );
              const next = attached
                .map((entry) =>
                  entry.attachmentKind ? entry : paths.get(entry.path),
                )
                .filter((entry): entry is ComposerReference => !!entry);
              if (
                next.length !== attached.length ||
                next.some(
                  (entry, index) =>
                    entry.inlineOffset !== attached[index].inlineOffset,
                )
              )
                setReferences({ scope, entries: next });
              setNotice("");
            }}
            onPaste={(event) => void paste(event)}
            onKeyDown={keys}
            onInputState={(text, offset) => {
              setBrowse(null);
              setAddMenu(false);
              setTrigger(
                composing.current ? null : composerTrigger(text, offset),
              );
            }}
            onCompositionStart={() => {
              composing.current = true;
              setImeActive(true);
              close();
            }}
            onCompositionEnd={(text, offset) => {
              composing.current = false;
              setImeActive(false);
              setTrigger(composerTrigger(text, offset));
            }}
            renderImage={(entry) => (
              <AttachmentImage
                reference={entry}
                variant="chip"
                hostId={hostId}
                projectId={projectId}
                projectPath={projectPath}
                sessionId={sessionId}
                connected={connected}
                active={!hidden}
                onOpen={close}
              />
            )}
          />
        ) : (
          <div className="composer-editor">
            {visiblePrediction && (
              <div
                className="composer-prediction"
                id={`${listId}-prediction-body`}
                ref={ghost}
                /* Explicitly described by the editor, not a separate browse stop. */
                aria-hidden="true"
              >
                {visiblePrediction.text}
              </div>
            )}
            <textarea
              ref={input}
              /* Remount across conceal transitions: a fresh node carries no IME
           composition state, so an engine cannot replay the submitted text
           into the cleared field after re-enabling it. */
              key={concealSubmitted ? "concealed" : "editing"}
              rows={1}
              aria-label={props.inputLabel ?? "任务输入"}
              {...autocomplete}
              placeholder={visiblePrediction ? "" : placeholder}
              aria-describedby={
                visiblePrediction
                  ? `${listId}-prediction-body ${listId}-prediction-hint`
                  : undefined
              }
              value={concealSubmitted ? "" : value}
              disabled={disabled || sending || pasting}
              onPaste={(event) => void paste(event)}
              onChange={(event) => {
                onChange(event.target.value);
                setNotice("");
                setBrowse(null);
                setAddMenu(false);
                setTrigger(
                  composing.current
                    ? null
                    : composerTrigger(
                        event.target.value,
                        event.target.selectionStart,
                      ),
                );
              }}
              onClick={(event) => {
                const el = event.currentTarget;
                setTrigger(composerTrigger(el.value, el.selectionStart));
                setBrowse(null);
              }}
              onKeyUp={(event) => {
                if (
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
                )
                  setTrigger(
                    composerTrigger(
                      event.currentTarget.value,
                      event.currentTarget.selectionStart,
                    ),
                  );
              }}
              onCompositionStart={() => {
                composing.current = true;
                setImeActive(true);
                close();
              }}
              onCompositionEnd={(event) => {
                composing.current = false;
                setImeActive(false);
                setTrigger(
                  composerTrigger(
                    event.currentTarget.value,
                    event.currentTarget.selectionStart,
                  ),
                );
              }}
              onKeyDown={keys}
            />
          </div>
        )}
      </ImageGallery>
      {pasting && (
        <div className="composer-notice" role="status">
          {pasteProgress}
        </div>
      )}
      {notice && (
        <div className="composer-notice" role="status">
          {notice}
        </div>
      )}
      {!!retryFiles.length && !pasting && (
        <div className="composer-attachment-retry">
          <button
            disabled={disabled || sending || !connected}
            onClick={() => void addFiles(retryFiles, true)}
          >
            重试添加附件
          </button>
          <button
            disabled={disabled || sending}
            onClick={() => {
              setRetryFiles([]);
              setNotice("");
            }}
          >
            移除未添加附件
          </button>
        </div>
      )}
      <div className="composer-toolbar">
        {visiblePrediction && (
          <span
            className="composer-prediction-hint"
            id={`${listId}-prediction-hint`}
          >
            Tab 插入
          </span>
        )}
        <button
          className="icon-button composer-add"
          title="添加附件或引用工作区文件"
          aria-label="添加文件"
          aria-haspopup="menu"
          aria-expanded={menu && addMenu}
          disabled={disabled || sending || pasting}
          onClick={() => {
            const open = !menu;
            close();
            setAddMenu(open);
          }}
        >
          <Plus size={19} />
        </button>
        {toolbar(
          () => void submit(),
          !pasting &&
            !retryFiles.length &&
            (!!value.trim() || !!attached.length || !!props.hasContext),
          localNavigation,
        )}
      </div>
    </div>
  );
}
