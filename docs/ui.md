# UI requirements

Status: required product direction; no screens are implemented yet. Updated: 2026-11-13.

## Visual direction

Build a polished, compact financial tool with clear hierarchy and efficient use of screen space. Mobile support is a first-release requirement. Avoid a generic generated dashboard appearance.

Use shadcn-vue and Tailwind CSS. Bring in only needed components and own their local source. Use shared design tokens for type, colors, spacing, borders, radii, and interaction states. Do not copy a dashboard template as the product design.

Use typography, alignment, restrained color, and spacing to organize information. Avoid oversized headings, excessive empty margins, decorative gradients, redundant cards, decorative icons, empty welcome sections, and charts without a useful question to answer. Whitespace should group content and support readability. Dense desktop layouts must not reduce mobile touch usability.

Align amounts consistently, use readable numeric typography, and display currency explicitly where needed. Do not rely on color alone for transaction direction, errors, or state. Distinguish cached balances, pending/posted records, removed history, and reconciliation review clearly.

## Responsive interactions

| Area | Desktop | Mobile |
| --- | --- | --- |
| Transactions | Compact table with aligned columns | Date-grouped rows prioritizing merchant, amount, date, and status |
| Transaction editing | Side panel retaining list context | Full-screen editing view with space for notes and the keyboard |
| Filters | Compact toolbar | Bottom drawer with clear apply/reset actions |
| Navigation | Account tree rail with pinned utilities | Bottom navigation plus a scope sheet from the page header |
| Account sharing | Per-account user selection | The same permissions in a touch-friendly layout |

These are layout targets to validate in a prototype. Share query and editing logic across layouts. Do not force a desktop table into a narrow viewport or hide important functionality on mobile. Preserve filters and list position when closing transaction details.

Use comfortable touch targets, visible focus, accessible labels, and keyboard navigation. Handle focus restoration when dialogs close. Ensure soft keyboards, device safe areas, and fixed navigation do not cover inputs or save/cancel controls. Long merchant names, notes, large amounts, empty states, loading, and errors need intentional layouts.

## Role-aware information architecture

- Overview: permitted account balances, meaningful summary information, and review work.
- Accounts: accounts grouped by account group. Members see their groups; administrators also manage groups, members, and moves with an impact preview.
- Transactions: search, filters, detail/history, notes, category, tags, and reconciliation.
- Review: actionable uncategorized records, reconciliation changes, and uncertain lifecycle links within the user's account scope.
- Settings: own credentials/session controls; bank connections, users and their groups, secrets, and system operations restricted to administrators.

Members are active bookkeepers, not read-only viewers. Shared accounts show shared annotations. Show an understandable conflict message when an edit is stale. Avoid displaying private account names or counts through hidden filters, error messages, or aggregate summaries.

## Design and acceptance sequence

Start with desktop and mobile versions of the transaction list and editing flow. Establish the visual language there before expanding the rest of the application.

Verify at representative mobile, tablet, and desktop widths, including a narrow phone viewport. Check real touch/browser behavior where possible, not only screenshots.

- No accidental page-level horizontal scrolling or inaccessible controls.
- Important values remain readable; long text has a way to reveal full content.
- Editing remains usable with the mobile keyboard open.
- Users can filter, open a transaction, edit annotations, reconcile, and return to their list on mobile and desktop.
- Account permissions remain consistent across all layouts and server requests.
- Desktop density uses available width without excessive blank areas; mobile maintains readable spacing and usable touch targets.
- Loading, failure, empty, revoked-access, and concurrent-edit states have useful feedback.
- No visual decoration or summary block is included without a clear user purpose.

## Art direction: the account tree

Accounts are the navigation. A dark rail lists All accounts, then each account group and its accounts, so the scope of every number on screen is always visible and changing it is one click. The page under the rail is a scope header (scope name, its cached balance or counts, and Transactions/Overview tabs) over the ledger itself. These references shaped specific choices; Mintless adapts the ideas, not their branding or assets.

- [Mercury](https://mercury.com/): accounts with their balances live in the persistent sidebar, and cents are set smaller than dollars so balances scan by magnitude. Mintless renders cents at 86% size in the same color, so they stay readable and keep text contrast.
- [Linear](https://linear.app/): a dark, quiet sidebar holds the workspace tree, and the content header carries the current scope with view tabs underneath. Mintless follows that split: tree in the rail, views as tabs, and small-caps labels (`label-caps`) for sections and columns.
- [Ramp](https://ramp.com/): warm off-white surfaces and thin borders keep a finance tool calm. The Light theme pairs a warm paper page with a deep green rail.
- [Copilot Money](https://copilot.money/) is a counter-example for this product: gradients, tinted panels, and colored pills suit a consumer app but would add noise to a dense household ledger.

Rules that follow from this:

- One active scope at a time: All accounts, one group, or one account, carried in the `group` and `account` query parameters. The tree marks exactly one entry with `aria-current="page"`. Rows, Overview charts and counts, CSV export, and the review links all use that scope, and changing scope closes an open editor and cancels stale requests. The server narrows the same parameters inside the user's permitted accounts, so a hidden account returns an empty scope rather than an error that reveals it. A scope the user cannot resolve (an unknown or revoked account or group, or an account paired with a group it is not in) stays in the URL and is shown as unavailable: no rows, totals, or export, and explicit choices to open the account in its own group, choose another scope, or go to All accounts. The app never silently widens or swaps the scope.
- Rail balances are cached values, not live ones. Each shows "Owed" for credit accounts and "Balance" otherwise, the currency code when it is not USD, and an accessible "cached, fetched ..." note. Balances are never summed across accounts, so groups show an account count instead of a total.
- The tree scrolls on its own and the utilities stay pinned below it: Review (with its count), Accounts management, Settings, and the signed-in user with Sign out. Unassigned is labelled "admins only".
- Phone keeps the bottom navigation for Transactions, Overview, Review, Accounts, and Settings. The scope header has a Scope button that opens the same tree in a sheet, and filters stay behind a Filters button with a count badge. Sign out is in Settings.
- One family, Inter Variable, self-hosted from `@fontsource-variable/inter` (SIL Open Font License 1.1) with a system-font fallback. Numbers use tabular figures.
- Filters are quiet "Label: value" chips with a real native select underneath. A chip tints only when it differs from its default.
- Sections are headed by a label over a hairline, not wrapped in cards. Totals for a view sit in one ruled band. Overview names them Money in, Spending, and Net (money in minus spending), never income or balance, and keeps the caveats that change those totals visible; full notes expand below.
- Status is never color alone: pending is a dashed outline label, review a labelled chip, reconciled an icon with text for screen readers.

## References

- [shadcn-vue introduction](https://www.shadcn-vue.com/docs/introduction)
- [Responsive drawer examples](https://www.shadcn-vue.com/docs/components/drawer)
- [Reka UI accessibility and unstyled primitives](https://reka-ui.com/docs/overview/introduction)
