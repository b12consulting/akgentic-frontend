import {
  commandArgsHint,
  descriptionSummary,
  optionCompletion,
  resolveCommand,
  tokenize,
  valueCompletion,
} from './command-completion';
import { CommandArg, CommandDescriptor } from '../../protocol/message.types';

function option(name: string, extra: Partial<CommandArg> = {}): CommandArg {
  return { name, type: 'string', required: false, keyword_only: true, ...extra };
}

function command(name: string, args: CommandArg[]): CommandDescriptor {
  return { name, description: `${name} description`, args, tool_card: 'TestTool' };
}

// The shipped shapes, as the backend announces them.
const SEARCH_PLANNING = command('search_planning', [
  option('mode', { choices: ['vector', 'keyword', 'hybrid'] }),
  option('status', { choices: ['pending', 'done'] }),
  option('owner'),
  option('creator'),
  option('top_k', { type: 'integer' }),
  option('score_threshold', { type: 'number' }),
  { name: 'query', type: 'string', required: false, rest_of_line: true },
]);
const SEARCH_GRAPH = command('search_graph', [
  option('mode', { choices: ['vector', 'keyword', 'hybrid'] }),
  option('top_k', { type: 'integer' }),
  option('include_neighbors', { type: 'boolean' }),
  option('include_edges', { type: 'boolean' }),
  option('find_paths', { type: 'boolean' }),
  option('score_threshold', { type: 'number' }),
  { name: 'query', type: 'string', required: true, rest_of_line: true },
]);
const RAG_SEARCH = command('workspace_rag_search', [
  option('top_k', { type: 'integer' }),
  option('path_prefix'),
  { name: 'query', type: 'string', required: true, rest_of_line: true },
]);
const WORKSPACE_WRITE = command('workspace_write', [
  { name: 'filepath', type: 'string', required: true },
  { name: 'content', type: 'string', required: true, rest_of_line: true },
]);
const ROSTER = command('roster', []);
// An older backend: none of the new fields, not even as `false`.
const HIRE = command('hire_member', [
  { name: 'role', type: 'string', required: true },
  { name: 'name', type: 'string', required: false },
]);

const COMMANDS = [SEARCH_PLANNING, SEARCH_GRAPH, RAG_SEARCH, WORKSPACE_WRITE, ROSTER, HIRE];

/** Option names a typed space would offer, or null; the caret defaults to the end. */
function options(text: string, caret = text.length): string[] | null {
  return optionCompletion(text, caret, COMMANDS)?.map((a) => a.name) ?? null;
}

/** The option a typed `=` would offer the values of, or null. */
function valueOption(text: string, caret = text.length): string | null {
  return valueCompletion(text, caret, COMMANDS)?.name ?? null;
}

