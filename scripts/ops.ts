/**
 * ops.ts — contract calls as whichever account env-file provides.
 *
 *   npx tsx --env-file=.env        scripts/ops.ts vendor <addr> <true|false>
 *   npx tsx --env-file=.env        scripts/ops.ts deposit <amount-qor>
 *   npx tsx --env-file=.env        scripts/ops.ts pause <true|false>
 *   npx tsx --env-file=.env.vendor scripts/ops.ts submit <amount-qor> <ref-text>
 *
 * Needs a live EVM window for the calling account (`pnpm window[:agent] open`).
 */
import { createPublicClient, createWalletClient, http, parseEther, parseAbi, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { qoreDiana, ADDRESSES } from "../agent/config.js";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: qoreDiana, transport: http() });
const wallet = createWalletClient({ account, chain: qoreDiana, transport: http() });

const OPS_ABI = parseAbi([
  "function setVendorAllowed(address vendor, bool allowed)",
  "function setPaused(bool p)",
  "function deposit() payable",
  "function submit(uint256 amount, bytes32 ref) returns (uint256)",
]);

const commands: Record<string, () => Promise<void>> = {
  vendor: async () => {
    const [vendor, allowed] = process.argv.slice(3);
    if (!vendor || !allowed) throw new Error("usage: ops.ts vendor <addr> <true|false>");
    const tx = await wallet.writeContract({
      address: ADDRESSES.vault,
      abi: OPS_ABI,
      functionName: "setVendorAllowed",
      args: [vendor as `0x${string}`, allowed === "true"],
    });
    console.log(`setVendorAllowed(${vendor}, ${allowed}): ${tx}`);
  },
  deposit: async () => {
    const [qor] = process.argv.slice(3);
    if (!qor) throw new Error("usage: ops.ts deposit <amount-qor>");
    const tx = await wallet.writeContract({
      address: ADDRESSES.vault,
      abi: OPS_ABI,
      functionName: "deposit",
      value: parseEther(qor),
    });
    console.log(`deposit(${qor} QOR): ${tx}`);
  },
  pause: async () => {
    const [p] = process.argv.slice(3);
    const tx = await wallet.writeContract({
      address: ADDRESSES.vault,
      abi: OPS_ABI,
      functionName: "setPaused",
      args: [p === "true"],
    });
    console.log(`setPaused(${p}): ${tx}`);
  },
  submit: async () => {
    const [qor, ...refParts] = process.argv.slice(3);
    if (!qor || !refParts.length) throw new Error("usage: ops.ts submit <amount-qor> <ref-text>");
    const ref = stringToHex(refParts.join(" "), { size: 32 });
    const tx = await wallet.writeContract({
      address: ADDRESSES.registry,
      abi: OPS_ABI,
      functionName: "submit",
      args: [parseEther(qor), ref],
    });
    const r = await publicClient.waitForTransactionReceipt({ hash: tx });
    const log = r.logs.find((l) => l.address.toLowerCase() === ADDRESSES.registry.toLowerCase());
    console.log(`submit(${qor} QOR, "${refParts.join(" ")}"): ${tx} · id=${log?.topics[1] ? BigInt(log.topics[1]).toString() : "?"}`);
  },
};

const run = commands[process.argv[2] ?? ""];
if (!run) {
  console.error(`Use: ${Object.keys(commands).join(" | ")}`);
  process.exit(1);
}
run().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
