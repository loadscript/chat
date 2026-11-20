// The harness WebSocket client (R2: streamed replies), driven frame by frame.
//
// WHY THIS FILE IS A PROTOCOL TEST AND NOT A SOCKET TEST: the transport is the
// platform's, and the harness server is the authority on the frames. What this
// package owns — and what can only be proved here — is the CLIENT SIDE of the
// contract: the subscribe frames it sends, the subprotocol it negotiates, the way
// `display.ops` fold into the answer text, the arithmetic that detects a dropped
// frame, the bounded REST re-read that recovers from one, the heartbeat deadline
// that gives up on a silent peer, and the resume state a reconnect replays.
//
// Every frame is hand-written in the harness's own wire spelling (snake_case,
// `subscription_id`, `sequence`, `cursor`), and every assertion is an exact
// value: the emitted frame objects, the accumulated strings, the close codes and
// the timer delays. The clock and the socket are injected, so nothing here races
// a real timeout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    HARNESS_WS_LIMITS,
    HARNESS_WS_SUBPROTOCOL,
    createHarnessStream,
    isTerminalTurnStatus,
    type StreamScheduler,
    type StreamSocket,
    type StreamSocketFactory
} from './harness-stream';
import type { HarnessStreamEvents } from './harness-stream';

// ---------------------------------------------------------------------------
// The socket double
// ---------------------------------------------------------------------------

type FakeSocket = StreamSocket & {
    /** Every frame this client sent, parsed back into objects. */
    sent: any[];
    /** Push one server frame in, exactly as `onmessage` would. */
    receive: (frame: unknown) => void;
    /** Fire `onopen`. */
    open: () => void;
    /** Fire `onclose`. */
    shut: (code?: number) => void;
    closedWith: { code?: number; reason?: string } | null;
};

const sockets: FakeSocket[] = [];

const fakeFactory: StreamSocketFactory = (): StreamSocket => {
    const socket = {
        sent: [] as any[],
        closedWith: null as { code?: number; reason?: string } | null,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send: (data: string) => {
            socket.sent.push(JSON.parse(data));
        },
        close: (code?: number, reason?: string) => {
            socket.closedWith = { code, reason };
        }
    } as unknown as FakeSocket;

    socket.receive = (frame: unknown): void => {
        socket.onmessage?.({ data: JSON.stringify(frame) });
    };
    socket.open = (): void => {
        socket.onopen?.();
    };
    socket.shut = (code?: number): void => {
        socket.onclose?.({ code });
    };

    sockets.push(socket);

    return socket;
};

const last = (): FakeSocket => sockets[sockets.length - 1];

// ---------------------------------------------------------------------------
// The clock double: every scheduled callback is captured, never fired by time
// ---------------------------------------------------------------------------

type Timer = { run: () => void; ms: number };
let timers: Timer[] = [];

const scheduler: StreamScheduler = (fn, ms) => {
    const timer = { run: fn, ms };

    timers.push(timer);

    return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
    };
};

const timersFor = (kind: 'heartbeat' | 'reconnect'): Timer[] =>
    // The heartbeat deadline is always `interval * intervals`; a reconnect backoff
    // is 500ms or more. The two are therefore distinguishable without a label.
    kind === 'heartbeat'
        ? timers.filter((timer) => timer.ms === HARNESS_WS_LIMITS.heartbeat_interval_ms * HARNESS_WS_LIMITS.heartbeat_timeout_intervals)
        : timers.filter((timer) => timer.ms !== HARNESS_WS_LIMITS.heartbeat_interval_ms * HARNESS_WS_LIMITS.heartbeat_timeout_intervals);

// ---------------------------------------------------------------------------
// Frames, in the harness's own spelling
// ---------------------------------------------------------------------------

const WELCOME = {
    type: 'welcome',
    protocol: HARNESS_WS_SUBPROTOCOL,
    epoch: 'epoch-1',
    at: 1,
    limits: { ...HARNESS_WS_LIMITS }
};

