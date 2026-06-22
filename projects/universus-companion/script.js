const STORAGE_KEY = "universus-companion-state-v1";

const defaultState = {
  players: {
    p1: { name: "Player 1", life: 30, maxLife: 30, counter: 0, progressiveDifficulty: 0, image: null },
    p2: { name: "Player 2", life: 30, maxLife: 30, counter: 0, progressiveDifficulty: 0, image: null }
  },
  turnPlayer: "p1",
  attack: { baseDamage: 3, baseSpeed: 3, location: "mid", throw: false },
  continuous: { damageBonus: 0, speedBonus: 0 },
  meta: { lastDamage: null, lastHitPlayer: null, healthDefaultVersion: 30 }
};

const uiState = {
  expandedRowId: null,
  pendingBlock: null,
  maxLifePlayerId: null,
  maxLifeDraft: null,
  continuousPopup: null,
  confirmReset: false,
  lifePressTimer: null,
  attackPressTimer: null,
  suppressNextLifeClick: false,
  suppressNextAttackTap: false,
  lastLifeTap: { playerId: null, time: 0 }
};

const locationLabels = { high: "High", mid: "Mid", low: "Low" };
const blockTable = {
  high: { high: "full", mid: "half", low: "none" },
  mid: { high: "half", mid: "full", low: "half" },
  low: { high: "none", mid: "half", low: "full" }
};

let state = loadState();
let pendingHitPlayer = null;

const playerTemplate = document.querySelector("#player-template");
const playerMounts = {
  p1: document.querySelector("#player-p1"),
  p2: document.querySelector("#player-p2")
};

const hud = {
  combatBar: document.querySelector("#combat-bar"),
  damageReadouts: document.querySelectorAll('[data-attack-field="damage"]'),
  speedReadouts: document.querySelectorAll('[data-attack-field="speed"]'),
  speedChips: document.querySelectorAll("[data-speed-chip]"),
  turnIndicator: document.querySelector("#turn-indicator"),
  lastDamage: document.querySelector("#last-damage")
};

const blockModal = document.querySelector("#block-modal");

// ---------- State and persistence ----------
function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const loadedState = sanitizeState({ ...structuredClone(defaultState), ...saved });
    resetProgressiveDifficulty(loadedState);
    return loadedState;
  } catch {
    return structuredClone(defaultState);
  }
}

function sanitizeState(nextState) {
  const merged = structuredClone(defaultState);

  if (nextState?.players) {
    ["p1", "p2"].forEach((playerId) => {
      merged.players[playerId] = {
        ...merged.players[playerId],
        ...(nextState.players[playerId] || {})
      };
    });
  }

  merged.turnPlayer = nextState?.turnPlayer === "p2" ? "p2" : "p1";
  merged.attack = { ...merged.attack, ...(nextState?.attack || {}) };
  merged.continuous = { ...merged.continuous, ...(nextState?.continuous || {}) };
  merged.meta = { ...merged.meta, ...(nextState?.meta || {}) };

  ["p1", "p2"].forEach((playerId) => {
    const player = merged.players[playerId];
    if (nextState?.meta?.healthDefaultVersion !== 30 && player.maxLife === 35 && player.life === 35) {
      player.maxLife = 30;
      player.life = 30;
    }
    player.maxLife = clampNumber(player.maxLife, 1, 999);
    player.life = clampNumber(player.life, 0, 999);
    player.counter = clampNumber(player.counter, -999, 999);
    player.progressiveDifficulty = clampNumber(player.progressiveDifficulty, -999, 999);
    player.name = String(player.name || defaultState.players[playerId].name).slice(0, 24);
    player.image = typeof player.image === "string" && player.image.startsWith("data:image/") ? player.image : null;
  });

  merged.attack.baseDamage = clampNumber(merged.attack.baseDamage, -99, 999);
  merged.attack.baseSpeed = clampNumber(merged.attack.baseSpeed, -99, 999);
  merged.attack.location = locationLabels[merged.attack.location] ? merged.attack.location : "mid";
  merged.attack.throw = Boolean(merged.attack.throw);
  merged.continuous.damageBonus = clampNumber(merged.continuous.damageBonus, -99, 999);
  merged.continuous.speedBonus = clampNumber(merged.continuous.speedBonus, -99, 999);

  return merged;
}

