import { getNetwork } from "@qorechain/sdk";
const net = getNetwork("testnet");
const hash = process.argv[2]!;
const res = await fetch(`${net.endpoints.rest}/cosmos/tx/v1beta1/txs/${hash}`);
const d = (await res.json()) as any;
const tr = d.tx_response;
console.log("code:", tr.code, "| raw_log:", (tr.raw_log || "").slice(0, 800));
for (const e of tr.events ?? []) {
  const attrs = (e.attributes ?? []).map((a: any) => `${a.key}=${String(a.value).slice(0, 120)}`).join(" ");
  if (e.type.includes("abstract") || e.type.includes("execution") || e.type.includes("auth") || e.type === "message")
    console.log("•", e.type, "|", attrs.slice(0, 400));
}
