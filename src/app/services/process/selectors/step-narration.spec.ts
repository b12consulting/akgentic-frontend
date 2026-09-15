import { ThinkingToolEntry } from './chat.selector';
import { describeStep } from './step-narration';

/**
 * `describeStep` is a pure function with four branches and no dependencies, and
 * it shipped with no spec at all — the only module in `process/selectors/` that
 * did. That matters more than the 1:1 convention it broke: this is the code that
 * decides what a reader is told an agent DID, and every one of its branches
 * fails silently. A wrong `titleKey` renders as a raw key, an unknown tool that
 * accidentally resolved renders someone else's sentence, and a `raw` string
 * assembled wrongly is only visible behind a toggle almost nobody opens.
 *
 * KEYS, NEVER COPY (NFR3). Every assertion below is on the key `describeStep`
 * returns, not on the English behind it. That is also what makes the "unknown
 * tool" branch assertable at all: its contract is precisely that there is no
 * key, and `titleKey === null` is the only way to say so.
 */
function step(overrides: Partial<ThinkingToolEntry> = {}): ThinkingToolEntry {
  return {
    tool_call_id: 'call-1',
    tool_name: 'search_web',
    arguments_preview: '{"query":"payroll"}',
    done: false,
    kind: 'tool',
    ...overrides,
  };
}

describe('describeStep', () => {
  describe('a tool this frontend can speak for', () => {
    // The three akgentic built-ins, asserted as a set rather than one example:
    // the table is the whole of this branch, and a spec that pinned one entry
    // would let the other two be renamed silently.
    const known: ReadonlyArray<[string, string]> = [
      ['hire_members', 'chat.activity.tool.hireMembers'],
      ['read_message', 'chat.activity.tool.readMessage'],
      ['send_message', 'chat.activity.tool.sendMessage'],
    ];

    for (const [toolName, expectedKey] of known) {
      it(`narrates ${toolName} through its own key`, () => {
        const narration = describeStep(step({ tool_name: toolName }));

        expect(narration.titleKey).toBe(expectedKey);
        // `title` stays the tool name even when a key was found: it is the
        // interpolation parameter, and a key that happens to take `{{ tool }}`
        // would render blank without it.
        expect(narration.title).toBe(toolName);
      });
    }
  });

  describe('a tool it has never heard of', () => {
    it('narrates itself with its own name and no key', () => {
      // The documented rule: an unknown tool is not an error and gets no
      // apology. In a framework where every deployment registers its own tools,
      // this is the COMMON branch, not the edge case.
      const narration = describeStep(step({ tool_name: 'sme_wage_code_lookup' }));

      expect(narration.titleKey).toBeNull();
      expect(narration.title).toBe('sme_wage_code_lookup');
      expect(narration.detail).toBe('{"query":"payroll"}');
    });

    it('does not resolve a name that merely collides with Object.prototype', () => {
      // `KNOWN_TOOLS` is a plain object literal, so a tool genuinely called
      // `constructor` or `toString` would otherwise find a function on the
      // prototype chain and be narrated as one — `titleKey` would be a
      // `Function`, and `| translate` would receive something that is not a key.
      for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
        expect(describeStep(step({ tool_name: name })).titleKey)
          .withContext(name)
          .toBeNull();
      }
    });
  });

  describe('a contact', () => {
    it('reads as who was asked, with the message as the detail', () => {
      const narration = describeStep(
        step({
          kind: 'contact',
          tool_name: '@Support',
          arguments_preview: 'Can you check the June run?',
        }),
      );

      expect(narration.titleKey).toBe('chat.activity.contactTitle');
      expect(narration.title).toBe('@Support');
      // A contact's "arguments" ARE the message, so the quote is the detail —
      // there is nothing else to show and no payload to summarise.
      expect(narration.detail).toBe('Can you check the June run?');
    });

    it('takes the contact branch even when the agent shares a built-in tool name', () => {
      // `kind` is checked BEFORE the table, and it has to be: an agent named
      // `send_message` is a protocol surprise, but narrating a contact as
      // "Sent a message" would be a wrong sentence rather than a missing one.
      const narration = describeStep(
        step({ kind: 'contact', tool_name: 'send_message' }),
      );

      expect(narration.titleKey).toBe('chat.activity.contactTitle');
    });
  });

  describe('the raw line', () => {
    it('joins the name and the preview when there is one', () => {
      expect(
        describeStep(
          step({ tool_name: 'search_web', arguments_preview: '{"q":1}' }),
        ).raw,
      ).toBe('search_web {"q":1}');
    });

    it('is the bare name when the preview is empty', () => {
      // `''` is falsy, which is the point: a tool called with no arguments must
      // not render as a name followed by a trailing space, because the raw pane
      // is the one place a reader is looking at the literal string.
      expect(
        describeStep(step({ tool_name: 'refresh', arguments_preview: '' })).raw,
      ).toBe('refresh');
    });

    it('is built the same way for a contact', () => {
      // The raw line is assembled BEFORE the branch, so both kinds carry it.
      // An operator debugging a run needs the contact's wire form as much as
      // the tool's.
      expect(
        describeStep(
          step({
            kind: 'contact',
            tool_name: '@Support',
            arguments_preview: 'ping',
          }),
        ).raw,
      ).toBe('@Support ping');
    });
  });
});
