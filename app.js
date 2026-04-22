const DATA_MANIFEST_PATH = './data/manifest.json';
const ALL_UNITS_OPTION = 'all-units';
const ALL_SECTIONS_OPTION = 'all-sections';
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
const CARD_COMPLETION_ANIMATION_MS = 1050;

const elements = {
  errorBanner: document.getElementById('error-banner'),
  grid: document.getElementById('grid'),
  gridWrapper: document.querySelector('.grid-wrapper'),
  pool: document.getElementById('pool'),
  poolContent: document.getElementById('pool-content'),
  poolToggleAll: document.getElementById('pool-toggle-all'),
  poolWrapper: document.querySelector('.pool-wrapper'),
  resetBtn: document.getElementById('reset-btn'),
  settingsActionRestart: document.getElementById('settings-restart'),
  settingsActionSolve: document.getElementById('settings-solve'),
  settingsBtn: document.getElementById('settings-btn'),
  settingsClose: document.getElementById('settings-close'),
  settingsSectionList: document.getElementById('settings-section-list'),
  settingsModal: document.getElementById('settings-modal'),
  unitPickerButton: document.getElementById('unit-picker-button'),
  unitPickerList: document.getElementById('unit-picker-list'),
  unitPickerMenu: document.getElementById('unit-picker-menu'),
};

const TRANSIENT_CARD_OPEN_CLASSES = ['card-hover-open', 'card-drag-hover', 'card-post-drop-open'];

let allItems = [];
let baseCategories = [];
let collapsedPoolSections = new Set();
let enabledSectionKeys = new Set();
let enabledUnitIds = new Set();
let placedLog = {};
let sectionOptions = [];
let draggingId = null;
let selectedPill = null;
let suppressCompletionAnimation = false;
let unitCatalog = [];
let unitCache = new Map();

const completionAnimationHandles = new WeakMap();

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

function lockedPoolLabelStates() {
  const states = new Map();

  document.querySelectorAll('.category.card-locked').forEach(card => {
    card.querySelectorAll('.subsection[data-key]').forEach(subsection => {
      const key = subsection.dataset.key;
      if (!key || subsection.classList.contains('prefilled-name-section')) {
        return;
      }

      const poolLabel = poolLabelFor(key);
      if (!states.has(poolLabel)) {
        states.set(poolLabel, { hasIncomplete: false, hasComplete: false });
      }

      const state = states.get(poolLabel);
      if (subsection.classList.contains('subsection-complete')) {
        state.hasComplete = true;
      } else {
        state.hasIncomplete = true;
      }
    });
  });

  return states;
}

function updatePoolLockedSectionMarkers() {
  const lockedStates = lockedPoolLabelStates();

  document.querySelectorAll('.pool-section').forEach(section => {
    const poolLabel = section.dataset.poolLabel;
    const state = poolLabel ? lockedStates.get(poolLabel) : null;
    const hasIncomplete = Boolean(state?.hasIncomplete);

    section.classList.toggle('pool-section-has-locked-card', hasIncomplete);
    section.classList.remove('pool-section-locked-complete');
  });

  return lockedStates;
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
  if (elements.poolContent) {
    elements.poolContent.innerHTML = `<div class="empty-state">${message}</div>`;
  }
  updatePoolToggleAllButton();
}

function renderGridMessage(message) {
  elements.grid.innerHTML = `<div class="category"><div class="cat-title">${message}</div></div>`;
}

function resetState({ preserveProgress = false } = {}) {
  allItems = [];
  if (!preserveProgress) {
    placedLog = {};
  }
  draggingId = null;
  selectedPill = null;
  elements.resetBtn.style.display = 'none';
}

function closeSettingsModal() {
  if (!elements.settingsModal) {
    return;
  }

  elements.settingsModal.classList.remove('open');
  elements.settingsModal.hidden = true;
}

function openSettingsModal() {
  if (!elements.settingsModal) {
    return;
  }

  elements.settingsModal.hidden = false;
  elements.settingsModal.classList.add('open');
}

function closeUnitPickerMenu() {
  if (!elements.unitPickerMenu || !elements.unitPickerButton) {
    return;
  }

  elements.unitPickerMenu.hidden = true;
  elements.unitPickerButton.setAttribute('aria-expanded', 'false');
  elements.unitPickerButton.parentElement?.classList.remove('open');
}

function openUnitPickerMenu() {
  if (!elements.unitPickerMenu || !elements.unitPickerButton || elements.unitPickerButton.disabled) {
    return;
  }

  elements.unitPickerMenu.hidden = false;
  elements.unitPickerButton.setAttribute('aria-expanded', 'true');
  elements.unitPickerButton.parentElement?.classList.add('open');
}

function selectedUnits() {
  return unitCatalog.filter(unit => enabledUnitIds.has(unit.id));
}

function allUnitsSelected() {
  return unitCatalog.length > 0 && enabledUnitIds.size === unitCatalog.length;
}

function groupedUnitsMode() {
  return selectedUnits().length > 1;
}

function unitPickerLabel() {
  if (!unitCatalog.length) {
    return 'No Units Loaded';
  }

  if (allUnitsSelected()) {
    return 'All Units';
  }

  const selected = selectedUnits();
  if (!selected.length) {
    return 'No Units';
  }

  if (selected.length === 1) {
    return selected[0].name;
  }

  return `${selected.length} Units`;
}

function syncUnitFilters(preserveSelection = false) {
  const previousEnabledIds = new Set(enabledUnitIds);
  enabledUnitIds = new Set();

  unitCatalog.forEach(unit => {
    if (!preserveSelection || previousEnabledIds.size === 0 || previousEnabledIds.has(unit.id)) {
      enabledUnitIds.add(unit.id);
    }
  });
}

