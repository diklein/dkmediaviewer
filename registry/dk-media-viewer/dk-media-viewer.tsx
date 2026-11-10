'use client'

/* DKMediaViewer — the masonry grid + the lightbox it opens.
 *
 *   <DKMediaViewer items={items} />
 *
 * Items are plain data (see types.ts) — hand-written, CMS-mapped, or generated with
 * `npx @diklein/dkmediaviewer scan ./public/photos`. Photos render as lazy <img>s (or through your own
 * renderImage slot, e.g. next/image); videos autoplay muted in the grid and hand off
 * frame-accurately to the lightbox player when clicked. */

import { useState, useEffect, useRef } from 'react'
import type { DKMediaItem } from './types'
import { useDKLightbox } from './dk-lightbox'

export interface DKMediaViewerProps {
  items: DKMediaItem[]
  /** Extra classes on the outer grid wrapper. */
  className?: string
  /** A sharper large variant for the lightbox to fade in over the base image (and to prefetch
   *  on hover and around the open item) — e.g. a CDN resize URL. Default: none; the lightbox
   *  shows item.src, which for local files is already the full image. */
  getHiResSrc?: (item: DKMediaItem) => string
  /** Render the grid image yourself (e.g. with next/image). Apply ctx.className to the visible
   *  image element and honor ctx.sizes/ctx.priority; the lightbox still works untouched — it
   *  reads the rendered <img>'s decoded file at click time. */
  renderImage?: (
    item: DKMediaItem,
    ctx: { index: number; priority: boolean; sizes: string; className: string },
  ) => React.ReactNode
  /** A 1px edge outline on the grid thumbnails and the lightbox photo. Default off. */
  showOutline?: boolean
  /** Reserve the lightbox caption/exif rail. Default: on when any item carries one. */
  hasCaptions?: boolean
  /** Open from `?photo=<index>` on mount, for shareable deep links. Default off. */
  deepLink?: boolean
}

const GRID_SIZES = '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw'
const IMG_BASE = 'w-full h-auto'

/* BlurHash decoder (https://blurha.sh), the reference algorithm. An item that carries a
 * blurHash wears a blurred preview of itself until its image arrives. */
const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~'
const decode83 = (str: string) => {
  let v = 0
  for (const c of str) v = v * 83 + B83.indexOf(c)
  return v
}
const toLinear = (v: number) => {
  const x = v / 255
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}
const toSrgb = (v: number) => {
  const x = Math.max(0, Math.min(1, v))
  return x <= 0.0031308 ? Math.round(x * 12.92 * 255 + 0.5) : Math.round((1.055 * x ** (1 / 2.4) - 0.055) * 255 + 0.5)
}
const signPow = (v: number, exp: number) => Math.sign(v) * Math.abs(v) ** exp
function decodeBlurHash(hash: string, width: number, height: number): Uint8ClampedArray | null {
  if (hash.length < 6) return null
  const size = decode83(hash[0])
  const ny = Math.floor(size / 9) + 1
  const nx = (size % 9) + 1
  if (hash.length !== 4 + 2 * nx * ny) return null
  const max = (decode83(hash[1]) + 1) / 166
  const colors: [number, number, number][] = []
  for (let i = 0; i < nx * ny; i++) {
    if (i === 0) {
      const v = decode83(hash.slice(2, 6))
      colors.push([toLinear(v >> 16), toLinear((v >> 8) & 255), toLinear(v & 255)])
    } else {
      const v = decode83(hash.slice(4 + i * 2, 6 + i * 2))
      colors.push([signPow((Math.floor(v / 361) - 9) / 9, 2) * max, signPow(((Math.floor(v / 19) % 19) - 9) / 9, 2) * max, signPow(((v % 19) - 9) / 9, 2) * max])
    }
  }
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const basis = Math.cos((Math.PI * x * i) / width) * Math.cos((Math.PI * y * j) / height)
          const c = colors[i + j * nx]
          r += c[0] * basis; g += c[1] * basis; b += c[2] * basis
        }
      }
      const o = 4 * (x + y * width)
      pixels[o] = toSrgb(r); pixels[o + 1] = toSrgb(g); pixels[o + 2] = toSrgb(b); pixels[o + 3] = 255
    }
  }
  return pixels
}

