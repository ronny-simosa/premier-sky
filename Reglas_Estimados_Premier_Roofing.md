# Reglas de Estimados de Techado — Premier Group Roofing & Construction

> Documento maestro con toda la lógica para generar estimados a partir de un Roof Report de Roofr y crearlos en JobNimbus.
> Incluye precios, reglas de cantidad/waste, pitch surcharge, markup y reglas de revisión. **No incluye estimados específicos de clientes.**
> Última actualización: 2026-06-24

---

## 1. Contexto

- **Empresa:** Premier Group Roofing & Construction (Florida).
- **Herramientas:** Roofr (genera el "Roof Report" PDF con las mediciones) + JobNimbus (CRM, jobs y estimados).
- **Equipo:** Customer Service (valida leads) y Estimadores (revisan estimados marcados).
- **Idioma:** comunicación en español; terminología técnica y documentos en inglés.

---

## 2. Fuente de datos (Roofr Roof Report PDF)

El PDF queda **adjunto en JobNimbus → Documentos** del job. No hace falta entrar a Roofr por navegador.

- **Pág. 6 "Report summary":** de aquí salen TODOS los measurements:
  - Total roof area, total pitched area, total flat area, total facets
  - Predominant pitch
  - Eaves, Valleys, Hips, Ridges, Rakes
  - Wall flashing, Step flashing, Transitions, Parapet wall
  - Hips + ridges, Eaves + rakes
  - Squares y **Recommended Waste %** (columna resaltada — es dinámico: 10%, 12%, 14%, etc.)
- **Pág. 7 "Material calculations":** cantidades de referencia de bundles/rolls por marca y nivel de waste.
- **Pág. 2 "Diagram":** imagen del techo. Se extrae y, si se puede, se **recorta solo a la casa** para adjuntarla al estimado/job.

### Reportes con varias estructuras
Si el reporte tiene **múltiples estructuras** (ej. "Structure #1 summary", "Structure #2 summary"), cada estructura tiene su propia pág. de resumen. Se estima la estructura indicada usando SUS measurements, no los del total combinado.

---

## 3. Fórmula general del estimado

```
Costo de línea      = cantidad × (M + L)
Subtotal            = Σ costos de línea
Subtotal ajustado   = Subtotal + Pitch surcharge
Total final         = Subtotal ajustado × (1 + markup)
```

- **M = Material, L = Labor** (dos columnas de los line items de JobNimbus).
- **Markup = SIEMPRE 63.93%** (× 1.6393) sobre el subtotal ajustado.
- **Redondeo de cantidades: SIEMPRE hacia arriba (ceiling).**
- Cada estimado se entrega en **3 marcas** en tablas separadas, cada una con su total: **IKO Cambridge AR**, **GAF Timberline**, **CertainTeed Landmark**. Mismo cálculo y mismas cantidades; solo cambian descripciones y precios.

---

## 4. Reglas de cantidad y waste por item

| Item | Cantidad | Waste |
|------|----------|-------|
| **Shingles** | Squares × waste recomendado de Roofr | Waste recomendado (dinámico, pág. 6) |
| **Felt** | MISMA cantidad (SQ) que los shingles | igual que shingles |
| **Starter** | Eaves + Rakes × 1.10 | Siempre +10% |
| **Drip edge** | Eaves + Rakes × 1.10 | Siempre +10% |
| **Ice & Water** | 2×Eaves + (Valleys + Step Flashing + Wall Flashing + Transitions) | Sin waste extra |
| **Hip & Ridge** | Hips + Ridges (LF) | Sin waste |
| **Step + Wall flashing** | Step + Wall flashing (LF) | Sin waste |
| **Valley flashing** | Valleys (LF) | Sin waste |
| **Coil nails / Staples / Roof cement / Geocel sealant** | 1 cada 15 SQ (ceil) | Divisor = **SQ CON waste** |

**Reglas importantes:**
- **Tear off: NUNCA se considera** (no se cobra).
- **Debris removal: no se cobra.**
- **Valley flashing está INCLUIDO** (no es penetración).
- Si la estructura tiene **área flat (0/12)**, esa porción NO lleva shingles, y sus **eaves del flat se RESTAN del total de eaves** (afecta Starter, Drip edge e Ice & Water). Los eaves del flat se identifican en la pág. 3 (líneas verdes que bordean el recuadro flat).

---

## 5. Pitch surcharge

- Base = **SQ con waste** (los mismos squares de los shingles, ya redondeados).
- Se **suma al subtotal ANTES del markup**.
- Se usa SIEMPRE el **pitch PREDOMINANTE** como pitch único de todo el techo (NO se calcula por porción en techos de pitch mixto).

| Pitch predominante | Cargo por SQ |
|--------------------|-------------|
| 2/12 – 6/12 | $0 (sin cargo) |
| 7/12 – 9/12 | +$10 / SQ |
| 10/12 – 12/12 | +$35 / SQ |
| > 12/12 | **NO calcular → contactar al estimador** |

**Pendiente por confirmar:** si el predominante es ≤6/12 pero hay porciones aisladas >12/12 (caso tipo Mayfair: 56/12, 75/12) + área flat, ¿se manda a revisión igual?

---

## 6. Precios por marca (M + L por unidad)

