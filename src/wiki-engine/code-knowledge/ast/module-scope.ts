import type { AstSymbol, AstSymbolKind } from "./types.js";

/**
 * Swift has no source-level package or module declaration — unlike Go's
 * `package` clause or Python's file-as-module rule, the module boundary is a
 * build-system fact that the AST cannot read. The only layout with a mandated
 * shape is SwiftPM: everything under `<package>/Sources/<Target>/` is one
 * module, and everything under `<package>/Tests/<Target>/` is another (test
 * targets see the library through `@testable import`, not by being the same
 * module).
 *
 * The key spans the path *up to and including* the target directory, not just
 * the `Sources/<Target>` tail. One repository can hold several Swift packages
 * side by side, and `Packages/A/Sources/App` and `Packages/B/Sources/App` are
 * two different modules that happen to share their last two segments; keying on
 * the tail alone would merge them and let a name in one package resolve into
 * the other.
 *
 * Outside that layout this function returns `undefined` on purpose. Guessing a
 * module boundary from an arbitrary directory tree would fabricate edges
 * between files that Swift actually keeps apart, and a wrong edge is worse than
 * a missing one: the missing one still surfaces as a gap.
 */
export function swiftModuleScope(relativePath: string): string | undefined {
  const normalized = relativePath.replace(/\\/gu, "/");
  if (!normalized.toLowerCase().endsWith(".swift")) {
    return undefined;
  }
  const segments = normalized.split("/");
  // The loop stops before the last two segments: they have to hold the root
  // directory and the target directory, so `Sources/App.swift` states no
  // target and gets no scope.
  for (let index = 0; index < segments.length - 2; index++) {
    const segment = segments[index];
    if (segment !== "Sources" && segment !== "Tests") {
      continue;
    }
    return segments.slice(0, index + 2).join("/");
  }
  return undefined;
}

export interface SwiftModuleSymbolIndex {
  /** Module scope key → every declaration found in that module. */
  byModule: Map<string, AstSymbol[]>;
  /** File → its module scope key, for files that sit inside a known module. */
  scopeOfFile: Map<string, string>;
}

/**
 * Index the declarations that a sibling file can reach by name.
 *
 * The caller supplies module-visible declarations only — top-level, and not
 * `private` / `fileprivate`. Neither fact survives into `AstSymbol`, so it
 * cannot be re-checked here; handing this function the full symbol list instead
 * would let a method, a protocol requirement or a file-scoped declaration
 * resolve from another file, which is exactly the fabricated edge this layer
 * exists to avoid. `walk.ts` decides it, at the point where the declaration node
 * is still in hand.
 */
export function buildSwiftModuleSymbolIndex(symbols: AstSymbol[]): SwiftModuleSymbolIndex {
  const byModule = new Map<string, AstSymbol[]>();
  const scopeOfFile = new Map<string, string>();

  for (const symbol of symbols) {
    const scope = swiftModuleScope(symbol.file);
    if (!scope) {
      continue;
    }
    scopeOfFile.set(symbol.file, scope);
    const bucket = byModule.get(scope);
    if (bucket) {
      bucket.push(symbol);
    } else {
      byModule.set(scope, [symbol]);
    }
  }

  return { byModule, scopeOfFile };
}

/**
 * Find the single declaration of `name` in the same Swift module as `fromFile`.
 *
 * Returns `undefined` when the name is declared in another module, not at all,
 * or more than once inside this one. An ambiguous name means the layout cannot
 * say which file it lives in, so the caller records nothing rather than picking
 * one arbitrarily — the same reasoning the module-import gap already follows.
 *
 * Declarations in `fromFile` are excluded: the same-file lookup in the caller
 * already covers those, and admitting them here would let a same-file match
 * arrive through the cross-file path.
 */
export function findSwiftModuleSymbol(
  index: SwiftModuleSymbolIndex,
  fromFile: string,
  name: string,
  kinds: readonly AstSymbolKind[]
): AstSymbol | undefined {
  const scope = index.scopeOfFile.get(fromFile) ?? swiftModuleScope(fromFile);
  if (!scope) {
    return undefined;
  }
  const matches = (index.byModule.get(scope) ?? []).filter(
    (symbol) => symbol.name === name && symbol.file !== fromFile && kinds.includes(symbol.kind)
  );
  return matches.length === 1 ? matches[0] : undefined;
}
