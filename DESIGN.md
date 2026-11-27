# Continue Design System (`DESIGN.md`)

This document is the authoritative visual, geometric, optical-surface,
interaction, and component contract for the Continue desktop client
(`apps/desktop/`).

**Core rule — Component-First, Token-First:** Every new or refactored page,
workspace pane, toolbar, dialog, popover, composer surface, or settings view
**must** compose primitives from `apps/desktop/src/ui/` and tokens from
`apps/desktop/src/tokens.css`. Never introduce ad-hoc `border-radius`, control
`height`, raw hex colors, per-item padded boulder cards, or one-off
popover/dialog wrappers in feature stylesheets.

Detailed behavioral invariants for existing workflows (drag reorder, keyboard
shortcuts, session lifecycle, bounded pagination) remain documented in
`docs/design-system.md`. When older prose in `docs/design-system.md` conflicts
with token values, geometry, or component rules below, **`DESIGN.md` +
`tokens.css` + `src/ui/` win**.

---

## 1. Complete UI Control Catalog (`apps/desktop/src/ui/`)

Import all shared layout, form, surface, navigation, overlay, and feedback
controls from `./ui`:

```tsx
import {
  // 1. Stage & Pane Topology
  StageIsland,
  Topbar,
  Subbar,
  SplitHandle,
  // 2. Page, Section & Toolbar Layout
  PageContainer,
  PageHeader,
  Section,
  SectionHeader,
  FilterBar,
  // 3. Action Controls
  Button,
  IconButton,
  // 4. Form & Selection Controls
  Field,
  TextInput,
  InputGroup,
  TextArea,
  SearchInput,
  Select,
  Switch,
  Checkbox,
  Slider,
  ColorField,
  ChoiceGroup,
  // 5. Surfaces, Grouped Lists & Disclosures
  Card,
  CardHeader,
  CardFooter,
  CardList,
  ItemRow,
  SettingRow,
  NavRow,
  Disclosure,
  Well,
  FloatingPill,
  // 6. Mode Switchers, Category Tabs & Data Tables
  Segmented,
  Tabs,
  DataTable,
  // 7. Overlays & Modals
  Popover,
  MenuTitle,
  MenuRow,
  MenuSeparator,
  Dialog,
  // 8. Semantic Signals, Notices & Empty States
  StatusSignal,
  Badge,
  NoticeBanner,
  EmptyState,
  Kbd,
  DiffStat,
  StateBlock,
} from "./ui";
```

