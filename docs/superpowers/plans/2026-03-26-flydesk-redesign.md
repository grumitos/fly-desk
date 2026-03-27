# Fly Desk Integral Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the entire Fly Desk frontend (CSS + HTML + JS) as a unified operational surface with consistent design tokens, compact search bar, flexible search mode, master-detail layout, and integrated calendar/list views.

**Architecture:** Three-file frontend rewrite. CSS rewritten from scratch with token system. HTML restructured into semantic layout regions (header, search-bar, sidebar, content, detail-panel). JS rendering functions updated to produce new markup while preserving all business logic, state management, API calls, and event patterns.

**Tech Stack:** Vanilla HTML5/CSS3/JS. No frameworks. No build step for frontend. Backend TypeScript unchanged.

**Spec:** `docs/superpowers/specs/2026-03-26-flydesk-redesign-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `public/app.css` | **Full rewrite** | Design tokens, layout, all component styles, animations, responsive |
| `public/index.html` | **Major restructure** | Semantic layout regions, new search bar, pax popover, updated section containers |
| `public/app.js` | **Update renders + new components** | All render functions rewritten, new pax popover logic, flexible mode translation, calendar view integration. Business logic/state/API preserved. |

---

## Task 1: CSS Design System — Tokens & Base

**Files:**
- Rewrite: `public/app.css` (lines 1-100 of new file)

- [ ] **Step 1: Write CSS tokens and reset**

Replace the entire `:root` block and base styles with the new design system. Write the following to the top of `public/app.css`:

```css
/* ==========================================================================
   Fly Desk — Design System v2
   ==========================================================================
   1. TOKENS        2. RESET & BASE     3. LAYOUT
   4. COMPONENTS     5. SEARCH BAR       6. RESULTS
   7. CALENDAR       8. DETAIL PANEL     9. COMPARE
   10. SIDEBAR       11. STATES          12. ANIMATIONS
   13. SCROLLBAR     14. RESPONSIVE
   ========================================================================== */

