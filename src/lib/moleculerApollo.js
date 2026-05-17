import { runHttpQuery, convertNodeHttpToRequest } from "apollo-server-core";
import url from "url";

// Utility function used to set multiple headers on a response object.
function setHeaders(res, headers) {
	Object.keys(headers).forEach(header => res.setHeader(header, headers[header]));
}

function graphqlMoleculer(options) {
	if (!options) {
		throw new Error("Apollo Server requires options.");
	}

	if (arguments.length > 1) {
		throw new Error(`Apollo Server expects exactly one argument, got ${arguments.length}`);
	}

	return async function graphqlHandler(req, res) {
		let query;
		try {
			if (req.method === "POST") {
				query = req.filePayload || req.body;
			} else {
				query = url.parse(req.url, true).query;
			}
		} catch (error) {
			// Do nothing; `query` stays `undefined`
		}

		try {
			const { graphqlResponse, responseInit } = await runHttpQuery([req, res], {
				method: req.method,
				options,
				query,
				request: convertNodeHttpToRequest(req),
			});

			setHeaders(res, responseInit.headers);

			return graphqlResponse;
		} catch (error) {
			console.error("**************** QUERY ERROR !", error);
			if (error.name === "HttpQueryError" && error.headers) {
				setHeaders(res, error.headers);
			}

			if (!error.statusCode) {
				error.statusCode = 500;
			}

			res.statusCode = error.statusCode || error.code || 500;
			res.end(error.message);

			return undefined;
		}
	};
}

export { graphqlMoleculer };
