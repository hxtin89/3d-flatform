**Nachtrag: Nebel und Culling im R3F-Port**

Die vorherigen Basemap-/Performance-Prüfungen haben eine weitere Portierungsregression übersehen: `Atmosphere` lag unter `FloatingOrigin`. Dadurch band R3F das Fog-Objekt an `ecef-root` (eine `Group`), während die tatsächlich gerenderte `Scene.fog` leer blieb. Die vorherigen Bildzeitmessungen enthalten deshalb trotz aktivierter UI-Option keinen wirksamen Szenennebel.

`Atmosphere` ist jetzt ein direktes Kind der Szene. Raster-Traversierung läuft nach der Berechnung der Kameraebenen, genauso wie die Punkt-Traversierung. Der Ebenenvergleich prüft die tatsächlichen Kameraeigenschaften, damit ein R3F-Reset bei Resize/DPR nicht unbemerkt eine große Far-Plane stehen lässt. Der Nebel folgt im Nahbereich der Punkt-Ausblendung; bei großer Flughöhe gilt wieder die ursprüngliche, nicht auf 12 km begrenzte Höhenregel aus der Three.js-Variante.

Rasterkacheln, deren komplette Begrenzung sicher hinter dem vollständig deckenden Nebel liegt, werden jetzt ebenfalls über die Distanzprüfung ausgeschlossen. Die Grenze umfasst die vier Frustum-Ecken an `fog.far`: Nebel arbeitet mit Blickachsen-Tiefe, die Kachelprüfung mit räumlichem Abstand. Ein einfacher Kugelradius von `fog.far` würde die sichtbaren Seiten eines breiten Bildes zu früh abschneiden. Ohne Nebel entfällt diese zusätzliche Begrenzung.

Der Browsertest `scripts/atmosphere-check.mjs` prüft den echten Fog-Anschluss, Ein-/Ausschalten, Wiederherstellung nach einem Kamera-Reset schon beim nächsten Raster-Update sowie Frustum-/Distanzculling mit dem installierten Renderer. Nahe Raster- und Punktkacheln bleiben sichtbar, Raster hinter der Kamera oder jenseits der Far-Plane sowie Punkte jenseits der Distanzgrenze werden verworfen. Die Kreis-Maske bleibt ausgeschaltet. In der festen Nahansicht liegen Nebelanfang/-ende bei rund 455/1010 m und die Far-Plane bei 24 km. In 100 km Höhe liegt das Nebelende bei rund 206 km.

[WebGPU-Prüfung](/private/tmp/wild-atmosphere-webgpu/report.json), [WebGL2 mit Rasterbegrenzung](/private/tmp/wild-atmosphere-webgl-culling/report.json), [Ansicht mit Nebel](/private/tmp/wild-atmosphere-webgpu/fog-on.png). Die Rasterbegrenzung reduziert die gezeichneten Kartenkacheln an der festen Kamerapose von 116 auf 57. 18 gezielte Regressionstests für LOD, Streaming, Navigation und Höhenabfrage sowie der Produktionsbuild bestehen. Die WebGL-Prüfung belegt Funktion und Bildaufbau; sie ist kein Nachweis von 60 FPS für diesen Backend-Pfad.

Die erneute WebGPU-Messung mit beiden Korrekturen prüft geladene Satellitenbilder, `maskMode = 0` und den tatsächlich angeschlossenen Szenennebel in jeder Messphase. Der automatische Startbenchmark wählte diesmal DPR 1,25; die früheren Läufe verwendeten 1,1. Daher ist dieser Lauf kein isolierter Vergleich der Nebelkosten. Es gelten dieselbe feste Kamera, 1400 × 900 CSS-Pixel und jeweils zehn Sekunden Messdauer.

