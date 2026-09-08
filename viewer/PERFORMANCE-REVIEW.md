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

**Offen: MapTiler**

MapTiler antwortet auf die konfigurierte Satelliten-Kachel mit HTTP 403 und dem Bildtext **„Invalid key“**. Das trat auch in der eingefrorenen Ausgangsversion auf. Der Schlüssel wurde nicht geändert. Der Viewer zeigt den Fehler jetzt ausdrücklich an und stoppt neue Imagery-Traversals, wenn die Basemap ausgeblendet ist.

Alle obigen Messungen enthalten deshalb **keine MapTiler-Kacheln**. Für die vollständige visuelle und technische Abnahme muss ein gültiger `VITE_MAPTILER_API_KEY` lokal konfiguriert, der Build/Devserver erneuert und der Test mit geladener Basemap wiederholt werden. Bis dahin sind die grünen Flächen zwischen den Baumkronen der vorhandene Boden-Fallback.

**Prüfungen und lokale Nachweise**

- `npm run build`: TypeScript und Produktionsbuild erfolgreich; bestehende Warnung zur Größe des Spark-Chunks.
- Gezielte Vitest-Prüfung: 18/18 bestanden (Regler, tatsächlicher Renderer-Vertrag, Streaming, Navigation, Höhenabfrage).
- `npm run bench:verify`: 9/9 bestanden.
- Die vollständige bestehende Vitest-Suite ist nicht grün: drei bereits in der Ausgangsversion fehlschlagende Erwartungen in APH/One-LOD-Tree sowie zwei `node:test`-Dateien, die Vitest als leere Suites einsammelt. Deren Tests bestehen über `bench:verify`.
- [Abschließende Messdaten](/private/tmp/wild-performance-verified/report.json), [Schrägblick](/private/tmp/wild-performance-verified/dry.png), [Blick nach unten](/private/tmp/wild-performance-verified/full-nadir.png).
- [Ausgangsversion ohne Maske](/private/tmp/wild-baseline-full/report.json), [abweichender Zwischenlauf](/private/tmp/wild-acceptance-final/report.json).
- [WebGPU-Navigation](/private/tmp/wild-navigation-verified-webgpu/report.json), [WebGL2-Navigation](/private/tmp/wild-navigation-verified-webgl/report.json), [MapTiler-Antwort](/private/tmp/wild-maptiler-response.png).

Reproduktion gegen einen laufenden Produktions-Preview:

```sh
PERF_ACCEPTANCE=1 PERF_EXTENDED=1 PERF_SAMPLE_MS=10000 node scripts/performance-check.mjs 'http://localhost:5183/livingdashboard/r3f.html?diag=1' /private/tmp/wild-performance-check
node scripts/navigation-check.mjs 'http://localhost:5183/livingdashboard/r3f.html?diag=1&webgl=1' /private/tmp/wild-navigation-check
```

Die Änderungen liegen im Arbeitsverzeichnis auf `jan-threejs-test`; sie sind nicht committed oder veröffentlicht.