### Tabla comparativa rápida
| Item | IKO Cambridge AR | GAF Timberline | CertainTeed Landmark |
|------|-----------------:|---------------:|---------------------:|
| Shingles (SQ) | 215 (M120+L95) | 226 (M131+L95) | 238 (M128+L110) |
| Hip & Ridge (LF) | 2.4 | 3.1 | 3 |
| Starter (LF) | 1.4 | 1.8 | 2 |
| Felt (SQ) | 12.7 | 12.7 | 12 |
| Ice & Water (LF) | 1.32 | 1.32 | 2 |
| Drip edge (LF) | 1.5 (M1+L0.5) | 1.5 | 1.5 |
| Step + Wall flashing (LF) | 7.9 (M2.9+L5) | 7.9 | 7.9 |
| Valley flashing (LF) | 6.9 (M4.4+L2.5) | 6.9 | 6.9 |

> **CertainTeed: la mano de obra (L) de shingles es SIEMPRE $110.**

### Nombres exactos de los line items (JobNimbus)

**IKO Cambridge AR**
- Shingles: "Install new shingles. IKO Cambridge AR" (SQ) — M120 + L95
- Hip & Ridge: "IKO Cambridge Algae Resistance" (LF) — M2.4
- Starter: "IKO Armour asphalt starter" (LF) — M1.4
- Felt: "Shingles split Felt #30" (SQ) — M12.7
- Ice & Water: "IKO StormShield Ice and Water Shield" (LF) — M1.32
- Drip edge / Gutter apron (LF) — M1 + L0.5

**GAF Timberline**
- Shingles: "Install new shingles. Architectural Style. (SQ) Brand: GAF Timberline" — M131 + L95
- Hip & Ridge: "Install new hip & Ridge shingles. (LF) Brand: GAF Timberline" — M3.1
- Starter: "GAF Weatherblocker Starter on eaves and rakes. (LF)" — M1.8 (cotizar por **LF**, aunque la unidad diga BDL)
- Felt: "Install ABC Felt Pro Guard 20 Synthetic Underlayment (SQ)" — M12.7
- Ice & Water: "Install IKO Stormshield Ice and Water Shield for: Gutters, valleys and penetrations." (LF) — M1.32

**CertainTeed Landmark**
- Shingles: "Install new shingles. Architectural Style. (SQ) Brand: CertainTeed Landmark" — M128 + L110
- Hip & Ridge: "Install new hip & Ridge shingles. (LF) Brand: CertainTeed Landmark" — M3
- Starter: "Install CertainTeed 10\" High Performance Starter on eaves and rakes. (LF)" — M2 (cotizar por **LF**, aunque la unidad diga BDL)
- Felt: "Install CertainTeed Roof Runner Synthetic Felt (SQ)" — M12
- Ice & Water: "Install Certainteed Winterguard Ice and Water Shield for: Gutters, valleys and penetrations." (LF) — M2

**Items comunes a las 3 marcas (Drip / Step+Wall / Valley):**
- "Install Drip Edge" (LF) — M1 + L0.5
- "Remove and Replace Shingles wall flashing below the siding/Step flashing" (LF) — M2.9 + L5
- "Valley Flashing per linear feet (LF)" — M4.4 + L2.5

**Consumibles (genéricos, iguales en las 3 marcas):**
- Coil nails (BX) — M71
- Roofing staples (CTN) — M14
- Roof cement (gal) — M20
- Geocel sealant #2300 (tube) — M7.5
- (Regla: 1 cada 15 SQ con waste, ceil)

---

## 7. Items de penetración / extras (NO van en el estimado estándar)

Estos NO se incluyen en el estimado base; van cubiertos por el disclaimer de penetraciones. Se guardan solo como referencia para el estimador.

| Item | GAF (M+L) | CertainTeed (M+L) |
|------|----------:|------------------:|
| Ridge Vent (GAF Cobra Snow Country 4', LF) | M5 + L3 = 8 | M5 + L3 = 8 |
| Vents / T-vents flashing (EA) | M22.99 + L16.4 = 39.39 | igual |
| Pipes flashing (EA) | M64 + L5.5 = 69.5 | igual |
| Chimney flashing (EA) | M100 + L150 = 250 | igual |
| Skylight flashing (EA) | L75 | **L100** |

> El skylight flashing difiere: GAF = L75, CertainTeed = L100.

---

## 8. Disclaimers obligatorios (en TODOS los estimados)

1. "Additional charges if we find more than 1 layer."
2. "Estimate does not include penetrations (pipes, vents, chimneys, skylights, ridge vents). Additional charges may apply, approximately $1,500-$2,000 depending on the complexity of the roof."

---

## 9. Regla de revisión (review tag)

Se calcula el **$/sq** del estimado:

```
$/sq = Total final ÷ (Squares × waste)   [= SQ con waste]
```

Si el $/sq cae **fuera del rango de la marca**, se aplica la etiqueta **"revisar estimado"** en JobNimbus para que un estimador lo revise.

| Marca | Rango aceptable $/sq |
|-------|----------------------|
| IKO Cambridge AR | $500 – $650 |
| GAF Timberline | $530 – $680 |
| CertainTeed Landmark | $560 – $710 |

> Cada marca tiene su propio rango. (Pendiente de decisión: si el tag se aplica por marca individual o al job completo cuando alguna marca se sale.)

