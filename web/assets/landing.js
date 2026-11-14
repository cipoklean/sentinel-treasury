import { $, $$, esc, qor, num, uqorToQor, ago, txUrl, addrUrl, trunc, fetchState, setLive, initCopy, initReveal } from "./common.js";

const T = {
  paid1: "0x7bdd0aadd4e0485f59bd289ba7c0f0525c646655781790000cbbb07d9ae9e212",
  window: "A6293E8A882E295054A751E7E21C3A3475FFBA6C3FD2FDDEEF026D4D3753655F",
  aaLink: "14FE8A997D24CB0AD43D5E8F7FADC5071D29DBE2317249C73EC88DDB5D777733",
  aaPay: "E380CE11957A5388269789E9F34DE3EE254B5E7E76BB1F6C506CA28B57F912E1",
  aaRefused: "34B98142040121032A9AF63EFE15109731BC01E4B881880306FCB3AE53552DB9",
  overCap: "0x7ac3b2622e365471726365857e766fa65013c4b218edd75ea9d191829e703c73",
  noMandate: "0xbaee26ec6e71b0ced3987042aea205bed4c7b590ec209a98c71397a1848c9817",
  withMandate: "0xf8b9e372ac5ea069565a5bc021e85dc14e4b00f5347b43350b9c039e662b1567",
  agentPqc: "B78ACBBC5753BD3DC7E7A23F66FCBE19C4C0DAE8E844EB45D3C70D65B721C63B",
  vaultDeploy: "0x08b4306a185fb8b7cf6fe64fde6960783daec7e0d9401ab090dfc7f5e1e157fa",
  registryDeploy: "0x944d505790fa0134c2b9c4e9b7dd5c7eb94a9424e32704b59ce6220d8944ced5",
};
const SRC = "https://github.com/cipoklean/sentinel-treasury/blob/main/";
const tx = (h, cls = "ok", label) => `<span class="outcome ${cls}">${label ?? ""}</span><a class="txlink" href="${txUrl(h)}" target="_blank" rel="noopener">${trunc(h, 8, 4)}</a>`;

const EVIDENCE = [
  ["Autonomous agent", "<code>agent/</code> loop scans the registry, signs an EIP-712 receipt and pays.", tx(T.paid1, "ok", "paid")],
  ["Scoped EVM window", "<code>allowed_targets</code> = vault + registry, 17,280 blocks, 20 txs, 4 QOR.", tx(T.window, "chain", "open")],
  ["Target limits", "Out-of-scope transfer from the agent EOA.", `<span class="outcome chain">rejected</span>at broadcast · <span class="muted">"window does not list recipient"</span>`],
  ["Smart-account spending rules", "<code>x/abstractaccount</code> rule <code>sentinel-agent-evm</code>: 1 QOR/tx, 5 QOR/day, 7-day expiry.", tx(T.aaLink, "chain", "link")],
  ["Paid via abstract account", "Agent authenticator executes <code>pay(4)</code> through the operator's account.", tx(T.aaPay, "ok", "paid")],
  ["Protocol refusal", "<code>abstractaccount_execution_failed</code> for a call outside <code>allowed_evm_calls</code>.", tx(T.aaRefused, "no", "refused")],
  ["Contract-level policy", "PolicyVault per-tx cap: 25 QOR invoice vs 5 QOR cap.", tx(T.overCap, "no", "refused")],
  ["Authenticated messaging", "Refused without mandate, then paid with an operator ML-DSA-87 mandate verified by <code>pqcVerify</code>.", `${tx(T.noMandate, "no", "refused")}<br/>${tx(T.withMandate, "ok", "paid")}`],
  ["PQ key registration", "Both accounts register ML-DSA-87 keys with proof of possession.", `${tx(T.agentPqc, "chain", "agent")}<br/><span class="outcome chain">operator</span><span class="muted">6092B826…</span>`],
  ["Contracts deployed", "Via <code>forge create</code> so constructors run on the real node with live precompiles.", `${tx(T.vaultDeploy, "chain", "vault")}<br/>${tx(T.registryDeploy, "chain", "registry")}`],
];

