/**
 * Receiving one MIDI channel, and voices that remember theirs.
 *
 * `setMidiChannel` (or the `[midichannel:N]` option of the DSP) restricts the
 * channel voice messages `midiMessage` hands on; the typed calls of the host
 * stay unfiltered. A polyphonic voice keeps the channel of the note that
 * started it, so a note off, an All Notes Off or an All Sound Off only reaches
 * the voices of its own channel. Port of the C++ change in faust's
 * `architecture/faust/midi/midi.h` and `architecture/faust/dsp/poly-dsp.h`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    FaustBaseWebAudioDsp,
    FaustPolyWebAudioDsp,
    FaustWebAudioDspVoice
} from '../../dist/esm/index.js';
import { monoProcessor, BLOCK } from './harness.mjs';

const VOICES = 4;
const { kFreeVoice, kReleaseVoice } = FaustWebAudioDspVoice;

/**
 * A polyphonic DSP over a wasm instance that does nothing, as in
 * `voice-steal.test.mjs`: voice allocation is all JavaScript.
 *
 * @param {object[]} [meta] - the `meta` array of the DSP JSON
 */
function polyDsp(meta) {
    const json = {
        name: 'probe',
        inputs: 0,
        outputs: 1,
        size: 8,
        ...(meta ? { meta } : {}),
        ui: [
            {
                type: 'vgroup',
                label: 'probe',
                items: [
                    {
                        type: 'hslider',
                        label: 'freq',
                        address: '/probe/freq',
                        index: 0,
                        init: 440,
                        min: 20,
                        max: 2000,
                        step: 1
                    },
                    {
                        type: 'hslider',
                        label: 'gain',
                        address: '/probe/gain',
                        index: 4,
                        init: 0.5,
                        min: 0,
                        max: 1,
                        step: 0.01
                    },
                    {
                        type: 'button',
                        label: 'gate',
                        address: '/probe/gate',
                        index: 8
                    }
                ]
            }
        ]
    };
    const inertApi = {
        init: () => {},
        instanceInit: () => {},
        instanceClear: () => {},
        instanceConstants: () => {},
        instanceResetUserInterface: () => {},
        setParamValue: () => {},
        getParamValue: () => 0,
        compute: () => {},
        getNumInputs: () => 0,
        getNumOutputs: () => 1
    };
    const instance = {
        memory: new WebAssembly.Memory({ initial: 1 }),
        voices: VOICES,
        voiceAPI: inertApi,
        effectAPI: undefined,
        effectJSON: undefined,
        mixerAPI: {
            clearOutput: () => {},
            mixCheckVoice: () => 0,
            fadeOut: () => {}
        },
        voiceJSON: JSON.stringify(json)
    };
    return new FaustPolyWebAudioDsp(
        /** @type {any} */ (instance),
        48000,
        4,
        128,
        {}
    );
}

/** The voices holding `pitch`, as the channels they were started on. */
const playing = (dsp, pitch) =>
    /** @type {any} */ (dsp).fVoiceTable
        .filter((voice) => voice.fCurNote === pitch)
        .map((voice) => voice.fChannel);

/** How many voices are in `state`. */
const count = (dsp, state) =>
    /** @type {any} */ (dsp).fVoiceTable.filter(
        (voice) => voice.fCurNote === state
    ).length;

/** Run `fn` with `console.warn` captured, return what it printed. */
function warnings(fn) {
    const printed = [];
    const warn = console.warn;
    console.warn = (...args) => printed.push(args.join(' '));
    try {
        fn();
    } finally {
        console.warn = warn;
    }
    return printed;
}

test('a note off releases the voice of its own channel', () => {
    const dsp = polyDsp();
    dsp.midiMessage([0x90, 60, 100]);
    dsp.midiMessage([0x91, 60, 100]);
    assert.deepEqual(playing(dsp, 60).sort(), [0, 1]);
    // The same pitch, released on channel 2: channel 1's note keeps sounding
    dsp.midiMessage([0x81, 60, 0]);
    assert.deepEqual(playing(dsp, 60), [0]);
    assert.equal(count(dsp, kReleaseVoice), 1);
    // A note on with velocity 0 is a note off, on its channel too
    dsp.midiMessage([0x92, 60, 0]);
    assert.deepEqual(playing(dsp, 60), [0]);
    dsp.midiMessage([0x90, 60, 0]);
    assert.deepEqual(playing(dsp, 60), []);
});

