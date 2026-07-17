/* DKMediaViewer — the data contract.
 *
 * One item = one photo or one video. Hand-write the array, generate it with
 * `npx dkmediaviewer scan ./public/photos`, or map it from your CMS — the viewer
 * only ever sees this shape. Everything beyond `src` is optional and degrades
 * cleanly: no exif → no spec line, no caption → no caption well, no dimensions
 * → the layout measures the rendered element instead. */

export interface DKExif {
  make?: string | null
  model?: string | null
  /** Shutter as the photographer says it: "1/80", "0.5", "30". */
  exposureTime?: string | null
  /** Aperture without the ƒ: "1.6", "8". */
  aperture?: string | null
  /** Focal length in mm, without the unit: "35", "23". */
  focalLength?: string | null
  iso?: number | null
}

export interface DKMediaItem {
  /** The image URL — or, for a video, its poster frame. */
  src: string
  /** Marks the item as a video and gives the clip to play (mp4/webm URL). */
  videoSrc?: string
  alt?: string
  /** Shown in the lightbox caption well (and read to assistive tech when alt is absent). */
  caption?: string
  /** Intrinsic pixels. Optional, but supplying them avoids layout shift in the grid. */
  width?: number
  height?: number
  /** Average/dominant color as #rrggbb — used for the blur-up placeholder. */
  color?: string
  /** Camera settings for the mono spec line under the caption. */
  exif?: DKExif
}

function toTitleCase(str: string): string {
  return str.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

/** EXIF `Make` is often the full legal name ("NIKON CORPORATION", "CASIO COMPUTER CO.,LTD.").
 *  Strip the legal-entity tail(s) so the spec line reads like a photographer, not a filing:
 *  "Nikon D610", never "Nikon Corporation D610". */
function cleanMake(raw: string): string {
  let make = toTitleCase(raw)
  const legal = /[\s,]*(Corporation|Corp|Company|Co|Ltd|Inc|Gmbh|K\.K)\.?,?$/i
  while (legal.test(make)) make = make.replace(legal, '')
  return make
}

/** "Ricoh GR IIIx · 26.1mm · ƒ/2.8 · 1/500s · ISO 200" — omits whatever is missing.
 *  Drops a leading brand word from the model that just repeats the make (make "Ricoh",
 *  model "RICOH GR IIIx" → "GR IIIx"), so the camera never reads doubled. */
export function formatExif(exif?: DKExif | null): string {
  if (!exif) return ''
  const parts: string[] = []
  const make = exif.make ? cleanMake(exif.make) : null
  let model = exif.model ?? null
  if (make && model) {
    model = model.replace(new RegExp(`^${make.split(/[\s,]/)[0]}\\s+`, 'i'), '') || null
  }
  if (make || model) parts.push([make, model].filter(Boolean).join(' '))
  if (exif.focalLength) parts.push(`${exif.focalLength}mm`)
  if (exif.aperture) parts.push(`ƒ/${exif.aperture}`)
  if (exif.exposureTime) parts.push(`${exif.exposureTime}s`)
  if (exif.iso) parts.push(`ISO ${exif.iso}`)
  return parts.join(' · ')
}
