import type {
  FirefoxAttachTabRecord,
} from "./types";
import { formatLocalTimestamp } from "../../../shared/lib/time/localTimestamp";

export type FirefoxAttachInstanceRecord = {
  instanceId: string;
  browser: "firefox" | "chrome";
  extensionVersion: string;
  profileName?: string | undefined;
  connectedAt: string;
  lastSeenAt: string;
  capabilities: string[];
  tabs: FirefoxAttachTabRecord[];
  activeTab: FirefoxAttachTabRecord | null;
};

export class BrowserAttachRegistry {
  private readonly instances = new Map<string, FirefoxAttachInstanceRecord>();

  public setConnected(input: {
    instanceId: string;
    browser: "firefox" | "chrome";
    extensionVersion: string;
    profileName?: string;
    capabilities: string[];
  }): FirefoxAttachInstanceRecord {
    const now = formatLocalTimestamp(new Date());
    const existing = this.instances.get(input.instanceId);
    const next: FirefoxAttachInstanceRecord = {
      instanceId: input.instanceId,
      browser: input.browser,
      extensionVersion: input.extensionVersion,
      ...(input.profileName ? { profileName: input.profileName } : {}),
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now,
      capabilities: [...input.capabilities],
      tabs: existing?.tabs ?? [],
      activeTab: existing?.activeTab ?? null,
    };
    this.instances.set(input.instanceId, next);
    return next;
  }

  public touch(instanceId: string): void {
    const existing = this.instances.get(instanceId);
    if (!existing) {
      return;
    }
    existing.lastSeenAt = formatLocalTimestamp(new Date());
  }

  public setTabs(instanceId: string, tabs: FirefoxAttachTabRecord[]): void {
    const existing = this.instances.get(instanceId);
    if (!existing) {
      return;
    }
    existing.tabs = tabs.map((tab) => ({ ...tab }));
    const reportedActive = tabs.find((tab) => tab.active) ?? null;
    const previousActiveStillPresent = existing.activeTab
      ? tabs.some((tab) => tab.tab_id === existing.activeTab?.tab_id)
      : false;
    existing.activeTab =
      reportedActive ?? (previousActiveStillPresent ? existing.activeTab : null);
    existing.lastSeenAt = formatLocalTimestamp(new Date());
  }

  public removeTab(instanceId: string, tabId: number): void {
    const existing = this.instances.get(instanceId);
    if (!existing) {
      return;
    }
    existing.tabs = existing.tabs.filter((tab) => tab.tab_id !== tabId);
    if (existing.activeTab?.tab_id === tabId) {
      existing.activeTab = null;
    }
    existing.lastSeenAt = formatLocalTimestamp(new Date());
  }

  public setActiveTab(
    instanceId: string,
    tab: FirefoxAttachTabRecord | null,
  ): void {
    const existing = this.instances.get(instanceId);
    if (!existing) {
      return;
    }
    existing.activeTab = tab ? { ...tab } : null;
    existing.lastSeenAt = formatLocalTimestamp(new Date());
  }

  public updateTab(instanceId: string, tab: FirefoxAttachTabRecord): void {
    const existing = this.instances.get(instanceId);
    if (!existing) {
      return;
    }
    const nextTabs = [...existing.tabs];
    const index = nextTabs.findIndex((item) => item.tab_id === tab.tab_id);
    if (index >= 0) {
      nextTabs[index] = { ...nextTabs[index], ...tab };
    } else {
      nextTabs.push({ ...tab });
    }
    existing.tabs = nextTabs;
    if (tab.active) {
      existing.activeTab = { ...tab };
    }
    existing.lastSeenAt = formatLocalTimestamp(new Date());
  }

  public remove(instanceId: string): void {
    this.instances.delete(instanceId);
  }

  public get(instanceId: string): FirefoxAttachInstanceRecord | undefined {
    const existing = this.instances.get(instanceId);
    if (!existing) {
      return undefined;
    }
    return {
      ...existing,
      tabs: existing.tabs.map((tab) => ({ ...tab })),
      activeTab: existing.activeTab ? { ...existing.activeTab } : null,
      capabilities: [...existing.capabilities],
    };
  }

  public listInstances(): FirefoxAttachInstanceRecord[] {
    return Array.from(this.instances.values()).map((item) => ({
      ...item,
      tabs: item.tabs.map((tab) => ({ ...tab })),
      activeTab: item.activeTab ? { ...item.activeTab } : null,
      capabilities: [...item.capabilities],
    }));
  }
}
