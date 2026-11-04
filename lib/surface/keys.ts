/**
 * Keys the areas send through a pi component's `handleInput()`, so a click takes the same path as
 * the key it stands for.
 */
import { getKeybindings } from "@earendil-works/pi-tui";

/** Arrow and editing keys as pi-tui's default keybindings read them. */
export const KEYS = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b" } as const;

const CSI_U_KEYS: Record<string, number> = { escape: 27, esc: 27, enter: 13, return: 13, tab: 9, space: 32, backspace: 127 };
const CSI_U_MODIFIERS: Record<string, number> = { shift: 1, alt: 2, ctrl: 4, super: 8 };

/** A pi key id such as `ctrl+-` as the Kitty `CSI u` sequence pi-tui parses, or undefined. */
export function keySequence(keyId: string): string | undefined {
	const id = keyId.toLowerCase();
	const key = id === "+" || id.endsWith("++") ? "+" : id.slice(id.lastIndexOf("+") + 1);
	let modifiers = 0;
	for (const part of id.slice(0, id.length - key.length).split("+").filter(Boolean)) {
		const bit = CSI_U_MODIFIERS[part];
		if (bit === undefined) return undefined;
		modifiers |= bit;
	}
	const code = CSI_U_KEYS[key] ?? ([...key].length === 1 ? key.codePointAt(0) : undefined);
	if (code === undefined) return undefined;
	return modifiers === 0 ? `\x1b[${code}u` : `\x1b[${code};${modifiers + 1}u`;
}

/**
 * The bytes of the first key bound to `binding` that pi reads back as that binding. `fallback` is
 * pi's default key, for a keybinding manager that does not know the binding.
 */
export function bindingSequence(binding: string, fallback?: string): string | undefined {
	const keybindings = getKeybindings();
	for (const keyId of keybindings.getKeys(binding as never)) {
		const sequence = keySequence(keyId);
		if (sequence && keybindings.matches(sequence, binding as never)) return sequence;
	}
	return fallback ? keySequence(fallback) : undefined;
}
