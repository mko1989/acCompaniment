// Typed ES-module face of src/backend/playlistLogic.js (CommonJS), so rust-anything can bridge and
// record it (rust/DECISIONS.md ADR-014). Every call goes to the original.
//
// Randomness: the original takes `rng`, a function returning [0, 1) (cueManager passes
// Math.random). Here it is `rngValues`, a sequence `rng()` returns in turn, cycling, so a
// shuffle is recorded exactly. Each value is reduced to its fraction (x - floor(x)) so it is in
// [0, 1) as the original requires; an empty list returns 0. The Rust port reads the list the
// same way; in the app the core passes a real random source.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const original = require('../../../src/backend/playlistLogic.js');

function rngFrom(rngValues: number[]): () => number {
    let i = 0;
    return () => {
        if (rngValues.length === 0) return 0;
        const x = rngValues[i % rngValues.length];
        i += 1;
        return x - Math.floor(x);
    };
}

export function shuffledOrder(itemCount: number, rngValues: number[]): number[] {
    return original.shuffledOrder(itemCount, rngFrom(rngValues));
}

export function isValidOrder(order: number[] | null | undefined, itemCount: number): boolean {
    return original.isValidOrder(order, itemCount);
}

export function effectiveOrder(itemCount: number, shuffle: boolean, order: number[] | null | undefined): number[] {
    return original.effectiveOrder({ itemCount, shuffle, order });
}

export function decideItemEnd(
    itemCount: number, currentIndex: number, mode: string, repeatOne: boolean, loop: boolean,
    shuffle: boolean, order: number[] | null | undefined, rngValues: number[],
): { action: string; nextIndex: number; order: number[] | null | undefined } {
    return original.decideItemEnd({
        itemCount, currentIndex, mode, repeatOne, loop, shuffle, order, rng: rngFrom(rngValues),
    });
}

export function stepIndex(
    itemCount: number, currentIndex: number, direction: string, shuffle: boolean, order: number[] | null | undefined,
): number {
    return original.stepIndex({ itemCount, currentIndex, direction, shuffle, order });
}

export function peekNextIndex(
    itemCount: number, currentIndex: number, shuffle: boolean, order: number[] | null | undefined, loop: boolean,
): number | null {
    return original.peekNextIndex({ itemCount, currentIndex, shuffle, order, loop });
}
