import { useState } from "react";
import {
  CardList,
  NoticeBanner,
  PageContainer,
  PageHeader,
  Select,
  SettingRow,
} from "./ui";
import { saveLinkTarget, useLinkTarget, type LinkTarget } from "./browserLinks";
import { message } from "./api";

export function BrowserSettings() {
  const target = useLinkTarget();
  const [error, setError] = useState("");
  return (
    <PageContainer className="browser-settings settings-panel-content">
      <PageHeader
        title="浏览器"
        description="配置对话与文档中外部链接的默认打开位置。"
      />
      <CardList>
        <SettingRow
          label="链接默认打开方式"
          description="右键点击任意链接，仍可单独选择打开方式或复制链接。"
        >
          <Select
            label="链接默认打开方式"
            size="md"
            minMenuWidth={240}
            align="end"
            value={target}
            options={[
              {
                value: "internal",
                label: "内置浏览器",
                description: "在右侧工作区打开网页标签",
              },
              {
                value: "system",
                label: "系统默认浏览器",
                description: "使用系统设置的浏览器",
              },
            ]}
            onChange={(value) => {
              try {
                saveLinkTarget(value as LinkTarget);
                setError("");
              } catch (e) {
                setError(`设置保存失败：${message(e)}`);
              }
            }}
          />
        </SettingRow>
      </CardList>
      {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
    </PageContainer>
  );
}
