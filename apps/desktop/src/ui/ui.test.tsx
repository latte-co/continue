// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardFooter,
  CardHeader,
  CardList,
  Checkbox,
  ChoiceGroup,
  ColorField,
  DataTable,
  Dialog,
  DiffStat,
  Disclosure,
  EmptyState,
  Field,
  FilterBar,
  FloatingPill,
  IconButton,
  InputGroup,
  ItemRow,
  Kbd,
  MenuRow,
  MenuSeparator,
  MenuTitle,
  NavRow,
  NoticeBanner,
  PageContainer,
  PageHeader,
  Popover,
  SearchInput,
  Section,
  SectionHeader,
  Segmented,
  Select,
  SettingRow,
  Slider,
  SplitHandle,
  StageIsland,
  StateBlock,
  StatusSignal,
  Subbar,
  Switch,
  Tabs,
  TextArea,
  TextInput,
  Topbar,
  Well,
} from "./index";

afterEach(() => {
  cleanup();
});

describe("Latte UI Kit (src/ui)", () => {
  it("renders StageIsland, Topbar, Subbar, and SplitHandle with expected landmarks", () => {
    render(
      <StageIsland fullInset data-testid="island">
        <Topbar leading={<span>Project</span>} trailing={<span>Ops</span>} />
        <Subbar>Scope</Subbar>
        <SplitHandle label="调整分栏宽度" />
      </StageIsland>,
    );
    expect(screen.getByTestId("island").dataset.fullInset).toBe("true");
    expect(screen.getByText("Project")).toBeTruthy();
    expect(
      screen.getByRole("separator", { name: "调整分栏宽度" }),
    ).toBeTruthy();
  });

  it("applies Button and IconButton variants, sizes, busy state, and accessible labels", () => {
    const onClick = vi.fn();
    render(
      <div>
        <Button variant="primary" size="lg" fullWidth onClick={onClick}>
          保存
        </Button>
        <Button variant="subtle" size="sm" busy onClick={onClick}>
          连接中
        </Button>
        <IconButton label="展开侧栏" active size="sm">
          <span>≡</span>
        </IconButton>
      </div>,
    );
    const save = screen.getByRole("button", { name: "保存" });
    expect(save.className).toContain("ui-btn--primary");
    expect(save.className).toContain("ui-btn--lg");
    expect(save.className).toContain("ui-btn--full");
    fireEvent.click(save);
    expect(onClick).toHaveBeenCalledOnce();

    const busyBtn = screen.getByRole("button", { name: "连接中" });
    expect(busyBtn.getAttribute("aria-busy")).toBe("true");
    expect((busyBtn as HTMLButtonElement).disabled).toBe(true);

    const icon = screen.getByRole("button", { name: "展开侧栏" });
    expect(icon.dataset.active).toBe("true");
  });

  it("supports Segmented, Tabs, and ChoiceGroup keyboard navigation", () => {
    function Harness() {
      const [mode, setMode] = useState<"unified" | "split">("unified");
      const [tab, setTab] = useState<"platform" | "agent" | "public">(
        "platform",
      );
      const [auth, setAuth] = useState<"none" | "key" | "password">("none");
      return (
        <div>
          <Segmented
            label="视图模式"
            value={mode}
            onChange={setMode}
            options={[
              { value: "unified", label: "统一" },
              { value: "split", label: "并排" },
            ]}
          />
          <Tabs
            label="技能分类"
            value={tab}
            onChange={setTab}
            options={[
              { value: "platform", label: "平台预置", count: 4 },
              { value: "agent", label: "Agent 内置", count: 8 },
              { value: "public", label: "公共技能", count: 12 },
            ]}
          />
          <ChoiceGroup
            label="身份验证方式"
            value={auth}
            onChange={setAuth}
            options={[
              { value: "none", label: "默认身份验证" },
              { value: "key", label: "身份文件" },
              { value: "password", label: "密码" },
            ]}
          />
        </div>
      );
    }
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole("radiogroup", { name: "视图模式" }), {
      key: "ArrowRight",
    });
    expect(
      screen.getByRole("radio", { name: "并排" }).getAttribute("aria-checked"),
    ).toBe("true");

    const tablist = screen.getByRole("tablist", { name: "技能分类" });
    fireEvent.keyDown(tablist, { key: "End" });
    expect(
      screen
        .getByRole("tab", { name: /公共技能/ })
        .getAttribute("aria-selected"),
    ).toBe("true");

    const authGroup = screen.getByRole("radiogroup", { name: "身份验证方式" });
    fireEvent.keyDown(authGroup, { key: "ArrowRight" });
    expect(
      screen
        .getByRole("radio", { name: "身份文件" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("handles PageLayout, FilterBar, Select, clearable SearchInput, Slider, ColorField, and Switch", () => {
    const toggle = vi.fn();
    function FormHarness() {
      const [query, setQuery] = useState("majiang");
      const [project, setProject] = useState("all");
      const [contrast, setContrast] = useState(50);
      const [hex, setHex] = useState("#181818");
      return (
        <PageContainer>
          <PageHeader
            title="已归档的聊天"
            description="查看并恢复已归档的历史对话"
            actions={<Button size="md">刷新</Button>}
          />
          <FilterBar>
            <SearchInput
              aria-label="搜索已归档的聊天"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery("")}
            />
            <Select
              label="筛选项目"
              size="md"
              value={project}
              onChange={setProject}
              options={[
                { value: "all", label: "所有项目" },
                { value: "eval", label: "Evaluation · Devbox" },
              ]}
            />
          </FilterBar>
          <Field label="目录" htmlFor="dir-in" error="路径不存在">
            <InputGroup>
              <TextInput id="dir-in" size="md" monospace defaultValue="/tmp" />
              <Button size="md">浏览</Button>
            </InputGroup>
          </Field>
          <TextArea aria-label="环境变量" monospace rows={2} />
          <Slider
            label="对比度"
            value={contrast}
            onChange={setContrast}
            formatValue={(v) => `${v}%`}
          />
          <ColorField label="背景色" value={hex} onChange={setHex} />
          <Switch label="启用技能" checked={false} onChange={toggle} />
        </PageContainer>
      );
    }
    render(<FormHarness />);
    expect(screen.getByText("已归档的聊天")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(
      (screen.getByLabelText("搜索已归档的聊天") as HTMLInputElement).value,
    ).toBe("");
    fireEvent.change(screen.getByRole("slider", { name: "对比度" }), {
      target: { value: "75" },
    });
    expect(screen.getByText("75%")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "背景色" }), {
      target: { value: "#202024" },
    });
    expect((screen.getByLabelText("背景色") as HTMLInputElement).value).toBe(
      "#202024",
    );
    expect(screen.getByRole("alert").textContent).toBe("路径不存在");
    fireEvent.click(screen.getByRole("switch", { name: "启用技能" }));
    expect(toggle).toHaveBeenCalledWith(true);
  });

  it("renders Section, CardList, ItemRow, SettingRow, CardFooter, Disclosure, and DataTable", () => {
    render(
      <Section>
        <SectionHeader title="Evaluation" meta="Devbox" count="2 个聊天" />
        <CardList label="归档列表">
          <ItemRow
            title="merlin 评测 one-pager"
            subtitle="更新于 2 小时前"
            actions={<Button size="sm">取消归档</Button>}
          />
          <SettingRow
            label="半透明侧边栏"
            description="允许桌面壁纸透出微弱质感"
          >
            <Switch label="半透明侧边栏" checked onChange={() => {}} />
          </SettingRow>
        </CardList>
        <Card>
          <CardFooter status="有未保存的修改">
            <Button variant="primary" size="md">
              保存关联
            </Button>
          </CardFooter>
        </Card>
        <Disclosure title="准备远程设备" meta="4 步">
          <p>在远端编译并安装 latte-work-server。</p>
        </Disclosure>
        <DataTable caption="模型目录">
          <thead>
            <tr>
              <th>模型 ID</th>
              <th>上下文</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>claude-sonnet-4-5</td>
              <td>200K</td>
            </tr>
          </tbody>
        </DataTable>
      </Section>,
    );
    expect(screen.getByText("2 个聊天")).toBeTruthy();
    expect(screen.getByText("merlin 评测 one-pager")).toBeTruthy();
    expect(screen.getByText("有未保存的修改")).toBeTruthy();
    expect(screen.getByText("claude-sonnet-4-5")).toBeTruthy();
  });

  it("renders Popover and Dialog with Escape dismissal and inert focus containment", () => {
    const closeDialog = vi.fn();
    function PopHarness() {
      const anchor = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(true);
      return (
        <>
          <button ref={anchor} type="button">
            触发器
          </button>
          <Popover
            open={open}
            anchorRef={anchor}
            label="快捷菜单"
            onClose={() => setOpen(false)}
          >
            <MenuTitle>会话操作</MenuTitle>
            <MenuRow active>置顶</MenuRow>
            <MenuSeparator />
            <MenuRow danger>归档</MenuRow>
          </Popover>
        </>
      );
    }
    render(
      <>
        <PopHarness />
        <Dialog
          open
          size="sm"
          title="创建项目"
          description="选择本地或远程工作目录"
          onClose={closeDialog}
          footer={<Button variant="primary">确认</Button>}
        >
          <p>目录内容</p>
        </Dialog>
      </>,
    );
    expect(screen.getByText("创建项目")).toBeTruthy();
    expect(screen.getByText("选择本地或远程工作目录")).toBeTruthy();
    fireEvent.keyDown(screen.getByText("创建项目"), { key: "Escape" });
    expect(closeDialog).toHaveBeenCalledOnce();
  });

  it("renders Surfaces, 2-axis NavRow, 5-state StatusSignal, NoticeBanner, and EmptyState", () => {
    const { container } = render(
      <div>
        <Card>
          <CardHeader
            title="统计"
            description="实时指标"
            actions={<Badge tone="brand">Beta</Badge>}
          />
          <Well>
            <Kbd>⌘N</Kbd>
            <DiffStat added={74} removed={22} />
          </Well>
        </Card>
        <FloatingPill>回到最新</FloatingPill>
        <NavRow selected indent="child">
          子会话标题
        </NavRow>
        <StatusSignal status="idle" />
        <StatusSignal status="running" />
        <StatusSignal status="waiting" />
        <StatusSignal status="unread" />
        <StatusSignal status="failed" />
        <StatusSignal status="unknown" />
        <NoticeBanner tone="danger" action={<Button size="xs">重试</Button>}>
          主机连接中断
        </NoticeBanner>
        <NoticeBanner tone="success">Provider 已保存</NoticeBanner>
        <EmptyState
          title="还没有已归档的聊天"
          description="在侧边栏右键会话即可归档，随时可在此恢复。"
        />
        <StateBlock
          kind="error"
          compact
          action={<Button size="xs">重试</Button>}
        >
          读取失败
        </StateBlock>
      </div>,
    );
    expect(screen.getByRole("img", { name: "执行中" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "等待确认" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "未读" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "执行失败" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "状态待确认" })).toBeTruthy();
    expect(container.querySelector(".ui-nav-row--child")).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getByText("还没有已归档的聊天")).toBeTruthy();
  });

  it("propagates ControlSizeContext md sizing inside FilterBar/SettingRow and renders Checkbox inside legacy containers", () => {
    const toggle = vi.fn();
    const { container } = render(
      <div className="settings-panel-content">
        <FilterBar>
          <SearchInput aria-label="过滤项" value="" onChange={() => {}} />
          <Select
            label="过滤范围"
            value="all"
            options={[{ value: "all", label: "全部" }]}
            onChange={() => {}}
          />
        </FilterBar>
        <CardList>
          <SettingRow label="自动核验">
            <Checkbox checked={false} onChange={toggle} label="启用自动核验" />
          </SettingRow>
        </CardList>
      </div>,
    );
    expect(container.querySelector(".ui-input--md")).toBeTruthy();
    expect(container.querySelector(".ui-select-trigger--md")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "启用自动核验" }));
    expect(toggle).toHaveBeenCalledWith(true);
  });

  it("auto-dismisses an open Select listbox when an async Dialog takes focus", () => {
    function SelectModalHarness() {
      const [modalOpen, setModalOpen] = useState(false);
      return (
        <>
          <Select
            label="界面字体"
            value="system"
            options={[
              { value: "system", label: "系统默认" },
              { value: "serif", label: "衬线字体" },
            ]}
            onChange={() => {}}
          />
          <button type="button" onClick={() => setModalOpen(true)}>
            弹出认证框
          </button>
          <Dialog
            open={modalOpen}
            size="sm"
            title="SSH 认证"
            onClose={() => setModalOpen(false)}
            footer={<Button variant="primary">连接</Button>}
          >
            <input aria-label="密码输入" />
          </Dialog>
        </>
      );
    }
    render(<SelectModalHarness />);
    fireEvent.click(screen.getByRole("combobox", { name: "界面字体" }));
    expect(screen.getByRole("listbox", { name: "界面字体" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "弹出认证框" }));
    expect(screen.getByRole("dialog", { name: "SSH 认证" })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "界面字体" })).toBeNull();
  });
});