const state = (subscriptionId: string, scope: string, sequence = 0, cursor = `${subscriptionId}-0`): unknown => ({
    type: 'subscription_state',
    subscription_id: subscriptionId,
    scope,
    epoch: 'epoch-1',
    sequence,
    cursor,
    revisions: [],
    publishes: []
});

const update = (subscriptionId: string, sequence: number, payload: Record<string, unknown>): unknown => ({
    type: 'update',
    subscription_id: subscriptionId,
    sequence,
    cursor: `${subscriptionId}-${sequence}`,
    at: sequence,
    ...payload
});

const SESSION_ID = 'sess-1';
const TURN_ID = 'turn-1';

// The conversation's ENTRY agent — the identity the answer fold keys on
// (api/harness.ts `isAnswerSection`: root-shaped AND this agent). Every section a
// test opens with `agent: ENTRY_AGENT` is the answer; every other agent's flow is
// a child section, parentless or not.
const ENTRY_AGENT = 'instruct';

/** Open a client, connect it, and accept the two subscriptions it asks for. */
const connected = (
    events: HarnessStreamEvents = {},
    turnIds: readonly string[] = [TURN_ID],
    entryAgentId: string = ENTRY_AGENT
) => {
    const handle = createHarnessStream({
        sessionId: SESSION_ID,
        entryAgentId,
        turnIds,
        socketUrl: '/v1/harness/stream',
        socketFactory: fakeFactory,
        schedule: scheduler,
        readText: readText,
        events
    });

    handle.connect();

    const socket = last();

    socket.open();
    socket.receive(WELCOME);

    const subscriptions = socket.sent.filter((frame) => frame.type === 'subscribe');

    subscriptions.forEach((frame) => {
        socket.receive(state(frame.subscription_id, frame.scope));
    });

    return { handle, socket, sessionSub: subscriptions[0].subscription_id, turnSub: subscriptions[1]?.subscription_id };
};

// The bounded REST re-read the gap/resync paths call. Every call is recorded so
// "a re-read happened" is an assertion, not a hope.
const reads: Array<{ sessionId: string; turnId: string }> = [];
let readText = async (_sessionId: string, _turnId: string): Promise<string> => 'canonical answer';

