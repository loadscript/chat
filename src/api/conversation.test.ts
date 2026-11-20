// The transport-neutral conversation model (api/conversation.ts) — the module
// that replaced the deleted `/v1/chat-assistant` REST client.
//
// Two things are worth pinning exactly, because BOTH transports and the whole
// plugin graph read them:
//   - the title rule, which the old SERVER applied and which the client now
//     applies itself (a harness session's title is never derived from the
//     transcript), and
//   - the tracked-id cache, which is the sidebar's scoping authority on both
//     modes and must survive a corrupt or hand-edited localStorage entry.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    CONVERSATION_POLL_INTERVAL_MS,
    CONVERSATION_TITLE_MAX_CHARS,
    DEFAULT_CONVERSATION_TITLE,
    TRACKED_CONVERSATIONS_KEY,
    deriveConversationTitle,
    isConversationPending,
    readTrackedConversationIds,
    storeTrackedConversationIds,
    trackConversationId,
    untrackConversationId
} from './conversation';

describe('the title rule (identical to the pre-rebuild server)', () => {
    it('uses the first line of the first user turn', () => {
        expect(
            deriveConversationTitle([
                { role: 'system', content: 'A prompt' },
                { role: 'user', content: 'First line\nsecond line' },
                { role: 'assistant', content: 'Answer' }
            ])
        ).toBe('First line');
    });

    it('trims and caps at 80 characters, with an ellipsis', () => {
        const long = 'x'.repeat(200);
        const title = deriveConversationTitle([{ role: 'user', content: long }]);

        expect(title.length).toBe(CONVERSATION_TITLE_MAX_CHARS);
        expect(title).toBe(`${'x'.repeat(77)}...`);
        expect(title.length).toBeLessThanOrEqual(200);
    });

    it('falls back to the default title when no user turn contributes one', () => {
        expect(deriveConversationTitle([])).toBe(DEFAULT_CONVERSATION_TITLE);
        expect(deriveConversationTitle([{ role: 'system', content: 'prompt only' }])).toBe(
            DEFAULT_CONVERSATION_TITLE
        );
        expect(deriveConversationTitle([{ role: 'user', content: '   \n  ' }])).toBe(
            DEFAULT_CONVERSATION_TITLE
        );
    });
});

describe('the tracked-id cache (the sidebar scope)', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    afterEach(() => {
        window.localStorage.clear();
    });

    it('persists under the pre-rebuild key, so an upgrade restores the same scope', () => {
        expect(TRACKED_CONVERSATIONS_KEY).toBe('chat-assistant:tracked-conversations');
    });

    it('starts empty and degrades to empty on a corrupt entry', () => {
        expect(readTrackedConversationIds()).toEqual([]);

        window.localStorage.setItem(TRACKED_CONVERSATIONS_KEY, 'not json');
        expect(readTrackedConversationIds()).toEqual([]);

        window.localStorage.setItem(TRACKED_CONVERSATIONS_KEY, JSON.stringify({ id: 'shape' }));
        expect(readTrackedConversationIds()).toEqual([]);

        // Non-strings and duplicates are dropped rather than thrown away loudly:
        // a hand-edited cache must not break the sidebar query.
        window.localStorage.setItem(TRACKED_CONVERSATIONS_KEY, JSON.stringify(['a', 3, '', 'a', null]));
        expect(readTrackedConversationIds()).toEqual(['a']);
    });

    it('tracks once, untracks after a delete, and keeps the insertion order', () => {
        expect(trackConversationId('conv-1')).toEqual(['conv-1']);
        expect(trackConversationId('conv-2')).toEqual(['conv-1', 'conv-2']);
        // Re-tracking an existing id is a no-op, so repeated sends on a restored
        // conversation never duplicate the row.
        expect(trackConversationId('conv-1')).toEqual(['conv-1', 'conv-2']);
        expect(untrackConversationId('conv-1')).toEqual(['conv-2']);
        expect(readTrackedConversationIds()).toEqual(['conv-2']);
    });

    it('normalizes a bulk write and keeps it best-effort', () => {
        expect(storeTrackedConversationIds(['a', 'a', '', 'b'])).toEqual(['a', 'b']);
        expect(JSON.parse(window.localStorage.getItem(TRACKED_CONVERSATIONS_KEY) as string)).toEqual(['a', 'b']);
    });
});

describe('the in-flight vocabulary', () => {
    it('treats only pending as pollable', () => {
        expect(isConversationPending('pending')).toBe(true);
        expect(isConversationPending('complete')).toBe(false);
        expect(isConversationPending('error')).toBe(false);
    });

    it('keeps the offline poll cadence at two seconds', () => {
        expect(CONVERSATION_POLL_INTERVAL_MS).toBe(2000);
    });
});
