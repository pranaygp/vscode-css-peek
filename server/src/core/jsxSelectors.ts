import { parse } from "@babel/parser";
import type * as t from "@babel/types";
import { TextDocument } from "vscode-languageserver-textdocument";
import { Selector } from "../types";

import { htmlSelectorRanges, SelectorRange } from "./htmlSelectors";

// Keep only selector ranges, not syntax trees. TextDocuments are released when
// closed, and editing one invalidates its ranges without retaining old versions.
const cache = new WeakMap<
  TextDocument,
  { version: number; ranges: SelectorRange[] }
>();

const functionTypes = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);
const scopeTypes = new Set([
  ...functionTypes,
  "BlockStatement",
  "CatchClause",
  "ForOfStatement",
  "ForInStatement",
  "ForStatement",
  "ClassExpression",
]);
const metadataKeys = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "errors",
  "comments",
]);

function forEachChild(node: t.Node, visit: (child: t.Node) => void): void {
  for (const key in node) {
    if (metadataKeys.has(key)) continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value)
        if (child && typeof child.type === "string") visit(child);
    } else if (value && typeof value === "object" && "type" in value)
      visit(value as t.Node);
  }
}

export function findJSXSelector(
  document: TextDocument,
  offset: number,
  supportTags: boolean,
): Selector | null {
  let entry = cache.get(document);
  if (!entry || entry.version !== document.version) {
    entry = { version: document.version, ranges: collectSelectors(document) };
    cache.set(document, entry);
  }
  const range = entry.ranges.find(
    ({ start, end, selector }) =>
      offset >= start &&
      offset <= end &&
      (selector.attribute !== null || supportTags),
  );
  return range?.selector || null;
}

