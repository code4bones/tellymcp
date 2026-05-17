export const parseAuth = () => {
	return function (req, res, next) {
		const { headers } = req;
		if ("authorization" in headers) {
			const value = headers.authorization;
			if (value.indexOf("Bearer") !== -1) {
				const [, v] = value.split(" ");
				req.access_token = v;
			}
		}
		next();
	};
};