| Szene | Aktive Punkte | Kartenkacheln | Median ms | p95 ms | p99 ms | Maximum ms |
|---|---:|---:|---:|---:|---:|---:|
| Schrägblick trocken | 5.160.289 | 70 | 19,4 | 29,0 | 35,1 | 41,0 |
| Erster Regenstart | 5.160.289 | 70 | 19,8 | 28,4 | 39,9 | 66,3 |
| Laufender Regen | 5.160.289 | 70 | 17,4 | 24,8 | 29,1 | 34,8 |
| Senkrechter Blick | 3.570.053 | 22 | 16,6 | 17,4 | 18,1 | 21,0 |
| Regenstart senkrecht | 3.570.053 | 22 | 16,7 | 17,7 | 18,4 | 23,0 |
| Rechts-Orbit mit Regen | 3.345.053 | 33 | 17,0 | 27,5 | 59,1 | 90,0 |

**Die funktionalen Prüfungen bestehen; das frühere Bildzeitziel wird mit der vollständig dargestellten Szene nicht durchgehend erreicht.** Insbesondere Schrägblick und Orbit benötigen weitere Leistungsarbeit. Die Werte belegen keine pauschale Beschleunigung durch die Rasterbegrenzung. Keine MapTiler-Fehler; nur der unabhängige Favicon-Request liefert HTTP 403. [Aktuelle Messdaten](/private/tmp/wild-performance-fog-culling/report.json), [aktueller Schrägblick](/private/tmp/wild-performance-fog-culling/dry.png).

```sh
ATMOSPHERE_BUILD_DIR=dist node scripts/atmosphere-check.mjs 'https://wilderness-prototype.de/livingdashboard/r3f.html?diag=1&webgl=1' /private/tmp/wild-atmosphere-check
PERF_BUILD_DIR=dist PERF_REQUIRE_BASEMAP=1 PERF_REQUIRE_FOG=1 PERF_ACCEPTANCE=1 PERF_EXTENDED=1 PERF_SAMPLE_MS=10000 node scripts/performance-check.mjs 'https://wilderness-prototype.de/livingdashboard/r3f.html?diag=1' /private/tmp/wild-performance-check
```

Die folgenden Abschnitte dokumentieren frühere Zwischenstände. Ihre Abnahmeaussagen werden durch die Korrekturen und Einschränkungen dieses Nachtrags ersetzt.

**R3F: Walddarstellung, Distanz-LOD und Navigation — 8. September 2026**

Die automatische Kreis-Maske ist für alle R3F-Leistungsklassen ausgeschaltet. Der Wald bleibt über das Sichtfeld zusammenhängend. Der Nahbereich erhält die APH-Detailvorgabe SSE 4; weiter entfernte Kacheln verfeinern sich schrittweise weniger. Unter Last reduziert der Regler zuerst Wolken und Schatten, dann entfernte Details. Die additive APH-Struktur und ihre Quelldaten bleiben erhalten.

Der zentrale LOD-Fehler war ein falscher API-Feldname: Der installierte `3d-tiles-renderer` 0.4.28 liefert `distanceFromCamera`, der bisherige Wrapper las `distance`. Damit wirkten Distanzgrenze und Ausdünnung nicht wie vorgesehen. Ein Integrationstest mit dem installierten `TilesRenderer` prüft jetzt ausdrücklich diesen Vertrag. Die Nahregel verwendet den Abstand zur Kachelgrenze und schützt damit auch Kacheln, in denen die Kamera steht. Zwischen 250 und 500 m geht die Detailvorgabe weich in die Fernregel über. Die globale SSE-Anzeige kann deshalb 8 melden, während nahe Kacheln weiterhin nach SSE 4 verfeinern.

„Visible points“ bezeichnete die Summe aller Punkte aktiver Kacheln, einschließlich verdeckter und außerhalb des Bildausschnitts liegender Punkte. Die Anzeige heißt jetzt **„Punkte in aktiven Kacheln“**. Sie ist keine Messung der tatsächlich sichtbaren Bildpunkte.

