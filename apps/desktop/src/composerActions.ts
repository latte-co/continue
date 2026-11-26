import type { AgentSlashCommand } from "./protocol";

export { referencePrompt } from "./referenceMessage";

export interface ComposerTrigger {
  kind: "files" | "commands";
  start: number;
  end: number;
  query: string;
}
export function composerTrigger(
  text: string,
  cursor: number,
): ComposerTrigger | null {
  if (cursor < 0) return null;
  const prefix = text.slice(0, cursor);
  const command = /(?:^|\s)\/([^\s/]*)$/.exec(prefix);
  if (command)
    return {
      kind: "commands",
      start: cursor - command[1].length - 1,
      end: cursor,
      query: command[1],
    };
  const match = /(?:^|\s)@([^\n@]*)$/.exec(prefix);
  if (!match) return null;
  return {
    kind: "files",
    start: cursor - match[1].length - 1,
    end: cursor,
    query: match[1],
  };
}
export const subagentPanelAliases = [
  "agents",
  "list-agents",
  "tasks",
  "subagents",
];
export const subagentPanelArgumentNotice =
  "已打开子智能体面板；此命令不接受参数，输入内容已保留。";

export function isSubagentPanelCommand(text: string) {
  const name = /^\/([^\s]+)(?:\s|$)/.exec(text.trim())?.[1];
  return !!name && subagentPanelAliases.includes(name);
}

export function hasCommandArguments(text: string) {
  return /^\/[^\s]+\s+\S/.test(text.trim());
}

export function isNativeSubagentCommand(command: AgentSlashCommand) {
  return (
    command.ui_action === "subagents" ||
    subagentPanelAliases.includes(command.name)
  );
}

export type AppCommandAction = "subagents" | "model" | "effort" | "side";
export type ComposerCommand = Omit<AgentSlashCommand, "ui_action"> & {
  ui_action?: AppCommandAction;
};
export type CommandPillIconKind =
  "skill" | "command" | "model" | "effort" | "subagents" | "side";
export interface ComposerCommandTokenMeta {
  name: string;
  icon: CommandPillIconKind;
  title?: string;
}
export const supportsSideChatAgent = (agent: string) =>
  agent === "claude" || agent === "codex" || agent === "traex";

export function isSideChatCommand(text: string) {
  return /^\/(side|btw)(?:\s|$)/.test(text.trim());
}

/** App-owned names take precedence even with an older or unavailable catalog. */
export function appCommandAction(
  text: string,
  commands: AgentSlashCommand[] = [],
  sideChat = false,
): AppCommandAction | null {
  const name = /^\/([^\s]+)(?:\s|$)/.exec(text.trim())?.[1];
  if (!name) return null;
  if (sideChat && (name === "side" || name === "btw")) return "side";
  if (name === "model" || name === "effort") return name;
  if (subagentPanelAliases.includes(name)) return "subagents";
  return commands.find((command) => command.name === name)?.ui_action ?? null;
}

const agentNames: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  traex: "Traex",
  opencode: "OpenCode",
  cursor: "Cursor Agent",
};

export function agentDisplayName(agent: string): string {
  return agentNames[agent] ?? agent;
}

export function leadingSlashCommand(text: string): string | undefined {
  return /^\/([^\s/]+)(?:\s|$)/.exec(text.trim())?.[1];
}

const alwaysCommandNames = new Set([
  "compact",
  "context",
  "usage",
  "cost",
  "clear",
  "init",
  "mcp",
  "config",
  "fast",
  "rename",
  "output-style",
  "reload-plugins",
  "reload-skills",
  "insights",
  "recap",
]);

export function isAlwaysNativeCommand(name: string): boolean {
  return alwaysCommandNames.has(name);
}

