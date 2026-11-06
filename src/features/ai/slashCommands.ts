import { msg, t } from "../../i18n";

export type SlashCommandName = "compact" | "new" | "history" | "settings";

export interface SlashCommand {
  name: SlashCommandName;
  /** Shown after the name, e.g. "[重点]". */
  argument?: string;
  description: string;
}

const COMMANDS: {
  name: SlashCommandName;
  argument?: string;
  description: string;
}[] = [
  {
    name: "compact",
    argument: msg("[要保留的重点]"),
    description: msg("压缩上下文，释放空间"),
  },
  { name: "new", description: msg("新建对话") },
  { name: "history", description: msg("查看此服务器的历史记录") },
  { name: "settings", description: msg("打开 AI 设置") },
];

/** The commands, translated for the current language. */
export function slashCommands(): SlashCommand[] {
  return COMMANDS.map((command) => ({
    name: command.name,
    argument: command.argument && t(command.argument),
    description: t(command.description),
  }));
}

/**
 * Commands offered for a draft that is still a bare `/word` (no space yet):
 * names starting with the word first, then names containing it. Null when
 * the draft is not a command being typed.
 */
export function matchSlashCommands(draft: string): SlashCommand[] | null {
  const match = /^\/(\S*)$/.exec(draft);
  if (!match) return null;
  const query = match[1].toLowerCase();
  const commands = slashCommands();
  return [
    ...commands.filter((command) => command.name.startsWith(query)),
    ...commands.filter(
      (command) =>
        !command.name.startsWith(query) && command.name.includes(query),
    ),
  ];
}

/**
 * A command typed in full that the panel handles itself (`/compact` is sent
 * on, since it calls the model). Null for anything else.
 */
export function localSlashCommand(
  draft: string,
): Exclude<SlashCommandName, "compact"> | null {
  const match = /^\/(new|history|settings)$/i.exec(draft.trim());
  return match
    ? (match[1].toLowerCase() as Exclude<SlashCommandName, "compact">)
    : null;
}
