(() => {
  'use strict';

  const PAGE = { portrait: { width: 210, height: 297 }, landscape: { width: 297, height: 210 }, margin: 7 };
  const ART_PADDING = 1.25;
  const PRESETS = {
    s: { label: 'S', faceSpan: 28, stripHeight: 30 },
    m: { label: 'M', faceSpan: 40, stripHeight: 36.5 },
    l: { label: 'L', faceSpan: 60, stripHeight: 54 },
    xl: { label: 'XL', faceSpan: 90, stripHeight: 112 },
  };
  // Fester Aufbau: 12,5 % Lasche | 37,5 % Vorderseite | 37,5 % Rückseite | 12,5 % Lasche.
  const RASTER = { faceShare: .375, tabFr: 1, faceFr: 3 };
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
  const output = document.querySelector('#layout-output');
  const warnings = document.querySelector('#warnings');
  const folderInput = document.querySelector('#folder-input');
  const dropZone = document.querySelector('#drop-zone');
  const printButton = document.querySelector('#print-button');
  const cardsButton = document.querySelector('#cards-button');
  const cardsPanel = document.querySelector('#cards-panel');
  const cardsOutput = document.querySelector('#cards-output');
  const miniTemplate = document.querySelector('#mini-template');
  let objectUrls = [];
  let assetUrls = new Map();
  let loadedArmy = null;
  let loadedArmyBook = null;
  let loadedEntries = [];
  let loadedCards = [];
  let loadMessages = [];

  function isImage(file) {
    return IMAGE_TYPES.has(file.type) || /\.(png|jpe?g|webp|svg)$/i.test(file.name);
  }

  function isJson(file) {
    return file.type === 'application/json' || /\.json$/i.test(file.name);
  }

  function baseName(name) {
    return name.replace(/\.[^.]+$/, '');
  }

  function normalizeName(value) {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  function artworkKey(file) {
    const rawName = baseName(file.name).trim();
    const explicitSide = rawName.match(/^(.*?)(?:__|[-_\s]+)(front|vorderseite|back|rueckseite|rückseite)$/i);
    const label = (explicitSide ? explicitSide[1] : rawName).trim();
    if (!label) return null;
    const sideToken = explicitSide?.[2]?.toLocaleLowerCase();
    return {
      key: normalizeName(label),
      label,
      // Bilder ohne Kennung gelten immer als Vorderseite.
      side: ['back', 'rueckseite', 'rückseite'].includes(sideToken) ? 'back' : 'front',
      explicitSide: Boolean(explicitSide),
    };
  }

  async function readArmyForgeExport(files) {
    const candidates = files.filter(isJson);
    for (const file of candidates) {
      try {
        const parsed = JSON.parse(await file.text());
        if (Array.isArray(parsed?.list?.units)) return { file, data: parsed };
      } catch {
        // Continue with another JSON in the folder.
      }
    }
    return null;
  }

  function parseArtworkFiles(files) {
    const records = new Map();
    const invalid = [];
    for (const file of files.filter(isImage)) {
      const parsed = artworkKey(file);
      if (!parsed) {
        invalid.push(file.name);
        continue;
      }
      if (!records.has(parsed.key)) records.set(parsed.key, { key: parsed.key, label: parsed.label, front: null, back: null, frontExplicit: false });
      const record = records.get(parsed.key);
      if (parsed.side === 'back') {
        record.back = file;
      } else if (!record.front || parsed.explicitSide) {
        // Eine explizit markierte Vorderseite überschreibt die unmarkierte Variante.
        record.front = file;
        record.frontExplicit = parsed.explicitSide;
      }
    }
    return { records: [...records.values()], invalid };
  }

  function imageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Bilddatei konnte nicht geöffnet werden: ${file.name}`));
      };
      image.src = url;
    });
  }

  function canvasBlob(canvas) {
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }

  // Transparente Ränder zählen nicht zur Miniaturgröße. Dadurch bestimmt die sichtbare Figur
  // und nicht eine zufällige PNG-Leinwand die Druckgröße.
  async function trimTransparentArtwork(file) {
    if (!file || file.type === 'image/svg+xml') return file;
    try {
      const image = await imageFromFile(file);
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!width || !height) return file;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, width, height).data;
      let hasTransparency = false;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let index = 3; index < pixels.length; index += 4) {
        const alpha = pixels[index];
        if (alpha < 250) hasTransparency = true;
        if (alpha > 12) {
          const pixel = (index - 3) / 4;
          const x = pixel % width;
          const y = Math.floor(pixel / width);
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      if (!hasTransparency || maxX < minX || maxY < minY) return file;
      const padding = Math.max(2, Math.round(Math.max(width, height) * .008));
      minX = Math.max(0, minX - padding);
      minY = Math.max(0, minY - padding);
      maxX = Math.min(width - 1, maxX + padding);
      maxY = Math.min(height - 1, maxY + padding);
      const cropWidth = maxX - minX + 1;
      const cropHeight = maxY - minY + 1;
      if (cropWidth >= width * .98 && cropHeight >= height * .98) return file;
      const cropped = document.createElement('canvas');
      cropped.width = cropWidth;
      cropped.height = cropHeight;
      cropped.getContext('2d').drawImage(canvas, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
      const blob = await canvasBlob(cropped);
      return blob || file;
    } catch {
      return file;
    }
  }

  async function prepareArtworkRecords(records) {
    const assets = new Map();
    const files = [...new Set(records.flatMap(record => [record.front, record.back]).filter(Boolean))];
    await Promise.all(files.map(async file => assets.set(file, await trimTransparentArtwork(file))));
    return records.map(record => ({
      ...record,
      frontAsset: record.front ? assets.get(record.front) : null,
      backAsset: record.back ? assets.get(record.back) : null,
    }));
  }

  function emitWarnings(messages) {
    warnings.replaceChildren(...messages.map(message => {
      const line = document.createElement('p');
      line.className = 'warning';
      line.textContent = message;
      return line;
    }));
  }

  function sizeFromBase(unit) {
    const base = String(unit?.bases?.round || unit?.bases?.square || '').toLocaleLowerCase();
    if (!base || base === 'none') return 'xl';
    const dimensions = base.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
    if (!dimensions.length) return 'm';
    if (dimensions.length > 1) return Math.max(...dimensions) <= 100 ? 'l' : 'xl';
    if (dimensions[0] <= 32) return 's';
    if (dimensions[0] <= 50) return 'm';
    if (dimensions[0] <= 75) return 'l';
    return 'xl';
  }

  function buildEntries(army, artworkRecords, armyBook) {
    const unitsById = new Map((armyBook?.units || []).map(unit => [unit.id, unit]));
    const artworkByName = new Map(artworkRecords.map(record => [record.key, record]));
    const entries = [];
    const messages = [];
    const usedArtwork = new Set();

    for (const selection of army.list.units) {
      const unit = unitsById.get(selection.id);
      const name = unit?.name || selection.id;
      const record = artworkByName.get(normalizeName(selection.selectionId))
        || artworkByName.get(normalizeName(selection.customName || ''))
        || artworkByName.get(normalizeName(name))
        || artworkByName.get(normalizeName(selection.id));
      if (!record) {
        messages.push(`${name}: Keine passende Bilddatei gefunden. Erwartet wird „${name}.png“.`);
        continue;
      }
      usedArtwork.add(record.key);
      if (!record.front) {
        messages.push(`${name}: Vorderseite fehlt. Ein Platzhalter wird gedruckt.`);
      }
      const count = Number(unit?.size) || 1;
      const size = sizeFromBase(unit);
      for (let copy = 1; copy <= count; copy += 1) {
        entries.push({
          ...record,
          label: name,
          size,
          copy,
          id: `${selection.selectionId}-${copy}`,
          selectionId: selection.selectionId,
          unitId: selection.id,
        });
      }
    }

    for (const record of artworkRecords) {
      if (!usedArtwork.has(record.key)) messages.push(`${record.label}: Bilddatei gehört zu keiner Einheit dieser Aufstellung.`);
    }
    return { entries, messages };
  }

  function cloneWeapon(weapon) {
    return {
      ...weapon,
      count: Number(weapon.count) || 1,
      specialRules: (weapon.specialRules || []).map(rule => ({ ...rule })),
    };
  }

  function ruleLabel(rule) {
    return `${rule.name}${rule.rating != null ? `(${rule.rating})` : ''}`;
  }

  function ruleIdentity(rule) {
    return `${rule.name}|${rule.rating ?? ''}`;
  }

  function normalizeWeaponName(name) {
    const normalized = normalizeName(name);
    return normalized.endsWith('s') ? normalized.slice(0, -1) : normalized;
  }

  function createUpgradeOptionIndex(armyBook) {
    const options = new Map();
    (armyBook?.upgradePackages || []).forEach(packageEntry => {
      (packageEntry.sections || []).forEach(section => {
        (section.options || []).forEach(option => {
          const resolved = { option, section };
          // ArmyForge exports the upgrade section UID alongside the option ID.
          // Keep that pair as the primary key, because option IDs alone are not
          // guaranteed to be unique across a complete faction book.
          const sectionKeys = [section.uid, section.id, option.parentSectionUid, option.parentSectionId].filter(Boolean);
          sectionKeys.forEach(sectionId => options.set(`${sectionId}|${option.id}`, resolved));
          options.set(option.id, resolved);
        });
      });
    });
    return options;
  }

  function optionCost(option, unitId) {
    const specificCost = (option.costs || []).find(cost => cost.unitId === unitId);
    return Number(specificCost?.cost ?? option.cost ?? 0);
  }

  function affectedModels(section, unitSize) {
    if (section.affects?.type === 'all') return unitSize;
    if (section.affects?.type === 'exactly') return Number(section.affects.value) || 1;
    return 1;
  }

  function addRules(target, rules) {
    const known = new Set(target.map(ruleIdentity));
    (rules || []).forEach(rule => {
      const identity = ruleIdentity(rule);
      if (!known.has(identity)) {
        target.push({ ...rule });
        known.add(identity);
      }
    });
  }

  function applySelectionUpgrades(selection, baseUnit, optionIndex) {
    const cardUnit = {
      selection,
      // A community list may give every selected unit a unique narrative name.
      // Preserve it on the card instead of collapsing it back to the book name.
      name: String(selection.customName || baseUnit.name).trim() || baseUnit.name,
      unitId: baseUnit.id,
      size: Number(baseUnit.size) || 1,
      quality: baseUnit.quality,
      defense: baseUnit.defense,
      cost: Number(baseUnit.cost) || 0,
      rules: (baseUnit.rules || []).map(rule => ({ ...rule })),
      weapons: (baseUnit.weapons || []).map(cloneWeapon),
      items: (baseUnit.items || []).map(item => ({ ...item, content: (item.content || []).map(rule => ({ ...rule })) })),
    };

    // ArmyForge keeps some innate abilities inside the unit's standard items
    // (for example Combat Shield -> Fortified). Items themselves stay hidden
    // on the card, but every rule they grant must be represented.
    cardUnit.items.forEach(item => addRules(cardUnit.rules, item.content || []));

    (selection.selectedUpgrades || []).forEach(pick => {
      const resolved = optionIndex.get(`${pick.upgradeId}|${pick.optionId}`) || optionIndex.get(pick.optionId);
      if (!resolved) return;
      const { option, section } = resolved;
      const multiplier = affectedModels(section, cardUnit.size);
      cardUnit.cost += optionCost(option, selection.id);

      if (section.variant === 'replace' && (section.targets || []).length) {
        const targetNames = new Set(section.targets.map(normalizeWeaponName));
        // A section can replace multiple weapon types at once (e.g. "Rifles
        // and CCWs"). The selected model count applies to every target type,
        // not only to the first weapon encountered in the list.
        const remainingByTarget = new Map([...targetNames].map(target => [target, multiplier]));
        cardUnit.weapons.forEach(weapon => {
          const target = normalizeWeaponName(weapon.name);
          const remaining = remainingByTarget.get(target) || 0;
          if (!targetNames.has(target) || remaining <= 0) return;
          const removed = Math.min(weapon.count, remaining);
          weapon.count -= removed;
          remainingByTarget.set(target, remaining - removed);
        });
        cardUnit.weapons = cardUnit.weapons.filter(weapon => weapon.count > 0);
      }

      (option.gains || []).forEach(gain => {
        if (gain.type === 'ArmyBookWeapon') {
          cardUnit.weapons.push({
            ...cloneWeapon(gain),
            count: (Number(gain.count) || 1) * multiplier,
          });
          return;
        }
        if (gain.type === 'ArmyBookItem') {
          cardUnit.items.push({ ...gain });
          addRules(cardUnit.rules, gain.content || []);
          return;
        }
        if (gain.type === 'ArmyBookRule') addRules(cardUnit.rules, [gain]);
      });
    });
    return cardUnit;
  }

  function aiArtworkSignature(unit) {
    return JSON.stringify({
      unitId: unit.unitId,
      weapons: unit.weapons.map(weapon => [weapon.name, weapon.count, weapon.range, weapon.attacks, weapon.specialRules]),
      rules: unit.rules.map(ruleIdentity),
    });
  }

  function buildAiArtworkRequests(army, armyBook) {
    const unitsById = new Map((armyBook?.units || []).map(unit => [unit.id, unit]));
    const optionIndex = createUpgradeOptionIndex(armyBook);
    const requests = new Map();
    (army.list.units || []).forEach(selection => {
      const baseUnit = unitsById.get(selection.id);
      if (!baseUnit) return;
      const unit = applySelectionUpgrades(selection, baseUnit, optionIndex);
      const signature = aiArtworkSignature(unit);
      if (!requests.has(signature)) {
        const equipment = unit.weapons.map(weapon => {
          const count = Number(weapon.count) > 1 ? `${weapon.count}x ` : '';
          return `${count}${weapon.name}`;
        }).join(', ');
        requests.set(signature, {
          id: `generated-${requests.size + 1}`,
          label: baseUnit.name,
          targets: [],
          prompt: [
            'Create one full-body, upright science-fantasy tabletop paper miniature illustration.',
            `Faction: ${army.armyName || armyBook.name || 'unknown faction'}.`,
            `Unit: ${baseUnit.name}.`,
            `Equipment: ${equipment || 'standard equipment'}.`,
            `Scale category: ${sizeFromBase(baseUnit).toUpperCase()}.`,
            'Show exactly one complete character or vehicle, with every foot or lowest contact point fully visible at the bottom of the canvas.',
            'Use a clear front or three-quarter front view, centered composition, a clean white background, no terrain, no base, no cast shadow, no text, no labels, no frame, and no duplicate subjects.',
            'Use original detailed painted sci-fi concept art with a crisp silhouette. Do not imitate a named artist or an existing franchise.',
          ].join(' '),
        });
      }
      requests.get(signature).targets.push({
        selectionId: selection.selectionId,
        label: unit.name,
      });
    });
    return [...requests.values()];
  }

  function mergeWeapons(units) {
    const merged = new Map();
    units.flatMap(unit => unit.weapons).forEach(weapon => {
      const signature = [weapon.name, weapon.range, weapon.attacks, JSON.stringify(weapon.specialRules || [])].join('|');
      if (!merged.has(signature)) merged.set(signature, { ...cloneWeapon(weapon), count: 0 });
      merged.get(signature).count += Number(weapon.count) || 1;
    });
    return [...merged.values()];
  }

  function mergeRules(units) {
    const rules = [];
    units.forEach(unit => addRules(rules, unit.rules));
    return rules;
  }

  function mergeItems(units) {
    const items = [];
    const known = new Set();
    units.flatMap(unit => unit.items).forEach(item => {
      const identity = item.label || item.name;
      if (!known.has(identity)) {
        items.push(item);
        known.add(identity);
      }
    });
    return items;
  }

  function combinedRoot(selection, selectionById) {
    let current = selection;
    const visited = new Set();
    while (current?.combined && current.joinToUnit && !visited.has(current.selectionId)) {
      visited.add(current.selectionId);
      current = selectionById.get(current.joinToUnit);
    }
    return current?.selectionId || selection.selectionId;
  }

  function cardSignature(card) {
    return JSON.stringify({
      id: card.unitId,
      name: card.name,
      quality: card.quality,
      defense: card.defense,
      weapons: card.weapons.map(weapon => [weapon.name, weapon.range, weapon.attacks, weapon.specialRules]),
      rules: card.rules.map(ruleIdentity),
      spells: card.spells.map(spell => spell.id),
      joinedTo: card.joinedTo || null,
    });
  }

  function armySpellsFor(unit, armyBook) {
    const caster = (unit.rules || []).find(rule => rule.name === 'Caster');
    if (!caster) return [];
    // ArmyForge exposes the spell list on the faction army book. Any model with
    // Caster may select from that entire list, so it is shown in full on its card.
    return (armyBook.spells || []).map(spell => ({
      id: spell.id,
      name: String(spell.name || 'Unnamed Spell').trim(),
      threshold: spell.threshold,
      effect: String(spell.effect || '').trim(),
    }));
  }

  function buildArmyCards(army, armyBook) {
    if (!armyBook) return [];
    const unitsById = new Map((armyBook.units || []).map(unit => [unit.id, unit]));
    const selectionById = new Map((army.list.units || []).map(selection => [selection.selectionId, selection]));
    const optionIndex = createUpgradeOptionIndex(armyBook);
    const transformed = (army.list.units || [])
      .map(selection => {
        const baseUnit = unitsById.get(selection.id);
        return baseUnit ? applySelectionUpgrades(selection, baseUnit, optionIndex) : null;
      })
      .filter(Boolean);
    const grouped = new Map();
    transformed.forEach(unit => {
      const groupId = unit.selection.combined ? combinedRoot(unit.selection, selectionById) : unit.selection.selectionId;
      if (!grouped.has(groupId)) grouped.set(groupId, []);
      grouped.get(groupId).push(unit);
    });
    const mergedGroups = [...grouped.values()].map(group => {
      const first = group[0];
      return {
        groupId: combinedRoot(first.selection, selectionById),
        name: first.name,
        unitId: first.unitId,
        size: group.reduce((total, unit) => total + unit.size, 0),
        quality: first.quality,
        defense: first.defense,
        cost: group.reduce((total, unit) => total + unit.cost, 0),
        weapons: mergeWeapons(group),
        rules: mergeRules(group),
        items: mergeItems(group),
        spells: [],
        joinedTo: first.selection.joinToUnit || null,
        quantity: 1,
      };
    });
    mergedGroups.forEach(card => {
      card.spells = armySpellsFor(card, armyBook);
    });
    const selectionToCard = new Map();
    mergedGroups.forEach(card => {
      grouped.get(card.groupId)?.forEach(unit => selectionToCard.set(unit.selection.selectionId, card));
      selectionToCard.set(card.groupId, card);
    });
    mergedGroups.forEach(card => {
      if (card.joinedTo) card.joinedTo = selectionToCard.get(card.joinedTo)?.name || null;
    });
    const displayed = new Map();
    mergedGroups.forEach(card => {
      const signature = cardSignature(card);
      if (!displayed.has(signature)) displayed.set(signature, card);
      else {
        const existing = displayed.get(signature);
        existing.quantity += 1;
        existing.cost += card.cost;
      }
    });
    return [...displayed.values()];
  }

  function formatRange(range) {
    return Number(range) > 0 ? `${range}″` : '–';
  }

  function weaponAp(weapon) {
    const ap = (weapon.specialRules || []).find(rule => rule.name === 'AP');
    return ap ? ap.rating ?? '–' : '–';
  }

  function weaponSpecials(weapon) {
    return (weapon.specialRules || []).filter(rule => rule.name !== 'AP').map(ruleLabel).join(', ') || '–';
  }

  // Army Forge supplies the current faction rules with each army book. These
  // are the remaining shared Grimdark Future core rules, so cards never fall
  // back to a non-descriptive "see the rules" placeholder.
  const CORE_RULE_DESCRIPTIONS = {
    Aircraft: 'Must deploy before all other units, ignores units and terrain when moving, can’t seize objectives, and may only Advance in a straight line.',
    Ambush: 'May be kept in reserve. At the start of any round after the first, place it anywhere over 9” away from enemy units.',
    AP: 'Targets get -X to Defense rolls when blocking hits.',
    Blast: 'Ignores cover, and each hit is multiplied by X, up to the number of models in the target unit.',
    Caster: 'Gets X spell tokens at the start of each round, up to 6. Before attacking, spend tokens to attempt spells; roll 4+ to resolve each spell.',
    Counter: 'Strikes first with this weapon when charged, and charging units get -1 total Impact attacks per model with this rule.',
    Deadly: 'Assign each wound to one model and multiply it by X. Resolve these wounds first; they do not carry over after that model is destroyed.',
    Entrenched: 'Enemies get -2 to hit when shooting at this model from over 12” away, as long as it has not moved since the beginning of its last activation.',
    Fast: 'Moves +2” when using Advance, and +4” when using Rush/Charge.',
    Fear: 'Counts as having dealt +X wounds when checking who won melee.',
    Fearless: 'When failing a morale test, roll one die. On a 4+ it is passed instead.',
    Flying: 'May move through obstacles and ignores terrain effects when moving.',
    Furious: 'When charging, unmodified results of 6 to hit in melee deal 1 extra hit.',
    Hero: 'Heroes with up to Tough(6) may deploy joined to one multi-model friendly unit; that unit uses the Hero’s Quality for morale tests.',
    Immobile: 'May only use Hold actions.',
    Impact: 'Gets X attacks that hit on 2+ when charging.',
    Indirect: 'May target enemies out of line of sight and ignores cover from sight obstructions, but gets -1 to hit when shooting after moving.',
    Lance: 'Gets AP(+2) when charging.',
    Limited: 'Weapons with this rule may only be used once per game.',
    'Lock-On': 'Ignores cover and all negative modifiers to hit rolls and range.',
    Poison: 'Targets get -1 to Regeneration rolls and must re-roll unmodified Defense rolls of 6 when blocking hits.',
    Regeneration: 'When taking a wound, roll one die. On a 5+ it is ignored.',
    Relentless: 'When using Hold actions and shooting, unmodified results of 6 to hit deal 1 extra hit.',
    Reliable: 'Attacks at Quality 2+ with this weapon.',
    Rending: 'Ignores Regeneration, and unmodified results of 6 to hit get AP(+4).',
    Scout: 'May be deployed after all other units, then may move by up to 12”, ignoring terrain.',
    Slow: 'Moves -2” when using Advance, and -4” when using Rush/Charge.',
    Sniper: 'Shoots at Quality 2+ and may pick one model in a unit as its target, resolved as if it were a unit of 1.',
    Stealth: 'Enemies get -1 to hit when shooting at units where all models have this rule from over 12” away.',
    Strider: 'May ignore the effects of difficult terrain when moving.',
    Tough: 'This model must take X wounds before being killed. Tough models joined to units without Tough are removed last.',
    Transport: 'May transport up to X models, subject to the transport restrictions. Units may deploy inside, embark by moving into contact, and disembark within 6”.',
    Unique: 'This unit may only be taken once per army.',
    Unstoppable: 'Ignores Regeneration and all negative modifiers to this weapon.',
  };

  function ruleDescription(rule, armyBook) {
    const name = String(rule.name || '').trim();
    const factionRule = (armyBook.specialRules || []).find(candidate => {
      const names = [candidate.name, candidate.originalName].filter(Boolean);
      return names.some(candidateName => normalizeName(candidateName) === normalizeName(name));
    });
    return String(factionRule?.description || CORE_RULE_DESCRIPTIONS[name] || '').trim();
  }

  function createStatBadge(label, value, suffix = '+') {
    const badge = document.createElement('div');
    badge.className = 'unit-stat-badge';
    const labelElement = document.createElement('span');
    labelElement.className = 'unit-stat-label';
    labelElement.textContent = label;
    const valueElement = document.createElement('span');
    valueElement.className = 'unit-stat-value';
    valueElement.textContent = `${value}${suffix}`;
    badge.append(labelElement, valueElement);
    return badge;
  }

  function createSpellCard(card) {
    const spellCard = document.createElement('article');
    spellCard.className = 'army-unit-card army-spell-card';
    const title = document.createElement('h3');
    title.textContent = 'Army Spells ';
    const meta = document.createElement('span');
    meta.className = 'unit-card-meta';
    const caster = card.rules.find(rule => rule.name === 'Caster');
    meta.textContent = `${card.name} · ${ruleLabel(caster)}`;
    title.append(meta);
    spellCard.append(title);
    const note = document.createElement('p');
    note.className = 'unit-spells-note';
    note.textContent = 'All faction spells';
    spellCard.append(note);
    const list = document.createElement('ol');
    list.className = 'unit-spell-list';
    card.spells.forEach(spell => {
      const item = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = spell.name;
      const threshold = document.createElement('span');
      threshold.className = 'unit-spell-threshold';
      threshold.textContent = spell.threshold != null ? `Cast ${spell.threshold}+` : '';
      const effect = document.createElement('p');
      effect.textContent = spell.effect || '—';
      item.append(name, threshold, effect);
      list.append(item);
    });
    spellCard.append(list);
    return spellCard;
  }

  function renderCards(cards, armyBook) {
    cardsOutput.replaceChildren();
    if (!cards.length) {
      cardsOutput.innerHTML = '<div class="empty-state"><h3>Noch keine Karten</h3><p>Lade eine ArmyForge-Aufstellung, damit die Einheitenkarten erstellt werden können.</p></div>';
      return;
    }
    cards.forEach(card => {
      const element = document.createElement('article');
      element.className = 'army-unit-card';
      const title = document.createElement('h3');
      title.textContent = `${card.quantity > 1 ? `${card.quantity}x ` : ''}${card.name} `;
      const meta = document.createElement('span');
      meta.className = 'unit-card-meta';
      meta.textContent = `[${card.size}] - ${card.cost}pts`;
      title.append(meta);
      element.append(title);
      if (card.joinedTo) {
        const joined = document.createElement('p');
        joined.className = 'unit-joined';
        joined.textContent = `↔ Joined to ${card.joinedTo}`;
        element.append(joined);
      }
      const badges = document.createElement('div');
      badges.className = 'unit-stat-badges';
      badges.append(createStatBadge('Quality', card.quality), createStatBadge('Defense', card.defense));
      const tough = card.rules.find(rule => rule.name === 'Tough');
      if (tough) badges.append(createStatBadge('Tough', tough.rating, ''));
      element.append(badges);
      if (card.rules.length) {
        const ruleLine = document.createElement('p');
        ruleLine.className = 'unit-rule-line';
        card.rules.forEach((rule, index) => {
          const ruleName = document.createElement('span');
          ruleName.textContent = ruleLabel(rule);
          ruleLine.append(ruleName);
          if (index < card.rules.length - 1) ruleLine.append(', ');
        });
        element.append(ruleLine);
      }
      const table = document.createElement('table');
      table.className = 'unit-weapon-table';
      table.innerHTML = '<thead><tr><th>Weapon</th><th>RNG</th><th>ATK</th><th>AP</th><th>SPE</th></tr></thead>';
      const body = document.createElement('tbody');
      card.weapons.forEach(weapon => {
        const row = document.createElement('tr');
        const cells = [
          `${weapon.count > 1 ? `${weapon.count}x ` : ''}${weapon.name}`,
          formatRange(weapon.range),
          `A${weapon.attacks}`,
          weaponAp(weapon),
          weaponSpecials(weapon),
        ];
        cells.forEach(value => {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.append(cell);
        });
        body.append(row);
      });
      table.append(body);
      element.append(table);
      const describedRules = [];
      addRules(describedRules, card.rules.filter(rule => rule.name !== 'Tough'));
      card.weapons.forEach(weapon => addRules(describedRules, weapon.specialRules || []));
      describedRules.sort((left, right) => ruleLabel(left).localeCompare(ruleLabel(right), 'en', { numeric: true, sensitivity: 'base' }));
      if (describedRules.length) {
        const explanations = document.createElement('ul');
        explanations.className = 'unit-rule-explanations';
        describedRules.forEach(rule => {
          const description = ruleDescription(rule, armyBook);
          if (!description) return;
          const item = document.createElement('li');
          const name = document.createElement('strong');
          name.textContent = `${ruleLabel(rule)}: `;
          item.append(name, description);
          explanations.append(item);
        });
        if (explanations.childElementCount) element.append(explanations);
      }
      cardsOutput.append(element);
      if (card.spells.length) cardsOutput.append(createSpellCard(card));
    });
  }

  function dimensions(entry) {
    const preset = PRESETS[entry.size];
    const raster = RASTER;
    const stripLength = preset.faceSpan / raster.faceShare;
    return { ...preset, ...raster, stripLength, stripHeight: preset.stripHeight };
  }

  // Guillotine-Packer nach dem Prinzip von Monsterforge: größte Elemente zuerst,
  // best short-side fit und freie Flächen erneut verwenden. Die Mini-Streifen selbst
  // werden nie gedreht - Laschen bleiben immer links und rechts.
  function packEntries(entries) {
    const pages = [];
    const messages = [];

    function pageSize(orientation) {
      const paper = PAGE[orientation];
      return {
        width: paper.width,
        height: paper.height,
        printable: { width: paper.width - PAGE.margin * 2, height: paper.height - PAGE.margin * 2 },
      };
    }

    function makePage(orientation) {
      const size = pageSize(orientation);
      return {
        orientation,
        ...size,
        placements: [],
        free: [{ x: PAGE.margin, y: PAGE.margin, width: size.printable.width, height: size.printable.height }],
      };
    }

    function findPlacement(page, d) {
      let best = null;
      page.free.forEach((free, freeIndex) => {
        const option = { width: d.stripLength, height: d.stripHeight };
        if (option.width > free.width + .001 || option.height > free.height + .001) return;
        const shortSide = Math.min(free.width - option.width, free.height - option.height);
        const longSide = Math.max(free.width - option.width, free.height - option.height);
        const score = shortSide * 1000 + longSide;
        if (!best || score < best.score) best = { freeIndex, free, ...option, score };
      });
      return best;
    }

    function splitFreeArea(page, placement) {
      const free = page.free.splice(placement.freeIndex, 1)[0];
      const remainingWidth = free.width - placement.width;
      const remainingHeight = free.height - placement.height;
      const verticalFirst = remainingWidth > remainingHeight;
      const candidates = verticalFirst
        ? [
          { x: free.x + placement.width, y: free.y, width: remainingWidth, height: free.height },
          { x: free.x, y: free.y + placement.height, width: placement.width, height: remainingHeight },
        ]
        : [
          { x: free.x + placement.width, y: free.y, width: remainingWidth, height: placement.height },
          { x: free.x, y: free.y + placement.height, width: free.width, height: remainingHeight },
        ];
      page.free.push(...candidates.filter(rectangle => rectangle.width > .01 && rectangle.height > .01));
    }

    const sortedEntries = entries
      .map(entry => ({ entry, dimensions: dimensions(entry) }))
      .sort((a, b) => (Math.max(b.dimensions.stripLength, b.dimensions.stripHeight) - Math.max(a.dimensions.stripLength, a.dimensions.stripHeight))
        || (b.dimensions.stripLength * b.dimensions.stripHeight - a.dimensions.stripLength * a.dimensions.stripHeight));

    for (const item of sortedEntries) {
      const portrait = pageSize('portrait');
      const orientation = item.dimensions.stripLength <= portrait.printable.width + .001
        && item.dimensions.stripHeight <= portrait.printable.height + .001
        ? 'portrait'
        : 'landscape';
      let pageIndex = -1;
      let best = null;
      pages.forEach((page, index) => {
        if (page.orientation !== orientation) return;
        const candidate = findPlacement(page, item.dimensions);
        if (candidate && (!best || candidate.score < best.score)) {
          best = candidate;
          pageIndex = index;
        }
      });
      if (!best) {
        const page = makePage(orientation);
        best = findPlacement(page, item.dimensions);
        if (!best) {
          messages.push(`${item.entry.label} (${item.entry.size.toUpperCase()}): ${item.dimensions.stripLength.toFixed(1)} × ${item.dimensions.stripHeight.toFixed(1)} mm passt auch im A4-Querformat nicht.`);
          continue;
        }
        pages.push(page);
        pageIndex = pages.length - 1;
      }
      const page = pages[pageIndex];
      page.placements.push({
        entry: item.entry,
        x: best.free.x,
        y: best.free.y,
        dimensions: item.dimensions,
      });
      splitFreeArea(page, best);
    }
    return { pages, messages };
  }

  function addArt(panel, imageFile, side, entry, mirrored = false) {
    const holder = panel.querySelector('.panel-art');
    if (!imageFile) {
      holder.classList.add('placeholder');
      holder.dataset.label = `${side}\n${entry.label}`;
      return;
    }
    const image = document.createElement('img');
    if (!assetUrls.has(imageFile)) {
      const url = URL.createObjectURL(imageFile);
      assetUrls.set(imageFile, url);
      objectUrls.push(url);
    }
    image.src = assetUrls.get(imageFile);
    image.alt = `${side} von ${entry.label}`;
    if (mirrored) image.classList.add('mirrored');
    holder.append(image);
  }

  function createMini(placement) {
    const { entry, x, y, dimensions: d } = placement;
    const fragment = miniTemplate.content.cloneNode(true);
    const element = fragment.querySelector('.mini-strip');
    element.style.setProperty('--strip-length', `${d.stripLength}mm`);
    element.style.setProperty('--strip-height', `${d.stripHeight}mm`);
    element.style.setProperty('--face-span', `${d.faceSpan}mm`);
    element.style.setProperty('--art-base', `${Math.max(1, d.stripHeight - ART_PADDING * 2)}mm`);
    element.style.setProperty('--art-height', `${Math.max(1, d.faceSpan - ART_PADDING * 2)}mm`);
    // CSS Grid benötigt Fraktionen mit Einheit. Ohne "fr" werden die vier
    // Felder als Zeilen statt als Lasche | Front | Rückseite | Lasche angelegt.
    element.style.setProperty('--tab-fr', `${d.tabFr}fr`);
    element.style.setProperty('--face-fr', `${d.faceFr}fr`);
    element.style.left = `${x}mm`;
    element.style.top = `${y}mm`;
    element.querySelector('.glue-left .fold-label').textContent = entry.label;
    element.querySelector('.glue-right .fold-label').textContent = '';
    addArt(element.querySelector('.front-panel'), entry.frontAsset || entry.front, 'Vorderseite', entry);
    addArt(element.querySelector('.back-panel'), entry.backAsset || entry.frontAsset || entry.back || entry.front, 'Rückseite', entry, !entry.back && Boolean(entry.front));
    return element;
  }

  function render(pages) {
    output.replaceChildren();
    pages.forEach((page, index) => {
      const { placements, orientation } = page;
      const wrapper = document.createElement('section');
      wrapper.className = `sheet-wrap ${orientation}`;
      const heading = document.createElement('p');
      heading.className = 'sheet-heading';
      heading.textContent = `A4-Seite ${index + 1}${orientation === 'landscape' ? ' · Querformat' : ''} · ${placements.length} Mini${placements.length === 1 ? '' : 's'}`;
      const sheet = document.createElement('div');
      sheet.className = `a4-sheet ${orientation}`;
      const printable = document.createElement('div');
      printable.className = 'printable-area';
      placements.forEach(placement => printable.append(createMini(placement)));
      sheet.append(printable);
      wrapper.append(heading, sheet);
      output.append(wrapper);
    });
  }

  function rebuildLayout() {
    if (!loadedArmy) return;
    const packed = packEntries(loadedEntries);
    emitWarnings([...loadMessages, ...packed.messages]);
    if (!packed.pages.length) {
      output.innerHTML = '<div class="empty-state"><h3>Noch keine druckbaren Minis</h3><p>Prüfe die Bildnamen. Sie müssen den Einheitsnamen aus Army Forge entsprechen, zum Beispiel „Dwarf Warriors.png“.</p></div>';
      printButton.disabled = true;
      return;
    }
    render(packed.pages);
    printButton.disabled = false;
  }

  function clearArtworkAssets() {
    objectUrls.forEach(URL.revokeObjectURL);
    objectUrls = [];
    assetUrls = new Map();
  }

  async function fetchArmyBook(army) {
    const params = new URLSearchParams({ armyId: army.armyId, gameSystem: army.gameSystem });
    const response = await fetch(`/api/army-book?${params.toString()}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function loadFiles(fileList) {
    const files = [...fileList];
    clearArtworkAssets();
    const exportFile = await readArmyForgeExport(files);
    if (!exportFile) {
      emitWarnings(['Kein gültiger ArmyForge-Export gefunden. Die JSON-Datei muss ein Feld „list.units“ enthalten.']);
      return;
    }
    const parsedArtworks = parseArtworkFiles(files);
    const records = await prepareArtworkRecords(parsedArtworks.records);
    const { invalid } = parsedArtworks;
    let armyBook = null;
    const allMessages = [];
    try {
      armyBook = await fetchArmyBook(exportFile.data);
    } catch {
      allMessages.push('Armeebuchdaten konnten nicht geladen werden. Bitte starte die App mit „node server.js“ und öffne http://127.0.0.1:4173/.');
    }
    const { entries, messages } = buildEntries(exportFile.data, records, armyBook);
    allMessages.push(...messages);
    if (invalid.length) allMessages.unshift(`${invalid.length} Bilddatei(en) konnten nicht gelesen werden.`);
    loadedArmy = exportFile.data;
    loadedArmyBook = armyBook;
    loadedEntries = entries;
    loadedCards = buildArmyCards(exportFile.data, armyBook);
    loadMessages = allMessages;
    renderCards(loadedCards, loadedArmyBook);
    cardsButton.disabled = !loadedCards.length;
    rebuildLayout();
  }

  function handleFiles(files) {
    if (files?.length) loadFiles(files);
  }

  folderInput.addEventListener('change', event => handleFiles(event.target.files));
  ['dragenter', 'dragover'].forEach(type => dropZone.addEventListener(type, event => {
    event.preventDefault();
    dropZone.classList.add('is-dragging');
  }));
  ['dragleave', 'drop'].forEach(type => dropZone.addEventListener(type, event => {
    event.preventDefault();
    dropZone.classList.remove('is-dragging');
  }));
  dropZone.addEventListener('drop', event => handleFiles(event.dataTransfer.files));
  dropZone.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') folderInput.click();
  });
  cardsButton.addEventListener('click', () => {
    const nextVisible = cardsPanel.hidden;
    cardsPanel.hidden = !nextVisible;
    document.body.classList.toggle('cards-view', nextVisible);
    cardsButton.textContent = nextVisible ? 'Zurück zu den Minis' : 'Cards anzeigen';
    if (nextVisible) cardsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  printButton.addEventListener('click', () => window.print());
})();
