'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../src/tools/parser');

test('compactToolSchema: strips annotations and preserves schema structure', () => {
  const schema = {
    title: 'ToolInput',
    description: 'Root schema description that should be removed',
    $comment: 'Developer comment',
    type: 'object',
    properties: {
      query: {
        type: 'string',
        title: 'Query Title',
        description: 'The search query',
        examples: ['hello world'],
      },
      nested: {
        type: 'object',
        description: 'Nested object',
        properties: {
          flag: {
            type: 'boolean',
            description: 'A boolean flag',
          },
        },
      },
      itemsList: {
        type: 'array',
        description: 'An array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'ID' },
          },
        },
      },
      config: {
        type: 'string',
        const: 'description', // Literal value named 'description' must remain intact
        default: 'title',
      },
    },
    required: ['query'],
  };

  const compacted = parser.compactToolSchema(schema);

  assert.equal(compacted.title, undefined);
  assert.equal(compacted.description, undefined);
  assert.equal(compacted.$comment, undefined);
  assert.equal(compacted.type, 'object');
  assert.equal(compacted.properties.query.title, undefined);
  assert.equal(compacted.properties.query.description, undefined);
  assert.equal(compacted.properties.query.examples, undefined);
  assert.equal(compacted.properties.query.type, 'string');
  assert.equal(compacted.properties.nested.description, undefined);
  assert.equal(compacted.properties.nested.properties.flag.type, 'boolean');
  assert.equal(compacted.properties.nested.properties.flag.description, undefined);
  assert.equal(compacted.properties.itemsList.items.properties.id.type, 'number');
  assert.equal(compacted.properties.itemsList.items.properties.id.description, undefined);
  assert.equal(compacted.properties.config.const, 'description');
  assert.equal(compacted.properties.config.default, 'title');
  assert.deepEqual(compacted.required, ['query']);
});

test('compactToolSchema: handles allOf, anyOf, oneOf, prefixItems, and dependencies', () => {
  const schema = {
    allOf: [
      { type: 'object', description: 'desc', properties: { a: { type: 'string', description: 'd' } } },
    ],
    anyOf: [
      { type: 'number', description: 'desc' },
    ],
    dependencies: {
      b: ['a'],
      c: { type: 'object', description: 'desc', properties: { x: { type: 'number' } } },
    },
  };

  const compacted = parser.compactToolSchema(schema);
  assert.equal(compacted.allOf[0].description, undefined);
  assert.equal(compacted.allOf[0].properties.a.type, 'string');
  assert.equal(compacted.allOf[0].properties.a.description, undefined);
  assert.equal(compacted.anyOf[0].description, undefined);
  assert.deepEqual(compacted.dependencies.b, ['a']);
  assert.equal(compacted.dependencies.c.description, undefined);
  assert.equal(compacted.dependencies.c.properties.x.type, 'number');
});

