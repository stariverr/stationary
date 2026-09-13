# Stationary Design System Spec (DESIGN.md)

This document establishes the UI/UX design system for the **Stationary** web application, drawing inspiration from Apple's spatial layers, Linear's high-density desktop-class refinement, and shadcn/ui's clean structural details.

---

## 1. Spatial Layout System: Seamless Split-Pane Layout

Rather than floating "cards on a gray canvas" separated by gaps and nested card radiuses, the application utilizes a **Seamless Split-Pane Layout** inspired by modern desktop-grade creative suites (such as Lightroom, Linear, and macOS native utilities). Workspaces seamlessly dock against the sidebar and topbar, maximizing screen real estate and providing a clean, edge-to-edge layout.

```
+------------------+----------------------------------------------------------+
| LeftSidebar      | Workspace View (Full-Bleed, Edge-to-Edge)                |
| (w-64 / border-r)| +------------------------------------------------------+ |
|                  | | Docked Header (h-14 px-4 md:px-6 border-b bg-white)  | |
|                  | +------------------------------------------------------+ |
|                  | | Filter & View Bar (h-12 border-b bg-white)          | |
|                  | +------------------------------------+-----------------+ |
|                  | | Main Content Grid / Table / Stream | Docked Inspector| |
|                  | | (flex-1 bg-white overflow-y-auto)  | (border-l)      | |
|                  | |                                    |                 | |
|                  | +------------------------------------+-----------------+ |
|                  | | Docked Footer / Status (h-12 border-t bg-white)      | |
|                  | +------------------------------------------------------+ |
+------------------+----------------------------------------------------------+
```

* **Full-Bleed Workspace Container (`flex-1 flex flex-col min-h-0 min-w-0 bg-white relative overflow-hidden`)**: Eliminates the outer canvas padding (`p-4` / `p-6` and `#f9fafb`) and double card borders. The workspace cleanly connects with adjacent panes.
* **Unified Docked Headers (`h-14 px-4 md:px-6 border-b border-zinc-200/80 bg-white`)**: Standardized 56px height across Media, Posts, Tags, Drafts, Trash, and Jobs, aligning title, search inputs, and primary action buttons.
* **Seamless Split-Pane Panes (`border-l border-zinc-200/80 bg-white`)**: Secondary panels (such as Tag Inspector or Media Details) dock directly to the right border of the view rather than floating as separated cards.
* **Micro-Interactions & A11y**:
  - Interactive elements feature tactile feedback with `active:scale-[0.96]` and standard focus rings `focus-visible:ring-2 focus-visible:ring-zinc-950`.
  - Telemetry badges and counters utilize `tabular-nums` to eliminate jitter during value changes.
  - Dropdowns, toggles, and buttons provide explicit semantic `<label>` associations and `aria-label` tags.

---

## 2. Color Palette & Border Details

To remove any "AI-generated / boilerplate" feel, we transition to a softer, cool-zinc palette.

* **Primary Backgrounds**: `bg-white` (card faces), `bg-[#f9fafb]` (canvas backdrop).
* **Dividers & Borders**: Faint, non-distracting lines (`border-zinc-100` / `border-zinc-200/40`).
* **Text Contrast**:
  - Headings: `text-zinc-800 font-semibold tracking-tight` (softer than pure black).
  - Body / Dynamic Values: `text-zinc-600` for readable, premium typography.
  - Subtext: `text-zinc-400 font-medium`.
* **Accent Colors**: Clean HSL palettes.

---

## 3. Minimalist Tab Bar (Linear / Vercel style)

We avoid chunky rounded-border outlines around active tabs, which look unrefined. Instead, we use custom text buttons with a sleek bottom indicator line:

