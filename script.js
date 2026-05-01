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

// Mobile fallback for Cal.com embed: the embed modal has a known layout
// bug on narrow viewports where the sticky "Back / Pay to book" bar floats
// mid-form and covers the phone field. Below 768px we strip the embed
// attributes so clicks open the Cal.com hosted page in a new tab, which
// lays out correctly at any width. Desktop keeps the in-page modal.
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