function updateState(mutator) {
  mutator(state);
  state = sanitizeState(state);
  saveState();
  render();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- Derived game values ----------
function getFinalDamage() {
  return Math.max(0, state.attack.baseDamage + state.continuous.damageBonus);
}

function getFinalSpeed() {
  return Math.max(0, state.attack.baseSpeed + state.continuous.speedBonus);
}

function getDefenderId() {
  return state.turnPlayer === "p1" ? "p2" : "p1";
}

function getBlockResult(blockLocation) {
  const finalDamage = getFinalDamage();
  const blockQuality = blockTable[state.attack.location][blockLocation];
  const throwFullBlock = state.attack.throw && blockQuality === "full";
  const blockedAmount = throwFullBlock
    ? Math.floor(finalDamage / 2)
    : blockQuality === "full"
      ? finalDamage
      : blockQuality === "half"
        ? Math.floor(finalDamage / 2)
        : 0;

  return {
    blockQuality: throwFullBlock ? "throw" : blockQuality,
    blockedAmount,
    damageTaken: Math.max(0, finalDamage - blockedAmount)
  };
}

function resetAttackValues(nextState) {
  nextState.attack.baseDamage = 3;
  nextState.attack.baseSpeed = 3;
  nextState.attack.location = "mid";
  nextState.attack.throw = false;
}

function resetProgressiveDifficulty(nextState) {
  ["p1", "p2"].forEach((playerId) => {
    nextState.players[playerId].progressiveDifficulty = 0;
  });
}

// ---------- Rendering ----------
function render() {
  renderHud();
  renderPlayer("p2");
  renderPlayer("p1");
  renderBlockModal();
  animatePendingHit();
}

function renderHud() {
  const finalDamage = getFinalDamage();
  const finalSpeed = getFinalSpeed();
  const location = state.attack.location;
  const attacker = state.players[state.turnPlayer];

  hud.combatBar.classList.toggle("attacker-p2", state.turnPlayer === "p2");
  hud.combatBar.classList.toggle("attacker-p1", state.turnPlayer === "p1");
  hud.damageReadouts.forEach((readout) => {
    readout.textContent = finalDamage;
  });
  hud.speedReadouts.forEach((readout) => {
    readout.textContent = finalSpeed;
  });
  hud.speedChips.forEach((chip) => {
    chip.className = `combat-chip speed-chip attack-icon-${location}`;
    chip.setAttribute("aria-label", `Speed ${finalSpeed}, ${locationLabels[location]} attack`);
  });
  hud.turnIndicator.textContent = `${attacker.name} attacking`;

  if (state.meta.lastDamage) {
    const target = state.players[state.meta.lastDamage.defenderId]?.name || "Defender";
    hud.lastDamage.textContent = `${target}: ${state.meta.lastDamage.damageTaken} dmg • ${state.meta.lastDamage.blockedAmount} blocked`;
  } else {
    hud.lastDamage.textContent = "No damage yet";
  }
}

function renderPlayer(playerId) {
  const player = state.players[playerId];
  const isAttacker = state.turnPlayer === playerId;
  const fragment = playerTemplate.content.cloneNode(true);
  const panel = fragment.querySelector(".player-panel");
  const playerName = fragment.querySelector(".player-name");
  const avatarThumb = fragment.querySelector(".avatar-thumb");
  const roleBadge = fragment.querySelector(".role-badge");
  const content = fragment.querySelector(".player-content");

  panel.dataset.player = playerId;
  panel.classList.toggle("is-attacker", isAttacker);
  panel.classList.toggle("has-image", Boolean(player.image));
  if (player.image) {
    panel.style.setProperty("--player-image", `url("${player.image}")`);
    avatarThumb.style.backgroundImage = `url("${player.image}")`;
  } else {
    panel.style.removeProperty("--player-image");
    avatarThumb.style.backgroundImage = "";
  }
  playerName.value = player.name;
  roleBadge.textContent = isAttacker ? "Attacking" : "Defending";
  roleBadge.classList.toggle("defending", !isAttacker);

  content.innerHTML = `
    <div class="controls-stack">
      <div class="control-row quick-stats-row">
        ${statTapCard(playerId, "progressiveDifficulty", "Prog Diff", player.progressiveDifficulty)}
        ${statTapCard(playerId, "life", "Life", `${player.life} / ${player.maxLife}`)}
        ${statTapCard(playerId, "counter", "Counter", player.counter)}
      </div>
      ${isAttacker ? attackerPanel(playerId) : defenderPanel()}
    </div>
  `;

  playerMounts[playerId].innerHTML = "";
  playerMounts[playerId].appendChild(fragment);
}

function attackerPanel() {
  return `
    <div class="control-row location-row" aria-label="Attack location controls">
      ${locationControls()}
    </div>
  `;
}

function defenderPanel() {
  const blockButtons = [
    state.attack.location !== "low" ? blockButton("high", "High Block") : "",
    blockButton("mid", "Mid Block"),
    state.attack.location !== "high" ? blockButton("low", "Low Block") : ""
  ].join("");

  return `
    <div class="control-row block-row" aria-label="Defending player block controls">
      ${blockButtons}
    </div>
    <div class="control-row no-block-row" aria-label="No block controls">
      <button class="no-block-btn" data-action="no-block" type="button">No Block</button>
    </div>
  `;
}

function blockButton(location, label) {
  return `<button class="block-btn block-icon-${location} loc-${location}" data-action="block" data-location="${location}" aria-label="${label}"><span>${label}</span></button>`;
}

function statTapCard(playerId, controlName, label, value) {
  return `
    <button class="stat-card stat-tap-card" data-stat-tap="${controlName}" data-player="${playerId}" data-control="${controlName}" type="button" aria-label="${label}: left side subtracts, right side adds">
      <span>${label}</span>
      <strong>${value}</strong>
    </button>
  `;
}

function statAccordion(playerId, controlName, label, value, controlsMarkup, hint = "") {
  const rowId = getRowId(playerId, controlName);
  const isOpen = uiState.expandedRowId === rowId;
  return `
    <div class="control-row stat-accordion ${isOpen ? "open expanded" : ""}" data-control="${controlName}" data-row-id="${rowId}">
      <button class="stat-card" data-action="toggle-control" data-control="${controlName}" aria-expanded="${isOpen}">
        <span>${label}</span>
        <strong>${value}</strong>
        ${hint ? `<small>${hint}</small>` : ""}
      </button>
      <div class="accordion-body" aria-hidden="${!isOpen}">
        <div class="accordion-inner">${isOpen ? controlsMarkup : ""}</div>
      </div>
    </div>
  `;
}

function stepperControls(decAction, incAction, label) {
  return `
    <div class="control-strip two-up">
      <button class="control-btn" data-action="${decAction}" aria-label="Decrease ${label}">−1</button>
      <button class="control-btn" data-action="${incAction}" aria-label="Increase ${label}">+1</button>
    </div>
  `;
}

function lifeControls() {
  return stepperControls("life-dec", "life-inc", "Life");
}

function locationControls() {
  const throwActive = state.attack.throw ? "active" : "";
  return `
    <div class="control-strip location-controls">
      ${locationButton("high", "High")}
      ${locationButton("mid", "Mid")}
      ${locationButton("low", "Low")}
      <button class="control-btn throw-btn ${throwActive}" data-action="toggle-throw" type="button" aria-pressed="${state.attack.throw}">Throw</button>
    </div>
  `;
}

function locationButton(location, label) {
  const active = state.attack.location === location ? "active" : "";
  return `<button class="control-btn location-btn attack-icon-${location} loc-${location} ${active}" data-action="set-location" data-location="${location}" aria-label="${label} attack location" title="${label} attack location"></button>`;
}

function renderMaxLifeModal() {
  const playerId = uiState.maxLifePlayerId;
  const player = state.players[playerId];

  if (!player) return false;

  const draftMaxLife = clampNumber(uiState.maxLifeDraft ?? player.maxLife, 1, 999);
  uiState.maxLifeDraft = draftMaxLife;

  blockModal.classList.remove("hidden");
  blockModal.classList.toggle("max-life-p2", playerId === "p2");
  blockModal.classList.toggle("max-life-p1", playerId === "p1");
  blockModal.classList.remove("defender-p1", "defender-p2", "continuous-p1", "continuous-p2");
  blockModal.innerHTML = `
    <div class="block-modal-backdrop" data-action="close-max-life-modal"></div>
    <div class="block-modal-card max-life-modal-card glass-card" role="dialog" aria-modal="true" aria-label="Set ${player.name} max health">
      <header class="block-modal-header">
        <span>${player.name} Max Health</span>
        <button class="btn btn-xs btn-ghost" data-action="close-max-life-modal" aria-label="Cancel max health">✕</button>
      </header>
      <p class="block-modal-copy">Current life: ${player.life} / ${player.maxLife}</p>
      <div class="max-life-draft" aria-live="polite">
        <span>New max</span>
        <strong>${draftMaxLife}</strong>
      </div>
      <div class="control-strip max-life-controls max-life-popup-controls">
        <button class="control-btn" data-action="max-life-popup-dec" type="button" aria-label="Decrease max life">−1</button>
        <button class="control-btn" data-action="max-life-popup-inc" type="button" aria-label="Increase max life">+1</button>
      </div>
      <button class="control-btn set-btn max-life-set-btn" data-action="set-max-life-popup" data-player="${playerId}" type="button">Set</button>
    </div>
  `;

  requestAnimationFrame(() => {
    blockModal.querySelector(".max-life-set-btn")?.focus();
  });

  return true;
}

function renderContinuousModal() {
  const popup = uiState.continuousPopup;
  if (!popup) return false;

  const { playerId, stat } = popup;
  const isDamage = stat === "damage";
  const label = isDamage ? "Continuous Attack" : "Continuous Speed";
  const key = isDamage ? "damageBonus" : "speedBonus";
  const value = state.continuous[key];

  blockModal.classList.remove("hidden");
  blockModal.classList.toggle("continuous-p2", playerId === "p2");
  blockModal.classList.toggle("continuous-p1", playerId === "p1");
  blockModal.classList.remove("defender-p1", "defender-p2", "max-life-p1", "max-life-p2");
  blockModal.innerHTML = `
    <div class="block-modal-backdrop" data-action="close-continuous-modal"></div>
    <div class="block-modal-card continuous-modal-card glass-card" role="dialog" aria-modal="true" aria-label="${label}">
      <header class="block-modal-header">
        <span>${label}</span>
        <button class="btn btn-xs btn-ghost" data-action="close-continuous-modal" aria-label="Close ${label}">✕</button>
      </header>
      <div class="continuous-readout ${isDamage ? "damage-chip" : "speed-chip attack-icon-" + state.attack.location}">
        <span>${isDamage ? "Attack Bonus" : "Speed Bonus"}</span>
        <strong>${formatSigned(value)}</strong>
      </div>
      <div class="block-result-actions">
        <button class="control-btn" data-action="cont-popup-dec">−1</button>
        <button class="control-btn" data-action="cont-popup-inc">+1</button>
      </div>
    </div>
  `;
  return true;
}

function renderResetModal() {
  if (!uiState.confirmReset) return false;

  blockModal.classList.remove("hidden");
  blockModal.classList.remove("defender-p1", "defender-p2", "max-life-p1", "max-life-p2", "continuous-p1", "continuous-p2");
  blockModal.innerHTML = `
    <div class="block-modal-backdrop" data-action="close-reset-modal"></div>
    <div class="block-modal-card reset-modal-card glass-card" role="dialog" aria-modal="true" aria-label="Confirm reset game">
      <header class="block-modal-header">
        <span>Reset game?</span>
        <button class="btn btn-xs btn-ghost" data-action="close-reset-modal" aria-label="Cancel reset">✕</button>
      </header>
      <p class="block-modal-copy">Restore life, clear counters and attack values, then randomize who attacks first.</p>
      <div class="block-result-actions reset-actions">
        <button class="btn btn-error" data-action="confirm-reset-game">Reset</button>
        <button class="btn btn-ghost" data-action="close-reset-modal">Cancel</button>
      </div>
    </div>
  `;
  return true;
}

function renderBlockModal() {
  if (renderMaxLifeModal()) return;
  if (renderContinuousModal()) return;
  if (renderResetModal()) return;

  blockModal.classList.toggle("defender-p2", getDefenderId() === "p2");
  blockModal.classList.toggle("defender-p1", getDefenderId() === "p1");
  blockModal.classList.remove("max-life-p1", "max-life-p2", "continuous-p1", "continuous-p2");

  if (!uiState.pendingBlock) {
    blockModal.classList.add("hidden");
    blockModal.innerHTML = "";
    return;
  }

  const { blockLocation, bonus, difficulty } = uiState.pendingBlock;
  const blockLabel = locationLabels[blockLocation];
  blockModal.classList.remove("hidden");

  if (bonus === null) {
    blockModal.innerHTML = `
      <div class="block-modal-backdrop" data-action="close-block-modal"></div>
      <div class="block-modal-card glass-card" role="dialog" aria-modal="true" aria-label="Choose ${blockLabel} block bonus">
        <header class="block-modal-header">
          <span>${blockLabel} Block</span>
          <button class="btn btn-xs btn-ghost" data-action="close-block-modal" aria-label="Cancel block">✕</button>
        </header>
        <p class="block-modal-copy">Choose block modifier</p>
        <div class="block-bonus-grid">
          ${[0, 1, 2, 3, 4, 5, 6].map((value) => blockBonusButton(blockLocation, value)).join("")}
        </div>
      </div>
    `;
    return;
  }

  blockModal.innerHTML = `
    <div class="block-modal-backdrop" data-action="close-block-modal"></div>
    <div class="block-modal-card glass-card" role="dialog" aria-modal="true" aria-label="${blockLabel} block result">
      <header class="block-modal-header">
        <span>${blockLabel} Block ${formatSigned(bonus)}</span>
        <button class="btn btn-xs btn-ghost" data-action="close-block-modal" aria-label="Cancel block">✕</button>
      </header>
      <div class="difficulty-readout block-icon-${blockLocation}">
        <span>Difficulty Check</span>
        <strong>${difficulty}</strong>
        <small>${formatSigned(bonus)} block + ${getFinalSpeed()} speed + ${state.players[getDefenderId()].progressiveDifficulty} prog diff</small>
      </div>
      <div class="block-result-actions">
        <button class="btn btn-success" data-action="block-success">Success</button>
        <button class="btn btn-error" data-action="block-fail">Fail</button>
      </div>
    </div>
  `;
}

function blockBonusButton(blockLocation, value) {
  const blockLabel = locationLabels[blockLocation];
  return `
    <button class="block-bonus-btn block-icon-${blockLocation}" data-action="block-bonus" data-bonus="${value}" aria-label="${blockLabel} block ${formatSigned(value)}">
      <span>${formatSigned(value)}</span>
    </button>
  `;
}

function animatePendingHit() {
  if (!pendingHitPlayer) return;
  const panel = playerMounts[pendingHitPlayer]?.querySelector(".player-panel");
  if (panel) {
    panel.classList.remove("hit-flash");
    requestAnimationFrame(() => panel.classList.add("hit-flash"));
  }
  pendingHitPlayer = null;
}

// ---------- UI accordion actions ----------
function getRowId(playerId, controlName) {
  return `${playerId}:${controlName}`;
}

function hasExpandedRow(playerId) {
  return typeof uiState.expandedRowId === "string" && uiState.expandedRowId.startsWith(`${playerId}:`);
}

function toggleControl(playerId, controlName) {
  if (!playerId || !controlName) return;
}


function closeAllControls() {
  uiState.expandedRowId = null;
  uiState.pendingBlock = null;
  uiState.maxLifePlayerId = null;
  uiState.maxLifeDraft = null;
  uiState.continuousPopup = null;
  uiState.confirmReset = false;
}

function closePlayerControls(playerId) {
  if (!playerId || !hasExpandedRow(playerId)) return;
  uiState.expandedRowId = null;
}

// ---------- Game actions ----------
function handleAction(action, element) {
  const playerId = element.closest(".player-panel")?.dataset.player;


  const actions = {
    "toggle-control": () => toggleControl(playerId, element.dataset.control),
    "choose-image": () => chooseImage(playerId, element),
    "life-inc": () => changePlayerValue(playerId, "life", 1, 0, 999),
    "life-dec": () => changePlayerValue(playerId, "life", -1, 0, 999),
    "counter-inc": () => changePlayerValue(playerId, "counter", 1, -999, 999),
    "counter-dec": () => changePlayerValue(playerId, "counter", -1, -999, 999),
    "max-life-popup-inc": () => changeMaxLifeDraft(1),
    "max-life-popup-dec": () => changeMaxLifeDraft(-1),
    "set-max-life-popup": () => setMaxLifeFromPopup(element.dataset.player),
    "base-damage-inc": () => changeAttackValue("baseDamage", 1),
    "base-damage-dec": () => changeAttackValue("baseDamage", -1),
    "base-speed-inc": () => changeAttackValue("baseSpeed", 1),
    "base-speed-dec": () => changeAttackValue("baseSpeed", -1),
    "cont-damage-inc": () => changeContinuousValue("damageBonus", 1),
    "cont-damage-dec": () => changeContinuousValue("damageBonus", -1),
    "cont-speed-inc": () => changeContinuousValue("speedBonus", 1),
    "cont-speed-dec": () => changeContinuousValue("speedBonus", -1),
    "cont-popup-inc": () => changeContinuousFromPopup(1),
    "cont-popup-dec": () => changeContinuousFromPopup(-1),
    "set-location": () => setAttackLocation(element.dataset.location),
    "toggle-throw": toggleThrow,
    block: () => openBlockBonusPicker(element.dataset.location),
    "block-bonus": () => chooseBlockBonus(element.dataset.bonus),
    "block-success": () => resolvePendingBlock(true),
    "block-fail": () => resolvePendingBlock(false),
    "no-block": resolveNoBlock,
    "close-block-modal": closeBlockModal,
    "close-max-life-modal": closeMaxLifeModal,
    "close-continuous-modal": closeContinuousModal,
    "close-reset-modal": closeResetModal,
    "confirm-reset-game": resetGame,
    "end-turn": endTurn,
    "reset-game": openResetModal
  };

  actions[action]?.();
}

function changePlayerValue(playerId, key, delta, min, max) {
  if (!playerId) return;
  updateState((nextState) => {
    nextState.players[playerId][key] = clampNumber(nextState.players[playerId][key] + delta, min, max);
  });
}

function changeMaxLifeDraft(delta) {
  const player = state.players[uiState.maxLifePlayerId];
  if (!player) return;
  uiState.maxLifeDraft = clampNumber((uiState.maxLifeDraft ?? player.maxLife) + delta, 1, 999);
  renderBlockModal();
}

function setMaxLifeFromPopup(playerId) {
  if (!playerId) return;
  const maxLife = clampNumber(uiState.maxLifeDraft, 1, 999);

  uiState.maxLifePlayerId = null;
  uiState.maxLifeDraft = null;
  updateState((nextState) => {
    nextState.players[playerId].maxLife = maxLife;
    nextState.players[playerId].life = maxLife;
  });
}

function changeAttackValue(key, delta) {
  updateState((nextState) => {
    nextState.attack[key] = clampNumber(nextState.attack[key] + delta, -99, 999);
  });
}

function changeContinuousValue(key, delta) {
  updateState((nextState) => {
    nextState.continuous[key] = clampNumber(nextState.continuous[key] + delta, -99, 999);
  });
}

function setAttackLocation(location) {
  if (!locationLabels[location]) return;
  updateState((nextState) => {
    nextState.attack.location = location;
  });
}

function toggleThrow() {
  updateState((nextState) => {
    nextState.attack.throw = !nextState.attack.throw;
  });
}

function openBlockBonusPicker(blockLocation) {
  if (!locationLabels[blockLocation]) return;
  uiState.pendingBlock = { blockLocation, bonus: null, difficulty: null };
  render();
}

function chooseBlockBonus(rawBonus) {
  if (!uiState.pendingBlock) return;
  const bonus = clampNumber(rawBonus, 0, 6);
  uiState.pendingBlock = {
    ...uiState.pendingBlock,
    bonus,
    difficulty: bonus + getFinalSpeed() + state.players[getDefenderId()].progressiveDifficulty
  };
  renderBlockModal();
}

function closeBlockModal() {
  uiState.pendingBlock = null;
  renderBlockModal();
}

function openMaxLifeModal(playerId) {
  if (!state.players[playerId]) return;
  closeAllControls();
  uiState.maxLifePlayerId = playerId;
  uiState.maxLifeDraft = state.players[playerId].maxLife;
  renderBlockModal();
}

function closeMaxLifeModal() {
  uiState.maxLifePlayerId = null;
  uiState.maxLifeDraft = null;
  renderBlockModal();
}

function openContinuousModal(playerId, stat) {
  if (!state.players[playerId] || !["damage", "speed"].includes(stat)) return;
  closeAllControls();
  uiState.continuousPopup = { playerId, stat };
  renderBlockModal();
}

function closeContinuousModal() {
  uiState.continuousPopup = null;
  renderBlockModal();
}

function changeContinuousFromPopup(delta) {
  const stat = uiState.continuousPopup?.stat;
  const key = stat === "damage" ? "damageBonus" : stat === "speed" ? "speedBonus" : null;
  if (!key) return;
  changeContinuousValue(key, delta);
}

function resolveNoBlock() {
  const defenderId = getDefenderId();
  const damageTaken = getFinalDamage();
  pendingHitPlayer = defenderId;
  closePlayerControls(defenderId);
  uiState.pendingBlock = null;

  updateState((nextState) => {
    nextState.players[defenderId].life = Math.max(0, nextState.players[defenderId].life - damageTaken);
    nextState.players[state.turnPlayer].progressiveDifficulty += 1;
    nextState.meta.lastDamage = {
      defenderId,
      blockLocation: "none",
      bonus: null,
      difficulty: null,
      success: false,
      blockQuality: "no-block",
      blockedAmount: 0,
      damageTaken
    };
    nextState.meta.lastHitPlayer = defenderId;
    resetAttackValues(nextState);
  });

  vibrateOnHit(damageTaken);
}

function resolvePendingBlock(success) {
  if (!uiState.pendingBlock) return;
  const { blockLocation, bonus, difficulty } = uiState.pendingBlock;
  if (!locationLabels[blockLocation] || bonus === null) return;

  const defenderId = getDefenderId();
  const result = success
    ? getBlockResult(blockLocation)
    : { blockQuality: "failed", blockedAmount: 0, damageTaken: getFinalDamage() };

  pendingHitPlayer = defenderId;
  closePlayerControls(defenderId);
  uiState.pendingBlock = null;

  updateState((nextState) => {
    nextState.players[defenderId].life = Math.max(0, nextState.players[defenderId].life - result.damageTaken);
    nextState.players[state.turnPlayer].progressiveDifficulty += 1;
    if (success) {
      nextState.players[defenderId].progressiveDifficulty += 1;
    }
    nextState.meta.lastDamage = { defenderId, blockLocation, bonus, difficulty, success, ...result };
    nextState.meta.lastHitPlayer = defenderId;
    resetAttackValues(nextState);
  });

  vibrateOnHit(result.damageTaken);
}

function endTurn() {
  closeAllControls();
  updateState((nextState) => {
    resetAttackValues(nextState);
    nextState.continuous.damageBonus = 0;
    nextState.continuous.speedBonus = 0;
    resetProgressiveDifficulty(nextState);
    nextState.turnPlayer = nextState.turnPlayer === "p1" ? "p2" : "p1";
    nextState.meta.lastDamage = null;
  });
}

function openResetModal() {
  closeAllControls();
  uiState.confirmReset = true;
  renderBlockModal();
}

function closeResetModal() {
  uiState.confirmReset = false;
  renderBlockModal();
}

function resetGame() {
  closeAllControls();
  updateState((nextState) => {
    ["p1", "p2"].forEach((playerId) => {
      nextState.players[playerId].life = nextState.players[playerId].maxLife;
      nextState.players[playerId].counter = 0;
    });
    resetProgressiveDifficulty(nextState);
    resetAttackValues(nextState);
    nextState.continuous.damageBonus = 0;
    nextState.continuous.speedBonus = 0;
    nextState.turnPlayer = Math.random() < 0.5 ? "p1" : "p2";
    nextState.meta.lastDamage = null;
    nextState.meta.lastHitPlayer = null;
  });
}

function chooseImage(playerId, element) {
  if (!playerId) return;
  const input = element.closest(".player-panel").querySelector(".image-input");
  input?.click();
}

function setPlayerImage(playerId, imageDataUrl) {
  if (!playerId) return;
  updateState((nextState) => {
    nextState.players[playerId].image = imageDataUrl;
  });
}

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const maxSize = 900;
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      };
      image.onerror = reject;
      image.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function vibrateOnHit(damageTaken) {
  if (damageTaken > 0 && "vibrate" in navigator) {
    navigator.vibrate([18, 24, 18]);
  }
}

