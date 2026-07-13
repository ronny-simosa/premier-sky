// Builds the state grid and shows how many active alerts there are.
(async function () {
  await window.I18n.init();
  const I18n = window.I18n;
  const API = window.WeatherAPI;
  const grid = document.getElementById("stateGrid");
  const nav = document.getElementById("nav");
  const navApp = document.getElementById("navApp") || nav;

  // Globals (right): Home → Flag → session
  nav.prepend(I18n.createHomeButton());
  I18n.mountLangSwitch(nav);

  function mountSession(auth) {
    if (!nav || nav.querySelector(".user-bar")) return;
    const bar = document.createElement("div");
    bar.className = "user-bar";
    bar.innerHTML =
      `<span class="user-email" title="${auth.email || ""}">${auth.email || ""}</span>` +
      `<button type="button" class="btn secondary btn-logout" id="btnLogout" data-i18n="nav.logout">${I18n.t("nav.logout")}</button>`;
    nav.appendChild(bar);
    I18n.apply(bar);
    document.getElementById("btnLogout")?.addEventListener("click", () => API.logoutAuth());
  }

  function renderStatuses(counts) {
    Object.values(window.STATES).forEach((st) => {
      const status = grid.querySelector(`.status[data-code="${st.code}"]`);
      if (!status) return;
      const n = counts[st.code];
      if (n == null) {
        status.innerHTML = `<span class="dot"></span> ${I18n.t("sky.unavailable")}`;
      } else if (n > 0) {
        status.innerHTML = `<span class="dot alert"></span> ${I18n.t("sky.alerts", { n })}`;
      } else {
        status.innerHTML = `<span class="dot clear"></span> ${I18n.t("sky.noAlerts")}`;
      }
    });
  }

  Object.values(window.STATES).forEach((st) => {
    const a = document.createElement("a");
    a.href = `state.html?state=${st.code}`;
    a.textContent = st.name;
    navApp.appendChild(a);

    const card = document.createElement("a");
    card.className = "state-card";
    card.href = `state.html?state=${st.code}`;
    card.innerHTML = `
      <div class="code">${st.code}</div>
      <h3>${st.name}</h3>
      <div class="status" data-code="${st.code}">
        <span class="dot"></span> ${I18n.t("sky.loading")}
      </div>`;
    grid.appendChild(card);
  });

  try {
    const auth = await API.getAuthMe();
    if (!auth.authenticated) {
      API.redirectToLogin(auth.sessionExpired);
      return;
    }
    mountSession(auth);
  } catch {
    /* ignore — page still usable if auth check fails transiently */
  }

  let lastCounts = {};
  try {
    const data = await API.getAlertsSummary();
    lastCounts = data.counts || {};
  } catch {
    lastCounts = {};
  }
  renderStatuses(lastCounts);

  window.addEventListener("premier:lang", () => {
    I18n.apply(document);
    const home = nav.querySelector(".btn-home");
    if (home) {
      home.textContent = I18n.t("nav.home");
      home.title = I18n.t("nav.homeHint");
    }
    const logout = document.getElementById("btnLogout");
    if (logout) logout.textContent = I18n.t("nav.logout");
    renderStatuses(lastCounts);
  });
})();
