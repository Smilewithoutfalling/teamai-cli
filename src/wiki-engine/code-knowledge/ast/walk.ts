import path from "node:path";

import type { Node } from "web-tree-sitter";

import type { CodeCollectedFile } from "../code-collector.js";
import {
  collectExportLineStarts,
  isExportedSymbol,
  isTypeOnlyImport,
  normalizeImportSpecifier,
  parseImportBindings
} from "./import-bindings.js";
import { grammarForExtension, getLanguage, getParser, getQuery } from "./parser-registry.js";
import type { AstCallSite, AstImplementsSite, AstImport, AstSymbol, AstSymbolKind } from "./types.js";

export interface FileWalkResult {
  symbols: AstSymbol[];
  /**
   * Swift only: the declarations a sibling file of the same module can reach by
   * name. Empty for every other language, and a subset of `symbols` for Swift.
   */
  swiftModuleSymbols: AstSymbol[];
  imports: AstImport[];
  callSites: AstCallSite[];
  implementsSites: AstImplementsSite[];
  parseErrors: string[];
}

const MAX_FILE_BYTES = 512 * 1024;

export function isAstParseableFile(relativePath: string): boolean {
  return grammarForExtension(path.extname(relativePath)) !== undefined;
}

export function walkFile(file: CodeCollectedFile): FileWalkResult {
  const symbols: AstSymbol[] = [];
  const swiftModuleSymbols: AstSymbol[] = [];
  const imports: AstImport[] = [];
  const callSites: AstCallSite[] = [];
  const implementsSites: AstImplementsSite[] = [];
  const parseErrors: string[] = [];

  if (!isAstParseableFile(file.relativePath)) {
    return { symbols, swiftModuleSymbols, imports, callSites, implementsSites, parseErrors };
  }

  if (Buffer.byteLength(file.content, "utf8") > MAX_FILE_BYTES) {
    parseErrors.push(`skipped large file: ${file.relativePath}`);
    return { symbols, swiftModuleSymbols, imports, callSites, implementsSites, parseErrors };
  }

  const variant = grammarForExtension(path.extname(file.relativePath))!;
  const language = getLanguage(variant);
  const parser = getParser();
  parser.setLanguage(language);

  let tree;
  try {
    tree = parser.parse(file.content);
  } catch (error) {
    parseErrors.push(`parse failed: ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    return { symbols, swiftModuleSymbols, imports, callSites, implementsSites, parseErrors };
  }

  if (!tree) {
    parseErrors.push(`parse returned null: ${file.relativePath}`);
    return { symbols, swiftModuleSymbols, imports, callSites, implementsSites, parseErrors };
  }

  try {
    const query = getQuery(variant);
    const exportLineStarts = collectExportLineStarts(variant, tree.rootNode);

    for (const match of query.matches(tree.rootNode)) {
      const byName = new Map(match.captures.map((c) => [c.name, c.node]));

      if (byName.has("import.stmt")) {
        const stmt = byName.get("import.stmt")!;
        const specNode = byName.get("import.spec");
        if (!specNode) continue;
        const specifier = normalizeImportSpecifier(specNode.text, variant);
        const line = stmt.startPosition.row + 1;
        const isTypeOnly = isTypeOnlyImport(stmt.text, variant);
        imports.push({
          fromFile: file.relativePath,
          specifier,
          line,
          isTypeOnly,
          ...parseImportBindings(stmt.text, variant)
        });
        continue;
      }

      const symbolName = byName.get("symbol.name")?.text;
      if (symbolName) {
        const decl =
          byName.get("symbol.class") ?? byName.get("symbol.function") ?? byName.get("symbol.interface");
        if (!decl) continue;
        const kind: AstSymbolKind = byName.has("symbol.class")
          ? "class"
          : byName.has("symbol.interface")
            ? "interface"
            : "function";
        const lineStart = decl.startPosition.row + 1;
        const lineEnd = decl.endPosition.row + 1;
        const exported = isExportedSymbol(variant, decl.startIndex, file.content, lineStart, exportLineStarts);
        const symbol: AstSymbol = {
          id: symbolId(file.relativePath, kind, symbolName),
          kind,
          name: symbolName,
          file: file.relativePath,
          lineStart,
          lineEnd,
          exported
        };
        symbols.push(symbol);
        // Swift files in one module see each other without any import, so the
        // module index needs exactly the declarations a sibling can reach.
        if (variant === "swift" && isSwiftModuleVisible(decl)) {
          swiftModuleSymbols.push(symbol);
        }
        continue;
      }

      if (byName.has("call.stmt") || byName.has("call.member")) {
        const callNode = byName.get("call.stmt") ?? byName.get("call.member")!;
        const line = callNode.startPosition.row + 1;
        const callee = byName.get("call.callee")?.text;
        const receiver = byName.get("call.receiver")?.text;
        const member = byName.get("call.member")?.text;
        const calleeText = callee ?? (receiver && member ? `${receiver}.${member}` : callNode.text);
        const localBindings = variant === "swift" ? swiftLocalBindingsAt(callNode) : [];
        callSites.push({
          fromFile: file.relativePath,
          line,
          calleeText,
          receiver,
          ...(localBindings.length > 0 ? { localBindings } : {}),
          confidence: "INFERRED"
        });
        continue;
      }

      if (byName.has("impl.stmt")) {
        const classNode = byName.get("impl.class");
        const ifaceNames = match.captures
          .filter((c) => c.name === "impl.iface")
          .map((c) => c.node.text);
        if (classNode && ifaceNames.length > 0) {
          implementsSites.push({
            fromFile: file.relativePath,
            className: classNode.text,
            ifaceNames,
            line: classNode.startPosition.row + 1
          });
        }
        continue;
      }
    }
  } finally {
    tree.delete();
  }

  return { symbols, swiftModuleSymbols, imports, callSites, implementsSites, parseErrors };
}

/**
 * Whether the other files of a Swift module can reach this declaration by name.
 *
 * There is no `import` between the files of one module, so a sibling file sees
 * every top-level declaration that is not narrowed to its own file. Two
 * exclusions follow, and both are load-bearing when a name is looked up
 * module-wide:
 *
 * - **Not top-level.** A method, a protocol requirement or a type nested in
 *   another type is reached through its container, not by a bare name. Admitting
 *   one would let an unqualified call in one file bind to an unrelated method in
 *   another, and two same-named members would also look like an ambiguous module
 *   name and suppress a resolution that was correct.
 * - **Not file-scoped.** `private` and `fileprivate` narrow a declaration to the
 *   file that declares it (or to its enclosing declaration), so a sibling cannot
 *   see it. `private(set)` narrows only the setter and is *not* file-scoped;
 *   the grammar reports it as `private(set)`, which the comparison below leaves
 *   alone.
 *
 * Absence of a `modifiers` child means the default, `internal`, which the whole
 * module sees.
 *
 * `namedChildren` is typed `(Node | null)[]` in web-tree-sitter, so both child
 * lookups below are null-guarded with `?.`. The `?.` is load-bearing: without it
 * the callbacks would have to reason about a null hole, and `tsc --noEmit`
 * rejects them.
 */
function isSwiftModuleVisible(decl: Node): boolean {
  if (decl.parent?.type !== "source_file") {
    return false;
  }
  const modifiers = decl.namedChildren.find((child) => child?.type === "modifiers");
  if (!modifiers) {
    return true;
  }
  return !modifiers.namedChildren.some(
    (child) =>
      child?.type === "visibility_modifier" && (child.text === "private" || child.text === "fileprivate")
  );
}

function symbolId(file: string, kind: AstSymbolKind, name: string): string {
  const kindLabel = kind.charAt(0).toUpperCase() + kind.slice(1);
  return `${file}#${kindLabel}:${name}`;
}

/** web-tree-sitter types `namedChildren` as `(Node | null)[]`; drop the holes. */
function namedChildrenOf(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

const SWIFT_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function addSwiftName(name: string, names: Set<string>): void {
  // `_` is the "no internal name" placeholder, not a binding.
  if (name === "_" || !SWIFT_IDENTIFIER.test(name)) {
    return;
  }
  names.add(name);
}

/** Every identifier under `node`, skipping type positions such as `Int` in `(work: Int)`. */
function collectSwiftIdentifiers(node: Node, names: Set<string>): void {
  if (node.type === "simple_identifier") {
    addSwiftName(node.text, names);
    return;
  }
  if (node.type === "user_type" || node.type === "type_identifier") {
    return;
  }
  for (const child of namedChildrenOf(node)) {
    collectSwiftIdentifiers(child, names);
  }
}

/**
 * The names one binding construct introduces.
 *
 * Two shapes carry them in this grammar: a `pattern` child that holds the names
 * directly (`let work`, `let (a, b)`, `for x in`, `catch let x`), and a
 * `value_binding_pattern` whose *next* sibling is the name (`guard let work`,
 * `if let work`, `case let work`, and `let work = x`, where that sibling is a
 * `pattern`).
 *
 * A `simple_identifier` that is neither of those is a *use*, not a binding —
 * `property_declaration` for `let work = pair` holds `pair` as a bare child, and
 * collecting it would invent a name.
 */
function addSwiftBoundNames(scope: Node, names: Set<string>): void {
  const children = namedChildrenOf(scope);
  children.forEach((child, index) => {
    if (child.type !== "value_binding_pattern") {
      return;
    }
    const bound = children[index + 1];
    if (bound?.type === "simple_identifier") {
      addSwiftName(bound.text, names);
    } else if (bound?.type === "pattern") {
      collectSwiftIdentifiers(bound, names);
    }
  });
  for (const child of children) {
    if (child.type === "pattern") {
      collectSwiftIdentifiers(child, names);
    }
  }
}

/**
 * A parameter binds the *last* identifier in its leading run: an external label
 * comes first, so `with work: Int` and `_ work: Int` both bind `work`, while
 * `with: Int` binds `with`. Stopping at the first non-identifier keeps a default
 * value such as `x: Int = defaultX` from contributing `defaultX`.
 */
function addSwiftParameterName(parameter: Node, names: Set<string>): void {
  let candidate: string | undefined;
  for (const child of namedChildrenOf(parameter)) {
    if (child.type !== "simple_identifier") {
      break;
    }
    candidate = child.text;
  }
  if (candidate !== undefined) {
    addSwiftName(candidate, names);
  }
}

/**
 * The names bound by an enclosing scope at `node`, in Swift.
 *
 * This is the missing half of the module-wide lookup. `call-resolver` decides
 * *which module* a bare call belongs to, but only the syntax tree knows whether
 * the name is a module-level declaration at all: `run(work:) { work() }` calls
 * its parameter, and a `let work = ...` above the call wins over a sibling
 * file's `func work()`. Resolving those against the module would fabricate a
 * cross-file edge, which is worse than missing one, so the names are gathered
 * here — while the tree is still in hand — and carried on the call site.
 *
 * The walk stops at the call's own ancestors, so a binding in an unrelated
 * function of the same file cannot shadow anything. It deliberately
 * over-collects inside the scopes it does visit: a binding introduced by an
 * `if let` reaches the `else` branch it does not cover, and a `where` clause
 * sees the `case let` it follows. Over-collecting costs a resolution; the
 * opposite error invents an edge, so the asymmetry is the point.
 */
function swiftLocalBindingsAt(node: Node): string[] {
  const names = new Set<string>();
  const position = node.startIndex;
  let current: Node = node;
  while (current.parent) {
    const scope = current.parent;
    switch (scope.type) {
      case "function_declaration":
      case "protocol_function_declaration":
      case "init_declaration":
      case "deinit_declaration":
      case "subscript_declaration":
        for (const child of namedChildrenOf(scope)) {
          if (child.type === "parameter") {
            addSwiftParameterName(child, names);
          }
        }
        break;
      case "lambda_literal":
        for (const child of namedChildrenOf(scope)) {
          if (child.type !== "lambda_function_type") {
            continue;
          }
          for (const params of namedChildrenOf(child)) {
            if (params.type === "lambda_function_type_parameters") {
              collectSwiftIdentifiers(params, names);
            }
          }
        }
        break;
      case "statements":
        // Only what is declared *before* the call: a later statement, or one in
        // a nested block, is not in scope at this position.
        for (const child of namedChildrenOf(scope)) {
          if (child.startIndex >= position) {
            continue;
          }
          if (child.type === "property_declaration" || child.type === "guard_statement") {
            addSwiftBoundNames(child, names);
          }
        }
        break;
      case "switch_entry":
        for (const child of namedChildrenOf(scope)) {
          if (child.type === "switch_pattern") {
            addSwiftBoundNames(child, names);
          }
        }
        break;
      case "for_statement":
      case "catch_block":
      case "if_statement":
      case "while_statement":
        addSwiftBoundNames(scope, names);
        break;
      default:
        break;
    }
    current = scope;
  }
  return [...names];
}