Die Punktfarben, Höhengradierung und Wolkenschatten werden jetzt an den Punkt-Vertices statt für jedes überlappende Fragment ausgewertet. Unnötige Berechnungen ausgeschalteter Effekte entfallen. Neue Kachelmaterialien werden einzeln asynchron vorbereitet; währenddessen bleiben die vorhandenen APH-Vorfahren sichtbar. Parsen und Knotenverarbeitung erhalten begrenzte Arbeitszulassungen auch während einer Geste. Der bisherige globale SSE-64-Eingriff bei manueller Navigation entfällt. Regenshader werden beim Laden vorbereitet; vollständig transparente Wolken werden nicht gezeichnet.

Anni/Ann-Katrin Krenz’ Navigation aus `origin/sbb/pivot-on-canopy`, Commit `da6129e62782b4a15c071ba7b7508124ad0c4832`, ist in den R3F-Pfad übertragen: Rechtsdrehen um einen einmal ermittelten Baumkronen-Drehpunkt, Halten dieses Punkts bis zum Loslassen, Ursprungwechsel, flache Pan-Gesten, Pointer-Capture und kontrollierte Trägheit an der Höhenbegrenzung. Die Baumhöhenabfrage verwendet einen räumlichen Cache statt einer erneuten Vollsuche und Sortierung auf jedem Mausklick.

**Gemessener Produktionsbuild**

Chrome auf diesem Mac, WebGPU, 1400 × 900 CSS-Pixel, Gerätefaktor 2, effektiver Renderer-DPR 1,1, ungefähr 3,9 CSS-Pixel Punktgröße. Separater headless Testbrowser, fest vorgegebene Kamera, Aufwärmzeit vor der Messung, jeweils 10 Sekunden pro Szene. Der Regenzyklus ist vor dem Einstieg deaktiviert und der erste Regenstart wird gezielt ausgelöst. Jede Messung prüft `maskMode = 0`. Screenshot- und Berichtserstellung liegen außerhalb der Framezeitfenster.

| Szene | Aktive Punkte am Ende | Median ms | p95 ms | p99 ms | Maximum ms |
|---|---:|---:|---:|---:|---:|
| Schrägblick, trocken | 5.760.289 | 16,7 | 17,9 | 18,3 | 18,7 |
| Erster Regenstart | 5.760.289 | 16,7 | 17,9 | 18,8 | 18,9 |
| Laufender Regen | 5.760.289 | 16,7 | 17,6 | 18,9 | 21,9 |
| Senkrechter Blick, 186 m | 3.570.053 | 16,7 | 17,9 | 18,1 | 18,3 |
| Regenstart beim senkrechten Blick | 3.570.053 | 16,7 | 17,2 | 17,3 | 17,4 |
| Rechts-Orbit mit Regen | 4.083.181 | 16,7 | 17,8 | 24,8 | 28,8 |

Dieser abschließende Lauf erfüllt das vereinbarte Ziel: Median ≤ 16,8 ms, p95 ≤ 20 ms, p99 ≤ 33,3 ms. Er enthält keinen Frame über 33,4 ms. Die unveränderte Ausgangsversion `cf7f6b7` wählte bei derselben schrägen Kamerapose, demselben DPR und ebenfalls ausgeschalteter Maske 3.999.681 Punkte; ihre p95-Zeiten betrugen trocken 21,3 ms, beim Regenstart 25,0 ms und bei laufendem Regen 17,5 ms. Damit ist keine pauschale prozentuale FPS-Steigerung behauptet: Qualität, Messdauer und Systemlast beeinflussen den Vergleich.

Ein früherer Zwischenstand hatte stark schwankende GPU-Zeiten und unter Regen nur 22,3 ms Median beziehungsweise 29,2 ms p95. Diese Abweichung ist nicht abschließend einer Systemlast oder einzelnen Codeänderung zugeordnet. Der letzte bestandene Lauf ist ein lokaler Nachweis, keine Garantie für jede Kamera, Hardware oder parallele Last.

