import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const source = readFileSync('public/favicon.svg', 'utf8');
const fullBleed = source.replace(/ rx="8"/, '');
const browser = await chromium.launch(
  process.env.MINTLESS_CHROMIUM ? { executablePath: process.env.MINTLESS_CHROMIUM } : {},
);
const page = await browser.newPage();

async function png(svg: string, size: number) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}</style><img width="${size}" height="${size}" src="data:image/svg+xml,${encodeURIComponent(svg)}">`,
  );
  await page.locator('img').evaluate((img: HTMLImageElement) => img.decode());
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

function ico(images: { size: number; data: Buffer }[]) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

const icoSizes = [16, 32, 48];
const icoImages = [];
for (const size of icoSizes) icoImages.push({ size, data: await png(source, size) });
writeFileSync('public/favicon.ico', ico(icoImages));
writeFileSync('public/apple-touch-icon.png', await png(fullBleed, 180));
writeFileSync('public/icon-192.png', await png(source, 192));
writeFileSync('public/icon-512.png', await png(source, 512));
writeFileSync('public/icon-maskable-512.png', await png(fullBleed, 512));
await browser.close();
console.log(
  'wrote favicon.ico (16, 32, 48), apple-touch-icon.png, icon-192.png, icon-512.png, icon-maskable-512.png',
);