| Module | Primitives | Responsibility & When to Use |
| --- | --- | --- |
| `ui/Stage.tsx` | `StageIsland`, `Topbar`, `Subbar`, `SplitHandle` | Right-hand `12px` single stage island (`6px` inset, `overflow: clip; isolation: isolate`), `38px` island topbars (`44px - 6px` aligned with window drag bar), `38px` secondary toolbars, and `1px` orthogonal pane splits. |
| `ui/Layout.tsx` | `PageContainer`, `PageHeader`, `Section`, `SectionHeader`, `FilterBar` | Centered page rhythm (`680px` standard / `960px` wide), page title + description + primary CTA, grouped section headers (`icon + title + host + count`), and height-locked horizontal search/filter bars (provides `ControlSizeContext` `"md"`). |
| `ui/Button.tsx` | `Button`, `IconButton` | All action triggers (`primary`, `elevated`, `subtle`, `ghost`, `danger` across `lg:36`, `md:32`, `sm:28`, `xs:24`), with `busy` spinner, `leading`/`trailing` icons, `active` elevation, and `fullWidth` support. |
| `ui/Select.tsx` | `Select` | Application-owned dark/light-aware combobox (`size="lg" \| "md" \| "sm"`, `variant="well" \| "ghost"`, `leading` icon, `searchable`, `menuTitle`, `align="start" \| "end"`, full keyboard + IME safety). Re-exported by `src/Select.tsx`. |
| `ui/Form.tsx` | `Field`, `TextInput`, `InputGroup`, `TextArea`, `SearchInput`, `Switch`, `Checkbox`, `Slider`, `ColorField`, `ChoiceGroup` | Size-locked inputs (`lg:36`, `md:32`, `sm:28`), input + trailing button groups, monospace ENV/code textareas, clearable search inputs, accessible `role="switch"` toggles, optical `Checkbox`, tabular range sliders, `#RRGGBB` color fields, and `role="radiogroup"` choice pills/cards. |
| `ui/Surface.tsx` | `Card`, `CardHeader`, `CardFooter`, `CardList`, `Disclosure`, `Well`, `FloatingPill` | `10px` optical cards, dirty-state save footers, `1px` hairline-divided grouped record lists (`CardList`), `<details>` accordions (`Disclosure`), recessed `8px` slots (`Well`), and `28px` elevated floating pills (`FloatingPill`). |
| `ui/ListRow.tsx` | `ItemRow`, `SettingRow`, `NavRow` | Compact `48–54px` structured record rows (`ItemRow` for Agents, Archived Chats, SSH hosts, Providers), two-column preference rows (`SettingRow`, provides `ControlSizeContext` `"md"`), and matte borderless 2-axis sidebar/nav rows (`NavRow`). |
| `ui/Segmented.tsx` | `Segmented` | Mode switchers (`Unified / Split`, `源码 / 预览`, `浅色主题 / 深色主题`) with `10px` recessed track and `8px` elevated active thumb (`default:28px` or `md:32px`). |
| `ui/Tabs.tsx` | `Tabs` | Category tab strips (`variant="pill" \| "underline"`, `role="tablist"` with roving arrow-key focus and tabular item counts, e.g. Skills scope tabs). |
| `ui/Table.tsx` | `DataTable` | `10px` framed compact data tables with muted headers, `1px` hairline dividers, and tabular numerals (e.g. Provider model catalog). |
| `ui/Overlay.tsx` | `Popover`, `MenuTitle`, `MenuRow`, `MenuSeparator`, `Dialog` | Viewport-clamped `10px` elevated menus and standardized `14px` modal dialogs (`sm:380`, `md:480`, `lg:600`) atop `Modal.tsx`'s nested `inert` focus containment stack. |
| `ui/Feedback.tsx` | `StatusSignal`, `Badge`, `NoticeBanner`, `EmptyState`, `Kbd`, `DiffStat`, `StateBlock` | 5-state semantic status signals, `5px` micro badges/keycaps, inline alert/status banners (`NoticeBanner`), calm `10px` zero-data blocks (`EmptyState`), and tabular `+add / -del` stats. |

---

## 2. Spatial Window Topology, Narrow-Viewport Budget & Concentric Geometry

### Multi-Plane Spatial Hierarchy

1. **`L1` Window Shell & Sidebar (`--color-shell` / `--color-sidebar`)**: Outer
   ambient shell (`#131313` in default dark, `#EFEFEF` in default light) with
   optional macOS vibrancy (`backdrop-filter: blur(28px) saturate(150%)`) and a
   floating `12px` `.sidebar-preview` hover-peek drawer when collapsed.
2. **`L2` Clipped Single Stage Island (`StageIsland`, `--color-canvas`)**: Houses
   both the primary conversation canvas and the collapsible right workspace
   inside **one** `12px` rounded container (`--island-inset: 6px`) with
   `overflow: clip; isolation: isolate` and crisp `1px` perimeter elevation
   (`--shadow-island`).
3. **`L2b` Auxiliary Workspace Tint (`--workspace-bg`)**: Non-expanded right
   workspace panes (`任务概览`, `文件`, `变更 Diff`, `终端`, `浏览器`, `SideChat`)
   use a subtle recessed mix (`78% canvas + 22% shell`) separated from the focal
   conversation stage by a straight `1px` orthogonal `SplitHandle`.
4. **`L3` Optical Cards & Double-Bezel Composer (`--color-card` / `--color-composer`)**:
   Grouped cards (`10px`) and the elevated input cockpit (`12px`,
   `--shadow-composer` resting -> `--shadow-composer-focus` on `:focus-within`).

### Narrow-Window Stage Budget (`workspaceState.ts` & `@container` Queries)

- **Stage Width Floor**: `CONVERSATION_MIN_WIDTH = 340px`,
  `WORKSPACE_MIN_WIDTH = 280px`, `STAGE_ISLAND_INSET = 6px`,
  `SIDEBAR_HANDLE_WIDTH = 4px`, `WORKSPACE_HANDLE_WIDTH = 1px`. Right workspace
  width clamps dynamically to `stageWidth - 340 - 1` so opening the right pane on
  a `960 × 640` window never crushes the conversation column.
