<template>
	<v-app class="pospire-app">
		<v-main>
			<Navbar @changePage="navigateTo($event)"></Navbar>
			<router-view class="mx-4 md-4"></router-view>
		</v-main>
	</v-app>
</template>

<script>
import Navbar from "@/components/Navbar.vue";

export default {
	components: {
		Navbar,
	},
	methods: {
		navigateTo(page) {
			const route = page === "Payments" ? "/payments" : "/pos";
			if (this.$route.path !== route) {
				this.$router.push(route);
			}
		},
	},
};
</script>

<style scoped>
.pospire-app {
	margin-top: 0px;
	height: 100vh;
}
</style>
