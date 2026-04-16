const DATA_MANIFEST_PATH = './data/manifest.json';
const ALL_UNITS_OPTION = 'all-units';
const META_KEYS = new Set(['id', 'label', 'unitName', 'prefilledSections']);

const POOL_GROUPS = [
  {
    poolLabel: 'Signs Of Toxicity',
    keys: ['signs of toxicity - early', 'signs of toxicity - late'],
  },
];

const POOL_SECTION_ORDER = [
  'Drugs', 'Mechanism', 'Targets', 'Onset', 'Side Effects',
  'Risks', 'Signs Of Toxicity', 'Signs', 'Notes',
];

const elements = {
  errorBanner: document.getElementById('error-banner'),
  grid: document.getElementById('grid'),
  pool: document.getElementById('pool'),
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
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function poolLabelFor(key) {
  const group = POOL_GROUPS.find(entry => entry.keys.includes(key));
  return group ? group.poolLabel : keyToLabel(key);
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

function resetState() {
  allItems = [];
  placedLog = {};
  draggingId = null;
  selectedPill = null;
  elements.resetBtn.style.display = 'none';
  document.querySelectorAll('.category').forEach(category => category.classList.remove('win-flicker'));
}

function bindUi() {
  elements.resetBtn.addEventListener('click', () => {
    void initGame();
  });

  elements.unitSelect.addEventListener('change', () => {
    void initGame();
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
      .map((table, index) => normalizeTableCategory(table, displayUnitName, unitSlug, index))
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

function normalizeTableCategory(table, unitName, unitSlug, index) {
  const label = String(table.table_name || table.name || `Table ${index + 1}`).trim();
  const normalized = {
    id: `${unitSlug}-${slugify(label || `table-${index + 1}`)}`,
    label: label || `Table ${index + 1}`,
    unitName,
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

  return subsectionsFor(normalized).length ? normalized : null;
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
    return trimmed || null;
  }

  if (typeof entry === 'number' || typeof entry === 'boolean') {
    return String(entry);
  }

  if (Array.isArray(entry)) {
    const flattened = entry.map(formatInlineValue).filter(Boolean).join(' | ');
    return flattened || null;
  }

  if (typeof entry === 'object') {
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
  const nameValue = redundantNameRowValue(category);
  if (!nameValue) {
    return { ...category };
  }

  const preparedCategory = {
    ...category,
    label: nameValue,
  };

  delete preparedCategory.Name;
  delete preparedCategory.prefilledSections;

  return preparedCategory;
}

function isPrefilledSection(category, key) {
  return Boolean(category.prefilledSections && category.prefilledSections[key]);
}

function parseData(categories) {
  const itemMap = {};

  function addItem(label, hint, typeId, typeKey, poolLabel, categoryId, parentId) {
    const itemKey = `${label.toLowerCase()}|${typeId}` + (parentId ? `|child-of-${parentId}` : '');
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
        if (typeof rawEntry === 'string') {
          const match = rawEntry.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
          const label = match ? match[1].trim() : rawEntry.trim();
          const hint = match ? match[2].trim() : null;
          addItem(label, hint, subsection.id, subsection.key, poolLabelFor(subsection.key), category.id, null);
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
                const match = typeof childRaw === 'string' && childRaw.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
                const childLabel = match ? match[1].trim() : String(childRaw).trim();
                const childHint = match ? match[2].trim() : null;
                const childId = addItem(
                  childLabel,
                  childHint,
                  nestedTypeId,
                  nestedKey,
                  nestedTypeLabel,
                  category.id,
                  parentId
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

    const subsectionsHtml = subsectionsFor(category)
      .map(subsection => `
        <div class="subsection">
          <div class="sub-label">${subsection.label}</div>
          <div class="sub-pills"
               id="pills-${category.id}-${subsection.id}"
               data-cat="${category.id}"
               data-sub="${subsection.id}"></div>
        </div>
      `)
      .join('');

    box.innerHTML = `<div class="cat-title">${category.label}</div>${subsectionsHtml}`;
    elements.grid.appendChild(box);
    applyPrefilledSections(category);
  });

  attachDropZoneListeners();
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

    entries.forEach(entry => {
      const placed = document.createElement('span');
      placed.className = 'placed-pill';
      placed.textContent = entry;
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

  if (zone.dataset.prefilled === 'true') {
    zone.classList.add('complete');
    return;
  }

  const categoryId = zone.dataset.cat;
  const subsectionId = zone.dataset.sub;
  const parentItemId = zone.dataset.parentItemId || null;
  const expected = expectedCountForZone(categoryId, subsectionId, parentItemId);
  const placed = countPlacedInZone(zone);

  zone.classList.toggle('complete', expected > 0 && placed >= expected);
}

function attachDropZoneListeners() {
  document.querySelectorAll('.sub-pills').forEach(zone => {
    if (zone.dataset.listenersAttached) {
      return;
    }

    zone.dataset.listenersAttached = 'true';

    zone.addEventListener('dragover', event => {
      event.preventDefault();
      event.stopPropagation();
      zone.classList.add('drag-over');
    });

    zone.addEventListener('dragleave', () => {
      zone.classList.remove('drag-over');
    });

    zone.addEventListener('drop', event => {
      event.preventDefault();
      event.stopPropagation();
      zone.classList.remove('drag-over');
      handleDrop(zone.dataset.cat, zone.dataset.sub, zone.dataset.parentItemId || null);
    });

    zone.addEventListener('click', event => {
      event.stopPropagation();

      if (!isMobile() || !selectedPill) {
        return;
      }

      document.querySelectorAll('.sub-pills').forEach(dropZone => dropZone.classList.remove('tap-target'));
      selectedPill.classList.remove('tap-selected');
      handleDrop(zone.dataset.cat, zone.dataset.sub, zone.dataset.parentItemId || null);
      selectedPill = null;
    });
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
    const leftIndex = POOL_SECTION_ORDER.indexOf(leftLabel);
    const rightIndex = POOL_SECTION_ORDER.indexOf(rightLabel);
    return (leftIndex === -1 ? Number.POSITIVE_INFINITY : leftIndex)
      - (rightIndex === -1 ? Number.POSITIVE_INFINITY : rightIndex);
  });

  if (!sections.length) {
    renderPoolMessage('No study items in this unit yet.');
    return;
  }

  sections.forEach(([label, items]) => {
    const section = document.createElement('div');
    section.className = 'pool-section';
    section.innerHTML = `<div class="pool-section-label">${label}</div>`;

    const row = document.createElement('div');
    row.className = 'pool-row';
    shuffle(items).forEach(item => row.appendChild(makePill(item)));

    section.appendChild(row);
    elements.pool.appendChild(section);
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
    draggingId = item.id;
  });

  pill.addEventListener('dragend', () => {
    draggingId = null;
  });

  pill.addEventListener('click', () => {
    if (!isMobile()) {
      return;
    }

    if (selectedPill === pill) {
      pill.classList.remove('tap-selected');
      selectedPill = null;
      return;
    }

    if (selectedPill) {
      selectedPill.classList.remove('tap-selected');
    }

    selectedPill = pill;
    draggingId = item.id;
    pill.classList.add('tap-selected');
    document.querySelectorAll('.sub-pills').forEach(zone => zone.classList.add('tap-target'));
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
  placed.innerHTML = item.hint
    ? `${item.label} <span class="hint">(${item.hint})</span>`
    : item.label;

  const zoneId = parentItemId
    ? `nested-${categoryId}-${subsectionId}-${parentItemId}`
    : `pills-${categoryId}-${subsectionId}`;
  const zone = document.getElementById(zoneId);

  if (zone) {
    zone.appendChild(placed);
    updateZoneCompletionState(zone);
  }

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

  checkComplete();
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
  startWinAnimation();
}

function startWinAnimation() {
  document.querySelectorAll('.category').forEach(category => {
    category.style.animationDelay = `${(Math.random() * 1.5).toFixed(2)}s`;
    category.style.animationDuration = `${(2.5 + Math.random() * 1.5).toFixed(2)}s`;
    category.classList.add('win-flicker');
  });
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
