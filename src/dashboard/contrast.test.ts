// WCAG 2.1 contrast guard for the DARK (base `.station`) palette in styles/tokens.css.
//
// WHY THIS TEST EXISTS: the skin is a colour system nobody in this suite renders, so a
// palette edit is invisible to every other test — and the current brief is "bright, but
// still dark", a tradeoff that drifts in both directions. Reverting toward near-black
// costs nothing mechanically, and lifting the surfaces too far silently turns the
// workstation into a washed-out midtone with unreadable muted text. Both are pinned
// numerically here: eleven fg/bg pairs at explicit minimums, plus an absolute
// luminance ceiling on `--surface` and the surface < raised < text ordering, so
// "bright dark" cannot become "light" or "flat" without a failure naming the pair.
//
// WHY `node:fs` AND NOT `./tokens.css?raw`: vitest stubs CSS requests (default
// `test.css: false`), so a raw import yields an empty string; see
// src/dashboard/styles/skin.test.ts:13-17 for the full rationale. This file sits one
// level ABOVE styles/ so that skin.test.ts's sorted stylesheet listing (its :59-70)
// is not disturbed by a new `*.test.ts` neighbour.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** A resolved sRGB colour as 0-255 encoded (non-linear) channels. */
type Channels = [number, number, number];

/** The palette's source of truth. */
const TOKENS = readFileSync(join(__dirname, 'styles', 'tokens.css'), 'utf-8');

/**
 * The base `.station` block body, i.e. the DARK theme. The pattern is anchored on
 * `^` at both ends so the light override (`.station[data-theme='slate'] {`), the
 * density block and the descendant rules (`.station .rail {`) can never be mistaken
 * for it — only the bare `.station {` selector matches.
 */
const darkBlock = (): string => {
    const match = /^\.station\s*\{([\s\S]*?)^\}/m.exec(TOKENS);
    if (match === null) throw new Error('tokens.css: the base `.station` dark block is gone');
    return match[1];
};

/** One 6-digit hex token from the dark block; a missing/renamed token throws. */
const hexOf = (block: string, name: string): string => {
    const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(block);
    if (match === null) throw new Error(`tokens.css: --${name} is missing from the dark block`);
    return match[1].toLowerCase();
};

/**
 * The `--accent-soft` mix percentage, read out of the real `color-mix()` declaration
 * rather than hardcoded, so raising or lowering the tint is followed by the guard.
 * The declaration's shape is pinned by the pattern itself: reformatting it fails loudly
 * instead of silently dropping the pair.
 */
const accentSoftPercent = (block: string): number => {
    const match =
        /--accent-soft:\s*color-mix\(\s*in srgb,\s*var\(--accent\)\s+(\d+(?:\.\d+)?)%,\s*var\(--surface\)\s*\)\s*;/.exec(block);
    if (match === null) throw new Error('tokens.css: --accent-soft is no longer an accent/surface color-mix');
    return Number(match[1]);
};

