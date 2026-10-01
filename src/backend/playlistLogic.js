/**
 * Pure playlist decisions - which item plays next, and whether the playlist
 * plays it, cues it, or finishes. No I/O and no state of its own: callers
 * (cueManager) pass the current position in and apply what comes back.
 *
 * Positions vs indices: `currentIndex` is always an index into
 * cue.playlistItems. With shuffle on, playback follows `order` - a
 * permutation of those indices - and the position is where currentIndex
 * sits in it.
 */

/** Fisher-Yates shuffle of [0..itemCount-1]. `rng` returns a number in [0, 1). */
function shuffledOrder(itemCount, rng = Math.random) {
    const order = Array.from({ length: Math.max(0, itemCount) }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
}

/** A shuffle order is only usable if it is a permutation of the current items. */
function isValidOrder(order, itemCount) {
    if (!Array.isArray(order) || order.length !== itemCount) {
        return false;
    }
    const seen = new Set(order);
    return seen.size === itemCount && order.every((i) => Number.isInteger(i) && i >= 0 && i < itemCount);
}

/** The play order in effect: the shuffle order, or items in list order. */
function effectiveOrder({ itemCount, shuffle, order }) {
    if (shuffle && isValidOrder(order, itemCount)) {
        return order;
    }
    return Array.from({ length: itemCount }, (_, i) => i);
}

/**
 * What happens when the current item plays to its natural end. Mirrors the
 * legacy Electron app:
 *   repeatOne            -> cue the same item again
 *   'stop_and_cue_next'  -> cue the next item
 *   'continue' (default) -> play the next item
 * Past the end of the order, `loop` wraps to the start (reshuffling when
 * shuffle is on); without loop the playlist finishes and resets.
 *
 * Returns { action: 'play' | 'cue' | 'finish', nextIndex, order }. `order`
 * is the shuffle order to keep (null when shuffle is off or finished).
 */
function decideItemEnd({
    itemCount, currentIndex = 0, mode = 'continue', repeatOne = false,
    loop = false, shuffle = false, order = null, rng = Math.random,
}) {
    if (itemCount <= 0) {
        return { action: 'finish', nextIndex: 0, order: null };
    }

    let activeOrder = shuffle
        ? (isValidOrder(order, itemCount) ? order : shuffledOrder(itemCount, rng))
        : null;
    const cueAction = (repeatOne || mode === 'stop_and_cue_next') ? 'cue' : 'play';

    if (repeatOne) {
        return { action: 'cue', nextIndex: currentIndex, order: activeOrder };
    }

    const sequence = activeOrder || effectiveOrder({ itemCount });
    const position = Math.max(0, sequence.indexOf(currentIndex));

    if (position + 1 < sequence.length) {
        return { action: cueAction, nextIndex: sequence[position + 1], order: activeOrder };
    }

    // Past the last item.
    if (!loop) {
        return { action: 'finish', nextIndex: 0, order: null };
    }
    if (shuffle) {
        activeOrder = shuffledOrder(itemCount, rng);
        return { action: cueAction, nextIndex: activeOrder[0], order: activeOrder };
    }
    return { action: cueAction, nextIndex: 0, order: null };
}

/**
 * Manual navigation (the grid's ◀ ▶ buttons, "Play Next Item" retrigger).
 * Follows the shuffle order when there is one; clamps at both ends.
 */
function stepIndex({ itemCount, currentIndex = 0, direction, shuffle = false, order = null }) {
    if (itemCount <= 0) {
        return 0;
    }
    const sequence = effectiveOrder({ itemCount, shuffle, order });
    const position = Math.max(0, sequence.indexOf(currentIndex));
    const delta = direction === 'previous' ? -1 : 1;
    const nextPosition = Math.min(sequence.length - 1, Math.max(0, position + delta));
    return sequence[nextPosition];
}

/** The item that would play after `currentIndex` (null at the end with no loop). */
function peekNextIndex({ itemCount, currentIndex = 0, shuffle = false, order = null, loop = false }) {
    if (itemCount <= 0) {
        return null;
    }
    const sequence = effectiveOrder({ itemCount, shuffle, order });
    const position = sequence.indexOf(currentIndex);
    if (position >= 0 && position + 1 < sequence.length) {
        return sequence[position + 1];
    }
    return loop ? sequence[0] : null;
}

module.exports = {
    shuffledOrder,
    isValidOrder,
    effectiveOrder,
    decideItemEnd,
    stepIndex,
    peekNextIndex,
};
