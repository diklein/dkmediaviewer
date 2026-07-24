#!/usr/bin/env node
/* dkmediaviewer scan — point it at a folder of images, get a ready-to-render items.json.
 *
 *   npx @diklein/dkmediaviewer scan ./public/photos
 *   npx @diklein/dkmediaviewer scan ./public/photos --base /photos --out src/lib/media-items.json
 *
 * For every image it reads intrinsic dimensions and real camera EXIF (make, model, shutter,
 * aperture, focal length, ISO) straight from the file — nothing is hand-typed. Videos
 * (mp4/webm) are picked up when a same-named poster image sits beside them
 * (clip.mp4 + clip.jpg → one video item). The output array is the DKMediaItem[] the
 * <DKMediaViewer> component takes verbatim.
 *
 * `--base` maps the scanned folder to its public URL prefix (default: the folder path with a
 * leading `public/` stripped — the Next.js convention). */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, basename, join, posix } from 'node:path'
import { imageSize } from 'image-size'
import exifr from 'exifr'

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'])
const VIDEO_EXTS = new Set(['.mp4', '.webm'])

const HELP = `dkmediaviewer, the companion CLI for the DKMediaViewer component
https://diklein.com/dkmediaviewer

Usage
  npx @diklein/dkmediaviewer scan <folder> [options]

Scans a folder of images and writes a ready-to-render items.json for
<DKMediaViewer>. Dimensions and camera EXIF (make, model, shutter, aperture,
focal length, ISO) are read straight from the files. A clip.mp4 next to a
clip.jpg becomes one video item with the jpg as its poster.

Options
  --base <prefix>   Public URL prefix for src paths. Default: the folder path
                    with a leading "public/" stripped (the Next.js convention).
  --out <file>      Output path. Default: items.json
  -h, --help        Show this help.
`

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i]
    else if (argv[i] === '--out') args.out = argv[++i]
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true
    else args._.push(argv[i])
  }
  return args
}

/** 0.0125 → "1/80"; 0.5 → "0.5"; 30 → "30" — shutter the way a photographer says it. */
function formatShutter(s) {
  if (s == null) return null
  if (s >= 0.5) return String(Math.round(s * 10) / 10)
  return `1/${Math.round(1 / s)}`
}

function trimNumber(n) {
  if (n == null) return null
  return String(Math.round(n * 10) / 10)
}

async function readExif(file) {
  try {
    const x = await exifr.parse(file, {
      pick: ['Make', 'Model', 'ExposureTime', 'FNumber', 'FocalLength', 'ISO'],
    })
    if (!x) return undefined
    const exif = {
      make: x.Make ?? null,
      model: x.Model ?? null,
      exposureTime: formatShutter(x.ExposureTime),
      aperture: trimNumber(x.FNumber),
      focalLength: trimNumber(x.FocalLength),
      iso: x.ISO ?? null,
    }
    // All-empty EXIF (screenshots, exports that strip metadata) → omit the field entirely.
    return Object.values(exif).some((v) => v != null) ? exif : undefined
  } catch {
    return undefined
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2).filter((a) => a !== 'scan'))
  if (args.help) {
    console.log(HELP)
    return
  }
  const folder = args._[0]
  if (!folder) {
    console.error('usage: dkmediaviewer scan <folder> [--base /public-url-prefix] [--out items.json]')
    console.error('       npx @diklein/dkmediaviewer --help for details')
    process.exit(1)
  }

  // public/photos → /photos (the Next.js convention); anything else keeps its own path.
  const base =
    args.base ?? '/' + posix.join(...folder.replace(/^\.?\//, '').split('/').filter((p) => p !== 'public'))

  const names = (await readdir(folder)).sort()
  const imageNames = names.filter((n) => IMAGE_EXTS.has(extname(n).toLowerCase()))
  const videoNames = names.filter((n) => VIDEO_EXTS.has(extname(n).toLowerCase()))

  // A video claims its same-named image as poster; that image stops being a standalone item.
  const posters = new Map()
  for (const v of videoNames) {
    const stem = basename(v, extname(v))
    const poster = imageNames.find((i) => basename(i, extname(i)) === stem)
    if (poster) posters.set(v, poster)
  }
  const claimed = new Set(posters.values())

  const items = []

  for (const name of imageNames) {
    if (claimed.has(name)) continue
    const file = join(folder, name)
    const buf = await readFile(file)
    let width, height
    try {
      ;({ width, height } = imageSize(buf))
    } catch {
      /* undecodable — ship without dimensions */
    }
    const exif = await readExif(file)
    items.push({
      src: posix.join(base, name),
      ...(width && height ? { width, height } : {}),
      ...(exif ? { exif } : {}),
    })
  }

  for (const [video, poster] of posters) {
    const file = join(folder, poster)
    const buf = await readFile(file)
    let width, height
    try {
      ;({ width, height } = imageSize(buf))
    } catch {
      /* ok */
    }
    items.push({
      src: posix.join(base, poster),
      videoSrc: posix.join(base, video),
      ...(width && height ? { width, height } : {}),
    })
  }

  const skippedVideos = videoNames.filter((v) => !posters.has(v))
  const out = args.out ?? 'items.json'
  await writeFile(out, JSON.stringify(items, null, 2) + '\n')

  console.log(`dkmediaviewer: ${items.length} item(s) → ${out}`)
  console.log(`  images: ${imageNames.length - claimed.size} · videos: ${posters.size} · with exif: ${items.filter((i) => i.exif).length}`)
  if (skippedVideos.length) {
    console.log(`  skipped ${skippedVideos.length} video(s) with no same-named poster image: ${skippedVideos.join(', ')}`)
  }
}

main().catch((err) => {
  console.error('dkmediaviewer:', err.message)
  process.exit(1)
})
