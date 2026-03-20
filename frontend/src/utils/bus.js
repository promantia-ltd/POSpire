import mitt from "mitt";
import { __ } from "@/utils/translate";

const emitter = mitt();

export default {
	install: (app) => {
		app.config.globalProperties.__ = __;
		app.config.globalProperties.eventBus = emitter;
	},
};

export { emitter as eventBus };
