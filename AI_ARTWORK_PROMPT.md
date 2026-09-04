# OPR AI Artwork Prompt

This is the canonical prompt template for the JSON + AI import. The website fills the placeholders once for every ArmyForge unit selection and sends the resulting prompt to the configured image provider.

## Placeholders

- `{{FACTION}}` — faction or army name from the ArmyForge export.
- `{{UNIT}}` — the selected unit name.
- `{{EQUIPMENT}}` — weapons and equipment from the selected unit.
- `{{ABILITIES}}` — special rules and visual cues from the selected unit.
- `{{KEYWORDS}}` — ArmyForge keywords, when available.
- `{{VISUAL_REFERENCE}}` — short visual reference gathered from the official OPR faction page.

## Template

Create exactly one isolated full-body 2D character or vehicle concept illustration for a game roster. This is a flat artwork asset only, never a physical tabletop miniature, painted plastic or resin model, product photo, 3D render, printable token, paper standee, or cut-out.

Faction: {{FACTION}}. Unit: {{UNIT}}.

Mandatory equipment from the ArmyForge JSON: {{EQUIPMENT}}. Special rules and visual cues: {{ABILITIES}}. Keywords: {{KEYWORDS}}.

Use this official faction reference as visual guidance when available: {{VISUAL_REFERENCE}}.

Style: strong, even black contours; polished 2D comic/cel-shading; crisp edges; a clear, readable silhouette; detailed but not overloaded armor and weapons matching every listed item. Treat the equipment list as a mandatory design brief and verify every listed weapon is visibly represented before finalizing.

Use faction-appropriate colors, including dirty/muted or vivid palettes when appropriate. Avoid an almost monochrome black/grey result unless the faction reference explicitly requires it; keep body, armor, and accent colors distinct and readable.

Show one complete representative individual only, even when the unit name is plural. Use a frontal or slight three-quarter view, an approximately 2:3 portrait composition, and a naturally tall and narrow subject that fills about 80–90% of the canvas height.

Keep feet, wheels, and the lowest contact point fully visible with an even margin. Use a transparent background; if transparency is unavailable, use pure white. No floor line, terrain, scenery, base, stand, cast shadow, smoke, text, letters, numbers, symbols, logo, frame, watermark, cropped parts, duplicates, or background gradient. All names and labels in this prompt are invisible metadata and must never appear in the image.

Use references as inspiration only; do not copy a reference image, named artist, or franchise.
