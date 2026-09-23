<template>
	<div class="item-image" :class="{ 'item-image--compact': compact }">
		<v-img
			v-if="showImage"
			:src="src"
			:aspect-ratio="aspectRatio"
			:height="height"
			:cover="cover"
			class="item-image__media"
			@error="hasError = true"
		>
			<slot></slot>
		</v-img>
		<div v-else class="item-image__placeholder" :style="placeholderStyle">
			<v-icon :size="compact ? 18 : 42" icon="mdi-image-off-outline" />
			<slot></slot>
		</div>
	</div>
</template>

<script>
export default {
	name: "ItemImage",
	props: {
		src: { type: String, default: "" },
		aspectRatio: { type: [Number, String], default: 1 },
		height: { type: [Number, String], default: undefined },
		cover: { type: Boolean, default: true },
		compact: { type: Boolean, default: false },
	},
	data() {
		return {
			hasError: false,
		};
	},
	computed: {
		showImage() {
			return Boolean(this.src) && !this.hasError;
		},
		placeholderStyle() {
			if (!this.height) return {};
			const height = typeof this.height === "number" ? `${this.height}px` : this.height;
			return { height };
		},
	},
	watch: {
		src() {
			this.hasError = false;
		},
	},
};
</script>

<style scoped>
.item-image {
	width: 100%;
	height: 100%;
}

.item-image__media {
	width: 100%;
	height: 100%;
}

.item-image__placeholder {
	width: 100%;
	height: 100%;
	min-height: 100%;
	display: flex;
	align-items: center;
	justify-content: center;
	position: relative;
	overflow: hidden;
	background: var(--pospire-surface-soft);
	color: var(--pospire-text-faint);
	border: 1px solid var(--pospire-border-subtle);
}

.item-image--compact .item-image__placeholder {
	border-radius: 999px;
	border: 0;
}
</style>
