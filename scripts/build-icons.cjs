const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const assetsDir = path.join(rootDir, 'assets');
const sourcePng = path.join(assetsDir, 'icon.png');
const iconsetDir = path.join(assetsDir, 'icon.iconset');
const icoTempDir = path.join(assetsDir, '.ico-tmp');

function ensureSource() {
  if (!fs.existsSync(sourcePng)) {
    throw new Error(`Missing source icon: ${sourcePng}`);
  }
}

function resizePng(size, outputPath) {
  execFileSync('sips', ['-z', String(size), String(size), sourcePng, '--out', outputPath], {
    stdio: 'ignore',
  });
}

function buildIcns() {
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir, { recursive: true });

  const iconsetFiles = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ];

  for (const [fileName, size] of iconsetFiles) {
    resizePng(size, path.join(iconsetDir, fileName));
  }

  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(assetsDir, 'icon.icns')], {
    stdio: 'inherit',
  });
  fs.rmSync(iconsetDir, { recursive: true, force: true });
}

function buildIco() {
  fs.rmSync(icoTempDir, { recursive: true, force: true });
  fs.mkdirSync(icoTempDir, { recursive: true });

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => {
    const filePath = path.join(icoTempDir, `icon-${size}.png`);
    resizePng(size, filePath);
    return {
      size,
      data: fs.readFileSync(filePath),
    };
  });

  const headerSize = 6;
  const directorySize = images.length * 16;
  let imageOffset = headerSize + directorySize;
  const buffers = [];
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  buffers.push(header);

  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(imageOffset, 12);
    imageOffset += image.data.length;
    buffers.push(entry);
  }

  images.forEach((image) => buffers.push(image.data));
  fs.writeFileSync(path.join(assetsDir, 'icon.ico'), Buffer.concat(buffers));
  fs.rmSync(icoTempDir, { recursive: true, force: true });
}

ensureSource();
buildIcns();
buildIco();
console.log('Built assets/icon.icns and assets/icon.ico');
