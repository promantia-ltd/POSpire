<template>
	<v-btn
		class="theme-toggle"
		variant="tonal"
		color="primary"
		size="small"
		icon
		:title="toggleTitle"
		@click="toggleTheme"
	>
		<v-icon :icon="toggleIcon" size="small" />
	</v-btn>
</template>

<script>
import { computed } from "vue";
import { useThemePreference } from "@/composables/useThemePreference";

export default {
	name: "ThemeToggle",
	setup() {
		const { isDark, toggleTheme } = useThemePreference();

		const toggleIcon = computed(() =>
			isDark.value ? "mdi-weather-sunny" : "mdi-weather-night",
		);
		const toggleTitle = computed(() =>
			isDark.value ? __("Switch to Light Mode") : __("Switch to Dark Mode"),
		);

		return { toggleIcon, toggleTitle, toggleTheme };
	},
};
</script>

<style scoped>
.theme-toggle {
	width: 36px;
	height: 36px;
	border-radius: 18px;
}
</style>
