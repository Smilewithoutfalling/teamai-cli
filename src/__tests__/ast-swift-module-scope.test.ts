import { describe, it, expect, beforeEach } from 'vitest';

import type { CodeCollectedFile } from '../wiki-engine/code-knowledge/code-collector.js';
import { extractStructuralGraphAsFacts } from '../wiki-engine/code-knowledge/ast/index.js';
import { swiftModuleScope } from '../wiki-engine/code-knowledge/ast/module-scope.js';
import { resetParserRegistryForTests } from '../wiki-engine/code-knowledge/ast/parser-registry.js';

function makeFile(relativePath: string, content: string): CodeCollectedFile {
  return {
    path: `/virtual/${relativePath}`,
    relativePath,
    language: 'swift',
    sha256: 'test',
    content,
  };
}

const REPO_ROOT = '/virtual';

async function extractFiles(files: Array<[string, string]>) {
  return extractStructuralGraphAsFacts({
    repoRoot: REPO_ROOT,
    files: files.map(([relativePath, content]) => makeFile(relativePath, content)),
  });
}

describe('Swift module scope', () => {
  it('reads the module boundary from a SwiftPM layout', () => {
    expect(swiftModuleScope('Sources/App/Models.swift')).toBe('Sources/App');
    expect(swiftModuleScope('Sources/App/Nested/Deep.swift')).toBe('Sources/App');
    expect(swiftModuleScope('Tests/AppTests/ModelsTests.swift')).toBe('Tests/AppTests');
    expect(swiftModuleScope('Sources\\App\\Models.swift')).toBe('Sources/App');
  });

  it('keeps the package root in the module boundary', () => {
    // Two packages in one repository can name their targets the same. The scope
    // has to span the path up to the target, or the two would be one module and
    // a name in one could resolve into the other.
    const a = swiftModuleScope('Packages/A/Sources/App/Models.swift');
    const b = swiftModuleScope('Packages/B/Sources/App/Models.swift');
    expect(a).toBe('Packages/A/Sources/App');
    expect(b).toBe('Packages/B/Sources/App');
    expect(a).not.toBe(b);
  });

  it('takes the innermost marker, so a package vendored under Tests/ keeps its own root', () => {
    // A repository may vendor whole packages under a directory it already named
    // `Tests`/`Sources`. The inner marker is those packages' boundary; taking the
    // outer one would scope `Tests/Fixtures/A/...` and `Tests/Fixtures/B/...` to
    // the same `Tests/Fixtures` and merge two packages.
    expect(swiftModuleScope('Tests/Fixtures/A/Sources/App/Models.swift')).toBe('Tests/Fixtures/A/Sources/App');
    expect(swiftModuleScope('Tests/Fixtures/A/Sources/App/Deep/Models.swift')).toBe('Tests/Fixtures/A/Sources/App');
    // A directory merely *named* `Tests` inside a target is not a boundary when
    // it cannot hold a target directory of its own — the file directly under it
    // leaves the real marker the only candidate.
    expect(swiftModuleScope('Sources/App/Tests/Helper.swift')).toBe('Sources/App');
    // The bias this direction buys: a marker this function mistakes for a
    // package root only ever yields a scope nested INSIDE the true module, so it
    // under-scopes (loses a resolution) instead of spanning two real modules.
    expect(swiftModuleScope('Sources/App/Tests/Sub/Helper.swift')).toBe('Sources/App/Tests/Sub');
  });

  it('refuses to invent a module where the layout states none', () => {
    // No `Sources/` or `Tests/` segment: an arbitrary directory tree says
    // nothing about Swift's module boundary, so no scope is claimed.
    expect(swiftModuleScope('App/Models.swift')).toBeUndefined();
    expect(swiftModuleScope('MySources/App/Models.swift')).toBeUndefined();
    // A file sitting directly under Sources/ has no target directory.
    expect(swiftModuleScope('Sources/App.swift')).toBeUndefined();
    expect(swiftModuleScope('Sources/App/Models.ts')).toBeUndefined();
  });
});

