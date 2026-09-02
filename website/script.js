const header = document.querySelector("[data-header]");
const menuButton = document.querySelector(".menu-button");
const navLinks = document.querySelector(".nav-links");
const themeButton = document.querySelector("[data-theme-toggle]");
const themeColor = document.querySelector('meta[name="theme-color"]');
const colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

const getSavedTheme = () => {
  try {
    const theme = localStorage.getItem("multicode-theme");
    return theme === "light" || theme === "dark" ? theme : null;
  } catch {
    return null;
  }
};

const applyTheme = (theme, persist = false) => {
  if (theme !== "light" && theme !== "dark") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  if (themeColor) themeColor.content = theme === "dark" ? "#0e1015" : "#f5f2ea";

  const nextTheme = theme === "dark" ? "light" : "dark";
  themeButton?.setAttribute("aria-pressed", String(theme === "dark"));
  themeButton?.setAttribute("aria-label", `Switch to ${nextTheme} mode`);
  themeButton?.setAttribute("title", `Switch to ${nextTheme} mode`);
  const label = themeButton?.querySelector("[data-theme-label]");
  if (label) label.textContent = `${nextTheme[0].toUpperCase()}${nextTheme.slice(1)} mode`;

  if (persist) {
    try {
      localStorage.setItem("multicode-theme", theme);
    } catch {}
  }
};

applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");

themeButton?.addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(theme, true);
});

const handleSystemThemeChange = (event) => {
  if (!getSavedTheme()) applyTheme(event.matches ? "dark" : "light");
};

if (typeof colorSchemeQuery.addEventListener === "function") {
  colorSchemeQuery.addEventListener("change", handleSystemThemeChange);
} else {
  colorSchemeQuery.addListener(handleSystemThemeChange);
}

window.addEventListener("storage", (event) => {
  if (event.key !== "multicode-theme") return;
  applyTheme(event.newValue === "dark" ? "dark" : event.newValue === "light" ? "light" : colorSchemeQuery.matches ? "dark" : "light");
});

const setHeaderState = () => header?.classList.toggle("scrolled", window.scrollY > 18);
setHeaderState();
window.addEventListener("scroll", setHeaderState, { passive: true });

menuButton?.addEventListener("click", () => {
  const opening = menuButton.getAttribute("aria-expanded") !== "true";
  menuButton.setAttribute("aria-expanded", String(opening));
  navLinks?.classList.toggle("open", opening);
  document.body.classList.toggle("menu-open", opening);
});

navLinks?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    menuButton?.setAttribute("aria-expanded", "false");
    navLinks.classList.remove("open");
    document.body.classList.remove("menu-open");
  });
});

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.12, rootMargin: "0px 0px -40px" },
);

document.querySelectorAll(".reveal").forEach((element) => revealObserver.observe(element));

const workflowTabs = [...document.querySelectorAll("[data-step]")];
const workflowPanels = [...document.querySelectorAll("[data-panel]")];
const terminalScenes = [...document.querySelectorAll("[data-terminal]")];

const showWorkflowStep = (index) => {
  workflowTabs.forEach((tab, tabIndex) => {
    const active = tabIndex === index;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  workflowPanels.forEach((panel, panelIndex) => panel.classList.toggle("active", panelIndex === index));
  terminalScenes.forEach((scene, sceneIndex) => scene.classList.toggle("active", sceneIndex === index));
};

workflowTabs.forEach((tab, index) => tab.addEventListener("click", () => showWorkflowStep(index)));

const copyText = async (text, button) => {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = "Copied";
    window.setTimeout(() => { button.textContent = original; }, 1600);
  } catch {
    button.textContent = "Select & copy";
  }
};

document.querySelector("[data-copy-token]")?.addEventListener("click", (event) => {
  copyText("K7MNP-4XQ2R.<room-secret>", event.currentTarget);
});

document.querySelector("[data-copy-install]")?.addEventListener("click", (event) => {
  copyText("code --install-extension multicode-vscode.vsix", event.currentTarget);
});

document.querySelectorAll(".faq-list details").forEach((detail) => {
  detail.addEventListener("toggle", () => {
    if (!detail.open) return;
    document.querySelectorAll(".faq-list details").forEach((other) => {
      if (other !== detail) other.open = false;
    });
  });
});