export function unifiedComposerCommands(
  commands: AgentSlashCommand[],
  ownsSideCommands: boolean,
  showSideChat: boolean,
): ComposerCommand[] {
  return [
    {
      name: "agents",
      display_name: "子智能体",
      description: "打开 Continue 子智能体面板",
      argument_hint: "",
      kind: "command",
      ui_action: "subagents",
    },
    {
      name: "model",
      display_name: "选择模型",
      description: "打开 Continue 模型菜单",
      argument_hint: "",
      kind: "command",
      ui_action: "model",
    },
    {
      name: "effort",
      display_name: "思考强度",
      description: "打开 Continue 思考强度菜单",
      argument_hint: "",
      kind: "command",
      ui_action: "effort",
    },
    ...(showSideChat
      ? [
          {
            name: "side",
            display_name: "侧边聊天",
            description: "在右侧引用主聊上下文继续提问",
            argument_hint: "[问题]",
            kind: "command" as const,
            ui_action: "side" as const,
          },
        ]
      : []),
    ...commands.filter(
      (command) =>
        !isNativeSubagentCommand(command) &&
        (!ownsSideCommands || !isSideChatCommand(`/${command.name}`)) &&
        command.name !== "model" &&
        command.name !== "effort",
    ),
  ];
}

const builtinCommandTitles: Record<string, string> = {
  compact: "压缩上下文",
  review: "代码审查",
  context: "上下文用量",
  usage: "使用情况",
  cost: "使用费用",
  clear: "清空上下文",
  init: "初始化项目",
  model: "选择模型",
  effort: "思考强度",
  mcp: "MCP 服务",
  config: "配置",
  fast: "快速模式",
  rename: "重命名会话",
  "output-style": "输出风格",
  "security-review": "安全审查",
  "code-review": "代码审查",
  "reload-plugins": "重新加载插件",
  "reload-skills": "重新加载技能",
  insights: "使用洞察",
  recap: "会话回顾",
  goal: "设置目标",
};
const verifiedSlashAgents = new Set([
  "claude",
  "codex",
  "traex",
  "opencode",
  "cursor",
]);
export function commandTitle(
  command: Omit<AgentSlashCommand, "ui_action">,
  agent?: string,
): string {
  const label = command.display_name?.trim();
  if (label && label !== command.name) return label;
  if (
    agent &&
    verifiedSlashAgents.has(agent) &&
    command.kind !== "skill" &&
    builtinCommandTitles[command.name]
  )
    return builtinCommandTitles[command.name];
  // Some skills expose their human title at the beginning of the description.
  // Use only a short explicit title; do not turn arbitrary prose into a label.
  const title = /^([^：:\n]{2,28})[：:]/u
    .exec(command.description)?.[1]
    ?.trim();
  if (title) return title;
  return command.name
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export function recognizedComposerCommands(
  commands: AgentSlashCommand[],
  agent: string,
  sideChat: boolean,
  sideAgent: boolean,
): Map<string, ComposerCommandTokenMeta> {
  const map = new Map<string, ComposerCommandTokenMeta>();
  map.set("model", { name: "model", icon: "model", title: "选择模型" });
  map.set("effort", { name: "effort", icon: "effort", title: "思考强度" });
  if (sideChat) return map;

  for (const alias of subagentPanelAliases) {
    map.set(alias, { name: alias, icon: "subagents", title: "子智能体" });
  }
  if (sideAgent) {
    map.set("side", { name: "side", icon: "side", title: "侧边聊天" });
    map.set("btw", { name: "btw", icon: "side", title: "侧边聊天" });
  }
  if (agent !== "opencode") {
    for (const name of alwaysCommandNames) {
      map.set(name, {
        name,
        icon: "command",
        title: builtinCommandTitles[name] ?? name,
      });
    }
  }
  for (const cmd of commands) {
    const icon: CommandPillIconKind = isNativeSubagentCommand(cmd)
      ? "subagents"
      : sideAgent && (cmd.name === "side" || cmd.name === "btw")
        ? "side"
        : cmd.name === "model"
          ? "model"
          : cmd.name === "effort"
            ? "effort"
            : cmd.kind === "skill"
              ? "skill"
              : "command";
    map.set(cmd.name, {
      name: cmd.name,
      icon,
      title: commandTitle(cmd, agent),
    });
  }
  return map;
}