test('All Notes Off releases, and All Sound Off frees, one channel', () => {
    const dsp = polyDsp();
    dsp.keyOn(0, 60, 100);
    dsp.keyOn(1, 62, 100);
    dsp.keyOn(1, 64, 100);
    dsp.ctrlChange(1, 123, 0);
    assert.deepEqual(playing(dsp, 60), [0], 'channel 1 untouched');
    assert.equal(count(dsp, kReleaseVoice), 2, 'channel 2 released');
    dsp.keyOn(2, 67, 100);
    dsp.ctrlChange(2, 120, 0);
    assert.deepEqual(playing(dsp, 67), [], 'channel 3 muted at once');
    assert.deepEqual(playing(dsp, 60), [0], 'channel 1 still untouched');
    assert.equal(count(dsp, kReleaseVoice), 2, 'the released ones stay so');
});

test('allNotesOff still ends every voice, whatever its channel', () => {
    const dsp = polyDsp();
    dsp.keyOn(0, 60, 100);
    dsp.keyOn(5, 62, 100);
    dsp.allNotesOff(true);
    assert.equal(count(dsp, kFreeVoice), VOICES);
});

test('setMidiChannel filters midiMessage, not the typed calls', () => {
    const dsp = polyDsp();
    assert.equal(dsp.getMidiChannel(), 0, 'all channels by default');
    dsp.setMidiChannel(2);
    assert.equal(dsp.getMidiChannel(), 2);

    dsp.midiMessage([0x90, 60, 100]);
    assert.deepEqual(playing(dsp, 60), [], 'channel 1 is not received');
    dsp.midiMessage([0x91, 60, 100]);
    assert.deepEqual(playing(dsp, 60), [1], 'channel 2 is');
    dsp.midiMessage([0x80, 60, 0]);
    dsp.midiMessage([0xb0, 120, 0]);
    assert.deepEqual(playing(dsp, 60), [1], 'nor off, nor CC on channel 1');

    // An on-screen keyboard calls keyOn on channel 1: still heard
    dsp.keyOn(0, 64, 100);
    assert.deepEqual(playing(dsp, 64), [0]);

    dsp.midiMessage([0x91, 60, 0]);
    assert.deepEqual(playing(dsp, 60), []);
});

test('setMidiChannel takes 0..16, anything else means all channels', () => {
    const dsp = polyDsp();
    for (const [value, expected] of [
        [16, 16],
        [1, 1],
        [0, 0],
        [17, 0],
        [-1, 0],
        [2.5, 0],
        [NaN, 0]
    ]) {
        dsp.setMidiChannel(5);
        dsp.setMidiChannel(value);
        assert.equal(
            dsp.getMidiChannel(),
            expected,
            `setMidiChannel(${value})`
        );
    }
});

test('the received channel defaults to the [midichannel:N] option', () => {
    assert.equal(
        polyDsp([
            { options: '[midi:on][nvoices:4][midichannel:5]' }
        ]).getMidiChannel(),
        5
    );
    assert.equal(polyDsp([{ midichannel: '7' }]).getMidiChannel(), 7);
    assert.equal(
        polyDsp([
            { options: '[midichannel:3]' },
            { midichannel: '7' }
        ]).getMidiChannel(),
        3,
        'the option wins over the plain metadata, as in C++'
    );
    assert.equal(polyDsp([{ options: '[midi:on]' }]).getMidiChannel(), 0);
    assert.equal(polyDsp().getMidiChannel(), 0, 'no metadata at all');
});

