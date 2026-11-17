// Fails if manifest.json and package.json have different versions.
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url))).version;
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
if (manifest !== pkg) {
    console.error(`Version mismatch: manifest.json ${manifest}, package.json ${pkg}`);
    process.exit(1);
}
console.log(`Version ${manifest}`);
