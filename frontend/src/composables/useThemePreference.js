import { computed } from "vue";
import { useTheme } from "vuetify";

export const THEME_STORAGE_KEY = "pospire.theme";
export const LIGHT_THEME = "light";
export const DARK_THEME = "dark";

const VALID_THEMES = new Set([LIGHT_THEME, DARK_THEME]);
const THEME_SWITCHING_CLASS = "pospire-theme-switching";

export function normalizeThemeName(themeName) {
	return VALID_THEMES.has(themeName) ? themeName : LIGHT_THEME;
}

export function getStoredTheme() {
	if (typeof localStorage === "undefined") return LIGHT_THEME;
	try {
		return normalizeThemeName(localStorage.getItem(THEME_STORAGE_KEY));
	} catch {
		return LIGHT_THEME;
	}
}

export function setStoredTheme(themeName) {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(THEME_STORAGE_KEY, normalizeThemeName(themeName));
	} catch {
		/* localStorage can be unavailable in strict privacy modes. */
	}
}

export function useThemePreference() {
	const theme = useTheme();

	function setTheme(themeName) {
		const nextTheme = normalizeThemeName(themeName);
		if (theme.global.name.value === nextTheme) return;

		if (typeof document !== "undefined") {
			document.documentElement.classList.add(THEME_SWITCHING_CLASS);
		}

		theme.global.name.value = nextTheme;
		setStoredTheme(nextTheme);

		if (typeof document === "undefined") return;

		if (typeof requestAnimationFrame !== "undefined") {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					document.documentElement.classList.remove(THEME_SWITCHING_CLASS);
				});
			});
			return;
		}

		setTimeout(() => {
			document.documentElement.classList.remove(THEME_SWITCHING_CLASS);
		}, 0);
	}

	const currentTheme = computed({
		get: () => normalizeThemeName(theme.global.name.value),
		set: setTheme,
	});

	const isDark = computed(() => currentTheme.value === DARK_THEME);

	function toggleTheme() {
		setTheme(isDark.value ? LIGHT_THEME : DARK_THEME);
	}

	return {
		currentTheme,
		isDark,
		setTheme,
		toggleTheme,
	};
}
