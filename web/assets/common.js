export const EXPLORER = "https://explore.qore.network";
export const REPO = "https://github.com/cipoklean/sentinel-treasury";

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export const trunc = (a, head = 6, tail = 4) => {
  if (!a) return "–";
  const pre = a.startsWith("0x") ? 2 : 0;
  return a.length <= pre + head + tail + 1 ? a : a.slice(0, pre + head) + "…" + a.slice(-tail);
};

export const qor = (s, digits = 4) => {
  const n = Number(s);
  if (!Number.isFinite(n)) return "–";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
};
export const num = (n) => (n == null || !Number.isFinite(Number(n)) ? "–" : Number(n).toLocaleString("en-US"));
export const uqorToQor = (u) => Number(u) / 1e6;

export const txUrl = (h) => `${EXPLORER}/tx/${h}`;
export const addrUrl = (a) => `${EXPLORER}/address/${a}`;

export function ago(ts) {
  if (!ts) return "–";
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export const utc = (ts) => (ts ? new Date(ts * 1000).toISOString().replace("T", " ").slice(5, 19) + " UTC" : "–");

export async function fetchState() {
  const r = await fetch("/api/state", { cache: "no-store" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

export function setLive(s, err) {
  const pill = $("#live");
  if (!pill) return;
  const txt = $(".live-txt", pill);
  if (err) {
    pill.className = "live-pill err";
    txt.textContent = "rpc unreachable";
    pill.title = String(err.message ?? err);
    return;
  }
  pill.className = "live-pill ok";
  txt.textContent = `block ${num(s.network.head)}`;
  pill.title = `qorechain-diana head ${s.network.head} · ${utc(s.network.headTs)}`;
}

export function initCopy() {
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      const old = b.textContent;
      b.textContent = "copied";
      b.classList.add("done");
      setTimeout(() => { b.textContent = old; b.classList.remove("done"); }, 1400);
    } catch {}
  });
}

export function initReveal() {
  const els = $$(".reveal");
  if (!("IntersectionObserver" in window)) return els.forEach((el) => el.classList.add("in"));
  const io = new IntersectionObserver(
    (entries) => entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } }),
    { rootMargin: "0px 0px -8% 0px" },
  );
  els.forEach((el) => io.observe(el));
}
