// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  type ComposerCommandTokenMeta,
  hasRichComposerMarkdown,
  htmlToComposerMarkdown,
  parseMarkdownToDoc,
  smartPasteTransform,
  tsvToMarkdownTable,
} from "./composerMarkdown";

describe("hasRichComposerMarkdown", () => {
  it("keeps plain text, slash commands, mentions, and bare URLs in textarea mode", () => {
    expect(hasRichComposerMarkdown("")).toBe(false);
    expect(hasRichComposerMarkdown("请帮我检查这段逻辑")).toBe(false);
    expect(hasRichComposerMarkdown("第一行\n第二行")).toBe(false);
    expect(hasRichComposerMarkdown("/compact 保留结论")).toBe(false);
    expect(hasRichComposerMarkdown("看看 @src/Composer.tsx")).toBe(false);
    expect(hasRichComposerMarkdown("https://example.com/docs")).toBe(false);
    expect(hasRichComposerMarkdown("#hashtag")).toBe(false);
    expect(hasRichComposerMarkdown("```python")).toBe(false);
  });

  it("detects lists, links, tables, code blocks, inline code, headings, quotes, and emphasis", () => {
    expect(hasRichComposerMarkdown("1. ")).toBe(true);
    expect(hasRichComposerMarkdown("1. 第一项\n2. 第二项")).toBe(true);
    expect(hasRichComposerMarkdown("- 列表项")).toBe(true);
    expect(hasRichComposerMarkdown("* 星号列表")).toBe(true);
    expect(hasRichComposerMarkdown("- [ ] 待办事项")).toBe(true);
    expect(hasRichComposerMarkdown("[文档](https://example.com/docs)")).toBe(
      true,
    );
    expect(hasRichComposerMarkdown("请看 `Composer.tsx` 实现")).toBe(true);
    expect(hasRichComposerMarkdown("```ts\nconst a = 1;")).toBe(true);
    expect(hasRichComposerMarkdown("```ts ")).toBe(true);
    expect(hasRichComposerMarkdown("| 名称 | 状态 |\n| --- | --- |")).toBe(
      true,
    );
    expect(hasRichComposerMarkdown("## 二级标题")).toBe(true);
    expect(hasRichComposerMarkdown("> 引用内容")).toBe(true);
    expect(hasRichComposerMarkdown("这是 **加粗** 文本")).toBe(true);
    expect(hasRichComposerMarkdown("这是 *斜体* 文本")).toBe(true);
    expect(hasRichComposerMarkdown("这是 ~~删除线~~ 文本")).toBe(true);
  });
});

describe("smartPasteTransform", () => {
  it("wraps single-line selected text as a Markdown link when pasting an HTTP(S) URL", () => {
    const currentValue = "3. ddd 文档";
    const start = currentValue.indexOf("文档");
    const end = start + "文档".length;
    expect(
      smartPasteTransform({
        clipboardText: "https://developers.openai.com/codex",
        clipboardHtml: "",
        hasHtmlType: false,
        currentValue,
        selectionStart: start,
        selectionEnd: end,
      }),
    ).toBe("[文档](https://developers.openai.com/codex)");
  });

  it("leaves bare URL pastes untouched when there is no selection", () => {
    expect(
      smartPasteTransform({
        clipboardText: "https://example.com/api",
        clipboardHtml: "",
        hasHtmlType: false,
        currentValue: "请求地址：",
        selectionStart: 5,
        selectionEnd: 5,
      }),
    ).toBeNull();
  });

  it("converts rich HTML links, lists, tables, and code blocks to GFM Markdown", () => {
    expect(
      htmlToComposerMarkdown(
        '<p>参考 <a href="https://example.com/spec">设计规范</a></p>',
      ),
    ).toBe("参考 [设计规范](https://example.com/spec)");

    expect(
      htmlToComposerMarkdown(
        "<table><tr><th>模块</th><th>结果</th></tr><tr><td>桌面端</td><td>通过</td></tr></table>",
      ),
    ).toBe("| 模块 | 结果 |\n| --- | --- |\n| 桌面端 | 通过 |");

    expect(
      htmlToComposerMarkdown(
        '<pre><code class="language-rust">fn main() {}</code></pre>',
      ),
    ).toBe("```rust\nfn main() {}\n```");

    expect(
      htmlToComposerMarkdown("<ol><li>第一项</li><li>第二项</li></ol>"),
    ).toBe("1. 第一项\n2. 第二项");
  });

  it("ignores non-semantic syntax-highlighted IDE span/div HTML wrappers", () => {
    expect(
      htmlToComposerMarkdown(
        '<div style="color:#ccc"><span style="color:#569cd6">const</span> x = 1;</div>',
      ),
    ).toBeNull();
  });

  it("converts multi-row TSV clipboard data into a GFM pipe table", () => {
    expect(tsvToMarkdownTable("指标\t数值\n延迟\t12ms\n吞吐\t1200")).toBe(
      "| 指标 | 数值 |\n| --- | --- |\n| 延迟 | 12ms |\n| 吞吐 | 1200 |",
    );
  });
});

describe("parseMarkdownToDoc", () => {
  it("parses ordered lists with inline link pills and reference chips", () => {
    const text = "1. 22\n2. 22\n3. ddd [文档](https://example.com) ";
    const doc = parseMarkdownToDoc(text, [
      {
        name: "README.md",
        path: "README.md",
        directory: false,
        inlineOffset: text.length,
      },
    ]);
    expect(doc.content?.[0]?.type).toBe("orderedList");
    const items = doc.content?.[0]?.content ?? [];
    expect(items).toHaveLength(3);
    const thirdInline = items[2]?.content?.[0]?.content ?? [];
    expect(thirdInline).toEqual([
      { type: "text", text: "ddd " },
      {
        type: "linkPill",
        attrs: { label: "文档", href: "https://example.com" },
      },
      { type: "text", text: " " },
      {
        type: "referenceChip",
        attrs: {
          path: "README.md",
          name: "README.md",
          directory: false,
          mimeType: null,
        },
      },
    ]);
  });

  it("parses recognized command and skill tokens into commandPill nodes while keeping active triggers and paths plain", () => {
    const commands = new Map<string, ComposerCommandTokenMeta>([
      [
        "doc-coauthoring",
        { name: "doc-coauthoring", icon: "skill", title: "Doc Coauthoring" },
      ],
      ["compact", { name: "compact", icon: "command", title: "压缩上下文" }],
    ]);
    expect(hasRichComposerMarkdown("/doc-coauthoring", commands, 0)).toBe(
      false,
    );
    expect(hasRichComposerMarkdown("/doc-coauthoring ", commands, null)).toBe(
      true,
    );
    expect(hasRichComposerMarkdown("/tmp/file 请检查", commands, null)).toBe(
      false,
    );

    const doc = parseMarkdownToDoc(
      "/doc-coauthoring /compact /doc-coauthoring",
      [],
      commands,
      26,
    );
    expect(doc.content?.[0]?.content).toEqual([
      {
        type: "commandPill",
        attrs: {
          name: "doc-coauthoring",
          icon: "skill",
          title: "Doc Coauthoring",
        },
      },
      { type: "text", text: " " },
      {
        type: "commandPill",
        attrs: {
          name: "compact",
          icon: "command",
          title: "压缩上下文",
        },
      },
      { type: "text", text: " /doc-coauthoring" },
    ]);
  });
});