- **Container-Driven Responsive Gutters**:
  - `@container conversation (max-width: 480px)` shrinks `--content-gutter` to
    `12px`; `(max-width: 380px)` shrinks it to `8px`.
  - `@container composer (max-width: 480px)` tightens composer padding and hides
    secondary effort labels before truncating the model name; permission text
    collapses to icon-only strictly below `260px`.

### Concentric Corner Radius Ladder (`R_outer = R_inner + padding`)

| Token | Value | Scope |
| --- | --- | --- |
| `--radius-window` | `16px` | Native macOS window frame |
| `--radius-dialog` | `14px` | Modal dialogs (`Dialog`, `SettingsPage` `.settings-modal`) |
| `--radius-island` | `12px` | `StageIsland`, `.sidebar-preview`, `Composer`, user message bubble |
| `--radius-card` / `--radius-track` | `10px` | `Card`, `CardList`, `DataTable`, `EmptyState`, `ApprovalCard`, `Popover`, `.composer-menu`, `Segmented` track |
| `--radius-control` | `8px` | **All** buttons, icon buttons, inputs, `SearchInput`, `Select`, `NoticeBanner`, `NavRow`, `MenuRow`, `FloatingPill`, `.activity-well`, workspace tabs, segmented thumbs |
| `--radius-badge` | `5px` | `<Kbd>`, `<Badge>`, inline `<code>`, `.composer-link-pill`, tool status tags |
| `--radius-pill` | `999px` | Reserved strictly for `Switch` tracks, status dots, and circular swatches |

Do not introduce arbitrary intermediate radii (`3px`, `18px`, `20px`, `24px`, or
`50%` action buttons; only ultra-dense `28px` `.composer-menu-option` rows inside
`4px`-padded `10px` autocomplete menus use concentric `6px` `10 - 4` inner radius).

---

## 3. Control Heights, Horizontal Bar Lock & Typography

### Four-Tier Control Height Matrix (Strict Horizontal Alignment Rule)

Controls placed side-by-side in the same horizontal bar **must** use the exact
same `size` token so heights, text baselines, and `8px` corner radii align to
the subpixel:

| Size Token | CSS Variable | Height | Mandatory Scope |
| --- | --- | --- | --- |
| `lg` | `--control-height-lg` | `36px` (`34px` on `Button`) | Standalone vertical form fields inside `Dialog`s and subview forms (`Field` + `TextInput size="lg"` / `Select size="lg"`). |
| `md` | `--control-height-md` | `32px` (`30px` `--button-height` standalone; `32px` inside `FilterBar` / `InputGroup`) | **Default** for `FilterBar` (`SearchInput` + `Select` + `Button`), `SettingRow` controls, `NavRow`, `MenuRow`, and modal/subview footer CTAs. |
| `sm` | `--control-height-sm` | `28px` | Compact `Topbar` / `Subbar` / `SettingsPane` header actions (`+ 添加`), `IconButton` hit targets (`28×28px`), `FloatingPill`, `.composer-menu-option`, and inline `ItemRow` actions (`取消归档`, `编辑`). |
| `xs` | `--control-height-xs` | `24px` | Dense inline micro actions (`查看完整输入`, `重试`) and compact `Segmented` items. |

