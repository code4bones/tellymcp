import { gql } from "@src/lib";

export default {
	settings: {
		graphql: {
			type: gql`
				type User {
					sub: UUID!
					email_verified: Boolean
					name: String!
					preferred_username: String
					given_name: String
					family_name: String
					email: String
					sid: String
					roles: [String!]!
					groups: [String!]!
				}

				type VFSUIConfig {
					default_scope: String!
					scope_visible: Boolean!
					tree_toolbar: Boolean!
					content_toolbar: Boolean!
					capabilities: [String!]!
				}
			`,
			resolvers: {},
		},
	},
};