/** `#rrggbb` -> encoded channels. */
const decode = (hex: string): Channels =>
    [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as Channels;

/**
 * `color-mix(in srgb, A n%, B)` for two opaque colours: the browser composites in
 * premultiplied sRGB, which for alpha 1 reduces to a straight lerp of the ENCODED
 * (gamma'd) channel values — not of linear light. `transparent` is premultiplied
 * rgb(0,0,0,0), so mixing an opaque colour with it keeps that colour at partial alpha;
 * painting that over `--surface` lands on the same lerp, which is why the 6% role-row
 * tints below are modelled as `mix(colour, 6%, surface)`.
 */
const mix = (a: Channels, percent: number, b: Channels): Channels => {
    const n = percent / 100;
    return a.map((channel, index) => Math.round(channel * n + b[index] * (1 - n))) as Channels;
};

/** WCAG 2.1 relative luminance. */
const luminance = ([r, g, b]: Channels): number => {
    // Each channel is linearised, then weighted by the eye's sensitivity to it.
    const linear = (channel: number): number => {
        const encoded = channel / 255;
        return encoded <= 0.03928 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};

/** WCAG 2.1 contrast ratio, always expressed as >= 1 regardless of which side is lighter. */
const contrast = (fg: Channels, bg: Channels): number => {
    const a = luminance(fg);
    const b = luminance(bg);
    const [light, dark] = a >= b ? [a, b] : [b, a];
    return (light + 0.05) / (dark + 0.05);
};

/** Two decimals: ratios are reported and asserted at the precision WCAG is quoted at. */
const round = (value: number): number => Math.round(value * 100) / 100;

const toHex = ([r, g, b]: Channels): string =>
    `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;

describe('the dark palette clears its contrast floor and stays dark', () => {
    const block = darkBlock();
    const surface = decode(hexOf(block, 'surface'));
    const raised = decode(hexOf(block, 'raised'));
    const text = decode(hexOf(block, 'text'));
    const muted = decode(hexOf(block, 'muted'));
    const accent = decode(hexOf(block, 'accent'));
    const warn = decode(hexOf(block, 'warn'));
    const assistant = decode(hexOf(block, 'assistant'));
    const system = decode(hexOf(block, 'system'));
    const danger = decode(hexOf(block, 'danger'));

    // Tinted backgrounds the shell paints *on top of* the surface, so foreground text
    // is measured against the resolved tint rather than against `--surface`. The
    // percentages mirror the call sites, and the `reads the same tint percentages` test
    // below fails if a stylesheet moves without this guard moving with it.
    const tints = {
        danger: mix(danger, 12, surface), // base.css:288 / transcript.css:60
        warn: mix(warn, 14, surface), // base.css:282
        system: mix(system, 6, surface), // transcript.css:157 (6% over transparent, on surface)
        accentSoft: mix(accent, accentSoftPercent(block), surface) // tokens.css:38
    };

    // label -> [foreground, background, minimum ratio]. Minimums sit above the WCAG AA
    // body-text floor (4.5:1) because this is a dense, monospace operator UI read at 11-13px.
    const pairs: Array<[string, Channels, Channels, number]> = [
        ['--text on --surface', text, surface, 12],
        ['--text on --raised', text, raised, 10],
        ['--muted on --surface', muted, surface, 6.5],
        ['--muted on --raised', muted, raised, 6],
        ['--accent on --surface', accent, surface, 8],
        ['--assistant on --surface', assistant, surface, 8],
        ['--danger on danger 12% tint', danger, tints.danger, 5.5],
        ['--warn on warn 14% tint', warn, tints.warn, 5.5],
        [`--text on --accent-soft (${accentSoftPercent(block)}%)`, text, tints.accentSoft, 7],
        [`--accent on --accent-soft (${accentSoftPercent(block)}%)`, accent, tints.accentSoft, 4.5],
        ['--muted on system 6% tint', muted, tints.system, 6]
    ];

    it.each(pairs)('%s', (label, fg, bg, min) => {
        const measured = round(contrast(fg, bg));
        // The message names the pair, both resolved colours and the measured ratio: a
        // failure has to say what to fix, not just that a number was too small.
        expect(
            measured,
            `${label}: ${measured.toFixed(2)}:1 < ${min}:1 (${toHex(fg)} on ${toHex(bg)})`
        ).toBeGreaterThanOrEqual(min);
    });

    it('still reads as a dark theme, not a washed-out midtone', () => {
        // Absolute ceiling: near-black was 0.0064, the brightened surface is 0.0185.
        // Crossing 0.05 means the base is a midtone and "dark theme" is a lie.
        expect(round(luminance(surface))).toBeLessThan(0.05);

        // Ordering: surface < raised < text. A palette that flattens these three loses
        // the elevation cue and the text stop alike.
        expect(luminance(surface)).toBeLessThan(luminance(raised));
        expect(luminance(raised)).toBeLessThan(luminance(text));

        // Native form controls/scrollbars still paint dark.
        expect(block).toContain('color-scheme: dark');
    });

    it('keeps the role-rail twins identical to their source tokens', () => {
        // transcript.css paints user turns with --user and system turns with --system;
        // both are deliberately the accent/muted colour, and a divergence shows up as
        // two different teals in one transcript.
        expect(hexOf(block, 'user')).toBe(hexOf(block, 'accent'));
        expect(hexOf(block, 'system')).toBe(hexOf(block, 'muted'));
    });

    it('reads the same tint percentages the stylesheets still paint with', () => {
        // Guard for the hardcoded percentages above: each tint declaration has to still
        // exist verbatim in the stylesheet that uses it, or the pair maths is stale.
        const declarations: Array<[string, string]> = [
            ['base.css', 'color-mix(in srgb, var(--danger) 12%, var(--surface))'],
            ['transcript.css', 'color-mix(in srgb, var(--danger) 12%, var(--surface))'],
            ['base.css', 'color-mix(in srgb, var(--warn) 14%, var(--surface))'],
            ['transcript.css', 'color-mix(in srgb, var(--system) 6%, transparent)']
        ];
        const offenders = declarations
            .filter(([file, declaration]) => !readFileSync(join(__dirname, 'styles', file), 'utf-8').includes(declaration))
            .map(([file, declaration]) => `${file}: ${declaration}`);
        expect(offenders).toEqual([]);
    });
});
