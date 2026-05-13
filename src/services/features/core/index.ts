import { DBMixin } from "@src/lib/mixins/db";
import { GQLSchema, GQLContext } from "@src/lib/moleculer";
import { gql } from "@src/lib";
import { PubBuilder } from "@src/lib/pubsub";
import { errorHandler } from "@src/services/core/sys/mixins/utillErrors/handleError";
import { GraphQLSettingsSchema } from "moleculer";
// GQLSchema["settings"]["graphql"]

export const gqlCompose = (entry: GraphQLSettingsSchema, ...args): GraphQLSettingsSchema => {
	const arr = [entry, ...args];
	const type = arr.map(({ type }) => type).join("\r\n");
	const resolvers = arr
		.map(({ resolvers }) => resolvers)
		.reduce((arr, res) => {
			return { ...arr, ...res };
		}, {});
	return { type, resolvers };
};

export { DBMixin, GQLSchema, gql, GQLContext, PubBuilder, errorHandler };
