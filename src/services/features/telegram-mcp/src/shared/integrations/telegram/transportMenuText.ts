export function buildLinkMenuText(input: {
  title: string;
  activeSessionLine: string;
  choosePartnerLine: string;
  hintLine: string;
}): string {
  return [
    input.title,
    "",
    input.activeSessionLine,
    "",
    input.choosePartnerLine,
    input.hintLine,
  ].join("\n");
}

export function buildInboxMenuText(input: {
  title: string;
  activeSessionLine: string;
  storedMessagesLine: string;
  chooseMessageLine: string;
  emptyLine: string;
  total: number;
}): string {
  return [
    input.title,
    "",
    input.activeSessionLine,
    input.storedMessagesLine,
    "",
    input.total > 0 ? input.chooseMessageLine : input.emptyLine,
  ].join("\n");
}

export function buildMainMenuText(input: {
  title: string;
  inboxMessagesLine: string;
  projectLine?: string | null;
  partnerLine?: string | null;
  partnerHintLine?: string | null;
  linkHintLine?: string | null;
}): string {
  return [
    input.title,
    "",
    input.inboxMessagesLine,
    ...(input.projectLine ? [input.projectLine] : []),
    ...(input.partnerLine
      ? ["", input.partnerLine, "", input.partnerHintLine]
      : ["", input.linkHintLine]),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function buildAdminMainMenuText(input: {
  title: string;
  gatewayClientsLine?: string | null;
  connectedClientsLine?: string | null;
  registeredClientsLine?: string | null;
  unavailableLine?: string | null;
  hintLine: string;
}): string {
  return [
    input.title,
    "",
    ...(input.unavailableLine
      ? [input.unavailableLine]
      : [
          input.gatewayClientsLine,
          input.connectedClientsLine,
          input.registeredClientsLine,
        ]),
    "",
    input.hintLine,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function buildBufferMenuText(input: {
  title: string;
  activeSessionLine: string;
  tmuxTargetLine: string;
  exportHintLine: string;
  exportModesLine: string;
}): string {
  return [
    input.title,
    "",
    input.activeSessionLine,
    input.tmuxTargetLine,
    "",
    input.exportHintLine,
    input.exportModesLine,
  ].join("\n");
}

export function buildBrowserMenuText(input: {
  title: string;
  activeSessionLine: string;
  storedScreenshotsLine: string;
  chooseActionLine: string;
}): string {
  return [
    input.title,
    "",
    input.activeSessionLine,
    input.storedScreenshotsLine,
    "",
    input.chooseActionLine,
  ].join("\n");
}

export function buildSettingsMenuText(input: {
  title: string;
  activeSessionLine: string;
  hintLine: string;
}): string {
  return [
    input.title,
    "",
    input.activeSessionLine,
    "",
    input.hintLine,
  ].join("\n");
}

export function buildScreenshotsMenuText(input: {
  title: string;
  activeSessionLine: string;
  storedScreenshotsLine: string;
  chooseScreenshotLine: string;
  emptyLine: string;
  total: number;
}): string {
  return [
    input.title,
    "",
    input.activeSessionLine,
    input.storedScreenshotsLine,
    "",
    input.total > 0 ? input.chooseScreenshotLine : input.emptyLine,
  ].join("\n");
}

export function buildStorageMenuText(input: {
  title: string;
  activeSessionLine: string;
  storedFilesLine: string;
  chooseFileLine: string;
  emptyLine: string;
  total: number;
}): string {
  return [
    input.title,
    "",
    input.activeSessionLine,
    input.storedFilesLine,
    "",
    input.total > 0 ? input.chooseFileLine : input.emptyLine,
  ].join("\n");
}

export function buildPartnerMenuText(input: {
  title: string;
  activeSessionLine: string;
  linkedPartnerLine?: string | null;
  noPartnerLine?: string | null;
  useLinkFirstLine?: string | null;
  promptHintLine?: string | null;
  promptFormatLine?: string | null;
}): string {
  if (!input.linkedPartnerLine) {
    return [
      input.title,
      "",
      input.activeSessionLine,
      "",
      input.noPartnerLine,
      input.useLinkFirstLine,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  return [
    input.title,
    "",
    input.activeSessionLine,
    input.linkedPartnerLine,
    "",
    input.promptHintLine,
    input.promptFormatLine,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function buildLocalMenuText(input: {
  title: string;
  activeSessionLine: string;
  linkStatusLine: string;
  hintTitleLine: string;
  hintBodyLine: string;
}): string {
  return [
    input.title,
    "",
    input.activeSessionLine,
    input.linkStatusLine,
    "",
    input.hintTitleLine,
    input.hintBodyLine,
  ].join("\n");
}

export function buildProjectsMenuText(input: {
  title: string;
  gatewayNotConfiguredLine?: string | null;
  useLocalInsteadLine?: string | null;
  activeSessionLine?: string | null;
  openProjectLine?: string | null;
  projectCountLine?: string | null;
  inviteHintLine?: string | null;
}): string {
  if (input.gatewayNotConfiguredLine) {
    return [
      input.title,
      "",
      input.gatewayNotConfiguredLine,
      input.useLocalInsteadLine,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  return [
    input.title,
    "",
    input.activeSessionLine,
    input.openProjectLine,
    input.projectCountLine,
    "",
    input.inviteHintLine,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function buildCollabToolsMenuText(input: {
  title: string;
  activeSessionLine: string;
  projectCountLine: string;
  sessionCountLine: string;
  broadcastLine: string;
  historyLine: string;
  hintLine: string;
}): string {
  return [
    input.title,
    "",
    input.activeSessionLine,
    input.projectCountLine,
    input.sessionCountLine,
    "",
    input.broadcastLine,
    input.historyLine,
    input.hintLine,
  ].join("\n");
}

export function buildCollabDeleteMenuText(input: {
  title: string;
  activeSessionLine: string;
  totalCountLine: string;
  ownerCountLine: string;
  chooseLine: string;
  bodyLine: string;
  ownerHintLine: string;
}): string {
  return [
    input.title,
    "",
    input.activeSessionLine,
    input.totalCountLine,
    input.ownerCountLine,
    "",
    input.chooseLine,
    input.bodyLine,
    input.ownerHintLine,
  ].join("\n");
}

export function buildAdminClientSessionsMenuText(input: {
  title: string;
  clientLine: string;
  chooseScopeLine: string;
}): string {
  return [input.title, "", input.clientLine, "", input.chooseScopeLine].join(
    "\n",
  );
}

export function buildAdminClientSessionListText(input: {
  title: string;
  scopeLine: string;
  clientLine: string;
  emptyLine?: string | null;
  chooseLine?: string | null;
}): string {
  return [
    input.title,
    "",
    input.scopeLine,
    input.clientLine,
    "",
    input.emptyLine ?? input.chooseLine,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function buildAdminClientSessionDetailText(input: {
  title: string;
  sessionLine: string;
  localSessionId: string;
  projectLine?: string | null;
}): string {
  return [
    input.title,
    "",
    input.sessionLine,
    `ID: <code>${input.localSessionId}</code>`,
    ...(input.projectLine ? [input.projectLine] : []),
  ].join("\n");
}

export function buildAdminToolsMenuText(input: {
  title: string;
  clientEnvHelpLine: string;
}): string {
  return [input.title, "", input.clientEnvHelpLine].join("\n");
}