function renderUnitPicker() {
  if (!elements.unitPickerButton || !elements.unitPickerList) {
    return;
  }

  if (!unitCatalog.length) {
    elements.unitPickerButton.textContent = 'No Units Loaded';
    elements.unitPickerButton.disabled = true;
    elements.unitPickerList.innerHTML = '<div class="picker-empty-state">No units loaded</div>';
    closeUnitPickerMenu();
    return;
  }

  elements.unitPickerButton.disabled = false;
  elements.unitPickerButton.textContent = unitPickerLabel();

  const selectedCount = enabledUnitIds.size;
  const allChecked = allUnitsSelected();
  const anyChecked = selectedCount > 0;

  elements.unitPickerList.innerHTML = [
    `
      <label class="picker-option picker-option-master">
        <input type="checkbox" data-unit-id="${ALL_UNITS_OPTION}" ${allChecked ? 'checked' : ''}>
        <span>All Units</span>
      </label>
    `,
    '<div class="picker-spacer" aria-hidden="true"></div>',
    ...unitCatalog.map(unit => `
      <label class="picker-option">
        <input type="checkbox" data-unit-id="${unit.id}" ${enabledUnitIds.has(unit.id) ? 'checked' : ''}>
        <span>${unit.name}</span>
      </label>
    `),
  ].join('');

  const allUnitsInput = elements.unitPickerList.querySelector(`input[data-unit-id="${ALL_UNITS_OPTION}"]`);
  if (allUnitsInput) {
    allUnitsInput.indeterminate = anyChecked && !allChecked;
  }
}

function playableSubsectionsFor(category) {
  return subsectionsFor(category).filter(subsection => subsection.key !== 'Name');
}

function deriveSectionOptions(categories) {
  const sectionMap = new Map();

  categories.forEach(category => {
    playableSubsectionsFor(category).forEach(subsection => {
      const poolLabel = poolLabelFor(subsection.key);

      if (!sectionMap.has(poolLabel)) {
        sectionMap.set(poolLabel, {
          key: poolLabel,
          label: poolLabel,
        });
      }
    });
  });

  return [...sectionMap.values()].sort((left, right) => {
    const leftRank = poolSectionRank(left.label);
    const rightRank = poolSectionRank(right.label);

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return left.label.localeCompare(right.label);
  });
}

function syncSectionFilters(options, preserveFilters = false) {
  const previousEnabledKeys = new Set(enabledSectionKeys);
  const previousOptionKeys = new Set(sectionOptions.map(option => option.key));

  enabledSectionKeys = new Set();

  options.forEach(option => {
    if (
      !preserveFilters ||
      previousEnabledKeys.size === 0 ||
      previousEnabledKeys.has(option.key) ||
      !previousOptionKeys.has(option.key)
    ) {
      enabledSectionKeys.add(option.key);
    }
  });
}

function filteredCategoriesFromSettings() {
  return baseCategories
    .map(category => {
      const filteredCategory = {};
      let hasPlayableSection = false;
      const hadPlayableSectionsOriginally = playableSubsectionsFor(category).length > 0;

      META_KEYS.forEach(key => {
        if (key === 'prefilledSections') {
          return;
        }

        if (key in category) {
          filteredCategory[key] = category[key];
        }
      });

      if (category.prefilledSections) {
        filteredCategory.prefilledSections = {};
      }

      Object.keys(category).forEach(key => {
        if (META_KEYS.has(key)) {
          return;
        }

        if (key === 'Name' && isPrefilledSection(category, key)) {
          filteredCategory[key] = category[key];
          filteredCategory.prefilledSections = filteredCategory.prefilledSections || {};
          filteredCategory.prefilledSections[key] = category.prefilledSections[key];
          return;
        }

        if (!enabledSectionKeys.has(poolLabelFor(key))) {
          return;
        }

        filteredCategory[key] = category[key];

        if (isPrefilledSection(category, key)) {
          filteredCategory.prefilledSections = filteredCategory.prefilledSections || {};
          filteredCategory.prefilledSections[key] = category.prefilledSections[key];
        } else {
          hasPlayableSection = true;
        }
      });

      if (filteredCategory.prefilledSections && !Object.keys(filteredCategory.prefilledSections).length) {
        delete filteredCategory.prefilledSections;
      }

      const stillHasAnySections = subsectionsFor(filteredCategory).length > 0;
      if (!stillHasAnySections) {
        return null;
      }

      return hasPlayableSection || !hadPlayableSectionsOriginally
        ? filteredCategory
        : null;
    })
    .filter(Boolean);
}

function renderSettingsPanel() {
  if (!elements.settingsSectionList) {
    return;
  }

  const hasRemainingPills = Boolean(elements.poolContent?.querySelector('.drug-pill'));
  elements.settingsActionRestart.disabled = baseCategories.length === 0;
  elements.settingsActionSolve.disabled = !hasRemainingPills;

  if (!sectionOptions.length) {
    elements.settingsSectionList.innerHTML = '<div class="settings-empty-state">No configurable sections.</div>';
    return;
  }

  const allSectionsChecked = enabledSectionKeys.size === sectionOptions.length;
  const anySectionsChecked = enabledSectionKeys.size > 0;

  elements.settingsSectionList.innerHTML = [
    `
      <label class="settings-section-option settings-section-option-master">
        <input
          type="checkbox"
          data-section-key="${ALL_SECTIONS_OPTION}"
          ${allSectionsChecked ? 'checked' : ''}
        >
        <span>All Sections</span>
      </label>
    `,
    '<div class="settings-section-spacer" aria-hidden="true"></div>',
    ...sectionOptions.map(option => `
      <label class="settings-section-option">
        <input
          type="checkbox"
          data-section-key="${option.key}"
          ${enabledSectionKeys.has(option.key) ? 'checked' : ''}
        >
        <span>${option.label}</span>
      </label>
    `),
  ].join('');

  const allSectionsInput = elements.settingsSectionList.querySelector(
    `input[data-section-key="${ALL_SECTIONS_OPTION}"]`
  );
  if (allSectionsInput) {
    allSectionsInput.indeterminate = anySectionsChecked && !allSectionsChecked;
  }
}

