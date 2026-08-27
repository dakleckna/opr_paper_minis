# OPR Paper Minis

Lokale Druckvorlage für ArmyForge-Aufstellungen.

## Start

`start.bat` doppelklicken oder im Projektordner `node server.js` ausführen und anschließend <http://127.0.0.1:4173/> öffnen.

## Import

- **Ordner wählen:** ArmyForge-JSON und vorhandene Artworks gemeinsam auswählen. Der Ordner wird lokal gelesen; ein Bild ohne Seitenkennung gilt als Vorderseite und die Rückseite wird automatisch gespiegelt.
- **JSON + KI:** Nur das ArmyForge-JSON auswählen. Die benötigten Einheiten werden nacheinander über die in `ai-keys.json` eingetragenen Provider erzeugt. Die Reihenfolge ist fest: zuerst Gemini, danach Hugging Face, danach alle weiteren Provider in ihrer Konfigurationsreihenfolge. Bei Fehlern oder erschöpfter Quote wird automatisch weitergeschaltet.

Vor der Bildgenerierung wird die offizielle OPR-Fraktionsseite kurz nach einer visuellen Beschreibung (Formen, Materialien und Farbwelt) geprüft. Ist die Seite nicht erreichbar oder handelt es sich um eine Community-Fraktion, läuft die Generierung ohne diesen Zusatz weiter.

Die vollständige, englische Prompt-Basis liegt in `AI_ARTWORK_PROMPT.md`. Diese Datei ist die zentrale Vorlage und kann angepasst werden; Platzhalter für Fraktion, Unit, Ausrüstung, Fähigkeiten, Keywords und den kurzen Fraktionscheck werden beim Import automatisch ersetzt. Pro ArmyForge-Auswahl wird genau eine eigene Artwork-Anfrage erzeugt. Mehrere Exemplare derselben Auswahl verwenden anschließend dieses Artwork für die Druckwiederholungen.

Lege `ai-keys.json` neben `server.js` an, indem du `ai-keys_EXAMPLE.json` kopierst, und trage dort mindestens einen kostenlosen API-Key ein. Die Datei bleibt lokal und gehört nicht in Git.

Du kannst mehrere Gemini-Schlüssel als eigene Einträge in `providers` hinterlegen. Verwende pro Schlüssel ein weiteres Objekt mit `type: "gemini"`; `apiKey` ist jeweils der persönliche Schlüssel und `model` kann gleich bleiben:

```json
{
  "providers": [
    { "type": "gemini", "enabled": true, "apiKey": "GEMINI_KEY_1", "model": "gemini-2.5-flash-image" },
    { "type": "gemini", "enabled": true, "apiKey": "GEMINI_KEY_2", "model": "gemini-2.5-flash-image" }
  ]
}
```

Die Einträge werden nacheinander ausprobiert. Jeder Gemini-Eintrag hat innerhalb eines laufenden Imports einen eigenen temporären Quota-Cooldown, sodass ein erschöpfter Schlüssel den nächsten nicht blockiert. Jeder neue JSON+KI-Lauf beginnt wieder mit dem ersten Gemini-Eintrag. Für wirklich getrennte Kontingente sollten die Schlüssel nach Möglichkeit zu unterschiedlichen AI-Studio-/Google-Cloud-Projekten gehören. Neue Schlüssel erstellst du in der [Google AI Studio API-Key-Verwaltung](https://ai.google.dev/gemini-api/docs/api-key).

Für Hugging Face mit `black-forest-labs/FLUX.1-schnell` wird der aktuelle Inference-Provider `fal-ai` über den Hugging-Face-Router verwendet. Der frühere `hf-inference/models/...`-Endpunkt unterstützt dieses FLUX-Modell nicht mehr und liefert HTTP 410. Das Beispiel enthält deshalb `"inferenceProvider": "fal-ai"`; alternativ sind `nscale` und `together` möglich, sofern das Modell dort live gemappt ist. `hf-inference` bleibt für Modelle erhalten, die ausdrücklich noch dort angeboten werden. Hugging Face stellt die aktuelle Zuordnung beim Start automatisch über die Model-API fest.

Die KI-Prompts fordern ein einzelnes vollständiges 2D-Artwork mit klarer dunkler Kontur, detailreicher aber lesbarer Ausrüstung aus dem JSON, sichtbaren Füßen bzw. Fahrzeugkontaktpunkt, transparentem Hintergrund und ohne Text, Base oder Schatten. Das Motiv bleibt bewusst hoch und schmal für den gefalteten Papierstreifen und füllt den Bildbereich weitgehend aus. Das Bild ist keine fertige Miniatur und kein 3D-Modell. AI-Ausgaben bleiben unverändert und verwenden anschließend dieselbe Stable-v1-Drehung wie Ordner-Artworks. Falls ein Provider keine Transparenz liefern kann, wird reiner weißer Hintergrund akzeptiert und ein gleichmäßiger Rand automatisch entfernt.

Nach einem KI-Import zeigt die Website im Bereich der Minis für jedes Artwork den tatsächlich verwendeten Provider an. Bei fehlgeschlagenen Einheiten bleiben die Platzhalter sichtbar.

Für sichtbar bessere Entwürfe verwendet Cloudflare 8 statt 4 Schritte; Hugging Face rendert FLUX mit 768 × 1152 Pixeln und einem Negativ-Prompt. Die Werte können pro Provider in `ai-keys.json` angepasst werden (`steps`, `width`, `height`, optional `guidanceScale` und `negativePrompt`).

Die Mini-Größen verwenden wieder die bewährten Stable-v1-Abmessungen, aktuell gleichmäßig um 20 % vergrößert. XL-Streifen werden bei Bedarf proportional auf die druckbare A4-Fläche verkleinert. Die ArmyForge-Base-Empfehlung bestimmt nur den Größen-Bucket (bis 32 mm = S, bis 50 mm = M, bis 75 mm = L, darüber = XL); rechteckige Empfehlungen folgen dabei der Stable-v1-Regel. Das Raster bleibt `12,5 % Lasche | 37,5 % Vorderseite | 37,5 % Rückseite | 12,5 % Lasche`.

Im Ordner-Modus muss der Bild-Dateiname dem Einheitsnamen auf der ArmyForge-Card entsprechen. Im KI-Modus werden keine Bilddateien benötigt.

## GitHub Pages

Der Workflow `.github/workflows/pages.yml` veröffentlicht bei jedem Push auf `main` eine statische Version unter:

<https://dakleckna.github.io/opr_paper_minis/>

Aktiviere im Repository unter **Settings → Pages** als Quelle **GitHub Actions**, falls GitHub danach fragt. Auf GitHub Pages bleiben Ordner-Import, Raster, Cards und PDF-Druck verfügbar. Die Schaltfläche **JSON + KI** wird dort absichtlich ausgeblendet: API-Schlüssel dürfen nicht in eine öffentlich ausgelieferte Webseite gelangen. Die statische Seite versucht, die ArmyForge-Daten direkt zu laden. Wenn der Browser diesen Zugriff wegen CORS verweigert, nutze für exakte Armeebuchdaten und die lokale KI-Funktion weiterhin `start.bat`.