- **Tactile Keycap Button Grammar (`Button` & `IconButton`)**:
  - **Unified `border-box` Geometry & Optical Icon Compensation**: Every `Button` and
    `IconButton` reserves a `1px solid` border slot (`transparent` on `ghost`) with
    size-proportional radii (`8px / 7px / 6px / 5px`) and tighter inline padding on
    any edge carrying a `leading` or `trailing` icon (`data-has-leading` /
    `data-has-trailing`), plus crisp `translateY(0.5px)` vertical press without
    blur-inducing `scale()`.
  - **Semantic Variant Hierarchy**:
    - `primary`: Reserved strictly for the single commit CTA of a form, dialog, or
      approval card (`保存并连接`, `保存`, `创建项目`, `允许一次`, `提交回答`). Never place a
      high-contrast `primary` slab in `SettingsPane` headers or `FilterBar`s.
    - `elevated`: Tactile raised keycap (`--color-btn-elevated` + `--color-border-strong`
      + top inner rim `--color-btn-rim`) for page/toolbar creation triggers (`+ 添加`
      in `SSHSettings` / `ProviderSettings` / `SkillAddMenu`). Inside
      `.settings-pane-header`, separate `.settings-pane-toolbar` from the modal
      close `×` button with a `1px` vertical hairline.
    - `subtle`: Default secondary keycap (`--color-btn-bg` + `--color-border`) for
      `取消`, `编辑` (clean label without redundant trailing `>` chevrons), `拒绝`, and
      `跳过`.
    - `danger` & `intent="danger"`: Calibrated crimson keycap (`--color-danger-surface`,
      `--color-danger-border`, `--color-danger-text`) for destructive confirmations
      (`确认移除`, `确认删除`, `卸载`). Row-level delete icons use `variant="ghost"
      intent="danger"` (muted at rest, crimson on hover), and inline row
      confirmations always follow left-to-right `[取消 (subtle)] [确认移除/删除 (danger)]`
      ordering matching Dialog footers.

- **Toolbar Non-Wrap Priority**: Inside `.ui-page-actions > .ui-filter-bar` (e.g.
  `SkillsSettings`), `.ui-search-wrap` uses `flex: 0 1 220px` (`min-width: 150px`)
  and `.ui-select-trigger` uses `flex: 0 0 auto` so search, host selector,
  refresh, and primary `+ 添加` stay on one horizontal row on wide viewports and
  wrap cleanly only when constrained.
- **Zero Baked Margin**: Never bake outer `margin-top` onto individual form
  controls (`TextInput`, `SearchInput`, `Select`); parent layout containers
  (`Field`, `FilterBar`, `InputGroup`, `SettingRow`) own all inter-element spacing.

### Typography & Optical Icon Grid

- **5-Step Type Scale**: `11px` (`--text-xs` micro metadata/badges) · `12px`
  (`--text-sm` labels/toolbars/code/descriptions) · `13px` (`--text-md` default UI,
  lists, tool rows, composer editor) · `14px` (`--text-lg` Markdown prose & user
  bubbles) · `18px` (`--text-heading` page titles; `15px` `--text-subheading` for
  modal/pane headers; `20px` `--text-page-title` for welcome hero).
- **Tabular Numerals**: Apply `font-variant-numeric: tabular-nums` to all counts,
  durations, slider readouts, token metrics, ordered list markers, line numbers,
  and `+add / -del` stats.
- **Markdown GFM Table Readability (`.markdown-table-wrap` + `MessageContent.tsx`)**:
  - **Framed `10px` Scroll Container**: Wrap Markdown `<table>` inside
    `.markdown-table-wrap` (`border-radius: var(--radius-card); border: 1px solid
    var(--color-border); overflow-x: auto`) while preserving native `display: table;
    width: 100%` layout, top-aligned cells (`vertical-align: top`), `1px` vertical
    column hairlines (`th + th`, `td + td`), distinct `12px` `thead` fill, and subtle
    even-row / hover tracking.
  - **Adaptive CJK Column Floors**: Compute content-aware `minWidth` floors per
    `<th>`/`<td>` (`6.5rem–14.5rem` for CJK/prose columns while leaving tiny `#` /
    status columns unconstrained) so CJK category columns never collapse into
    1-character-wide vertical strips.
  - **Safe `<br>` Cell Paragraph Splitting**: Convert literal `<br>` / `<br/>` /
    `<br />` tags (outside `code` / `inlineCode`, without enabling `rehype-raw`)
    into `6px`-spaced `.markdown-cell-block` paragraphs inside `<td>`.
- **Icons**: Lucide icons at `15.5px` (`13px–14px` for auxiliary chevrons, search
  icons, and tool stream icons) with `stroke-width: 1.6`.

---

## 4. Page, Modal Settings & View Composition Recipes (Anti-Bloat Rules)

To keep every page visually calm, dense, and cohesive:

