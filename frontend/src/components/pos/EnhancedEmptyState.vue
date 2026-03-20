<template>
	<div class="enhanced-empty-state enhanced-fade-in">
		<div class="enhanced-empty-state-icon">
			<v-icon size="64" color="grey-lighten-1">{{ icon }}</v-icon>
		</div>
		<div class="enhanced-empty-state-title">{{ title }}</div>
		<div class="enhanced-empty-state-description">{{ description }}</div>
		<button v-if="actionText" @click="$emit('action')" class="enhanced-empty-state-action">
			{{ actionText }}
		</button>
	</div>
</template>

<script setup>
defineProps({
	icon: {
		type: String,
		default: "mdi-package-variant-closed",
	},
	title: {
		type: String,
		default: "No items found",
	},
	description: {
		type: String,
		default: "Try adjusting your search or filter criteria to find items.",
	},
	actionText: {
		type: String,
		default: null,
	},
});

defineEmits(["action"]);
</script>

<style scoped>
.enhanced-empty-state {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	padding: 3rem 2rem;
	text-align: center;
	color: var(--empty-text-color);
	background: var(--empty-bg-gradient);
	border-radius: var(--empty-radius);
	border: var(--empty-border);
	margin: 2rem 0;
	min-height: 300px;
}

.enhanced-empty-state-title {
	font-size: var(--empty-title-size);
	font-weight: 600;
	color: var(--empty-title-color);
	margin: 1rem 0 0.5rem 0;
}

.enhanced-empty-state-description {
	font-size: var(--empty-desc-size);
	color: var(--empty-text-color);
	margin-bottom: 1.5rem;
	max-width: 400px;
	line-height: 1.5;
}

.enhanced-empty-state-action {
	background: var(--empty-btn-bg);
	color: var(--empty-btn-color);
	padding: 0.75rem 1.5rem;
	border-radius: var(--empty-btn-radius);
	text-decoration: none;
	font-weight: var(--empty-btn-font-weight);
	transition: all 0.3s ease;
	border: none;
	cursor: pointer;
}

.enhanced-empty-state-action:hover {
	transform: translateY(-2px);
	box-shadow: var(--empty-btn-shadow);
}

.enhanced-fade-in {
	animation: enhanced-fadeIn 0.3s ease-in-out;
}

@keyframes enhanced-fadeIn {
	from {
		opacity: 0;
		transform: translateY(20px);
	}
	to {
		opacity: 1;
		transform: translateY(0);
	}
}
</style>
