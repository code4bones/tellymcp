const errorHandler = (ctx: any, error: Error) => {
	const logger = ctx?.service?.logger;
	const name = ctx?.action?.name;
	logger.error(`Ошибка в ${name}`, error);
	throw error;
};

export { errorHandler };
