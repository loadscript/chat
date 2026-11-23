// The workstation shell: the only piece of React in this package that knows
// what a "workspace" looks like, and it contains no feature list at all.
//
// Vendored and adapted from
// packages/underload/dashboard/example/src/app/WorkstationShell.tsx. Differences
// are deliberate and marked below: region slots are per-column channels
// (`layout.sidebar|stage|aside`) with a winner-takes-region rule instead of one
// shared panel channel with a `region` field, and the grid is viewport-locked
// (styles/base.css owns that, this file only emits the attributes/classes).
//
// Everything on screen comes out of the composed instance:
//
//   bar title          <- `layout.brand` service (ONE versioned title, `compact`)
//   columns            <- `layout.regions` service (order + accessible labels)
//   column content     <- the region slot contributions (see pickRegionOwner)
//   bar chips          <- STATUS_SLOT contributions (nothing registers one today)
//   bar settings popup <- ./components/SettingsDialog, which owns its open flag
//   skin               <- `ui.theme|density|motion` state -> data-* attributes
//
// The bar projects skin STATE onto attributes and offers no skin control: the product
// ships one dark theme, so the theme/density cells stay as internal state that an
// embedder can drive (plugins/theme.ts) while the header stays out of the way.
//
// Registering another capability adds a surface with no edit to this file.
import type { ComponentType } from 'react';
import type { Dashboard } from '@underload/dashboard';
import {
    ASIDE_SLOT,
    isPanelComponent,
    LAYOUT_BRAND_SERVICE,
    LAYOUT_REGIONS_SERVICE,
    SIDEBAR_SLOT,
    STAGE_SLOT,
    STATUS_SLOT,
    UI_DENSITY_STATE,
    UI_MOTION_STATE,
    UI_THEME_STATE,
    type BrandSpec,
    type Contribution,
    type DashboardDensity,
    type DashboardMotion,
    type DashboardTheme,
    type PanelValue,
    type RegionSpec,
    type StatusValue
} from './contract';
import { useDashboardService, useDashboardSlot, useDashboardValue } from './state-hooks';
import { WorkbenchProvider } from './workbench';
// The ONE component this file renders directly instead of resolving from a slot: the
// header is shell chrome, and the configuration popup is chrome too, not a feature
// competing for a region. It is imported by path rather than through the components
// barrel so the shell does not pull every feature surface into its module graph.
import { SettingsDialogButton } from './components/SettingsDialog';

export function WorkstationShell({ instance }: { instance?: Dashboard } = {}) {
    // Two supported wirings, and the difference is only who owns the context:
    // ChatAssistantApp provides the instance (it also owns disposal), while a
    // story or a test that hands the instance here gets the provider for free —
    // the example's entry pattern. ShellFrame itself never takes props.
    if (instance !== undefined) {
        return (
            <WorkbenchProvider instance={instance}>
                <ShellFrame />
            </WorkbenchProvider>
        );
    }
    return <ShellFrame />;
}

/**
 * Region ownership rule (documented here because it is a CONTRACT for the chat
 * plugins, not an implementation detail):
 *
 * `instance.slot()` returns contributions sorted by `order` ascending, ties
 * broken by registration order. A region renders exactly ONE contribution — the
 * LAST of that sorted list — so "the highest order per region wins" and a later
 * plugin replaces the T1 placeholder without knowing it exists. Ties resolve to
 * the plugin that registered last (setup order is deterministic), so two plugins
 * must never share an order in one region: use the bands 10 (sidebar),
 * 20 (stage), 30 (aside), 40 (add-ons).
 *
 * Consequence for authors: one component owns a column. The stage's transcript +
 * composer are composed BY the stage component, not contributed separately.
 */
function pickRegionOwner(
    contributions: readonly Contribution<PanelValue>[]
): Contribution<PanelValue> | null {
    return contributions.length === 0 ? null : contributions[contributions.length - 1];
}

/** One region column: the winning contribution, rendered without extra wrappers. */
function RegionColumn({
    region,
    contributions
}: {
    region: RegionSpec;
    contributions: readonly Contribution<PanelValue>[];
}) {
    const owner = pickRegionOwner(contributions);

    return (
        <section
            className={`station__region station__region--${region.id}`}
            data-region={region.id}
            // Shell-owned ids (see the grammar header in contract.ts); the bare
            // `sidebar` / `aside-panel` ids stay free for the feature surface.
            data-testid={`region-${region.id}`}
            aria-label={region.label}
        >
            {owner === null ? null : renderContribution(owner)}
        </section>
    );
}

