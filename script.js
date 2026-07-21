document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener("click", (e) => {
    const href = a.getAttribute("href");
    if (!href || href === "#") return;
    const target = document.querySelector(href);
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState(null, "", href);
    }
  });
});

// On narrow viewports the primary nav overflows and scrolls horizontally;
// fade the clipped edge so off-canvas items are discoverable.
const primaryNav = document.querySelector(".primary-nav");
if (primaryNav) {
  const updateNavFade = () => {
    const maxScroll = primaryNav.scrollWidth - primaryNav.clientWidth;
    primaryNav.classList.toggle("nav-fade-start", primaryNav.scrollLeft > 6);
    primaryNav.classList.toggle("nav-fade-end", maxScroll > 6 && primaryNav.scrollLeft < maxScroll - 6);
  };
  primaryNav.addEventListener("scroll", updateNavFade, { passive: true });
  window.addEventListener("resize", updateNavFade);
  updateNavFade();
}

// Mobile fallback for Cal.com embed: historically the embed modal had a
// sticky-button-bar layout bug on narrow viewports that overlapped form
// fields. The bug appears resolved as of May 2026, but we keep this
// fallback as a safety net and because the full-page Cal.com booker
// gives mobile users more room to work. Below 768px we strip the embed
// attributes so clicks open the hosted page in a new tab. Desktop keeps
// the in-page modal. Payment is no longer collected at booking, so the
// Stripe-redirect failure mode this once protected against is moot.
if (window.matchMedia("(max-width: 767px)").matches) {
  document.querySelectorAll("a[data-cal-link]").forEach((a) => {
    a.removeAttribute("data-cal-namespace");
    a.removeAttribute("data-cal-link");
    a.removeAttribute("data-cal-config");
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener");
  });
}

(function (C, A, L) {
  let p = function (a, ar) { a.q.push(ar); };
  let d = C.document;
  C.Cal = C.Cal || function () {
    let cal = C.Cal;
    let ar = arguments;
    if (!cal.loaded) {
      cal.ns = {};
      cal.q = cal.q || [];
      d.head.appendChild(d.createElement("script")).src = A;
      cal.loaded = true;
    }
    if (ar[0] === L) {
      const api = function () { p(api, arguments); };
      const namespace = ar[1];
      api.q = api.q || [];
      if (typeof namespace === "string") {
        cal.ns[namespace] = cal.ns[namespace] || api;
        p(cal.ns[namespace], ar);
        p(cal, ["initNamespace", namespace]);
      } else {
        p(cal, ar);
      }
      return;
    }
    p(cal, ar);
  };
})(window, "https://app.cal.com/embed/embed.js", "init");

Cal("init", "bayou-sips", { origin: "https://app.cal.com" });
Cal.ns["bayou-sips"]("ui", { hideEventTypeDetails: false, layout: "month_view" });
