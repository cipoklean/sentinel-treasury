import { $, $$, esc, trunc, qor, num, uqorToQor, ago, utc, txUrl, addrUrl, fetchState, setLive } from "./common.js";

const REFRESH_MS = 10_000;
const open = new Set();
let filter = "ALL";
let last = null;

const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);
const bar = (id, p) => { $(id).style.width = `${p}%`; };
const link = (h, label) => (h ? `<a href="${txUrl(h)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(label ?? trunc(h, 8, 4))} ↗</a>` : "–");

function attemptHtml(a) {
  const r = a.receipt;
  const rc = r
    ? `<span class="chip ${r.verified ? "ok" : "bad"}">${r.verified ? "receipt verified" : "receipt invalid"}</span> EIP-712 · signer ${esc(trunc(r.signer, 6, 4))}`
    : a.decisionRefText
      ? `<span class="chip">pre-receipt</span> ref "${esc(a.decisionRefText)}"`
      : `<span class="chip">no receipt</span>`;
  const llm = r?.llm
    ? `<div class="llm"><b>${esc(r.llm.model)}</b> · ${r.llm.vetoed ? "VETO" : "no veto"}${r.llm.confidence != null ? ` · confidence ${Number(r.llm.confidence).toFixed(2)}` : ""}<br/>${esc(r.llm.reason)}</div>`
    : "";
  return `<div class="att ${esc(a.outcome)}">
    <div class="att-top"><span class="att-o">${esc(a.outcome.replace("-", " "))}</span><span class="att-r">${esc(a.reason)}</span>${a.withMandate ? `<span class="chip ok">ML-DSA-87 mandate · pqcVerify</span>` : ""}</div>
    <div class="att-m">
      <span>${a.block ? `block ${num(a.block)}` : "off-chain"}</span>
      <span>${a.ts ? `${esc(utc(a.ts))} · ${esc(ago(a.ts))}` : ""}</span>
      <span>${esc(a.rail)}</span>
      <span>${a.tx ? `tx ${link(a.tx, trunc(a.tx, 10, 6))}` : ""}</span>
    </div>
    <div class="att-m"><span>${rc}</span>${a.decisionRef && !a.decisionRefText ? `<span>decisionRef ${esc(trunc(a.decisionRef, 10, 6))}</span>` : ""}</div>
    ${llm}
  </div>`;
}

function rowHtml(inv) {
  const id = String(inv.id).padStart(3, "0");
  const v = inv.verdict.toLowerCase();
  const isOpen = open.has(inv.id);
  const proof = inv.proof?.tx ? link(inv.proof.tx, "tx") + (inv.proof.decisionRef ? ` · ref ${esc(inv.proof.decisionRef.slice(0, 10))}…` : "") : "–";
  const flags = [inv.overPerTxCap && "over per-tx cap", inv.overThreshold && !inv.overPerTxCap && "mandate tier"].filter(Boolean).join(" · ");
  return `<button class="b-row" aria-expanded="${isOpen}" aria-controls="d-${inv.id}" data-id="${inv.id}">
      <span class="id">${id}</span>
      <span class="ref">${esc(inv.ref)}<small>${esc(inv.reason ?? "awaiting agent")}${inv.llm && !inv.llm.vetoed && inv.llm.confidence != null ? ` · llm ${Number(inv.llm.confidence).toFixed(2)}` : ""}</small></span>
      <span class="vendor" title="${esc(inv.vendor)}">${esc(trunc(inv.vendor))}</span>
      <span class="amt">${qor(inv.amountQor)} QOR</span>
      <span class="vd ${v}">${esc(inv.verdict)}</span>
      <span class="proof">${proof}</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>
    <div class="detail ${isOpen ? "on" : ""}" id="d-${inv.id}">
      <div class="att-m" style="padding:12px 0 6px">submitted ${esc(utc(inv.createdAt))} · ${link(inv.submitTx, "submit tx")} · vendor <a href="${addrUrl(inv.vendor)}" target="_blank" rel="noopener">${esc(inv.vendor)}</a>${flags ? ` · ${esc(flags)}` : ""}</div>
      ${inv.attempts.length ? inv.attempts.map(attemptHtml).join("") : `<div class="att"><div class="att-top"><span class="att-o">pending</span><span class="att-r">no agent action yet</span></div></div>`}
    </div>`;
}

function renderRows() {
  if (!last) return;
  const list = last.invoices.filter((i) =>
    filter === "ALL" ? true : filter === "OPEN" ? i.verdict === "PENDING" || i.verdict === "VETOED" : i.verdict === filter,
  );
  $("#rows").innerHTML = list.length ? [...list].reverse().map(rowHtml).join("") : `<div class="empty">no invoices match</div>`;
}

