import type { ShellTab } from "../shell/types";
import type { NetworkSample } from "../../types";

export function networkPatch(
  tab: ShellTab,
  sample: NetworkSample,
  rxBps: number,
  txBps: number,
): ShellTab {
  return {
    ...tab,
    networkSample: sample,
    networkRxBps: rxBps,
    networkTxBps: txBps,
    networkHistory: [...tab.networkHistory, { sampledAt: sample.sampledAt, rxBps, txBps }].slice(-40),
  };
}
