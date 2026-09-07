/** Hardcoded Slack E2E harness defaults (env can override on the server). */
export const SLACK_E2E = {
  workspace: "connect-8w75152",
  channelId: "C0BVCSA4T2P",
  threadTs: "1788808933.776429",
  permalink:
    "https://connect-8w75152.slack.com/archives/C0BVCSA4T2P/p1788808933776429",
  channelName: "#control-e2e",
  fixtureText:
    "[E2E fixture · Priya · #infra] Does staging credential rotation block deploys today? Need an answer before standup.",
} as const;

export function slackPermalink(
  channelId: string,
  messageTs: string,
  workspace = SLACK_E2E.workspace
) {
  const p = messageTs.replace(".", "");
  return `https://${workspace}.slack.com/archives/${channelId}/p${p}`;
}
