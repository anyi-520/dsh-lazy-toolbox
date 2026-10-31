import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeSchema } from "../lib/schema.js";

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const CONSTRAINT = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const"]);
const ANNOTATION = new Set(["description", "title", "default", "examples"]);
const ONE_OF_SIBLINGS = ["properties", "required", "additionalProperties", "items", "enum", "const"];

/**
 * 复刻 @deepseek-ai/dsh-tools 的 assertSupportedJsonSchema 规则，
 * 用来保证我们产出的 schema 一定能被 DSH 接受。
 */
function assertDshSchema(schema, path = "schema") {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) throw new Error(`${path} 必须是对象`);
  for (const key of Object.keys(schema)) {
    if (!CONSTRAINT.has(key) && !ANNOTATION.has(key)) throw new Error(`${path}.${key} 不是受支持的关键字`);
  }
  const hasType = Object.hasOwn(schema, "type");
  const hasOneOf = Object.hasOwn(schema, "oneOf");
  assert.ok(!(hasType && hasOneOf), `${path} 不能同时有 type 和 oneOf`);
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLINGS) assert.ok(!Object.hasOwn(schema, key), `${path}.${key} 需要 type 或 oneOf`);
    return;
  }
  if (hasOneOf) {
    assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length >= 2, `${path}.oneOf 至少两个分支`);
    for (const key of ONE_OF_SIBLINGS) assert.ok(!Object.hasOwn(schema, key), `${path}.${key} 不能与 oneOf 并列`);
    schema.oneOf.forEach((branch, index) => assertDshSchema(branch, `${path}.oneOf[${index}]`));
    return;
  }
  assert.ok(TYPES.has(schema.type), `${path}.type 必须是单一受支持类型`);
  if (schema.type === "object") {
    if (Object.hasOwn(schema, "required")) {
      assert.ok(Array.isArray(schema.required), `${path}.required 必须是数组`);
      for (const key of schema.required) assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${path}.required 含未声明字段 ${key}`);
    }
    if (Object.hasOwn(schema, "additionalProperties")) {
      assert.equal(typeof schema.additionalProperties, "boolean", `${path}.additionalProperties 必须是布尔`);
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) assertDshSchema(child, `${path}.properties.${name}`);
  }
  if (schema.type === "array" && Object.hasOwn(schema, "items")) assertDshSchema(schema.items, `${path}.items`);
  if (schema.type === "array" && Object.hasOwn(schema, "properties")) throw new Error(`${path}.properties 只能用于 object`);
  if (["string", "number", "integer", "boolean", "null"].includes(schema.type)) {
    assert.ok(!Object.hasOwn(schema, "properties"), `${path}.properties 只能用于 object`);
    if (Object.hasOwn(schema, "enum")) assert.ok(Array.isArray(schema.enum) && schema.enum.length > 0, `${path}.enum 非空`);
  }
}

const CASES = {
  "draft-07 带 $schema": {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { q: { type: "string", description: "查询" } },
    required: ["q"],
  },
  "type 数组（可空）": { type: ["string", "null"], description: "可空字符串" },
  "anyOf 可空": { anyOf: [{ type: "string" }, { type: "null" }] },
  "oneOf 引用": {
    oneOf: [{ $ref: "#/definitions/a" }, { type: "string" }],
  },
  "嵌套数组与映射": {
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string", minLength: 1 } },
      meta: { type: "object", additionalProperties: { type: "string" } },
      deep: { type: "array", items: { type: "array", items: { type: "integer", minimum: 0 } } },
    },
    required: ["tags", "nope"],
    additionalProperties: false,
  },
  "枚举与常量": {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["a", "b", 3] },
      level: { type: "integer", const: 3 },
    },
  },
  "无类型注解": { description: "任意 JSON" },
  "布尔根": true,
  "非法 items 数组": { type: "array", items: [{ type: "string" }, { type: "number" }] },
  "空对象": {},
};

test("所有上游 schema 归一化后都能通过 DSH 校验", () => {
  for (const [name, schema] of Object.entries(CASES)) {
    const sanitized = sanitizeSchema(schema);
    try {
      assertDshSchema(sanitized);
    } catch (error) {
      assert.fail(`${name} 归一化后不合法：${error.message}\n${JSON.stringify(sanitized)}`);
    }
  }
});

test("归一化保留可用结构", () => {
  const object = sanitizeSchema(CASES["draft-07 带 $schema"]);
  assert.equal(object.type, "object");
  assert.deepEqual(object.properties.q, { type: "string", description: "查询" });
  assert.deepEqual(object.required, ["q"]);

  const nullable = sanitizeSchema(CASES["type 数组（可空）"]);
  assert.equal(nullable.type, "string");
  assert.equal(nullable.description, "可空字符串");

  const nested = sanitizeSchema(CASES["嵌套数组与映射"]);
  assert.deepEqual(nested.required, ["tags"], "未声明的 required 字段应被丢弃");
  assert.equal(nested.additionalProperties, false);
  assert.deepEqual(nested.properties.meta, { type: "object", additionalProperties: true });
});

test("toolbox 自身的 schema 也符合 DSH 校验", async () => {
  const { toolboxToolDefinition } = await import("../lib/tools.js");
  const definition = toolboxToolDefinition({});
  assertDshSchema(definition.parameters);
  assertDshSchema(definition.output.schema);
});
