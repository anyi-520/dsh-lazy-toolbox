/**
 * 把上游 MCP 的 JSON Schema 收敛成 DSH ToolRuntime 强制支持的子集：
 *   type / oneOf / properties / required / additionalProperties / items / enum / const
 *   + 注解 description / title / default / examples
 *
 * DSH 的校验很严（见 @deepseek-ai/dsh-tools 的 assertSupportedJsonSchema）：
 * $schema、$ref、anyOf、allOf、format、minimum、pattern、type 数组……
 * 一律会被拒。这里做「有损但安全」的降级：保结构、丢约束，绝不让服务因为
 * 一个 schema 关键字导致整个服务加载不上。
 */

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const ANNOTATION_KEYS = ["description", "title", "default", "examples"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLosslessJson(value) {
  try {
    if (typeof value === "number" && !Number.isFinite(value)) return false;
    const text = JSON.stringify(value);
    if (text === undefined) return false;
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function inferType(node) {
  if (node.properties !== undefined || node.required !== undefined) return "object";
  if (node.items !== undefined) return "array";
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const first = node.enum[0];
    if (typeof first === "string") return "string";
    if (typeof first === "number") return Number.isInteger(first) ? "integer" : "number";
    if (typeof first === "boolean") return "boolean";
    if (first === null) return "null";
  }
  return undefined;
}

function scalarMatches(type, value) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function copyAnnotations(source, target) {
  for (const key of ANNOTATION_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    if ((key === "description" || key === "title") && typeof source[key] !== "string") continue;
    if (!isLosslessJson(source[key])) continue;
    target[key] = source[key];
  }
}

export function sanitizeSchema(schema, depth = 0) {
  if (depth > 12 || !isRecord(schema)) return {};
  const node = schema;
  const out = {};

  // oneOf 是除 type 之外唯一支持的分支关键字
  if (Array.isArray(node.oneOf) && node.oneOf.length >= 2) {
    out.oneOf = node.oneOf.map((branch) => sanitizeSchema(branch, depth + 1));
    copyAnnotations(node, out);
    return out;
  }

  let type;
  if (typeof node.type === "string" && TYPES.has(node.type)) {
    type = node.type;
  } else if (Array.isArray(node.type)) {
    const candidates = node.type.filter((item) => typeof item === "string" && TYPES.has(item) && item !== "null");
    type = candidates.length > 0 ? candidates[0] : "null";
  }
  if (type === undefined) type = inferType(node);
  if (type === undefined) {
    // 无类型：只保留注解，作为「任意 JSON」处理
    copyAnnotations(node, out);
    return out;
  }

  out.type = type;
  copyAnnotations(node, out);

  if (type === "object") {
    if (isRecord(node.properties)) {
      const properties = {};
      for (const [name, child] of Object.entries(node.properties)) properties[name] = sanitizeSchema(child, depth + 1);
      out.properties = properties;
      if (Array.isArray(node.required)) {
        const required = node.required.filter((item) => typeof item === "string" && Object.hasOwn(properties, item));
        if (required.length > 0) out.required = required;
      }
    }
    if (typeof node.additionalProperties === "boolean") out.additionalProperties = node.additionalProperties;
    else if (isRecord(node.additionalProperties)) out.additionalProperties = true;
  } else if (type === "array") {
    if (node.items !== undefined && !Array.isArray(node.items)) out.items = sanitizeSchema(node.items, depth + 1);
  } else {
    if (Array.isArray(node.enum)) {
      const values = node.enum.filter((item) => scalarMatches(type, item));
      if (values.length > 0) out.enum = values;
    }
    if (Object.hasOwn(node, "const") && scalarMatches(type, node.const)) {
      if (out.enum === undefined || out.enum.includes(node.const)) out.const = node.const;
    }
  }

  if (Object.hasOwn(node, "default") && isLosslessJson(node.default)) {
    // 只对根/参数层保留，避免运行期拿到与类型不符的默认值
    if (type === "string" && typeof node.default === "string") out.default = node.default;
    else if (type === "boolean" && typeof node.default === "boolean") out.default = node.default;
    else if ((type === "number" || type === "integer") && typeof node.default === "number" && Number.isFinite(node.default)) out.default = node.default;
    else if (type === "null" && node.default === null) out.default = node.default;
  }

  return out;
}
