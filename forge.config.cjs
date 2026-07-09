const fs = require('fs');
const path = require('path');

const keepLocaleFiles = new Set(['ko.pak', 'en-US.pak', 'en-GB.pak']);

function pruneUnusedLocales(buildPath, electronVersion, platform, arch, callback) {
  if (platform !== 'win32') {
    callback();
    return;
  }

  const localesDir = path.join(buildPath, 'locales');

  try {
    if (fs.existsSync(localesDir)) {
      for (const fileName of fs.readdirSync(localesDir)) {
        if (fileName.endsWith('.pak') && !keepLocaleFiles.has(fileName)) {
          fs.rmSync(path.join(localesDir, fileName), { force: true });
        }
      }
    }

    callback();
  } catch (error) {
    callback(error);
  }
}

module.exports = {
  packagerConfig: {
    name: 'WEHAGO VAT OCR',
    executableName: 'WEHAGO VAT OCR',
    icon: 'assets/icon',
    asar: true,
    overwrite: true,
    afterComplete: [pruneUnusedLocales],
    ignore: [
      /^\/\.env(?:$|\.)/,
      /^\/\.git(?:$|\/)/,
      /^\/\.github(?:$|\/)/,
      /^\/src(?:$|\/)/,
      /^\/scripts(?:$|\/)/,
      /^\/out(?:$|\/)/,
      /^\/vite\.config\.js$/,
      /^\/vercel\.json$/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'wehago_vat_ocr',
        authors: 'WEHAGO VAT OCR',
        description: 'WEHAGO VAT OCR desktop app',
        setupExe: 'WEHAGO VAT OCR Setup.exe',
        setupIcon: 'assets/icon.ico',
        noMsi: true,
      },
    },
  ],
};
