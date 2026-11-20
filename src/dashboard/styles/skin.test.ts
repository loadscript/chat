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
                '.station .inspector__menu',
                '.station .inspector__scrim',
                ".station .inspector[data-open='true']",
                ".station[data-theme='slate']",
                '.station__bar',
                '.station__brand',
                '.station__brand-compact',
                '.station__brand-name',
                '.station__grid',
                '.station__region--sidebar, .station__region--aside',
                '.station__tagline, .station__chips, .station__actions, .station__note'
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
        // corner controls. `nowrap` is the single-line guarantee; the four hidden
        // children are the other half of it.
        expect(rules['.station__bar']).toContain('flex-wrap: nowrap');
        expect(rules['.station__bar']).toContain('min-height: var(--mobile-bar)');
        expect(rules['.station__bar']).toContain('env(safe-area-inset-top');
        expect(rules['.station__brand']).toContain('text-transform: none');
        expect(rules['.station__brand-compact']).toContain('text-overflow: ellipsis');
        expect(rules['.station__brand-name']).toBe('display: none');
        expect(rules['.station__tagline, .station__chips, .station__actions, .station__note']).toBe(
            'display: none'
        );

        // THE RIGHT DRAWER: the aside mirrors the rail — off the right edge, a full
        // viewport scrim, the same 160ms transform language, literal z-index pair.
        expect(rules['.station .inspector']).toContain('transform: translateX(105%)');
        expect(rules['.station .inspector']).toContain('transition: transform 160ms ease');
        expect(rules['.station .inspector']).toContain('z-index: 20');
        expect(rules['.station .inspector']).toContain('padding-top: calc(var(--mobile-bar) + var(--pad))');
        expect(rules['.station .inspector__scrim']).toContain('inset: 0');
        expect(rules['.station .inspector__scrim']).toContain('z-index: 10');
        expect(rules['.station .inspector__menu']).toContain('right: 8px');
        expect(rules['.station .inspector__menu']).toContain('z-index: 30');

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
        expect(footer['.station .composer__help, .station .composer__usage']).toBe('display: none');

        // `viewport-fit=cover` is what makes every `env(safe-area-inset-*)` above
        // resolve to a real inset on a notched phone; without it the meta ships 0.
        const document = readFileSync(join(SKIN_DIR, '..', '..', '..', 'index.html'), 'utf-8');
        expect(document).toContain('viewport-fit=cover');
    });
});
