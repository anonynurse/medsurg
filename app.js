const DATA_MANIFEST_PATH = './data/manifest.json';
const ALL_UNITS_OPTION = 'all-units';
const META_KEYS = new Set(['id', 'label', 'unitName', 'prefilledSections', 'gameType', 'tableName']);

const POOL_GROUPS = [
  {
    poolLabel: 'Signs Of Toxicity',
    keys: ['signs of toxicity - early', 'signs of toxicity - late'],
  },
];

const POOL_SECTION_ORDER = [
  'Description',
  'Etiology',
  'Risk Factors',
  'Pathophysiology',
  'Diagnostics',
  'Clinical Manifestations',
  'Treatment',
  'Nursing',
];

const LAST_POOL_SECTION_LABEL = 'Notes';

const elements = {
  errorBanner: document.getElementById('error-banner'),
  grid: document.getElementById('grid'),
  pool: document.getElementById('pool'),
  poolWrapper: document.querySelector('.pool-wrapper'),
  resetBtn: document.getElementById('reset-btn'),
  unitSelect: document.getElementById('unit-select'),
};

let allItems = [];
let placedLog = {};
let draggingId = null;
let selectedPill = null;
let unitCatalog = [];
let unitCache = new Map();

const isMobile = () => window.matchMedia('(pointer: coarse)').matches;

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.json$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function unitNameFromFile(fileName) {
  return String(fileName || '').replace(/\.json$/i, '');
}

function keyToId(key) {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function keyToLabel(key) {
  return String(key)
    .replace(/[-_]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(word => word.replace(/[a-z]/i, match => match.toUpperCase()))
    .join(' ');
}

function poolGroupingKeyFor(key) {
  return String(key)
    .replace(/\s*(\[[^\]]+\]|\([^)]+\))\s*$/, '')
    .trim();
}

function poolLabelFor(key) {
  const baseKey = poolGroupingKeyFor(key);
  const group = POOL_GROUPS.find(entry => entry.keys.includes(key) || entry.keys.includes(baseKey));
  return group ? group.poolLabel : keyToLabel(baseKey);
}

function poolSectionRank(label) {
  if (label === LAST_POOL_SECTION_LABEL) {
    return POOL_SECTION_ORDER.length + 1;
  }

  const index = POOL_SECTION_ORDER.indexOf(label);
  return index === -1 ? POOL_SECTION_ORDER.length : index;
}

function subsectionsFor(category) {
  return Object.keys(category)
    .filter(key => !META_KEYS.has(key))
    .map(key => ({ id: keyToId(key), key, label: keyToLabel(key) }));
}

function shuffle(items) {
  return [...items].sort(() => Math.random() - 0.5);
}

function clearError() {
  elements.errorBanner.style.display = 'none';
  elements.errorBanner.innerHTML = '';
}

function showError(message) {
  elements.errorBanner.innerHTML = message;
  elements.errorBanner.style.display = 'block';
}

function renderPoolMessage(message) {
  elements.pool.innerHTML = `<div class="empty-state">${message}</div>`;
}

function renderGridMessage(message) {
  elements.grid.innerHTML = `<div class="category"><div class="cat-title">${message}</div></div>`;
}

function ensureCompletedDivider() {
  let divider = elements.grid.querySelector('.completed-divider');
  if (!divider) {
    divider = document.createElement('div');
    divider.className = 'completed-divider';
    elements.grid.appendChild(divider);
  }

  return divider;
}

function resetState() {
  allItems = [];
  placedLog = {};
  draggingId = null;
  selectedPill = null;
  elements.resetBtn.style.display = 'none';
}

function bindUi() {
  elements.resetBtn.addEventListener('click', () => {
    void initGame();
  });

  elements.unitSelect.addEventListener('change', () => {
    void initGame();
  });

  window.addEventListener('resize', () => {
    if (elements.grid.querySelector('.category')) {
      updateCompletedCardLayout();
    }
  });

  elements.poolWrapper?.addEventListener('mouseenter', () => {
    clearPostDropOpenCards();
  });

  document.addEventListener('mousemove', event => {
    syncHoverOpenCards(event.target);
  });

  window.addEventListener('blur', () => {
    clearHoverOpenCards();
  });
}

async function initializeCatalog() {
  elements.unitSelect.disabled = true;

  try {
    const remoteUnits = await fetchRemoteCatalog();
    applyUnitCatalog(remoteUnits, ALL_UNITS_OPTION);
    clearError();
    await initGame();
  } catch (error) {
    unitCatalog = [];
    unitCache = new Map();
    populateUnitSelect();
    renderPoolMessage('Host the site to load unit data.');
    renderGridMessage('No hosted unit data available');
    showError(
      'Could not load hosted unit files. Run a simple local server like <code>py -m http.server</code>, or test from GitHub Pages after pushing.'
    );
  }
}

async function fetchRemoteCatalog() {
  const response = await fetch(DATA_MANIFEST_PATH, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const manifest = await response.json();
  const files = Array.isArray(manifest) ? manifest : manifest.units;

  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Manifest is empty.');
  }

  return files
    .filter(fileName => /\.json$/i.test(fileName))
    .filter(fileName => slugify(fileName) !== 'manifest')
    .map(fileName => ({
      id: `remote:${slugify(fileName)}`,
      name: unitNameFromFile(fileName),
      fileName,
      source: 'remote',
    }));
}

