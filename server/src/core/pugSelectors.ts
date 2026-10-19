import { TextDocument } from "vscode-languageserver-textdocument";
import { Selector } from "../types";

/** Find only selectors in Pug's tag prefix/attributes, never its text or JS. */
export function findPugSelector(
  document: TextDocument,
  offset: number,
  supportTags: boolean,
): Selector | null {
  const text = document.getText();
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = text.indexOf("\n", offset);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const indent = /^\s*/.exec(line)![0].length;
  // Pug comments cover the indented block below them as well as their line.
  let commentIndent: number | undefined;
  for (const previous of text.slice(0, lineStart).split(/\r?\n/)) {
    if (!previous.trim()) continue;
    const previousIndent = /^\s*/.exec(previous)![0].length;
    if (commentIndent !== undefined && previousIndent <= commentIndent)
      commentIndent = undefined;
    if (previous.trimStart().startsWith("//")) commentIndent = previousIndent;
  }
  if (
    (commentIndent !== undefined && indent > commentIndent) ||
    line.trimStart().startsWith("//")
  )
    return null;

  let cursor = indent;
  const tag = /^[a-zA-Z][\w:-]*/.exec(line.slice(cursor));
  if (tag) {
    if (
      [
        "if",
        "unless",
        "else",
        "each",
        "for",
        "while",
        "case",
        "when",
        "default",
        "mixin",
        "include",
        "extends",
        "block",
        "append",
        "prepend",
        "doctype",
      ].includes(tag[0])
    )
      return null;
    if (
      supportTags &&
      offset >= lineStart + cursor &&
      offset <= lineStart + cursor + tag[0].length
    ) {
      return { attribute: null, value: tag[0] };
    }
    cursor += tag[0].length;
  } else if (line[cursor] !== "." && line[cursor] !== "#") return null;

  while (line[cursor] === "." || line[cursor] === "#") {
    const attribute = line[cursor++] === "." ? "class" : "id";
    const word = /^[\p{L}\p{N}_-]+/u.exec(line.slice(cursor));
    if (!word) return null;
    if (
      offset >= lineStart + cursor &&
      offset <= lineStart + cursor + word[0].length
    )
      return { attribute, value: word[0] };
    cursor += word[0].length;
  }
  if (line[cursor] !== "(") return null;

  // Quoted class/id attributes. Dynamic expressions and interpolation remain
  // JavaScript/Pug navigation; recognizing them as literal CSS is misleading.
  const attributes = /(?:^|[\s,(])(class|id)\s*=\s*(["'])([^]*?)\2/g;
  let closing = cursor + 1;
  let depth = 1;
  let quote = "";
  while (closing < line.length && depth) {
    const character = line[closing++];
    if (quote) {
      if (character === "\\") closing++;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth++;
    else if (character === ")") depth--;
  }
  const attributeText = line.slice(cursor, closing);
  for (const match of attributeText.matchAll(attributes)) {
    const value = match[3];
    if (value.includes("#{") || value.includes("!{")) continue;
    const valueStart =
      lineStart +
      cursor +
      match.index! +
      match[0].lastIndexOf(value + match[2]);
    for (const word of value.matchAll(/\S+/g)) {
      const start = valueStart + word.index!;
      if (offset >= start && offset <= start + word[0].length)
        return { attribute: match[1], value: word[0] };
    }
  }
  return null;
}
