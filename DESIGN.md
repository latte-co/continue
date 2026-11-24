# Latte Work Design System (`DESIGN.md`)

This document is the authoritative visual, geometric, optical-surface, and
component contract for the Latte Work desktop client (`apps/desktop/`).

**Core rule — Component-First, Token-First:** Every new or refactored page,
workspace pane, toolbar, dialog, popover, or settings view **must** compose
primitives from `apps/desktop/src/ui/` and tokens from
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
| `ui/Stage.tsx` | `StageIsland`, `Topbar`, `Subbar`, `SplitHandle` | Right-hand `12px` single stage island (`overflow: clip; isolation: isolate`), `44px` primary topbars, `38px` secondary toolbars, and `1px` orthogonal pane splits. |
| `ui/Layout.tsx` | `PageContainer`, `PageHeader`, `Section`, `SectionHeader`, `FilterBar` | Centered page rhythm (`680px` standard / `960px` wide), page title + description + primary CTA, grouped section headers (`icon + title + host + count`), and height-locked horizontal search/filter bars (provides `ControlSizeContext` `"md"`). |
| `ui/Button.tsx` | `Button`, `IconButton` | All action triggers (`primary`, `elevated`, `subtle`, `ghost`, `danger` across `lg:36`, `md:32`, `sm:28`, `xs:24`), with `busy` spinner, `leading`/`trailing` icons, and `fullWidth` support. |
| `ui/Select.tsx` | `Select` | Application-owned dark/light-aware combobox (`size="lg" \| "md" \| "sm"`, `variant="well" \| "ghost"`, `leading` icon, `searchable`, `menuTitle`, full keyboard + IME safety). Re-exported by `src/Select.tsx`. |
| `ui/Form.tsx` | `Field`, `TextInput`, `InputGroup`, `TextArea`, `SearchInput`, `Switch`, `Checkbox`, `Slider`, `ColorField`, `ChoiceGroup` | Size-locked inputs (`lg:36`, `md:32`, `sm:28`), input + trailing button groups, monospace ENV/code textareas, clearable search inputs, accessible `role="switch"` toggles, optical `Checkbox`, tabular range sliders, `#RRGGBB` color fields, and `role="radiogroup"` choice pills/cards. |
| `ui/Surface.tsx` | `Card`, `CardHeader`, `CardFooter`, `CardList`, `Disclosure`, `Well`, `FloatingPill` | `10px` optical cards, dirty-state save footers, `1px` hairline-divided grouped record lists (`CardList`), `<details>` accordions (`Disclosure`), recessed `8px` slots (`Well`), and `28px` frosted pills (`FloatingPill`). |
| `ui/ListRow.tsx` | `ItemRow`, `SettingRow`, `NavRow` | Compact `46–54px` structured record rows (`ItemRow` for Archived Chats, SSH hosts, Providers), two-column preference rows (`SettingRow`, provides `ControlSizeContext` `"md"`), and matte borderless 2-axis sidebar/nav rows (`NavRow`). |
| `ui/Segmented.tsx` | `Segmented` | Mode switchers (`Unified / Split`, `源码 / 预览`, theme mode) with `10px` recessed track and `8px` elevated active thumb. |
| `ui/Tabs.tsx` | `Tabs` | Category tab strips (`role="tablist"` with roving arrow-key focus and optional item counts, e.g. Skills scope tabs). |
| `ui/Table.tsx` | `DataTable` | `10px` framed compact data tables with muted headers, `1px` hairline dividers, and tabular numerals (e.g. Provider model catalog). |
| `ui/Overlay.tsx` | `Popover`, `MenuTitle`, `MenuRow`, `MenuSeparator`, `Dialog` | Viewport-clamped `10px` frosted menus and standardized `14px` modal dialogs (`sm:380`, `md:480`, `lg:600`) atop `Modal.tsx`'s nested `inert` focus containment stack. |
| `ui/Feedback.tsx` | `StatusSignal`, `Badge`, `NoticeBanner`, `EmptyState`, `Kbd`, `DiffStat`, `StateBlock` | 5-state semantic status signals, `5px` micro badges/keycaps, inline alert/status banners (`NoticeBanner`), calm `10px` zero-data blocks (`EmptyState`), and tabular `+add / -del` stats. |

---

## 2. Spatial Window Topology & Concentric Geometry

### Multi-Plane Spatial Hierarchy