1. **Modal Settings Shell & Zero Modal-on-Modal (`SettingsPage` + `SettingsPane`)**:
   - `SettingsPage` renders as a centered two-column `14px` modal
     (`width: min(920px, 100vw - 48px)`, `height: min(640px, 100dvh - 64px)`,
     `208px` `NavRow` category rail + `SettingsPane` content column) over the
     inert workbench (`Modal.tsx` focus/inert stack).
   - Categories: `连接与 Agent`, `SSH 连接`, `模型`, `浏览器`, `外观`, `已归档的聊天`.
   - **Never stack a child form `<Dialog>` atop `SettingsPage`** (except transient
     system/SSH password prompts). Entity-list pages (`SSHSettings`,
     `ProviderSettings`) start on a collapsed `<CardList>` summary view and
     transition in-place into a **Drill-down Subview** (`52px` sticky breadcrumb
     header `‹ SSH 连接 / 编辑 Devbox` + scrollable `.settings-subview-form` +
     `54px` sticky footer `[取消] [保存]`).
   - `AgentSettings` renders each detected CLI agent as a compact `<ItemRow>` with
     an inline row-tail Provider `<Select size="sm">` and a collapsible `ENV`
     drawer button (`环境变量` / `ENV · N`) inside the same `<CardList>`.
2. **Grouped `CardList` + `ItemRow` Over Per-Item Boulder Cards**:
   Never render a list of records (Agents, Archived Chats, SSH Hosts, Providers,
   Subagents) as separate `padding: 20px` cards or pre-expanded multi-footer
   forms. Group related records inside **one** `10px` `<CardList>` and render each
   record as a compact `48–54px` `<ItemRow>` (`10px 16px` padding) separated by
   `1px` `--color-border-subtle` hairlines, with summary `<Badge>`s and `size="sm"`
   subtle or ghost action buttons on the right.
3. **Preference Rows & Global Switcher Rules (`SettingRow` / `Select` / `Segmented`)**:
   - **Static 2–4 view modes** (`浅色主题 | 深色主题`, `Unified | Split`, `源码 | 预览`):
     use `<Segmented>`.
   - **Dynamic entity scopes** (`运行主机`, `技能所在主机`, `所有项目`): place
     `<Select size="md">` with a leading icon in `.settings-pane-actions` or
     `<FilterBar>`.
   - **Single-choice preference rows** inside `<SettingRow>`: use borderless
     `<Select variant="ghost" align="end">` triggers opening an opaque popover
     menu with checkmarks and descriptions rather than boxed inputs on every row.
4. **Progressive Disclosure (`Disclosure`)**:
   Tuck secondary setup guides (`准备远程设备`), diagnostics (`服务与实例诊断`), and
   manual overrides (`手动输入路径`, `操作参数`) inside `<Disclosure>` rather than
   permanently expanding multi-paragraph instructions inline.

---

## 5. Perceptual OKLCH Palette, Optical Surfaces & Signals

- **OKLCH Derivation (`appearance.ts`)**:
  - Built-in presets: Dark (`Latte` `#181818`, `Material` `#1E272C`, `Graphite`
    `#202024`) and Light (`Latte` `#FFFFFF`, `Paper` `#FAF7F2`, `Mint` `#F4F8F6`).
  - Interpolates surfaces in OKLab/OKLCH perceptual lightness while serializing
    `--color-*` tokens to `#RRGGBB` / `#RRGGBBAA` for `Appearance` JSON
    `version: 1` compatibility, enforcing WCAG AA `>= 4.5:1` (`4.75:1` muted,
    `7.0:1` secondary) across all seven surface planes (`canvas`, `sidebar`,
    `surface`, `card`, `elevated`, `input`, `composer`).
  - **Placeholder Contrast Invariant**: `--color-placeholder` equals the contrast-
    verified `--color-text-muted` token directly (`opacity: 1`), never diluted
    with background `color-mix`, so empty composer and search prompts remain
    legible (`>= 4.75:1`) in Material and custom dark themes.