function populateUnitSelect(selectedValue = ALL_UNITS_OPTION) {
  if (!unitCatalog.length) {
    elements.unitSelect.innerHTML = '<option>No units loaded</option>';
    elements.unitSelect.disabled = true;
    return;
  }

  const options = [`<option value="${ALL_UNITS_OPTION}">All Units</option>`]
    .concat(
      unitCatalog.map(unit => `<option value="${unit.id}">${unit.name}</option>`)
    )
    .join('');

  elements.unitSelect.innerHTML = options;
  elements.unitSelect.disabled = false;
  elements.unitSelect.value = unitCatalog.some(unit => unit.id === selectedValue)
    ? selectedValue
    : ALL_UNITS_OPTION;
}

function applyUnitCatalog(units, selectedValue = ALL_UNITS_OPTION) {
  unitCatalog = units;
  unitCache = new Map();
  populateUnitSelect(selectedValue);
}

async function loadUnitCategories(unit) {
  if (unitCache.has(unit.id)) {
    return unitCache.get(unit.id);
  }

  const response = await fetch(`./data/${unit.fileName}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Could not load ${unit.fileName} (${response.status}).`);
  }

  const rawData = await response.json();
  const normalized = normalizeUnitData(rawData, unit.name);
  unitCache.set(unit.id, normalized);
  return normalized;
}

function normalizeUnitData(rawData, unitName) {
  const unitSlug = slugify(unitName);

  if (Array.isArray(rawData)) {
    return rawData
      .map((category, index) => normalizeLegacyCategory(category, unitName, unitSlug, index))
      .filter(Boolean);
  }

  if (rawData && Array.isArray(rawData.tables)) {
    const displayUnitName = String(rawData.title || unitName).trim() || unitName;
    return rawData.tables
      .flatMap((table, index) => normalizeTableCategories(table, displayUnitName, unitSlug, index))
      .filter(Boolean);
  }

  throw new Error(`Unsupported JSON shape for ${unitName}.`);
}

function normalizeLegacyCategory(category, unitName, unitSlug, index) {
  const normalized = {
    id: `${unitSlug}-${slugify(category.id || category.label || `category-${index + 1}`)}`,
    label: String(category.label || `Category ${index + 1}`).trim(),
    unitName,
  };

  Object.entries(category).forEach(([key, value]) => {
    if (key === 'id' || key === 'label') {
      return;
    }

    const entries = normalizeSectionEntries(value);
    if (entries.length) {
      normalized[key] = entries;
    }
  });

  return subsectionsFor(normalized).length ? normalized : null;
}

function normalizeTableCategories(table, unitName, unitSlug, index) {
  if (table.game_type === 'row-match') {
    return normalizeRowMatchTable(table, unitName, unitSlug, index);
  }

  const label = String(table.table_name || table.name || `Table ${index + 1}`).trim();
  const normalized = {
    id: `${unitSlug}-${slugify(label || `table-${index + 1}`)}`,
    label: label || `Table ${index + 1}`,
    unitName,
    tableName: label || `Table ${index + 1}`,
  };

  const rows = table.rows;

  if (Array.isArray(rows)) {
    Object.entries(normalizeTabularRows(rows)).forEach(([key, entries]) => {
      if (entries.length) {
        normalized[key] = entries;
      }
    });
  } else if (rows && typeof rows === 'object') {
    Object.entries(rows).forEach(([key, value]) => {
      const entries = normalizeSectionEntries(value);
      if (entries.length) {
        normalized[key] = entries;
      }
    });
  }

  return subsectionsFor(normalized).length ? [normalized] : [];
}

function normalizeRowMatchTable(table, unitName, unitSlug, index) {
  const tableLabel = String(table.table_name || table.name || `Table ${index + 1}`).trim() || `Table ${index + 1}`;
  const prefillKeys = new Set(Array.isArray(table.prefill_keys) ? table.prefill_keys : []);
  const rows = Array.isArray(table.rows) ? table.rows : [];

  return rows
    .map((row, rowIndex) => {
      const category = {
        id: `${unitSlug}-${slugify(tableLabel)}-row-${rowIndex + 1}`,
        label: tableLabel,
        unitName,
        tableName: tableLabel,
        gameType: 'row-match',
        prefilledSections: {},
      };

      Object.entries(row || {}).forEach(([key, value]) => {
        const entries = normalizeSectionEntries(value);
        if (!entries.length) {
          return;
        }

        category[key] = entries;

        if (prefillKeys.has(key)) {
          category.prefilledSections[key] = entries;
        }
      });

      return Object.keys(category.prefilledSections).length || subsectionsFor(category).length
        ? category
        : null;
    })
    .filter(Boolean);
}

function normalizeTabularRows(rows) {
  const columns = [];

  rows.forEach(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return;
    }

    Object.keys(row).forEach(key => {
      if (!columns.includes(key)) {
        columns.push(key);
      }
    });
  });

  return columns.reduce((result, key) => {
    const entries = rows
      .map(row => formatInlineValue(row && row[key]))
      .filter(Boolean);

    if (entries.length) {
      result[key] = entries;
    }

    return result;
  }, {});
}

