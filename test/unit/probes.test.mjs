/**
 * Probes: bargraphs carrying `[probe]`, read on every frame.
 *
 * A host reads a bargraph once per block, which is enough for a meter but not
 * for an oscilloscope. While a probe handler is set, a mono DSP renders the
 * block one frame at a time and reads its probes after each frame, so the
 * handler gets the signal at the probe points sample for sample.
 *
 * The claims checked here: the probes are found by their metadata and only by
 * it, what the handler gets is the probed signal itself, the audio output does
 * not move by a single bit when probing is switched on (even with state, a
 * feedback loop and an event in the middle of a block), the processor carries
 * the probes to the node, and a polyphonic DSP has none.
 *
 * Like param-api.test.mjs this compiles real DSPs through libfaust: the probes
 * are found in the compiler's own JSON and read from real wasm memory.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    instantiateFaustModuleFromFile,
    LibFaust,
    FaustCompiler,
    FaustWasmInstantiator,
    FaustBaseWebAudioDsp,
    FaustMonoWebAudioDsp,
    FaustPolyWebAudioDsp,
    FaustWebAudioDspVoice,
    FaustPolyDspGenerator,
    getFaustAudioWorkletProcessor
} from '../../dist/esm/index.js';

const ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
);
const SAMPLE_RATE = 48000;
const BLOCK = 128;
const BLOCKS = 8;

/** One probe inside the chain, one plain bargraph that is not a probe. */
const PROBED = `
import("stdfaust.lib");
probe = _ <: attach(_, hbargraph("osc[probe:scope]", -1, 1));
meter = _ <: attach(_, hbargraph("level", -1, 1));
process = os.osc(440) : probe : *(0.5) : meter;
`;

/**
 * Two probes in a feedback loop with a control: state that carries across
 * blocks and a parameter that can change inside one.
 */
const FEEDBACK = `
import("stdfaust.lib");
probe(n) = _ <: attach(_, hbargraph("p %n[probe:scope]", -2, 2));
fb = hslider("fb", 0.5, 0, 0.99, 0.01);
loop = (+ : probe(1) : ma.tanh : fi.lowpass(1, 3000) : *(fb)) ~ (de.delay(64, 37) : probe(2));
process = no.noise * 0.1 : loop;
`;

/** @type {any} */ let compiler;

before(async () => {
    const faustModule = await instantiateFaustModuleFromFile(
        path.join(ROOT, 'libfaust-wasm', 'libfaust-wasm.js')
    );
    compiler = new FaustCompiler(new LibFaust(faustModule));
});

/** A fresh mono DSP of `code`. */
const makeDsp = async (name, code) => {
    const factory = await compiler.createMonoDSPFactory(name, code, '-ftz 2');
    assert.ok(factory, `${name} has to compile`);
    const instance =
        await FaustWasmInstantiator.createAsyncMonoDSPInstance(factory);
    return new FaustMonoWebAudioDsp(
        instance,
        SAMPLE_RATE,
        4,
        BLOCK,
        factory.soundfiles || {}
    );
};

/**
 * Render `BLOCKS` blocks, giving each block's events to `compute`.
 *
 * @param {any} dsp
 * @param {(block: number) => any[] | undefined} [eventsOf]
 * @returns {Float32Array}
 */
const render = (dsp, eventsOf = () => undefined) => {
    const rendered = new Float32Array(BLOCK * BLOCKS);
    dsp.start();
    for (let block = 0; block < BLOCKS; block += 1) {
        const out = [new Float32Array(BLOCK)];
        dsp.compute([], out, eventsOf(block));
        rendered.set(out[0], block * BLOCK);
    }
    dsp.stop();
    return rendered;
};

/** Collects every block a probe handler is given, copied. */
const collector = () => {
    /** @type {Float32Array[][]} */
    const blocks = [];
    const handler = (probes, index) => {
        assert.equal(index, blocks.length, 'the block index counts up');
        blocks.push(probes.map((probe) => probe.slice()));
    };
    return { blocks, handler };
};

/** Probe `which` of every collected block, end to end. */
const joined = (blocks, which) => {
    const signal = new Float32Array(blocks.length * BLOCK);
    blocks.forEach((probes, block) => signal.set(probes[which], block * BLOCK));
    return signal;
};

const assertSame = (a, b, what) => {
    assert.equal(a.length, b.length, `${what}: length`);
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i])
            assert.fail(`${what}: frame ${i}, ${a[i]} vs ${b[i]}`);
    }
};

test('the probes are the bargraphs with probe metadata, and only those', async () => {
    const dsp = await makeDsp('probed', PROBED);
    assert.deepEqual(dsp.getProbes(), ['/probed/osc']);
});