function renderCurrentGameFromState() {
  resetState({ preserveProgress: true });
  clearError();

  if (unitCatalog.length > 0 && enabledUnitIds.size === 0) {
    renderGridMessage('No units selected.');
    renderPoolMessage('No units selected.');
    renderSettingsPanel();
    return;
  }

  const categories = filteredCategoriesFromSettings();
  if (sectionOptions.length > 0 && !enabledSectionKeys.size) {
    renderGridMessage('No sections selected.');
    renderPoolMessage('No sections selected.');
    renderSettingsPanel();
    return;
  }

  if (!categories.length) {
    renderGridMessage('No active study cards in the selected sections.');
    renderPoolMessage('No study items in the selected sections.');
    renderSettingsPanel();
    return;
  }

  allItems = parseData(categories);
  buildGrid(categories);
  buildPool();

  suppressCompletionAnimation = true;
  try {
    reapplyCurrentProgress();
    document.querySelectorAll('.sub-pills').forEach(updateZoneCompletionState);
  } finally {
    suppressCompletionAnimation = false;
  }

  renderSettingsPanel();
}

function solveCurrentGame() {
  if (!allItems.length) {
    return;
  }

  suppressCompletionAnimation = true;

  try {
    if (selectedPill) {
      selectedPill.classList.remove('tap-selected');
      selectedPill = null;
    }

    clearTapTargets();
    clearDropZoneHints();

    const placements = allItems
      .flatMap(item => [...item.correctCats].map(categoryId => ({ item, categoryId })))
      .sort((left, right) => {
        const leftParentRank = left.item.parentId ? 1 : 0;
        const rightParentRank = right.item.parentId ? 1 : 0;
        if (leftParentRank !== rightParentRank) {
          return leftParentRank - rightParentRank;
        }

        const leftOrder = left.item.sortOrder ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = right.item.sortOrder ?? Number.MAX_SAFE_INTEGER;
        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }

        if (left.categoryId !== right.categoryId) {
          return left.categoryId.localeCompare(right.categoryId);
        }

        if (left.item.type !== right.item.type) {
          return left.item.type.localeCompare(right.item.type);
        }

        return left.item.label.localeCompare(right.item.label);
      });

    placements.forEach(({ item, categoryId }) => {
      draggingId = item.id;
      handleDrop(categoryId, item.type, item.parentId || null);
    });
  } finally {
    suppressCompletionAnimation = false;
  }

  draggingId = null;
  document.querySelectorAll('.category').forEach(card => {
    stripCardOpenState(card, { includeLock: true, suppressHover: false });
  });
  updateCompletedCardLayout();
}

function currentSlotKeysForItem(item) {
  return new Set(
    [...item.correctCats].map(categoryId => slotKeyFor(categoryId, item.type, item.parentId || null))
  );
}

function currentPlacedSlotsForItem(item) {
  const itemPlacements = placedLog[item.id];
  if (!itemPlacements) {
    return [];
  }

  const currentSlots = currentSlotKeysForItem(item);
  return [...itemPlacements].filter(slotKey => currentSlots.has(slotKey));
}

function parseSlotKey(slotKey) {
  const [categoryId, subsectionId, parentItemId] = String(slotKey).split('|');
  return {
    categoryId,
    subsectionId,
    parentItemId: parentItemId || null,
  };
}

function makePlacedPillElement(item, categoryId) {
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

  return placed;
}

function syncPoolWithCurrentProgress() {
  allItems.forEach(item => {
    const pill = document.getElementById(`pill-${item.id}`);
    if (!pill) {
      return;
    }

    const remaining = item.correctCats.size - currentPlacedSlotsForItem(item).length;
    if (remaining <= 0) {
      pill.remove();
      return;
    }

    const badge = pill.querySelector('.remaining-badge');
    if (badge) {
      badge.textContent = remaining;
    }
  });

  updatePoolSectionLayout();
}

function reapplyCurrentProgress() {
  const placements = allItems
    .flatMap(item =>
      currentPlacedSlotsForItem(item).map(slotKey => ({
        item,
        slotKey,
        ...parseSlotKey(slotKey),
      }))
    )
    .sort((left, right) => {
      const leftParentRank = left.item.parentId ? 1 : 0;
      const rightParentRank = right.item.parentId ? 1 : 0;
      if (leftParentRank !== rightParentRank) {
        return leftParentRank - rightParentRank;
      }

      const leftOrder = left.item.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.item.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }

      if (left.categoryId !== right.categoryId) {
        return left.categoryId.localeCompare(right.categoryId);
      }

      if (left.subsectionId !== right.subsectionId) {
        return left.subsectionId.localeCompare(right.subsectionId);
      }

      return left.item.label.localeCompare(right.item.label);
    });

  placements.forEach(({ item, categoryId, subsectionId, parentItemId }) => {
    const zoneId = parentItemId
      ? `nested-${categoryId}-${subsectionId}-${parentItemId}`
      : `pills-${categoryId}-${subsectionId}`;
    const zone = document.getElementById(zoneId);
    if (!zone) {
      return;
    }

    const placed = makePlacedPillElement(item, categoryId);
    insertPlacedPill(zone, placed, item.sortOrder);
    updateZoneCompletionState(zone);

    if (item.children.length) {
      revealChildren(item, categoryId);
    }
  });

  syncPoolWithCurrentProgress();
  checkComplete();
}

