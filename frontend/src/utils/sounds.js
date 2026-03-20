/**
 * Sound utilities — drop-in replacement for frappe.utils.play_sound().
 * Plays Frappe's bundled MP3 assets from /assets/frappe/sounds/.
 */

export function playSound(name) {
	try {
		const audio = new Audio(`/assets/frappe/sounds/${name}.mp3`);
		audio.play().catch(() => {
			// Silently ignore autoplay policy errors
		});
	} catch {
		// Silently ignore missing audio support
	}
}
