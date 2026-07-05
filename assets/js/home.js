// Construye la cuadrícula de estados y muestra cuántas alertas activas hay.
(function () {
  const grid = document.getElementById("stateGrid");
  const nav = document.getElementById("nav");

  Object.values(window.STATES).forEach((st) => {
    const a = document.createElement("a");
    a.href = `state.html?state=${st.code}`;
    a.textContent = st.name;
    nav.appendChild(a);

    const card = document.createElement("a");
    card.className = "state-card";
    card.href = `state.html?state=${st.code}`;
    card.innerHTML = `
      <div class="code">${st.code}</div>
      <h3>${st.name}</h3>
      <div class="status" data-code="${st.code}">
        <span class="dot"></span> Cargando alertas…
      </div>`;
    grid.appendChild(card);
  });

  // Una sola petición al servidor (caché 5 min) en lugar de 6 llamadas NWS.
  (async () => {
    let counts = {};
    try {
      const data = await window.WeatherAPI.getAlertsSummary();
      counts = data.counts || {};
    } catch {
      counts = {};
    }

    Object.values(window.STATES).forEach((st) => {
      const status = grid.querySelector(`.status[data-code="${st.code}"]`);
      const n = counts[st.code];
      if (n == null) {
        status.innerHTML = `<span class="dot"></span> No disponible`;
      } else if (n > 0) {
        status.innerHTML = `<span class="dot alert"></span> ${n} alerta(s) activa(s)`;
      } else {
        status.innerHTML = `<span class="dot clear"></span> Sin alertas activas`;
      }
    });
  })();
})();