test('an invalid [midichannel:N] is reported and means all channels', () => {
    for (const value of ['42', 'two', '-1', '2.5']) {
        let channel = -1;
        const printed = warnings(() => {
            channel = polyDsp([
                { options: `[midichannel:${value}]` }
            ]).getMidiChannel();
        });
        assert.equal(channel, 0, value);
        assert.equal(printed.length, 1, `one warning for '${value}'`);
        assert.match(printed[0], /invalid MIDI channel/);
    }
});

test('the base class filters before decoding, real-time messages excepted', () => {
    // The monophonic DSP's controls go through the base midiMessage.
    class Probe extends FaustBaseWebAudioDsp {
        constructor() {
            super(4, BLOCK, {});
            this.seen = [];
        }
        ctrlChange(channel, ctrl, value) {
            this.seen.push(['ctrl', channel, ctrl, value]);
        }
        pitchWheel(channel, wheel) {
            this.seen.push(['bend', channel, wheel]);
        }
        keyOn(channel, pitch) {
            this.seen.push(['on', channel, pitch]);
        }
        keyOff(channel, pitch) {
            this.seen.push(['off', channel, pitch]);
        }
    }
    const dsp = new Probe();
    dsp.setMidiChannel(16);
    dsp.midiMessage([0xb0, 7, 64]);
    dsp.midiMessage([0xe3, 0, 64]);
    dsp.midiMessage([0x9e, 60, 100]);
    dsp.midiMessage([0xf8]);
    assert.deepEqual(dsp.seen, [], 'nothing outside channel 16');
    dsp.midiMessage([0xbf, 7, 64]);
    dsp.midiMessage([0xef, 0, 64]);
    dsp.midiMessage([0x9f, 60, 100]);
    dsp.midiMessage([0x8f, 60, 0]);
    assert.deepEqual(dsp.seen, [
        ['ctrl', 15, 7, 64],
        ['bend', 15, 8192],
        ['on', 15, 60],
        ['off', 15, 60]
    ]);
});

test('the processor hands the channel to its DSP', () => {
    const p = monoProcessor();
    p.port.send({ type: 'midiChannel', data: 3 });
    assert.equal(p.dsp.getMidiChannel(), 3);
    p.port.send({ type: 'midiChannel', data: 0 });
    assert.equal(p.dsp.getMidiChannel(), 0);
});

test('a panic cancels the notes scheduled on its channel only', () => {
    const p = monoProcessor();
    p.port.send({ type: 'keyOn', data: [0, 60, 100], frame: 4 * BLOCK });
    p.port.send({ type: 'keyOn', data: [1, 62, 100], frame: 4 * BLOCK });
    p.port.send({ type: 'midi', data: [0x90, 64, 100], frame: 4 * BLOCK });
    p.port.send({ type: 'midi', data: [0x91, 65, 100], frame: 4 * BLOCK });
    // All Notes Off on channel 1, arriving now
    p.port.send({ type: 'ctrlChange', data: [0, 123, 0] });
    for (let i = 0; i < 6; i++) p.render();
    assert.deepEqual(
        p.dsp.notes.map((n) => [n.channel, n.pitch]),
        [[1, 62]],
        'the typed note on channel 2 still plays'
    );
    assert.deepEqual(
        p.dsp.midi.filter((m) => m.type === 'midi').map((m) => m.data),
        [[0x91, 65, 100]],
        'and so does the raw one'
    );
});

test('a raw panic on a channel the DSP does not receive cancels nothing', () => {
    const p = monoProcessor();
    p.dsp.setMidiChannel(1);
    p.port.send({ type: 'keyOn', data: [0, 60, 100], frame: 4 * BLOCK });
    p.port.send({ type: 'midi', data: [0xb1, 123, 0] });
    for (let i = 0; i < 6; i++) p.render();
    assert.deepEqual(
        p.dsp.notes.map((n) => n.pitch),
        [60]
    );
    // On the received channel, it does
    p.port.send({ type: 'keyOn', data: [0, 62, 100], frame: 10 * BLOCK });
    p.port.send({ type: 'midi', data: [0xb0, 120, 0] });
    for (let i = 0; i < 6; i++) p.render();
    assert.deepEqual(
        p.dsp.notes.map((n) => n.pitch),
        [60]
    );
});