1. **`L1` Window Shell & Sidebar (`--color-shell` / `--color-sidebar`)**: Outer
   ambient shell (`#0E0E0E` in default dark, `#EFEFEF` in default light) with
   optional macOS vibrancy (`backdrop-filter: blur(28px)`).
2. **`L2` Clipped Single Stage Island (`StageIsland`, `--color-canvas`)**: Houses
   both the primary reading/settings canvas and the collapsible right workspace
   inside **one** `12px` rounded container (`7px` inset) with `overflow: clip;
   isolation: isolate` and crisp perimeter elevation (`--shadow-island`).
3. **`L2b` Auxiliary Workspace Tint (`--workspace-bg`)**: Non-expanded right
   workspace panes use a subtle recessed mix (`78% canvas + 22% shell`) separated
   from the focal conversation stage by a straight `1px` orthogonal `SplitHandle`.
4. **`L3` Optical Cards & Double-Bezel Composer (`--color-card` / `--color-composer`)**:
   Grouped cards (`10px`) and the elevated input cockpit (`12px`).

### Concentric Corner Radius Ladder (`R_outer = R_inner + padding`)

| Token | Value | Scope |
| --- | --- | --- |
| `--radius-window` | `16px` | Native macOS window frame |
| `--radius-dialog` | `14px` | Modal dialogs (`Dialog`) |
| `--radius-island` | `12px` | `StageIsland`, collapsed sidebar preview, `Composer`, user message bubble |
| `--radius-card` / `--radius-track` | `10px` | `Card`, `CardList`, `DataTable`, `EmptyState`, `ApprovalCard`, `Popover`, `Segmented` track |
| `--radius-control` | `8px` | **All** buttons, icon buttons, inputs, `SearchInput`, `Select`, `NoticeBanner`, `NavRow`, `MenuRow`, workspace tabs, segmented thumbs |
| `--radius-badge` | `5px` | `<Kbd>`, `<Badge>`, inline `<code>`, tool status tags |
| `--radius-pill` | `999px` | Reserved strictly for `Switch` tracks, status dots, and `FloatingPill` anchors |

Do not introduce arbitrary intermediate radii (`3px`, `6px`, `18px`, `20px`, `24px`, `50%` action buttons).

---

## 3. Control Heights, Horizontal Bar Lock & Typography

### Four-Tier Control Height Matrix (Strict Horizontal Alignment Rule)

Controls placed side-by-side in the same horizontal bar **must** use the exact
same `size` token so heights, text baselines, and `8px` corner radii align to
the subpixel:

| Size Token | CSS Variable | Height | Mandatory Scope |
| --- | --- | --- | --- |
| `lg` | `--control-height-lg` | `36px` | Standalone vertical form fields inside `Dialog`s and `Card` forms (`Field` + `TextInput size="lg"` / `Select size="lg"`). |
| `md` | `--control-height-md` | `32px` | **Default** for `FilterBar` (`SearchInput size="md"` + `Select size="md"` + `Button size="md"`), `SettingRow` controls, `NavRow`, `MenuRow`, and dialog footer CTAs. |
| `sm` | `--control-height-sm` | `28px` | Compact `Topbar` / `Subbar` / `Composer` toolbar controls, `IconButton` hit targets (`28×28px`), and inline row actions inside `ItemRow` (`取消归档`, `编辑`). |
| `xs` | `--control-height-xs` | `24px` | Dense inline micro actions and compact `Segmented` items. |

Never bake outer `margin-top` onto individual form controls (`TextInput`,
`SearchInput`, `Select`); parent layout containers (`Field`, `FilterBar`,
`InputGroup`, `SettingRow`) own all inter-element spacing.

### Typography & Optical Icon Grid

- **5-Step Type Scale**: `11px` (`--text-xs` micro metadata/badges) · `12px`
  (`--text-sm` labels/toolbars/code/descriptions) · `13px` (`--text-md` default UI,
  lists, tool rows) · `14px` (`--text-lg` Markdown prose & composer) · `18px`
  (`--text-heading` page titles).
- **Tabular Numerals**: Apply `font-variant-numeric: tabular-nums` to all counts,
  durations, slider readouts, token metrics, line numbers, and `+add / -del` stats.
- **Icons**: Lucide icons at `15px–16px` (`13.5px–14px` for auxiliary chevrons,
  search icons, and tool stream icons) with `stroke-width: 1.6`.

---

## 4. Page & View Composition Recipes (Anti-Bloat Rules)

To keep every page visually calm, dense, and cohesive:

