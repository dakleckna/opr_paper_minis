# OPR Paper Minis

Lokale Druckvorlage für ArmyForge-Aufstellungen.

## Start

`start.bat` doppelklicken oder im Projektordner `node server.js` ausführen und anschließend <http://127.0.0.1:4173/> öffnen.

## Import

- **Ordner wählen:** ArmyForge-JSON und vorhandene Artworks gemeinsam auswählen. Der Ordner wird lokal gelesen; ein Bild ohne Seitenkennung gilt als Vorderseite und die Rückseite wird automatisch gespiegelt.
- **JSON + KI:** Nur das ArmyForge-JSON auswählen. Die benötigten Einheiten werden nacheinander über die in `ai-keys.json` eingetragenen Provider erzeugt. Die Reihenfolge ist fest: zuerst Gemini, danach Hugging Face, danach alle weiteren Provider in ihrer Konfigurationsreihenfolge. Bei Fehlern oder erschöpfter Quote wird automatisch weitergeschaltet.

Vor der Bildgenerierung wird die offizielle OPR-Fraktionsseite kurz nach einer visuellen Beschreibung (Formen, Materialien und Farbwelt) geprüft. Ist die Seite nicht erreichbar oder handelt es sich um eine Community-Fraktion, läuft die Generierung ohne diesen Zusatz weiter.

Lege `ai-keys.json` neben `server.js` an, indem du `ai-keys_EXAMPLE.json` kopierst, und trage dort mindestens einen kostenlosen API-Key ein. Die Datei bleibt lokal und gehört nicht in Git.

Die KI-Prompts fordern ein einzelnes vollständiges 2D-Artwork mit klarer dunkler Kontur, detailreicher aber lesbarer Ausrüstung aus dem JSON, sichtbaren Füßen bzw. Fahrzeugkontaktpunkt, transparentem Hintergrund und ohne Text, Base oder Schatten. Das Motiv bleibt bewusst hoch und schmal für den gefalteten Papierstreifen und füllt den Bildbereich weitgehend aus. Das Bild ist keine fertige Miniatur und kein 3D-Modell. AI-Ausgaben bleiben unverändert und verwenden anschließend dieselbe Stable-v1-Drehung wie Ordner-Artworks. Falls ein Provider keine Transparenz liefern kann, wird reiner weißer Hintergrund akzeptiert und ein gleichmäßiger Rand automatisch entfernt.

Nach einem KI-Import zeigt die Website im Bereich der Minis für jedes Artwork den tatsächlich verwendeten Provider an. Bei fehlgeschlagenen Einheiten bleiben die Platzhalter sichtbar.

Die Mini-Größen verwenden wieder die bewährten Stable-v1-Abmessungen, aktuell gleichmäßig um 20 % vergrößert. XL-Streifen werden bei Bedarf proportional auf die druckbare A4-Fläche verkleinert. Die ArmyForge-Base-Empfehlung bestimmt nur den Größen-Bucket (bis 32 mm = S, bis 50 mm = M, bis 75 mm = L, darüber = XL); rechteckige Empfehlungen folgen dabei der Stable-v1-Regel. Das Raster bleibt `12,5 % Lasche | 37,5 % Vorderseite | 37,5 % Rückseite | 12,5 % Lasche`.

Im Ordner-Modus muss der Bild-Dateiname dem Einheitsnamen auf der ArmyForge-Card entsprechen. Im KI-Modus werden keine Bilddateien benötigt.