const ATTACKS = [
  { t: "Send the agent's funds to my own wallet", layer: "l0", badge: "L0 · chain window", h: "Rejected at broadcast.",
    p: "The agent EOA's EVM window lists exactly two allowed targets: PolicyVault and InvoiceRegistry. A transfer to any other recipient never makes it into a block. The node rejects it before execution, with no contract involved.",
    proof: `observed: <span style="color:var(--board-ink)">"window does not list recipient as allowed target"</span>` },
  { t: "Pay a 25 QOR invoice in one shot", layer: "l2", badge: "L2 · PolicyVault", h: "Refused on-chain: over per-tx cap.",
    p: "The vault re-checks every payment no matter what the agent decided. 25 QOR is over the 5 QOR per-tx cap, so the vault emits PaymentRefused and moves nothing. The window budget (4 QOR) would have stopped it too.",
    proof: `PaymentRefused · <a href="${txUrl(T.overCap)}" target="_blank" rel="noopener">${T.overCap}</a>` },
  { t: "Pay 3 QOR without the operator's sign-off", layer: "l2", badge: "L2 · pqcVerify 0x0A01", h: "Refused on-chain: mandate required.",
    p: "Above 2 QOR the vault requires an operator mandate signed with ML-DSA-87 and verifies it inside Solidity with the pqcVerify precompile. A stolen ECDSA key can't produce one, and neither can a quantum attacker.",
    proof: `refused · <a href="${txUrl(T.noMandate)}" target="_blank" rel="noopener">${trunc(T.noMandate, 10, 6)}</a><br/>paid once the guardian issued a real mandate · <a href="${txUrl(T.withMandate)}" target="_blank" rel="noopener">${trunc(T.withMandate, 10, 6)}</a>` },
  { t: "Call another contract through the smart account", layer: "l1", badge: "L1 · x/abstractaccount", h: "Rejected by the protocol.",
    p: "The agent key's authenticator on the operator account carries spending rule sentinel-agent-evm: allowed_evm_calls = [vault], 1 QOR per tx, 5 QOR per day, expiring after 7 days. Any other call fails with abstractaccount_execution_failed.",
    proof: `abstractaccount_execution_failed · <a href="${txUrl(T.aaRefused)}" target="_blank" rel="noopener">${trunc(T.aaRefused, 10, 6)}</a>` },
  { t: "Open a wider window for itself", layer: "l3", badge: "custody split", h: "Impossible: wrong key.",
    p: "Opening or widening an EVM window is a hybrid-signed native tx that needs the account's ML-DSA-87 key. That key derives from a recovery code held only by the guardian. The agent process never loads it.",
    proof: `by construction · <a href="${SRC}guardian/env.ts" target="_blank" rel="noopener">guardian/env.ts</a> holds the recovery code · <a href="${SRC}agent/config.ts" target="_blank" rel="noopener">agent/config.ts</a> holds PRIVATE_KEY only` },
  { t: "Invoice myself, then pay it", layer: "l2", badge: "L2 · vendor allowlist", h: "Refused: vendor not allowed.",
    p: "Anyone can submit to InvoiceRegistry, but the vault only pays vendors the operator has allowlisted. An attacker-controlled vendor is refused on-chain.",
    proof: `<a href="${SRC}src/PolicyVault.sol" target="_blank" rel="noopener">PolicyVault._settle</a> · <a href="${SRC}test/PolicyVault.t.sol" target="_blank" rel="noopener">test_RefusesUnlistedVendor</a>` },
  { t: "Drain it slowly with many small payments", layer: "l0", badge: "L0 + L1 + L2", h: "Bounded three times over.",
    p: "The window caps total value at 4 QOR and 20 txs per 17,280 blocks. The abstract-account rule caps 5 QOR a day. The vault caps 20 QOR a day and pays allowlisted vendors only. The tightest bound wins, and each sits in a different enforcer.",
    proof: `window <a href="${txUrl(T.window)}" target="_blank" rel="noopener">${trunc(T.window, 8, 4)}</a> · rule <a href="${txUrl(T.aaLink)}" target="_blank" rel="noopener">${trunc(T.aaLink, 8, 4)}</a> · <a href="/dashboard">live budgets →</a>` },
  { t: "Pause the vault or loosen its policy", layer: "l2", badge: "L2 · pqcKeyStatus 0x0A02", h: "Not authorized.",
    p: "Every admin function is onlyOperator, and each one also checks through pqcKeyStatus that the operator still holds a proven post-quantum key. The agent key isn't the operator and never will be.",
    proof: `<a href="${SRC}src/PolicyVault.sol" target="_blank" rel="noopener">onlyOperator · _requireOperatorPqc()</a> · <a href="${SRC}test/PolicyVault.t.sol" target="_blank" rel="noopener">test_RevertWhen_NonOperatorAdmin</a>` },
];

const ADDRS = [
  ["PolicyVault", "treasury + policy", "0x18221b4d802b4Efc9B1B4099bab93c803ec2D1C9"],
  ["InvoiceRegistry", "payable invoices", "0x7CC179815f429E6cA53B0f56f2E0dF44b192B78D"],
  ["Agent", "hot · classical key · drill target", "0xBBCDb4F24461E7b73a344d2ff365Fb32080331a8"],
  ["Operator", "cold · ML-DSA-87", "0x9488BAD757ab796638f5Ad4ae5d8bE333AE77e6C"],
  ["pqcVerify", "precompile", "0x0000000000000000000000000000000000000a01"],
  ["pqcKeyStatus", "precompile", "0x0000000000000000000000000000000000000a02"],
];