1. **Settings & Management Page Skeleton**:
   Compose `<PageContainer>` → `<PageHeader title="..." description="..." actions={...} />`
   → optional `<FilterBar>` (`SearchInput` + `Select` + `IconButton`/`Button` all
   at `size="md"`) → `<NoticeBanner>` (when error/status is present) → grouped
   `<Section>`s.
2. **Grouped `CardList` + `ItemRow` Over Per-Item Boulder Cards**:
   Never render a list of records (Archived Chats, SSH Hosts, Providers,
   Directory entries) as separate `padding: 20px` cards with gaps between every
   item. Instead, group related records inside **one** `10px` `<CardList>` and
   render each record as a compact `46–54px` `<ItemRow>` (`12px 16px` padding)
   separated by `1px` `--color-border-subtle` hairlines, with `size="sm"` subtle
   or ghost action buttons on the right.
3. **Preference Rows (`SettingRow`)**:
   Group related settings inside a `<CardList>` of `<SettingRow label="..." description="...">`
   items rather than scattering standalone labels and inputs down the page.
4. **Card Forms with Dirty-State Save Footers**:
   When a card contains editable fields (`AgentSettings`, `ProviderSettings`),
   place fields inside `<Card>` body and put the status note + `<Button variant="primary">`
   inside `<CardFooter>` rather than reusing `.modal-actions`.
5. **Progressive Disclosure (`Disclosure`)**:
   Tuck secondary setup guides, diagnostics (`Server 实例`), and manual overrides
   (`高级设置`, `输入文件夹路径`) inside `<Disclosure title="...">` rather than
   permanently expanding multi-paragraph instructions inline.

---

## 5. Perceptual OKLCH Palette, Optical Surfaces & Signals

- **OKLCH Derivation (`appearance.ts`)**: Interpolates surfaces in OKLab/OKLCH
  perceptual lightness while serializing `--color-*` tokens to `#RRGGBB` /
  `#RRGGBBAA` for `Appearance` JSON `version: 1` compatibility, enforcing WCAG AA
  `>= 4.5:1` text contrast across every surface (`canvas`, `sidebar`, `surface`,
  `elevated`, `input`, `composer`).
- **Three Optical Surface Tiers**:
  1. `Well` (`--color-well` + `--shadow-well`): `8px` recessed `1px` inner hairline for inputs, selects, code wells, and `Segmented` tracks.
  2. `Card` (`--color-card` + `--shadow-card`): `10px` grouped surface with `1px` optical perimeter ring, top inner bevel, and soft ambient lift.
  3. `Elevated` (`--color-elevated` + `--shadow-elevated`): `8px` active segmented thumbs, active tabs, and raised controls.
- **Five-State Semantic Signal Grammar (`StatusSignal`)**:
  - `running`: 3-dot emerald pulse (`•••`)
  - `waiting`: Amber `CirclePause` (`13.5px`)
  - `unread`: `6px` sky-blue solid dot
  - `failed`: Coral-red `CircleAlert` (`13.5px`)
  - `unknown`: Muted `CircleHelp` (`13.5px`) — **Safety invariant:** never infer
    completion or success after a transport/daemon interruption; preserve
    `unknown` (`状态待确认`) until reconciled.
  - `idle`: **Visual silence** (render nothing).

---

## 6. Sidebar Calm Density, Vertical-Line Governance & Session Stream

- **Sidebar Calm Density**: Zero colored rectangular badges on sidebar rows;
  strict 2-axis left alignment (`flat` vs `child` `32px` flush under parent
  project name); single right-edge `StatusSignal` swapped with hover actions.
- **Global Vertical-Line Whitelist (`No Scaffold Rails for Depth <= 2`)**:
  Never draw vertical indent guide lines in the Sidebar (`项目 → 会话`) or
  Session Process Stream (`阶段簇 → 工具行 → 展开卡`). Vertical bars are allowed
  only for: ① `2.5px` +/- bars inside inline code diffs, ② `2px` Markdown/SideChat
  blockquotes, and ③ `WorkspaceFiles` directory trees at depth `>= 3`.
- **Session & Tool Stream**: Natural verb-phrase phase clusters (`探索了文件并运行命令`),
  `14px` monochrome icons + `13px` two-tone verb/target typography, failure tint
  scoped strictly to the icon and trailing `失败` badge (never whole-row red text),
  and semantic `1px` hairline detail wells (terminal `$ command` + stdout,
  line-numbered inline diff, path-headed file excerpt) instead of raw JSON dumps.
