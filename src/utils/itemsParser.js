const fs = require('fs');
const path = require('path');

const OX_ITEMS_PATH = 'D:\\base zk & indulgent\\resources\\ox_inventory\\data\\items.lua';

let cachedItems = null;
let lastCacheTime = 0;

function parseOxItems() {
  const now = Date.now();
  if (cachedItems && (now - lastCacheTime < 60000)) {
    return cachedItems;
  }

  try {
    if (!fs.existsSync(OX_ITEMS_PATH)) {
      return [];
    }

    const content = fs.readFileSync(OX_ITEMS_PATH, 'utf8');
    const items = [];
    const lines = content.split('\n');
    let currentItem = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Détection début item: ["burger"] = {
      const startMatch = line.match(/^\[["']([^"']+)["']\]\s*=\s*\{/);
      if (startMatch) {
        currentItem = {
          name: startMatch[1],
          label: startMatch[1]
        };
        continue;
      }

      if (currentItem) {
        const labelMatch = line.match(/label\s*=\s*["']([^"']+)["']/);
        if (labelMatch) {
          currentItem.label = labelMatch[1];
        }

        // Fin du bloc de l'item
        if (line.startsWith('},') || line === '}') {
          items.push(currentItem);
          currentItem = null;
        }
      }
    }

    cachedItems = items;
    lastCacheTime = now;
    return items;
  } catch (err) {
    console.error('[ITEMS_PARSER_ERROR]', err);
    return [];
  }
}

module.exports = {
  parseOxItems
};
