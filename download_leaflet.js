const https = require('https');
const fs = require('fs');
const path = require('path');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download ${url}: status ${res.statusCode}`));
      }
      const stream = fs.createWriteStream(dest);
      res.pipe(stream);
      stream.on('finish', () => {
        stream.close();
        console.log(`Downloaded ${url} -> ${dest}`);
        resolve();
      });
    }).on('error', reject);
  });
}

async function main() {
  await download('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', path.join(__dirname, 'scripts', 'leaflet.js'));
  await download('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', path.join(__dirname, 'styles', 'leaflet.css'));
  console.log('Leaflet assets saved locally!');
}

main().catch(console.error);