function bindUi() {
  elements.resetBtn.addEventListener('click', () => {
    void initGame({ preserveFilters: true, reusePreparedCategories: true, resetProgress: true });
  });

  elements.unitPickerButton?.addEventListener('click', event => {
    event.stopPropagation();

    if (elements.unitPickerMenu?.hidden) {
      openUnitPickerMenu();
    } else {
      closeUnitPickerMenu();
    }
  });

  elements.unitPickerList?.addEventListener('change', event => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    if (!input || input.type !== 'checkbox' || !input.dataset.unitId) {
      return;
    }

    if (input.dataset.unitId === ALL_UNITS_OPTION) {
      enabledUnitIds = input.checked
        ? new Set(unitCatalog.map(unit => unit.id))
        : new Set();
    } else if (input.checked) {
      enabledUnitIds.add(input.dataset.unitId);
    } else {
      enabledUnitIds.delete(input.dataset.unitId);
    }

    renderUnitPicker();
    void initGame();
  });

  window.addEventListener('resize', () => {
    if (elements.grid.querySelector('.category')) {
      updateCompletedCardLayout();
    }
  });

  elements.settingsBtn?.addEventListener('click', () => {
    closeUnitPickerMenu();
    openSettingsModal();
  });

  elements.settingsActionSolve?.addEventListener('click', () => {
    solveCurrentGame();
    renderSettingsPanel();
  });

  elements.settingsActionRestart?.addEventListener('click', () => {
    void initGame({ preserveFilters: true, reusePreparedCategories: true, resetProgress: true });
  });

  elements.settingsClose?.addEventListener('click', () => {
    closeSettingsModal();
  });

  elements.pool?.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('.pool-section-label') : null;
    if (!button) {
      return;
    }

    event.stopPropagation();
    togglePoolSection(button.closest('.pool-section'));
  });

  elements.poolToggleAll?.addEventListener('click', () => {
    toggleAllPoolSections();
  });

  elements.settingsSectionList?.addEventListener('change', event => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    if (!input || input.type !== 'checkbox' || !input.dataset.sectionKey) {
      return;
    }

    if (input.dataset.sectionKey === ALL_SECTIONS_OPTION) {
      enabledSectionKeys = input.checked
        ? new Set(sectionOptions.map(option => option.key))
        : new Set();
    } else if (input.checked) {
      enabledSectionKeys.add(input.dataset.sectionKey);
    } else {
      enabledSectionKeys.delete(input.dataset.sectionKey);
    }

    renderCurrentGameFromState();
  });

  elements.settingsModal?.addEventListener('click', event => {
    if (event.target === elements.settingsModal) {
      closeSettingsModal();
    }
  });

  document.addEventListener('mousemove', event => {
    syncHoverOpenCards(event.target);
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeUnitPickerMenu();
      closeSettingsModal();
    }
  });

  document.addEventListener('click', event => {
    if (!(event.target instanceof Element)) {
      closeUnitPickerMenu();
      return;
    }

    if (!event.target.closest('.picker-control')) {
      closeUnitPickerMenu();
    }
  });

  window.addEventListener('blur', () => {
    closeUnitPickerMenu();
    clearHoverOpenCards();
  });
}

