/**
 * Semantic node tree diff.
 *
 * The full surface describes each region as a fresh node tree on every repaint. Tern keeps the
 * document, so the sink sends only what changed between the last tree and the new one.
 */

const sameValue = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The prop delta between two nodes of the same kind, or null when nothing changed.
 *
 * A removed prop is sent as `null`, because `set` merges into the props Tern already holds.
 * Without it a dropped Vim `mode` label would stay on the composer.
 */
export function propDelta(oldProps = {}, newProps = {}) {
	let delta = null;
	for (const key of Object.keys(newProps)) {
		if (newProps[key] === undefined) continue;
		if (!sameValue(oldProps[key], newProps[key])) (delta ??= {})[key] = newProps[key];
	}
	for (const key of Object.keys(oldProps)) {
		if (oldProps[key] !== undefined && newProps[key] === undefined) (delta ??= {})[key] = null;
	}
	return delta;
}

/**
 * Push the `add`, `set` and `del` ops that turn `prev` into `next` under `parentId`.
 *
 * Ids are the identity. A node whose kind changed, or that moved out of order, is deleted and
 * added again, because these three ops cannot move a node. New and re-added nodes are inserted
 * before the next sibling that stayed in place, so they land in `next` order.
 */
export function diffChildren(parentId, prev, next, ops) {
	const prevById = new Map(prev.map((node) => [node.id, node]));
	const nextIds = new Set(next.map((node) => node.id));
	for (const node of prev) if (!nextIds.has(node.id)) ops.push(["del", node.id]);

	const kept = prev.filter((node) => nextIds.has(node.id)).map((node) => node.id);
	const inPlace = new Set();
	let cursor = 0;
	for (const node of next) {
		const old = prevById.get(node.id);
		if (old && old.k === node.k && kept[cursor] === node.id) {
			inPlace.add(node.id);
			cursor += 1;
		} else if (old && kept.indexOf(node.id, cursor) !== -1) {
			// Out of order: skipping it keeps the rest of `kept` aligned with `next`.
			kept.splice(kept.indexOf(node.id, cursor), 1);
		}
	}

	for (let i = 0; i < next.length; i += 1) {
		const node = next[i];
		const old = prevById.get(node.id);
		if (old && inPlace.has(node.id)) {
			const delta = propDelta(old.p, node.p);
			if (delta) ops.push(["set", node.id, delta]);
			diffChildren(node.id, old.c ?? [], node.c ?? [], ops);
			continue;
		}
		if (old) ops.push(["del", node.id]);
		let before = null;
		for (let j = i + 1; j < next.length; j += 1) {
			if (inPlace.has(next[j].id)) {
				before = next[j].id;
				break;
			}
		}
		ops.push(["add", node.id, parentId, before, node]);
	}
	return ops;
}