beforeEach(() => {
    sockets.length = 0;
    timers = [];
    reads.length = 0;
    readText = async (sessionId: string, turnId: string): Promise<string> => {
        reads.push({ sessionId, turnId });

        return 'canonical answer';
    };
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('connecting and subscribing', () => {
    it('dials this origin on the harness stream path with the harness subprotocol', () => {
        connected();

        expect(sockets).toHaveLength(1);
        // A root-relative path upgrades on the PAGE origin, scheme-matched: the
        // packaged server and the dev proxy are both same-origin by design.
        expect(window.location.origin).toBe('http://localhost:3000');
        expect(HARNESS_WS_SUBPROTOCOL).toBe('harness.v1');
    });

    it('subscribes the session scope and each turn scope, in the contract spelling', () => {
        const { socket } = connected();

        expect(socket.sent).toEqual([
            { type: 'subscribe', subscription_id: 'ca-1', scope: 'session', session_id: SESSION_ID, pace: 'ordered' },
            { type: 'subscribe', subscription_id: 'ca-2', scope: 'turn', session_id: SESSION_ID, turn_id: TURN_ID, pace: 'ordered' }
        ]);
    });

    it('sends hello FIRST on a reconnect, and only when there is a position to resume', () => {
        const { handle, socket } = connected();

        // A first connection has nothing to resume: no hello frame at all.
        expect(socket.sent.some((frame) => frame.type === 'hello')).toBe(false);

        socket.receive(update('ca-1', 1, { kind: 'session.updated', session: { status: 'running' } }));
        socket.shut();

        handle.connect();
        const next = last();

        next.open();
        next.receive(WELCOME);

        expect(next.sent[0]).toEqual({
            type: 'hello',
            protocol: HARNESS_WS_SUBPROTOCOL,
            epoch: 'epoch-1',
            cursor: 'ca-1-1'
        });
        // Every subscription is re-registered after a reconnect.
        expect(next.sent.filter((frame) => frame.type === 'subscribe')).toHaveLength(2);
    });

    it('reports the epoch and cursor it applied', () => {
        const { handle, socket } = connected();

        // Every `subscription_state` stamps the resume position, so both baselines
        // (session, then turn) have already moved it.
        expect(handle.resumeState()).toEqual({ epoch: 'epoch-1', cursor: 'ca-2-0' });

        socket.receive(update('ca-1', 1, { kind: 'session.updated', session: {} }));
        expect(handle.resumeState()).toEqual({ epoch: 'epoch-1', cursor: 'ca-1-1' });
    });
});

describe('the display fold', () => {
    it('folds own-flow text-node appends into one accumulating answer', () => {
        const deltas: string[] = [];
        const { socket } = connected({ onText: (text) => deltas.push(text) });

        socket.receive(
            update('ca-2', 1, {
                kind: 'display.ops',
                turn_id: TURN_ID,
                ops: [
                    // A section with NO `parentSectionId` is one of the turn's own
                    // flows, which is what puts its text in the answer (`rank` is the
                    // agent's authority letter and decides nothing here).
                    { op: 'section:open', turnId: TURN_ID, section: { id: 'sec-1', rank: 'A', agent: 'instruct' } },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec-1', node: { id: 'n-1', kind: 'text', text: 'Two ' } },
                    { op: 'node:append', turnId: TURN_ID, sectionId: 'sec-1', nodeId: 'n-1', delta: 'and two ' },
                    { op: 'node:append', turnId: TURN_ID, sectionId: 'sec-1', nodeId: 'n-1', delta: 'make four.' }
                ]
            })
        );

        // The insert carries the first chunk, so it paints too: the surface never
        // waits for a delta to show text it already has.
        expect(deltas).toEqual(['Two ', 'Two and two ', 'Two and two make four.']);
    });

    it('keeps reasoning and delegated-child text out of the answer', () => {
        const answers: string[] = [];
        const thoughts: string[] = [];
        const { socket } = connected({ onText: (text) => answers.push(text), onReasoning: (text) => thoughts.push(text) });

        socket.receive(
            update('ca-2', 1, {
                kind: 'display.ops',
                turn_id: TURN_ID,
                ops: [
                    { op: 'section:open', turnId: TURN_ID, section: { id: 'sec-p', rank: 'A', agent: 'instruct' } },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec-p', node: { id: 'r-1', kind: 'reasoning' } },
                    { op: 'node:append', turnId: 'turn-1', sectionId: 'sec-p', nodeId: 'r-1', delta: 'hmm ' },
                    { op: 'node:append', turnId: TURN_ID, sectionId: 'sec-p', nodeId: 'r-1', delta: 'let me see' },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec-p', node: { id: 't-1', kind: 'text', text: 'Four.' } },
                    // A delegated child section's text belongs to that section's pane:
                    // the server gave it a `parentSectionId`, and that nesting — not the
                    // rank letter — is what keeps it out of the answer.
                    { op: 'section:open', turnId: TURN_ID, section: { id: 'sec-s', rank: 'B', parentSectionId: 'sec-p', agent: 'reviewer' } },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec-s', node: { id: 't-2', kind: 'text', text: 'delegated' } }
                ]
            })
        );

        expect(thoughts).toEqual(['hmm ', 'hmm let me see']);
        expect(answers).toEqual(['Four.']);
    });

    it('groups the answer by NESTING and never by the rank letter', () => {
        // WHY THIS TEST EXISTS (R83, the two scenarios the rank model allows): the
        // fold used to read `section.role === 'primary'`, which collapses two facts
        // the new model separates — "whose answer is this" and "how much authority
        // does this agent have". Neither half may leak back in:
        //   - the ENTRY agent may hold ANY letter, so the turn's own flow is Rank B
        //     here and its text must still reach `onText`;
        //   - any number of agents share a rank, and a branch/fork PROPAGATES its
        //     source agent's rank (types/index.ts), so a nested flow legitimately
        //     carries Rank A here — a rank filter would fold its text into the
        //     answer and print a delegated child's prose as the assistant's reply.
        const answers: string[] = [];
        const { handle, socket } = connected({ onText: (text) => answers.push(text) });

        socket.receive(
            update('ca-2', 1, {
                kind: 'display.ops',
                turn_id: TURN_ID,
                ops: [
                    { op: 'section:open', turnId: TURN_ID, section: { id: 'sec-entry', rank: 'B', agent: 'instruct' } },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec-entry', node: { id: 't-1', kind: 'text', text: 'the answer' } },
                    { op: 'section:open', turnId: TURN_ID, section: { id: 'sec-nested', rank: 'A', parentSectionId: 'sec-entry', agent: 'reviewer' } },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec-nested', node: { id: 't-2', kind: 'text', text: ' — delegated' } }
                ]
            })
        );

        // Only the parentless flow's text is emitted, in insertion order, and the
        // accumulated snapshot agrees with what the caller was streamed.
        expect(answers).toEqual(['the answer']);
        expect(handle.textOf(TURN_ID)).toBe('the answer');
    });

    it('keeps a PARENTLESS lane belonging to a NON-entry agent out of the answer', () => {
        // R85/R86, the streaming twin of the REST read: a DELEGATED lane can arrive
        // with NO lineage on its frames — the projector documents that the runtime
        // records some of them with no parent/call/kind/branch (harness
        // turn-projector.ts:1395-1407) and that a post-restart journal carries only
        // `thread.id` (:1595-1610). Such a section is root-shaped, so nesting alone
        // folded 'HELPER PROSE. ' into the chat answer; the entry agent's IDENTITY is
        // what keeps it in the lane's own pane.
        const answers: string[] = [];
        const { handle, socket } = connected({ onText: (text) => answers.push(text) });

        socket.receive(
            update('ca-2', 1, {
                kind: 'display.ops',
                turn_id: TURN_ID,
                ops: [
                    { op: 'section:open', turnId: TURN_ID, section: { id: 'sec-entry', rank: 'A', agent: ENTRY_AGENT } },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec-entry', node: { id: 't-1', kind: 'text', text: 'ROOT ANSWER. ' } },
                    // Root-shaped (`parentSectionId` absent) and Rank B — and NOT the
                    // entry agent, so it is a child flow.
                    { op: 'section:open', turnId: TURN_ID, section: { id: 'sec-lane', rank: 'B', agent: 'helper' } },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec-lane', node: { id: 't-2', kind: 'text', text: 'HELPER PROSE. ' } },
                    // A DELTA into that lane recomputes the answer snapshot; it must
                    // not grow it (the second emission below is the same text).
                    { op: 'node:append', turnId: TURN_ID, sectionId: 'sec-lane', nodeId: 't-2', delta: 'MORE HELPER. ' }
                ]
            })
        );

        expect(answers).toEqual(['ROOT ANSWER. ', 'ROOT ANSWER. ']);
        expect(handle.textOf(TURN_ID)).toBe('ROOT ANSWER. ');
    });

    it('keeps a threadless `inline:<non-entry>` stream out of the answer', () => {
        // R85, reviewer case C: a stream with NO `thread` metadata at all from a
        // non-entry agent mints the projector's `inline:<agent>` section
        // (turn-projector.ts:1420/inlineSection), which is parentless BY CONSTRUCTION.
        // Under the nesting-only rule its prose was printed as the assistant's reply.
        const answers: string[] = [];
        const { handle, socket } = connected({ onText: (text) => answers.push(text) });

        socket.receive(
            update('ca-2', 1, {
                kind: 'display.ops',
                turn_id: TURN_ID,
                ops: [
                    { op: 'section:open', turnId: TURN_ID, section: { id: 'sec-entry', rank: 'A', agent: ENTRY_AGENT } },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec-entry', node: { id: 't-1', kind: 'text', text: 'ROOT ANSWER. ' } },
                    { op: 'section:open', turnId: TURN_ID, section: { id: 'inline:helper', rank: 'B', agent: 'helper' } },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'inline:helper', node: { id: 't-2', kind: 'text', text: 'HELPER PROSE. ' } }
                ]
            })
        );

        expect(answers).toEqual(['ROOT ANSWER. ']);
        expect(handle.textOf(TURN_ID)).toBe('ROOT ANSWER. ');
    });

    it('folds the ENTRY agent alone when TWO members hold Rank A and the entry is the SECOND roster member', () => {
        // R87: the scenario the reviewer showed is REACHABLE from this app's own
        // dashboard (`POST /sessions/{id}/agents`, and a runtime binding lands one
        // rank BELOW the lowest stated rank, so the roster spans two letters and
        // `delegate` is declared). Here both members are Rank A and the entry is
        // `reviewer`, the SECOND name of the roster's declaration order
        // (`agents: ['instruct', 'reviewer']`), while `instruct` — the FIRST row —
        // streams a parentless lane:
        //   - a RANK filter would fold both (both are 'A');
        //   - a "first roster member" rule would fold `instruct`'s prose instead.
        // Only the entry identity `entryAgentId` resolves from the frozen definition
        // decides, so the answer is the entry's own flow.
        const answers: string[] = [];
        const { handle, socket } = connected({ onText: (text) => answers.push(text) }, [TURN_ID], 'reviewer');

        socket.receive(
            update('ca-2', 1, {
                kind: 'display.ops',
                turn_id: TURN_ID,
                ops: [
                    { op: 'section:open', turnId: TURN_ID, section: { id: 'sec-entry', rank: 'A', agent: 'reviewer' } },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec-entry', node: { id: 't-1', kind: 'text', text: 'ENTRY ANSWER. ' } },
                    { op: 'section:open', turnId: TURN_ID, section: { id: 'sec-peer', rank: 'A', agent: 'instruct' } },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec-peer', node: { id: 't-2', kind: 'text', text: 'PEER PROSE. ' } }
                ]
            })
        );

        expect(answers).toEqual(['ENTRY ANSWER. ']);
        expect(handle.textOf(TURN_ID)).toBe('ENTRY ANSWER. ');
    });

    it('sends a node whose `section:open` never arrived to the CHILD side, and the gap re-read replaces the fold', async () => {
        // R85, the tolerant default the reviewer called out: a node naming a section
        // this client never saw OPENED used to land on the answer side ("unknown ⇒
        // answer"), which is how foreign prose entered when the open frame was the one
        // that got dropped. The ordering contract (`section:open` precedes every op
        // naming its section) makes that case a DROPPED FRAME, and a dropped frame is
        // a sequence gap: the fold stays conservative and the canonical display
        // re-read replaces it a moment later.
        const answers: string[] = [];
        const resyncs: string[] = [];
        const { socket, handle } = connected({ onText: (text) => answers.push(text), onResync: (reason) => resyncs.push(reason) });

        socket.receive(
            update('ca-2', 1, {
                kind: 'display.ops',
                turn_id: TURN_ID,
                ops: [
                    { op: 'section:open', turnId: TURN_ID, section: { id: 'sec-entry', rank: 'A', agent: ENTRY_AGENT } },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec-entry', node: { id: 't-1', kind: 'text', text: 'ROOT ' } },
                    // No `section:open` for `sec-lane` reached this client.
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec-lane', node: { id: 't-2', kind: 'text', text: 'HELPER ' } }
                ]
            })
        );

        expect(answers).toEqual(['ROOT ']);

        // Sequence 1 then 3: frame 2 (which carried the lane's open) was dropped, so
        // the gap path fires as well. `t-9` is the other conservative shape: a delta
        // whose `node:insert` never arrived, in a section never opened.
        socket.receive(
            update('ca-2', 3, {
                kind: 'display.ops',
                turn_id: TURN_ID,
                ops: [
                    { op: 'node:append', turnId: TURN_ID, sectionId: 'sec-entry', nodeId: 't-1', delta: 'ANSWER' },
                    { op: 'node:append', turnId: TURN_ID, sectionId: 'sec-mystery', nodeId: 't-9', delta: 'FOREIGN ' }
                ]
            })
        );

        expect(resyncs).toEqual(['frames_dropped']);
        // Neither foreign fragment is in either snapshot: 'ROOT ANSWER' is the whole
        // answer the client can prove, and the provisional `t-9` delta never entered.
        expect(answers).toEqual(['ROOT ', 'ROOT ANSWER', 'ROOT ANSWER']);

        await Promise.resolve();
        await Promise.resolve();

        // The bounded REST re-read is the authority: it replaces the fold with the
        // canonical text, which is what the omission costs — nothing.
        expect(reads).toEqual([{ sessionId: SESSION_ID, turnId: TURN_ID }]);
        expect(handle.textOf(TURN_ID)).toBe('canonical answer');
    });

    it('drops exactly the nodes an attempt discard or a node removal names', () => {
        const answers: string[] = [];
        const { socket } = connected({ onText: (text) => answers.push(text) });

        socket.receive(
            update('ca-2', 1, {
                kind: 'display.ops',
                turn_id: TURN_ID,
                ops: [
                    { op: 'section:open', turnId: TURN_ID, section: { id: 'sec', rank: 'A', agent: 'instruct' } },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec', node: { id: 'a', kind: 'text', text: 'kept ' } },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec', node: { id: 'b', kind: 'text', text: 'discarded' } }
                ]
            })
        );

        socket.receive(
            update('ca-2', 2, {
                kind: 'display.ops',
                turn_id: TURN_ID,
                ops: [{ op: 'attempt:discard', turnId: TURN_ID, sectionId: 'sec', nodeIds: ['b'] }]
            })
        );

        // The fold recomputes from the nodes, so the discarded fragment cannot
        // survive in the answer text.
        socket.receive(
            update('ca-2', 3, {
                kind: 'display.ops',
                turn_id: TURN_ID,
                ops: [{ op: 'node:append', turnId: TURN_ID, sectionId: 'sec', nodeId: 'a', delta: '(and kept)' }]
            })
        );

        // An insert that carries text paints at once (a committed/replayed node is
        // part of the answer from the moment it exists), and the discard removes
        // exactly the node it names.
        expect(answers).toEqual(['kept ', 'kept discarded', 'kept (and kept)']);
    });

    it('routes a turn.upsert row and a usage patch to their own callbacks', () => {
        const turns: any[] = [];
        const usages: any[] = [];
        const { socket } = connected({ onTurn: (turn) => turns.push(turn), onUsage: (patch, turnId) => usages.push({ patch, turnId }) });

        const row = { id: TURN_ID, index: 0, status: 'running', updatedAt: 5 };

        socket.receive(update('ca-1', 1, { kind: 'turn.upsert', turn: row }));
        socket.receive(update('ca-1', 2, { kind: 'usage.updated', turn_id: TURN_ID, usage_patch: { input: 12, output: 8, total: 20 } }));

        expect(turns).toEqual([row]);
        expect(usages).toEqual([{ patch: { input: 12, output: 8, total: 20 }, turnId: TURN_ID }]);
        // Only the row's own kind reaches the fold: a turn scope never carries it.
        expect(socket.sent.filter((frame) => frame.type === 'unsubscribe')).toEqual([]);
    });

    it('recognizes the terminal turn states', () => {
        expect(['done', 'error', 'cancelled'].map(isTerminalTurnStatus)).toEqual([true, true, true]);
        expect(['queued', 'running'].map(isTerminalTurnStatus)).toEqual([false, false]);
    });
});

