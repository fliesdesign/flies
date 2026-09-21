import type * as t from "@swc/wasm-web";

import { parseJsx } from "./jsx-parser";
import { unwrapSource } from "./source";

type Value =
  | string
  | number
  | boolean
  | null
  | undefined
  | Value[]
  | { [key: string]: Value }
  | Markup
  | StaticFunction;
type Scope = Map<string, Value>;
// SWC emits this node, although wasm-web's bundled Expression union omits it.
type TsSatisfiesExpression = { type: "TsSatisfiesExpression"; expression: t.Expression };
type Expression = t.Expression | TsSatisfiesExpression;
type Evaluable = Expression | t.Pattern | t.Super | t.Import;
const MAX_OUTPUT = 200_000;

function bounded(text: string): string {
  if (text.length > MAX_OUTPUT) throw new Error("Rendered JSX is limited to 200KB.");

  return text;
}

class Markup {
  constructor(readonly html: string) {
    bounded(html);
  }
}

class StaticFunction {
  constructor(
    readonly node: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression,
    readonly scope: Scope,
  ) {}
}

const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const forbidden = new Set(["__proto__", "prototype", "constructor"]);

const unitless = new Set(
  "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth columnCount fillOpacity flex flexGrow flexShrink fontWeight gridArea gridColumn gridColumnEnd gridColumnSpan gridColumnStart gridRow gridRowEnd gridRowSpan gridRowStart lineHeight opacity order orphans scale strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth tabSize widows zIndex zoom".split(
    " ",
  ),
);

const voidTags = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" "),
);

const svgCase = new Set([
  "viewBox",
  "preserveAspectRatio",
  "gradientUnits",
  "gradientTransform",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "markerWidth",
  "markerHeight",
  "refX",
  "refY",
  "textLength",
  "lengthAdjust",
  "clipPathUnits",
]);

const fail = (message: string): never => {
  throw new Error(
    `${message} Paste static JSX or a self-contained component without hooks or external dependencies.`,
  );
};

function tagName(name: t.JSXElementName): string {
  if (name.type === "Identifier") return name.value;
  if (name.type === "JSXMemberExpression") return `${tagName(name.object)}.${name.property.value}`;

  return `${name.namespace.value}:${name.name.value}`;
}

