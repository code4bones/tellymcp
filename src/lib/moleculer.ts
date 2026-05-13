import { Context, Service, ServiceSchema, ServiceSettingSchema } from "moleculer";
import { Knex } from "knex";
import { IncomingHttpHeaders, IncomingMessage, OutgoingMessage } from "http";

type GenericObject = Record<string, unknown>;

export interface TracerSchema {
	startSession?: string;
	stopSession?: boolean;
	tag?: string;
	step?: string;
	marker?: string;
	level?: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
	captureParams?: boolean | string[];
	captureResult?: boolean | string[];
	captureError?: boolean | string[];
}

declare module "moleculer" {
	export interface GraphQLSubscriptionSchema {
		/**
		 * Облявление Query
		 * @type(string)
		 */
		subscription?: string;
		/**
		 * subscription unique name
		 */
		tags: string[];
		/**
		 * filter action name
		 */
		filter?: string;
	}

	export interface GraphQLQuerySchema {
		/**
		 * Облявление Query
		 * @type(string)
		 */
		query?: string;
	}

	export interface GraphQLMutationSchema {
		/**
		 * Облявление Mutation
		 * @type(string)
		 */
		mutation?: string;
	}

	type SendEventCheckFn = (ctx: Context, res: any) => boolean;
	type SendEventParams = "simple" | "result";

	export interface ActionSchema {
		/**
		 * Вызывает подписку, для обновления фронта ( работает в паре c "sendWepAppEvent" и useAppEvent на фронте).
		 *
		 * @type{string[]}
		 */
		app_event?: string[];
		/**
		 * Проверяет группу/роль пользователя указанными этого action значениями в oidc_object_access[groups,roles].
		 *
		 * @type{boolean}
		 */
		object_access?: boolean;
		/**
		 * Проверяет группы пользователя с перечислеными группами
		 */
		groups?: string[];
		/**
		 *  Проверяет рольи пользоватя с перечисленными ролями
		 */
		roles?: string[];
		/**
		 *  добавление GraphQL в схему сервиса
		 * @type {GraphQLQuerySchema | GraphQLMutationSchema | GraphQLSubscriptionSchema}
		 */
		graphql?: GraphQLQuerySchema | GraphQLMutationSchema | GraphQLSubscriptionSchema;

		event?: SendEventCheckFn | SendEventParams;
		tracer?: TracerSchema;
	}

	type Resolver = {
		action: string;
		rootParams?: any;
	};

	type Resolvers = {
		[key: string]: Record<never, Resolver | string>;
	};

	export interface GraphQLSettingsSchema {
		type?: string;
		resolvers?: Resolvers;
	}

	export interface ServiceSettingSchema {
		graphql?: GraphQLSettingsSchema;
	}

	export interface Service {
		db: Knex;
	}

	/*
	export type ServiceActionsSchema<S = ServiceSettingSchema> = {
		[key: string]: ActionSchema | ActionHandler | boolean;
	} & ThisType<Service<S>>;
    */
}

export type GQLSchema = ServiceSchema<ServiceSettingSchema, Service>;

export type Account = {
	sub: string;
	profile: object;
	groups: string[];
	roles: string[];
	account_id: number;
	email: string;
};

export type ExtendedMeta = {
	user?: Account;
	$headers?: IncomingHttpHeaders; // Record<string, string>;
	$cookies?: Record<string, string>;
	$session: any;
	$request: IncomingMessage;
	$response: OutgoingMessage;
	$trace?: {
		sessionId: string;
		name?: string | null;
		tag?: string | null;
		rootAction?: string | null;
		startedBy?: string | null;
	};
	$traceInternal?: boolean;
	[key: string]: unknown;
} & object;

export type GQLContext<P = unknown, L = GenericObject> = Context<P, ExtendedMeta, L>;
