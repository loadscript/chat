// The vendored skin's breakpoints, pinned against the JS viewport seam.
//
// WHY A TEST READS CSS AT ALL: the stylesheet is otherwise invisible to this suite
// (no test renders the skin), so the one thing that CAN be checked mechanically is
// the number. N3 is exactly a number drifting: three inner `@media` blocks still
// flipped at `max-width: 820px` while the station grid itself flips at 899
// (base.css:417), which left the 820-899 band with an element reflowed for a phone
// inside a region the layout still treated as a wide column. `viewport.ts` publishes
// THE threshold as `DESKTOP_QUERY` ('(min-width: 900px)'), and its comment used to
// claim the CSS disagreed with it; both directions are pinned here so the
// disagreement cannot come back silently.
//
// WHY `node:fs` AND NOT `./x.css?raw`: Vitest stubs every CSS request (the default
// `test.css: false`), so a `?raw` import of a stylesheet yields an empty string here
// even though Vite's build serves the real text. The filesystem is the one source
// that cannot be stubbed, and `__dirname` is this file's own directory, so the test
// reads the very files the bundle compiles regardless of the runner's cwd.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_QUERY } from '../viewport';

/** The stylesheet directory (this file lives in it). */
const SKIN_DIR = __dirname;

/** Every `*.css` file the skin ships, sorted so a failure names a stable order. */
const skinFiles = (): string[] =>
    readdirSync(SKIN_DIR)
        .filter((name) => name.endsWith('.css'))
        .sort();

const readSkin = (name: string): string => readFileSync(join(SKIN_DIR, name), 'utf-8');

/**
 * A stylesheet with every comment removed. `narrowBlockIn` does this internally because
 * the skin documents its decisions BETWEEN declarations; the regex-based checks below
 * need the same treatment, or a comment that merely mentions `transform` would decide a
 * rule's assertion.
 */
const declarationsOf = (name: string): string => readSkin(name).replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * A component file with its comments removed, for exactly the reason `declarationsOf`
 * strips a stylesheet's: this skin records every removed piece of vocabulary in prose, and
 * that prose must not decide an assertion about the code that renders it. A JSX comment is a
 * `{/* … *\/}` block, so the pattern below erases the body and leaves the braces behind;
 * whole-line `//` comments go with it.
 */