/* ring ↔ layer highlighting */
function highlight(layer) {
  $$("[data-layer]").forEach((el) => el.classList.toggle("on", !!layer && el.dataset.layer === layer));
}
$$("svg.rings g[data-layer], .layer[data-layer]").forEach((el) => {
  el.addEventListener("mouseenter", () => highlight(el.dataset.layer));
  el.addEventListener("mouseleave", () => highlight(null));
  el.addEventListener("click", () => {
    const card = document.querySelector(`.layer[data-layer="${el.dataset.layer}"]`);
    if (el.tagName.toLowerCase() === "g" && card) card.scrollIntoView({ behavior: "smooth", block: "center" });
  });
});

/* drill */
function renderAttacks() {
  $("#attacks").innerHTML = ATTACKS.map((a, i) => `<li role="presentation"><button role="tab" id="atk-${i}" aria-selected="${i === 0}" aria-controls="verdict" data-i="${i}">
    <span class="i">${String(i + 1).padStart(2, "0")}</span><span>${esc(a.t)}</span><span class="x">stopped</span></button></li>`).join("");
  $("#attacks").addEventListener("click", (e) => { const b = e.target.closest("button[data-i]"); if (b) select(Number(b.dataset.i)); });
  $("#attacks").addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const cur = Number(document.activeElement?.dataset?.i ?? 0);
    const next = (cur + (e.key === "ArrowDown" ? 1 : -1) + ATTACKS.length) % ATTACKS.length;
    select(next); $(`#atk-${next}`).focus();
  });
  select(0);
}
function select(i) {
  const a = ATTACKS[i];
  $$("#attacks button").forEach((b) => b.setAttribute("aria-selected", String(Number(b.dataset.i) === i)));
  $("#verdict").setAttribute("aria-labelledby", `atk-${i}`);
  $("#verdict").innerHTML = `<p class="attempt">attacker with agent ECDSA key → <b>${esc(a.t.toLowerCase())}</b></p>
    <div class="stopper"><span class="badge">${esc(a.badge)}</span></div>
    <h3>${esc(a.h)}</h3><p>${esc(a.p)}</p><p class="proof-line">${a.proof}</p>`;
}
function countdown() {
  const drill = Date.UTC(2026, 10, 18);
  const d = Math.ceil((drill - Date.now()) / 86_400_000);
  $("#countdown").textContent = d > 1 ? `18 Nov · in ${d} days` : d === 1 ? "18 Nov · tomorrow" : d === 0 ? "18 Nov · today" : "18 Nov · completed";
}

/* live strip */
async function live() {
  try {
    const s = await fetchState();
    setLive(s);
    $("#h-paid").innerHTML = `${s.stats.paid}<small>/ ${s.stats.invoices}</small>`;
    $("#h-paid-u").textContent = `${qor(s.stats.settledQor)} QOR moved`;
    $("#h-refused").textContent = num(s.stats.refusedOnChain);
    if (s.window.found) {
      $("#h-window").innerHTML = `${qor(uqorToQor(s.window.remainingValueUqor), 2)}<small>QOR</small>`;
      $("#h-window-u").textContent = `${num(s.window.remainingTxs)} txs · ${num(s.window.remainingBlocks)} blocks left`;
    } else {
      $("#h-window").textContent = "closed";
    }
    $("#h-vault").innerHTML = `${qor(s.policy.vaultBalanceQor, 2)}<small>QOR</small>`;
    $("#h-vault-u").textContent = s.policy.paused ? "vault PAUSED" : `${qor(s.policy.spentTodayQor, 2)} of ${qor(s.policy.dailyCapQor)} spent today`;
    const last = s.events.find((e) => e.kind === "PaymentExecuted" || e.kind === "PaymentRefused" || e.kind === "AccountExecute");
    if (last) {
      $("#h-last").textContent = `${last.kind === "PaymentRefused" ? "REFUSED" : "PAID"} #${String(last.invoiceId).padStart(3, "0")}`;
      $("#h-last-u").innerHTML = `${esc(ago(last.ts))} · <a href="${txUrl(last.tx)}" target="_blank" rel="noopener">tx ↗</a>`;
    }
  } catch (e) {
    setLive(null, e);
    $$(".strip .skeleton").forEach((el) => (el.outerHTML = "–"));
  }
}

$("#evidence-rows").innerHTML = EVIDENCE.map(([a, b, c]) => `<tr><td>${a}</td><td>${b}</td><td>${c}</td></tr>`).join("");
$("#addrs").innerHTML = ADDRS.map(([n, sub, a]) => `<div class="addr"><div><div class="name">${n}</div><div class="sub">${sub}</div></div>
  <div class="addr-v"><a href="${addrUrl(a)}" target="_blank" rel="noopener" title="${a}">${trunc(a, 8, 6)}</a><button class="copy" data-copy="${a}" aria-label="Copy ${n} address">copy</button></div></div>`).join("");
renderAttacks();
countdown();
initCopy();
initReveal();
live();
setInterval(live, 20_000);