/* What a tile shows before its photo arrives, in two layers, both on the tile itself and
 * both optional: item.color as a plain background-color (in the server's HTML, nothing to
 * decode), and item.blurHash decoded here, once the page is idle, into a 32px preview the
 * browser stretches smooth. Both STAY for the life of the tile. "Loaded" is not "painted":
 * on a fast scroll Safari reports a cached photo as loaded frames before it has drawn it,
 * and a placeholder removed on that signal leaves bare page in between. The photo is opaque,
 * so once drawn it simply covers them. (Give a transparent image neither.) */
function paintBlurPreviews(items: DKMediaItem[], tileFor: (index: number) => HTMLElement | null): () => void {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}
  // Safari has no requestIdleCallback; a short timeout stands in.
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }
  const idle = (cb: () => void) => (w.requestIdleCallback ? w.requestIdleCallback(cb, { timeout: 500 }) : window.setTimeout(cb, 50))
  const cancel = (id: number) => (w.cancelIdleCallback ? w.cancelIdleCallback(id) : window.clearTimeout(id))
  let i = 0
  let handle = idle(function work() {
    // A dozen tiles per idle slice: no slice is long enough to be felt in a scroll.
    for (let n = 0; n < 12 && i < items.length; n++, i++) {
      const item = items[i]
      if (!item.blurHash || item.videoSrc) continue
      const tile = tileFor(i)
      if (!tile || tile.style.backgroundImage) continue
      const wide = (item.width ?? 3) >= (item.height ?? 2)
      const ratio = (item.width ?? 3) / (item.height ?? 2)
      const pw = wide ? 32 : Math.max(1, Math.round(32 * ratio))
      const ph = wide ? Math.max(1, Math.round(32 / ratio)) : 32
      const pixels = decodeBlurHash(item.blurHash, pw, ph)
      if (!pixels) continue
      canvas.width = pw
      canvas.height = ph
      const data = ctx.createImageData(pw, ph)
      data.data.set(pixels)
      ctx.putImageData(data, 0, 0)
      tile.style.backgroundImage = `url(${canvas.toDataURL('image/jpeg', 0.7)})`
    }
    if (i < items.length) handle = idle(work)
  })
  return () => cancel(handle)
}

