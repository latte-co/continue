import { describe, expect, it } from "vitest";
import { parseTurnError } from "./turnError";

describe("parseTurnError", () => {
  it("parses bracketed 429 rate-limit API errors and strips numeric code + trace ID", () => {
    const raw =
      "API Error: Request rejected (429) · [1302][您的账户已达到速率限制，请您控制请求频率][20261125162645e418428b3b184a3a]";
    expect(parseTurnError(raw)).toEqual({
      tone: "warning",
      category: "rate_limit",
      title: "请求达到速率限制 (429)",
      detail: "您的账户已达到速率限制，请您控制请求频率",
      raw,
    });
  });

  it("classifies 401 auth errors and strips trailing request IDs", () => {
    const raw =
      "API Error: 401 Unauthorized · invalid_api_key: API key expired [req_441a8b]";
    expect(parseTurnError(raw)).toEqual({
      tone: "danger",
      category: "auth",
      title: "模型鉴权失败 (401)",
      detail: "invalid_api_key: API key expired",
      raw,
    });
  });

  it("extracts human message from embedded JSON error payloads", () => {
    const raw =
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 205123 tokens > 200000 maximum"}}';
    expect(parseTurnError(raw)).toEqual({
      tone: "danger",
      category: "context",
      title: "上下文超出模型上限 (400)",
      detail: "prompt is too long: 205123 tokens > 200000 maximum",
      raw,
    });
  });

  it("classifies 502 upstream gateway failures", () => {
    const raw =
      "API Error: 502 Bad Gateway · upstream connect error or disconnect/reset before headers [req_98f12c04]";
    expect(parseTurnError(raw)).toEqual({
      tone: "danger",
      category: "upstream",
      title: "模型服务响应失败 (502)",
      detail: "upstream connect error or disconnect/reset before headers",
      raw,
    });
  });

  it("keeps plain daemon or tool error text intact without inventing advice", () => {
    expect(parseTurnError("命令退出码非零")).toEqual({
      tone: "danger",
      category: "general",
      title: "执行失败",
      detail: "命令退出码非零",
      raw: "命令退出码非零",
    });
    expect(parseTurnError("执行失败")).toEqual({
      tone: "danger",
      category: "general",
      title: "执行失败",
      detail: "",
      raw: "执行失败",
    });
  });
});