- **Three Optical Surface Tiers & Cohesive 4-Step Border Ramp**:
  All container rings, control borders, popover frames, and focus rings derive from
  one OKLCH-interpolated, `contrast`-scaled ramp (`--color-border-subtle` ->
  `--color-border` -> `--color-border-strong` -> `--color-focus-ring`) — never
  disconnected `rgba(255, 255, 255, ...)` outer rings that vanish over dark
  backdrops or stark `#FFFFFF` focus outlines:
  1. `Well` (`--color-well` + `--shadow-well`): `8px` recessed `1px` inner
     hairline (`inset 0 0 0 1px var(--color-border)`) for inputs, selects, subtle
     buttons, code blocks, and `Segmented` tracks; focuses in-place via `1px`
     `--focus-ring-inset` (`inset 0 0 0 1px var(--color-focus-ring)`) without
     outer geometry expansion.
  2. `Card` (`--color-card` + `--shadow-card`): `10px` grouped surface with `1px`
     `--color-border-subtle` (dark) / `--color-border` (light) perimeter ring.
  3. `Elevated` (`--color-elevated` + `--shadow-elevated` / `--shadow-popover`):
     `8px`/`10px` raised surface with opaque `1px` `--color-border` /
     `--color-border-strong` perimeter. Menu and listbox rows (`MenuRow`,
     `Select`, `ModelSelector`, context menus) indicate hover/focus strictly via
     soft row fills (`--color-hover` / `--color-row-selected`) with zero focus
     border rings (`box-shadow: none`).
- **Five-State Semantic Signal Grammar (`StatusSignal`)**:
  - `running`: 3-dot emerald pulse (`•••`, `--color-success`)
  - `waiting`: Amber `CirclePause` (`13.5px`, `--color-warning`)
  - `unread`: `6px` sky-blue solid dot (`--color-unread`)
  - `failed`: Coral-red `CircleAlert` (`13.5px`, `--color-danger`)
  - `unknown`: Muted `CircleHelp` (`13.5px`, `--color-text-muted`) — **Safety
    invariant:** never infer completion or success after a transport/daemon
    interruption; preserve `unknown` (`状态待确认`) until reconciled.
  - `idle`: **Visual silence** (render nothing).

---

## 6. Sidebar Calm Density, Vertical-Line Whitelist & Session Execution Stream

### Sidebar & Global Vertical-Line Whitelist

- **Sidebar Calm Density**: Zero colored rectangular badges on sidebar rows;
  strict 2-axis left alignment (`7px` project row vs `31px` child session title,
  flush under parent project name); single right-edge `.row-status` swapped cleanly
  with hover action buttons.
- **Global Vertical-Line Whitelist (`No Scaffold Rails for Depth <= 2`)**:
  Never draw vertical indent guide lines in the Sidebar (`项目 → 会话`) or
  Session Process Stream (`阶段簇 → 工具行 → 展开卡`). Vertical bars are allowed
  only for: ① `2.5px` `+ / -` bars inside inline code diffs, ② `2px`
  Markdown/SideChat blockquotes, and ③ `WorkspaceFiles` directory trees at depth
  `>= 3`. Level-2 tool children (`.activity-children`) indent on a pure **`22px`
  whitespace axis**, while expanded `.activity-output` wells align **flush with
  their own parent row's left edge** (`0px` at top level alongside prose/code
  blocks; `22px` inside `.activity-children`).

### Graded Tool Failure Folding (`ToolGroup` + `activity.ts`)

- **Keep Exploratory Failures Folded in Level-2 Phase Clusters**: Intermediate
  `failed` tool calls (e.g. probing whether a file exists or checking a command
  exit code before recovering) are grouped together with adjacent `completed` /
  `pending` / `unconfirmed` tool calls inside the same `<ToolGroup>`. Only human-
  gated interactive items (`approval`, `askuserquestion`) break out to Level 1.
- **Two-Tier Level-1 Failure Signaling**:
  1. **Calm Passthrough (Recovered / Partial Failure)**: When a phase cluster has
     both succeeded and failed steps (and did not halt the turn unrecovered),
     Level 1 keeps its neutral phase icon and appends a muted tabular count
     `探索了文件并运行了命令 · 71 步（2 项失败）` — zero red icons or red pills on
     Level 1, while preserving per-row red `CircleAlert` + `失败` badges inside
     Level 2 when expanded.
  2. **Escalated Failure (All Failed or Unrecovered Tail Halt)**: Level 1
     renders coral-red `CircleAlert` + trailing `失败` status pill **only** when
     every tool in the group failed, or when the turn ended `failed`/`stopped`
     with no assistant recovery after a trailing failed tool.

### Unified Semantic Execution Wells (`ToolRow` & `ApprovalCard`)