describe('loss recovery', () => {
    it('detects a sequence gap, re-subscribes from the last cursor, and re-reads the answer', async () => {
        const resyncs: string[] = [];
        const { socket } = connected({ onResync: (reason) => resyncs.push(reason) });

        // Sequence 1, then 3: frame 2 was dropped somewhere between the broker and
        // this socket.
        socket.receive(
            update('ca-2', 1, {
                kind: 'display.ops',
                turn_id: TURN_ID,
                ops: [
                    { op: 'section:open', turnId: TURN_ID, section: { id: 'sec', rank: 'A', agent: 'instruct' } },
                    { op: 'node:insert', turnId: TURN_ID, sectionId: 'sec', node: { id: 'n', kind: 'text', text: 'partial' } }
                ]
            })
        );
        socket.receive(
            update('ca-2', 3, { kind: 'display.ops', turn_id: TURN_ID, ops: [{ op: 'node:append', turnId: TURN_ID, sectionId: 'sec', nodeId: 'n', delta: ' tail' }] })
        );

        expect(resyncs).toEqual(['frames_dropped']);
        // The recovery is an unsubscribe + a resuming subscribe, in that order.
        expect(socket.sent.slice(-2)).toEqual([
            { type: 'unsubscribe', subscription_id: 'ca-2' },
            { type: 'subscribe', subscription_id: 'ca-2', scope: 'turn', session_id: SESSION_ID, turn_id: TURN_ID, pace: 'ordered', cursor: 'ca-2-1' }
        ]);

        await Promise.resolve();
        await Promise.resolve();

        // The fold is REPLACED by the canonical display read, and the caller is
        // told, because a gap means the local answer text was wrong.
        expect(reads).toEqual([{ sessionId: SESSION_ID, turnId: TURN_ID }]);
    });

    it('honors a server-demanded resync and reports its reason', async () => {
        const resyncs: string[] = [];
        const { socket } = connected({ onResync: (reason) => resyncs.push(reason) });

        socket.receive({
            type: 'resync_required',
            subscription_id: 'ca-2',
            reason: 'cursor_expired',
            epoch: 'epoch-1',
            cursor: 'ca-2-9',
            resources: []
        });

        expect(resyncs).toEqual(['cursor_expired']);
        await Promise.resolve();
        await Promise.resolve();
        expect(reads).toEqual([{ sessionId: SESSION_ID, turnId: TURN_ID }]);
    });

    it('closes the window a late turn subscription would otherwise leave', async () => {
        // `requestResync` is what the send flow calls right after the receipt: the
        // deltas published before the turn scope existed are already gone.
        // `connected(events, turnIds)`: the SECOND argument is the turn list, so an
        // empty one is passed positionally — the point of the case is that the send
        // follows its turn only AFTER the receipt, with nothing pre-subscribed.
        const { socket, handle } = connected({}, []);

        handle.followTurn(TURN_ID);
        expect(socket.sent[socket.sent.length - 1]).toEqual({
            type: 'subscribe',
            subscription_id: 'ca-2',
            scope: 'turn',
            session_id: SESSION_ID,
            turn_id: TURN_ID,
            pace: 'ordered'
        });

        handle.requestResync(TURN_ID);
        await Promise.resolve();
        await Promise.resolve();

        expect(reads).toEqual([{ sessionId: SESSION_ID, turnId: TURN_ID }]);
        expect(handle.textOf(TURN_ID)).toBe('canonical answer');
    });

    it('ignores frames for a subscription it does not own', () => {
        const turns: any[] = [];
        const { socket } = connected({ onTurn: (turn) => turns.push(turn) });

        socket.receive(update('someone-else', 1, { kind: 'turn.upsert', turn: { id: 'x', index: 0, status: 'done', updatedAt: 1 } }));

        expect(turns).toEqual([]);
    });

    it('tolerates a frame it cannot parse instead of dropping the connection', () => {
        const { socket, handle } = connected();

        socket.onmessage?.({ data: 'not json' });
        socket.onmessage?.({ data: JSON.stringify({ type: 'brand_new_frame' }) });

        expect(handle.status()).toBe('open');
        expect(socket.closedWith).toBeNull();
    });
});