function normalizeSectionEntries(value) {
  if (Array.isArray(value)) {
    return value
      .map(normalizeCollectionEntry)
      .filter(Boolean);
  }

  const singleEntry = normalizeCollectionEntry(value);
  return singleEntry ? [singleEntry] : [];
}

function normalizeCollectionEntry(entry) {
  if (entry === null || entry === undefined) {
    return null;
  }

  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (!trimmed) {
      return null;
    }

    const orderedEntry = parseOrderedEntry(trimmed);
    return orderedEntry || trimmed;
  }

  if (typeof entry === 'number' || typeof entry === 'boolean') {
    return String(entry);
  }

  if (Array.isArray(entry)) {
    const flattened = entry.map(formatInlineValue).filter(Boolean).join(' | ');
    return flattened || null;
  }

  if (typeof entry === 'object') {
    if (typeof entry.text === 'string' && entry.text.trim()) {
      const normalizedEntry = {
        text: entry.text.trim(),
      };

      if (Number.isFinite(entry.order)) {
        normalizedEntry.order = Number(entry.order);
      }

      if (typeof entry.hint === 'string' && entry.hint.trim()) {
        normalizedEntry.hint = entry.hint.trim();
      }

      return normalizedEntry;
    }

    if (typeof entry.label === 'string' && entry.label.trim()) {
      const normalizedNested = { label: entry.label.trim() };

      Object.entries(entry).forEach(([key, value]) => {
        if (key === 'label') {
          return;
        }

        const nestedEntries = Array.isArray(value)
          ? value.map(formatInlineValue).filter(Boolean)
          : [formatInlineValue(value)].filter(Boolean);

        if (nestedEntries.length) {
          normalizedNested[key] = nestedEntries;
        }
      });

      return normalizedNested;
    }

    const formatted = formatObjectEntry(entry);
    return formatted || null;
  }

  return null;
}

function formatInlineValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(formatInlineValue).filter(Boolean).join(', ');
  }

  if (typeof value === 'object') {
    if (typeof value.text === 'string') {
      return value.text.trim();
    }

    return formatObjectEntry(value);
  }

  return '';
}

function formatObjectEntry(objectValue) {
  return Object.entries(objectValue)
    .map(([key, value]) => {
      const renderedValue = formatInlineValue(value);
      return renderedValue ? `${key}: ${renderedValue}` : key;
    })
    .filter(Boolean)
    .join(' | ');
}

async function categoriesForCurrentSelection() {
  if (!unitCatalog.length) {
    return [];
  }

  if (elements.unitSelect.value === ALL_UNITS_OPTION) {
    const bundles = await Promise.all(unitCatalog.map(unit => loadUnitCategories(unit)));
    return bundles.flat().map(prepareCategoryForAllUnits);
  }

  const selectedUnit = unitCatalog.find(unit => unit.id === elements.unitSelect.value);
  if (!selectedUnit) {
    return [];
  }

  const categories = await loadUnitCategories(selectedUnit);
  return categories.map(prepareCategoryForSingleUnit);
}

function redundantNameRowValue(category) {
  const nameEntries = Array.isArray(category.Name) ? category.Name : null;
  if (!nameEntries || nameEntries.length !== 1) {
    return null;
  }

  const nameValue = String(nameEntries[0]).trim();
  if (!nameValue) {
    return null;
  }

  return slugify(nameValue) === slugify(category.label)
    ? nameValue
    : null;
}

function prepareCategoryForAllUnits(category) {
  if (category.gameType === 'row-match') {
    return {
      ...category,
      label: `${category.unitName} | ${category.label}`,
    };
  }

  const nameValue = redundantNameRowValue(category);
  if (!nameValue) {
    return {
      ...category,
      label: `${category.unitName} | ${category.label}`,
    };
  }

  return {
    ...category,
    label: category.unitName,
    prefilledSections: {
      Name: [nameValue],
    },
  };
}

function prepareCategoryForSingleUnit(category) {
  if (category.gameType === 'row-match') {
    return { ...category };
  }

  const nameValue = redundantNameRowValue(category);
  if (!nameValue) {
    return { ...category };
  }

  return {
    ...category,
    label: '',
    prefilledSections: {
      ...(category.prefilledSections || {}),
      Name: [nameValue],
    },
  };
}

function isPrefilledSection(category, key) {
  return Boolean(category.prefilledSections && category.prefilledSections[key]);
}