test('formatToolDefinitions: formats tools and truncates long descriptions', () => {
  assert.equal(parser.formatToolDefinitions([]), '');
  assert.equal(parser.formatToolDefinitions(null), '');

  const tools = [
    {
      type: 'function',
      function: {
        name: 'test_tool',
        description: 'A'.repeat(600),
        parameters: { type: 'object', properties: { p: { type: 'string' } } },
      },
    },
  ];

  const formatted = parser.formatToolDefinitions(tools);
  assert.match(formatted, /--- TOOL REQUEST SYSTEM ---/);
  assert.match(formatted, /## test_tool/);
  assert.match(formatted, /\.\.\./); // Truncated description
  assert.match(formatted, /Parameters: \{"type":"object"/);
  assert.match(formatted, /--- END TOOL REQUEST SYSTEM ---/);
});

test('formatToolReminder: outputs clear reminder when tools provided', () => {
  assert.equal(parser.formatToolReminder([]), '');
  assert.equal(parser.formatToolReminder(null), '');

  const tools = [{ type: 'function', function: { name: 'calculator' } }];
  const reminder = parser.formatToolReminder(tools);
  assert.match(reminder, /\[Tool reminder\]/);
  assert.match(reminder, /Available tools: calculator/);
  assert.match(reminder, /\{"tool_call":\{"name":/);
});

test('extractBalancedJsonAt: extracts nested JSON objects correctly', () => {
  const text = 'prefix {"a": {"b": [1, 2, "}"], "c": "foo"}} suffix';
  const startIdx = text.indexOf('{');
  const jsonStr = parser.extractBalancedJsonAt(text, startIdx);

  assert.ok(jsonStr);
  const parsed = JSON.parse(jsonStr);
  assert.deepEqual(parsed.a.b, [1, 2, '}']);
  assert.equal(parsed.a.c, 'foo');

  assert.equal(parser.extractBalancedJsonAt('unclosed { "a": 1', 9), null);
  assert.equal(parser.extractBalancedJsonAt('not an object', 0), null);
});

test('extractBalancedJsonObjects: finds balanced JSON objects with predicate and limit', () => {
  const text = 'foo {"type": "ignore"} bar {"tool_call": {"name": "f1"}} baz {"tool_call": {"name": "f2"}} qux {"tool_call": {"name": "f3"}}';
  const matches = parser.extractBalancedJsonObjects(text, 2, (obj) => obj.includes('tool_call'));

  assert.equal(matches.length, 2);
  assert.match(matches[0], /"name":\s*"f1"/);
  assert.match(matches[1], /"name":\s*"f2"/);
});

test('repairJsonText and parseJsonLenient: repairs lenient JSON strings', () => {
  // Valid JSON parses directly
  const validJson = '{"name": "test", "num": 42}';
  assert.deepEqual(parser.parseJsonLenient(validJson), { name: 'test', num: 42 });

  // Windows path with single backslashes in value
  const winPath = '{"path": "C:\\Users\\Jeff\\test.txt"}';
  const parsedWin = parser.parseJsonLenient(winPath);
  assert.equal(parsedWin.path, 'C:\\Users\\Jeff\\test.txt');

  // Raw newline inside string
  const rawNewline = '{"text": "line1\nline2"}';
  const parsedNewline = parser.parseJsonLenient(rawNewline);
  assert.equal(parsedNewline.text, 'line1\nline2');

  // Unparseable garbage throws
  assert.throws(() => parser.parseJsonLenient('not json at all {{{'));
});

test('parseDsmlToolCall: correctly parses DSML tool markup', () => {
  const dsml = `<tool_calls>
<invoke name="read_file">
<parameter name="path">/tmp/test.txt</parameter>
</invoke>
</tool_calls>`;

  const result = parser.parseDsmlToolCall(dsml);
  assert.ok(result);
  assert.equal(result.name, 'read_file');
  const args = JSON.parse(result.arguments);
  assert.equal(args.path, '/tmp/test.txt');
});

test('looksLikeToolCallMarkup: recognizes tool markup while ignoring foreign fences', () => {
  assert.ok(parser.looksLikeToolCallMarkup('TOOL_CALL: search {"query": "deepseek"}'));
  assert.ok(parser.looksLikeToolCallMarkup('<tool_call>{"name": "fetch"}</tool_call>'));
  assert.ok(parser.looksLikeToolCallMarkup('<tool_calls><invoke name="run"/></tool_calls>'));

  // Documentation example in python code fence should NOT trigger looksLikeToolCallMarkup
  const docInPython = 'Here is how to call tools in python:\n```python\nTOOL_CALL: do_something\n```\nDone.';
  assert.equal(parser.looksLikeToolCallMarkup(docInPython), false);
});

test('stripForeignCodeFences: keeps json/tool fences and strips foreign code fences', () => {
  const mixed = 'Before\n```javascript\nconsole.log("hello");\n```\nMiddle\n```json\n{"a": 1}\n```\nAfter';
  const stripped = parser.stripForeignCodeFences(mixed);
  assert.ok(!stripped.includes('console.log'));
  assert.ok(stripped.includes('{"a": 1}'));
});

test('parseToolCall: parses multiple supported formats', () => {
  // Format 1: Inline tool_call envelope
  const t1 = parser.parseToolCall('Please call this: {"tool_call": {"name": "calculator", "arguments": {"expr": "2+2"}}}');
  assert.ok(t1);
  assert.equal(t1.name, 'calculator');
  assert.deepEqual(JSON.parse(t1.arguments), { expr: '2+2' });

  // Format 2: Legacy TOOL_CALL prefix
  const t2 = parser.parseToolCall('Result:\nTOOL_CALL: get_weather {"city": "Paris"}');
  assert.ok(t2);
  assert.equal(t2.name, 'get_weather');
  assert.deepEqual(JSON.parse(t2.arguments), { city: 'Paris' });

  // Format 3: XML tag
  const t3 = parser.parseToolCall('<tool_call>{"name": "execute_cmd", "arguments": {"cmd": "ls"}}</tool_call>');
  assert.ok(t3);
  assert.equal(t3.name, 'execute_cmd');
  assert.deepEqual(JSON.parse(t3.arguments), { cmd: 'ls' });

  // Format 4: Fenced JSON block
  const t4 = parser.parseToolCall('```json\n{"tool_call": {"name": "fenced_tool", "arguments": {"x": 10}}}\n```');
  assert.ok(t4);
  assert.equal(t4.name, 'fenced_tool');
  assert.deepEqual(JSON.parse(t4.arguments), { x: 10 });

  // Format 5: DSML
  const t5 = parser.parseToolCall('<tool_calls><invoke name="dsml_tool"><parameter name="arg">val</parameter></invoke></tool_calls>');
  assert.ok(t5);
  assert.equal(t5.name, 'dsml_tool');
  assert.deepEqual(JSON.parse(t5.arguments), { arg: 'val' });

  // Non tool call plain text
  assert.equal(parser.parseToolCall('Hello, this is just a regular assistant response.'), null);
  assert.equal(parser.parseToolCall(''), null);
  assert.equal(parser.parseToolCall(null), null);
});