Die Navigationstests auf WebGPU und WebGL2 ergeben **0 m Drehpunktdrift**, einschließlich erzwungenem Ursprungwechsel. Baumhöhenabfrage: 1,1 ms auf WebGPU, 1,5 ms auf WebGL2. Geprüft sind auch Fensterrand, Loslassen, Blur, Linksschwenk und Zweifingerrotation. Keine JavaScript-Fehler; der abschließende WebGL-Test prüft zusätzlich Shader-Fehler und den tatsächlich verwendeten Backend-Namen.

**MapTiler-Korrektur — 9. September 2026**

Die ursprüngliche Diagnose „ungültiger Schlüssel“ war für die Produktionsdomain falsch. Dort erhalten sowohl `index.html` als auch `r3f.html` mit demselben Schlüssel echte JPEG-Kacheln (HTTP 200). In R3F verdeckte die grüne `GroundFallback`-Scheibe die geladenen Satellitenbilder: Durch den Punktwolken-Höhenversatz lag sie rund 2,1 m über dem Ellipsoid und schrieb in den Tiefenpuffer. Die Scheibe wird jetzt zuerst und ohne Tiefentest/Tiefenschreiben gezeichnet. Geladene Kartenkacheln überdecken sie unabhängig von ihrer Geometrie.

MapTilers TileJSON für `satellite-v4` meldet Zoom 0–22. Der bisherige XYZ-Standard war auf 0–19 begrenzt. R3F erlaubt jetzt alle 23 Stufen, verwendet 512 × 512 Pixel pro Kachel und die tatsächliche Canvas-Auflösung statt CSS-Pixeln. Anisotrope Filterung verbessert schräge Ansichten. Die ausgewählte Stufe bleibt vom projizierten Pixelbedarf abhängig; Zoom 22 über den gesamten Horizont würde keine zusätzliche sichtbare Qualität liefern. Die reale Aufnahmeauflösung kann je nach Gebiet geringer sein als die angebotene maximale Zoomstufe.

Der alte 96-MiB-CPU-Cache war schon mit 94 Kacheln voll und ließ den nahen Schrägblick bei Zoom 15 hängen. Die R3F-Budgets für dekodierte Bilder liegen jetzt je nach Geräteklasse bei 192/256/320 MiB; GPU- und Punktwolkenbudgets werden getrennt geführt. Nach einer CPU-Verdrängung wird die Traversierung auch bei stillstehender Kamera erneut angestoßen. So können freie Plätze wieder mit benötigten Detailkacheln belegt werden.

Vorübergehende Netzwerkfehler, HTTP 408/429 und Serverfehler werden mit begrenztem exponentiellem Abstand erneut versucht. Fehlgeschlagene LRU-Einträge werden vor dem Zurücksetzen entfernt, weil `resetFailedTiles()` im installierten Renderer allein kein erneutes Einreihen erlaubt. HTTP 401/403/404 werden nicht blind wiederholt.

Die vier Viewer-Einstiegspunkte teilen sich eine Schlüsselauswahl. Produktionsbuilds enthalten ausschließlich `VITE_MAPTILER_API_KEY`, auch wenn sie lokal als Preview geöffnet werden. Nur der Entwicklungsserver auf einem Loopback-Host verwendet `VITE_MAPTILER_API_KEY_LOCAL`. Der Vite-Proxy übermittelt den tatsächlichen Ursprung samt Port, statt Origin und Referer zu entfernen. `strictPort` verhindert einen unbemerkten Portwechsel. Mit der aktuellen Freigabe ist `http://localhost:5177` erfolgreich; Port 5183 ist nicht freigeschaltet. Die `.env` wurde nicht geändert.

