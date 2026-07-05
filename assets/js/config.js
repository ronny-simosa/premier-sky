// Configuración de estados monitoreados.
// stateCode: código usado por NWS (api.weather.gov/alerts/active?area=XX)
// center: [lat, lon] para centrar el mapa
// zoom: nivel de zoom inicial
window.STATES = {
  IL: {
    code: "IL",
    name: "Illinois",
    center: [40.0, -89.2],
    zoom: 7,
    bbox: [-91.6, 36.9, -87.0, 42.6]
  },
  DC: {
    code: "DC",
    name: "Washington D.C.",
    center: [38.9072, -77.0369],
    zoom: 11,
    bbox: [-77.12, 38.79, -76.91, 39.0]
  },
  VA: {
    code: "VA",
    name: "Virginia",
    center: [37.6, -78.7],
    zoom: 7,
    bbox: [-83.7, 36.5, -75.2, 39.5]
  },
  WI: {
    code: "WI",
    name: "Wisconsin",
    center: [44.6, -89.9],
    zoom: 7,
    bbox: [-92.9, 42.5, -86.8, 47.1]
  },
  MD: {
    code: "MD",
    name: "Maryland",
    center: [39.0, -76.7],
    zoom: 8,
    bbox: [-79.5, 37.9, -75.0, 39.7]
  },
  FL: {
    code: "FL",
    name: "Florida",
    center: [28.0, -82.0],
    zoom: 7,
    bbox: [-87.6, 24.4, -80.0, 31.0]
  }
};

// Oficinas de Premier (ícono de casita + radio de cobertura ~40 millas).
// Clave = código de estado donde se muestra la oficina.
window.PREMIER_OFFICES = {
  IL: { name: "Premier · Illinois", address: "140 W Lake Street, Bloomingdale, IL 60108", lat: 41.9578017, lon: -88.0836828 },
  FL: { name: "Premier · Florida", address: "3766 NW 16th St, Lauderhill, FL 33311", lat: 26.1461074, lon: -80.1991495 },
  MD: { name: "Premier · Maryland", address: "8280 Patuxent Range Rd, Jessup, MD 20794", lat: 39.1477652, lon: -76.7965342 },
  WI: { name: "Premier · Wisconsin", address: "2812 W Forest Home Ave, Milwaukee, WI 53215", lat: 43.0001646, lon: -87.9497563 }
};
// Radio de cobertura aproximado de Premier, en millas.
window.PREMIER_RADIUS_MI = 40;

// Colores por severidad de alerta NWS
window.SEVERITY_COLORS = {
  Extreme: "#7c0a02",
  Severe: "#e63900",
  Moderate: "#ff9100",
  Minor: "#ffd000",
  Unknown: "#3aa0ff"
};

// Colores categóricos del SPC (Storm Prediction Center) Day 1/2/3 outlook
window.SPC_COLORS = {
  TSTM: "#c1e9c1",
  MRGL: "#66a366",
  SLGT: "#ffe066",
  ENH: "#ffa366",
  MDT: "#ff6666",
  HIGH: "#ff66ff"
};

// Colores por % de probabilidad de granizo PRONOSTICADO (SPC hail outlook)
window.HAIL_PROB_COLORS = {
  "0.05": "#8b4726",
  "0.15": "#ffc800",
  "0.30": "#ff0000",
  "0.45": "#ff00ff",
  "0.60": "#912cee",
  SIGN: "#0a0a0a"
};