async function initializeCatalog() {
  if (elements.unitPickerButton) {
    elements.unitPickerButton.disabled = true;
    elements.unitPickerButton.textContent = 'Loading units...';
  }

  try {
    const remoteUnits = await fetchRemoteCatalog();
    applyUnitCatalog(remoteUnits);
    clearError();
    await initGame();
  } catch (error) {
    unitCatalog = [];
    unitCache = new Map();
    enabledUnitIds = new Set();
    renderUnitPicker();
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

function applyUnitCatalog(units, preserveSelection = false) {
  unitCatalog = units;
  unitCache = new Map();
  syncUnitFilters(preserveSelection);
  renderUnitPicker();
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

  const activeUnits = selectedUnits();
  if (!activeUnits.length) {
    return [];
  }

  if (activeUnits.length === 1) {
    const categories = await loadUnitCategories(activeUnits[0]);
    return categories.map(prepareCategoryForSingleUnit);
  }

  const bundles = await Promise.all(activeUnits.map(unit => loadUnitCategories(unit)));
  return bundles.flat().map(prepareCategoryForAllUnits);
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
    box.dataset.unitName = category.unitName || '';

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
               data-sub="${subsection.id}"
               data-pool-label="${poolLabelFor(subsection.key)}"></div>
        </div>
      `)
      .join('');
    const placeholderBodyHtml = !bodySubsections.length
      ? `
        <div class="subsection placeholder-subsection subsection-complete">
          <div class="sub-pills complete placeholder-status" data-prefilled="true">
            <span class="placed-pill placeholder-pill">Not Finished</span>
          </div>
        </div>
      `
      : '';

    box.innerHTML = `
      <div class="card-summary">
        ${titleHtml}
        ${nameHeaderHtml}
      </div>
      <div class="card-body">${bodyHtml || placeholderBodyHtml}</div>
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
  const shouldAutoCollapsePoolSection = hasLockedCards();

  if (zone.dataset.prefilled === 'true') {
    zone.classList.add('complete');
    subsection?.classList.add('subsection-complete');
    updateCardCompletionState(zone.closest('.category'));
    const lockedStates = updatePoolLockedSectionMarkers();
    if (shouldAutoCollapsePoolSection && subsection?.dataset.key) {
      const poolLabel = poolLabelFor(subsection.dataset.key);
      const labelState = lockedStates.get(poolLabel);
      if (!labelState?.hasIncomplete) {
        collapsePoolSectionByLabel(poolLabel);
        updatePoolToggleAllButton();
      }
    }
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
  const lockedStates = updatePoolLockedSectionMarkers();

  if (shouldAutoCollapsePoolSection && isComplete && subsection?.dataset.key) {
    const poolLabel = poolLabelFor(subsection.dataset.key);
    const labelState = lockedStates.get(poolLabel);
    if (!labelState?.hasIncomplete) {
      collapsePoolSectionByLabel(poolLabel);
      updatePoolToggleAllButton();
    }
  }
}

function cancelPendingCardCompletion(card) {
  if (!card) {
    return false;
  }

  const pendingHandles = completionAnimationHandles.get(card);
  if (pendingHandles) {
    if (pendingHandles.timeoutId) {
      window.clearTimeout(pendingHandles.timeoutId);
    }

    if (pendingHandles.animations) {
      pendingHandles.animations.forEach(animation => {
        try {
          animation.cancel();
        } catch (error) {
          // Ignore stale animation handles.
        }
      });
    }

    completionAnimationHandles.delete(card);
  }

  if (!card.classList.contains('card-completing')) {
    return false;
  }

  card.classList.remove('card-completing');
  return true;
}

function playCardCompletionAnimations(card) {
  if (
    !card ||
    !card.isConnected ||
    !card.classList.contains('card-completing') ||
    typeof card.animate !== 'function'
  ) {
    return [];
  }

  const animations = [];

  animations.push(card.animate(
    [
      {
        borderColor: '#2d6f8e',
        boxShadow: '0 0 14px rgba(127, 219, 255, 0.12), inset 0 0 20px rgba(0, 0, 0, 0.45)',
        filter: 'brightness(1)',
        transform: 'scale(1)',
      },
      {
        borderColor: '#7fdbff',
        boxShadow: '0 0 32px rgba(127, 219, 255, 0.46), inset 0 0 30px rgba(127, 219, 255, 0.12)',
        filter: 'brightness(1.38)',
        transform: 'scale(1.02)',
        offset: 0.14,
      },
      {
        borderColor: '#2d6f8e',
        boxShadow: '0 0 14px rgba(127, 219, 255, 0.12), inset 0 0 20px rgba(0, 0, 0, 0.45)',
        filter: 'brightness(1)',
        transform: 'scale(1)',
        offset: 0.28,
      },
      {
        borderColor: '#7fdbff',
        boxShadow: '0 0 32px rgba(127, 219, 255, 0.46), inset 0 0 30px rgba(127, 219, 255, 0.12)',
        filter: 'brightness(1.38)',
        transform: 'scale(1.02)',
        offset: 0.48,
      },
      {
        borderColor: '#2d6f8e',
        boxShadow: '0 0 14px rgba(127, 219, 255, 0.12), inset 0 0 20px rgba(0, 0, 0, 0.45)',
        filter: 'brightness(1)',
        transform: 'scale(1)',
        offset: 0.62,
      },
      {
        borderColor: '#7fdbff',
        boxShadow: '0 0 32px rgba(127, 219, 255, 0.46), inset 0 0 30px rgba(127, 219, 255, 0.12)',
        filter: 'brightness(1.38)',
        transform: 'scale(1.02)',
        offset: 0.82,
      },
      {
        borderColor: '#7fdbff',
        boxShadow: '0 0 32px rgba(127, 219, 255, 0.46), inset 0 0 30px rgba(127, 219, 255, 0.12)',
        filter: 'brightness(1.22)',
        transform: 'scale(1)',
      },
    ],
    {
      duration: CARD_COMPLETION_ANIMATION_MS,
      easing: 'ease-in-out',
      fill: 'forwards',
    }
  ));

  card.querySelectorAll('.cat-title, .sub-pills.prefilled-name .placed-pill').forEach(element => {
    if (typeof element.animate !== 'function') {
      return;
    }

    animations.push(element.animate(
      [
        { color: '#d8f9ff', textShadow: 'none', filter: 'brightness(1)' },
        { color: '#a7ebff', textShadow: '0 0 14px #7fdbff', filter: 'brightness(1.4)', offset: 0.14 },
        { color: '#d8f9ff', textShadow: 'none', filter: 'brightness(1)', offset: 0.28 },
        { color: '#a7ebff', textShadow: '0 0 14px #7fdbff', filter: 'brightness(1.4)', offset: 0.48 },
        { color: '#d8f9ff', textShadow: 'none', filter: 'brightness(1)', offset: 0.62 },
        { color: '#a7ebff', textShadow: '0 0 14px #7fdbff', filter: 'brightness(1.4)', offset: 0.82 },
        { color: '#a7ebff', textShadow: '0 0 10px #7fdbff', filter: 'brightness(1.2)' },
      ],
      {
        duration: CARD_COMPLETION_ANIMATION_MS,
        easing: 'ease-in-out',
        fill: 'forwards',
      }
    ));
  });

  return animations;
}

function finishCardCompletion(card) {
  if (!card) {
    return;
  }

  const pendingHandles = completionAnimationHandles.get(card);
  if (pendingHandles) {
    if (pendingHandles.timeoutId) {
      window.clearTimeout(pendingHandles.timeoutId);
    }

    if (pendingHandles.animations) {
      pendingHandles.animations.forEach(animation => {
        try {
          animation.cancel();
        } catch (error) {
          // Ignore stale animation handles.
        }
      });
    }

    completionAnimationHandles.delete(card);
  }

  if (!card.isConnected) {
    return;
  }

  if (!card.classList.contains('card-completing')) {
    return;
  }

  card.classList.remove('card-completing');
  card.classList.add('card-complete');
  updateCompletedCardLayout();
}

function beginCardCompletion(card) {
  if (!card || card.classList.contains('card-complete') || card.classList.contains('card-completing')) {
    return;
  }

  stripCardOpenState(card, { includeLock: true, suppressHover: false });

  if (suppressCompletionAnimation) {
    card.classList.add('card-complete');
    updateCompletedCardLayout();
    return;
  }

  card.classList.add('card-completing');
  updateCompletedCardLayout();

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const activeHandles = completionAnimationHandles.get(card);
      if (!activeHandles || !card.classList.contains('card-completing')) {
        return;
      }

      const animations = playCardCompletionAnimations(card);
      activeHandles.animations = animations;

      if (animations.length) {
        Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
          if (completionAnimationHandles.get(card) === activeHandles) {
            finishCardCompletion(card);
          }
        });
      }
    });
  });

  const timeoutId = window.setTimeout(() => {
    finishCardCompletion(card);
  }, CARD_COMPLETION_ANIMATION_MS + 160);

  completionAnimationHandles.set(card, { timeoutId, animations: [] });
}

function updateCardCompletionState(card) {
  if (!card) {
    return;
  }

  const zones = [...card.querySelectorAll('.sub-pills')];
  const actionableZones = zones.filter(zone => zone.dataset.prefilled !== 'true');
  const isComplete =
    actionableZones.length > 0 &&
    actionableZones.every(zone => zone.classList.contains('complete'));
  const wasComplete = card.classList.contains('card-complete');
  const wasCompleting = card.classList.contains('card-completing');

  if (isComplete) {
    if (!wasComplete && !wasCompleting) {
      beginCardCompletion(card);
    }
    return;
  }

  let changed = false;
  if (cancelPendingCardCompletion(card)) {
    changed = true;
  }

  if (wasComplete) {
    card.classList.remove('card-complete');
    changed = true;
  }

  if (changed) {
    updateCompletedCardLayout();
  }
}

