import type { TransportTargetOptions } from "pino";

export type PinoTargetConfig = {
	level: string;
	fileEnabled: boolean;
	filePath: string;
};

export function createPinoTargets(config: PinoTargetConfig): TransportTargetOptions[] {
	const targets: TransportTargetOptions[] = [
		{
			target: "pino-pretty",
			level: config.level,
			options: {
				destination: 2,
				colorize: true,
				translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
				ignore: "pid,hostname",
				singleLine: false,
			},
		},
	];

	if (config.fileEnabled) {
		targets.unshift({
			target: "pino/file",
			level: config.level,
			options: {
				destination: config.filePath,
				mkdir: true,
			},
		});
	}

	return targets;
}