describe('liveness and teardown', () => {
    it('gives up on a silent peer at the contract heartbeat budget, with the contract code', () => {
        const { socket } = connected();

        expect(timersFor('heartbeat')).toHaveLength(1);
        expect(timersFor('heartbeat')[0].ms).toBe(15_000 * 3);

        timersFor('heartbeat')[0].run();

        expect(socket.closedWith).toEqual({ code: 4408, reason: 'heartbeat timeout' });
    });

    it('moves the heartbeat deadline on every inbound frame', () => {
        const { socket } = connected();
        const armed = timersFor('heartbeat')[0];

        socket.receive({ type: 'heartbeat', at: 2 });

        const rearmed = timersFor('heartbeat');

        expect(rearmed).toHaveLength(1);
        expect(rearmed[0]).not.toBe(armed);
    });

    it('re-adopts the heartbeat numbers the welcome frame carries', () => {
        const handle = createHarnessStream({
            sessionId: SESSION_ID,
            entryAgentId: ENTRY_AGENT,
            socketUrl: '/v1/harness/stream',
            socketFactory: fakeFactory,
            schedule: scheduler,
            events: {}
        });

        handle.connect();
        const socket = last();

        socket.open();
        socket.receive({
            type: 'welcome',
            protocol: HARNESS_WS_SUBPROTOCOL,
            epoch: 'epoch-2',
            at: 1,
            // A deployment tuned inside the declared bounds; the client follows it
            // rather than assuming the shipped default.
            limits: { ...HARNESS_WS_LIMITS, heartbeat_interval_ms: 1000, heartbeat_timeout_intervals: 2 }
        });

        // The default-budget timer was CANCELLED and re-armed on the tuned budget:
        // one live deadline, at 1000ms x 2, not 15000 x 3.
        expect(timers.map((timer) => timer.ms)).toEqual([2000]);
    });

    it('reconnects with capped exponential backoff and jitter, and re-reads a followed turn', () => {
        const { handle, socket } = connected();

        socket.shut();
        expect(handle.status()).toBe('reconnecting');

        const backoff = timersFor('reconnect')[0];

        // 500ms base, plus up to 25% jitter.
        expect(backoff.ms).toBeGreaterThanOrEqual(500);
        expect(backoff.ms).toBeLessThanOrEqual(625);

        backoff.run();

        expect(sockets).toHaveLength(2);
        const next = last();

        next.open();
        // A reconnect re-reads the followed turn: the run kept going while the
        // socket was down, so the local fold is stale by construction.
        expect(next.sent.map((frame) => frame.type)).toEqual(['hello', 'subscribe', 'subscribe']);
        expect(reads).toEqual([{ sessionId: SESSION_ID, turnId: TURN_ID }]);
    });

    it('says goodbye and stops, without reconnecting', () => {
        const { handle, socket } = connected();

        handle.close('page unload');

        // `Array.prototype.at` is outside this package's `lib` (es2015 collection
        // targets), so the last frame is addressed by index.
        expect(socket.sent[socket.sent.length - 1]).toEqual({ type: 'bye', reason: 'page unload' });
        expect(socket.closedWith).toEqual({ code: 1000, reason: 'page unload' });
        expect(handle.status()).toBe('closed');
        expect(timersFor('reconnect')).toEqual([]);

        // A close is final for this observation: the RUN it was watching is
        // untouched, and no timer survives to redial.
        socket.shut();
        expect(handle.status()).toBe('closed');
        expect(timers).toEqual([]);
    });

    it('degrades to closed when the host has no WebSocket at all', () => {
        const saved = (globalThis as { WebSocket?: unknown }).WebSocket;

        delete (globalThis as { WebSocket?: unknown }).WebSocket;

        const handle = createHarnessStream({
            sessionId: SESSION_ID,
            entryAgentId: ENTRY_AGENT,
            socketUrl: '/v1/harness/stream',
            schedule: scheduler,
            events: {}
        });

        handle.connect();
        expect(handle.status()).toBe('closed');

        (globalThis as { WebSocket?: unknown }).WebSocket = saved;
    });
});