function collectSelectors(document: TextDocument): SelectorRange[] {
  const text = document.getText();
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(text, {
      sourceType: "unambiguous",
      plugins: document.languageId.startsWith("typescript")
        ? ["jsx", "typescript", "decorators-legacy"]
        : ["jsx", "decorators-legacy"],
      errorRecovery: true,
      // Comments and tokens are unnecessary for selector navigation.
      attachComment: false,
    });
  } catch {
    // An incomplete expression is normal while editing. Never fall back to an
    // HTML scanner here: it mistakes JS comparisons and strings for JSX (#96).
    return [];
  }

  const ranges: SelectorRange[] = [];
  const helpers = new Set<string>();
  const modules = new Map<string, string>();
  const templateTags = new Set<string>();
  const templateNamespaces = new Set<string>();
  const shadowScopes: Set<string>[] = [];
  const isShadowed = (name: string) =>
    shadowScopes.some((scope) => scope.has(name));
  for (const statement of ast.program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    if (/^(?:lit|lit-html|lit-element)$/.test(statement.source.value)) {
      for (const specifier of statement.specifiers) {
        if (
          specifier.type === "ImportSpecifier" &&
          ["html", "svg", "mathml"].includes(
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value,
          )
        )
          templateTags.add(specifier.local.name);
        else if (specifier.type === "ImportNamespaceSpecifier")
          templateNamespaces.add(specifier.local.name);
      }
    }
    if (/^(?:clsx|classnames)$/.test(statement.source.value)) {
      for (const specifier of statement.specifiers)
        helpers.add(specifier.local.name);
    }
    if (/\.(?:css|scss|sass|less)$/.test(statement.source.value)) {
      for (const specifier of statement.specifiers) {
        if (
          specifier.type === "ImportDefaultSpecifier" ||
          specifier.type === "ImportNamespaceSpecifier"
        ) {
          try {
            modules.set(
              specifier.local.name,
              new URL(statement.source.value, document.uri).toString(),
            );
          } catch {
            /* Unsupported import URI: leave JavaScript navigation alone. */
          }
        }
      }
    }
  }

  function addWords(
    start: number,
    end: number,
    attribute: string,
    moduleUri?: string,
  ) {
    const value = text.slice(start, end);
    for (const match of value.matchAll(/\S+/g)) {
      // Escaped JS strings cannot be mapped to a CSS identifier by slicing;
      // don't return a misleading partial name for those expressions.
      if (match[0].includes("\\") || match[0].includes("${")) continue;
      const wordStart = start + match.index!;
      ranges.push({
        start: wordStart,
        end: wordStart + match[0].length,
        selector: {
          attribute,
          value: match[0],
          ...(moduleUri ? { moduleUri } : {}),
        },
      });
    }
  }

  function literal(
    node: t.StringLiteral | t.TemplateLiteral,
    attribute: string,
  ) {
    if (node.type === "TemplateLiteral") {
      if (node.expressions.length === 0)
        addWords(node.start! + 1, node.end! - 1, attribute);
    } else {
      addWords(node.start! + 1, node.end! - 1, attribute);
    }
  }

  function expression(
    node: t.Node | null | undefined,
    attribute: string,
    helperArgument = false,
  ): void {
    if (!node) return;
    switch (node.type) {
      case "StringLiteral":
      case "TemplateLiteral":
        literal(node, attribute);
        break;
      case "ConditionalExpression":
        expression(node.consequent, attribute, helperArgument);
        expression(node.alternate, attribute, helperArgument);
        break;
      case "LogicalExpression":
        expression(node.left, attribute, helperArgument);
        expression(node.right, attribute, helperArgument);
        break;
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
        expression(node.expression, attribute, helperArgument);
        break;
      case "MemberExpression": {
        if (attribute !== "class" || node.object.type !== "Identifier") break;
        const moduleUri = isShadowed(node.object.name)
          ? undefined
          : modules.get(node.object.name);
        if (!moduleUri) break;
        if (!node.computed && node.property.type === "Identifier") {
          addWords(
            node.property.start!,
            node.property.end!,
            attribute,
            moduleUri,
          );
        } else if (node.computed && node.property.type === "StringLiteral") {
          addWords(
            node.property.start! + 1,
            node.property.end! - 1,
            attribute,
            moduleUri,
          );
        }
        break;
      }
      case "CallExpression":
        if (
          attribute === "class" &&
          node.callee.type === "Identifier" &&
          helpers.has(node.callee.name) &&
          !isShadowed(node.callee.name)
        ) {
          for (const argument of node.arguments)
            expression(argument, attribute, true);
        }
        break;
      case "ArrayExpression":
        if (helperArgument)
          for (const element of node.elements)
            expression(element, attribute, true);
        break;
      case "ObjectExpression":
        if (helperArgument) {
          for (const property of node.properties) {
            if (property.type !== "ObjectProperty") continue;
            if (property.computed) expression(property.key, attribute, true);
            else if (property.key.type === "StringLiteral")
              literal(property.key, attribute);
            else if (property.key.type === "Identifier")
              addWords(property.key.start!, property.key.end!, attribute);
          }
        }
        break;
    }
  }

  function template(node: t.StringLiteral | t.TemplateLiteral) {
    const start = node.start! + 1;
    const end = node.end! - 1;
    let markup = text.slice(start, end);
    if (node.type === "TemplateLiteral") {
      // Keep interpolations opaque and preserve offsets. Any class touching
      // one is dynamic; separate, wholly literal class tokens remain usable.
      const marker = "\uE000";
      for (let i = node.expressions.length - 1; i >= 0; i--) {
        const from = node.quasis[i]!.end! - start;
        const to = node.quasis[i + 1]!.start! - start;
        markup =
          markup.slice(0, from) + marker.repeat(to - from) + markup.slice(to);
      }
    } else {
      // Escaped quotes/whitespace in JS strings can be represented by spaces
      // plus their quote without moving literal class names in the source.
      markup = markup.replace(/\\(["'])/g, " $1").replace(/\\[nrvtf]/g, "  ");
    }
    for (const range of htmlSelectorRanges(markup)) {
      if (
        range.selector.value.includes("\uE000") ||
        range.selector.value.includes("\\")
      )
        continue;
      ranges.push({
        start: range.start + start,
        end: range.end + start,
        selector: range.selector,
      });
    }
  }

  function bind(pattern: t.Node | null | undefined, names: Set<string>): void {
    if (!pattern) return;
    if (pattern.type === "Identifier") names.add(pattern.name);
    else if (pattern.type === "RestElement") bind(pattern.argument, names);
    else if (pattern.type === "AssignmentPattern") bind(pattern.left, names);
    else if (pattern.type === "TSParameterProperty")
      bind(pattern.parameter, names);
    else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties)
        bind(
          property.type === "RestElement" ? property.argument : property.value,
          names,
        );
    } else if (pattern.type === "ArrayPattern")
      for (const element of pattern.elements) bind(element, names);
  }

  function hoistedBindings(body: t.Node, names: Set<string>): void {
    function scan(node: t.Node): void {
      // `var` belongs to this function even inside conditional/loop blocks.
      // A nested function/class establishes its own scope and cannot shadow
      // imports used elsewhere in the enclosing function.
      if (
        functionTypes.has(node.type) ||
        node.type === "ClassDeclaration" ||
        node.type === "ClassExpression"
      )
        return;
      if (node.type === "VariableDeclaration" && node.kind === "var") {
        for (const declaration of node.declarations)
          bind(declaration.id, names);
      }
      forEachChild(node, scan);
    }
    scan(body);
  }

  function bindings(node: t.Node): Set<string> | null {
    if (!scopeTypes.has(node.type)) return null;
    const names = new Set<string>();
    if (functionTypes.has(node.type)) {
      const fn = node as t.Function;
      for (const parameter of fn.params) bind(parameter, names);
      if (
        node.type === "FunctionExpression" ||
        node.type === "FunctionDeclaration"
      )
        bind(node.id, names);
      hoistedBindings(fn.body, names);
    } else if (node.type === "ClassExpression") bind(node.id, names);
    else if (node.type === "BlockStatement") {
      for (const statement of node.body) {
        if (statement.type === "VariableDeclaration")
          for (const declaration of statement.declarations)
            bind(declaration.id, names);
        else if (
          statement.type === "FunctionDeclaration" ||
          statement.type === "ClassDeclaration"
        )
          bind(statement.id, names);
      }
    } else if (node.type === "CatchClause") bind(node.param, names);
    else if (
      (node.type === "ForOfStatement" || node.type === "ForInStatement") &&
      node.left.type === "VariableDeclaration"
    ) {
      for (const declaration of node.left.declarations)
        bind(declaration.id, names);
    } else if (
      node.type === "ForStatement" &&
      node.init?.type === "VariableDeclaration"
    ) {
      for (const declaration of node.init.declarations)
        bind(declaration.id, names);
    }
    return names.size ? names : null;
  }

  function visit(node: t.Node) {
    const scope = bindings(node);
    if (scope) shadowScopes.push(scope);
    if (node.type === "TaggedTemplateExpression") {
      const tag = node.tag;
      if (
        (tag.type === "Identifier" &&
          templateTags.has(tag.name) &&
          !isShadowed(tag.name)) ||
        (tag.type === "MemberExpression" &&
          !tag.computed &&
          tag.object.type === "Identifier" &&
          templateNamespaces.has(tag.object.name) &&
          !isShadowed(tag.object.name) &&
          tag.property.type === "Identifier" &&
          ["html", "svg", "mathml"].includes(tag.property.name))
      )
        template(node.quasi);
    } else if (
      node.type === "ObjectProperty" &&
      !node.computed &&
      ((node.key.type === "Identifier" && node.key.name === "template") ||
        (node.key.type === "StringLiteral" && node.key.value === "template")) &&
      (node.value.type === "StringLiteral" ||
        node.value.type === "TemplateLiteral")
    ) {
      template(node.value);
    }
    if (
      node.type === "JSXOpeningElement" ||
      node.type === "JSXClosingElement"
    ) {
      if (node.name.type === "JSXIdentifier" && /^[a-z]/.test(node.name.name)) {
        ranges.push({
          start: node.name.start!,
          end: node.name.end!,
          selector: { attribute: null, value: node.name.name },
        });
      }
      if (node.type === "JSXOpeningElement") {
        for (const attribute of node.attributes) {
          if (
            attribute.type !== "JSXAttribute" ||
            attribute.name.type !== "JSXIdentifier"
          )
            continue;
          const kind =
            attribute.name.name === "id"
              ? "id"
              : ["class", "className"].includes(attribute.name.name)
                ? "class"
                : null;
          if (!kind || !attribute.value) continue;
          if (attribute.value.type === "StringLiteral")
            literal(attribute.value, kind);
          else if (attribute.value.type === "JSXExpressionContainer")
            expression(attribute.value.expression, kind);
        }
      }
    }
    // Babel's AST fields are plain objects/arrays; skip metadata and visit only
    // child nodes. No traversal dependency or retained parent links are needed.
    forEachChild(node, visit);
    if (scope) shadowScopes.pop();
  }
  visit(ast.program);
  return ranges;
}
