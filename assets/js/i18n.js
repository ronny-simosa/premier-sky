// Lightweight i18n: JSON locales, English default.
// Flag button shows current language; click toggles EN ↔ ES.
(function () {
  const STORAGE_KEY = "premier_lang";
  const DEFAULT_LANG = "en";
  const SUPPORTED = ["en", "es"];
  const FLAGS = { en: "🇺🇸", es: "🇪🇸" };
  const catalogs = {};
  let lang = DEFAULT_LANG;
  let ready = null;

  function resolveLang(preferred) {
    const raw = String(preferred || (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY)) || DEFAULT_LANG)
      .trim()
      .toLowerCase()
      .slice(0, 2);
    return SUPPORTED.includes(raw) ? raw : DEFAULT_LANG;
  }

  async function loadCatalog(code) {
    if (catalogs[code]) return catalogs[code];
    const res = await fetch(`/assets/i18n/${code}.json?v=47`, { cache: "no-store" });
    if (!res.ok) throw new Error(`i18n: missing ${code}.json`);
    catalogs[code] = await res.json();
    return catalogs[code];
  }

  function t(key, vars) {
    const dict = catalogs[lang] || {};
    const fallback = catalogs[DEFAULT_LANG] || {};
    let out = dict[key] ?? fallback[key] ?? key;
    if (vars && typeof vars === "object") {
      for (const [k, v] of Object.entries(vars)) {
        out = String(out).replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      }
    }
    return out;
  }

  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (!key) return;
      const attr = el.getAttribute("data-i18n-attr");
      const html = el.hasAttribute("data-i18n-html");
      const value = t(key);
      if (attr) el.setAttribute(attr, value);
      else if (html) el.innerHTML = value;
      else el.textContent = value;
    });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
    });
    scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
      if (el.tagName === "TITLE" || el.hasAttribute("data-i18n-doc-title")) {
        document.title = t(el.getAttribute("data-i18n-title"));
      } else {
        el.title = t(el.getAttribute("data-i18n-title"));
      }
    });
    document.documentElement.lang = lang;
    refreshFlagButtons(scope);
  }

  function refreshFlagButtons(scope) {
    (scope || document).querySelectorAll(".lang-flag-btn").forEach((btn) => {
      btn.textContent = FLAGS[lang] || FLAGS.en;
      btn.setAttribute("aria-label", lang === "en" ? t("lang.switchToEs") : t("lang.switchToEn"));
      btn.title = lang === "en" ? t("lang.switchToEs") : t("lang.switchToEn");
    });
  }

  function mountLangSwitch(parent) {
    if (!parent) return null;
    let btn = parent.querySelector(".lang-flag-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lang-flag-btn";
      btn.addEventListener("click", () => {
        setLang(lang === "en" ? "es" : "en");
      });
      parent.appendChild(btn);
    }
    refreshFlagButtons(parent);
    return btn;
  }

  async function setLang(next) {
    const code = resolveLang(next);
    await loadCatalog(DEFAULT_LANG);
    if (code !== DEFAULT_LANG) await loadCatalog(code);
    lang = code;
    try { localStorage.setItem(STORAGE_KEY, code); } catch { /* ignore */ }
    apply(document);
    document.querySelectorAll(".lang-switch-host, #nav, #salesLangHost").forEach((el) => {
      mountLangSwitch(el);
    });
    window.dispatchEvent(new CustomEvent("premier:lang", { detail: { lang: code } }));
  }

  async function init(preferred) {
    if (!ready) {
      ready = (async () => {
        lang = resolveLang(preferred);
        await loadCatalog(DEFAULT_LANG);
        if (lang !== DEFAULT_LANG) await loadCatalog(lang);
        apply(document);
        // Let pages that rendered before catalogs loaded refresh dynamic UI.
        window.dispatchEvent(new CustomEvent("premier:lang", { detail: { lang, initial: true } }));
        return lang;
      })();
    }
    return ready;
  }

  function createHomeButton() {
    const a = document.createElement("a");
    a.className = "btn-home";
    a.href = "/index.html";
    a.title = t("nav.homeHint");
    a.textContent = t("nav.home");
    a.setAttribute("data-i18n", "nav.home");
    a.setAttribute("data-i18n-title", "nav.homeHint");
    return a;
  }

  window.I18n = {
    init,
    t,
    apply,
    setLang,
    mountLangSwitch,
    createHomeButton,
    FLAGS,
    get lang() { return lang; }
  };
})();