function gridColumnCount() {
  const availableWidth = elements.gridWrapper?.clientWidth || window.innerWidth;

  if (availableWidth >= 1180) {
    return 5;
  }

  if (availableWidth >= 860) {
    return 4;
  }

  return 3;
}

function buildGridBand(cards, bandClassName, columnCount, preserveEmptyColumns = false) {
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
    .filter(column => preserveEmptyColumns || column.children.length > 0)
    .forEach(column => band.appendChild(column));

  return band;
}

function createGridDivider(label, className = '') {
  const divider = document.createElement('div');
  divider.className = `grid-divider ${className}`.trim();
  divider.innerHTML = `<span>${label}</span>`;
  return divider;
}

function cardsSortedByInitialIndex(cards) {
  return [...cards].sort(
    (leftCard, rightCard) =>
      (Number(leftCard.dataset.initialIndex) || 0) - (Number(rightCard.dataset.initialIndex) || 0)
  );
}

function groupedCardsByUnit(cards) {
  const groups = [];
  const groupMap = new Map();

  cardsSortedByInitialIndex(cards).forEach(card => {
    const unitName = card.dataset.unitName || 'Unit';

    if (!groupMap.has(unitName)) {
      const group = { unitName, cards: [] };
      groupMap.set(unitName, group);
      groups.push(group);
    }

    groupMap.get(unitName).cards.push(card);
  });

  return groups;
}

function stripCardOpenState(card, { includeLock = false, suppressHover = null } = {}) {
  if (!card) {
    return false;
  }

  let changed = false;

  TRANSIENT_CARD_OPEN_CLASSES.forEach(className => {
    if (card.classList.contains(className)) {
      card.classList.remove(className);
      changed = true;
    }
  });

  if (includeLock && card.classList.contains('card-locked')) {
    card.classList.remove('card-locked');
    changed = true;
  }

  if (suppressHover === true && !card.classList.contains('card-hover-suppressed')) {
    card.classList.add('card-hover-suppressed');
    changed = true;
  }

  if (suppressHover === false && card.classList.contains('card-hover-suppressed')) {
    card.classList.remove('card-hover-suppressed');
    changed = true;
  }

  return changed;
}

function closeOtherCards(exceptCard = null) {
  let changed = false;

  document.querySelectorAll('.category').forEach(card => {
    if (card === exceptCard || card.classList.contains('card-locked')) {
      return;
    }

    if (stripCardOpenState(card)) {
      changed = true;
    }
  });

  return changed;
}

function setTransientCardOpenState(card, className) {
  if (!card || card.classList.contains('card-locked')) {
    return;
  }

  let changed = closeOtherCards(card);

  TRANSIENT_CARD_OPEN_CLASSES.forEach(otherClassName => {
    if (otherClassName !== className && card.classList.contains(otherClassName)) {
      card.classList.remove(otherClassName);
      changed = true;
    }
  });

  if (!card.classList.contains(className)) {
    card.classList.add(className);
    changed = true;
  }

  if (changed) {
    updateCompletedCardLayout();
  }
}

function hasLockedCards() {
  return Boolean(document.querySelector('.category.card-locked'));
}

function toggleCardLock(card) {
  if (!card) {
    return;
  }

  const willLock = !card.classList.contains('card-locked');
  let changed = closeOtherCards(willLock ? card : null);

  if (willLock) {
    if (!card.classList.contains('card-locked')) {
      card.classList.add('card-locked');
      changed = true;
    }

    if (stripCardOpenState(card, { suppressHover: false })) {
      changed = true;
    }
  } else {
    if (card.classList.contains('card-locked')) {
      card.classList.remove('card-locked');
      changed = true;
    }

    if (stripCardOpenState(card, { suppressHover: true })) {
      changed = true;
    }
  }

  if (changed) {
    updateCompletedCardLayout();
  }
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
  const incompleteCards = cards.filter(card => !card.classList.contains('card-complete') || card.classList.contains('card-completing'));
  const completedCards = cards.filter(card => card.classList.contains('card-complete') && !card.classList.contains('card-completing'));
  const isAllUnitsMode = groupedUnitsMode();
  const preserveColumnSlots = isAllUnitsMode || (incompleteCards.length > 0 && completedCards.length > 0);

  grid.innerHTML = '';

  if (isAllUnitsMode && incompleteCards.length) {
    groupedCardsByUnit(incompleteCards).forEach(group => {
      grid.appendChild(createGridDivider(group.unitName, 'unit-divider'));
      const unitBand = buildGridBand(group.cards, 'grid-band-active', columnCount, true);
      if (unitBand) {
        grid.appendChild(unitBand);
      }
    });
  } else {
    const incompleteBand = buildGridBand(incompleteCards, 'grid-band-active', columnCount, preserveColumnSlots);
    if (incompleteBand) {
      grid.appendChild(incompleteBand);
    }
  }

  if (completedCards.length) {
    const completedBand = buildGridBand(completedCards, 'grid-band-completed', columnCount, preserveColumnSlots);
    grid.appendChild(createGridDivider('Completed', 'completed-divider'));
    grid.appendChild(completedBand);
  }

  normalizeCardSummaryHeights();
  updatePoolLockedSectionMarkers();
}

