import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

type PluginManifest = {
  name: string;
  version: string;
};

export type CodexPluginStatus = {
  pluginName: string;
  marketplaceName: string;
  bundledVersion: string;
  sourceVersion: string | null;
  installedVersion: string | null;
  codexAvailable: boolean;
  marketplaceRegistered: boolean;
  upToDate: boolean;
  bundledPluginDir: string;
  managedPluginDir: string;
  marketplaceFile: string;
  marketplaceRoot: string;
};

const PLUGIN_NAME = "telly-workflows";
const MARKETPLACE_NAME = "personal";
const MARKETPLACE_RELATIVE_PLUGIN_PATH = "./.codex/local-plugins/telly-workflows";

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function getBundledPluginDir(packageRoot: string): string {
  return path.join(packageRoot, "config", "codex", "plugins", PLUGIN_NAME);
}

function getBundledPluginManifest(packageRoot: string): PluginManifest {
  return readJsonFile<PluginManifest>(
    path.join(getBundledPluginDir(packageRoot), ".codex-plugin", "plugin.json"),
  );
}

function getMarketplaceRoot(homeDir: string): string {
  return homeDir;
}

function getMarketplaceFile(homeDir: string): string {
  return path.join(homeDir, ".agents", "plugins", "marketplace.json");
}

function getManagedPluginDir(homeDir: string): string {
  return path.join(homeDir, ".codex", "local-plugins", PLUGIN_NAME);
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function parseMarketplaceRegistered(stdout: string, rootPath: string): boolean {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      if (
        line === "MARKETPLACE     ROOT" ||
        line.startsWith("Added marketplace ") ||
        line.startsWith("Installed marketplace root:")
      ) {
        return false;
      }
      const columns = line.split(/\s{2,}/u);
      return columns[0] === MARKETPLACE_NAME && columns[1] === rootPath;
    });
}

function parseInstalledPluginVersion(stdout: string): string | null {
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith(`${PLUGIN_NAME}@${MARKETPLACE_NAME}`)) {
      continue;
    }
    const columns = line.split(/\s{2,}/u);
    if (columns.length < 3) {
      continue;
    }
    const version = columns[2]?.trim();
    return version || null;
  }
  return null;
}