function parseData(categories) {
  const itemMap = {};

  function addItem(label, hint, typeId, typeKey, poolLabel, categoryId, parentId, sortOrder) {
    const orderKey = sortOrder === null || sortOrder === undefined ? '' : `|order-${sortOrder}`;
    const itemKey = `${label.toLowerCase()}|${typeId}${orderKey}` + (parentId ? `|child-of-${parentId}` : '');
    const id = itemKey.replace(/[^a-z0-9]/g, '-');

    if (!itemMap[itemKey]) {
      itemMap[itemKey] = {
        id,
        label,
        hint,
        type: typeId,
        typeKey,
        poolLabel,
        correctCats: new Set(),
        parentId: parentId || null,
        children: [],
        sortOrder: sortOrder ?? null,
      };
    }

    itemMap[itemKey].correctCats.add(categoryId);
    return id;
  }

  categories.forEach(category => {
    subsectionsFor(category).forEach(subsection => {
      if (isPrefilledSection(category, subsection.key)) {
        return;
      }

      const entries = category[subsection.key] || [];

      entries.forEach(rawEntry => {
        const parsedEntry = parseDisplayEntry(rawEntry);
        if (parsedEntry) {
          addItem(
            parsedEntry.label,
            parsedEntry.hint,
            subsection.id,
            subsection.key,
            poolLabelFor(subsection.key),
            category.id,
            null,
            parsedEntry.order
          );
          return;
        }

        if (typeof rawEntry === 'object' && rawEntry && rawEntry.label) {
          const parentId = addItem(
            rawEntry.label,
            null,
            subsection.id,
            subsection.key,
            poolLabelFor(subsection.key),
            category.id,
            null
          );

          Object.keys(rawEntry)
            .filter(key => key !== 'label')
            .forEach(nestedKey => {
              const nestedEntries = rawEntry[nestedKey] || [];
              const nestedTypeId = keyToId(nestedKey);
              const nestedTypeLabel = keyToLabel(nestedKey);

              nestedEntries.forEach(childRaw => {
                const childEntry = parseDisplayEntry(childRaw);
                const childLabel = childEntry ? childEntry.label : String(childRaw).trim();
                const childHint = childEntry ? childEntry.hint : null;
                const childId = addItem(
                  childLabel,
                  childHint,
                  nestedTypeId,
                  nestedKey,
                  nestedTypeLabel,
                  category.id,
                  parentId,
                  childEntry ? childEntry.order : null
                );

                const parentItem = Object.values(itemMap).find(item => item.id === parentId);
                if (parentItem && !parentItem.children.find(child => child.typeId === nestedTypeId)) {
                  parentItem.children.push({ typeId: nestedTypeId, typeLabel: nestedTypeLabel });
                }

                return childId;
              });
            });
        }
      });
    });
  });

  return Object.values(itemMap);
}

function buildGrid(categories) {
  elements.grid.innerHTML = '';

  if (!categories.length) {
    renderGridMessage('No study tables in this unit yet');
    return;
  }

  categories.forEach(category => {
    const box = document.createElement('div');
    box.className = 'category';
    box.id = `cat-${category.id}`;
    box.dataset.initialIndex = String(elements.grid.children.length);

    const subsections = subsectionsFor(category);
    const nameHeader = subsections.find(subsection => isPrefilledSection(category, subsection.key) && subsection.key === 'Name');
    const bodySubsections = subsections.filter(subsection => subsection !== nameHeader);

    const titleHtml = category.label ? `<div class="cat-title">${category.label}</div>` : '';
    const nameHeaderHtml = nameHeader
      ? `
        <div class="subsection prefilled-name-section" data-key="${nameHeader.key}">
          <div class="sub-pills prefilled-name"
               id="pills-${category.id}-${nameHeader.id}"
               data-cat="${category.id}"
               data-sub="${nameHeader.id}"></div>
        </div>
      `
      : '';

    const bodyHtml = bodySubsections
      .map(subsection => `
        <div class="subsection" data-key="${subsection.key}">
          <div class="sub-label">${subsection.label}</div>
          <div class="sub-pills"
               id="pills-${category.id}-${subsection.id}"
               data-cat="${category.id}"
               data-sub="${subsection.id}"></div>
        </div>
      `)
      .join('');

    box.innerHTML = `
      <div class="card-summary">
        ${titleHtml}
        ${nameHeaderHtml}
      </div>
      <div class="card-body">${bodyHtml}</div>
    `;
    elements.grid.appendChild(box);
    applyPrefilledSections(category);
  });

  attachCardInteractionListeners();
  attachDropZoneListeners();
  updateCompletedCardLayout();
}

function applyPrefilledSections(category) {
  if (!category.prefilledSections) {
    return;
  }

  Object.entries(category.prefilledSections).forEach(([key, entries]) => {
    const zone = document.getElementById(`pills-${category.id}-${keyToId(key)}`);
    if (!zone) {
      return;
    }

    zone.dataset.prefilled = 'true';
    zone.innerHTML = '';
    zone.closest('.subsection')?.classList.add('prefilled-section');

    if (key === 'Name') {
      zone.classList.add('prefilled-name');
      zone.closest('.subsection')?.classList.add('prefilled-name-section');
    }

    sortEntriesForDisplay(entries).forEach(entry => {
      const placed = document.createElement('span');
      placed.className = 'placed-pill';
      placed.textContent = displayTextForEntry(entry);
      const entryOrder = orderForEntry(entry);
      if (entryOrder !== null) {
        placed.dataset.sortOrder = String(entryOrder);
      }
      zone.appendChild(placed);
    });

    zone.classList.add('complete');
  });
}

function expectedCountForZone(categoryId, subsectionId, parentItemId = null) {
  return allItems.filter(item =>
    item.correctCats.has(categoryId) &&
    item.type === subsectionId &&
    (item.parentId || null) === parentItemId
  ).length;
}

