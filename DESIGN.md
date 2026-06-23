# Stationary Design System Spec (DESIGN.md)

This document establishes the UI/UX design system for the **Stationary** web application, drawing inspiration from Apple's spatial layers, Linear's high-density desktop-class refinement, and shadcn/ui's clean structural details.

---

## 1. Spatial Layout System: Card-on-Canvas

Rather than flat, full-bleed screen splits with border lines touching the viewport edges, we utilize a **Card-on-Canvas** hierarchy to introduce depth, focus, and a desktop-application feel.

```
+-------------------------------------------------------------+
| Canvas (Cool neutral slate-gray backdrop: bg-[#f9fafb] / p-6)|
|                                                             |
|  +---------------------------+  +------------------------+  |
|  | Left Card: Tag List       |  | Right Card: Inspector  |  |
|  |                           |  |                        |  |
|  | - bg-white                |  | - bg-white             |  |
|  | - rounded-2xl             |  | - rounded-2xl          |  |
|  | - shadow-[0_1px_2px_rgba(0,0,0,0.02)]                 |  |
|  | - border border-zinc-100  |  | - border border-zinc-100| |
|  |                           |  |                        |  |
|  +---------------------------+  +------------------------+  |
+-------------------------------------------------------------+
```

* **The Canvas (`bg-[#f9fafb]`)**: The baseline background. Provides a cool, crisp backdrop that makes active workspaces float.
* **Floating Cards (`bg-white rounded-2xl shadow-[0_1px_2px_rgba(0,0,0,0.02)] border border-zinc-100/80`)**: Individual interactive compartments that group related actions. They feature generous border radii (`1rem` / `rounded-2xl`) and soft shadow definitions.
* **Layout Padding**: The canvas uses a consistent `p-6` layout padding, separating the workspace from sidebar elements with breathing room.

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
