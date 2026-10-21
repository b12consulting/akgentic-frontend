/**
 * What the composer may offer while a slash-command is being written.
 *
 * Pure and DOM-free on purpose: `angular-mentions` has no notion of position —
 * it opens a list on EVERY keystroke that matches a registered trigger char —
 * so the only way to keep a space or an `=` from popping a list mid-sentence is
 * to withhold its config entirely. Whether to withhold it is decided here, from
 * the text and the caret alone, which is what lets every arming case be pinned
 * by a table rather than by a browser.
 *
 * The grammar is the backend's "options, then text":
 * `/cmd [name=value …] <text…>`. Options are tokenised with quotes, so
 * `owner="Alice Smith"` is ONE option; the text starts at the first token that
 * is not a known option, and from there everything — a later `mode=x`
 * included — is text, which is why nothing is ever offered after it.
 */
import { CommandArg, CommandDescriptor } from '../../protocol/message.types';

/**
 * The args hint for a `/` row, in declared order: `[name=]` for an option,
 * `<name…>` / `[name…]` for the trailing free text, `<name>` / `[name]`
 * otherwise. `keyword_only` is checked first, because an option is never
 * written positionally whatever else it is.
 *
 * A descriptor from a backend that sends none of the new fields renders
 * exactly as before (`<role> [name]`): an absent flag is `undefined`, which
 * falls through to the old two rows.
 */
export function commandArgsHint(args: readonly CommandArg[]): string {
  return args.map(argHint).join(' ');
}

function argHint(arg: CommandArg): string {
  if (arg.keyword_only) return `[${arg.name}=]`;
  if (arg.rest_of_line) return arg.required ? `<${arg.name}…>` : `[${arg.name}…]`;
  return arg.required ? `<${arg.name}>` : `[${arg.name}]`;
}

/**
 * The first paragraph of a row's description, on one line. A command's
 * description is its whole docstring, whose `Example:` and `Args:` sections
 * would only repeat what the args hint and the option rows already show.
 */
export function descriptionSummary(description: string | null | undefined): string {
  return (description ?? '').split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
}

/** The text split into whitespace-separated tokens, quotes kept intact. */
export interface Tokenized {
  tokens: string[];
  /** A quote was opened and never closed — the caret is inside a value. */
  unclosedQuote: boolean;
}

/**
 * Split on whitespace, keeping a `"…"` or `'…'` segment inside one token.
 *
 * The quotes stay in the token: the caller only needs to know where the
 * option boundaries are, not what the value unquotes to. An unclosed quote is
 * reported rather than guessed at — the user is still typing a value, and
 * offering a list there would complete into the middle of it.
 */
export function tokenize(text: string): Tokenized {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
    } else {
      if (ch === '"' || ch === "'") quote = ch;
      current += ch;
      inToken = true;
    }
  }
  if (inToken) tokens.push(current);
  return { tokens, unclosedQuote: quote !== null };
}

/** A `/command` followed only by complete options, as parsed. */
interface OptionPrefix {
  command: CommandDescriptor;
  used: ReadonlySet<string>;
}

/**
 * Read `tokens` as `/<known command>` followed only by complete `name=value`
 * options, or return null.
 *
 * Every option must name a `keyword_only` arg of the command, once, with a
 * non-empty value. A token containing `@` disqualifies the whole input: the
 * `@` list may be open there (it allows spaces), and a second list racing it
 * for the same keystroke is worse than no list.
 */
