# Accessibility Specification (A11y Spec)

This document outlines the accessibility specifications for the `vs-code-ai-helper` extension views and settings webviews, conforming to the WCAG AA minimum standards.

## Theme & Color Tokens
- The extension UI integrates directly with VS Code's native theme colors (tokens) to ensure high-contrast mode compliance and seamless support for light/dark themes.
- CSS classes use VS Code theme variables (`var(--vscode-editor-foreground)`, `var(--vscode-focusBorder)`, etc.) rather than hardcoded colors.
- Focus borders use `var(--vscode-focusBorder)` to provide a consistent, visible focus indicator.

## Typography
- Default font family leverages VS Code's system stack (`var(--vscode-font-family)` or system-ui).
- Base font size is `13px` / `1rem` conforming to standard VS Code typography settings. Line height is kept at `1.4` to ensure reading comfort.

## Keyboard Interaction
- All interactive controls (buttons, select dropdowns, checkboxes) must be focusable via `Tab`.
- Focused elements display a high-contrast focus outline.
- Action buttons are triggerable using the `Enter` or `Space` key.
- Custom dropdown widgets (if any) support arrow keys for item selection, and `Escape` to close.

## Screen Reader Support (ARIA)
- Webviews use landmark elements (`<header>`, `<main>`, `<section>`).
- Controls have explicit accessible names (e.g. `aria-label` or `<label>`).
- Live status changes (such as loading states) use `aria-live="polite"` or `role="status"` to announce background progress dynamically.
- Status icons (circle for active task, pause indicator, checkmark) use descriptive `aria-label` texts and appropriate alt-texts.

## Reduced Motion
- All animations, transitions, and loading spinners respect the user's operating system settings (`prefers-reduced-motion: reduce`).
- Spinners and transition effects collapse to static/stepped states when reduced motion is requested.