function clampNumber(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function formatSigned(value) {
  return value >= 0 ? `+${value}` : String(value);
}

function getLifeCardPlayerId(element) {
  return element.closest(".player-panel")?.dataset.player || element.closest("[data-stat-tap]")?.dataset.player;
}

function getStatTapInfo(element, event) {
  const card = element.closest("[data-stat-tap]");
  if (!card) return null;
  const rect = card.getBoundingClientRect();
  return {
    playerId: card.dataset.player,
    stat: card.dataset.statTap,
    pointerSide: event.clientX < rect.left + rect.width / 2 ? "left" : "right"
  };
}

function applyStatCardTap(info) {
  if (!info?.playerId) return;
  if (info.stat === "life") {
    changePlayerValue(info.playerId, "life", info.pointerSide === "left" ? -1 : 1, 0, 999);
  } else if (info.stat === "counter") {
    changePlayerValue(info.playerId, "counter", info.pointerSide === "left" ? -1 : 1, -999, 999);
  } else if (info.stat === "progressiveDifficulty") {
    changePlayerValue(info.playerId, "progressiveDifficulty", info.pointerSide === "left" ? -1 : 1, -999, 999);
  }
}

function clearLifePressTimer() {
  if (!uiState.lifePressTimer) return;
  clearTimeout(uiState.lifePressTimer);
  uiState.lifePressTimer = null;
}

function getAttackChipInfo(element, event) {
  const chip = element.closest("[data-attack-chip]");
  if (!chip) return null;
  const rect = chip.getBoundingClientRect();
  return {
    chip,
    stat: chip.dataset.attackChip,
    playerId: chip.dataset.playerSide,
    pointerSide: event.clientX < rect.left + rect.width / 2 ? "left" : "right"
  };
}

function getAttackStateKey(stat) {
  return stat === "damage" ? "baseDamage" : stat === "speed" ? "baseSpeed" : null;
}

function clearAttackPressTimer() {
  if (!uiState.attackPressTimer) return;
  clearTimeout(uiState.attackPressTimer);
  uiState.attackPressTimer = null;
}

function applyAttackChipTap(info) {
  if (!info) return;
  const stateKey = getAttackStateKey(info.stat);
  if (!stateKey) return;

  // Player 2's controls are rendered at the top of the phone and rotated for
  // their point of view, so their perceived left/right is the inverse of the
  // screen coordinates reported by the pointer event.
  const isTopPlayer = info.playerId === "p2";
  const isLeftSide = info.pointerSide === "left";
  const delta = (isLeftSide === isTopPlayer) ? 1 : -1;
  changeAttackValue(stateKey, delta);
}

// ---------- Event delegation ----------

document.addEventListener("selectstart", (event) => {
  if (event.target.closest?.("input, textarea")) return;
  event.preventDefault();
});

document.addEventListener("contextmenu", (event) => {
  if (event.target.closest?.("input, textarea")) return;
  event.preventDefault();
});

document.addEventListener("pointerdown", (event) => {
  const attackInfo = getAttackChipInfo(event.target, event);
  if (attackInfo) {
    clearAttackPressTimer();
    uiState.attackPressTimer = setTimeout(() => {
      uiState.attackPressTimer = null;
      uiState.suppressNextAttackTap = true;
      openContinuousModal(attackInfo.playerId, attackInfo.stat);
    }, 1000);
    return;
  }

  const lifeCard = event.target.closest('.stat-card[data-control="life"]');
  if (!lifeCard) return;
  const playerId = getLifeCardPlayerId(lifeCard);
  if (!playerId) return;

  clearLifePressTimer();
  uiState.lifePressTimer = setTimeout(() => {
    uiState.lifePressTimer = null;
    uiState.suppressNextLifeClick = true;
    openMaxLifeModal(playerId);
  }, 1000);
});

document.addEventListener("pointerup", (event) => {
  clearLifePressTimer();
  clearAttackPressTimer();
  const attackInfo = getAttackChipInfo(event.target, event);
  if (attackInfo) {
    if (uiState.suppressNextAttackTap) {
      uiState.suppressNextAttackTap = false;
      return;
    }
    applyAttackChipTap(attackInfo);
    return;
  }

  const statInfo = getStatTapInfo(event.target, event);
  if (statInfo?.stat === "life" && uiState.suppressNextLifeClick) {
    uiState.suppressNextLifeClick = false;
    return;
  }
  applyStatCardTap(statInfo);
});
document.addEventListener("pointercancel", () => {
  clearLifePressTimer();
  clearAttackPressTimer();
});
document.addEventListener("pointerleave", () => {
  clearLifePressTimer();
  clearAttackPressTimer();
});

document.addEventListener("click", (event) => {
  const actionable = event.target.closest("[data-action]");
  if (actionable) {
    handleAction(actionable.dataset.action, actionable);
    return;
  }

  if (uiState.maxLifePlayerId && event.target.closest(".max-life-modal-card")) {
    closeMaxLifeModal();
  }
});

document.addEventListener("input", (event) => {
  if (!event.target.matches(".player-name")) return;
  const playerId = event.target.closest(".player-panel")?.dataset.player;
  if (!playerId) return;

  state.players[playerId].name = event.target.value.slice(0, 24);
  saveState();
  renderHud();
});


document.addEventListener("change", async (event) => {
  if (!event.target.matches(".image-input")) return;
  const playerId = event.target.closest(".player-panel")?.dataset.player;
  const file = event.target.files?.[0];
  if (!playerId || !file) return;

  const imageDataUrl = await resizeImage(file);
  setPlayerImage(playerId, imageDataUrl);
  event.target.value = "";
});

document.addEventListener("change", (event) => {
  if (!event.target.matches(".player-name")) return;
  const playerId = event.target.closest(".player-panel")?.dataset.player;
  if (!playerId) return;

  updateState((nextState) => {
    nextState.players[playerId].name = event.target.value.trim() || defaultState.players[playerId].name;
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.matches(".player-name")) {
    event.target.blur();
  }

  if (event.key === "Escape" && uiState.maxLifePlayerId) {
    closeMaxLifeModal();
  }

  if (event.key === "Escape" && uiState.continuousPopup) {
    closeContinuousModal();
  }

  if (event.key === "Escape" && uiState.confirmReset) {
    closeResetModal();
  }
});

render();