* **Tab Bar**: A clean navigation strip with `border-b border-zinc-100 bg-[#fbfbfb] px-6 gap-6 h-12`.
* **Tab Trigger**: A text button with `text-xs font-bold uppercase tracking-wider text-zinc-400 hover:text-zinc-700 transition-colors`.
* **Active State**: The text transitions to `text-zinc-900`, accompanied by a thin `h-[2px] bg-zinc-800 rounded-full` indicator line aligned at the bottom boundary.

---

## 4. The Pill-Tag Component

A tag is a lightweight metadata container. It should not look like a hard rectangular block or a raw string prefix. We represent tags as **Pill Badges**.

* **Tag Pill Anatomy**:
  - Shape: `rounded-full` (capsule style).
  - Background: Dynamic HSL light background with a matching color value at `6%` opacity (`bg-[color]/6`).
  - Text: High contrast color matching the tag's color accent.
  - Border: Soft colored border matching at `20%` opacity (`border-[color]/20`).
  - Neutral / Default State: Cool zinc styling (`bg-zinc-50 border-zinc-200 text-zinc-600`) to avoid dry monochrome blocks.

---

## 5. High-Density Refined Tables

Instead of generic grid cards or dry spreadsheet tables, the tag table is styled as a **refined settings index**:

* **Headers**: Compact, uppercase headers styled with `tracking-wider text-[10px] text-zinc-400 bg-zinc-50/40 border-b border-zinc-100`.
* **Rows**:
  - Spacing: Standardized vertical heights with clean margins (`py-3`).
  - Selected State: A glowing background transition (`bg-indigo-50/20`) with a left border highlight to represent active focus.
  - Borders: Thin, soft grey borders (`border-b border-zinc-100`).
* **Icons**: Standardized sizes (`w-4 h-4`) using low-contrast opacity (`text-zinc-300` or `text-zinc-400`) that light up on hover.

---

## 6. Left Sidebar Architecture & Navigation

* **Unified `h-14` Docked Header**:
  - The sidebar header matches the exact `h-14` (56px) height of the main workspace headers with a bottom dividing border (`border-b border-zinc-200/80`). This produces a seamless, continuous horizontal baseline across the entire viewport.
  - Houses the `LibrarySwitcher` (with clean `hover:bg-zinc-100`) and the desktop collapse trigger (`⌘B`).
* **Spacious Creation Action Bar**:
  - Full-width stacked buttons with comfortable breathing room (`px-3.5 pt-4 pb-2 flex flex-col gap-2`).
  - Primary button (New Post) in high-contrast solid zinc (`h-9 bg-zinc-900 hover:bg-zinc-800 text-white font-medium text-sm shadow-xs rounded-lg`) alongside secondary button (Upload Media) in crisp bordered white (`h-9 border border-zinc-200/90 bg-white hover:bg-zinc-50 text-zinc-700 hover:text-zinc-900 font-medium text-sm shadow-xs rounded-lg`).
* **Elevated White Card Active Navigation & Clean Hover**:
  - Replaces muddy grey backgrounds with a pristine elevated active tile (`bg-white text-zinc-950 font-semibold shadow-xs border border-zinc-200/80`).
  - Inactive items feature gentle, whisper-light hover states (`hover:bg-zinc-100 hover:text-zinc-900 text-zinc-600`) and optical icon states (`text-zinc-400 group-hover:text-zinc-700` inactive, `text-zinc-950` active).
  - Comfortable navigation typography at `text-sm font-medium` (14px) with generous hit areas (`px-3 py-2 rounded-lg`) and balanced icons (`w-4.5 h-4.5`).
  - Notification and draft badges use rounded pill tags with `tabular-nums` and balanced contrast (`bg-zinc-200/70 text-zinc-600` inactive, `bg-zinc-900 text-white` active).
* **Sidebar Toggle Ergonomics**:
  - Global `⌘B` / `Ctrl+B` toggle shortcut (safely bypassing input fields and textareas).
  - Main workspace headers hide the toggle trigger when the sidebar is already expanded on desktop, preventing redundant buttons.