function ensureMarketplaceManifest(homeDir: string): string {
  const marketplaceFile = getMarketplaceFile(homeDir);
  mkdirSync(path.dirname(marketplaceFile), { recursive: true });

  const payload = existsSync(marketplaceFile)
    ? readJsonFile<{
        name?: string;
        interface?: { displayName?: string };
        plugins?: Array<Record<string, unknown>>;
      }>(marketplaceFile)
    : {
        name: MARKETPLACE_NAME,
        interface: { displayName: "Personal" },
        plugins: [],
      };

  const plugins = Array.isArray(payload.plugins) ? payload.plugins : [];
  const existingIndex = plugins.findIndex(
    (plugin) => String(plugin.name ?? "") === PLUGIN_NAME,
  );
  const nextEntry = {
    name: PLUGIN_NAME,
    source: {
      source: "local",
      path: MARKETPLACE_RELATIVE_PLUGIN_PATH,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  };

  if (existingIndex >= 0) {
    plugins[existingIndex] = nextEntry;
  } else {
    plugins.push(nextEntry);
  }

  const nextPayload = {
    name:
      typeof payload.name === "string" && payload.name.trim()
        ? payload.name.trim()
        : MARKETPLACE_NAME,
    interface:
      payload.interface &&
      typeof payload.interface === "object" &&
      typeof payload.interface.displayName === "string" &&
      payload.interface.displayName.trim()
        ? { displayName: payload.interface.displayName.trim() }
        : { displayName: "Personal" },
    plugins,
  };

  writeFileSync(marketplaceFile, `${JSON.stringify(nextPayload, null, 2)}\n`, "utf8");
  return marketplaceFile;
}

function syncBundledPlugin(packageRoot: string, homeDir: string): string {
  const bundledPluginDir = getBundledPluginDir(packageRoot);
  if (!existsSync(bundledPluginDir)) {
    throw new Error(`Bundled Codex plugin is missing: ${bundledPluginDir}`);
  }

  const managedPluginDir = getManagedPluginDir(homeDir);
  mkdirSync(path.dirname(managedPluginDir), { recursive: true });
  rmSync(managedPluginDir, { recursive: true, force: true });
  cpSync(bundledPluginDir, managedPluginDir, { recursive: true });
  return managedPluginDir;
}

function ensureMarketplaceRegistered(homeDir: string): boolean {
  if (!commandExists("codex")) {
    return false;
  }

  const marketplaceRoot = getMarketplaceRoot(homeDir);
  const listed = spawnSync("codex", ["plugin", "marketplace", "list"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (listed.status === 0 && parseMarketplaceRegistered(listed.stdout || "", marketplaceRoot)) {
    return true;
  }

  const added = spawnSync("codex", ["plugin", "marketplace", "add", marketplaceRoot], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (added.status !== 0) {
    throw new Error((added.stderr || added.stdout || "Failed to add Codex marketplace.").trim());
  }
  return true;
}

export function getCodexPluginStatus(packageRoot: string): CodexPluginStatus {
  const homeDir = os.homedir();
  const bundledManifest = getBundledPluginManifest(packageRoot);
  const managedPluginDir = getManagedPluginDir(homeDir);
  const sourceVersion = existsSync(path.join(managedPluginDir, ".codex-plugin", "plugin.json"))
    ? readJsonFile<PluginManifest>(
        path.join(managedPluginDir, ".codex-plugin", "plugin.json"),
      ).version
    : null;
  const codexAvailable = commandExists("codex");
  const marketplaceRoot = getMarketplaceRoot(homeDir);
  let marketplaceRegistered = false;
  let installedVersion: string | null = null;

  if (codexAvailable) {
    const listedMarketplaces = spawnSync("codex", ["plugin", "marketplace", "list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    marketplaceRegistered =
      listedMarketplaces.status === 0 &&
      parseMarketplaceRegistered(listedMarketplaces.stdout || "", marketplaceRoot);

    const listedPlugins = spawnSync("codex", ["plugin", "list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (listedPlugins.status === 0) {
      installedVersion = parseInstalledPluginVersion(listedPlugins.stdout || "");
    }
  }

  return {
    pluginName: bundledManifest.name,
    marketplaceName: MARKETPLACE_NAME,
    bundledVersion: bundledManifest.version,
    sourceVersion,
    installedVersion,
    codexAvailable,
    marketplaceRegistered,
    upToDate: installedVersion === bundledManifest.version,
    bundledPluginDir: getBundledPluginDir(packageRoot),
    managedPluginDir,
    marketplaceFile: getMarketplaceFile(homeDir),
    marketplaceRoot,
  };
}

export function installCodexPlugin(packageRoot: string): CodexPluginStatus {
  const homeDir = os.homedir();
  ensureMarketplaceManifest(homeDir);
  syncBundledPlugin(packageRoot, homeDir);

  const afterSync = getCodexPluginStatus(packageRoot);
  if (!afterSync.codexAvailable) {
    return {
      ...afterSync,
      marketplaceRegistered: false,
      installedVersion: null,
      upToDate: false,
    };
  }

  ensureMarketplaceRegistered(homeDir);

  const beforeInstall = getCodexPluginStatus(packageRoot);
  if (beforeInstall.installedVersion === beforeInstall.bundledVersion) {
    return beforeInstall;
  }

  const installed = spawnSync(
    "codex",
    ["plugin", "add", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (installed.status !== 0) {
    throw new Error((installed.stderr || installed.stdout || "Failed to install Codex plugin.").trim());
  }

  return getCodexPluginStatus(packageRoot);
}