Both regular `<ToolRow>` items and `<ApprovalCard>` items (`presentation="request"`
in the live approval dock and `presentation="record"` in the transcript) share the
exact same `<ToolDetailBody>` semantic `8px` (`--radius-control`, `1px solid
var(--color-border)`) `.activity-well` containers:

- **Terminal Well (`.activity-well--terminal`)**:
  - **Conditional `cwd` Header**: Renders `.activity-well-header` with folder icon
    + directory path **only** when `input.cwd` is outside `projectPath` (or uses a
    subpath relative to `projectPath`), omitting redundant headers when running in
    the project root.
  - **`$` Prompt & Output**: `.activity-terminal-prompt` (`$` sigil + wrapped
    monospace command) above a `1px` hairline-separated `.activity-terminal-stdout`
    section (labeled `错误输出` when `status === "failed"`).
- **Diff Well (`.activity-well--diff`)**: Header with `file_path` + tabular
  `<DiffStat>` (`+add -del` or `差异已简化` warning badge) above `.activity-diff-lines`
  with `38px` tabular line-number gutter and `2.5px` emerald/coral left bars.
- **Code / Search Well (`.activity-well--code`)**: Header with target path/pattern
  + `行范围` metadata above bounded monospace output.
- **Approval Alignment Contract**: Resolved `<ApprovalCard presentation="record">`
  renders `<details class="approval-result activity-row">` with `ShieldCheck`
  (`14px`), two-tone verb + monospace target, status pill (`已完成` / `执行失败` /
  `已拒绝`), and `.activity-output` flush with its own row's left edge (`0px` top-
  level) housing `<ToolDetailBody>` + collapsible `操作参数`.

### Borderless Stream Error Row & Dual-Layer Deduplication (`TurnErrorRow`)

- **Dual-Layer Synthetic Error Deduplication**:
  - **Server (`agents/claude.rs`)**: Synthetic API error `"assistant"` frames
    (`isApiErrorMessage: true` or non-null `error`) suppress duplicate
    `EventKind::Text` and synthetic zero-token `Usage` emission so only the
    terminal `Action::Finished { failed: true, message }` is recorded.
  - **Transcript Projection (`transcript.ts`)**: Historical sessions containing
    a synthetic `text` event immediately preceding `state(status: "failed")` with
    identical trimmed text deduplicate that `text` event while preserving any
    genuine partial assistant prose streamed earlier in the turn.
- **Zero-Border Stream Row (`TurnErrorRow.tsx`)**:
  - **No Tinted Card or Colored Border**: Renders as a pure borderless stream row
    (`.turn-error-toggle`: `min-height: 28px; padding: 2px 6px; margin-left: -6px;
    border-radius: 8px`) sharing the exact `0px` icon / `22px` label axis and
    `--color-hover` feedback of `ToolRow` and `ToolGroup`.
  - **Collapsed Single-Line Anatomy**: `14px` `CircleAlert` (`--color-warning`
    for `429`/`529` rate-limit or overload; `--color-danger` for auth, upstream,
    context, and general failures) + concise parsed title (`--color-text`,
    `font-weight: 500`) + single-line human detail (`--color-text-muted`,
    stripping raw `[1302]` numeric codes and `[trace_id]` / `[req_...]` tokens)
    + `13px` rotating `ChevronRight`.
  - **Single Contextual Recovery Button (`size="xs"`, `variant="subtle"`)**:
    Rendered on the right **only** on the latest halted turn (`模型设置` for
    `401`/`403` auth/quota failures; `继续` when tools, approvals, or prose
    already ran in the turn; `重试` when zero progress ran before failure;
    omitted for context-window overflow or once retired by a newer turn), using
    `preserveDraft: true` so unsent Composer drafts are never cleared.
  - **Row-Edge Flush Neutral Raw Drawer**: Clicking the row in either active or
    historical turns expands `.activity-output` (`margin: 5px 0 12px`) flush with
    the `0px` row start, housing a neutral `.activity-well.turn-error-well` (`<pre>`
    full raw error message + `复制` / `已复制` ghost micro-button).

---

## 7. Timeline Navigation, Feed Auto-Load & Rich Markdown Composer

### 12-Turn Paginated `TurnNavigator` & Feed Upward Auto-Loading

