import { PubBuilder } from "@src/lib/pubsub";

export enum VFSEvents {
	vfsChanged = "vfsChanged",
	vfsNodeChanged = "vfsNodeChanged",
	vfsTilesChanged = "vfsTilesChanged",
}

const vfsChanged = (ctx, id, payload) =>
	PubBuilder.New(ctx, VFSEvents.vfsChanged).to(id).payload(payload).pub();

const vfsNodeChanged = (ctx, id, payload) =>
	PubBuilder.New(ctx, VFSEvents.vfsNodeChanged).to(id).payload(payload).pub();

const vfsTilesChanged = (ctx, id, payload) =>
	PubBuilder.New(ctx, VFSEvents.vfsTilesChanged).to(id).payload(payload).pub();

export default {
	name: "vfsEvents",
	methods: {
		vfsChanged,
		vfsNodeChanged,
		vfsTilesChanged,
	},
};
