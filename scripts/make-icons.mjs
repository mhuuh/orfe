// Renders public/icon.svg to the PNG sizes the manifest needs.
import sharp from 'sharp'

for (const size of [192, 512]) {
  await sharp('public/icon.svg').resize(size, size).png().toFile(`public/icon-${size}.png`)
}