export function DKMediaViewer({
  items,
  className,
  getHiResSrc,
  renderImage,
  showOutline = false,
  hasCaptions,
  deepLink = false,
}: DKMediaViewerProps) {
  const IMG_CLASS = showOutline ? `dk-img-outline ${IMG_BASE}` : IMG_BASE
  const [numCols, setNumCols] = useState(3)
  // Reduced-motion visitors get still thumbnails: autoPlay drops and each clip holds its poster
  // frame, with the lightbox as the play path (its player carries explicit controls). Read in an
  // effect so the SSR markup stays stable; live-updated because the OS toggle can flip mid-visit.
  const [reducedMotion, setReducedMotion] = useState(false)
  const prefetched = useRef<Set<string>>(new Set())
  // Thumbnail registry: close hands focus back to the item the viewer ended on, and deep links
  // need a zoom origin — both resolved through here.
  const thumbEls = useRef<Map<number, HTMLButtonElement>>(new Map())

  const { open, lightbox } = useDKLightbox(items, {
    getHiResSrc,
    showOutline,
    hasCaptions,
    deepLink,
    getOriginEl: (i) => thumbEls.current.get(i) ?? null,
  })

  // Warm the hi-res layer on hover/focus so it is already downloading by the time the lightbox
  // opens — the browser cache hit makes the sharp layer's fade-in instant instead of a re-fetch
  // after the fly-in lands. No-op without getHiResSrc (the lightbox then reuses the grid's file).
  const prefetchHiRes = (item: DKMediaItem) => {
    if (!getHiResSrc) return
    const hi = getHiResSrc(item)
    if (!hi || hi === item.src || prefetched.current.has(hi)) return
    prefetched.current.add(hi)
    const img = new window.Image()
    img.src = hi
  }

  useEffect(() => {
    const sm = window.matchMedia('(max-width: 639px)')
    const md = window.matchMedia('(max-width: 1023px)')

    const update = () => {
      if (sm.matches) setNumCols(1)
      else if (md.matches) setNumCols(2)
      else setNumCols(3)
    }

    update()
    sm.addEventListener('change', update)
    md.addEventListener('change', update)
    return () => {
      sm.removeEventListener('change', update)
      md.removeEventListener('change', update)
    }
  }, [])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // Mounted clips don't react to the autoPlay attribute changing, so a live preference flip is
  // applied by hand: pause everything when motion is reduced, resume when the preference lifts.
  useEffect(() => {
    thumbEls.current.forEach((btn) => {
      const video = btn.querySelector('video')
      if (!video) return
      if (reducedMotion) video.pause()
      else video.play().catch(() => {})
    })
  }, [reducedMotion])

  // Blurred previews, laid on once the tiles exist (a column change remounts them, and with
  // them the inline backgrounds).
  useEffect(() => paintBlurPreviews(items, (i) => thumbEls.current.get(i) ?? null), [items, numCols])

  if (items.length === 0) return null

  const columns: Array<Array<{ item: DKMediaItem; originalIndex: number }>> =
    Array.from({ length: numCols }, () => [])
  items.forEach((item, i) => columns[i % numCols].push({ item, originalIndex: i }))

  return (
    <>
      {/* data-dk-scope: the lightbox pauses playing <video>s inside this wrapper while open. */}
      <div data-dk-scope className={`dk-scope flex gap-1${className ? ` ${className}` : ''}`}>
        {columns.map((colItems, colIndex) => (
          <div key={colIndex} className="flex-1 flex flex-col gap-1">
            {colItems.map(({ item, originalIndex }) => (
              <button
                key={item.src}
                ref={(el) => {
                  if (el) thumbEls.current.set(originalIndex, el)
                  else thumbEls.current.delete(originalIndex)
                }}
                onMouseEnter={() => prefetchHiRes(item)}
                onFocus={() => prefetchHiRes(item)}
                onClick={(e) => open(originalIndex, e.currentTarget, e)}
                // No focus-visible override: the host's global :focus-visible styling (or the
                // browser default) gives keyboard users their ring — opting out leaves them
                // tabbing blind.
                // The hover dim is a veil over the tile, not the image going translucent: the
                // placeholder layers stay behind the image for good (see paintBlurPreviews),
                // and a see-through image would fade toward them instead of toward the page.
                className="dk-cv-auto relative block w-full cursor-zoom-in after:pointer-events-none after:absolute after:inset-0 after:bg-[var(--dk-bg)] after:opacity-0 after:transition-opacity after:duration-200 hover:after:opacity-15"
                style={item.color && !item.videoSrc ? { backgroundColor: item.color, backgroundSize: '100% 100%' } : { backgroundSize: '100% 100%' }}
                aria-label={item.alt ?? item.caption ?? (item.videoSrc ? 'Play video' : 'Open photo')}
              >
                {item.videoSrc ? (
                  // Clips autoplay muted in the grid (poster = item.src covers the load) — except
                  // under prefers-reduced-motion, where they sit on their poster and play in the
                  // lightbox instead. The lightbox resumes from this element's exact frame — see
                  // useDKLightbox's capture.
                  <video
                    src={item.videoSrc}
                    poster={item.src}
                    muted
                    loop
                    playsInline
                    autoPlay={!reducedMotion}
                    preload="metadata"
                    className={IMG_CLASS}
                    style={
                      item.width && item.height
                        ? { aspectRatio: `${item.width} / ${item.height}` }
                        : undefined
                    }
                  />
                ) : renderImage ? (
                  renderImage(item, {
                    index: originalIndex,
                    priority: originalIndex < 3,
                    sizes: GRID_SIZES,
                    className: IMG_CLASS,
                  })
                ) : (
                  <img
                    src={item.src}
                    alt={item.alt ?? item.caption ?? ''}
                    width={item.width}
                    height={item.height}
                    sizes={GRID_SIZES}
                    className={IMG_CLASS}
                    loading={originalIndex < 3 ? 'eager' : 'lazy'}
                    decoding="async"
                  />
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
      {lightbox}
    </>
  )
}
