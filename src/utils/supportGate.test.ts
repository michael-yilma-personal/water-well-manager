import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

/**
 * The support gate is an inline classic script in each HTML entry point. It
 * must be plain ES5 and self-contained: a browser too old to parse the app
 * bundle (iOS 12 Safari chokes on `??`) only ever runs this script, so it is
 * the one chance to say why the page is otherwise empty.
 */
const ROOT = path.resolve(import.meta.dirname, '../..');

function gateScript(file: string): string {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const matches = html.match(/<script id="support-gate">([\s\S]*?)<\/script>/g) ?? [];
  assert.equal(matches.length, 1, `${file} must contain exactly one support-gate script`);
  return matches[0].replace(/^<script id="support-gate">/, '').replace(/<\/script>$/, '');
}

interface FakeElement {
  id: string;
  innerHTML: string;
  style: string;
  setAttribute(name: string, value: string): void;
}

interface Env {
  supportsCss?: boolean;
  hasCssApi?: boolean;
  syntaxOk?: boolean;
  hasRandomUuid?: boolean;
  hasStructuredClone?: boolean;
  hasRoot?: boolean;
}

/** Runs the gate against a stand-in for the browser and returns #root afterwards. */
function runGate(env: Env = {}): FakeElement | null {
  const {
    supportsCss = true,
    hasCssApi = true,
    syntaxOk = true,
    hasRandomUuid = true,
    hasStructuredClone = true,
    hasRoot = true,
  } = env;
  const root: FakeElement | null = hasRoot
    ? {
        id: 'root',
        innerHTML: '',
        style: '',
        setAttribute(name, value) {
          if (name === 'style') this.style = value;
        },
      }
    : null;
  const sandbox: Record<string, unknown> = {
    document: { getElementById: (id: string) => (root && root.id === id ? root : null) },
    navigator: { userAgent: 'Mozilla/5.0 (iPad; CPU OS 12_1 like Mac OS X) Safari/605.1.15' },
    crypto: hasRandomUuid ? { randomUUID: () => 'uuid' } : {},
  };
  if (hasCssApi) sandbox.CSS = { supports: () => supportsCss };
  if (hasStructuredClone) sandbox.structuredClone = (v: unknown) => v;
  if (!syntaxOk) {
    sandbox.Function = function () {
      throw new SyntaxError('Unexpected token');
    };
  }
  sandbox.window = sandbox;
  vm.runInContext(gateScript('index.html'), vm.createContext(sandbox));
  return root;
}

test('index.html and admin.html carry the same support gate', () => {
  assert.equal(gateScript('admin.html'), gateScript('index.html'));
});

test('the gate is ES5 so a 2018 Safari can run it', () => {
  const script = gateScript('index.html');
  for (const modern of ['=>', 'const ', 'let ', '`', 'class ', '?.', '??']) {
    assert.ok(!script.includes(modern), `gate must not use ${JSON.stringify(modern)}`);
  }
});

test('a current browser is left alone so the app mounts into #root', () => {
  const root = runGate();
  assert.equal(root?.id, 'root');
  assert.equal(root?.innerHTML, '');
});

test('a browser that cannot parse modern syntax sees the message instead of a blank page', () => {
  const root = runGate({ syntaxOk: false });
  assert.notEqual(root?.id, 'root');
  assert.match(root?.innerHTML ?? '', /too old/);
  assert.match(root?.innerHTML ?? '', /iOS 16 or newer/);
});

test('a browser without the colour support the stylesheet needs sees the message', () => {
  const root = runGate({ supportsCss: false });
  assert.notEqual(root?.id, 'root');
  assert.match(root?.innerHTML ?? '', /too old/);
});

test('a browser without CSS.supports at all sees the message', () => {
  const root = runGate({ hasCssApi: false });
  assert.notEqual(root?.id, 'root');
});

test('a browser that cannot mint record ids sees the message', () => {
  const root = runGate({ hasRandomUuid: false });
  assert.notEqual(root?.id, 'root');
});

test('a browser without structuredClone sees the message', () => {
  const root = runGate({ hasStructuredClone: false });
  assert.notEqual(root?.id, 'root');
});

test('the message names the browser so support can read it off a photo', () => {
  const root = runGate({ syntaxOk: false });
  assert.match(root?.innerHTML ?? '', /CPU OS 12_1/);
});

test('a page with no #root does not throw', () => {
  assert.doesNotThrow(() => runGate({ hasRoot: false, syntaxOk: false }));
});