/** Interpret only static data and JSX. Source never reaches eval, Function or a script element. */
export async function jsxToHtml(input: string): Promise<{ html: string; warnings: string[] }> {
  const { source } = unwrapSource(input);
  if (new TextEncoder().encode(source).length > 200_000)
    throw new Error("Source is limited to 200KB.");

  const parsed = await parseJsx(source);

  const warnings = new Set<string>();

  let operations = 0,
    depth = 0;

  const scope: Scope = new Map();

  const tick = () => {
    if (++operations > 20_000) fail("JSX is too complex.");
  };

  const property = (key: string) => {
    if (forbidden.has(key)) fail(`Unsupported property: ${key}.`);

    return key;
  };

  const record = (value: Value): { [key: string]: Value } => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value instanceof Markup ||
      value instanceof StaticFunction
    )
      return fail("Expected a static object.");

    return value;
  };

  const primitive = (value: Value): string | number | boolean | null | undefined => {
    if (value !== null && typeof value === "object") return fail("Expected a literal value.");

    return value;
  };

  const stringify = (value: Value): string => {
    if (value === undefined || value === null || typeof value === "boolean") return "";
    if (value instanceof Markup) return value.html;
    if (Array.isArray(value))
      return value.reduce<string>((text, item) => bounded(text + stringify(item)), "");
    if (typeof value === "object") return fail("Objects cannot be rendered as JSX children.");

    return bounded(escape(String(value)));
  };

  function propertyName(key: t.PropertyName | t.PrivateName, env: Scope): string {
    if (key.type === "PrivateName") return fail("Private properties are not supported.");

    return property(
      key.type === "Computed"
        ? String(primitive(evaluate(key.expression, env)))
        : String(key.value),
    );
  }

  function member(object: Value, keyNode: t.MemberExpression["property"], env: Scope): Value {
    const key = propertyName(keyNode, env);
    if ((Array.isArray(object) || typeof object === "string") && key === "length")
      return object.length;
    if (Array.isArray(object) && /^\d+$/.test(key)) return object[Number(key)];

    return record(object)[key];
  }

  function bind(pattern: t.Pattern, value: Value, env: Scope): void {
    tick();
    if (pattern.type === "Identifier") env.set(pattern.value, value);
    else if (pattern.type === "AssignmentPattern")
      bind(pattern.left, value === undefined ? evaluate(pattern.right, env) : value, env);
    else if (pattern.type === "ObjectPattern") {
      const object = record(value),
        used = new Set<string>();

      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") {
          const rest = Object.create(null) as { [key: string]: Value };
          for (const [key, item] of Object.entries(object)) if (!used.has(key)) rest[key] = item;
          bind(prop.argument, rest, env);
        } else if (prop.type === "AssignmentPatternProperty") {
          const key = property(prop.key.value);
          used.add(key);
          bind(
            prop.key,
            object[key] === undefined && prop.value ? evaluate(prop.value, env) : object[key],
            env,
          );
        } else {
          const key = propertyName(prop.key, env);
          used.add(key);
          bind(prop.value, object[key], env);
        }
      }
    } else if (pattern.type === "ArrayPattern") {
      if (!Array.isArray(value)) fail("Expected a static array.");
      pattern.elements.forEach((item, index) => {
        if (item) bind(item, (value as Value[])[index], env);
      });
    } else fail(`Unsupported binding: ${pattern.type}.`);
  }

  function call(fn: Value, args: Value[]): Value {
    if (!(fn instanceof StaticFunction))
      return fail("Only local static component/helper functions can be called.");
    if (fn.node.async || fn.node.generator)
      return fail("Async components and generators are not supported.");
    if (++depth > 30) return fail("Component nesting is limited to 30 levels.");

    try {
      const env = new Map(fn.scope);
      if (fn.node.type !== "ArrowFunctionExpression" && fn.node.identifier)
        env.set(fn.node.identifier.value, fn);
      if (!fn.node.body) return fail("A component needs a function body.");
      fn.node.params.forEach((param, index) =>
        bind(param.type === "Parameter" ? param.pat : param, args[index], env),
      );

      return fn.node.body.type === "FunctionBody"
        ? statements(fn.node.body.stmts, env).value
        : evaluate(fn.node.body, env);
    } finally {
      depth--;
    }
  }

  function statements(body: t.Statement[], env: Scope): { returned: boolean; value?: Value } {
    for (const item of body)
      if (item.type === "FunctionDeclaration" && item.identifier)
        env.set(item.identifier.value, new StaticFunction(item, env));

    for (const item of body) {
      tick();
      if (
        [
          "FunctionDeclaration",
          "EmptyStatement",
          "TsInterfaceDeclaration",
          "TsTypeAliasDeclaration",
        ].includes(item.type)
      )
        continue;
      if (item.type === "VariableDeclaration") {
        for (const declaration of item.declarations)
          bind(declaration.id, declaration.init ? evaluate(declaration.init, env) : undefined, env);
      } else if (item.type === "ReturnStatement")
        return { returned: true, value: item.argument ? evaluate(item.argument, env) : undefined };
      else if (item.type === "IfStatement") {
        const branch = evaluate(item.test, env) ? item.consequent : item.alternate;

        if (branch) {
          const result = statements(
            branch.type === "BlockStatement" ? branch.stmts : [branch],
            new Map(env),
          );

          if (result.returned) return result;
        }
      } else return fail(`Unsupported component statement: ${item.type}.`);
    }

    return { returned: false };
  }

  function style(value: Value): string {
    return Object.entries(record(value))
      .map(([key, entry]) => {
        property(key);
        if (entry === null || entry === undefined || entry === false) return "";
        if (typeof entry !== "string" && typeof entry !== "number")
          return fail(`Style ${key} needs a string or number.`);

        const name = key.startsWith("--")
          ? key
          : key
              .replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)
              .replace(/^ms-/, "-ms-");

        return `${name}:${entry}${typeof entry === "number" && entry !== 0 && !unitless.has(key) && !key.startsWith("--") ? "px" : ""}`;
      })
      .filter(Boolean)
      .join(";");
  }

  function jsx(node: t.JSXElement | t.JSXFragment, env: Scope, inSvg = false): Markup {
    tick();
    if (++depth > 30) return fail("JSX nesting is limited to 30 levels.");

    try {
      const name = node.type === "JSXFragment" ? "Fragment" : tagName(node.opening.name);
      const fragment = ["Fragment", "React.Fragment"].includes(name);
      const native = /^[a-z]/.test(name);
      const svg = inSvg || name === "svg";
      const props = Object.create(null) as { [key: string]: Value };

      if (node.type === "JSXElement")
        for (const attr of node.opening.attributes) {
          if (attr.type === "SpreadElement") {
            for (const [key, value] of Object.entries(record(evaluate(attr.arguments, env))))
              props[property(key)] = value;
            continue;
          }

          const key =
            attr.name.type === "Identifier"
              ? attr.name.value
              : `${attr.name.namespace.value}:${attr.name.name.value}`;

          property(key);

          if (/^on[A-Z]/.test(key) || key === "ref") {
            warnings.add("Event handlers and refs were omitted from the static design.");
            continue;
          }

          if (key === "dangerouslySetInnerHTML")
            return fail("dangerouslySetInnerHTML is not supported.");
          props[key] = !attr.value
            ? true
            : attr.value.type === "StringLiteral"
              ? attr.value.value
              : attr.value.type === "JSXExpressionContainer"
                ? evaluate(attr.value.expression, env)
                : evaluate(attr.value, env);
        }

      const children: Value[] = node.children.map((child) => {
        if (child.type === "JSXText") {
          const lines = child.value.replace(/\r/g, "").split("\n");

          return lines
            .map((line, index) => {
              let text = line.replace(/\t/g, " ");
              if (index > 0) text = text.replace(/^ +/, "");
              if (index < lines.length - 1) text = text.replace(/ +$/, "");

              return text;
            })
            .filter(Boolean)
            .join(" ");
        }

        if (child.type === "JSXExpressionContainer") return evaluate(child.expression, env);
        if (child.type === "JSXSpreadChild")
          return fail("Use an array expression for JSX children.");

        return jsx(child, env, svg);
      });

      if (children.length) props.children = children.length === 1 ? children[0] : children;
      if (fragment) return new Markup(stringify(props.children));

      if (!native) {
        const names = name.split(".");
        let component = env.get(names[0]);
        for (const key of names.slice(1)) component = record(component)[property(key)];
        if (!component) return fail(`Component ${name} is not defined in this snippet.`);

        return new Markup(stringify(call(component, [props])));
      }

      const attributes = Object.entries(props)
        .flatMap(([key, value]) => {
          if (["children", "key"].includes(key)) return [];

          if (/^on/i.test(key) || key === "ref") {
            warnings.add("Event handlers and refs were omitted from the static design.");

            return [];
          }

          if (key === "dangerouslySetInnerHTML")
            return fail("dangerouslySetInnerHTML is not supported.");
          if (value === false || value === null || value === undefined) return [];

          if (["disabled", "readOnly"].includes(key)) {
            warnings.add("Interactive control state was omitted from the static design.");

            return [];
          }

          const attribute =
            key === "className"
              ? "class"
              : key === "htmlFor"
                ? "for"
                : svg && !svgCase.has(key)
                  ? key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
                  : key;

          return [
            `${attribute}="${escape(key === "style" ? style(value) : String(primitive(value)))}"`,
          ];
        })
        .join(" ");

      const open = `<${name}${attributes ? ` ${attributes}` : ""}>`;

      return new Markup(
        voidTags.has(name) ? open : `${open}${stringify(props.children)}</${name}>`,
      );
    } finally {
      depth--;
    }
  }

  function evaluate(node: Evaluable, env: Scope): Value {
    tick();

    switch (node.type) {
      case "JSXElement":
      case "JSXFragment":
        return jsx(node, env);
      case "JSXEmptyExpression":
      case "NullLiteral":
        return null;
      case "StringLiteral":
      case "NumericLiteral":
      case "BooleanLiteral":
        return node.value;
      case "Identifier":
        if (node.value === "undefined") return undefined;
        if (!env.has(node.value))
          return fail(
            `Unknown value ${node.value}. Hooks, globals and imported values are not evaluated.`,
          );

        return env.get(node.value);
      case "TsAsExpression":
      case "TsSatisfiesExpression":
      case "TsNonNullExpression":
      case "ParenthesisExpression":
        return evaluate(node.expression, env);
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        return new StaticFunction(node, env);

      case "ArrayExpression": {
        const array: Value[] = [];

        for (const item of node.elements) {
          const values = !item
            ? [undefined]
            : item.spread
              ? evaluate(item.expression, env)
              : [evaluate(item.expression, env)];

          if (!Array.isArray(values)) return fail("Array spreads require an array.");
          if (array.length + values.length > 500)
            return fail("Static arrays are limited to 500 items.");
          array.push(...values);
        }

        return array;
      }

      case "ObjectExpression": {
        const object = Object.create(null) as { [key: string]: Value };

        for (const entry of node.properties) {
          if (entry.type === "SpreadElement") {
            for (const [key, value] of Object.entries(record(evaluate(entry.arguments, env))))
              object[property(key)] = value;
          } else if (entry.type === "KeyValueProperty") {
            object[propertyName(entry.key, env)] = evaluate(entry.value, env);
          } else if (entry.type === "Identifier") {
            object[property(entry.value)] = evaluate(entry, env);
          } else return fail("Object methods and getters are not supported.");
        }

        return object;
      }

      case "TemplateLiteral":
        return node.quasis.reduce(
          (text, part, index) =>
            bounded(
              text +
                (part.cooked ?? part.raw) +
                (node.expressions[index]
                  ? String(primitive(evaluate(node.expressions[index], env)))
                  : ""),
            ),
          "",
        );
      case "ConditionalExpression":
        return evaluate(evaluate(node.test, env) ? node.consequent : node.alternate, env);

      case "UnaryExpression": {
        const value = primitive(evaluate(node.argument, env));
        if (node.operator === "!") return !value;
        if (node.operator === "-") return -Number(value);
        if (node.operator === "+") return Number(value);

        return fail(`Unsupported unary operator ${node.operator}.`);
      }

      case "BinaryExpression": {
        const lhs = evaluate(node.left, env);
        if (node.operator === "&&") return lhs && evaluate(node.right, env);
        if (node.operator === "||") return lhs || evaluate(node.right, env);
        if (node.operator === "??") return lhs ?? evaluate(node.right, env);

        const left = primitive(lhs),
          right = primitive(evaluate(node.right, env));

        switch (node.operator) {
          case "+":
            return typeof left === "string" || typeof right === "string"
              ? bounded(String(left) + String(right))
              : Number(left) + Number(right);
          case "-":
            return Number(left) - Number(right);
          case "*":
            return Number(left) * Number(right);
          case "/":
            return Number(left) / Number(right);
          case "%":
            return Number(left) % Number(right);
          case "===":
            return left === right;
          case "!==":
            return left !== right;
          case "<":
            return Number(left) < Number(right);
          case ">":
            return Number(left) > Number(right);
          case "<=":
            return Number(left) <= Number(right);
          case ">=":
            return Number(left) >= Number(right);
          default:
            return fail(`Unsupported operator ${node.operator}.`);
        }
      }

      case "OptionalChainingExpression": {
        if (node.base.type !== "MemberExpression")
          return fail("Optional function calls are not supported.");
        const object = evaluate(node.base.object, env);

        return object == null ? undefined : member(object, node.base.property, env);
      }

      case "MemberExpression":
        return member(evaluate(node.object, env), node.property, env);

      case "CallExpression": {
        const args = node.arguments.map((arg) => {
          if (arg.spread) return fail("Call spreads are not supported.");

          return evaluate(arg.expression, env);
        });

        if (node.callee.type === "MemberExpression") {
          const receiver = evaluate(node.callee.object, env),
            key = propertyName(node.callee.property, env);

          if (Array.isArray(receiver) && key === "map") {
            if (receiver.length > 500) return fail("Mapped arrays are limited to 500 items.");

            return receiver.map((value, index) => call(args[0], [value, index]));
          }

          if (Array.isArray(receiver) && key === "join") {
            const separator = args[0] === undefined ? "," : String(primitive(args[0]));

            return receiver.reduce<string>(
              (text, value, index) =>
                bounded(text + (index ? separator : "") + String(primitive(value) ?? "")),
              "",
            );
          }
        }

        return call(evaluate(node.callee, env), args);
      }

      default:
        return fail(`Unsupported expression: ${node.type}.`);
    }
  }

  let result: Value;

  if (parsed.type !== "Module") {
    result = evaluate(parsed, scope);
  } else {
    let entry: Expression | t.TsInterfaceDeclaration | undefined;
    const body: t.Statement[] = [];

    for (const statement of parsed.body) {
      if (statement.type === "ImportDeclaration") continue;
      if (statement.type === "ExportDefaultDeclaration") {
        entry = statement.decl;
        if (entry.type === "FunctionExpression" && entry.identifier)
          scope.set(entry.identifier.value, new StaticFunction(entry, scope));
      } else if (statement.type === "ExportDefaultExpression") entry = statement.expression;
      else if (statement.type === "ExportDeclaration") body.push(statement.declaration);
      else if (statement.type === "ExportNamedDeclaration") {
        if (statement.source)
          return fail("Re-exported components are not available in this snippet.");

        for (const specifier of statement.specifiers) {
          if (specifier.type === "ExportSpecifier" && specifier.exported?.value === "default")
            entry = specifier.orig;
        }
      } else if (statement.type === "ExpressionStatement") {
        if (
          statement.expression.type === "StringLiteral" &&
          ["use client", "use server", "use strict"].includes(statement.expression.value)
        )
          continue;
        if (entry) return fail("Unexpected executable statement after a component.");
        entry = statement.expression;
      } else if (
        [
          "ExportAllDeclaration",
          "TsImportEqualsDeclaration",
          "TsExportAssignment",
          "TsNamespaceExportDeclaration",
        ].includes(statement.type)
      )
        return fail(`Unsupported module statement: ${statement.type}.`);
      else body.push(statement as t.Statement);
    }

    statements(body, scope);
    if (entry?.type === "TsInterfaceDeclaration") return fail("Export a component, not a type.");

    if (entry) result = evaluate(entry, scope);
    else {
      const candidates = [...scope.entries()].filter(
        ([name, value]) =>
          /^[A-Z]/.test(name) && (value instanceof StaticFunction || value instanceof Markup),
      );

      if (!candidates.length) return fail("No JSX or component was found.");
      result = candidates[candidates.length - 1][1];
    }
  }

  if (result instanceof StaticFunction) result = call(result, [Object.create(null)]);

  const html = stringify(result);
  if (!html.trim()) return fail("The snippet did not produce visible markup.");
  if (new TextEncoder().encode(html).length > 200_000)
    return fail("Rendered JSX is limited to 200KB.");

  return { html, warnings: [...warnings] };
}
