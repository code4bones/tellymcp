import { PubBuilder } from "@src/lib/pubsub";

export enum CRUDEvents {
	tableDataChanged = "tableDataChanged",
}

const tableDataChanged = (ctx, id, payload) =>
	PubBuilder.New(ctx, CRUDEvents.tableDataChanged).to(id).payload(payload).pub();

export default {
	name: "crudEvents",
	methods: {
		tableDataChanged,
	},
};
