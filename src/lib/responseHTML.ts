export const renderJSON = (ctx, obj) => {
	ctx.meta.$responseType = "text/html";
	return `<body style="background-color:#2e2e39;color:#d58f0b;padding:5px"><pre>${JSON.stringify(obj, null, 2)}</pre></body>`;
};
