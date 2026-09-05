import { useMemo } from "react";

type SyntaxLanguage = "css" | "glsl" | "javascript" | "jsx" | "markdown" | "shader-javascript" | "text" | "tsx" | "typescript";

type SyntaxHighlightedCodeProps = {
  code: string;
  language: string;
};

type TokenKind = "builtin" | "comment" | "function" | "keyword" | "number" | "operator" | "preprocessor" | "property" | "string" | "type";

type SyntaxToken = {
  kind?: TokenKind;
  text: string;
};

const MAX_HIGHLIGHTED_SOURCE_LENGTH = 100_000;

const JAVASCRIPT_KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "declare", "default", "delete", "do", "else", "enum", "export", "extends", "finally", "for", "from", "function", "get", "if", "implements", "import", "in", "instanceof", "interface", "keyof", "let", "new", "of", "package", "private", "protected", "public", "readonly", "return", "satisfies", "set", "static", "super", "switch", "this", "throw", "try", "type", "typeof", "var", "void", "while", "with", "yield",
]);

const GLSL_KEYWORDS = new Set([
  "attribute", "bool", "break", "bvec2", "bvec3", "bvec4", "const", "continue", "discard", "do", "else", "false", "float", "for", "highp", "if", "in", "inout", "int", "invariant", "ivec2", "ivec3", "ivec4", "layout", "lowp", "mat2", "mat3", "mat4", "mediump", "out", "precision", "return", "sampler2D", "samplerCube", "struct", "true", "uniform", "varying", "vec2", "vec3", "vec4", "void", "while",
]);

const BUILTINS = new Set([
  "document", "false", "gl_FragColor", "gl_FragCoord", "gl_Position", "Infinity", "Math", "NaN", "navigator", "null", "performance", "true", "undefined", "window",
]);