describe('Swift module-scope resolution (web-tree-sitter WASM)', () => {
  beforeEach(() => {
    resetParserRegistryForTests();
  });

  it('resolves a conformance to a protocol declared in another file of the same module', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Protocols.swift', 'protocol LocalProto {\n  func describe() -> String\n}\n'],
      [
        'Sources/App/Models.swift',
        'struct Point: LocalProto {\n  func describe() -> String { return "point" }\n}\n',
      ],
    ]);

    const implementsEdges = result.edges.filter((e) => e.relation === 'IMPLEMENTS');
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]?.from).toBe('Sources/App/Models.swift');
    expect(implementsEdges[0]?.to).toBe('Sources/App/Protocols.swift');
    expect(implementsEdges[0]?.evidence[0]?.note).toBe('Point implements LocalProto');
  });

  it('resolves a call to a function declared in another file of the same module', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Math.swift', 'func helper() -> Int { return 1 }\n'],
      ['Sources/App/Runner.swift', 'func run() -> Int {\n  return helper()\n}\n'],
    ]);

    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.from).toBe('Sources/App/Runner.swift');
    expect(references[0]?.to).toBe('Sources/App/Math.swift');
    expect(references[0]?.confidence).toBe('INFERRED');
  });

  it('resolves a receiver call whose type lives in another file of the same module', async () => {
    const { result } = await extractFiles([
      ['Sources/App/Service.swift', 'class Service {\n  func ping() -> Int { return 1 }\n}\n'],
      ['Sources/App/App.swift', 'func run() -> Int {\n  return Service.ping()\n}\n'],
    ]);

    const references = result.edges.filter((e) => e.relation === 'REFERENCES');
    expect(references).toHaveLength(1);
    expect(references[0]?.to).toBe('Sources/App/Service.swift');
  });

  it('keeps a symbol from a different target unresolved', async () => {
    const { result } = await extractFiles([
      ['Sources/Other/Remote.swift', 'protocol RemoteProto { }\n'],
      ['Sources/App/Models.swift', 'struct Point: RemoteProto { }\n'],
    ]);

    // A separate target is a separate module: without an import the name is not
    // visible, and emitting an edge here would be fabrication.
    expect(result.edges.filter((e) => e.relation === 'IMPLEMENTS')).toHaveLength(0);
  });

  it('emits nothing when the name is declared more than once in the module', async () => {
    const { result } = await extractFiles([
      ['Sources/App/A.swift', 'protocol Dup { }\n'],
      ['Sources/App/B.swift', 'protocol Dup { }\n'],
      ['Sources/App/C.swift', 'struct S: Dup { }\n'],
    ]);

    // Two candidates mean the layout cannot say which file defines it, so the
    // resolution declines rather than picking one at random.
    expect(result.edges.filter((e) => e.relation === 'IMPLEMENTS')).toHaveLength(0);
  });

  it('does not guess a module outside a SwiftPM layout', async () => {
    const { result } = await extractFiles([
      ['App/Protocols.swift', 'protocol LocalProto { }\n'],
      ['App/Models.swift', 'struct Point: LocalProto { }\n'],
    ]);

    expect(result.edges.filter((e) => e.relation === 'IMPLEMENTS')).toHaveLength(0);
  });

  it('leaves same-file resolution unchanged', async () => {
    const { result } = await extractFiles([
      [
        'Sources/App/All.swift',
        [
          'protocol LocalProto { }',
          '',
          'struct Point: LocalProto { }',
          '',
          'func helper() -> Int { return 1 }',
          '',
          'func run() -> Int { return helper() }',
          '',
        ].join('\n'),
      ],
    ]);

    const implementsEdges = result.edges.filter((e) => e.relation === 'IMPLEMENTS');
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]?.from).toBe('Sources/App/All.swift');
    expect(implementsEdges[0]?.to).toBe('Sources/App/All.swift');

    // A same-file call still resolves to EXTRACTED; it must not be downgraded
    // to the cross-file path now that the fallback exists.
    const helperCall = result.callSites.find((c) => c.calleeText === 'helper');
    expect(helperCall?.confidence).toBe('EXTRACTED');
    expect(helperCall?.resolvedTargetFile).toBe('Sources/App/All.swift');
  });

  it('does not resolve a file-scoped declaration from another file', async () => {
    const { result } = await extractFiles([
      [
        'Sources/App/Internal.swift',
        [
          'private func hidden() -> Int { return 1 }',
          'fileprivate func alsoHidden() -> Int { return 2 }',
          'func visible() -> Int { return 3 }',
          '',
        ].join('\n'),
      ],
      [
        'Sources/App/Runner.swift',
        [
          'func run() -> Int {',
          '  let a = hidden()',
          '  let b = alsoHidden()',
          '  let c = visible()',
          '  return a + b + c',
          '}',
          '',
        ].join('\n'),
      ],
    ]);

    const calls = new Map(result.callSites.map((c) => [c.calleeText, c]));
    for (const name of ['hidden', 'alsoHidden', 'visible']) {
      expect(calls.has(name)).toBe(true);
    }
    // Same file, same call shape, same `-> Int` signature: the only variable is
    // the modifier on the declaration. `private` and `fileprivate` stop at the
    // file that declares them; the unmodified function is module-wide.
    expect(calls.get('hidden')?.resolvedTargetFile).toBeUndefined();
    expect(calls.get('alsoHidden')?.resolvedTargetFile).toBeUndefined();
    expect(calls.get('visible')?.resolvedTargetFile).toBe('Sources/App/Internal.swift');
  });

  it('does not resolve a method or a protocol requirement from another file', async () => {
    const { result } = await extractFiles([
      [
        'Sources/App/Service.swift',
        [
          'struct Service {',
          '  func handle() -> Int { return 1 }',
          '}',
          '',
          'protocol Handler {',
          '  func respond() -> Int',
          '}',
          '',
          'func handled() -> Int { return 2 }',
          '',
        ].join('\n'),
      ],
      [
        'Sources/App/Runner.swift',
        [
          'func run() -> Int {',
          '  let a = handle()',
          '  let b = respond()',
          '  let c = handled()',
          '  return a + b + c',
          '}',
          '',
        ].join('\n'),
      ],
    ]);

    const calls = new Map(result.callSites.map((c) => [c.calleeText, c]));
    for (const name of ['handle', 'respond', 'handled']) {
      expect(calls.has(name)).toBe(true);
    }
    // A member is reached through its container, not by a bare name, so only the
    // top-level function is something a sibling file can call on its own.
    expect(calls.get('handle')?.resolvedTargetFile).toBeUndefined();
    expect(calls.get('respond')?.resolvedTargetFile).toBeUndefined();
    expect(calls.get('handled')?.resolvedTargetFile).toBe('Sources/App/Service.swift');
  });

  it('does not resolve a type nested inside another file', async () => {
    const { result } = await extractFiles([
      [
        'Sources/App/Outer.swift',
        [
          'struct Outer {',
          '  struct Config {',
          '    static func make() -> Int { return 1 }',
          '  }',
          '}',
          '',
          'struct TopLevelConfig {',
          '  static func make() -> Int { return 2 }',
          '}',
          '',
        ].join('\n'),
      ],
      [
        'Sources/App/Builder.swift',
        [
          'func build() -> Int {',
          '  let a = Config.make()',
          '  let b = TopLevelConfig.make()',
          '  return a + b',
          '}',
          '',
        ].join('\n'),
      ],
    ]);

    const calls = new Map(result.callSites.map((c) => [c.calleeText, c]));
    for (const name of ['Config.make', 'TopLevelConfig.make']) {
      expect(calls.has(name)).toBe(true);
    }
    expect(calls.get('Config.make')?.resolvedTargetFile).toBeUndefined();
    expect(calls.get('TopLevelConfig.make')?.resolvedTargetFile).toBe('Sources/App/Outer.swift');
  });

  it('does not merge same-named targets of different packages', async () => {
    const { result } = await extractFiles([
      ['Packages/A/Sources/App/Proto.swift', 'protocol Shared { }\n'],
      ['Packages/B/Sources/App/Model.swift', 'struct S: Shared { }\n'],
    ]);

    // `Packages/A/Sources/App` and `Packages/B/Sources/App` share their last two
    // segments but are separate modules, so the name stays unresolved.
    expect(result.edges.filter((e) => e.relation === 'IMPLEMENTS')).toHaveLength(0);
  });

  it('resolves inside a nested package target', async () => {
    const { result } = await extractFiles([
      ['Packages/A/Sources/App/Proto.swift', 'protocol Shared { }\n'],
      ['Packages/A/Sources/App/Model.swift', 'struct S: Shared { }\n'],
    ]);

    // The control for the case above: the same layout, one package, so the
    // conformance must still resolve.
    const implementsEdges = result.edges.filter((e) => e.relation === 'IMPLEMENTS');
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]?.to).toBe('Packages/A/Sources/App/Proto.swift');
  });

  it('does not merge two packages vendored under the same Tests directory', async () => {
    const { result } = await extractFiles([
      ['Tests/Fixtures/A/Sources/App/Proto.swift', 'protocol Shared { }\n'],
      ['Tests/Fixtures/B/Sources/App/Model.swift', 'struct S: Shared { }\n'],
    ]);

    // Both paths carry an outer `Tests` segment. A scan that took the first
    // marker would scope both to `Tests/Fixtures` — the same merge the package
    // root fix rules out one level down, just reached through the outer package.
    expect(result.edges.filter((e) => e.relation === 'IMPLEMENTS')).toHaveLength(0);
  });

  it('resolves inside a package vendored under a Tests directory', async () => {
    const { result } = await extractFiles([
      ['Tests/Fixtures/A/Sources/App/Proto.swift', 'protocol Shared { }\n'],
      ['Tests/Fixtures/A/Sources/App/Model.swift', 'struct S: Shared { }\n'],
    ]);

    // The control for the case above: the same layout, one fixture package.
    const implementsEdges = result.edges.filter((e) => e.relation === 'IMPLEMENTS');
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]?.to).toBe('Tests/Fixtures/A/Sources/App/Proto.swift');
  });
});
