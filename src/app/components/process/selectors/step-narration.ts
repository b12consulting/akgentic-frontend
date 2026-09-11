import { ThinkingToolEntry } from './chat.selector';

/**
 * Turning a step into a sentence.
 *
 * The fold answers "what did this agent do", and `hire_members` with a JSON blob
 * does not answer it for anyone who is not holding the tool catalogue in their
 * head. A step therefore renders as a short title and a supporting line, with
 * the raw call kept one click away rather than thrown out — prose for the person
 * reading the conversation, payload for the person debugging it.
 *
 * WHY A TABLE IN THE FRONTEND. The alternative is a display label on the wire,
 * which is the better long-term home; this is deliberately the reversible half
 * of that choice. It needs no protocol change to ship, and the day `ToolCallEvent`
 * carries a label, this becomes the fallback rather than the source. What it
 * cannot do is know about a tool it has never heard of — which, in a framework
 * where every deployment registers its own, is most of them. Hence the rule
 * below: an unknown tool is not an error and gets no apology, it just narrates
 * itself with its own name.
 */
export interface StepNarration {
  /** Translation key for the title, or `null` when the tool names itself. */
  titleKey: string | null;
  /** Interpolation params for `titleKey`, and the verbatim title when it is null. */
  title: string;
  /** The supporting line, already human — a quoted message, or the arguments. */
  detail: string;
  /** The call as it came off the wire, shown only behind "Show raw". */
  raw: string;
}

/**
 * Tools this frontend can speak for.
 *
 * Keys are akgentic built-ins. Deliberately short: a deployment's own tools
 * belong to the deployment, and guessing at them produces confident nonsense.
 *
 * A `Map`, NOT an object literal, and the reason is a live bug rather than
 * taste. `tool_name` is attacker-adjacent data — it is whatever a deployment
 * registered — and an object literal answers a lookup from `Object.prototype`
 * as readily as from itself. A tool named `constructor` or `toString` would
 * therefore "resolve", `titleKey` would be a FUNCTION, and the template would
 * hand it to `| translate` as though it were a key. The `Record<string, string>`
 * type says that cannot happen; at runtime it can. `Map` has no prototype chain
 * to fall through, and its `get` returns `string | undefined`, which is the
 * honest type for a lookup that mostly misses.
 */
const KNOWN_TOOLS: ReadonlyMap<string, string> = new Map([
  ['hire_members', 'chat.activity.tool.hireMembers'],
  ['read_message', 'chat.activity.tool.readMessage'],
  ['send_message', 'chat.activity.tool.sendMessage'],
]);

export function describeStep(step: ThinkingToolEntry): StepNarration {
  const raw = step.arguments_preview
    ? `${step.tool_name} ${step.arguments_preview}`
    : step.tool_name;

  if (step.kind === 'contact') {
    // A contact already reads as a sentence: who was asked, and what was said.
    // Its "arguments" are the message itself, so the quote IS the detail.
    return {
      titleKey: 'chat.activity.contactTitle',
      title: step.tool_name,
      detail: step.arguments_preview,
      raw,
    };
  }

  const known = KNOWN_TOOLS.get(step.tool_name);
  return {
    titleKey: known ?? null,
    // When nothing is known, the tool name is the title. Not "Unknown tool" and
    // not a raw dump dressed as prose — just the name, which is true and short.
    title: step.tool_name,
    detail: step.arguments_preview,
    raw,
  };
}
