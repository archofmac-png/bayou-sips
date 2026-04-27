const packages = {
  "The Mini": {
    price: "$175",
    description: "Single featured flavor for an intimate party.",
    includes: [
      "1 Self-Serve Cart",
      "1 Single-Spout Frozen Drink Machine",
      "1 Flavor of Your Choice",
      "50 (9oz) Plastic Cups"
    ]
  },
  "The Original": {
    price: "$250",
    description: "Two flavors with the white tent included.",
    includes: [
      "1 Self-Serve Cart",
      "1 Double-Spout Frozen Drink Machine",
      "2 Flavors of Your Choice",
      "100 (9oz) Plastic Cups",
      "White Tent for All-Day Outdoor Use"
    ]
  },
  "The Deluxe": {
    price: "$400",
    description: "Four flavors and 200 cups for the big crowd.",
    includes: [
      "1 Self-Serve Cart",
      "1 Double-Spout Frozen Drink Machine",
      "4 Flavors of Your Choice",
      "200 (9oz) Plastic Cups",
      "White Tent for All-Day Outdoor Use"
    ]
  }
};

const facebookUrl = "https://www.facebook.com/profile.php?id=61572368766729";
const packageSelect = document.querySelector("#packageSelect");
const selectedPackageLabel = document.querySelector("#selectedPackageLabel");
const selectedPackagePrice = document.querySelector("#selectedPackagePrice");
const selectedPackageIncludes = document.querySelector("#selectedPackageIncludes");
const packageButtons = document.querySelectorAll("[data-package]");
const form = document.querySelector("#bookingForm");
const statusEl = document.querySelector("#formStatus");
const yearEl = document.querySelector("#year");

if (yearEl) {
  yearEl.textContent = new Date().getFullYear();
}

function packageLabel(name) {
  return `${name} - ${packages[name].price}`;
}

function renderIncludes(name) {
  selectedPackageIncludes.innerHTML = "";
  packages[name].includes.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    selectedPackageIncludes.append(li);
  });
}

function setPackage(name) {
  if (!packages[name]) return;
  const selected = packages[name];
  packageSelect.value = name;
  selectedPackageLabel.textContent = name;
  selectedPackagePrice.textContent = selected.price;
  renderIncludes(name);

  document.querySelectorAll("[data-package-card]").forEach((card) => {
    card.classList.toggle("is-selected", card.dataset.packageCard === name);
  });
}

function valueFor(selector) {
  const el = document.querySelector(selector);
  return el && el.value.trim() ? el.value.trim() : "Not provided";
}

function buildRequest() {
  const name = packageSelect.value;
  const selected = packages[name];

  return [
    "Bayou Sips booking request",
    "",
    `Rental option: ${packageLabel(name)}`,
    `Rental note: ${selected.description}`,
    "Included:",
    ...selected.includes.map((item) => `- ${item}`),
    "",
    `Name: ${valueFor("#customerName")}`,
    `Phone: ${valueFor("#customerPhone")}`,
    `Event date: ${valueFor("#eventDate")}`,
    `Event type: ${valueFor("#eventType")}`,
    `Guest count: ${valueFor("#guestCount")}`,
    `Flavor ideas: ${valueFor("#flavorIdeas")}`,
    `Notes: ${valueFor("#notes")}`
  ].join("\n");
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // fall through to fallback
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-999px";
  document.body.append(textarea);
  textarea.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch (e) { copied = false; }
  textarea.remove();
  return copied;
}

packageButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setPackage(button.dataset.package);
    document.querySelector("#booking").scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

if (packageSelect) {
  packageSelect.addEventListener("change", () => setPackage(packageSelect.value));
}

if (form) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    statusEl.textContent = "Copying request...";

    try {
      const copied = await copyText(buildRequest());
      statusEl.textContent = copied
        ? "Request copied. Paste it into a Facebook message to Bayou Sips."
        : "Request ready. Select the form text manually if copy is blocked.";

      if (copied) {
        window.open(facebookUrl, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      statusEl.textContent = "Copy was blocked by the browser. Open Facebook and send your event details.";
    }
  });
}

if (packageSelect) {
  setPackage(packageSelect.value);
}

/* Smooth-scroll for in-page anchor clicks (helps mobile) */
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
