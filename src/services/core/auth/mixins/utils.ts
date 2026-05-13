import { Errors } from "moleculer";

export const authError = e => {
	if (e?.response?.data) {
		throw new Errors.MoleculerServerError(e.message, 401, "AUTH", e.response.data);
	} else if (e?.response?.statusText) {
		throw new Errors.MoleculerServerError(e.message, 401, "AUTH", e.response.statusText);
	}
	throw new Errors.MoleculerServerError(e.message, 401, "AUTH");
};

export const profileTokenFromSession = ctx => {
	// const session_token = ctx.meta.cookies.access_token;
	return ctx.call("accounts.getSessionByAccessToken", ctx.params).then(info => {
		if (!info?.access_token) throw new Error("Cannot find session from cookies");
		return info?.access_token;
	});
};

export default {
	methods: {
		authError,
		profileTokenFromSession,
	},
};
