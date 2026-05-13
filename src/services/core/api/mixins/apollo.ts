/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-console */
/* eslint-disable require-await */
import { GraphQLJSON } from "graphql-type-json";
import { ApolloService } from "@src/lib/index";
import * as scalars from "graphql-scalars";
import { GraphQLScalarType, Kind } from "graphql";

import { getRedisSID, onBeforeCall, sessionFromRedis, useSessionMiddleware } from "./session";

const isPlaygroundRestricted = process.env.RESTRICT_PLAYGROUND === "true";
const publicApiBase = (process.env.APIS || process.env.ROOT_PREFIX || "/api").replace(/\/$/, "");
const publicGraphqlWsEndpoint = `${publicApiBase.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/graphql`;

const BigIntScalar = new GraphQLScalarType({
	name: "BigInt",
	description: "64-bit integer",
	serialize(value: any) {
		// Преобразуем в строку для безопасной передачи
		return value.toString();
	},
	parseValue(value: any) {
		return BigInt(value);
	},
	parseLiteral(ast) {
		if (ast.kind === Kind.INT || ast.kind === Kind.STRING) {
			return BigInt(ast.value);
		}
		return null;
	},
});

const Apollo = ApolloService({
	typeDefs: `
		scalar Date
		scalar JSON
		scalar BigInt
		scalar UUID
		scalar EmailAddress
		scalar GUID
		scalar IPv4

		input DataViewFilterInput {
			column:String!
			operator:String
			value:String
			values: [Int]
			and:[DataViewFilterInput!]
		}
		
		input DataViewPaganationInput {
			offset:Int!
			limit:Int!
		}

		input DataViewSortInput {
			column:String!
			order:String!
			nulls:String        
		}

		input DataViewInput {
			pagination:DataViewPaganationInput
			sort:[DataViewSortInput!]
			filter:[DataViewFilterInput!]
		}

		type DataViewPagination {
			offset:Int! 
			limit:Int!
			total:Int!
		}

		type Query {
			nothing__:String
		}
		`,
	resolvers: {
		JSON: GraphQLJSON,
		BigInt: BigIntScalar, //scalars.GraphQLBigInt,
		UUID: scalars.GraphQLUUID,
		EmailAddress: scalars.GraphQLEmailAddress,
		GUID: scalars.GraphQLGUID,
		IPv4: scalars.GraphQLIPv4,
	},

	// API Gateway route options
	routeOptions: {
		path: `${process.env.ROOT_PREFIX}/graphql`,
		// mappingPolicy: "restrict",
		authentication: false,
		authorization: false,
		use: useSessionMiddleware,
		callOptions: {
			timeout: 900000,
			fallbackResponse() {
				console.log("FALLBACK !");
				return { error: true };
			},
		},
		// onError(req, res, err) {
		//	console.error("GRAPHQL ERR", err);
		//},

		cors: {
			origin: (process.env.ORIGINS || "http://localhost:3000").split(","),
			methods: ["GET", "OPTIONS", "POST", "PUT", "DELETE", "Authorization"],
			// allowedHeaders: "*",
			// exposedHeaders: "*",
			credentials: true,
			// maxAge: null,
		},

		onBeforeCall: onBeforeCall(true),
	},

	serverOptions: {
		path: `${process.env.ROOT_PREFIX}/graphql`,
		subscriptions: {
			async context(this: any, $ctx: any) {
				const {
					params: {
						connectionParams,
						extra: { request },
					},
				} = $ctx;

				const sid = connectionParams.sid || getRedisSID(request);
				return sessionFromRedis(sid)
					.then(s => {
						return s?.user;
					})
					.catch(() => null);
			},
			async onConnect(ctx) {
				const {
					params: {
						connectionParams,
						extra: { request },
					},
				} = ctx;
				const sid = connectionParams.sid || getRedisSID(request);
				const user = await sessionFromRedis(sid)
					.then(s => {
						return s?.user;
					})
					.catch(() => null);

				return { Welcome: "Connected", user };
			},
		},

		playgroundOptions: {
			endpoint: `${publicApiBase}/graphql`, // external URL for sandbox shell/assets
			subscriptionEndpoint: publicGraphqlWsEndpoint,
			settings: {
				"editor.theme": "dark",
				"request.credentials": "include",
			},
		},
		// hideSchemaDetailsFromClientErrors: false, // not works
		includeStacktraceInErrorResponses: process.env.GQL_ERROR_STACK === "true", // works
		tracing: process.env.GQL_TRACE,
		introspection: !isPlaygroundRestricted,
		formatError: (formatted, error) => {
			console.log(error);
			return {
				message: error.message,
				...error.extensions,
				stack: process.env.GQL_ERROR_STACK === "true" ? formatted.extensions.stacktrace : undefined,
			};
		},
	},
	// actions: {},
	// methods: {},
});

export default Apollo;