/* === 1. TOKENS === */
:root {
  /* Backgrounds — elevation scale */
  --bg-base:      #0d1117;
  --bg-raised:    #161b22;
  --bg-surface:   #1c2129;
  --bg-overlay:   #21262d;
  --bg-hover:     #262c36;
  --bg-active:    #2a3140;

  /* Accent */
  --accent:       #4c9aed;
  --accent-hover: #5ba8f5;
  --accent-muted: rgba(76, 154, 237, 0.12);
  --accent-border:rgba(76, 154, 237, 0.30);

  /* Semantic */
  --success:      #3fb950;
  --success-muted:rgba(63, 185, 80, 0.10);
  --warning:      #d29922;
  --warning-muted:rgba(210, 153, 34, 0.10);
  --danger:       #f85149;
  --danger-muted: rgba(248, 81, 73, 0.08);
  --info:         #79c0ff;

  /* Text — 4 levels */
  --text-primary:   #e6edf3;
  --text-secondary: #b1bac4;
  --text-tertiary:  #6e7681;
  --text-disabled:  #3d444d;

  /* Borders — 3 levels */
  --border-default: #30363d;
  --border-subtle:  #21262d;
  --border-focus:   var(--accent);

  /* Typography */
  --font-sans:  'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --font-mono:  'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
  --text-xs:    11px;
  --text-sm:    12px;
  --text-base:  13px;
  --text-md:    15px;
  --text-lg:    20px;
  --weight-normal:  400;
  --weight-medium:  500;
  --weight-semibold:600;

  /* Spacing — 4px scale */
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px;
  --sp-4: 16px; --sp-5: 20px; --sp-6: 24px;
  --sp-8: 32px; --sp-10: 40px;

  /* Radii */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;

  /* Shadows */
  --shadow-sm:  0 1px 2px rgba(0,0,0,0.3);
  --shadow-md:  0 2px 8px rgba(0,0,0,0.3);
  --shadow-lg:  0 4px 16px rgba(0,0,0,0.4);
  --shadow-glow:0 0 0 3px var(--accent-muted);

  /* Motion */
  --duration-fast:   120ms;
  --duration-normal: 200ms;
  --duration-slow:   300ms;
  --ease-default:    cubic-bezier(0.4, 0, 0.2, 1);
  --ease-spring:     cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* === 2. RESET & BASE === */
*, *::before, *::after { box-sizing: border-box; margin: 0; }

html {
  font-family: var(--font-sans);
  font-size: var(--text-base);
  color: var(--text-secondary);
  background: var(--bg-base);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
```

- [ ] **Step 2: Verify tokens render correctly**

Start the dev server and open the page. Confirm the background color is `#0d1117` and text is readable. The page will look broken at this point because all old class names are gone — that is expected.

Run: `npm run build && npm start`

- [ ] **Step 3: Commit**

```bash
git add public/app.css
git commit -m "feat(css): rewrite design tokens and base reset for v2 redesign"
```

---

## Task 2: CSS — Layout System

**Files:**
- Modify: `public/app.css` (append after base styles)

- [ ] **Step 1: Write layout styles**

Append layout styles for header, search bar, main area (sidebar + content + detail panel):

```css
/* === 3. LAYOUT === */

.layout-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 36px;
  padding: 0 var(--sp-4);
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-subtle);
  position: sticky;
  top: 0;
  z-index: 50;
}

.layout-header__brand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.08em;
  color: var(--accent);
  user-select: none;
}

.layout-header__right {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.search-bar {
  display: flex;
  flex-direction: column;
  background: var(--bg-raised);
  border-bottom: 1px solid var(--border-default);
  position: sticky;
  top: 36px;
  z-index: 40;
}

.search-bar__main {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-4);
  min-height: 48px;
}

.search-bar__chips {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-4) var(--sp-2);
  flex-wrap: wrap;
}

.search-bar__divider {
  width: 1px;
  height: 24px;
  background: var(--border-default);
  opacity: 0.5;
  flex-shrink: 0;
}

.layout-main {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.layout-sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--bg-raised);
  border-right: 1px solid var(--border-subtle);
  overflow-y: auto;
  display: none; /* shown via JS when results exist */
}

.layout-sidebar.is-visible {
  display: block;
}

.layout-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.layout-detail {
  width: 380px;
  flex-shrink: 0;
  background: var(--bg-raised);
  border-left: 1px solid var(--border-subtle);
  overflow-y: auto;
  transform: translateX(100%);
  transition: transform var(--duration-slow) var(--ease-default);
  position: relative;
}

.layout-detail.is-open {
  transform: translateX(0);
}

/* When detail panel is closed, don't reserve space */
.layout-detail:not(.is-open) {
  width: 0;
  border: none;
  overflow: hidden;
}

.results-toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-4);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-base);
  min-height: 40px;
  flex-wrap: wrap;
}

.results-toolbar__sort {
  display: flex;
  gap: 2px;
  background: var(--bg-surface);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  overflow: hidden;
}

.results-toolbar__sort-btn {
  padding: var(--sp-1) var(--sp-3);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--text-tertiary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all var(--duration-fast) var(--ease-default);
}

.results-toolbar__sort-btn.is-active {
  background: var(--accent-muted);
  color: var(--accent);
  font-weight: var(--weight-semibold);
}

.results-toolbar__sort-btn:hover:not(.is-active) {
  color: var(--text-secondary);
  background: var(--bg-hover);
}

.results-toolbar__view {
  display: flex;
  gap: 2px;
  margin-left: auto;
}

.results-toolbar__count {
  font-size: var(--text-xs);
  color: var(--text-tertiary);
}

.results-toolbar__count strong {
  color: var(--text-primary);
}
```

- [ ] **Step 2: Commit**

```bash
git add public/app.css
git commit -m "feat(css): add layout system — header, search bar, sidebar, content, detail panel"
```

---

## Task 3: CSS — Component Library

**Files:**
- Modify: `public/app.css` (append after layout)

- [ ] **Step 1: Write core component styles**

Append all shared component styles: inputs, buttons, badges, dropdowns, toasts, tables, scrollbar, loading, empty states.

Key component patterns (write full implementations for each):

**Inputs** — 32px height default, `--bg-surface` bg, focus ring with `--shadow-glow`, error state with `--danger` border + shake.

**Buttons** — Three variants: `.btn--primary` (accent bg, white text), `.btn--secondary` (surface bg, border), `.btn--ghost` (transparent, accent text). Plus `.btn--icon` (28x28).

**Badges** — `.badge` at 22px height, pill-shaped (radius-sm), variants for accent/success/warning/danger/neutral.

**Chips** — `.chip` for search parameters. Clickable, 28px height, surface bg, editable inline.

**Dropdown/Popover** — `.dropdown` with overlay bg, shadow-md, fade+scale animation.

**Location Autocomplete** — `.autocomplete-menu` fixed position, max 6 items, keyboard navigable.

**Pax Popover** — `.pax-popover` with +/- rows for adults/children/infants.

**Table** — `.results-table` with 44px rows, sticky header, hover/active states, price right-aligned.

**Toast** — `.toast` bottom-right, slide-in, 3 semantic variants.

**Scrollbar** — Minimal 6px thumb, transparent track.

**Loading** — Inline progress bar (2px top of content), skeleton shimmer, spinner.

**Empty/Error states** — Centered message with icon + text + action button.

Complete code for all components — this is the bulk of the CSS file (~800 lines). Each component must use only the token variables defined in Task 1.

- [ ] **Step 2: Write animation keyframes**

```css
/* === 12. ANIMATIONS === */
@keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-2px)} 75%{transform:translateX(2px)} }
@keyframes slideDown { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:translateY(0)} }
@keyframes fadeIn { from{opacity:0} to{opacity:1} }
@keyframes dropIn { from{opacity:0;transform:translateY(-4px) scale(0.98)} to{opacity:1;transform:translateY(0) scale(1)} }
@keyframes shimmer { from{background-position:200% 0} to{background-position:-200% 0} }
@keyframes toastIn { from{opacity:0;transform:translateX(20px)} to{opacity:1;transform:translateX(0)} }
@keyframes spin { to{transform:rotate(360deg)} }
@keyframes spinDash { 0%{stroke-dasharray:1,200;stroke-dashoffset:0} 50%{stroke-dasharray:90,200;stroke-dashoffset:-35} 100%{stroke-dasharray:90,200;stroke-dashoffset:-125} }
```

- [ ] **Step 3: Write responsive breakpoints**

```css
/* === 14. RESPONSIVE === */
@media (max-width: 1200px) {
  .layout-detail { width: 320px; }
}

@media (max-width: 900px) {
  .layout-main { flex-direction: column; }
  .layout-sidebar { width: 100%; border-right: none; border-bottom: 1px solid var(--border-subtle); }
  .layout-detail { width: 100%; position: fixed; top: 0; right: 0; bottom: 0; z-index: 100; transform: translateX(100%); }
  .layout-detail.is-open { transform: translateX(0); }
  .search-bar__main { flex-wrap: wrap; }
  .results-table td, .results-table th { padding: var(--sp-1) var(--sp-2); }
}

@media (max-width: 600px) {
  .layout-header { padding: 0 var(--sp-3); }
  .search-bar__main { padding: var(--sp-2) var(--sp-3); }
  .search-bar__chips { padding: 0 var(--sp-3) var(--sp-2); }
}
```

- [ ] **Step 4: Commit**

```bash
git add public/app.css
git commit -m "feat(css): add full component library, animations, responsive breakpoints"
```

---

## Task 4: HTML — Restructure Layout

**Files:**
- Rewrite: `public/index.html`

- [ ] **Step 1: Rewrite HTML with new semantic structure**

Rewrite `public/index.html` with the new layout. Key changes:
- SVG sprite stays (move to end of body to declutter).
- Header: 36px, brand + status badges.
- Search bar: Single main row (trip type, origin, swap, destination, dates/flex fields, pax trigger, search button) + chips row below.
- Pax popover: Hidden popover with +/- controls.
- Main layout: sidebar + content + detail panel.
- Content: toolbar + results container (for both table and calendar).
- Detail panel: always in DOM, hidden via transform.
- Compare: section within content area.
- Toast container and loading overlay at bottom.

The complete HTML structure:

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Fly Desk</title>
  <link rel="stylesheet" href="/app.css" />
</head>
<body>

  <!-- Header -->
  <header class="layout-header">
    <div class="layout-header__brand">
      <svg class="ico ico--brand"><use href="#ico-plane"/></svg>
      FLY DESK
    </div>
    <div class="layout-header__right">
      <span id="runtimeBadge" class="badge">IDLE</span>
      <span id="resultPill" class="badge badge--accent">0</span>
    </div>
  </header>

  <!-- Search Bar -->
  <form id="searchForm" class="search-bar" novalidate autocomplete="off">
    <div class="search-bar__main">
      <!-- Trip Type -->
      <select name="tripType" id="tripType" class="input input--compact">
        <option value="round-trip">Ida/Vta</option>
        <option value="one-way">Solo ida</option>
      </select>

      <span class="search-bar__divider"></span>

      <!-- Route -->
      <div class="search-bar__route">
        <div class="location-field">
          <input name="origin" id="origin" class="input input--location" autocomplete="off"
                 spellcheck="false" placeholder="Origen" required />
          <div id="originSuggestions" class="autocomplete-menu hidden"></div>
        </div>
        <button type="button" id="swapRouteBtn" class="btn--icon" title="Intercambiar">
          <svg class="ico"><use href="#ico-swap"/></svg>
        </button>
        <div class="location-field">
          <input name="destination" id="destination" class="input input--location" autocomplete="off"
                 spellcheck="false" placeholder="Destino" required />
          <div id="destinationSuggestions" class="autocomplete-menu hidden"></div>
        </div>
      </div>

      <span class="search-bar__divider"></span>

      <!-- Dates: exact mode -->
      <div class="search-bar__dates" id="datesExact">
        <input name="departureDate" id="departureDate" type="date" class="input input--date" required />
        <input name="returnDate" id="returnDate" type="date" class="input input--date roundtrip-only" />
      </div>

      <!-- Dates: flexible mode -->
      <div class="search-bar__dates search-bar__flex-dates hidden" id="datesFlex">
        <div class="flex-duration">
          <input name="stayDaysMin" id="stayDaysMin" type="number" class="input input--mini" min="1" max="90" placeholder="7" />
          <span class="flex-duration__sep">-</span>
          <input name="stayDaysMax" id="stayDaysMax" type="number" class="input input--mini" min="1" max="90" placeholder="14" />
          <span class="flex-duration__label">dias</span>
        </div>
        <span class="search-bar__divider"></span>
        <div class="flex-window">
          <input name="departureStart" id="departureStart" type="date" class="input input--date" />
          <span class="flex-window__sep">~</span>
          <input name="departureEnd" id="departureEnd" type="date" class="input input--date" />
        </div>
      </div>

      <span class="search-bar__divider"></span>

      <!-- Pax trigger -->
      <button type="button" id="paxTrigger" class="chip chip--interactive">
        <span id="paxLabel">1 ADT</span>
        <svg class="ico ico--xs"><use href="#ico-chevron-down"/></svg>
      </button>

      <!-- Hidden pax inputs (values used by form) -->
      <input name="adults" id="adults" type="hidden" value="1" />
      <input name="children" id="children" type="hidden" value="0" />
      <input name="infants" id="infants" type="hidden" value="0" />

      <!-- Search button -->
      <button id="submitButton" class="btn btn--primary" type="submit">
        <svg class="ico ico--btn"><use href="#ico-search"/></svg>
        BUSCAR
      </button>
    </div>

    <!-- Pax Popover -->
    <div id="paxPopover" class="pax-popover hidden">
      <div class="pax-popover__row">
        <span class="pax-popover__label">Adultos</span>
        <div class="pax-popover__controls">
          <button type="button" class="btn--icon" data-pax-action="adults-dec">-</button>
          <span id="paxAdultsDisplay" class="pax-popover__value">1</span>
          <button type="button" class="btn--icon" data-pax-action="adults-inc">+</button>
        </div>
      </div>
      <div class="pax-popover__row">
        <span class="pax-popover__label">Ninos <span class="text-dim">(2-11)</span></span>
        <div class="pax-popover__controls">
          <button type="button" class="btn--icon" data-pax-action="children-dec">-</button>
          <span id="paxChildrenDisplay" class="pax-popover__value">0</span>
          <button type="button" class="btn--icon" data-pax-action="children-inc">+</button>
        </div>
      </div>
      <div class="pax-popover__row">
        <span class="pax-popover__label">Bebes <span class="text-dim">(&lt;2)</span></span>
        <div class="pax-popover__controls">
          <button type="button" class="btn--icon" data-pax-action="infants-dec">-</button>
          <span id="paxInfantsDisplay" class="pax-popover__value">0</span>
          <button type="button" class="btn--icon" data-pax-action="infants-inc">+</button>
        </div>
      </div>
    </div>

    <!-- Chips row: secondary parameters -->
    <div class="search-bar__chips">
      <select name="cabin" id="cabin" class="chip chip--select">
        <option value="ECONOMY">Economy</option>
        <option value="PREMIUM_ECONOMY">Prem Eco</option>
        <option value="BUSINESS">Business</option>
        <option value="FIRST">First</option>
      </select>
      <div class="chip chip--input">
        <input name="currencyCode" id="currencyCode" class="chip__input" maxlength="3" value="USD" />
      </div>
      <label class="chip chip--toggle">
        <input name="nonStop" id="nonStop" type="checkbox" />
        <span>Directos</span>
      </label>
      <label class="chip chip--toggle">
        <input name="baggageRequired" id="baggageRequired" type="checkbox" />
        <span>Equipaje</span>
      </label>

      <!-- Mode toggle: Exacto | Flexible -->
      <div class="chip-group chip-group--mode">
        <button type="button" class="chip chip--mode is-active" data-mode="exact">Exacto</button>
        <button type="button" class="chip chip--mode" data-mode="flexible">Flexible</button>
      </div>

      <!-- Hidden select for backend compat — JS keeps this in sync -->
      <select name="searchMode" id="searchMode" class="hidden">
        <option value="exact">Exacto</option>
        <option value="stay-range">Rango</option>
        <option value="roundtrip-grid">Matriz</option>
      </select>

      <!-- Extra filters (visible on demand) -->
      <div class="chip chip--input">
        <span class="chip__label">Max $</span>
        <input name="maxPrice" id="maxPrice" type="number" class="chip__input" min="0" placeholder="—" />
      </div>
      <div class="chip chip--input">
        <span class="chip__label">Esc</span>
        <input name="maxStops" id="maxStops" type="number" class="chip__input chip__input--narrow" min="0" max="3" placeholder="—" />
      </div>
      <select name="sortMode" id="sortMode" class="hidden">
        <option value="cheapest">Precio</option>
        <option value="best-value">Valor</option>
        <option value="fastest">Rapido</option>
      </select>
    </div>
  </form>

  <!-- Validation/Error bar -->
  <div id="validationErrors" class="error-bar hidden"></div>

  <!-- Main layout -->
  <div class="layout-main">
    <!-- Sidebar -->
    <aside id="sidebar" class="layout-sidebar"></aside>

    <!-- Content -->
    <main class="layout-content">
      <!-- Results toolbar -->
      <div id="resultsToolbar" class="results-toolbar hidden">
        <div class="results-toolbar__sort" id="sortButtons">
          <button type="button" class="results-toolbar__sort-btn is-active" data-sort="cheapest">Precio</button>
          <button type="button" class="results-toolbar__sort-btn" data-sort="fastest">Duracion</button>
          <button type="button" class="results-toolbar__sort-btn" data-sort="best-value">Mejor valor</button>
        </div>
        <span class="results-toolbar__count" id="resultsCountLabel"></span>
        <div class="results-toolbar__view" id="viewToggle">
          <button type="button" class="btn--icon" data-view="list" title="Vista lista">
            <svg class="ico" viewBox="0 0 16 16"><path fill="currentColor" d="M2 3h12v1H2zm0 4h12v1H2zm0 4h12v1H2z"/></svg>
          </button>
          <button type="button" class="btn--icon" data-view="calendar" title="Vista calendario">
            <svg class="ico" viewBox="0 0 16 16"><path fill="currentColor" d="M1 3h3v3H1zm5 0h3v3H6zm5 0h3v3h-3zM1 8h3v3H1zm5 0h3v3H6zm5 0h3v3h-3z"/></svg>
          </button>
        </div>
        <button type="button" class="btn btn--secondary btn--sm hidden" id="compareBtn">Comparar (<span id="compareBtnCount">0</span>)</button>
      </div>

      <!-- Results container (table or calendar rendered here by JS) -->
      <div id="resultsContainer" class="results-container">
        <div class="empty-state" id="emptyState">
          <div class="empty-state__icon">
            <svg class="ico" style="width:48px;height:48px"><use href="#ico-plane"/></svg>
          </div>
          <p class="empty-state__text">Ingresa origen, destino y fechas para comenzar</p>
        </div>
      </div>

      <!-- Compare section -->
      <div id="compareSection" class="compare-section hidden">
        <div class="compare-section__header">
          <h3 class="compare-section__title">Comparador</h3>
          <button type="button" class="btn btn--ghost btn--sm" id="compareClear">Limpiar</button>
        </div>
        <div id="compareContent"></div>
      </div>
    </main>

    <!-- Detail Panel -->
    <aside id="detailPanel" class="layout-detail">
      <div class="detail-panel__header">
        <h3 class="detail-panel__title">Detalle</h3>
        <div class="detail-panel__actions">
          <button id="repriceButton" class="btn btn--secondary btn--sm" type="button" disabled>Reprice</button>
          <button id="quotationButton" class="btn btn--secondary btn--sm" type="button" disabled>Cotizar</button>
          <button id="detailClose" class="btn--icon" type="button" title="Cerrar">
            <svg class="ico" viewBox="0 0 16 16"><path fill="currentColor" d="M4.5 3.5l8 8m-8 0l8-8" stroke="currentColor" stroke-width="1.5"/></svg>
          </button>
        </div>
      </div>
      <div id="detailContent" class="detail-panel__body"></div>
    </aside>
  </div>

  <!-- Loading overlay -->
  <div id="loadingOverlay" class="loading-overlay hidden">
    <div class="spinner">
      <svg class="spinner__svg" viewBox="0 0 50 50">
        <circle class="spinner__track" cx="25" cy="25" r="20"/>
        <circle class="spinner__fill" cx="25" cy="25" r="20"/>
      </svg>
    </div>
    <span class="spinner__text">Consultando vuelos...</span>
  </div>

  <!-- Progress bar (inline, at top of content) -->
  <div id="progressBar" class="progress-bar hidden"></div>

  <!-- Toast container -->
  <div id="toastContainer" class="toast-container"></div>

  <!-- SVG sprite -->
  <svg xmlns="http://www.w3.org/2000/svg" style="display:none">
    <symbol id="ico-plane" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>
    </symbol>
    <symbol id="ico-swap" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>
    </symbol>
    <symbol id="ico-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
    </symbol>
    <symbol id="ico-route" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>
    </symbol>
    <symbol id="ico-luggage" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 20h0a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h0"/><path d="M8 18V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v14"/><path d="M10 20h4"/><circle cx="16" cy="20" r="2"/><circle cx="8" cy="20" r="2"/>
    </symbol>
    <symbol id="ico-arrow-right" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
    </symbol>
    <symbol id="ico-calendar" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>
    </symbol>
    <symbol id="ico-chevron-down" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m6 9 6 6 6-6"/>
    </symbol>
  </svg>

  <script src="/app.js" defer></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat(html): restructure layout with semantic regions, new search bar, pax popover"
```

---

## Task 5: JS — Update Element References & State

**Files:**
- Modify: `public/app.js` (lines 1-60 — element references and state)

- [ ] **Step 1: Update element references**

The HTML element IDs have been preserved where possible. Update the DOM reference block at the top of `app.js` to add new elements and remove stale references:

New references to add:
```javascript
const detailPanel = $("detailPanel");
const detailClose = $("detailClose");
const resultsToolbar = $("resultsToolbar");
const resultsContainer = $("resultsContainer");
const emptyState = $("emptyState");
const paxTrigger = $("paxTrigger");
const paxPopover = $("paxPopover");
const paxLabel = $("paxLabel");
const paxAdultsDisplay = $("paxAdultsDisplay");
const paxChildrenDisplay = $("paxChildrenDisplay");
const paxInfantsDisplay = $("paxInfantsDisplay");
const sortButtons = $("sortButtons");
const compareBtn = $("compareBtn");
const compareBtnCount = $("compareBtnCount");
const compareClear = $("compareClear");
const viewToggle = $("viewToggle");
const resultsCountLabel = $("resultsCountLabel");
const progressBar = $("progressBar");
const datesExact = $("datesExact");
const datesFlex = $("datesFlex");
const stayDaysMin = $("stayDaysMin");
const stayDaysMax = $("stayDaysMax");
```

References to remove (elements no longer exist):
```javascript
// Remove: matrixSection, matrixInfo, matrixContent, matrixCountBadge
// Remove: detailSection (replaced by detailPanel)
// Remove: resultsSection (replaced by resultsContainer)
// Remove: compareSection reference (update to new ID)
```

Add to state:
```javascript
state.viewMode = "list"; // "list" | "calendar"
state.flexMode = false; // true when flexible search is active
```

Update `RESULTS_PAGE_SIZE` from 10 to 15.

- [ ] **Step 2: Commit**

```bash
git add public/app.js
git commit -m "feat(js): update element references and state for new layout"
```

---

## Task 6: JS — Pax Popover & Mode Toggle

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: Write pax popover logic**

Add functions for the passenger popover component:

```javascript
function updatePaxLabel() {
  const a = parseInt($("adults").value, 10) || 1;
  const c = parseInt($("children").value, 10) || 0;
  const i = parseInt($("infants").value, 10) || 0;
  let label = `${a} ADT`;
  if (c > 0) label += `, ${c} CHD`;
  if (i > 0) label += `, ${i} INF`;
  paxLabel.textContent = label;
  paxAdultsDisplay.textContent = a;
  paxChildrenDisplay.textContent = c;
  paxInfantsDisplay.textContent = i;
}

function setupPaxPopover() {
  paxTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    paxPopover.classList.toggle("hidden");
  });

  document.addEventListener("click", (e) => {
    if (!paxPopover.contains(e.target) && e.target !== paxTrigger) {
      paxPopover.classList.add("hidden");
    }
  });

  paxPopover.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pax-action]");
    if (!btn) return;
    const action = btn.dataset.paxAction;
    const adultsEl = $("adults");
    const childrenEl = $("children");
    const infantsEl = $("infants");
    let a = parseInt(adultsEl.value, 10) || 1;
    let c = parseInt(childrenEl.value, 10) || 0;
    let i = parseInt(infantsEl.value, 10) || 0;

    if (action === "adults-inc" && a + c + i < 9) a++;
    if (action === "adults-dec" && a > 1) { a--; if (i > a) i = a; }
    if (action === "children-inc" && a + c + i < 9) c++;
    if (action === "children-dec" && c > 0) c--;
    if (action === "infants-inc" && i < a && a + c + i < 9) i++;
    if (action === "infants-dec" && i > 0) i--;

    adultsEl.value = a;
    childrenEl.value = c;
    infantsEl.value = i;
    updatePaxLabel();
  });
}
```

- [ ] **Step 2: Write mode toggle logic**

The mode toggle switches between Exact and Flexible. When flexible, show duration + window fields; when exact, show departure/return dates.

```javascript
function setupModeToggle() {
  document.querySelectorAll("[data-mode]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-mode]").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      const isFlexible = btn.dataset.mode === "flexible";
      state.flexMode = isFlexible;
      datesExact.classList.toggle("hidden", isFlexible);
      datesFlex.classList.toggle("hidden", !isFlexible);
      // Map to backend search modes
      if (isFlexible) {
        searchMode.value = tripType.value === "round-trip" ? "roundtrip-grid" : "stay-range";
      } else {
        searchMode.value = "exact";
      }
    });
  });
}
```

- [ ] **Step 3: Write flexible mode → backend translation**

When flexible mode is active and form is submitted, translate `stayDaysMin/Max + departureStart/End` into the date ranges the backend expects:

```javascript
function translateFlexibleDates(payload) {
  if (!state.flexMode) return payload;
  const minDays = parseInt(stayDaysMin?.value, 10) || 7;
  const maxDays = parseInt(stayDaysMax?.value, 10) || minDays;
  const depStart = $("departureStart")?.value;
  const depEnd = $("departureEnd")?.value;
  if (!depStart || !depEnd) return payload;
  const leg = payload.request.legs[0];
  leg.departureStart = depStart;
  leg.departureEnd = depEnd;
  if (payload.request.tripType === "round-trip") {
    leg.returnStart = addDaysIso(depStart, minDays);
    leg.returnEnd = addDaysIso(depEnd, maxDays);
    payload.request.searchMode = "roundtrip-grid";
  } else {
    payload.request.searchMode = "stay-range";
  }
  return payload;
}
```

This function is called inside `getFormPayload()` when `state.flexMode` is true.

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "feat(js): add pax popover, mode toggle, flexible date translation"
```

