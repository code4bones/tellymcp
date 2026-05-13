import { PubBuilder } from "@src/lib/pubsub";

export enum SettingsEvents {
	settingsChanged = "settingsChanged",
}

const settingsChanged = (ctx, id, payload) =>
	PubBuilder.New(ctx, SettingsEvents.settingsChanged).to(id).payload(payload).pub();

export default {
	name: "settingsEvents",
	methods: {
		settingsChanged,
	},
};