function countPlacedInZone(zone) {
  return [...zone.children].filter(child => child.classList && child.classList.contains('placed-pill')).length;
}

function updateZoneCompletionState(zone) {
  if (!zone) {
    return;
  }

  const subsection = zone.closest('.subsection');

  if (zone.dataset.prefilled === 'true') {
    zone.classList.add('complete');
    subsection?.classList.add('subsection-complete');
    updateCardCompletionState(zone.closest('.category'));
    return;
  }

  const categoryId = zone.dataset.cat;
  const subsectionId = zone.dataset.sub;
  const parentItemId = zone.dataset.parentItemId || null;
  const expected = expectedCountForZone(categoryId, subsectionId, parentItemId);
  const placed = countPlacedInZone(zone);

  const isComplete = expected > 0 && placed >= expected;
  zone.classList.toggle('complete', isComplete);
  subsection?.classList.toggle('subsection-complete', isComplete);
  updateCardCompletionState(zone.closest('.category'));
}

function updateCardCompletionState(card) {
  if (!card) {
    return;
  }

  const zones = [...card.querySelectorAll('.sub-pills')];
  const isComplete = zones.length > 0 && zones.every(zone => zone.classList.contains('complete'));
  const wasComplete = card.classList.contains('card-complete');
  card.classList.toggle('card-complete', isComplete);

  if (wasComplete !== isComplete) {
    updateCompletedCardLayout();
  }
}

function gridColumnCount() {
  if (window.matchMedia('(max-width: 560px)').matches) {
    return 1;
  }

  if (window.matchMedia('(max-width: 900px)').matches) {
    return 2;
  }

  if (window.matchMedia('(max-width: 1200px)').matches) {
    return 3;
  }

  return 4;
}

function buildGridBand(cards, bandClassName, columnCount) {
  if (!cards.length) {
    return null;
  }

  const band = document.createElement('div');
  band.className = `grid-band ${bandClassName}`;

  const columns = Array.from({ length: columnCount }, () => {
    const column = document.createElement('div');
    column.className = 'grid-column';
    return column;
  });

  const sortedCards = [...cards].sort(
    (leftCard, rightCard) =>
      (Number(leftCard.dataset.initialIndex) || 0) - (Number(rightCard.dataset.initialIndex) || 0)
  );

  sortedCards.forEach(card => {
    const columnIndex = (Number(card.dataset.initialIndex) || 0) % columnCount;
    columns[columnIndex].appendChild(card);
  });

  columns
    .filter(column => column.children.length > 0)
    .forEach(column => band.appendChild(column));

  return band;
}

function isCardOpen(card) {
  return (
    card.classList.contains('card-hover-open') ||
    card.classList.contains('card-drag-hover') ||
    card.classList.contains('card-post-drop-open') ||
    card.classList.contains('card-locked')
  );
}

function updateCompletedCardLayout() {
  const grid = elements.grid;
  if (!grid) {
    return;
  }

  const cards = [...grid.querySelectorAll('.category')];
  if (!cards.length) {
    return;
  }

  const columnCount = gridColumnCount();
  const incompleteCards = cards.filter(card => !card.classList.contains('card-complete'));
  const completedCards = cards.filter(card => card.classList.contains('card-complete'));

  const incompleteBand = buildGridBand(incompleteCards, 'grid-band-active', columnCount);
  const completedBand = buildGridBand(completedCards, 'grid-band-completed', columnCount);

  grid.innerHTML = '';

  if (incompleteBand) {
    grid.appendChild(incompleteBand);
  }

  if (completedBand) {
    grid.appendChild(completedBand);
  }
}

function clearDragHoverCards() {
  let changed = false;
  document.querySelectorAll('.category.card-drag-hover').forEach(card => {
    card.classList.remove('card-drag-hover');
    changed = true;
  });

  if (changed) {
    updateCompletedCardLayout();
  }
}

function clearPostDropOpenCards() {
  let changed = false;
  document.querySelectorAll('.category.card-post-drop-open').forEach(card => {
    if (!card.classList.contains('card-locked')) {
      card.classList.remove('card-post-drop-open');
      changed = true;
    }
  });

  if (changed) {
    updateCompletedCardLayout();
  }
}

function clearHoverOpenCards() {
  let changed = false;
  document.querySelectorAll('.category.card-hover-open').forEach(card => {
    card.classList.remove('card-hover-open');
    changed = true;
  });

  if (changed) {
    updateCompletedCardLayout();
  }
}

function syncHoverOpenCards(target) {
  if (isMobile() || draggingId || selectedPill) {
    return;
  }

  const hoveredCard = target instanceof Element ? target.closest('.category') : null;
  let changed = false;

  document.querySelectorAll('.category.card-hover-open').forEach(card => {
    if (card !== hoveredCard) {
      card.classList.remove('card-hover-open');
      changed = true;
    }
  });

  if (changed) {
    updateCompletedCardLayout();
  }
}

function clearCardOpenStateForNewPick() {
  clearHoverOpenCards();
  clearPostDropOpenCards();

  let changed = false;
  document.querySelectorAll('.category.card-drag-hover').forEach(card => {
    card.classList.remove('card-drag-hover');
    changed = true;
  });

  if (changed) {
    updateCompletedCardLayout();
  }
}

