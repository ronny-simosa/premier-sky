// Covered Illinois ZIPs for Premier Sales (live sources only):
// Chicago city · Cook County · DuPage County.
// Labels: ZIP — City (Zone).
// Multi-area / zone searches use hub ZIPs to protect API quota.
(function (global) {
  const ZIPS = [
    // ——— DuPage ———
    { zip: "60101", city: "Addison", zone: "DuPage" },
    { zip: "60103", city: "Bartlett", zone: "DuPage" },
    { zip: "60106", city: "Bensenville", zone: "DuPage" },
    { zip: "60108", city: "Bloomingdale", zone: "DuPage" },
    { zip: "60126", city: "Elmhurst", zone: "DuPage" },
    { zip: "60137", city: "Glen Ellyn", zone: "DuPage" },
    { zip: "60139", city: "Glendale Heights", zone: "DuPage" },
    { zip: "60143", city: "Itasca", zone: "DuPage" },
    { zip: "60148", city: "Lombard", zone: "DuPage" },
    { zip: "60157", city: "Medinah", zone: "DuPage" },
    { zip: "60181", city: "Villa Park", zone: "DuPage" },
    { zip: "60185", city: "West Chicago", zone: "DuPage" },
    { zip: "60187", city: "Wheaton", zone: "DuPage" },
    { zip: "60188", city: "Carol Stream", zone: "DuPage" },
    { zip: "60189", city: "Wheaton", zone: "DuPage" },
    { zip: "60190", city: "Winfield", zone: "DuPage" },
    { zip: "60191", city: "Wood Dale", zone: "DuPage" },
    { zip: "60514", city: "Clarendon Hills", zone: "DuPage" },
    { zip: "60515", city: "Downers Grove", zone: "DuPage" },
    { zip: "60516", city: "Downers Grove", zone: "DuPage" },
    { zip: "60517", city: "Woodridge", zone: "DuPage" },
    { zip: "60521", city: "Hinsdale", zone: "DuPage" },
    { zip: "60523", city: "Oak Brook", zone: "DuPage" },
    { zip: "60527", city: "Willowbrook", zone: "DuPage" },
    { zip: "60532", city: "Lisle", zone: "DuPage" },
    { zip: "60540", city: "Naperville", zone: "DuPage" },
    { zip: "60555", city: "Warrenville", zone: "DuPage" },
    { zip: "60559", city: "Westmont", zone: "DuPage" },
    { zip: "60561", city: "Darien", zone: "DuPage" },
    { zip: "60563", city: "Naperville", zone: "DuPage" },
    { zip: "60565", city: "Naperville", zone: "DuPage" },
    { zip: "60566", city: "Naperville", zone: "DuPage" },
    { zip: "60567", city: "Naperville", zone: "DuPage" },
    // ——— Cook (suburban) ———
    { zip: "60004", city: "Arlington Heights", zone: "Cook" },
    { zip: "60005", city: "Arlington Heights", zone: "Cook" },
    { zip: "60007", city: "Elk Grove Village", zone: "Cook" },
    { zip: "60008", city: "Rolling Meadows", zone: "Cook" },
    { zip: "60010", city: "Barrington", zone: "Cook" },
    { zip: "60016", city: "Des Plaines", zone: "Cook" },
    { zip: "60018", city: "Des Plaines", zone: "Cook" },
    { zip: "60022", city: "Glencoe", zone: "Cook" },
    { zip: "60025", city: "Glenview", zone: "Cook" },
    { zip: "60026", city: "Glenview", zone: "Cook" },
    { zip: "60029", city: "Golf", zone: "Cook" },
    { zip: "60043", city: "Kenilworth", zone: "Cook" },
    { zip: "60053", city: "Morton Grove", zone: "Cook" },
    { zip: "60056", city: "Mount Prospect", zone: "Cook" },
    { zip: "60062", city: "Northbrook", zone: "Cook" },
    { zip: "60067", city: "Palatine", zone: "Cook" },
    { zip: "60068", city: "Park Ridge", zone: "Cook" },
    { zip: "60070", city: "Prospect Heights", zone: "Cook" },
    { zip: "60074", city: "Palatine", zone: "Cook" },
    { zip: "60076", city: "Skokie", zone: "Cook" },
    { zip: "60077", city: "Skokie", zone: "Cook" },
    { zip: "60089", city: "Buffalo Grove", zone: "Cook" },
    { zip: "60090", city: "Wheeling", zone: "Cook" },
    { zip: "60091", city: "Wilmette", zone: "Cook" },
    { zip: "60093", city: "Winnetka", zone: "Cook" },
    { zip: "60107", city: "Streamwood", zone: "Cook" },
    { zip: "60130", city: "Forest Park", zone: "Cook" },
    { zip: "60131", city: "Franklin Park", zone: "Cook" },
    { zip: "60133", city: "Hanover Park", zone: "Cook" },
    { zip: "60153", city: "Maywood", zone: "Cook" },
    { zip: "60154", city: "Westchester", zone: "Cook" },
    { zip: "60155", city: "Broadview", zone: "Cook" },
    { zip: "60160", city: "Melrose Park", zone: "Cook" },
    { zip: "60162", city: "Hillside", zone: "Cook" },
    { zip: "60163", city: "Berkeley", zone: "Cook" },
    { zip: "60164", city: "Melrose Park", zone: "Cook" },
    { zip: "60165", city: "Stone Park", zone: "Cook" },
    { zip: "60169", city: "Hoffman Estates", zone: "Cook" },
    { zip: "60171", city: "River Grove", zone: "Cook" },
    { zip: "60172", city: "Roselle", zone: "Cook" },
    { zip: "60173", city: "Schaumburg", zone: "Cook" },
    { zip: "60176", city: "Schiller Park", zone: "Cook" },
    { zip: "60192", city: "Hoffman Estates", zone: "Cook" },
    { zip: "60193", city: "Schaumburg", zone: "Cook" },
    { zip: "60194", city: "Schaumburg", zone: "Cook" },
    { zip: "60195", city: "Schaumburg", zone: "Cook" },
    { zip: "60201", city: "Evanston", zone: "Cook" },
    { zip: "60202", city: "Evanston", zone: "Cook" },
    { zip: "60203", city: "Evanston", zone: "Cook" },
    { zip: "60301", city: "Oak Park", zone: "Cook" },
    { zip: "60302", city: "Oak Park", zone: "Cook" },
    { zip: "60304", city: "Oak Park", zone: "Cook" },
    { zip: "60305", city: "River Forest", zone: "Cook" },
    { zip: "60402", city: "Cicero", zone: "Cook" },
    { zip: "60406", city: "Blue Island", zone: "Cook" },
    { zip: "60409", city: "Calumet City", zone: "Cook" },
    { zip: "60411", city: "Chicago Heights", zone: "Cook" },
    { zip: "60415", city: "Chicago Ridge", zone: "Cook" },
    { zip: "60419", city: "Dolton", zone: "Cook" },
    { zip: "60422", city: "Flossmoor", zone: "Cook" },
    { zip: "60425", city: "Glenwood", zone: "Cook" },
    { zip: "60426", city: "Harvey", zone: "Cook" },
    { zip: "60428", city: "Markham", zone: "Cook" },
    { zip: "60429", city: "Hazel Crest", zone: "Cook" },
    { zip: "60430", city: "Homewood", zone: "Cook" },
    { zip: "60438", city: "Lansing", zone: "Cook" },
    { zip: "60439", city: "Lemont", zone: "Cook" },
    { zip: "60443", city: "Matteson", zone: "Cook" },
    { zip: "60445", city: "Midlothian", zone: "Cook" },
    { zip: "60452", city: "Oak Forest", zone: "Cook" },
    { zip: "60453", city: "Oak Lawn", zone: "Cook" },
    { zip: "60455", city: "Bridgeview", zone: "Cook" },
    { zip: "60456", city: "Hometown", zone: "Cook" },
    { zip: "60457", city: "Hickory Hills", zone: "Cook" },
    { zip: "60458", city: "Justice", zone: "Cook" },
    { zip: "60459", city: "Burbank", zone: "Cook" },
    { zip: "60461", city: "Olympia Fields", zone: "Cook" },
    { zip: "60462", city: "Orland Park", zone: "Cook" },
    { zip: "60463", city: "Palos Heights", zone: "Cook" },
    { zip: "60464", city: "Palos Park", zone: "Cook" },
    { zip: "60465", city: "Palos Hills", zone: "Cook" },
    { zip: "60466", city: "Park Forest", zone: "Cook" },
    { zip: "60467", city: "Orland Park", zone: "Cook" },
    { zip: "60469", city: "Posen", zone: "Cook" },
    { zip: "60471", city: "Richton Park", zone: "Cook" },
    { zip: "60472", city: "Robbins", zone: "Cook" },
    { zip: "60473", city: "South Holland", zone: "Cook" },
    { zip: "60475", city: "Steger", zone: "Cook" },
    { zip: "60476", city: "Thornton", zone: "Cook" },
    { zip: "60477", city: "Tinley Park", zone: "Cook" },
    { zip: "60478", city: "Country Club Hills", zone: "Cook" },
    { zip: "60480", city: "Willow Springs", zone: "Cook" },
    { zip: "60482", city: "Worth", zone: "Cook" },
    { zip: "60487", city: "Tinley Park", zone: "Cook" },
    { zip: "60501", city: "Summit", zone: "Cook" },
    { zip: "60513", city: "Brookfield", zone: "Cook" },
    { zip: "60525", city: "La Grange", zone: "Cook" },
    { zip: "60526", city: "La Grange Park", zone: "Cook" },
    { zip: "60534", city: "Lyons", zone: "Cook" },
    { zip: "60546", city: "Riverside", zone: "Cook" },
    { zip: "60558", city: "Western Springs", zone: "Cook" },
    // ——— Chicago ———
    { zip: "60601", city: "Chicago Loop", zone: "Chicago" },
    { zip: "60602", city: "Chicago Loop", zone: "Chicago" },
    { zip: "60603", city: "Chicago Loop", zone: "Chicago" },
    { zip: "60604", city: "Chicago Loop", zone: "Chicago" },
    { zip: "60605", city: "Chicago South Loop", zone: "Chicago" },
    { zip: "60606", city: "Chicago West Loop", zone: "Chicago" },
    { zip: "60607", city: "Chicago West Loop", zone: "Chicago" },
    { zip: "60608", city: "Chicago Pilsen", zone: "Chicago" },
    { zip: "60609", city: "Chicago Back of the Yards", zone: "Chicago" },
    { zip: "60610", city: "Chicago Near North", zone: "Chicago" },
    { zip: "60611", city: "Chicago Streeterville", zone: "Chicago" },
    { zip: "60612", city: "Chicago Near West", zone: "Chicago" },
    { zip: "60613", city: "Chicago Lakeview", zone: "Chicago" },
    { zip: "60614", city: "Chicago Lincoln Park", zone: "Chicago" },
    { zip: "60615", city: "Chicago Hyde Park", zone: "Chicago" },
    { zip: "60616", city: "Chicago Near South", zone: "Chicago" },
    { zip: "60617", city: "Chicago South Chicago", zone: "Chicago" },
    { zip: "60618", city: "Chicago North Center", zone: "Chicago" },
    { zip: "60619", city: "Chicago Chatham", zone: "Chicago" },
    { zip: "60620", city: "Chicago Auburn Gresham", zone: "Chicago" },
    { zip: "60621", city: "Chicago Englewood", zone: "Chicago" },
    { zip: "60622", city: "Chicago Wicker Park", zone: "Chicago" },
    { zip: "60623", city: "Chicago Little Village", zone: "Chicago" },
    { zip: "60624", city: "Chicago West Garfield", zone: "Chicago" },
    { zip: "60625", city: "Chicago Lincoln Square", zone: "Chicago" },
    { zip: "60626", city: "Chicago Rogers Park", zone: "Chicago" },
    { zip: "60628", city: "Chicago Roseland", zone: "Chicago" },
    { zip: "60629", city: "Chicago Chicago Lawn", zone: "Chicago" },
    { zip: "60630", city: "Chicago Jefferson Park", zone: "Chicago" },
    { zip: "60631", city: "Chicago Norwood Park", zone: "Chicago" },
    { zip: "60632", city: "Chicago Brighton Park", zone: "Chicago" },
    { zip: "60633", city: "Chicago Hegewisch", zone: "Chicago" },
    { zip: "60634", city: "Chicago Portage Park", zone: "Chicago" },
    { zip: "60636", city: "Chicago West Englewood", zone: "Chicago" },
    { zip: "60637", city: "Chicago Woodlawn", zone: "Chicago" },
    { zip: "60638", city: "Chicago Clearing", zone: "Chicago" },
    { zip: "60639", city: "Chicago Belmont Cragin", zone: "Chicago" },
    { zip: "60640", city: "Chicago Uptown", zone: "Chicago" },
    { zip: "60641", city: "Chicago Irving Park", zone: "Chicago" },
    { zip: "60642", city: "Chicago Goose Island", zone: "Chicago" },
    { zip: "60643", city: "Chicago Beverly", zone: "Chicago" },
    { zip: "60644", city: "Chicago Austin", zone: "Chicago" },
    { zip: "60645", city: "Chicago West Ridge", zone: "Chicago" },
    { zip: "60646", city: "Chicago Sauganash", zone: "Chicago" },
    { zip: "60647", city: "Chicago Logan Square", zone: "Chicago" },
    { zip: "60649", city: "Chicago South Shore", zone: "Chicago" },
    { zip: "60651", city: "Chicago Humboldt Park", zone: "Chicago" },
    { zip: "60652", city: "Chicago West Lawn", zone: "Chicago" },
    { zip: "60653", city: "Chicago Bronzeville", zone: "Chicago" },
    { zip: "60654", city: "Chicago River North", zone: "Chicago" },
    { zip: "60655", city: "Chicago Mount Greenwood", zone: "Chicago" },
    { zip: "60656", city: "Chicago O'Hare", zone: "Chicago" },
    { zip: "60657", city: "Chicago Lakeview", zone: "Chicago" },
    { zip: "60659", city: "Chicago North Park", zone: "Chicago" },
    { zip: "60660", city: "Chicago Edgewater", zone: "Chicago" },
    { zip: "60661", city: "Chicago West Loop", zone: "Chicago" },
  ];

  const ZONE_HUBS = {
    DuPage: ["60108", "60143", "60148", "60523", "60540", "60126"],
    Cook: ["60173", "60007", "60453", "60201", "60462", "60018"],
    Chicago: ["60601", "60607", "60616", "60632", "60638", "60654"],
  };

  const HUB_ZIPS = [].concat(ZONE_HUBS.DuPage, ZONE_HUBS.Cook, ZONE_HUBS.Chicago);
  const ALL_VALUE = "__ALL__";
  const ZONES = ["DuPage", "Cook", "Chicago"];
  const STORAGE_KEY = "premier-sales-zip";

  function zoneAllValue(zone) {
    return `__ZONE:${zone}__`;
  }

  function label(row) {
    return `${row.zip} — ${row.city} (${row.zone})`;
  }

  function byZone() {
    const groups = { DuPage: [], Cook: [], Chicago: [] };
    for (const row of ZIPS) {
      if (groups[row.zone]) groups[row.zone].push(row);
    }
    return groups;
  }

  function find(zip) {
    return ZIPS.find((z) => z.zip === zip) || null;
  }

  function isValidSelection(value) {
    if (!value) return false;
    if (value === ALL_VALUE) return true;
    if (/^__ZONE:(DuPage|Cook|Chicago)__$/.test(value)) return true;
    return !!find(value);
  }

  /** Returns hub ZIP list for multi-search, or null for a single ZIP. */
  function hubsForSelection(value) {
    if (value === ALL_VALUE) return HUB_ZIPS.slice();
    const m = /^__ZONE:(DuPage|Cook|Chicago)__$/.exec(value);
    if (m) return (ZONE_HUBS[m[1]] || []).slice();
    return null;
  }

  function loadSavedZip(fallback) {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (isValidSelection(v)) return v;
    } catch {
      /* ignore */
    }
    return fallback || "60108";
  }

  function saveZip(value) {
    try {
      if (isValidSelection(value)) localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* ignore */
    }
  }

  global.IL_COVERED_ZIPS = {
    ALL_VALUE,
    ZIPS,
    HUB_ZIPS,
    ZONE_HUBS,
    ZONES,
    STORAGE_KEY,
    label,
    byZone,
    find,
    zoneAllValue,
    isValidSelection,
    hubsForSelection,
    loadSavedZip,
    saveZip,
  };
})(window);
