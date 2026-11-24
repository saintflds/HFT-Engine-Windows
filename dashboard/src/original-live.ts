import { el } from "./dom";
import { startLiveDashboard } from "./live-dashboard";

export function addModeNavigation(root: HTMLElement, active: "replay" | "live" | "history" | "sierra-live"): HTMLElement {
  const nav = el("nav", "bar mode-nav", root);
  nav.setAttribute("aria-label", "HFTENGINE modes");
  const mnqReplay = "mnq_20261023_1330_depth_queue_30min";
  const session = new URLSearchParams(location.search).get("session") ?? "sample";
  const selected = active === "replay" ? session === mnqReplay ? "mnq-replay" : session === "sample" ? "sample" : "replay" : active;
  const links = [
    { label: "MNQ 30min replay", url: `/?session=${mnqReplay}&play=0`, key: "mnq-replay" },
    { label: "Live MNQ", url: "/?live=mnq", key: "live" },
    { label: "Live MNQ – Sierra Engine", url: "/?live=mnq&account=sierra", key: "sierra-live" },
    { label: "MNQ backtest", url: "/?sierra=mnq", key: "history" },
    { label: "Sample replay", url: "/?session=sample", key: "sample" },
  ];
  for (const [index, link] of links.entries()) {
    if (index) nav.append("  │  ");
    const a = el("a", "", nav);
    a.href = link.url;
    a.textContent = link.label;
    if (link.key === selected) a.setAttribute("aria-current", "page");
  }
  return nav;
}

export const startOriginalLive = startLiveDashboard;