function readOptionPrefix(
  tokens: readonly string[],
  commands: readonly CommandDescriptor[],
): OptionPrefix | null {
  const [head, ...options] = tokens;
  if (!head?.startsWith('/')) return null;
  const command = commands.find((c) => c.name === head.slice(1));
  if (!command) return null;

  const used = new Set<string>();
  for (const token of options) {
    const eq = token.indexOf('=');
    if (eq <= 0 || token.includes('@')) return null;
    const name = token.slice(0, eq);
    const value = token.slice(eq + 1).replace(/["']/g, '');
    const isOption = command.args.some((a) => a.keyword_only && a.name === name);
    if (!isOption || value === '' || used.has(name)) return null;
    used.add(name);
  }
  return { command, used };
}

/**
 * The known command the first token names exactly, or null.
 *
 * `commands` is the target's user-invocable list (the same one the `/` list
 * shows), so a partial name (`/search_plan`) or an internal command is null.
 */
export function resolveCommand(
  text: string,
  commands: readonly CommandDescriptor[],
): CommandDescriptor | null {
  if (!text.startsWith('/')) return null;
  const [head] = tokenize(text).tokens;
  return commands.find((c) => c.name === head.slice(1)) ?? null;
}

/**
 * The options a typed space may offer right now, in declared order — or null
 * when a space must open nothing.
 *
 * Armed only when the text before the caret, trailing whitespace aside, is
 * `/<known command>` followed only by complete options, no quote is open, the
 * caret is at the end, and an option is left to offer. Everything else is
 * null: a sentence, a partial command name, a command with no options, an
 * input whose text has started, an unknown or empty option, an `@` mention.
 *
 * A caret PAST the end counts as the end: the component's caret can lag a
 * programmatic clear of the input, and the text it lags is shorter, never
 * longer.
 */
export function optionCompletion(
  text: string,
  caret: number,
  commands: readonly CommandDescriptor[],
): CommandArg[] | null {
  if (caret < text.length || !text.startsWith('/')) return null;
  const { tokens, unclosedQuote } = tokenize(text);
  if (unclosedQuote) return null;
  const prefix = readOptionPrefix(tokens, commands);
  if (!prefix) return null;
  const unused = prefix.command.args.filter(
    (a) => a.keyword_only && !prefix.used.has(a.name),
  );
  return unused.length > 0 ? unused : null;
}

/**
 * The option whose `choices` a typed `=` may offer right now — or null when an
 * `=` must open nothing.
 *
 * Armed only when the word right before the caret is an UNUSED option of the
 * current command that has choices, and everything before that word is an
 * option prefix `optionCompletion` would accept. A trailing space means the
 * word is finished, so `=` there is text, not a value.
 */
export function valueCompletion(
  text: string,
  caret: number,
  commands: readonly CommandDescriptor[],
): CommandArg | null {
  if (caret < text.length || !text.startsWith('/') || /\s$/.test(text)) {
    return null;
  }
  const { tokens, unclosedQuote } = tokenize(text);
  if (unclosedQuote || tokens.length < 2) return null;
  const word = tokens[tokens.length - 1];
  const prefix = readOptionPrefix(tokens.slice(0, -1), commands);
  if (!prefix || prefix.used.has(word)) return null;
  return (
    prefix.command.args.find(
      (a) => a.keyword_only && a.name === word && (a.choices?.length ?? 0) > 0,
    ) ?? null
  );
}

/** The first positional argument: neither an option nor the trailing free text. */
function firstPositional(args: readonly CommandArg[]): CommandArg | undefined {
  return args.find((a) => !a.keyword_only && !a.rest_of_line);
}

/**
 * The positional argument whose `choices` a typed space may offer right now —
 * or null. Armed only when the text is `/<known command>` and nothing after it,
 * the caret is at the end, and the command's first positional argument has
 * choices (`/switch_model` and the agent's models).
 */
export function positionalCompletion(
  text: string,
  caret: number,
  commands: readonly CommandDescriptor[],
): CommandArg | null {
  if (caret < text.length || !text.startsWith('/')) return null;
  const { tokens, unclosedQuote } = tokenize(text);
  if (unclosedQuote || tokens.length !== 1) return null;
  const command = commands.find((c) => c.name === tokens[0].slice(1));
  const arg = command ? firstPositional(command.args) : undefined;
  return arg && (arg.choices?.length ?? 0) > 0 ? arg : null;
}

/**
 * Whether selecting this command should type its space and open a list: it
 * has options, or its first positional argument has choices.
 */
export function completesAfterName(args: readonly CommandArg[] | undefined): boolean {
  if (!args) return false;
  return args.some((a) => a.keyword_only) || (firstPositional(args)?.choices?.length ?? 0) > 0;
}
