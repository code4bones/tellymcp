import type { Context } from "moleculer";
import type { ExtendedMeta, TracerSchema } from "../moleculer";
import {
	deleteTraceContext,
	loadTraceContext,
	saveTraceContext,
	touchTraceContext,
	type TraceContextPayload,
} from "../traceContext";
import {
	buildTraceErrorData,
	buildTraceStartData,
	buildTraceSuccessData,
	normalizeTraceLevel,
	sanitizeTraceValue,
} from "../trace";

const shouldSkipTrace = (actionName: string, ctx: Context<any, ExtendedMeta>) =>
	Boolean(
		ctx?.meta?.$traceInternal ||
			!actionName ||
			actionName === "context" ||
			actionName === "graphql.publish" ||
			(actionName === "rest" && ctx?.params?.req?.url === "/api/graphql")
	);

export const createTracerMiddleware = () => {
	let broker: any = null;

	const resolveTracer = (action: any): { tracer?: TracerSchema; source?: string } => {
		const rawName = String(action?.rawName || action?.name || "");
		if (action?.tracer) return { tracer: action.tracer, source: "action.tracer" };
		if (action?.schema?.tracer) return { tracer: action.schema.tracer, source: "action.schema.tracer" };
		if (action?.service?.schema?.actions?.[rawName]?.tracer) {
			return {
				tracer: action.service.schema.actions[rawName].tracer,
				source: "service.schema.actions[rawName].tracer",
			};
		}
		return {};
	};

	const callTrace = async (
		ctx: Context<any, ExtendedMeta>,
		actionName: string,
		params: Record<string, unknown>,
		silent = false
	) => {
		if (!broker) {
			return null;
		}
		try {
			return await broker.call(actionName, params, {
				requestID: ctx.requestID,
				meta: {
					user: ctx.meta?.user,
					$traceInternal: true,
				},
			});
		} catch (error) {
			if (!silent) {
				broker.logger.warn("Tracer call failed", {
					actionName,
					sourceAction: ctx.action?.name || null,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return null;
		}
	};

	return {
		created(localBroker: any) {
			broker = localBroker;
		},
		localAction(next: any, action: any) {
			const actionName = String(action?.rawName || action?.name || "");
			const serviceName = String((action as any)?.service?.name || "");

			return async function traceAction(ctx: Context<any, ExtendedMeta>) {
				if (serviceName === "trace" || shouldSkipTrace(actionName, ctx)) {
					return next(ctx);
				}
				const resolvedTracer = resolveTracer((ctx as any)?.action || action);
				const tracer: TracerSchema | undefined = resolvedTracer.tracer;
				let traceMeta: TraceContextPayload | null = null;
				const startSessionName = tracer?.startSession;
				const tracerTag = tracer?.tag;
				const shouldStartRootSession = Boolean(startSessionName);
				if (!shouldStartRootSession) {
					traceMeta = await loadTraceContext();
				}
				let startedSession = false;

				if (shouldStartRootSession) {
					await deleteTraceContext().catch(() => null);
					const session = (await callTrace(ctx, "trace.startSession", {
						name: startSessionName,
						tag: tracerTag || null,
						source: actionName,
						meta: sanitizeTraceValue({
							action: actionName,
							params: ctx.params,
						}),
					}, false)) as { session_id?: string } | null;

					if (session?.session_id) {
						traceMeta = {
							sessionId: String(session.session_id),
							name: startSessionName ?? null,
							tag: tracerTag || null,
							rootAction: actionName,
							startedBy: actionName,
						};
						await saveTraceContext(traceMeta);
						startedSession = true;
					}
				}

				const sessionId = String(traceMeta?.sessionId || "").trim();
				const hasSession = Boolean(sessionId);
				const startedAt = Date.now();

				if (hasSession) {
					await touchTraceContext().catch(() => null);
					await callTrace(ctx, "trace.log", {
						session_id: sessionId,
						level: normalizeTraceLevel(tracer?.level || "debug"),
						action: actionName,
						state: "started",
						marker: tracer?.marker || null,
						step: tracer?.step || "action",
						message: actionName,
						data: buildTraceStartData(ctx, actionName, tracer, startedSession),
					}, false);
				}

				try {
					const result = await next(ctx);
					const durationMs = Date.now() - startedAt;
					if (hasSession) {
						await callTrace(ctx, "trace.log", {
							session_id: sessionId,
							level: normalizeTraceLevel(tracer?.level || "debug"),
							action: actionName,
							state: "succeeded",
							marker: tracer?.marker || null,
							step: tracer?.step || "action",
							message: actionName,
							data: buildTraceSuccessData(ctx, actionName, result, durationMs, tracer),
						}, false);
						if (tracer?.stopSession) {
							await callTrace(ctx, "trace.endSession", {
								session_id: sessionId,
								status: "succeeded",
								summary: `${actionName} completed`,
								meta: sanitizeTraceValue({
									action: actionName,
									durationMs,
								}),
							}, false);
							await deleteTraceContext();
						}
					}
					return result;
				} catch (error) {
					const durationMs = Date.now() - startedAt;
					if (hasSession) {
						await callTrace(ctx, "trace.log", {
							session_id: sessionId,
							level: "error",
							action: actionName,
							state: "failed",
							marker: tracer?.marker || null,
							step: tracer?.step || "action",
							message: actionName,
							data: buildTraceErrorData(ctx, actionName, error, durationMs, tracer),
						}, false);
						if (tracer?.stopSession || startedSession) {
							await callTrace(ctx, "trace.endSession", {
								session_id: sessionId,
								status: "failed",
								summary:
									error instanceof Error ? error.message : `Action failed: ${actionName}`,
								meta: sanitizeTraceValue({
									action: actionName,
									durationMs,
								}),
							}, false);
							await deleteTraceContext();
						}
					}
					throw error;
				}
			};
		},
	};
};