function markCardOpenAfterSuccess(card) {
  if (!card || card.classList.contains('card-locked')) {
    return;
  }

  let changed = false;

  document.querySelectorAll('.category.card-post-drop-open').forEach(otherCard => {
    if (otherCard !== card && !otherCard.classList.contains('card-locked')) {
      otherCard.classList.remove('card-post-drop-open');
      changed = true;
    }
  });

  if (!card.classList.contains('card-post-drop-open')) {
    card.classList.add('card-post-drop-open');
    changed = true;
  }

  if (changed) {
    updateCompletedCardLayout();
  }
}

function expandCardForDrag(card) {
  if (!card || !draggingId || isMobile()) {
    return;
  }

  let changed = false;

  document.querySelectorAll('.category.card-drag-hover').forEach(otherCard => {
    if (otherCard !== card) {
      otherCard.classList.remove('card-drag-hover');
      changed = true;
    }
  });

  if (!card.classList.contains('card-locked') && !card.classList.contains('card-drag-hover')) {
    card.classList.add('card-drag-hover');
    changed = true;
  }

  if (changed) {
    updateCompletedCardLayout();
  }
}

function attachCardInteractionListeners() {
  document.querySelectorAll('.category').forEach(card => {
    if (card.dataset.cardListenersAttached) {
      return;
    }

    card.dataset.cardListenersAttached = 'true';

    const summary = card.querySelector('.card-summary');
    if (!summary) {
      return;
    }

    summary.addEventListener('dragenter', () => {
      expandCardForDrag(card);
    });

    summary.addEventListener('dragover', () => {
      expandCardForDrag(card);
    });

    summary.addEventListener('mouseenter', () => {
      if (isMobile() || card.classList.contains('card-locked') || card.classList.contains('card-hover-open')) {
        return;
      }

      card.classList.add('card-hover-open');
      updateCompletedCardLayout();
    });

    card.addEventListener('mouseleave', () => {
      if (!card.classList.contains('card-hover-open')) {
        return;
      }

      card.classList.remove('card-hover-open');
      updateCompletedCardLayout();
    });

    summary.addEventListener('click', event => {
      event.stopPropagation();

      if (selectedPill) {
        if (!card.classList.contains('card-locked') && !card.classList.contains('card-hover-open')) {
          card.classList.add('card-hover-open');
          updateCompletedCardLayout();
        }
        return;
      }

      if (card.classList.contains('card-post-drop-open') && !card.classList.contains('card-locked')) {
        card.classList.remove('card-post-drop-open');
        card.classList.remove('card-hover-open');
        card.classList.remove('card-drag-hover');
        updateCompletedCardLayout();
        return;
      }

      if (draggingId && !isMobile()) {
        return;
      }

      const willLock = !card.classList.contains('card-locked');
      card.classList.toggle('card-locked', willLock);

      if (willLock) {
        card.classList.remove('card-hover-open');
        card.classList.remove('card-drag-hover');
      }

      updateCompletedCardLayout();
    });
  });
}

function attachDropZoneListeners() {
  document.querySelectorAll('.sub-pills').forEach(zone => {
    if (zone.dataset.listenersAttached) {
      return;
    }

    zone.dataset.listenersAttached = 'true';

    if (zone.dataset.prefilled === 'true') {
      return;
    }

    zone.addEventListener('dragover', event => {
      event.preventDefault();
      event.stopPropagation();
      zone.classList.add('drag-over');
    });

    zone.addEventListener('dragleave', event => {
      if (zone.contains(event.relatedTarget)) {
        return;
      }

      zone.classList.remove('drag-over');
    });

    zone.addEventListener('drop', event => {
      event.preventDefault();
      event.stopPropagation();
      clearDropZoneHints();
      handleDrop(zone.dataset.cat, zone.dataset.sub, zone.dataset.parentItemId || null);
    });

    zone.addEventListener('click', event => {
      event.stopPropagation();

      if (!selectedPill) {
        return;
      }

      placeSelectedPillInZone(zone);
    });

    const subsection = zone.closest('.subsection');
    if (subsection && !subsection.dataset.clickPlacementAttached) {
      subsection.dataset.clickPlacementAttached = 'true';
      subsection.addEventListener('click', event => {
        if (!selectedPill) {
          return;
        }

        if (event.target.closest('.sub-pills')) {
          return;
        }

        event.stopPropagation();
        const subsectionZone = subsection.querySelector('.sub-pills');
        if (!subsectionZone || subsectionZone.dataset.prefilled === 'true') {
          return;
        }

        placeSelectedPillInZone(subsectionZone);
      });
    }
  });
}