const markupOf = (name: string): string =>
    readFileSync(join(SKIN_DIR, '..', 'components', name), 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

/**
 * Every NARROW-layout flip one stylesheet declares, i.e. the px values inside a
 * `@media (max-width: ...)`. Deliberately not a bare `max-width:` scan: a measure
 * cap (settings.css `.settings { max-width: 520px }`) or a text ellipsis bound
 * (composer.css `max-width: 26ch`) is not a breakpoint and must not be swept into
 * this assertion.
 */
const narrowFlipsIn = (source: string): number[] =>
    [...source.matchAll(/@media\s*\(\s*max-width:\s*(\d+)px/g)].map((match) => Number(match[1]));

/** The desktop threshold as a number, derived from the seam's own constant. */
const desktopFrom = (query: string): number => {
    const match = /\(min-width:\s*(\d+)px\)/.exec(query);
    if (match === null) throw new Error(`Unexpected DESKTOP_QUERY: ${query}`);
    return Number(match[1]);
};

/**
 * The rules one `@media (max-width: <width>px)` block ships, as `selector ->
 * declarations` with every run of whitespace (and every comment) collapsed to a
 * single space. Comments are stripped FIRST because the skin documents its decisions
 * BETWEEN declarations, and those words must not leak into the assertion text.
 * Braces are matched by counting, so a nested at-rule cannot truncate the body.
 */
const narrowBlockIn = (source: string, width: number): Record<string, string> => {
    const header = `@media (max-width: ${width}px)`;
    const open = source.indexOf(header);
    if (open < 0) throw new Error(`skin: no ${header} block`);

    let depth = 0;
    let cursor = source.indexOf('{', open);
    const bodyStart = cursor + 1;
    for (; cursor < source.length; cursor += 1) {
        if (source[cursor] === '{') depth += 1;
        else if (source[cursor] === '}') {
            depth -= 1;
            if (depth === 0) break;
        }
    }
    const body = source.slice(bodyStart, cursor).replace(/\/\*[\s\S]*?\*\//g, '');

    const rules: Record<string, string> = {};
    for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = match[1].replace(/\s+/g, ' ').trim();
        const declarations = match[2]
            .split(';')
            .map((entry) => entry.replace(/\s+/g, ' ').trim())
            .filter((entry) => entry !== '')
            .join('; ');
        rules[selector] = declarations;
    }
    return rules;
};

/** The widest stage layout still gets before the middle column is squeezed. */
const WIDE_SQUEEZE = 1120;

describe('the skin agrees with the viewport seam', () => {
    it('flips every region and every element at the same crossing (899)', () => {
        // The directory listing is part of the assertion: a NEW stylesheet has to be
        // given an expectation here, which is what keeps a fourth column of rules from
        // inventing its own breakpoint.
        expect(skinFiles()).toEqual([
            'agents.css',
            'base.css',
            'composer.css',
            'index.css',
            'inspector.css',
            'markdown.css',
            'notices.css',
            'sessions.css',
            'settings.css',
            'tokens.css',
            'tools.css',
            'transcript.css'
        ]);

        const narrow = desktopFrom(DESKTOP_QUERY) - 1;
        expect(narrow).toBe(899);
        const flips = skinFiles().reduce<Record<string, number[]>>((accumulated, name) => {
            accumulated[name] = narrowFlipsIn(readSkin(name));
            return accumulated;
        }, {});

        // Exact per-file lists: a NEW inner media query at a different width — or one
        // of the four 899 blocks moving again — fails here with the file named.
        expect(flips).toEqual({
            'agents.css': [],
            'base.css': [WIDE_SQUEEZE, narrow],
            'composer.css': [narrow],
            'index.css': [],
            'inspector.css': [],
            'markdown.css': [],
            'notices.css': [narrow],
            'sessions.css': [narrow],
            'settings.css': [narrow],
            'tokens.css': [],
            'tools.css': [],
            'transcript.css': []
        });
    });

    it('leaves no 820px rule anywhere in the skin', () => {
        // The number the drift was made of: nothing in the stylesheet may still claim
        // a narrow layout starts at 820.
        const offenders = skinFiles().filter((name) => narrowFlipsIn(readSkin(name)).includes(820));
        expect(offenders).toEqual([]);
    });

    it('documents the breakpoint the seam actually ships', () => {
        // N3 also corrected the comment in the seam itself: it described base.css as
        // flipping at 820, which was true of an earlier revision of the skin only.
        const seam = readFileSync(join(SKIN_DIR, '..', 'viewport.ts'), 'utf-8');
        expect(seam).toContain('max-width: 899px');
        expect(seam).not.toContain('820');
    });

    it('ships the phone layout: one-line bar, full-height stage, two drawers', () => {
        // R3 is the one acceptance criterion this suite CAN check mechanically: the
        // stylesheet is never rendered, but the declarations are text. Every entry
        // below is a rule the mobile redesign depends on, and a rule that silently
        // leaves the 899 block (or moves to a selector that cannot win the cascade)
        // fails here naming the file.
        const rules = narrowBlockIn(readSkin('base.css'), 899);
        expect(Object.keys(rules).sort()).toEqual(
            [
                '.station',
                ".station[data-density='compact']",
                '.station .inspector',
                '.station .inspector__scrim',
                ".station .inspector[data-open='true']",
                ".station[data-theme='slate']",
                '.station__bar',
                '.station__brand',
                '.station__chips',
                '.station__grid',
                '.station__region--sidebar, .station__region--aside'
            ].sort()
        );

        // THE FRAME: the station is flush to the edges and the grid is ONE row for
        // the stage; the two drawer columns leave the flow entirely, which is what
        // removes the dead rows the old 2fr/1fr/1fr grid left under the transcript.
        expect(rules['.station']).toContain('--mobile-bar');
        expect(rules['.station']).toContain('padding: 0');
        expect(rules['.station__grid']).toContain('grid-template-columns: minmax(0, 1fr)');
        expect(rules['.station__grid']).toContain('grid-template-rows: minmax(0, 1fr)');
        expect(rules['.station__grid']).not.toContain('2fr');
        expect(rules['.station__region--sidebar, .station__region--aside']).toContain('position: fixed');
        // tokens.css:78-82 declares the compact metrics as `.station[data-density=
        // 'compact']` (0,2,0), which OUTRANKS a bare `.station` no matter where the
        // rule sits — so the phone re-declares them for that spelling too, or a
        // compact station would keep 8px/9px and ignore the tighter phone metrics.
        expect(rules[".station[data-density='compact']"]).toBe('--gap: 6px; --pad: 10px');

        // THE BAR: one line, an ellipsised title, and the room for the two fixed
        // corner controls. `nowrap` is the single-line guarantee. T3 left the phone bar
        // TWO children — the versioned title and the configuration button — so the chip
        // row is the only child still hidden below the seam, and the title's truncation
        // now lives on `.station__brand` itself (the name/compact span pair, and the
        // display:none rules that used to choose between them, are gone).
        expect(rules['.station__bar']).toContain('flex-wrap: nowrap');
        expect(rules['.station__bar']).toContain('min-height: var(--mobile-bar)');
        expect(rules['.station__bar']).toContain('env(safe-area-inset-top');
        expect(rules['.station__brand']).toContain('text-transform: none');
        expect(rules['.station__brand']).toContain('font-size: 13px');
        expect(rules['.station__chips']).toBe('display: none');
        // The settings control is NOT hidden on a phone: the dialog it opens is the
        // package's only configuration editor, and the actions row claims the right edge
        // with its own auto margin (the chip row's margin is the pre-existing pair).
        expect(rules['.station__actions']).toBeUndefined();

        // THE INSPECTOR DRAWER opens off the LEFT edge — the rail's side — so it
        // mirrors the rail exactly: same edge, same `-105%` travel, same 160ms
        // transform language, same literal z-index pair, plus a full-viewport scrim.
        expect(rules['.station .inspector']).toContain('left: 0');
        expect(rules['.station .inspector']).toContain('border-right: 1px solid var(--line)');
        expect(rules['.station .inspector']).toContain('transform: translateX(-105%)');
        expect(rules['.station .inspector']).toContain('transition: transform 160ms ease');
        expect(rules['.station .inspector']).toContain('z-index: 20');
        // NO RESERVED TOP BAND: the drawer starts under the one-line bar
        // (`--mobile-bar`, the same measure the bar's own `min-height` reads) instead
        // of running beneath it behind a run of empty `padding-top`, which is what the
        // rail pays for its floating corner control. The `--pad` ring stays even.
        expect(rules['.station .inspector']).toContain('inset-block: var(--mobile-bar) 0');
        expect(rules['.station .inspector']).not.toContain('padding-top');
        expect(rules['.station .inspector']).toContain('padding: var(--pad)');
        // The edge it used to hang from may not come back beside the new one: a stale
        // `right: 0`/`border-left` pair would make the panel a fixed-position box with
        // BOTH insets set, which stretches it across the viewport instead of sliding.
        expect(rules['.station .inspector']).not.toContain('right: 0');
        expect(rules['.station .inspector']).not.toContain('border-left');
        expect(rules['.station .inspector__scrim']).toContain('inset: 0');
        expect(rules['.station .inspector__scrim']).toContain('z-index: 10');
        // THE DRAWER HAS NO CORNER CONTROL: the phone's only rules for this column are the
        // panel and its dismiss target. `.inspector__menu` is pinned out of the sheet (and
        // out of the markup) by the describe below, and what replaced it by the composer's.
        expect(rules['.station .inspector__menu']).toBeUndefined();

        // THE LEFT DRAWER: the rail's control is pinned to the bar's opposite corner
        // and sits ABOVE the open panel, so the same corner closes it; the panel
        // itself starts under the bar line, and it is the scrim — a sibling of the
        // rail in the tree — that covers the viewport.
        const rail = narrowBlockIn(readSkin('sessions.css'), 899);
        expect(rail['.station .rail__menu']).toContain('position: fixed');
        expect(rail['.station .rail__menu']).toContain('left: 8px');
        expect(rail['.station .rail__menu']).toContain('z-index: 30');
        expect(rail['.station .rail']).toContain('padding-top: calc(var(--mobile-bar) + var(--pad))');
        expect(rail['.station .rail__scrim']).toContain('inset: 0');

        // THE FOOTER: flush, one hairline, and the home-indicator safe area absorbed
        // into the bottom padding (so the composer is the shortest thing on screen).
        const footer = narrowBlockIn(readSkin('composer.css'), 899);
        expect(footer['.station .composer']).toContain('border-top: 1px solid var(--line)');
        expect(footer['.station .composer']).toContain('padding: 6px 6px calc(6px + env(safe-area-inset-bottom');
        // THE METADATA LINE IS THE DESKTOP'S, NOT A PHONE VARIANT of it: one line
        // (`nowrap`), the two pickers as content-width tracks side by side, and the
        // count still flush right on its `margin-left: auto`. `flex: 1 1 0` on the
        // pickers — the revision this replaces — grew each track to half the bar and
        // spread the two labels to opposite edges; the `display: none` on the counter
        // (which the keyboard hint used to share, hence the dead pair below) removed
        // the count the desktop shows. Neither rule may come back.
        expect(footer['.station .composer__row']).toBe('flex-wrap: nowrap');
        expect(footer['.station .composer__pick']).toBeUndefined();
        // ONE phone-only declaration is allowed on the counter, and it is not a layout
        // one: `cursor: pointer`, because below this seam the element is the inspector
        // drawer's control (the aside's corner chevron is gone, and the composer describes
        // the swap). A `display`/`margin`/`order` variant here would put a second metadata
        // design on the phone, which is what the paragraph above forbids.
        expect(footer['.station .composer__usage']).toBe('cursor: pointer');
        expect(footer['.station .composer__help, .station .composer__usage']).toBeUndefined();

        // `viewport-fit=cover` is what makes every `env(safe-area-inset-*)` above
        // resolve to a real inset on a notched phone; without it the meta ships 0.
        const document = readFileSync(join(SKIN_DIR, '..', '..', '..', 'index.html'), 'utf-8');
        expect(document).toContain('viewport-fit=cover');
    });
});

describe('the composer metadata line: pickers left, token count right', () => {
    // The other half of the composer's markup contract is CSS, and the skin is never
    // rendered in this suite — so, exactly as for the breakpoints, the declarations are
    // read as text. The counter is the LAST track of the composer's single metadata
    // row and that track claims the free space, which is what makes the live count read
    // `7925 Tokens` against the right edge, with no label and no row of its own.
    it('gives the counter the free space at the right edge of the metadata row', () => {
        const source = readSkin('composer.css');
        // ONE flex track for the metadata, still free to wrap on a narrow column.
        expect(/\.station \.composer__meta \{[^}]*display: flex;[^}]*flex-wrap: wrap/.test(source)).toBe(true);
        // The picker strip is the growing track, so it cannot push the count over the
        // edge; its labels ellipsise instead (`.composer__pick-text`).
        expect(/\.composer__row \{[^}]*flex: 1 1 auto/.test(source)).toBe(true);
        // `margin-left: auto` — the last value of the shorthand — is the alignment
        // itself; a plain `margin: 0` (the pre-change rule) fails this.
        expect(/\.station \.composer__usage \{[^}]*margin: 0 0 0 auto/.test(source)).toBe(true);
    });

    it('ships no trace of the keyboard hint rule', () => {
        // The element that carried the `Enter sends, Shift+Enter adds a newline` copy is
        // gone, so a rule for it would be dead weight: the class may not appear in this
        // stylesheet at all, in either layout.
        expect(readSkin('composer.css')).not.toContain('composer__help');
    });
});

describe('the rail opens on its content, not on a caption', () => {
    // The sidebar column used to start with a head line reading "Rail" — the name of the
    // layout slot, not of what is in it — one row above the board's own "Conversations"
    // heading. The line is gone by request, so the sheet may not still style it and the
    // component may not still emit it: the same two-sided pin the aside's chevron gets, for
    // the same reason (a rule styling nothing is dead weight, an element with no rule is a
    // UA default the skin never agreed to).
    it('ships no `.rail__bar` / `.rail__label` rule, and no caption element', () => {
        const source = declarationsOf('sessions.css');
        expect(/\.rail__bar\s*\{/.test(source)).toBe(false);
        expect(/\.rail__label\s*\{/.test(source)).toBe(false);

        const markup = markupOf('ChatSidebar.tsx');
        expect(markup).not.toContain('rail__bar');
        expect(markup).not.toContain('rail__label');
        expect(markup).not.toContain('>Rail<');

        // What the column DOES start with keeps its rules: the board's heading + count, and
        // the panel edge they sit on is `.rail`'s own `gap`, not a caption row.
        expect(source).toContain('.station .rail__heading');
        expect(source).toContain('.station .rail__heading-text');
    });
});

describe('the single header title and its configuration dialog', () => {
    // T3's header work is invisible to every render test in this suite (no test mounts
    // a stylesheet), so the declarations are the mechanical evidence: the title box is
    // the ellipsis box, the settings control survives the phone layout, and the old bar
    // copy left the skin when it left the markup.
    it('makes the one title box the truncation box, at every width', () => {
        // Comments stripped first, exactly as `narrowBlockIn` does: the skin documents
        // its decisions between declarations, and those words must not decide an
        // assertion about the declarations.
        const source = declarationsOf('base.css');

        // R1: one title at every width, so `text-overflow` lives on `.station__brand`
        // itself rather than on a phone-only span that the desktop rule hid.
        expect(
            /\.station__brand \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis/.test(source)
        ).toBe(true);
        // The version moved out of the chip and into the title, so the actions row has
        // to claim the right edge on its own — otherwise the settings button would sit
        // against the title on desktop.
        expect(/\.station__actions \{[^}]*margin-left: auto/.test(source)).toBe(true);

        // R1/R2: the bar copy and the brand span pair that CSS used to arbitrate between
        // are gone from the sheet, not merely unrendered. `chip--brand` joins the list for
        // the same reason (T5): its producer, the bar's version chip, left the markup, so
        // the rule was styling an element nothing renders.
        for (const removed of [
            'station__brand-name',
            'station__brand-compact',
            'station__tagline',
            'station__note',
            'chip--brand'
        ]) {
            expect(source).not.toContain(removed);
        }
    });

    it('floats the configuration dialog above the station on both layouts', () => {
        const source = declarationsOf('settings.css');

        // R3: the popup is a fixed overlay, centred by auto margins (no transform, so it
        // never becomes the containing block of its own fixed descendants — the trap the
        // drawers document at sessions.css:48-50), over a full-viewport dismiss target.
        const panelRule = /\.station \.settings-dialog \{([^}]*)\}/.exec(source);
        expect(panelRule).not.toBeNull();
        const panel = (panelRule?.[1] ?? '').replace(/\s+/g, ' ');
        expect(panel).toContain('position: fixed');
        expect(panel).toContain('margin: auto');
        expect(panel).toContain('z-index: 41');
        expect(panel).not.toContain('transform');

        const backdropRule = /\.station \.settings-dialog__backdrop \{([^}]*)\}/.exec(source);
        expect(backdropRule).not.toBeNull();
        const backdrop = (backdropRule?.[1] ?? '').replace(/\s+/g, ' ');
        expect(backdrop).toContain('position: fixed');
        expect(backdrop).toContain('inset: 0');
        // The literal pair: the panel paints above the target that dismisses it, and both
        // sit over the phone drawers (20) and their corner controls (30).
        expect(backdrop).toContain('z-index: 40');

        // A phone gets the SAME overlay, narrowed — the phone bar's only settings affordance.
        expect(narrowBlockIn(source, 899)['.station .settings-dialog']).toContain(
            'width: calc(100% - 24px)'
        );
    });

    it('ships no palette swatch rules (R2)', () => {
        // The skin has one dark theme and no skin switch, so the live palette list that
        // used to sit under the settings groups is gone — and its rules would be dead
        // weight in the sheet, exactly like a rendered-but-inert control. The header
        // comment may still NAME the removed vocabulary; the rules may not still ship it.
        const source = declarationsOf('settings.css');
        expect(source).not.toContain('.station .swatches');
        expect(source).not.toContain('--swatch-size:');
    });
});

describe('the aside column: no corner control at any width', () => {
    // The drawer's toggle used to be a chevron this column pinned to the phone bar's
    // top-right corner: `.inspector__menu btn btn--ghost btn--icon`, testid `aside-toggle`.
    // `.btn--icon` sets `display: inline-flex`, so the desktop `display: none` had to be
    // authored AFTER that primitive to win the cascade on equal specificity — written
    // higher up the sheet, the primitive won, the glyph painted on desktop, and
    // `.station__region > * { flex: 1 1 auto }` stretched it into a full-height block over
    // the inspector column: the "huge chevron". The whole arrangement — rule, cascade gate,
    // phone re-win — is gone by request. The composer's token counter is the drawer's
    // control now (the case below pins what that costs the sheet). The stylesheet is text no
    // render test can see, so the ABSENCE is pinned as text, in both layouts and in the
    // markup that would have produced the element.
    it('ships no inspector corner control, in either layout or in the markup', () => {
        const source = declarationsOf('base.css');

        // NO RULE ANYWHERE: neither the desktop layout nor the phone's declares the class.
        expect(/\.inspector__menu\s*\{/.test(source)).toBe(false);
        expect(narrowBlockIn(source, 899)['.station .inspector__menu']).toBeUndefined();

        // AND NO ELEMENT: a re-added button that lost its rule would paint as a bare UA
        // glyph in the corner, which is exactly the bug this column already shipped once.
        // (Comments come out first — this file EXPLAINS the removal in prose that names the
        // class and the testid, and prose must not decide an assertion about the render.)
        const markup = markupOf('ChatInspector.tsx');
        expect(markup).not.toContain('inspector__menu');
        expect(markup).not.toContain('aside-toggle');

        // THE RAIL KEEPS ITS CORNER CONTROL. Only the aside's glyph was removed, and the
        // asymmetry is deliberate: a hamburger has no readout to double as a control.
        expect(narrowBlockIn(readSkin('sessions.css'), 899)['.station .rail__menu']).toContain(
            'z-index: 30'
        );
    });

    it('makes the composer counter a real control, reset to read as metadata', () => {
        const source = declarationsOf('composer.css');

        // The counter became a <button>, so the sheet owes a RESET: a UA button brings a
        // border, a background, padding, its own `font` and — on a mobile engine — native
        // control styling, any of which would put a second piece of chrome on the ONE line
        // the picker labels share. `margin: 0 0 0 auto` stays the first declaration, i.e.
        // the alignment the case above pins is untouched.
        const counter = /\.station \.composer__usage \{([^}]*)\}/.exec(source);
        expect(counter).not.toBeNull();
        const declarations = (counter?.[1] ?? '').replace(/\s+/g, ' ');
        expect(declarations).toContain('margin: 0 0 0 auto');
        for (const reset of [
            'padding: 0',
            'border: 0',
            'appearance: none',
            'background: none',
            'font: inherit'
        ]) {
            expect(declarations).toContain(reset);
        }

        // CLICKABLE ONLY WHERE IT IS A CONTROL: the pointer appears in the 899 block and
        // nowhere else, which is also why no hover rule is authored for it.
        expect(narrowBlockIn(source, 899)['.station .composer__usage']).toBe('cursor: pointer');

        // And visible to the keyboard. base.css's shared focus ring belongs to the
        // `.btn`/`.field` primitives, which this element deliberately is NOT (a `.btn`
        // carries a min-width and padding the metadata line cannot pay for).
        expect(
            /\.station \.composer__usage:focus-visible \{[^}]*outline: 2px solid var\(--accent\)/.test(
                source
            )
        ).toBe(true);
    });

    it('styles the conversation readout in its own file, off the shell sheet', () => {
        // The Chat tab's surface (ConversationInspector.tsx) is a feature surface, so
        // its rules live in inspector.css, not in base.css's shell chrome — the same
        // split agents.css / tools.css make for the other two tabs. The row markup the
        // component emits is matched here, so a renamed class fails the skin rather
        // than silently unstyling the column.
        const source = declarationsOf('inspector.css');
        for (const owned of [
            '.station .inspector__state',
            '.station .inspector__live',
            '.station .inspector__rows',
            '.station .inspector__row',
            '.station .inspector__error'
        ]) {
            expect(source).toContain(owned);
        }
        // A readout row is label + value on one line, and the value breaks inside the
        // 300px column instead of scrolling the region sideways.
        expect(/\.station \.inspector__row dd \{[^}]*overflow-wrap: anywhere/.test(source)).toBe(true);
        // base.css stays blind to the readout's own vocabulary.
        expect(declarationsOf('base.css')).not.toContain('.inspector__rows');
    });
});

describe('the document hint agrees with the dark-only boot (T5)', () => {
    it('claims a dark document, because the station never boots light', () => {
        // index.html is read as text for the same reason the stylesheets are: nothing in
        // this suite renders it. Comments come out FIRST (HTML and CSS alike) — the file
        // explains the decision in prose that names the light palette, and prose must not
        // decide an assertion about the declarations.
        const markup = readFileSync(join(SKIN_DIR, '..', '..', '..', 'index.html'), 'utf-8')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '');

        // T3 made the palette unconditional — `readInitialTheme` returns 'ink'
        // (../plugins/theme.ts) — so a `light dark` document hint was a promise the UI
        // never kept: the browser paints light-native form controls, <option> popups and
        // scrollbars behind a dark station until the React tree mounts and `.station`
        // sets its own hint (tokens.css). The retained Slate palette still overrides it
        // per station, which is a rule, not the document default.
        expect(markup).toContain('color-scheme: dark');
        expect(markup).not.toContain('light dark');

        // The mobile status-bar tint still names the ink surface, so the two cannot drift
        // apart silently if the default palette changes (tokens.css `.station`).
        expect(markup).toContain('name="theme-color" content="#18272f"');
        expect(declarationsOf('tokens.css')).toContain('--surface: #18272f');
    });
});