describe('command-completion', () => {
  describe('commandArgsHint', () => {
    const cases: { name: string; args: CommandArg[]; hint: string }[] = [
      { name: 'an option renders [name=]', args: [option('mode')], hint: '[mode=]' },
      {
        name: 'required free text renders <name…>',
        args: [{ name: 'query', type: 'string', required: true, rest_of_line: true }],
        hint: '<query…>',
      },
      {
        name: 'optional free text renders [name…]',
        args: [{ name: 'query', type: 'string', required: false, rest_of_line: true }],
        hint: '[query…]',
      },
      {
        name: 'a plain arg renders <name> / [name], unchanged',
        args: [
          { name: 'role', type: 'string', required: true },
          { name: 'name', type: 'string', required: false },
        ],
        hint: '<role> [name]',
      },
      {
        name: 'keyword_only wins over rest_of_line',
        args: [option('odd', { rest_of_line: true, required: true })],
        hint: '[odd=]',
      },
      {
        name: 'the search_planning example, verbatim',
        args: SEARCH_PLANNING.args,
        hint: '[mode=] [status=] [owner=] [creator=] [top_k=] [score_threshold=] [query…]',
      },
      {
        name: 'the workspace_write example, verbatim',
        args: WORKSPACE_WRITE.args,
        hint: '<filepath> <content…>',
      },
      {
        name: 'a descriptor with every new field absent is unchanged',
        args: HIRE.args,
        hint: '<role> [name]',
      },
      { name: 'no args is the empty string', args: [], hint: '' },
    ];

    for (const c of cases) {
      it(c.name, () => {
        expect(commandArgsHint(c.args)).toBe(c.hint);
      });
    }

    it('uses the single ellipsis character, not three dots', () => {
      expect(commandArgsHint(RAG_SEARCH.args)).toContain('…');
      expect(commandArgsHint(RAG_SEARCH.args)).not.toContain('...');
    });
  });

  describe('tokenize', () => {
    it('keeps a double-quoted segment inside one token', () => {
      expect(tokenize('/search_planning owner="Alice Smith" x')).toEqual({
        tokens: ['/search_planning', 'owner="Alice Smith"', 'x'],
        unclosedQuote: false,
      });
    });

    it('keeps a single-quoted segment inside one token', () => {
      expect(tokenize("a b='c d'").tokens).toEqual(['a', "b='c d'"]);
    });

    it('reports an unclosed quote', () => {
      expect(tokenize('/search_planning owner="Alice').unclosedQuote).toBeTrue();
    });

    it('collapses runs of whitespace and ignores the ends', () => {
      expect(tokenize('  a \t b  ').tokens).toEqual(['a', 'b']);
    });
  });

  describe('optionCompletion — armed', () => {
    const ALL = ['mode', 'status', 'owner', 'creator', 'top_k', 'score_threshold'];
    const cases: { name: string; text: string; expected: string[] }[] = [
      { name: 'a bare known command', text: '/search_planning', expected: ALL },
      {
        name: 'after a complete option, which is no longer offered',
        text: '/search_planning status=pending',
        expected: ['mode', 'owner', 'creator', 'top_k', 'score_threshold'],
      },
      {
        name: 'after a quoted value with a space in it',
        text: '/search_planning owner="Alice Smith"',
        expected: ['mode', 'status', 'creator', 'top_k', 'score_threshold'],
      },
      {
        name: 'with a trailing space after the command name',
        text: '/search_planning ',
        expected: ALL,
      },
      {
        name: 'with a trailing space after a complete value',
        text: '/search_planning status=pending ',
        expected: ['mode', 'owner', 'creator', 'top_k', 'score_threshold'],
      },
    ];

    for (const c of cases) {
      it(c.name, () => {
        expect(options(c.text)).toEqual(c.expected);
      });
    }
  });

  describe('optionCompletion — disarmed', () => {
    const cases: { name: string; text: string; caret?: number }[] = [
      { name: 'the empty input', text: '' },
      { name: 'a non-command message', text: 'hello' },
      { name: 'a partial command name', text: '/search_plan' },
      { name: 'a command with no options', text: '/roster' },
      { name: 'a command with positionals only', text: '/workspace_write' },
      { name: 'an input whose text has started', text: '/search_planning deploy' },
      { name: 'a later `=` once text has started', text: '/search_planning deploy mode=x' },
      { name: 'an unknown option', text: '/search_planning bogus=1' },
      { name: 'an empty value', text: '/search_planning status=' },
      { name: 'an empty quoted value', text: '/search_planning owner=""' },
      { name: 'an unclosed quote', text: '/search_planning owner="Alice' },
      { name: 'an @ mention in a value', text: '/search_planning owner=@Ali' },
      { name: 'a duplicate option', text: '/search_planning status=a status=b' },
      { name: 'every option already used', text: '/workspace_rag_search top_k=3 path_prefix=src' },
      { name: 'a caret before the end', text: '/search_planning status=pending', caret: 3 },
      { name: 'a leading space before the slash', text: ' /search_planning' },
      { name: 'a descriptor with no new fields', text: '/hire_member' },
      { name: 'a descriptor with no new fields, trailing space', text: '/hire_member ' },
      { name: 'a descriptor with no new fields, positional typed', text: '/hire_member Developer' },
    ];

    for (const c of cases) {
      it(c.name, () => {
        expect(options(c.text, c.caret)).toBeNull();
      });
    }

    it('treats a caret past the end (a stale caret after a clear) as the end', () => {
      expect(options('/search_planning', 40)).not.toBeNull();
    });
  });

  describe('valueCompletion — armed', () => {
    it('an unused option with choices right before the caret', () => {
      expect(valueOption('/search_graph mode')).toBe('mode');
    });

    it('after a complete option', () => {
      expect(valueOption('/search_planning top_k=3 status')).toBe('status');
    });

    it('hands back the arg, so its choices come in declared order', () => {
      expect(valueCompletion('/search_graph mode', 18, COMMANDS)?.choices).toEqual([
        'vector',
        'keyword',
        'hybrid',
      ]);
    });
  });

  describe('valueCompletion — disarmed', () => {
    const cases: { name: string; text: string; caret?: number }[] = [
      { name: 'an option with no choices', text: '/search_graph top_k' },
      { name: 'an option already used', text: '/search_graph mode=vector mode' },
      { name: 'text has started', text: '/search_graph deploy mode' },
      { name: 'not an option name', text: '/search_graph mod' },
      { name: 'the word is not right before the caret', text: '/search_graph mode ' },
      { name: 'a mid-text caret', text: '/search_graph mode', caret: 5 },
      { name: 'a non-command message', text: 'hello mode' },
      { name: 'the bare command, no word yet', text: '/search_graph' },
      { name: 'an `=` already typed', text: '/search_graph mode=' },
      { name: 'an @ mention before the word', text: '/search_planning owner=@Ali mode' },
      { name: 'an unclosed quote before the word', text: '/search_planning owner="Ali mode' },
      { name: 'a descriptor with no new fields', text: '/hire_member role' },
    ];

    for (const c of cases) {
      it(c.name, () => {
        expect(valueOption(c.text, c.caret)).toBeNull();
      });
    }
  });

  describe('resolveCommand', () => {
    it('matches the first token exactly', () => {
      expect(resolveCommand('/search_graph deploy', COMMANDS)).toBe(SEARCH_GRAPH);
    });

    it('is null for a partial name and for a non-command', () => {
      expect(resolveCommand('/search_gr', COMMANDS)).toBeNull();
      expect(resolveCommand('search_graph', COMMANDS)).toBeNull();
      expect(resolveCommand('', COMMANDS)).toBeNull();
    });
  });
});

describe('descriptionSummary', () => {
  it('keeps the first paragraph of a docstring, on one line', () => {
    const doc =
      'Search tasks — options first, then the rest of the line\nis the query.\n\n' +
      'Example: /search_planning status=pending deploy\n\nArgs:\n    mode: How to match.';
    expect(descriptionSummary(doc)).toBe(
      'Search tasks — options first, then the rest of the line is the query.',
    );
  });

  it('joins a multi-line option description', () => {
    expect(descriptionSummary('"hybrid" (default) = both,\n"keyword" = substring only.')).toBe(
      '"hybrid" (default) = both, "keyword" = substring only.',
    );
  });

  it('is empty for a missing description', () => {
    expect(descriptionSummary(null)).toBe('');
    expect(descriptionSummary(undefined)).toBe('');
  });
});