function buildPool() {
  elements.pool.innerHTML = '';

  const sectionMap = new Map();
  allItems.forEach(item => {
    if (!sectionMap.has(item.poolLabel)) {
      sectionMap.set(item.poolLabel, []);
    }

    sectionMap.get(item.poolLabel).push(item);
  });

  const sections = [...sectionMap.entries()].sort(([leftLabel], [rightLabel]) => {
    const leftRank = poolSectionRank(leftLabel);
    const rightRank = poolSectionRank(rightLabel);

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return leftLabel.localeCompare(rightLabel);
  });

  if (!sections.length) {
    renderPoolMessage('No study items in this unit yet.');
    return;
  }

  sections.forEach(([label, items], index) => {
    const section = document.createElement('div');
    section.className = 'pool-section';
    section.dataset.baseOrder = String(index);
    section.innerHTML = `<div class="pool-section-label">${label}</div>`;

    const row = document.createElement('div');
    row.className = 'pool-row';
    shuffle(items).forEach(item => row.appendChild(makePill(item)));

    section.appendChild(row);
    elements.pool.appendChild(section);
  });

  updatePoolSectionLayout();
}

function updatePoolSectionLayout() {
  const sections = [...elements.pool.querySelectorAll('.pool-section')];
  const offset = sections.length + 1;

  sections.forEach((section, index) => {
    const baseOrder = Number(section.dataset.baseOrder) || index;
    const hasPills = Boolean(section.querySelector('.drug-pill'));
    section.classList.toggle('pool-section-empty', !hasPills);
    section.style.order = String(hasPills ? baseOrder : offset + baseOrder);
  });
}

function makePill(item) {
  const pill = document.createElement('div');
  pill.className = 'drug-pill';
  pill.id = `pill-${item.id}`;
  pill.draggable = true;
  pill.textContent = item.label;

  if (item.correctCats.size > 1) {
    const badge = document.createElement('span');
    badge.className = 'remaining-badge';
    badge.textContent = item.correctCats.size;
    pill.appendChild(badge);
  }

  pill.addEventListener('dragstart', () => {
    clearDropZoneHints();
    clearCardOpenStateForNewPick();
    draggingId = item.id;
  });

  pill.addEventListener('dragend', () => {
    clearDropZoneHints();
    clearDragHoverCards();
    clearTapTargets();
    draggingId = null;
  });

  pill.addEventListener('click', () => {
    if (selectedPill === pill) {
      pill.classList.remove('tap-selected');
      selectedPill = null;
      draggingId = null;
      clearTapTargets();
      return;
    }

    if (selectedPill) {
      selectedPill.classList.remove('tap-selected');
    }

    clearCardOpenStateForNewPick();
    selectedPill = pill;
    draggingId = item.id;
    pill.classList.add('tap-selected');
    document.querySelectorAll('.sub-pills').forEach(zone => {
      if (zone.dataset.prefilled === 'true') {
        return;
      }

      zone.classList.add('tap-target');
    });
  });

  return pill;
}

function revealChildren(parentItem, categoryId) {
  if (!parentItem.children.length) {
    return;
  }

  const placedElement = document.querySelector(`.placed-pill[data-item-id="${parentItem.id}"][data-cat="${categoryId}"]`);
  if (!placedElement) {
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'nested-zone-wrapper';

  parentItem.children.forEach(child => {
    const zoneId = `nested-${categoryId}-${child.typeId}-${parentItem.id}`;
    const zoneContainer = document.createElement('div');
    zoneContainer.innerHTML = `
      <div class="nested-zone-label">${parentItem.label} - ${child.typeLabel}</div>
      <div class="sub-pills"
           id="${zoneId}"
           data-cat="${categoryId}"
           data-sub="${child.typeId}"
           data-parent-item-id="${parentItem.id}"></div>
    `;
    wrapper.appendChild(zoneContainer);
  });

  placedElement.insertAdjacentElement('afterend', wrapper);
  attachDropZoneListeners();
  updateCardCompletionState(placedElement.closest('.category'));
}

function handleDrop(categoryId, subsectionId, parentItemId) {
  if (!draggingId) {
    return;
  }

  const item = allItems.find(entry => entry.id === draggingId);
  if (!item) {
    return;
  }

  const pill = document.getElementById(`pill-${item.id}`);
  if (!pill) {
    return;
  }

  const correctCategoryAndType = item.correctCats.has(categoryId) && item.type === subsectionId;
  const correctParent = !item.parentId || parentItemId === item.parentId;
  const isCorrect = correctCategoryAndType && correctParent;
  const targetCard = document.getElementById(`cat-${categoryId}`);

  if (!isCorrect) {
    shake(pill);

    if (!isMobile()) {
      selectedPill = null;
      draggingId = null;
    }

    return;
  }

  const slotKey = `${categoryId}|${subsectionId}` + (parentItemId ? `|${parentItemId}` : '');
  if (placedLog[item.id] && placedLog[item.id].has(slotKey)) {
    return;
  }

  if (!placedLog[item.id]) {
    placedLog[item.id] = new Set();
  }

  placedLog[item.id].add(slotKey);

  const placed = document.createElement('span');
  placed.className = 'placed-pill';
  placed.dataset.itemId = item.id;
  placed.dataset.cat = categoryId;
  if (item.sortOrder !== null) {
    placed.dataset.sortOrder = String(item.sortOrder);
  }
  placed.innerHTML = item.hint
    ? `${item.label} <span class="hint">(${item.hint})</span>`
    : item.label;

  const zoneId = parentItemId
    ? `nested-${categoryId}-${subsectionId}-${parentItemId}`
    : `pills-${categoryId}-${subsectionId}`;
  const zone = document.getElementById(zoneId);

  if (zone) {
    insertPlacedPill(zone, placed, item.sortOrder);
    updateZoneCompletionState(zone);
  }

  markCardOpenAfterSuccess(targetCard);

  if (item.children.length) {
    revealChildren(item, categoryId);
  }

  const remaining = item.correctCats.size - placedLog[item.id].size;
  if (remaining <= 0) {
    pill.remove();
  } else {
    const badge = pill.querySelector('.remaining-badge');
    if (badge) {
      badge.textContent = remaining;
    }
  }

  updatePoolSectionLayout();
  checkComplete();
}

function clearTapTargets() {
  document.querySelectorAll('.sub-pills').forEach(zone => zone.classList.remove('tap-target'));
}

function clearDropZoneHints() {
  document.querySelectorAll('.sub-pills').forEach(zone => zone.classList.remove('drag-over'));
  clearDragHoverCards();
}

function placeSelectedPillInZone(zone) {
  if (!selectedPill || !zone) {
    return;
  }

  clearTapTargets();
  selectedPill.classList.remove('tap-selected');
  handleDrop(zone.dataset.cat, zone.dataset.sub, zone.dataset.parentItemId || null);
  selectedPill = null;
  draggingId = null;
}

function parseOrderedEntry(text) {
  const dotMatch = text.match(/^\s*(\d+)[.)]\s+(.+)$/);
  if (dotMatch) {
    return { text: dotMatch[2].trim(), order: Number(dotMatch[1]) };
  }

  const hyphenMatch = text.match(/^\s*(\d+)\s*[-\u2013]\s*(\D.+)$/);
  if (hyphenMatch) {
    return { text: hyphenMatch[2].trim(), order: Number(hyphenMatch[1]) };
  }

  return null;
}

