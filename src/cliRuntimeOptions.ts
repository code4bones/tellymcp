import { existsSync } from "node:fs";
import path from "node:path";

export function defaultClientEnvPath(homeDir: string): string {
  return path.join(homeDir, ".tellymcp", ".env");
}

function optionValue(args: string[], name: string): string | undefined {
  const values: string[] = [];
  const valueOptions = new Set(["--env", "--ws", "--agent", "--session", "-s"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1).trim();
      if (!value) throw new Error(`Expected a value after ${name}=`);
      values.push(value);
    } else if (arg === name) {
      const value = args[++i]?.trim();
      if (!value || value.startsWith("-")) throw new Error(`Expected a value after ${name}`);
      values.push(value);
    } else if (valueOptions.has(arg)) {
      i += 1;
    }
  }
  if (values.length > 1) throw new Error(`Specify ${name} only once`);
  return values[0];
}

export function resolveRuntimeEnvPath(
  args: string[],
  context: { cwd: string; homeDir: string; markerEnvFile?: string | undefined },
): string {
  const explicit = optionValue(args, "--env");
  if (explicit) return path.resolve(context.cwd, explicit);
  const globalEnv = defaultClientEnvPath(context.homeDir);
  if (context.markerEnvFile?.trim()) {
    const markerEnv = path.resolve(context.cwd, context.markerEnvFile.trim());
    // Earlier shared profiles used this home-level name. Resolve existing
    // workspace markers to the new canonical location after the profile moves.
    if (markerEnv === path.join(context.homeDir, ".env-client") && existsSync(globalEnv)) {
      return globalEnv;
    }
    return markerEnv;
  }
  const localEnv = path.join(context.cwd, ".env");
  return existsSync(localEnv) ? localEnv : globalEnv;
}

export function browserWsOverrides(args: string[]): Record<string, string> {
  const value = optionValue(args, "--ws");
  if (value === undefined) return {};
  const port = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--ws must be a port number from 1 to 65535");
  }
  return { BROWSER_ATTACH_ENABLED: "true", BROWSER_ATTACH_WS_PORT: String(port) };
}