---

## Task 7: JS — Results Table Rendering

**Files:**
- Modify: `public/app.js` — rewrite `renderResults()`

- [ ] **Step 1: Rewrite renderResults()**

The new results rendering produces a dense table with these columns: Airline, Route, Departure, Arrival, Duration, Stops (badge), Baggage (icons), Price (right-aligned, bold), Actions.

Key changes from current:
- Render into `resultsContainer` (not `resultsContent`)
- Results toolbar visible when results exist
- Pagination at bottom with "Mostrando 1-15 de 47" + prev/next
- Price is the visually dominant column (right-aligned, larger font, `--text-primary`)
- Stops column uses semantic badges (0=green "Directo", 1=amber, 2+=danger)
- Row click opens detail panel (side panel, not stacked section)
- Group badge for multi-return options

The render function writes directly to `resultsContainer.innerHTML` with the new table structure using new CSS class names (`.results-table`, `.results-row`, etc.).

Update `renderToolbar()` to use new badge classes.

Update `renderSummary()` — this becomes part of the results toolbar, not a separate bar.

- [ ] **Step 2: Update pagination event handling**

Pagination events use the same data-attribute delegation pattern but target the new container. Page size is now 15.

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat(js): rewrite results table rendering with new layout and dense table"
```

---

## Task 8: JS — Calendar View (formerly Matrix)

**Files:**
- Modify: `public/app.js` — rewrite `renderMatrix()` → `renderCalendarView()`

- [ ] **Step 1: Rename and rewrite calendar rendering**

Rename `renderMatrix()` to `renderCalendarView()`. This function now renders into the same `resultsContainer` when `state.viewMode === "calendar"`.

Key changes:
- Uses same CSS classes from the component library (`.cal-grid`, `.cal-cell`, `.cal-header`, etc.)
- Color coding uses the refined perceptual scale from the spec
- Click on cell selects it AND opens the detail panel for that combination
- The calendar is only available when a flexible search produced matrix data
- When switching between list and calendar, the view toggles instantly without re-fetching

The view toggle buttons in the toolbar control `state.viewMode`. The render dispatcher decides which view to show:

```javascript
function renderResultsArea() {
  if (state.viewMode === "calendar" && state.matrixResponse?.cells?.length) {
    renderCalendarView();
  } else {
    renderResults();
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add public/app.js
git commit -m "feat(js): integrate calendar view as alternate results view"
```

---

## Task 9: JS — Detail Panel

**Files:**
- Modify: `public/app.js` — rewrite `renderDetail()` → `renderDetailPanel()`

- [ ] **Step 1: Rewrite detail rendering for side panel**

The detail panel renders into `detailContent` within the `.layout-detail` aside. Key changes:

- Opens/closes via `.is-open` class on `detailPanel`
- Price is the hero element at top (large, green, bold)
- Route + carrier + duration as a compact summary line below price
- Segments displayed as timeline blocks (outbound/inbound) with clear visual separation
- Inbound options as horizontal scrollable cards if group > 1
- Baggage section with check/cross icons
- Fare breakdown (base + taxes)
- Actions at top header (reprice, quotation, close)
- Quotation textarea at bottom when available
- Close button removes `.is-open` and deselects offer

```javascript
function openDetailPanel() {
  detailPanel.classList.add("is-open");
}

function closeDetailPanel() {
  detailPanel.classList.remove("is-open");
  state.selectedOfferId = null;
  renderResultsArea();
}
```

- [ ] **Step 2: Wire detail close button**

```javascript
detailClose.addEventListener("click", closeDetailPanel);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && detailPanel.classList.contains("is-open")) {
    closeDetailPanel();
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat(js): rewrite detail panel as slide-in side panel"
```

---

## Task 10: JS — Sidebar Filters

**Files:**
- Modify: `public/app.js` — rewrite `renderSidebar()`

- [ ] **Step 1: Rewrite sidebar rendering**

The sidebar renders into `#sidebar` (`.layout-sidebar`). Key changes:

- Shows/hides via `.is-visible` class (not `hidden` — avoids layout shift)
- Always present in DOM, just not visible when no results
- Airline section: checkboxes with count + min price, "Solo" button
- Stops section: checkbox multi-select (Direct, 1 stop, 2+)
- Price slider or input for max price
- "Limpiar filtros" button at bottom
- All filters apply in real-time with debounce

The sidebar structure stays similar but uses new CSS classes from the component library.

- [ ] **Step 2: Commit**

```bash
git add public/app.js
git commit -m "feat(js): rewrite sidebar filters with new layout"
```

---

## Task 11: JS — Compare, Toasts, Empty States

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: Update compare rendering**

`renderCompare()` renders into the compare section within the content area. Uses the new table component classes.

- [ ] **Step 2: Update toast rendering**

`showToast()` uses new `.toast` classes with left border semantic color.

- [ ] **Step 3: Add empty and error state rendering**

```javascript
function renderEmptyState(message, suggestion) {
  resultsContainer.innerHTML = `
    <div class="empty-state">
      <div class="empty-state__icon">
        <svg class="ico" style="width:48px;height:48px"><use href="#ico-plane"/></svg>
      </div>
      <p class="empty-state__text">${escapeHtml(message)}</p>
      ${suggestion ? `<p class="empty-state__hint">${escapeHtml(suggestion)}</p>` : ""}
    </div>`;
}

function renderErrorState(message) {
  resultsContainer.innerHTML = `
    <div class="empty-state empty-state--error">
      <p class="empty-state__text">${escapeHtml(message)}</p>
      <button class="btn btn--secondary btn--sm" onclick="location.reload()">Reintentar</button>
    </div>`;
}
```

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "feat(js): update compare, toasts, empty states for new design"
```

---

## Task 12: JS — Event Bindings & renderAll()

**Files:**
- Modify: `public/app.js` — update event bindings and init block

- [ ] **Step 1: Update renderAll()**

```javascript
function renderAll() {
  renderToolbar();
  renderSidebar();
  renderResultsArea(); // dispatches to list or calendar
  renderCompare();
  renderDetailPanel();
  updateResultsToolbar();
}
```

- [ ] **Step 2: Wire new event bindings**

- Sort buttons in toolbar: click → update `state.sortMode`, re-render
- View toggle: click → update `state.viewMode`, re-render
- Compare button: click → show compare section
- Compare clear: click → clear compare selections
- Mode toggle chips: already wired in Task 6
- Form submit: update to call `translateFlexibleDates()` when flex mode active
- Detail panel close: already wired in Task 9

- [ ] **Step 3: Update updateModeFields()**

Replace the old `updateModeFields()` with the new mode logic from Task 6. The old function showed/hid range date rows; the new function shows/hides datesExact/datesFlex.

- [ ] **Step 4: Update validation**

`validateForm()` needs updates to handle flexible mode:
- When flex: validate departureStart, departureEnd, stayDaysMin/Max
- When exact: validate departureDate, returnDate (unchanged)
- Add validation: stayDaysMax >= stayDaysMin

- [ ] **Step 5: Update setupInputEnforcement()**

Add enforcement for stayDaysMin/Max (integer range 1-90).
Remove enforcement for old range fields (returnStart, returnEnd) — these are now computed, not user-entered.

- [ ] **Step 6: Init block**

Update the init block at the bottom of app.js:

```javascript
setupInputEnforcement();
setupLocationAutocomplete("origin");
setupLocationAutocomplete("destination");
setupPaxPopover();
setupModeToggle();
updatePaxLabel();
window.addEventListener("resize", syncVisibleLocationMenus);
window.addEventListener("scroll", syncVisibleLocationMenus, true);
renderAll();
```

- [ ] **Step 7: Commit**

```bash
git add public/app.js
git commit -m "feat(js): wire events, renderAll, validation, init for redesigned UI"
```

---

## Task 13: CSS — Search Bar, Calendar, Detail Panel, Sidebar Specifics

**Files:**
- Modify: `public/app.css` — add section-specific styles

- [ ] **Step 1: Write search bar specific styles**

Styles for `.search-bar__route`, `.location-field`, `.flex-duration`, `.flex-window`, `.chip-group--mode`, `.pax-popover`.

The search bar main row should have items vertically centered, with the route group being the widest element. Inputs in the search bar use `--bg-surface` background, 32px height.

- [ ] **Step 2: Write calendar grid styles**

```css
/* === 7. CALENDAR === */
.cal-grid { display: grid; gap: 2px; padding: var(--sp-3); }
.cal-row { display: grid; grid-template-columns: 64px repeat(var(--cols), minmax(72px, 1fr)); gap: 2px; }
.cal-corner, .cal-header { padding: var(--sp-2) var(--sp-1); font-size: var(--text-xs); font-weight: var(--weight-semibold); color: var(--text-tertiary); background: var(--bg-overlay); text-align: center; border-radius: var(--radius-sm); }
.cal-label { /* same as header but left-aligned */ }
.cal-cell { padding: var(--sp-2) var(--sp-1); font-size: var(--text-sm); text-align: left; cursor: pointer; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--bg-surface); transition: all var(--duration-fast) var(--ease-default); }
.cal-cell:hover { border-color: var(--accent); }
.cal-cell.is-active { border-color: var(--accent); background: var(--accent-muted); box-shadow: var(--shadow-glow); }
.cal-cell.is-loading { background: linear-gradient(90deg, var(--bg-surface) 0%, var(--bg-overlay) 50%, var(--bg-surface) 100%); background-size: 200% 100%; animation: shimmer 1.5s linear infinite; cursor: progress; }
.cal-cell:disabled { opacity: 0.25; cursor: default; }
.cal-cell--best { border-color: rgba(76,154,237,0.4); background: rgba(76,154,237,0.08); }
.cal-cell--good { border-color: rgba(63,185,80,0.4); background: rgba(63,185,80,0.06); }
.cal-cell--ok { border-color: transparent; }
.cal-cell--warm { border-color: rgba(210,153,34,0.4); background: rgba(210,153,34,0.06); }
.cal-cell--hot { border-color: rgba(248,81,73,0.4); background: rgba(248,81,73,0.06); }
.cal-price { font-weight: var(--weight-semibold); color: var(--text-primary); }
.cal-meta { font-size: 10px; color: var(--text-tertiary); margin-top: 1px; }
```

- [ ] **Step 3: Write detail panel styles**

```css
/* === 8. DETAIL PANEL === */
.detail-panel__header { display: flex; align-items: center; justify-content: space-between; padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border-subtle); background: var(--bg-overlay); position: sticky; top: 0; z-index: 1; }
.detail-panel__title { font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.06em; }
.detail-panel__actions { display: flex; gap: var(--sp-1); }
.detail-panel__body { padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-4); }
.detail-hero { font-size: var(--text-lg); font-weight: var(--weight-semibold); color: var(--success); }
.detail-summary { font-size: var(--text-sm); color: var(--text-tertiary); }
.detail-section { display: flex; flex-direction: column; gap: var(--sp-2); }
.detail-section__title { font-size: var(--text-xs); font-weight: var(--weight-semibold); color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.06em; padding-bottom: var(--sp-1); border-bottom: 1px solid var(--border-subtle); }
.detail-segment { padding: var(--sp-3); background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); }
.detail-segment__dir { font-size: var(--text-xs); font-weight: var(--weight-semibold); color: var(--text-tertiary); text-transform: uppercase; margin-bottom: var(--sp-2); }
.detail-segment__leg { font-size: var(--text-sm); padding: var(--sp-1) 0; }
.detail-segment__flight { font-weight: var(--weight-semibold); color: var(--text-primary); }
.detail-segment__times { color: var(--text-tertiary); font-size: var(--text-xs); }
.detail-pair { display: flex; justify-content: space-between; align-items: center; padding: var(--sp-2) var(--sp-3); background: var(--bg-surface); border-radius: var(--radius-sm); }
.detail-pair__key { color: var(--text-tertiary); font-size: var(--text-xs); }
.detail-pair__val { font-weight: var(--weight-semibold); color: var(--text-primary); }
```

- [ ] **Step 4: Write sidebar filter styles**

```css
/* === 10. SIDEBAR === */
.sidebar__section { padding: var(--sp-3); border-bottom: 1px solid var(--border-subtle); }
.sidebar__section:last-child { border-bottom: none; }
.sidebar__title { font-size: var(--text-xs); font-weight: var(--weight-semibold); color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: var(--sp-2); display: flex; justify-content: space-between; align-items: center; }
.sidebar__reset { font-size: var(--text-xs); color: var(--accent); background: none; border: none; cursor: pointer; }
.sidebar__airline { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) var(--sp-2); border-radius: var(--radius-sm); cursor: pointer; transition: background var(--duration-fast); }
.sidebar__airline:hover { background: var(--bg-hover); }
.sidebar__airline.is-hidden { opacity: 0.3; }
.sidebar__airline.is-solo { background: var(--accent-muted); }
.sidebar__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); flex-shrink: 0; }
.sidebar__airline.is-hidden .sidebar__dot { background: transparent; border: 1.5px solid var(--text-disabled); }
.sidebar__airline.is-solo .sidebar__dot { background: var(--accent); }
.sidebar__code { font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--text-primary); }
.sidebar__meta { font-size: var(--text-xs); color: var(--text-tertiary); }
.sidebar__solo-btn { font-size: 10px; font-weight: var(--weight-semibold); padding: 1px 6px; background: none; border: 1px solid var(--border-default); border-radius: 10px; color: var(--text-tertiary); cursor: pointer; transition: all var(--duration-fast); margin-left: auto; }
.sidebar__solo-btn:hover { border-color: var(--accent); color: var(--accent); }
```

- [ ] **Step 5: Commit**

```bash
git add public/app.css
git commit -m "feat(css): add search bar, calendar, detail panel, sidebar specific styles"
```

---

## Task 14: Integration & Visual Verification

**Files:**
- May touch: `public/app.css`, `public/app.js`, `public/index.html`

- [ ] **Step 1: Start dev server and verify page loads**

Run: `npm run build && npm start`
Open browser, check that:
- Header renders at 36px with brand and badges
- Search bar renders as single compact row
- Chips row shows below search bar
- Main layout shows empty state centered
- No console errors

- [ ] **Step 2: Test search flow end-to-end**

1. Enter origin (LIM), destination (SCL)
2. Enter departure/return dates
3. Click BUSCAR
4. Verify: loading overlay appears, results load into table
5. Verify: sidebar appears with airline filters
6. Verify: clicking a result opens detail panel on the right
7. Verify: pagination works (if >15 results)
8. Verify: closing detail panel works (X button, Escape)

- [ ] **Step 3: Test flexible mode**

1. Click "Flexible" chip
2. Verify: date fields switch to duration + window
3. Enter 10-10 days, window dates
4. Click BUSCAR
5. Verify: calendar view is available in toolbar
6. Verify: switching to calendar view shows price grid
7. Verify: clicking a calendar cell opens detail

- [ ] **Step 4: Test pax popover**

1. Click pax chip
2. Verify: popover opens with +/- controls
3. Increment adults to 2, children to 1
4. Verify: label updates to "2 ADT, 1 CHD"
5. Click outside — popover closes

- [ ] **Step 5: Fix any visual inconsistencies**

Review all surfaces for:
- Token usage consistency (no hardcoded colors)
- Spacing adherence to 4px scale
- Typography scale consistency
- Border/radius consistency
- Transition smoothness
- Responsive behavior at 900px and 600px breakpoints

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete Fly Desk v2 redesign — integrated operational surface"
```

---

## Summary

| Task | File(s) | Description |
|------|---------|-------------|
| 1 | app.css | Design tokens + base reset |
| 2 | app.css | Layout system |
| 3 | app.css | Component library + animations + responsive |
| 4 | index.html | Full HTML restructure |
| 5 | app.js | Element references + state updates |
| 6 | app.js | Pax popover + mode toggle + flex translation |
| 7 | app.js | Results table rendering |
| 8 | app.js | Calendar view (ex-matrix) |
| 9 | app.js | Detail panel (side panel) |
| 10 | app.js | Sidebar filters |
| 11 | app.js | Compare, toasts, empty states |
| 12 | app.js | Event bindings, renderAll, validation, init |
| 13 | app.css | Section-specific styles (search, calendar, detail, sidebar) |
| 14 | all | Integration testing + visual verification + fixes |