/**
 * Renders one winning contribution. A `component` contribution is rendered with
 * NO props and NO panel chrome so it can fill the column (the skin styles
 * `.station__region > *` to stretch); a descriptor contribution gets the panel
 * frame (head + body) the example's skin defines.
 */
function renderContribution(contribution: Contribution<PanelValue>) {
    const value = contribution.value;

    if (isPanelComponent(value)) {
        const Surface: ComponentType = value.component;
        return <Surface key={contribution.id} />;
    }

    const titleId = `panel-${contribution.id}-title`;
    return (
        <article
            key={contribution.id}
            className="panel"
            data-panel={contribution.id}
            aria-labelledby={titleId}
        >
            <header className="panel__head">
                <h2 className="panel__title" id={titleId}>
                    {value.title}
                </h2>
                {value.hint ? <span className="panel__hint">{value.hint}</span> : null}
            </header>
            <div className="panel__body">
                {value.body === undefined ? <p className="panel__empty">Nothing registered yet.</p> : value.body}
            </div>
        </article>
    );
}

function ShellFrame() {
    const brand = useDashboardService<BrandSpec>(LAYOUT_BRAND_SERVICE);
    const regions = useDashboardService<readonly RegionSpec[]>(LAYOUT_REGIONS_SERVICE);
    const statuses = useDashboardSlot<StatusValue>(STATUS_SLOT);

    // Fixed three calls: hooks must be unconditional, and the region channels are
    // a closed set (the shell renders nothing else), so reading them by name is
    // safer than looping over a service value.
    const sidebar = useDashboardSlot<PanelValue>(SIDEBAR_SLOT);
    const stage = useDashboardSlot<PanelValue>(STAGE_SLOT);
    const aside = useDashboardSlot<PanelValue>(ASIDE_SLOT);

    // Read-only skin projections. Nothing in the bar mutates them any more (no theme
    // or density affordance ships), so `instance` is not needed here either — the
    // values arrive through the state hooks below.
    const theme = useDashboardValue<DashboardTheme>(UI_THEME_STATE);
    const density = useDashboardValue<DashboardDensity>(UI_DENSITY_STATE);
    const motion = useDashboardValue<DashboardMotion>(UI_MOTION_STATE);

    // Contributions are keyed by region id, so a plugin only ever writes to the
    // channel it named; an unknown channel is simply not rendered.
    const contributionsByRegion: Record<string, readonly Contribution<PanelValue>[]> = {
        sidebar,
        stage,
        aside
    };

    const declared = [...regions].sort((left, right) => left.order - right.order);

    return (
        <div
            className="station"
            // The three skin states are the only styling switch the shell
            // touches; styles/tokens.css owns every colour and metric and is
            // scoped to `.station`, never to :root, so the skin can be embedded
            // inside another page without leaking.
            data-theme={theme}
            data-density={density}
            data-motion={motion}
            data-testid="station-root"
        >
            <header className="station__bar" data-testid="station-bar">
                {/* THE ONE TITLE, at every width: `layout.brand.compact` is
                    "Chat v<X.X.X>", built from the package.json version via
                    src/version.ts, so the bar needs no separate version chip and no
                    tagline. It is a bare <h1> with a text node — styles/base.css
                    truncates it on a phone (`.station__brand` is the
                    `text-overflow: ellipsis` box) and pushes the controls to the right
                    edge with `flex: 1 1 auto`. The unused brand fields
                    (name / tagline / chip / notice) stopped rendering here; they are
                    metadata the `layout.brand` service still publishes. */}
                <h1 className="station__brand" data-testid="station-title">
                    {brand.compact}
                </h1>

                {/* STATUS_SLOT contributions, i.e. live chips. The row renders only
                    when something registered: the accent-bordered brand chip that used
                    to guarantee a row of its own is gone with the version, and an empty
                    labelled group would be announced as an empty region. */}
                {statuses.length === 0 ? null : (
                    <div className="station__chips" role="group" aria-label="Station signal">
                        {statuses.map((contribution) => {
                            const Chip: ComponentType = contribution.value.component;
                            return <Chip key={contribution.id} />;
                        })}
                    </div>
                )}

                <div className="station__actions" role="group" aria-label="Station controls">
                    {/* The configuration popup. Its open flag is local state inside the
                        component (./components/SettingsDialog.tsx), so the shell stays
                        out of the dialog's lifecycle and no `chat.*` cell carries it. */}
                    <SettingsDialogButton />
                </div>
            </header>

            <main className="station__grid">
                {declared.map((region) => (
                    <RegionColumn
                        key={region.id}
                        region={region}
                        contributions={contributionsByRegion[region.id] ?? []}
                    />
                ))}
            </main>
        </div>
    );
}