test('the handler gets the probed signal, sample for sample', async () => {
    const dsp = await makeDsp('probed', PROBED);
    const { blocks, handler } = collector();
    dsp.setProbeHandler(handler);
    const output = render(dsp);

    assert.equal(blocks.length, BLOCKS, 'one call per block');
    // The probe sits before `*(0.5)`: the output is exactly half of it
    const probed = joined(blocks, 0);
    assert.ok(
        probed.some((sample) => sample !== 0),
        'the probe saw a signal'
    );
    assertSame(
        probed.map((sample) => sample * 0.5),
        output,
        'probe against output'
    );
});

test('probing leaves the output unchanged, bit for bit', async () => {
    // A control change in the middle of block 3: the frame-by-frame render
    // has to apply it on the same frame as the sliced one.
    const eventsOf = (dsp) => (block) =>
        block === 3
            ? [
                  {
                      frame: 50,
                      apply: () => dsp.setParamValue('/feedback/fb', 0.9)
                  }
              ]
            : undefined;

    const plain = await makeDsp('feedback', FEEDBACK);
    const reference = render(plain, eventsOf(plain));

    const probed = await makeDsp('feedback', FEEDBACK);
    const { blocks, handler } = collector();
    probed.setProbeHandler(handler);
    const output = render(probed, eventsOf(probed));

    assert.ok(
        reference.some((sample) => sample !== 0),
        'not silence'
    );
    assertSame(output, reference, 'output with and without probes');
    assert.deepEqual(probed.getProbes(), ['/feedback/p_1', '/feedback/p_2']);
    // Both points of the loop were seen moving, not just the first frame
    for (const which of [0, 1]) {
        const signal = joined(blocks, which);
        assert.ok(
            new Set(signal).size > BLOCK,
            `probe ${which + 1} moves from frame to frame`
        );
    }
});

test('removing the handler goes back to rendering by block', async () => {
    const dsp = await makeDsp('probed', PROBED);
    const { blocks, handler } = collector();
    dsp.setProbeHandler(handler);
    render(dsp);
    dsp.setProbeHandler(null);
    render(dsp);
    assert.equal(blocks.length, BLOCKS, 'no call once removed');
    assert.equal(dsp.getProbeHandler(), null);
});

test('the worklet processor posts the probes of every block', async () => {
    const factory = await compiler.createMonoDSPFactory(
        'probed',
        PROBED,
        '-ftz 2'
    );
    const posted = [];
    globalThis.sampleRate = SAMPLE_RATE;
    globalThis.registerProcessor = () => {};
    globalThis.AudioWorkletProcessor = class {
        constructor() {
            this.port = {
                addEventListener() {},
                start() {},
                postMessage: (message) => posted.push(message)
            };
        }
    };
    Object.defineProperty(globalThis, 'currentFrame', {
        configurable: true,
        get: () => 0
    });
    const Processor = getFaustAudioWorkletProcessor(
        /** @type {any} */ ({
            FaustBaseWebAudioDsp,
            FaustMonoWebAudioDsp,
            FaustPolyWebAudioDsp,
            FaustWebAudioDspVoice,
            FaustWasmInstantiator,
            FaustAudioWorkletProcessorCommunicator: class {
                getNewAccDataAvailable() {
                    return false;
                }
                getNewGyrDataAvailable() {
                    return false;
                }
            }
        }),
        {
            processorName: 'probed',
            dspName: 'probed',
            dspMeta: JSON.parse(factory.json),
            poly: false
        },
        false
    );
    // Typed loosely: the message handler is protected on the processor
    const processor = /** @type {any} */ (
        new Processor({ processorOptions: { factory, sampleSize: 4 } })
    );
    processor.handleMessageAux({
        data: { type: 'setProbeHandler', data: true }
    });
    const out = [new Float32Array(BLOCK)];
    processor.process([[]], [out], {});

    const probes = posted.filter((message) => message.type === 'probe');
    assert.equal(probes.length, 1, 'one message for one block');
    assert.equal(probes[0].index, 0);
    assertSame(
        probes[0].value[0].map((sample) => sample * 0.5),
        out[0],
        'posted probe against output'
    );
});

test('a polyphonic DSP has no probes', async () => {
    const voice = `import("stdfaust.lib");
probe = _ <: attach(_, hbargraph("v[probe:scope]", -1, 1));
process = os.osc(hslider("freq", 440, 20, 3000, 1)) * button("gate") : probe;`;
    const generator = new FaustPolyDspGenerator();
    await generator.compile(compiler, 'polyprobe', voice, '-ftz 2');
    const processor = await generator.createOfflineProcessor(
        SAMPLE_RATE,
        BLOCK,
        2
    );
    assert.deepEqual(processor.getProbes(), []);
});