const MULTI_OPERATORS = ["===", "!==", ">>>", "**=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "**", "<<", ">>", "&=", "|=", "^="];

function pushToken(tokens: SyntaxToken[], text: string, kind?: TokenKind) {
  if (!text) return;
  const previous = tokens[tokens.length - 1];
  if (previous && previous.kind === kind) previous.text += text;
  else tokens.push({ text, kind });
}

function tokenizeMarkdown(code: string) {
  const tokens: SyntaxToken[] = [];
  const lines = code.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let frontmatter = false;
  let fencedLanguage = "";

  lines.forEach((rawLine, index) => {
    const hasNewline = rawLine.endsWith("\n");
    const line = hasNewline ? rawLine.slice(0, -1) : rawLine;
    const fence = line.match(/^```([\w-]*)/);

    if (fence) {
      pushToken(tokens, line, "preprocessor");
      fencedLanguage = fencedLanguage ? "" : fence[1] || "text";
    } else if (line === "---" && (index === 0 || frontmatter)) {
      pushToken(tokens, line, "preprocessor");
      frontmatter = !frontmatter;
    } else if (fencedLanguage) {
      for (const token of tokenizeSyntax(line, fencedLanguage)) pushToken(tokens, token.text, token.kind);
    } else if (/^#{1,6}\s/.test(line)) {
      pushToken(tokens, line, "keyword");
    } else if (frontmatter) {
      const field = line.match(/^([a-z][\w-]*)(:)(.*)$/i);
      if (field) {
        pushToken(tokens, field[1], "property");
        pushToken(tokens, field[2], "operator");
        pushToken(tokens, field[3], "string");
      } else pushToken(tokens, line);
    } else {
      const listItem = line.match(/^(\s*(?:[-*]|\d+\.)\s+)(.*)$/);
      if (listItem) {
        pushToken(tokens, listItem[1], "operator");
        pushToken(tokens, listItem[2]);
      } else pushToken(tokens, line);
    }

    if (hasNewline) pushToken(tokens, "\n");
  });

  return tokens;
}

function previousNonSpace(code: string, index: number) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(code[cursor])) return code[cursor];
  }
  return "";
}

function nextNonSpace(code: string, index: number) {
  for (let cursor = index; cursor < code.length; cursor += 1) {
    if (!/\s/.test(code[cursor])) return code[cursor];
  }
  return "";
}

function normalizedLanguage(language: string): SyntaxLanguage {
  if (["css", "glsl", "javascript", "jsx", "markdown", "shader-javascript", "text", "tsx", "typescript"].includes(language)) {
    return language as SyntaxLanguage;
  }
  return "text";
}

export function tokenizeSyntax(code: string, requestedLanguage: string) {
  const language = normalizedLanguage(requestedLanguage);
  if (language === "markdown") return tokenizeMarkdown(code);
  const tokens: SyntaxToken[] = [];
  const isJavaScript = ["javascript", "jsx", "shader-javascript", "tsx", "typescript"].includes(language);
  const supportsJsx = language === "jsx" || language === "tsx";
  let cursor = 0;
  let inJsxTag = false;
  let expectsJsxTagName = false;

  while (cursor < code.length) {
    const character = code[cursor];
    const next = code[cursor + 1] ?? "";

    if (/\s/.test(character)) {
      const start = cursor;
      while (cursor < code.length && /\s/.test(code[cursor])) cursor += 1;
      pushToken(tokens, code.slice(start, cursor));
      continue;
    }

    if (character === "/" && next === "/" && language !== "css") {
      const start = cursor;
      cursor = code.indexOf("\n", cursor);
      if (cursor === -1) cursor = code.length;
      pushToken(tokens, code.slice(start, cursor), "comment");
      continue;
    }

    if (character === "/" && next === "*") {
      const start = cursor;
      const end = code.indexOf("*/", cursor + 2);
      cursor = end === -1 ? code.length : end + 2;
      pushToken(tokens, code.slice(start, cursor), "comment");
      continue;
    }

    if (character === "`" && language === "shader-javascript") {
      const contentStart = cursor + 1;
      let contentEnd = contentStart;
      while (contentEnd < code.length) {
        if (code[contentEnd] === "\\") contentEnd += 2;
        else if (code[contentEnd] === "`") break;
        else contentEnd += 1;
      }
      pushToken(tokens, "`", "string");
      for (const token of tokenizeSyntax(code.slice(contentStart, contentEnd), "glsl")) {
        pushToken(tokens, token.text, token.kind);
      }
      if (code[contentEnd] === "`") {
        pushToken(tokens, "`", "string");
        cursor = contentEnd + 1;
      } else cursor = code.length;
      continue;
    }

    if (character === "\"" || character === "'" || character === "`") {
      const quote = character;
      const start = cursor;
      cursor += 1;
      while (cursor < code.length) {
        if (code[cursor] === "\\") cursor += 2;
        else if (code[cursor] === quote) {
          cursor += 1;
          break;
        } else cursor += 1;
      }
      pushToken(tokens, code.slice(start, cursor), "string");
      continue;
    }

    if (language === "glsl" && character === "#") {
      const start = cursor;
      cursor = code.indexOf("\n", cursor);
      if (cursor === -1) cursor = code.length;
      pushToken(tokens, code.slice(start, cursor), "preprocessor");
      continue;
    }

    if (language === "css" && character === "#" && /[\da-f]/i.test(next)) {
      const start = cursor;
      cursor += 1;
      while (cursor < code.length && /[\da-f]/i.test(code[cursor])) cursor += 1;
      pushToken(tokens, code.slice(start, cursor), "number");
      continue;
    }

    if (/\d/.test(character) || (character === "." && /\d/.test(next))) {
      const number = code.slice(cursor).match(/^(?:0x[\da-f]+|\d*\.?\d+(?:e[+-]?\d+)?)/i)?.[0] ?? character;
      pushToken(tokens, number, "number");
      cursor += number.length;
      continue;
    }

    if (supportsJsx && character === "<") {
      const following = next === "/" ? code[cursor + 2] ?? "" : next;
      const previous = previousNonSpace(code, cursor - 1);
      const startsTag = /[A-Z]/.test(following) || (/[a-z]/.test(following) && (!previous || /[([{=,:;>]/.test(previous))) || next === "/";
      if (startsTag) {
        inJsxTag = true;
        expectsJsxTagName = true;
      }
    }

    if (/[A-Za-z_$]/.test(character)) {
      const start = cursor;
      cursor += 1;
      while (cursor < code.length && /[\w$-]/.test(code[cursor])) cursor += 1;
      const word = code.slice(start, cursor);
      const following = nextNonSpace(code, cursor);
      let kind: TokenKind | undefined;

      if (inJsxTag && expectsJsxTagName) {
        kind = "type";
        expectsJsxTagName = false;
      } else if (inJsxTag) kind = "property";
      else if ((isJavaScript && JAVASCRIPT_KEYWORDS.has(word)) || (language === "glsl" && GLSL_KEYWORDS.has(word))) kind = "keyword";
      else if (BUILTINS.has(word)) kind = "builtin";
      else if (language === "css" && following === ":") kind = "property";
      else if (isJavaScript && /^[A-Z]/.test(word)) kind = "type";
      else if (following === "(") kind = "function";

      pushToken(tokens, word, kind);
      continue;
    }

    if (inJsxTag && character === ">") {
      pushToken(tokens, character, "operator");
      inJsxTag = false;
      expectsJsxTagName = false;
      cursor += 1;
      continue;
    }

    const operator = MULTI_OPERATORS.find((candidate) => code.startsWith(candidate, cursor));
    if (operator) {
      pushToken(tokens, operator, "operator");
      cursor += operator.length;
      continue;
    }

    if (/[+\-*/%=<>!&|^~?:]/.test(character)) {
      pushToken(tokens, character, "operator");
      cursor += 1;
      continue;
    }

    pushToken(tokens, character);
    cursor += 1;
  }

  return tokens;
}

export function SyntaxHighlightedCode({ code, language }: SyntaxHighlightedCodeProps) {
  const tokens = useMemo(
    () => code.length > MAX_HIGHLIGHTED_SOURCE_LENGTH ? [{ text: code }] : tokenizeSyntax(code, language),
    [code, language],
  );

  return (
    <code className="syntax-highlighted" data-language={normalizedLanguage(language)}>
      {tokens.map((token, index) => token.kind ? (
        <span className={`syntax-${token.kind}`} key={`${index}-${token.kind}`}>{token.text}</span>
      ) : token.text)}
    </code>
  );
}