function parseDisplayEntry(rawEntry) {
  if (typeof rawEntry === 'string') {
    return parseDisplayText(rawEntry);
  }

  if (rawEntry && typeof rawEntry === 'object' && typeof rawEntry.text === 'string') {
    return {
      label: rawEntry.text.trim(),
      hint: typeof rawEntry.hint === 'string' && rawEntry.hint.trim() ? rawEntry.hint.trim() : null,
      order: Number.isFinite(rawEntry.order) ? Number(rawEntry.order) : null,
    };
  }

  return null;
}

function parseDisplayText(rawText) {
  let text = rawText.trim();
  let order = null;
  const ordered = parseOrderedEntry(text);

  if (ordered) {
    text = ordered.text;
    order = ordered.order;
  }

  const hintMatch = text.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  return {
    label: hintMatch ? hintMatch[1].trim() : text.trim(),
    hint: hintMatch ? hintMatch[2].trim() : null,
    order,
  };
}

function displayTextForEntry(entry) {
  if (typeof entry === 'string') {
    return entry;
  }

  if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
    return entry.text;
  }

  return String(entry ?? '');
}

function orderForEntry(entry) {
  return entry && typeof entry === 'object' && Number.isFinite(entry.order)
    ? Number(entry.order)
    : null;
}

function sortEntriesForDisplay(entries) {
  return [...entries].sort((left, right) => {
    const leftOrder = orderForEntry(left);
    const rightOrder = orderForEntry(right);

    if (leftOrder === null && rightOrder === null) {
      return 0;
    }

    if (leftOrder === null) {
      return 1;
    }

    if (rightOrder === null) {
      return -1;
    }

    return leftOrder - rightOrder;
  });
}

function insertPlacedPill(zone, placedPill, sortOrder) {
  if (sortOrder === null || sortOrder === undefined) {
    zone.appendChild(placedPill);
    return;
  }

  const existingPills = [...zone.children].filter(child => child.classList && child.classList.contains('placed-pill'));
  const nextPill = existingPills.find(child => {
    const childOrder = Number.isFinite(Number(child.dataset.sortOrder))
      ? Number(child.dataset.sortOrder)
      : null;

    return childOrder === null || childOrder > sortOrder;
  });

  if (nextPill) {
    zone.insertBefore(placedPill, nextPill);
  } else {
    zone.appendChild(placedPill);
  }
}

function shake(pill) {
  pill.classList.remove('shake');
  void pill.offsetWidth;
  pill.classList.add('shake');
  setTimeout(() => pill.classList.remove('shake'), 500);
}

function checkComplete() {
  if (document.querySelectorAll('#pool .drug-pill').length !== 0) {
    return;
  }

  elements.pool.innerHTML = '<div class="success-msg">All correct</div>';
  elements.resetBtn.style.display = 'block';
}

async function initGame() {
  resetState();
  clearError();

  try {
    const categories = await categoriesForCurrentSelection();
    buildGrid(categories);
    allItems = parseData(categories);
    buildPool();
    document.querySelectorAll('.sub-pills').forEach(updateZoneCompletionState);
  } catch (error) {
    buildGrid([]);
    renderPoolMessage('Unable to load the selected unit.');
    showError(`Could not load the selected unit data. ${error.message}`);
  }
}

bindUi();
void initializeCatalog();