function render(s) {
  last = s;
  setLive(s);
  const w = s.window;
  const p = s.policy;
  const pv = s.provenance;

  $("#prov").innerHTML = `rebuilt from <b>${num(pv.logs)} logs</b> · blocks ${num(pv.fromBlock)} → ${num(pv.toBlock)}<br/>
    <span class="ok">${s.stats.receiptsVerified}/${s.stats.receipts}</span> signed receipts verified · agent <a href="${addrUrl(s.agent.evm)}" target="_blank" rel="noopener">${esc(trunc(s.agent.evm))}</a>`;

  const banner = $("#banner");
  if (p.paused) { banner.className = "banner on"; banner.textContent = "Kill switch engaged · PolicyVault is paused by the operator. Every payment is refused."; }
  else if (!w.found || !w.live) { banner.className = "banner on warn"; banner.textContent = "Agent EVM window is closed or exhausted · the chain admits no agent transactions until the guardian renews it."; }
  else banner.className = "banner";

  if (w.found) {
    const total = w.expiryHeight - w.openedHeight;
    $("#m-blocks").textContent = num(w.remainingBlocks);
    $("#m-blocks-u").textContent = `of ${num(total)} · expires #${num(w.expiryHeight)}`;
    bar("#b-blocks", pct(w.remainingBlocks, total));
    $("#m-txs").innerHTML = `${num(w.remainingTxs)}<small>/ ${num(w.maxTxs)}</small>`;
    $("#m-txs-u").textContent = `scoped to ${w.allowedTargets.length} targets`;
    bar("#b-txs", pct(w.remainingTxs, w.maxTxs));
    $("#m-val").innerHTML = `${qor(uqorToQor(w.remainingValueUqor), 3)}<small>QOR</small>`;
    $("#m-val-u").textContent = `of ${qor(uqorToQor(w.maxValueUqor))} QOR · ${num(w.remainingValueUqor)} uqor`;
    bar("#b-val", pct(Number(w.remainingValueUqor), Number(w.maxValueUqor)));
  } else {
    ["#m-blocks", "#m-txs", "#m-val"].forEach((id) => ($(id).textContent = "closed"));
  }
  $("#m-bal").innerHTML = `${qor(p.vaultBalanceQor, 3)}<small>QOR</small>`;
  $("#m-bal-u").textContent = `${qor(p.totalPaidQor)} QOR paid lifetime`;
  bar("#b-bal", pct(Number(p.vaultBalanceQor), Number(p.vaultBalanceQor) + Number(p.totalPaidQor)));
  $("#m-spent").innerHTML = `${qor(p.spentTodayQor, 3)}<small>QOR</small>`;
  $("#m-spent-u").textContent = `of ${qor(p.dailyCapQor)} QOR daily cap`;
  bar("#b-spent", pct(Number(p.spentTodayQor), Number(p.dailyCapQor)));

  renderRows();
  $("#board-meta").textContent = `${s.stats.invoices} invoices · ${s.stats.paid} settled · ${s.stats.refusedOnChain} on-chain refusals`;
  $("#updated").textContent = `updated ${new Date(s.ts).toLocaleTimeString("en-GB", { hour12: false })} · every ${REFRESH_MS / 1000}s`;

  $("#ledger-n").textContent = `${s.events.length} events`;
  $("#ledger").innerHTML = s.events.map((e) => `<li>
      <span class="kind ${esc(e.kind)}">${esc(e.kind.replace(/([a-z])([A-Z])/g, "$1 $2"))}</span>
      <span class="what">${e.invoiceId ? `<b>#${esc(String(e.invoiceId).padStart(3, "0"))}</b> · ` : ""}${esc(e.detail)}${e.amountQor ? ` · ${qor(e.amountQor)} QOR` : ""}<small>block ${num(e.block)} · ${esc(e.contract)}</small></span>
      <span class="when">${esc(ago(e.ts))}<br/><a href="${txUrl(e.tx)}" target="_blank" rel="noopener">tx ↗</a></span>
    </li>`).join("");

  $("#policy").innerHTML = [
    ["Per-tx cap", `${qor(p.perTxCapQor)} QOR`],
    ["Daily cap", `${qor(p.dailyCapQor)} QOR`],
    ["Mandate threshold", `> ${qor(p.mandateThresholdQor)} QOR · ML-DSA-87`],
    ["Vault paused", p.paused ? "YES" : "no", p.paused],
    ["Vault agent", `<a href="${addrUrl(p.vaultAgent)}" target="_blank" rel="noopener">${esc(trunc(p.vaultAgent))}</a>`],
    ["Window", w.found ? (w.live ? "live" : "exhausted") : "none", !w.found || !w.live],
    ["Window scope", w.found && w.allowedTargets.length ? w.allowedTargets.map((a) => esc(trunc(a))).join("<br/>") : "unscoped"],
    ["Operator", `<a href="${addrUrl(s.operator.evm)}" target="_blank" rel="noopener">${esc(trunc(s.operator.evm))}</a>`],
  ].map(([k, v, hot]) => `<div class="p-row"><span class="p-k">${k}</span><span class="p-v ${hot ? "hot" : ""}">${v}</span></div>`).join("");
}

$("#rows").addEventListener("click", (e) => {
  const b = e.target.closest(".b-row");
  if (!b) return;
  const id = Number(b.dataset.id);
  open.has(id) ? open.delete(id) : open.add(id);
  b.setAttribute("aria-expanded", String(open.has(id)));
  $(`#d-${id}`).classList.toggle("on", open.has(id));
});
$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-f]");
  if (!b) return;
  filter = b.dataset.f;
  $$("#filters button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  renderRows();
});

async function refresh() {
  try {
    render(await fetchState());
  } catch (e) {
    setLive(null, e);
    $("#updated").textContent = `rpc error · retrying`;
    if (!last) $("#rows").innerHTML = `<div class="empty">could not reach qorechain-diana: ${esc(e.message)}</div>`;
  }
}
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