Die früheren Messwerte oben enthalten keine MapTiler-Kacheln und sind deshalb keine vollständige Abnahme. Der neue Produktionsbuild wurde im isolierten Chrome unter der echten freigeschalteten Domain getestet: Nur lokale Build-Dateien wurden per Browser-Interception bereitgestellt, alle MapTiler-Anfragen gingen unverändert an den Dienst. Es wurde nichts veröffentlicht.

**Prüfungen und lokale Nachweise**

- `npm run build`: TypeScript und Produktionsbuild erfolgreich; bestehende Warnung zur Größe des Spark-Chunks.
- Gezielte Vitest-Prüfung: 24/24 bestanden (Regler, Renderer-Vertrag, Navigation, Höhenabfrage, Schlüsselauswahl und datensatzabhängige Spendenfläche).
- `npm run bench:verify`: 9/9 bestanden.
- Python: 7/7 Manifest-Tests bestanden, mit kleinen LAS-Header-Fixtures und realen ENU/CRS-Transformationen; kein Dekodieren von Punktdaten. `bash -n pipeline/area-manifest.sh` bestanden.
- Die vollständige bestehende Vitest-Suite ist nicht grün: drei bereits in der Ausgangsversion fehlschlagende Erwartungen in APH/One-LOD-Tree sowie zwei `node:test`-Dateien, die Vitest als leere Suites einsammelt. Deren Tests bestehen über `bench:verify`.
- [Abschließende Messdaten](/private/tmp/wild-performance-verified/report.json), [Schrägblick](/private/tmp/wild-performance-verified/dry.png), [Blick nach unten](/private/tmp/wild-performance-verified/full-nadir.png).
- [Ausgangsversion ohne Maske](/private/tmp/wild-baseline-full/report.json), [abweichender Zwischenlauf](/private/tmp/wild-acceptance-final/report.json).
- [WebGPU-Navigation](/private/tmp/wild-navigation-verified-webgpu/report.json), [WebGL2-Navigation](/private/tmp/wild-navigation-verified-webgl/report.json), [MapTiler-Antwort](/private/tmp/wild-maptiler-response.png).

**Abschließende Messung mit scharfer Basemap**

Gleicher Mac, Chrome/WebGPU, 1400 × 900 CSS-Pixel, Renderer-DPR 1,1; jeweils zehn Sekunden. Kreis-Maske ausgeschaltet, echte Satellitenbilder geladen. Im Schrägblick sind jetzt deutlich mehr Kartenkacheln resident als im früheren Lauf mit zu kleinem Cache.

| Szene | Aktive Punkte | Sichtbare Kartenkacheln | Median ms | p95 ms | p99 ms | Maximum ms |
|---|---:|---:|---:|---:|---:|---:|
| Schrägblick trocken | 5,760,289 | 113 | 16.7 | 18.1 | 18.4 | 18.7 |
| Erster Regenstart | 5,760,289 | 113 | 16.7 | 18.4 | 18.5 | 20.2 |
| Laufender Regen | 5,760,289 | 113 | 16.7 | 18.5 | 19.3 | 20 |
| Senkrechter Blick 186 m | 3,570,053 | 22 | 16.6 | 18.3 | 18.6 | 18.7 |
| Regenstart senkrecht | 3,570,053 | 22 | 16.7 | 18.2 | 18.6 | 18.7 |
| Rechts-Orbit mit Regen | 3,806,177 | 31 | 16.7 | 18.7 | 27.8 | 39.7 |

Median 16,6–16,7 ms, p95 höchstens 18,7 ms. Bei trockenem Schrägblick, beiden Regenstarts, laufendem Regen und senkrechtem Blick kein Frame über 33,4 ms. Der Rechts-Orbit enthält zwei längere Frames, maximal 39,7 ms. Das ist ein lokaler Vergleichsnachweis und keine Zusage, unter jeder Bewegung oder Systemlast exakt 60 FPS zu halten. Keine MapTiler-Fehler; der unabhängige Request auf das Favicon der Website liefert weiterhin HTTP 403. [Messdaten](/private/tmp/wild-performance-sharp-basemap/report.json).

