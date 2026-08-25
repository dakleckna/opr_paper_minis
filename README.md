# OPR Paper Minis

Eine lokale, browserbasierte Druckvorlage für Papierminis aus einem ArmyForge-Export. Sie kann vorhandene Artworks aus einem Ordner nutzen oder neue Vorderseiten über Bild-KI erzeugen.

## Start

Im Projektordner zuerst `node server.js` ausführen und dann `http://127.0.0.1:4173/` im Browser öffnen. Danach den Ordner mit dem ArmyForge-Export sowie den Artworks auswählen oder **JSON + KI** verwenden. Die lokale App fragt damit die Einheitsnamen und Modellzahlen aus Army Forge ab. Anschließend kann die A4-Vorschau als PDF gespeichert oder gedruckt werden.

## KI-Artworks aus JSON

Kopiere zuerst `ai-keys.example.json` als `ai-keys.json`. Dort stehen alle API-Keys zentral und in der gewünschten Reihenfolge. Die Datei `ai-keys.json` wird nicht in Git übernommen und wird ausschließlich vom lokalen Node-Server gelesen – niemals vom Browser.

```powershell
Copy-Item ai-keys.example.json ai-keys.json
```

Trage anschließend mindestens einen Schlüssel ein. Beim Klick auf **JSON + KI** erzeugt das Tool für jede unterschiedliche Unit-/Ausrüstungs-Kombination ein Artwork. Es probiert die konfigurierten Provider von oben nach unten und wechselt bei einem Fehler, einer Rate-Limit-Antwort oder einer ausgeschöpften Gratisquote automatisch weiter.

- `gemini`: Google Gemini Bildmodell (API-Key aus Google AI Studio)
- `cloudflare`: Cloudflare Workers AI; benötigt API-Token und Account-ID
- `huggingface`: Hugging Face Inference Providers Token

Die fertigen Bilder bleiben für den laufenden Browser-Import im Speicher und werden direkt für die Mini-Seiten verwendet. Sie werden nicht als Dateien in einen externen Dienst hochgeladen; beim KI-Modus wird jedoch jeweils der Bild-Prompt an den verwendeten Anbieter gesendet. Gratisquoten und für kostenlose Keys freigeschaltete Modelle ändern sich bei den Anbietern, deshalb kann die Reihenfolge oder das Modell direkt in `ai-keys.json` angepasst werden.

## Artwork-Dateien

Der Ordner darf einfach aus dem ArmyForge-Export und Bildern mit den Einheitsnamen bestehen:

```text
Fortress Tank.png
APC.png
Dwarf Trike.png
Dwarf Champion.png
Iron Veterans.png
Berserkers.png
Dwarf Warriors.png
```

Eine Datei ohne Seitenkennung ist immer die Vorderseite. Die App erzeugt die Rückseite automatisch als gespiegelte Version, sodass der Miniaturbogen direkt druckbar ist. Nur wenn eine eigene Rückseite vorliegt, wird sie ergänzt:

```text
Dwarf Warriors_back.png
# oder
Dwarf Warriors_rueckseite.png
```

Vorderseiten können optional als `Dwarf Warriors_front.png` bzw. `Dwarf Warriors_vorderseite.png` markiert werden. PNG, JPG, WEBP und SVG werden akzeptiert. Die Größe kommt nicht mehr aus dem Dateinamen: Sie wird anhand der ArmyForge-Base ermittelt; Fahrzeuge ohne Base werden zunächst als XL behandelt.

## Faltraster

Die Referenzbögen haben ein sichtbares Verhältnis von `1 : 2 : 2 : 1`: Bei einem 120-mm-Streifen sind die Laschen 20 mm und die Bildfelder 40 mm breit. Dieses Raster ist als Standard ausgewählt. Der alternative Modus erhält die ursprünglich beschriebene Vorgabe:

```text
12,5 % Klebelasche | 37,5 % Vorderseite | 37,5 % Rückseite | 12,5 % Klebelasche
```

Die verbindliche Reihenfolge des Streifens ist `Lasche | Vorderseite | Rückseite | Lasche`. Die Artworks werden aufrecht geliefert und automatisch so gedreht, dass die Vorderseiten-Füße an der linken und die Rückseiten-Füße an der rechten Klebelasche liegen. Transparente Ränder eines PNGs werden vor dem Platzieren entfernt; die sichtbare Figur wird anschließend innerhalb ihres S/M/L/XL-Felds maßhaltig skaliert. Für KI-Bilder ohne Transparenz fordert der Prompt einen weißen Hintergrund an, der mit dem Druckbogen verschmilzt.

Die Minis werden mit einem Guillotine-Packer auf der nutzbaren A4-Fläche verteilt. Dadurch werden freie Flächen nach jeder Platzierung erneut genutzt. Die Streifen selbst werden dabei nie gedreht: Klebelaschen bleiben immer links und rechts. Ein XL-Streifen, der nur quer auf das Papier passt, erhält automatisch eine A4-Seite im Querformat.

## Einheitenkarten

Nach dem Laden einer Aufstellung steht oben die Schaltfläche **Cards anzeigen** bereit. Sie erzeugt Karten im Army-Forge-Stil für alle Einheiten der Liste und berücksichtigt dabei kombinierte Trupps, angehängte Helden, gleiche Duplikate sowie die im Export ausgewählten Upgrades. Die Sonderregel-Texte werden aus den aktuell geladenen Army-Forge-Daten ergänzt. In der Kartenansicht druckt die bestehende Druck-Schaltfläche zwei Karten pro A4-Seite.

## Hinweise zur ersten Version

- Das ArmyForge-JSON enthält Aufstellungseinträge. Über die lokale ArmyForge-Abfrage werden Einheitsname, Modellanzahl und Base-Größe ergänzt. Der Bilddateiname bleibt die verbindliche Zuordnung zum Unit-Namen.
- Die nutzbare A4-Fläche hat 7 mm Rand. Ein zu großer Streifen wird als Hinweis angezeigt und nicht abgeschnitten.
- Die Größen-Voreinstellungen stehen am Anfang von `app.js` und können später nach realen Testdrucken feinjustiert werden.
