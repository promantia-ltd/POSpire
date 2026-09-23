<template>
	<v-dialog :model-value="modelValue" max-width="420" @update:model-value="$emit('update:modelValue', $event)">
		<v-card rounded="lg">
			<v-card-title class="d-flex align-center">
				<v-icon icon="mdi-alert-circle-outline" color="warning" class="mr-2" />
				{{ __("Reset this form?") }}
			</v-card-title>
			<v-card-text class="text-body-2 text-medium-emphasis">
				{{ __("This will clear everything you've entered so far. This cannot be undone.") }}
			</v-card-text>
			<v-card-actions>
				<v-spacer />
				<v-btn variant="text" color="grey-darken-1" @click="$emit('cancel')">
					{{ __("No") }}
				</v-btn>
				<v-btn variant="elevated" color="error" @click="$emit('confirm')">
					{{ __("Yes") }}
				</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script>
export default {
	props: {
		modelValue: { type: Boolean, default: false },
	},
	emits: ["update:modelValue", "confirm", "cancel"],
};
</script>