Der zusätzliche WebGL2-Test mit der korrigierten Produktions-Basemap besteht ebenfalls: 0 m Drehpunktdrift, Baumhöhenabfrage 1,6 ms, Rechts-Orbit einschließlich Ursprungwechsel, Pointer-Capture, Blur, Linksschwenk und Zweifingerrotation. Keine JavaScript- oder Shaderfehler. [Navigationsbericht](/private/tmp/wild-navigation-basemap-final/report.json).

**Datensatz-Unterstützung und Merge**

Tins Commit `703fe8d` enthält keine neuen Punktwolken-Dateien. Er ergänzt die Erstellung eines Gebietsmanifests aus vorhandenen COPC-Headern und dem gespeicherten APH-Zustand, falls alte Konvertierungsberichte fehlen. Außerdem wird die Peru-Spendenfläche bei anderen Datensätzen nur noch mit explizitem `?shape=` geladen. Diese Regel gilt jetzt ebenfalls in R3F. Die Header-Ergänzung behält die vorhandenen Berichte als ersten Pfad bei; ihre wissenschaftlichen Python-Abhängigkeiten werden nur bei Bedarf importiert.

Das veröffentlichte Peru-Manifest enthält 72 Gebiete. Der bereits aktive APH-Baum umfasst in ENU rund 12,8 × 8,5 km (Begrenzungsrechteck, keine Garantie lückenloser Befliegung). Im Browser wurden vom Ausgangspunkt jeweils 1 km westlich und östlich neue Punktkacheln desselben APH-Datensatzes geladen: 3.536.124 beziehungsweise 3.345.053 aktive Punkte, bei deaktivierter Kreis-Maske. Es wurden keine neuen Rohdaten erzeugt oder hochgeladen.

Der Basemap-Browsertest prüft echte 512-Pixel-JPEGs, Tiefeneinstellungen der Ersatzfläche, Canvas-Pixelauflösung, verfügbare maximale Stufe 22, ausreichend verfeinerte Nahkacheln und neue Punktkachel-IDs nach seitlicher Bewegung. Ein absichtlich zurückgegebener HTTP-503 erholt sich ohne Seitenneuladen. Der abschließende Qualitätslauf erreichte im Schrägblick Zoom 20, in allen drei senkrechten Ansichten Zoom 19; 794 echte MapTiler-Antworten mit HTTP 200 und keine 401/403/404. [Prüfbericht](/private/tmp/wild-basemap-final/report.json).

Reproduktion mit dem lokalen Produktionsbuild unter der freigeschalteten Domain (isolierter Browser, keine Veröffentlichung):

```sh
npm run build
BASEMAP_BUILD_DIR=dist BASEMAP_TEST_RETRY=1 node scripts/basemap-check.mjs 'https://wilderness-prototype.de/livingdashboard/r3f.html?diag=1' /private/tmp/wild-basemap-check
PERF_BUILD_DIR=dist PERF_REQUIRE_BASEMAP=1 PERF_ACCEPTANCE=1 PERF_EXTENDED=1 PERF_SAMPLE_MS=10000 node scripts/performance-check.mjs 'https://wilderness-prototype.de/livingdashboard/r3f.html?diag=1' /private/tmp/wild-performance-check
NAV_BUILD_DIR=dist node scripts/navigation-check.mjs 'https://wilderness-prototype.de/livingdashboard/r3f.html?diag=1&webgl=1' /private/tmp/wild-navigation-check
```

Für den normalen Entwicklungsserver: `http://localhost:5177/r3f.html?diag=1`. Ein Produktions-Preview auf Port 5183 verwendet absichtlich den Produktionsschlüssel, für den dieser lokale Ursprung nicht freigeschaltet ist.

Der lokale Merge integriert Tins Datensatz-Unterstützung zusammen mit den R3F-Korrekturen. Es wurde weder gepusht noch veröffentlicht.
