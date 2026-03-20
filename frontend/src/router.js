import { createRouter, createWebHistory } from "vue-router";

const routes = [
	{
		path: "/",
		redirect: "/pos",
	},
	{
		path: "/pos",
		name: "POS",
		component: () => import("@/pages/PosPage.vue"),
	},
	{
		path: "/payments",
		name: "Payments",
		component: () => import("@/pages/PaymentsPage.vue"),
	},
];

const router = createRouter({
	history: createWebHistory("/pospire"),
	routes,
});

router.beforeEach((to, from, next) => {
	// window.user is injected by the Frappe page template from boot data
	const userId = window.user;

	if (!userId || userId === "Guest") {
		window.location.href = `/login?redirect-to=/pospire${to.fullPath}`;
		return;
	}
	next();
});

export default router;
