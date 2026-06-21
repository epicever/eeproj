const imageInput = document.getElementById('imageInput');
const cardsList = document.getElementById('cardsList');
const exportBtn = document.getElementById('exportBtn');
const statusEl = document.getElementById('status');

/** @type {{id: string, name: string, src: string, quantity: number, rotation: number}[]} */
let cards = [];

const CARD_WIDTH_IN = 2.5;
const CARD_HEIGHT_IN = 3.5;
const EXPORT_DPI = 300;
const POINTS_PER_INCH = 72;
const PAGE_WIDTH_PT = CARD_WIDTH_IN * POINTS_PER_INCH;
const PAGE_HEIGHT_PT = CARD_HEIGHT_IN * POINTS_PER_INCH;

imageInput.addEventListener('change', async (event) => {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) return;

  const newCards = await Promise.all(
    files.map(async (file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      src: await fileToDataURL(file),
      quantity: 1,
      rotation: 0,
    }))
  );

  cards = [...cards, ...newCards];
  imageInput.value = '';
  renderCards();
  setStatus(`${newCards.length} image(s) added.`);
});

exportBtn.addEventListener('click', async () => {
  if (cards.length === 0) {
    setStatus('Please import at least one image first.');
    return;
  }

  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) {
    setStatus('PDF library failed to load. Please refresh and try again.');
    return;
  }

  const pages = cards.flatMap((card) => {
    const quantity = Number.isFinite(card.quantity) ? Math.max(0, Math.floor(card.quantity)) : 0;
    return Array.from({ length: quantity }, () => card);
  });

  if (pages.length === 0) {
    setStatus('All quantities are 0. Set at least one quantity above 0.');
    return;
  }

  setStatus(`Building ${EXPORT_DPI} DPI PDF with ${pages.length} page(s)...`);

  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: [PAGE_WIDTH_PT, PAGE_HEIGHT_PT],
    compress: false,
  });

  for (let i = 0; i < pages.length; i += 1) {
    if (i > 0) pdf.addPage([PAGE_WIDTH_PT, PAGE_HEIGHT_PT], 'portrait');

    const pageCard = pages[i];
    const canvas = await renderCardToCanvas(pageCard, EXPORT_DPI);

    const imageData = canvas.toDataURL('image/png');
    pdf.addImage(imageData, 'PNG', 0, 0, PAGE_WIDTH_PT, PAGE_HEIGHT_PT, undefined, 'NONE');
  }

  pdf.save('cards.pdf');
  setStatus(`Export complete: ${pages.length} page(s) in cards.pdf at ${EXPORT_DPI} DPI.`);
});

function renderCards() {
  cardsList.innerHTML = '';

  cards.forEach((card) => {
    const item = document.createElement('article');
    item.className = 'card-item';

    const previewWrap = document.createElement('div');
    previewWrap.className = 'preview-wrap';

    const previewImg = document.createElement('img');
    previewImg.src = card.src;
    previewImg.alt = card.name;
    previewImg.style.transform = `rotate(${card.rotation}deg)`;

    previewWrap.appendChild(previewImg);

    const fileName = document.createElement('p');
    fileName.className = 'filename';
    fileName.textContent = card.name;

    const qtyRow = document.createElement('div');
    qtyRow.className = 'field-row';

    const qtyLabel = document.createElement('label');
    qtyLabel.textContent = 'Quantity';
    qtyLabel.htmlFor = `qty-${card.id}`;

    const qtyInput = document.createElement('input');
    qtyInput.id = `qty-${card.id}`;
    qtyInput.type = 'number';
    qtyInput.min = '0';
    qtyInput.step = '1';
    qtyInput.value = String(card.quantity);
    qtyInput.addEventListener('input', () => {
      const value = parseInt(qtyInput.value, 10);
      card.quantity = Number.isFinite(value) ? Math.max(0, value) : 0;
    });

    qtyRow.append(qtyLabel, qtyInput);

    const rotRow = document.createElement('div');
    rotRow.className = 'field-row';

    const rotLabel = document.createElement('label');
    rotLabel.textContent = 'Rotation';
    rotLabel.htmlFor = `rot-${card.id}`;

    const rotInput = document.createElement('input');
    rotInput.id = `rot-${card.id}`;
    rotInput.type = 'number';
    rotInput.step = '1';
    rotInput.value = String(card.rotation);
    rotInput.addEventListener('input', () => {
      const value = parseFloat(rotInput.value);
      card.rotation = Number.isFinite(value) ? normalizeRotation(value) : 0;
      previewImg.style.transform = `rotate(${card.rotation}deg)`;
      rotInput.value = String(card.rotation);
    });

    rotRow.append(rotLabel, rotInput);

    const rotationActions = document.createElement('div');
    rotationActions.className = 'rotation-actions';

    const rotateLeftBtn = document.createElement('button');
    rotateLeftBtn.type = 'button';
    rotateLeftBtn.textContent = '⟲ -90°';
    rotateLeftBtn.addEventListener('click', () => {
      card.rotation = normalizeRotation(card.rotation - 90);
      rotInput.value = String(card.rotation);
      previewImg.style.transform = `rotate(${card.rotation}deg)`;
    });

    const rotateRightBtn = document.createElement('button');
    rotateRightBtn.type = 'button';
    rotateRightBtn.textContent = '⟳ +90°';
    rotateRightBtn.addEventListener('click', () => {
      card.rotation = normalizeRotation(card.rotation + 90);
      rotInput.value = String(card.rotation);
      previewImg.style.transform = `rotate(${card.rotation}deg)`;
    });

    rotationActions.append(rotateLeftBtn, rotateRightBtn);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      cards = cards.filter((entry) => entry.id !== card.id);
      renderCards();
    });

    item.append(previewWrap, fileName, qtyRow, rotRow, rotationActions, removeBtn);
    cardsList.appendChild(item);
  });
}

async function renderCardToCanvas(card, dpi = EXPORT_DPI) {
  const img = await loadImage(card.src);
  const canvas = document.createElement('canvas');
  const width = Math.round(CARD_WIDTH_IN * dpi);
  const height = Math.round(CARD_HEIGHT_IN * dpi);
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(width / 2, height / 2);
  const radians = ((card.rotation || 0) * Math.PI) / 180;
  ctx.rotate(radians);

  const sourceWidth = img.naturalWidth || img.width;
  const sourceHeight = img.naturalHeight || img.height;
  const absCos = Math.abs(Math.cos(radians));
  const absSin = Math.abs(Math.sin(radians));
  const rotatedBoundsWidth = sourceWidth * absCos + sourceHeight * absSin;
  const rotatedBoundsHeight = sourceWidth * absSin + sourceHeight * absCos;

  // Cover-fit the rotated source so each page is fully filled at export size.
  const scale = Math.max(width / rotatedBoundsWidth, height / rotatedBoundsHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;

  ctx.drawImage(img, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  ctx.restore();

  return canvas;
}

function normalizeRotation(value) {
  let result = value % 360;
  if (result < 0) result += 360;
  return Number(result.toFixed(2));
}

function setStatus(message) {
  statusEl.textContent = message;
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image.'));
    img.src = src;
  });
}