function normalizeCardSummaryHeights() {
  const summaries = [...elements.grid.querySelectorAll('.category .card-summary')];
  if (!summaries.length) {
    return;
  }

  summaries.forEach(summary => {
    summary.style.minHeight = '';
  });

  const tallestSummary = summaries.reduce((maxHeight, summary) => {
    return Math.max(maxHeight, Math.ceil(summary.getBoundingClientRect().height));
  }, 0);

  if (!tallestSummary) {
    return;
  }

  summaries.forEach(summary => {
    summary.style.minHeight = `${tallestSummary}px`;
  });
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
  const hoveredColumn = target instanceof Element ? target.closest('.grid-column') : null;
  const hoverOpeningDisabled = hasLockedCards();
  let changed = false;

  document.querySelectorAll('.category.card-hover-open').forEach(card => {
    if (hoverOpeningDisabled || card !== hoveredCard) {
      card.classList.remove('card-hover-open');
      changed = true;
    }
  });

  document.querySelectorAll('.category.card-post-drop-open').forEach(card => {
    if (card.classList.contains('card-locked')) {
      return;
    }

    const cardColumn = card.closest('.grid-column');
    if (cardColumn !== hoveredColumn) {
      card.classList.remove('card-post-drop-open');
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
  document.querySelectorAll('.category.card-hover-suppressed').forEach(card => {
    card.classList.remove('card-hover-suppressed');
  });

  document.querySelectorAll('.category.card-drag-hover').forEach(card => {
    card.classList.remove('card-drag-hover');
    changed = true;
  });

  if (changed) {
    updateCompletedCardLayout();
  }
}

function markCardOpenAfterPlacement(card) {
  if (
    !card ||
    card.classList.contains('card-locked') ||
    card.classList.contains('card-complete') ||
    card.classList.contains('card-completing')
  ) {
    return;
  }

  setTransientCardOpenState(card, 'card-post-drop-open');
}

function expandCardForDrag(card) {
  if (!card || !draggingId || isMobile() || card.classList.contains('card-completing')) {
    return;
  }

  setTransientCardOpenState(card, 'card-drag-hover');
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
      if (
        isMobile() ||
        hasLockedCards() ||
        card.classList.contains('card-completing') ||
        card.classList.contains('card-locked') ||
        card.classList.contains('card-hover-open') ||
        card.classList.contains('card-hover-suppressed')
      ) {
        return;
      }

      setTransientCardOpenState(card, 'card-hover-open');
    });

    card.addEventListener('mouseleave', () => {
      const hadHoverOpen = card.classList.contains('card-hover-open');
      const hadHoverSuppressed = card.classList.contains('card-hover-suppressed');
      if (!hadHoverOpen && !hadHoverSuppressed) {
        return;
      }

      card.classList.remove('card-hover-open');
      card.classList.remove('card-hover-suppressed');
      updateCompletedCardLayout();
    });

    summary.addEventListener('click', event => {
      event.stopPropagation();

      if (card.classList.contains('card-completing')) {
        return;
      }

      if (card.classList.contains('card-post-drop-open') && !card.classList.contains('card-locked')) {
        stripCardOpenState(card, { suppressHover: true });
        updateCompletedCardLayout();
        return;
      }

      if (selectedPill) {
        if (card.classList.contains('card-locked') || isCardOpen(card)) {
          toggleCardLock(card);
        } else {
          setTransientCardOpenState(card, 'card-hover-open');
        }
        return;
      }

      toggleCardLock(card);
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
  if (!elements.poolContent) {
    return;
  }

  elements.poolContent.innerHTML = '';

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

  collapsedPoolSections = new Set(sections.map(([label]) => label));

  sections.forEach(([label, items], index) => {
    const section = document.createElement('div');
    section.className = 'pool-section';
    section.dataset.baseOrder = String(index);
    section.dataset.poolLabel = label;
    section.classList.toggle('pool-section-collapsed', collapsedPoolSections.has(label));
    section.innerHTML = `
      <button type="button" class="pool-section-label" aria-expanded="${collapsedPoolSections.has(label) ? 'false' : 'true'}">
        <span class="pool-section-label-text">${label}</span>
      </button>
    `;

    const row = document.createElement('div');
    row.className = 'pool-row';
    shuffle(items).forEach(item => row.appendChild(makePill(item)));

    section.appendChild(row);
    elements.poolContent.appendChild(section);
  });

  updatePoolSectionLayout();
  updatePoolToggleAllButton();
  updatePoolLockedSectionMarkers();
}

function updatePoolSectionLayout() {
  const sections = [...elements.poolContent.querySelectorAll('.pool-section')];
  const offset = sections.length + 1;

  sections.forEach((section, index) => {
    const baseOrder = Number(section.dataset.baseOrder) || index;
    const hasPills = Boolean(section.querySelector('.drug-pill'));
    section.classList.toggle('pool-section-empty', !hasPills);
    section.style.order = String(hasPills ? baseOrder : offset + baseOrder);
  });

  updatePoolToggleAllButton();
}

function setPoolSectionCollapsed(section, shouldCollapse) {
  if (!section) {
    return;
  }

  const isCollapsed = section.classList.contains('pool-section-collapsed');
  if (isCollapsed === shouldCollapse) {
    return;
  }

  section.classList.toggle('pool-section-collapsed', shouldCollapse);

  const labelButton = section.querySelector('.pool-section-label');
  if (labelButton) {
    labelButton.setAttribute('aria-expanded', shouldCollapse ? 'false' : 'true');
  }

  const label = section.dataset.poolLabel;
  if (!label) {
    return;
  }

  if (shouldCollapse) {
    collapsedPoolSections.add(label);
  } else {
    collapsedPoolSections.delete(label);
  }
}

function collapsePoolSectionByLabel(label) {
  if (!label) {
    return;
  }

  const section = [...elements.poolContent.querySelectorAll('.pool-section')].find(entry => entry.dataset.poolLabel === label);
  setPoolSectionCollapsed(section, true);
}

function togglePoolSection(section) {
  if (!section) {
    return;
  }

  const label = section.dataset.poolLabel;
  if (!label) {
    return;
  }

  const willCollapse = !section.classList.contains('pool-section-collapsed');
  setPoolSectionCollapsed(section, willCollapse);
  updatePoolToggleAllButton();
}

function updatePoolToggleAllButton() {
  if (!elements.poolToggleAll) {
    return;
  }

  const sections = [...elements.poolContent.querySelectorAll('.pool-section')];
  if (!sections.length) {
    elements.poolToggleAll.disabled = true;
    elements.poolToggleAll.textContent = 'Collapse All';
    return;
  }

  const allCollapsed = sections.every(section => section.classList.contains('pool-section-collapsed'));
  elements.poolToggleAll.disabled = false;
  elements.poolToggleAll.textContent = allCollapsed ? 'Reveal All' : 'Collapse All';
}

function toggleAllPoolSections() {
  const sections = [...elements.poolContent.querySelectorAll('.pool-section')];
  if (!sections.length) {
    return;
  }

  const allCollapsed = sections.every(section => section.classList.contains('pool-section-collapsed'));

  sections.forEach(section => {
    const label = section.dataset.poolLabel;
    if (!label) {
      return;
    }

    const willCollapse = !allCollapsed;
    section.classList.toggle('pool-section-collapsed', willCollapse);

    const labelButton = section.querySelector('.pool-section-label');
    if (labelButton) {
      labelButton.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
    }

    if (willCollapse) {
      collapsedPoolSections.add(label);
    } else {
      collapsedPoolSections.delete(label);
    }
  });

  updatePoolToggleAllButton();
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
    highlightTapTargetsForItem(item);
  });

  return pill;
}

function isTapTargetForItem(zone, item) {
  if (!zone || zone.dataset.prefilled === 'true' || zone.classList.contains('complete')) {
    return false;
  }

  const zonePoolLabel = zone.dataset.poolLabel;
  if (zonePoolLabel) {
    return zonePoolLabel === item.poolLabel;
  }

  return zone.dataset.sub === item.type;
}

function highlightTapTargetsForItem(item) {
  clearTapTargets();

  if (!item) {
    return;
  }

  document.querySelectorAll('.sub-pills').forEach(zone => {
    if (isTapTargetForItem(zone, item)) {
      zone.classList.add('tap-target');
    }
  });
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
           data-pool-label="${child.typeLabel}"
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
  const expectedOrder = item.sortOrder === null
    ? null
    : nextExpectedOrderForZone(categoryId, subsectionId, parentItemId);
  const correctOrder = item.sortOrder === null || expectedOrder === null || item.sortOrder === expectedOrder;
  const isCorrect = correctCategoryAndType && correctParent && correctOrder;
  const targetCard = document.getElementById(`cat-${categoryId}`);

  if (!isCorrect) {
    markCardOpenAfterPlacement(targetCard);
    shake(pill);

    if (!isMobile()) {
      selectedPill = null;
      draggingId = null;
    }

    return;
  }

  const slotKey = slotKeyFor(categoryId, subsectionId, parentItemId);
  if (placedLog[item.id] && placedLog[item.id].has(slotKey)) {
    return;
  }

  if (!placedLog[item.id]) {
    placedLog[item.id] = new Set();
  }

  placedLog[item.id].add(slotKey);

  const placed = makePlacedPillElement(item, categoryId);

  const zoneId = parentItemId
    ? `nested-${categoryId}-${subsectionId}-${parentItemId}`
    : `pills-${categoryId}-${subsectionId}`;
  const zone = document.getElementById(zoneId);

  if (zone) {
    insertPlacedPill(zone, placed, item.sortOrder);
    updateZoneCompletionState(zone);
  }

  markCardOpenAfterPlacement(targetCard);

  if (item.children.length) {
    revealChildren(item, categoryId);
  }

  const remaining = item.correctCats.size - currentPlacedSlotsForItem(item).length;
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

function slotKeyFor(categoryId, subsectionId, parentItemId = null) {
  return `${categoryId}|${subsectionId}` + (parentItemId ? `|${parentItemId}` : '');
}

function nextExpectedOrderForZone(categoryId, subsectionId, parentItemId = null) {
  const slotKey = slotKeyFor(categoryId, subsectionId, parentItemId);

  const orderedItems = allItems
    .filter(item =>
      item.correctCats.has(categoryId) &&
      item.type === subsectionId &&
      (item.parentId || null) === parentItemId &&
      item.sortOrder !== null
    )
    .sort((left, right) => left.sortOrder - right.sortOrder);

  const nextItem = orderedItems.find(item => !(placedLog[item.id] && placedLog[item.id].has(slotKey)));
  return nextItem ? nextItem.sortOrder : null;
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
    const parsedTextEntry = parseDisplayText(rawEntry.text);
    const mergedHint = [parsedTextEntry.hint, typeof rawEntry.hint === 'string' ? rawEntry.hint.trim() : '']
      .filter(Boolean)
      .join('; ');

    return {
      label: parsedTextEntry.label,
      hint: mergedHint || null,
      order: Number.isFinite(rawEntry.order) ? Number(rawEntry.order) : parsedTextEntry.order,
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

  const hints = [];
  text = text
    .replace(/\(([^()]*)\)|\[([^\]]*)\]/g, (_, parenHint, bracketHint) => {
      const hint = String(parenHint || bracketHint || '').trim();
      if (hint) {
        hints.push(hint);
      }
      return '';
    })
    .replace(/\(([^()]*)$/g, (_, trailingHint) => {
      const hint = String(trailingHint || '').trim();
      if (hint) {
        hints.push(hint);
      }
      return '';
    });

  text = text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:?!])/g, '$1')
    .replace(/([,;:])(?=\S)/g, '$1 ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    label: text.trim(),
    hint: hints.length ? hints.join('; ') : null,
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
  if (document.querySelectorAll('#pool-content .drug-pill').length !== 0) {
    return;
  }

  if (elements.poolContent) {
    elements.poolContent.innerHTML = '<div class="success-msg">All correct</div>';
  }
  updatePoolToggleAllButton();
  elements.resetBtn.style.display = 'block';
}

async function initGame({ preserveFilters = false, reusePreparedCategories = false, resetProgress = false } = {}) {
  clearError();

  if (resetProgress) {
    placedLog = {};
  }

  try {
    if (!reusePreparedCategories || !baseCategories.length) {
      baseCategories = await categoriesForCurrentSelection();
    }

    const nextSectionOptions = deriveSectionOptions(baseCategories);
    syncSectionFilters(nextSectionOptions, preserveFilters);
    sectionOptions = nextSectionOptions;
    renderCurrentGameFromState();
  } catch (error) {
    resetState({ preserveProgress: true });
    baseCategories = [];
    sectionOptions = [];
    enabledSectionKeys = new Set();
    buildGrid([]);
    renderPoolMessage('Unable to load the selected unit.');
    renderSettingsPanel();
    showError(`Could not load the selected unit data. ${error.message}`);
  }
}

bindUi();
void initializeCatalog();
