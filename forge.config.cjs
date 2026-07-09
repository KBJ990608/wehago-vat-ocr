module.exports = {
  packagerConfig: {
    name: 'WEHAGO VAT OCR',
    executableName: 'WEHAGO VAT OCR',
    icon: 'assets/icon',
    asar: true,
    overwrite: true,
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