- **`TurnNavigator` (`TURN_PAGE_SIZE = 12`)**:
  - Anchored along the left conversation gutter (`width: 28px`), rendering up to
    **12** compact horizontal turn bars (`6px` resting, `16px` hover, `24px` solid
    `--color-text` for `aria-current="location"`).
  - When a session exceeds 12 turns (or `hasEarlierHistory` on host), renders `^`
    (`上一页对话轮次`) and `v` (`下一页对话轮次`) pagination buttons that page the
    12-bar preview window (fetching earlier turns on demand with `LoaderCircle`)
    without jumping the user's scroll viewport until a bar is clicked.
  - Hovering or focusing any bar opens `.turn-navigator-preview` (`max-width:
    360px`) showing a 2-line prompt excerpt, 3-line reply excerpt, and turn status.
- **Feed-Style Upward Scroll Auto-Loading**:
  - Scrolling or wheeling upward within `max(320px, 65% viewport)` of the top
    automatically prefetches the previous page of turns (initial server window:
    12 turns) and chains loads if a page is shorter than the viewport, preserving
    scroll anchor position without rendering a permanent `"加载之前的记录"` button
    (which appears only as a manual fallback if auto-loading stalls or errors).
- **Centered `28px` Floating Status Pills**:
  - `.agent-session-opening` (`••• 正在打开`) and `.return-latest` (`回到最新`) sit
    centered in `.composer-context` with `display: inline-flex; align-items:
    center; height: 28px; padding: 0 10px; line-height: 1` and zero vertical
    baseline drift.

### Rich WYSIWYG Markdown Composer & Ultra-Compact `@` / `/` Menus

- **Rich Markdown Composer (`ComposerRichInput` + `composerMarkdown.ts`)**:
  - Live WYSIWYG editing inside `.composer` (`12px` double-bezel container) with
    lossless Markdown serialization:
    - **Lists**: Ordered (`1. `), unordered (`- `), and task lists (`- [ ] `);
      `Shift+Enter` splits and auto-numbers the next list item (`2. `), `Enter`
      on an empty item exits the list, and `Enter` on non-empty content submits
      the prompt.
    - **Inline Link Pills (`.composer-link-pill`)**: Markdown links `[文档](https://...)`
      render as compact atomic inline pills with a `Globe` icon + label (`🌐 文档`).
    - **Inline Command & Skill Pills (`.composer-command-pill`)**: Completed
      slash commands and skills (`/doc-coauthoring`, `/compact`, `/agents`,
      `/model`, `/effort`, `/side`) render as borderless sky-blue atomic inline
      tokens (`14px` semantic command/skill SVG icon + bare command/skill `name`
      without leading `/`), while serializing losslessly back to `/name` on
      submit or copy.
    - **GFM Tables & Code Blocks**: Live bordered Markdown tables (`th` in
      `--color-well`) and fenced `.composer-md-codeblock` blocks displaying their
      `data-language` label in the top-left header strip.
    - **Inline `@` Reference Chips (`.composer-inline-reference`)**: Atomic
      file/directory/image chips interleaved seamlessly with prose and Markdown
      blocks.
- **Ultra-Compact `28px` `@` Reference & `/` Command Menus (`.composer-menu`)**:
  - **High-Density Chrome-Free List**: `10px` elevated popover (`padding: 4px`,
    `gap: 1px`, zero horizontal row dividers, zero redundant top title bar or
    bottom keybinding footer). Every `.composer-menu-option` is locked to a single
    `28px` row (`padding: 0 8px`, `border-radius: 6px`):
    - `@` menu: `14px` file/folder icon + primary filename/dirname + muted
      relative parent directory (`small`), with a subtle right chevron on folders
      and an inline `28px` `.composer-menu-search` input at the top.
    - `/` menu: `14px` command/skill icon + bare command/skill `name` (without
      leading `/`) + muted single-line description (`small`).
  - **Keyboard Navigation Contract**:
    - `ArrowUp` / `ArrowDown`: Roving highlight across `.composer-menu-option`s.
    - `Tab`: On a directory (`@dir`), drills into `@dir/` to browse its children
      in-place; on a file or `/` command, completes the token.
    - `Enter`: Immediately selects and attaches the highlighted file, directory
      chip, or slash command.
    - `Escape`: Dismisses the menu while preserving typed text.
